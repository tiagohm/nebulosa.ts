import { afterAll, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { AstapError, astapDetectStars, astapPlateSolve } from '../../../src/astrometry/solvers/astap'
import { PlateSolveError } from '../../../src/astrometry/solvers/platesolver'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { deg, hour, toArcmin, toArcsec, toDeg, toHour } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'
import { FAKE_EXECUTABLE_PROBE, headerOnlyFits, isBinaryTestSkipped, settleExecutable } from '../../util'

await downloadPerTag('astap')

const SKIP = isBinaryTestSkipped()

// Scripts standing in for ASTAP, so the failure paths run without the real binary.
const fakes = await mkdtemp(join(tmpdir(), 'nebulosa-astap-'))

afterAll(() => rm(fakes, { recursive: true, force: true }))

interface FakeAstap {
	// Lines of the CSV written next to the input, header included; none is written when absent.
	readonly csv?: readonly string[]
	// Seconds slept before exiting.
	readonly sleep?: number
	readonly exitCode?: number
}

let fakeCount = 0

// Writes an executable behaving like ASTAP's -extract (the input is its second argument) and an input file
// in its own directory.
async function fakeAstap({ csv = [], sleep = 0, exitCode = 0 }: FakeAstap) {
	const directory = join(fakes, `run${++fakeCount}`)
	await mkdir(directory)
	const input = join(directory, 'frame.fit')
	await Bun.write(input, 'SIMPLE')

	if (process.platform === 'win32') {
		const lines = ['@echo off', ...csv.map((line) => `echo ${line}>> "%~dpn2.csv"`), ...(sleep > 0 ? [`ping -n ${sleep + 1} 127.0.0.1 >nul`] : []), `exit /b ${exitCode}`]
		const executable = join(directory, 'astap.cmd')
		await Bun.write(executable, lines.join('\r\n'))
		return { executable, input, directory }
	}

	const lines = ['#!/bin/sh', 'base="${2%.*}"', ...csv.map((line) => `echo '${line}' >> "$base.csv"`), ...(sleep > 0 ? [`sleep ${sleep}`] : []), `exit ${exitCode}`]
	const executable = join(directory, 'astap')
	await Bun.write(executable, lines.join('\n'))
	await chmod(executable, 0o755)
	return { executable, input, directory }
}

// Awaits a star detection that must fail, returning its error.
async function detectionError(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		expect(error).toBeInstanceOf(AstapError)
		return error as AstapError
	}

	throw new Error('the star detection did not fail')
}

test('parses the star list of ASTAP into 0-based coordinates and deletes it', async () => {
	const { executable, input, directory } = await fakeAstap({ csv: ['x,y,hfd,snr,flux', '11,21,2.5,40,1000', '31.5,41.25,3,20,500'] })
	const stars = await astapDetectStars(input, { executable })

	expect(stars).toEqual([
		{ x: 10, y: 20, hfd: 2.5, snr: 40, flux: 1000 },
		{ x: 30.5, y: 40.25, hfd: 3, snr: 20, flux: 500 },
	])
	expect(await readdir(directory)).not.toContain('frame.csv')
})

test('keeps the stars of highest SNR when limited', async () => {
	const { executable, input } = await fakeAstap({ csv: ['x,y,hfd,snr,flux', '1,1,2,10,100', '2,2,2,30,300', '3,3,2,20,200'] })
	const stars = await astapDetectStars(input, { executable, maxStars: 2 })

	expect(stars.map((star) => star.snr)).toEqual([30, 20])
})

test('returns no stars when ASTAP wrote an empty star list', async () => {
	const { executable, input } = await fakeAstap({ csv: ['x,y,hfd,snr,flux'] })
	expect(await astapDetectStars(input, { executable })).toEqual([])
})

test('fails when ASTAP wrote no star list', async () => {
	const { executable, input } = await fakeAstap({ exitCode: 2 })
	const error = await detectionError(astapDetectStars(input, { executable }))

	expect(error.code).toBe('failed')
	expect(error.message).toContain('exit code 2')
})

test('fails as unavailable when the executable cannot be started', async () => {
	const { input, directory } = await fakeAstap({})
	const error = await detectionError(astapDetectStars(input, { executable: join(directory, 'missing.exe') }))

	expect(error.code).toBe('unavailable')
})

