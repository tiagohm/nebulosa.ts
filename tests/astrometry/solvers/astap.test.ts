import { afterAll, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { AstapError, astapDetectStars, astapPlateSolve } from '../../../src/astrometry/solvers/astap'
import { deg, hour, toArcmin, toArcsec, toDeg, toHour } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'
import { isBinaryTestSkipped } from '../../util'

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