test('fails for a missing input file', async () => {
	const { executable, directory } = await fakeAstap({})
	const error = await detectionError(astapDetectStars(join(directory, 'missing.fit'), { executable }))

	expect(error.code).toBe('failed')
})

test('kills ASTAP on timeout and deletes a partial star list', async () => {
	const { executable, input, directory } = await fakeAstap({ csv: ['x,y,hfd,snr,flux'], sleep: 5 })
	const error = await detectionError(astapDetectStars(input, { executable, timeout: 300 }))

	expect(error.code).toBe('timeout')
	expect(await readdir(directory)).not.toContain('frame.csv')
}, 15000)

test('kills ASTAP when aborted', async () => {
	const { executable, input } = await fakeAstap({ sleep: 5 })
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 300)
	const error = await detectionError(astapDetectStars(input, { executable }, controller.signal))

	expect(error.code).toBe('aborted')
}, 15000)

// A TAN solution of a 100x50 image, without NAXIS1/NAXIS2 like the WCS of ASTAP.
const SOLVED_WCS = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 50.5, CRPIX2: 25.5, CRVAL1: 42, CRVAL2: -17, CD1_1: 0.0005, CD1_2: 0, CD2_1: 0, CD2_2: 0.0005 } as const

interface FakeAstapSolve {
	// Lines of the .ini written for the -o base (the second argument); none is written when absent.
	readonly ini?: readonly string[]
	// Header of the .wcs written for the -o base; none is written when absent.
	readonly wcs?: FitsHeader
	readonly sleep?: number
	readonly exitCode?: number
}

// Writes an executable behaving like an ASTAP solve: it copies the prepared .ini and .wcs to the base it was given.
async function fakeAstapSolve({ ini, wcs, sleep = 0, exitCode = 0 }: FakeAstapSolve) {
	const directory = join(fakes, `run${++fakeCount}`)
	await mkdir(directory)
	const input = join(directory, 'frame.fit')
	await Bun.write(input, 'SIMPLE')
	if (ini) await Bun.write(join(directory, 'out.ini'), ini.join('\n'))
	if (wcs) await Bun.write(join(directory, 'out.wcs'), headerOnlyFits(wcs))

	if (process.platform === 'win32') {
		const copies = [...(ini ? [`copy /y "${join(directory, 'out.ini')}" "%~dpn2.ini" >nul`] : []), ...(wcs ? [`copy /y "${join(directory, 'out.wcs')}" "%~dpn2.wcs" >nul`] : [])]
		const lines = ['@echo off', `if defined ${FAKE_EXECUTABLE_PROBE} exit /b 0`, ...(sleep > 0 ? [`ping -n ${sleep + 1} 127.0.0.1 >nul`] : []), ...copies, `exit /b ${exitCode}`]
		const executable = join(directory, 'astap.cmd')
		await Bun.write(executable, lines.join('\r\n'))
		await settleExecutable(executable)
		return { executable, input }
	}

	const copies = [...(ini ? [`cp '${join(directory, 'out.ini')}' "$base.ini"`] : []), ...(wcs ? [`cp '${join(directory, 'out.wcs')}' "$base.wcs"`] : [])]
	const lines = ['#!/bin/sh', `[ -n "$${FAKE_EXECUTABLE_PROBE}" ] && exit 0`, 'base="${2%.*}"', ...(sleep > 0 ? [`sleep ${sleep}`] : []), ...copies, `exit ${exitCode}`]
	const executable = join(directory, 'astap')
	await Bun.write(executable, lines.join('\n'))
	await chmod(executable, 0o755)
	await settleExecutable(executable)
	return { executable, input }
}

// Awaits a plate solve that must fail, returning its error.
async function solveError(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		expect(error).toBeInstanceOf(AstapError)
		expect(error).toBeInstanceOf(PlateSolveError)
		return error as AstapError
	}

	throw new Error('the plate solve did not fail')
}

test('builds the solution from the WCS of ASTAP', async () => {
	const { executable, input } = await fakeAstapSolve({ ini: ['PLTSOLVD=T'], wcs: SOLVED_WCS })
	const solution = await astapPlateSolve(input, { executable })

	expect(solution).toBeDefined()
	expect(solution!.widthInPixels).toBe(100)
	expect(solution!.heightInPixels).toBe(50)
	expect(toDeg(solution!.declination)).toBeCloseTo(-17, 6)
	expect(toArcsec(solution!.scale)).toBeCloseTo(1.8, 6)
})

test('resolves undefined when ASTAP found no solution', async () => {
	const { executable, input } = await fakeAstapSolve({ ini: ['PLTSOLVD=F'], exitCode: 1 })
	expect(await astapPlateSolve(input, { executable })).toBeUndefined()
})

test('resolves undefined when ASTAP detected too few stars', async () => {
	const { executable, input } = await fakeAstapSolve({ exitCode: 2 })
	expect(await astapPlateSolve(input, { executable })).toBeUndefined()
})

test('fails with the error of ASTAP', async () => {
	const { executable, input } = await fakeAstapSolve({ ini: ['PLTSOLVD=F', 'ERROR=No star database found!'], exitCode: 32 })
	const error = await solveError(astapPlateSolve(input, { executable }))

	expect(error.code).toBe('failed')
	expect(error.message).toContain('exit code 32')
	expect(error.message).toContain('No star database found!')
})

test('fails for an exit code that is not a search without solution', async () => {
	const { executable, input } = await fakeAstapSolve({ exitCode: 16 })
	const error = await solveError(astapPlateSolve(input, { executable }))

	expect(error.code).toBe('failed')
	expect(error.message).toContain('exit code 16')
})

test('fails for a WCS that is not an equatorial TAN solution', async () => {
	const { executable, input } = await fakeAstapSolve({ ini: ['PLTSOLVD=T'], wcs: { ...SOLVED_WCS, CTYPE1: 'GLON-TAN', CTYPE2: 'GLAT-TAN' } })
	const error = await solveError(astapPlateSolve(input, { executable }))

	expect(error.code).toBe('failed')
})

test('fails a solve as unavailable when the executable cannot be started', async () => {
	const { input } = await fakeAstapSolve({})
	const error = await solveError(astapPlateSolve(input, { executable: join(dirname(input), 'missing.exe') }))

	expect(error.code).toBe('unavailable')
})

test('kills a solve on timeout', async () => {
	const { executable, input } = await fakeAstapSolve({ ini: ['PLTSOLVD=T'], wcs: SOLVED_WCS, sleep: 5 })
	const error = await solveError(astapPlateSolve(input, { executable, timeout: 300 }))

	expect(error.code).toBe('timeout')
}, 15000)

test('kills a solve when aborted', async () => {
	const { executable, input } = await fakeAstapSolve({ sleep: 5 })
	const controller = new AbortController()
	setTimeout(() => controller.abort(), 300)
	const error = await solveError(astapPlateSolve(input, { executable }, controller.signal))

	expect(error.code).toBe('aborted')
}, 15000)

test.skipIf(SKIP)('detect stars', async () => {
	const stars = await astapDetectStars(join(dirname(__dirname), '..', '..', 'data', 'apod4.jpg'))

	expect(stars.length).toBeGreaterThanOrEqual(200)
	expect(stars[0].x).toBeGreaterThan(0)
	expect(stars[0].y).toBeGreaterThan(0)
	expect(stars[0].hfd).toBeGreaterThan(0)
	expect(stars[0].snr).toBeGreaterThan(0)
	expect(stars[0].flux).toBeGreaterThan(0)
})

test.skipIf(SKIP)('plate solve', async () => {
	const rightAscension = hour(10.7345)
	const declination = deg(-59.6022)
	const solution = await astapPlateSolve(join(dirname(__dirname), '..', '..', 'data', 'NGC3372--32.1.fit'), { rightAscension, declination, radius: deg(4), fov: deg(0.54) })

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(110.1, 1)
	expect(toArcsec(solution!.scale)).toBeCloseTo(2.7, 1)
	expect(toHour(solution!.rightAscension)).toBeCloseTo(10.7, 1)
	expect(toDeg(solution!.declination)).toBeCloseTo(-59.6, 1)
	expect(toArcmin(solution!.width)).toBeCloseTo(47.3, 1)
	expect(toArcmin(solution!.height)).toBeCloseTo(32.2, 1)
	expect(toArcmin(solution!.radius)).toBeCloseTo(28.6, 1)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(1037)
	expect(solution!.heightInPixels).toBe(706)

	// Don't test SIP for now, since the latest ASTAP version doesn't returning it
	// expect(solution!.CTYPE1).toBe('RA---TAN-SIP')
})
