import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { localAstrometryNetPlateSolve, login, novaAstrometryNetPlateSolve, submissionStatus, upload, wcsFile } from '../../../src/astrometry/solvers/astrometrynet'
import { PlateSolveError } from '../../../src/astrometry/solvers/platesolver'
import { RA_TAN_SIP, tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import { type FitsHeader, readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { toArcsec, toDeg, toHour } from '../../../src/math/units/angle'
import { FAKE_EXECUTABLE_PROBE, headerOnlyFits, isLinuxSkipped, isNetworkTestSkipped, settleExecutable } from '../../util'

const SKIP = isNetworkTestSkipped()

describe.skipIf(SKIP)('nova', () => {
	test('login', async () => {
		const session = await login()

		expect(session).toBeDefined()
		expect(session!.status).toBe('success')
		expect(session!.session).not.toBeEmpty()
	})

	test.skip('upload url', async () => {
		const session = await login()

		expect(session).toBeDefined()

		if (session) {
			const input = 'https://github.com/dstndstn/astrometry.net/blob/main/demo/apod1.jpg?raw=true'
			const submission = await upload({ input, session })

			expect(submission).toBeDefined()
			expect(submission!.status).toBe('success')
			expect(submission!.subid).toBeDefined()
		}
	})

	test('submission status', async () => {
		const session = await login()

		expect(session).toBeDefined()

		if (session) {
			const status = await submissionStatus(12174168, { session })

			expect(status!.processing_started).not.toBeEmpty()
			expect(status!.processing_finished).not.toBeEmpty()
			expect(status!.jobs).not.toBeEmpty()
		}
	})

	test('wcs', async () => {
		const session = await login()

		expect(session).toBeDefined()

		if (session) {
			const status = await wcsFile(13003925, { session })

			expect(status).toBeDefined()
			expect(status!.size).toBe(63360)

			const buffer = Buffer.from(await status!.arrayBuffer())
			const fits = await readFits(bufferSource(buffer))
			const [ra, dec] = tanUnproject(fits!.hdus[0].header, 400.5, 263.5)!

			expect(toDeg(ra)).toBeCloseTo(100.215755, 6)
			expect(toDeg(dec)).toBeCloseTo(9.831592, 6)
		}
	})

	// https://nova.astrometry.net/status/12190450
	test.skip('plate solve url', async () => {
		const input = 'https://github.com/dstndstn/astrometry.net/blob/main/demo/apod1.jpg?raw=true'
		const solution = await novaAstrometryNetPlateSolve(input)

		expect(solution).toBeDefined()

		const [ra, dec] = tanUnproject(solution!, 400.5, 263.5)!

		expect(toDeg(ra)).toBeCloseTo(100.215755, 5)
		expect(toDeg(dec)).toBeCloseTo(9.831592, 5)
	}, 300000)

	// https://nova.astrometry.net/status/12189544
	test.skip('plate solve file', async () => {
		const input = Bun.file('data/apod4.jpg')
		const solution = await novaAstrometryNetPlateSolve(input)

		expect(solution).toBeDefined()

		const [ra, dec] = tanUnproject(solution!, 359.5, 253.5)!

		expect(toDeg(ra)).toBeCloseTo(187.1252286, 3)
		expect(toDeg(dec)).toBeCloseTo(56.720194049, 3)
	}, 300000)
})

test('nova plate solve sends every request to the configured api url', async () => {
	const paths: string[] = []

	using server = Bun.serve({
		port: 0,
		fetch(req) {
			const { pathname } = new URL(req.url)
			paths.push(pathname)
			if (pathname === '/api/url_upload') return Response.json({ status: 'success', subid: 3 })
			if (pathname === '/api/submissions/3') return Response.json({ jobs: [7] })
			if (pathname === '/api/jobs/7') return Response.json({ status: 'success' })
			return new Response(undefined, { status: 404 })
		},
	})

	const solution = await novaAstrometryNetPlateSolve('https://example.com/image.jpg', { apiUrl: server.url.origin, session: 'session' })

	expect(solution).toBeUndefined()
	expect(paths).toEqual(['/api/url_upload', '/api/submissions/3', '/api/jobs/7', '/wcs_file/7'])
})

describe('local with a fake solve-field', () => {
	// A TAN-SIP-free solution of a 100x50 image, as solve-field writes it (IMAGEW/IMAGEH, no NAXIS1/NAXIS2).
	const SOLVED_WCS = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 50.5, CRPIX2: 25.5, CRVAL1: 42, CRVAL2: -17, CD1_1: 0.0005, CD1_2: 0, CD2_1: 0, CD2_2: 0.0005, IMAGEW: 100, IMAGEH: 50 } as const

	let fakes = ''
	let count = 0

	beforeAll(async () => {
		fakes = await mkdtemp(join(tmpdir(), 'nebulosa-solve-field-'))
	})

	afterAll(() => rm(fakes, { recursive: true, force: true }))

	interface FakeSolveField {
		// Header of the nebulosa.wcs written into the --dir directory (the fifth argument); none when absent.
		readonly wcs?: FitsHeader
		readonly stderr?: string
		readonly sleep?: number
		readonly exitCode?: number
	}

	// Writes an executable behaving like solve-field. It records its arguments in args.txt next to itself.
	async function fakeSolveField({ wcs, stderr, sleep = 0, exitCode = 0 }: FakeSolveField) {
		const directory = join(fakes, `run${++count}`)
		await mkdir(directory)
		const input = join(directory, 'frame.fit')
		const args = join(directory, 'args.txt')
		await Bun.write(input, 'SIMPLE')
		if (wcs) await Bun.write(join(directory, 'out.wcs'), headerOnlyFits(wcs))

		if (process.platform === 'win32') {
			const lines = [
				'@echo off',
				`if defined ${FAKE_EXECUTABLE_PROBE} exit /b 0`,
				`echo %*> "${args}"`,
				...(sleep > 0 ? [`ping -n ${sleep + 1} 127.0.0.1 >nul`] : []),
				...(wcs ? [`mkdir "%~5" 2>nul`, `copy /y "${join(directory, 'out.wcs')}" "%~5\\nebulosa.wcs" >nul`] : []),
				...(stderr ? [`echo ${stderr} 1>&2`] : []),
				`exit /b ${exitCode}`,
			]
			const executable = join(directory, 'solve-field.cmd')
			await Bun.write(executable, lines.join('\r\n'))
			await settleExecutable(executable)
			return { executable, input, args }
		}

		const lines = ['#!/bin/sh', `[ -n "$${FAKE_EXECUTABLE_PROBE}" ] && exit 0`, `echo "$@" > '${args}'`, ...(sleep > 0 ? [`sleep ${sleep}`] : []), ...(wcs ? [`mkdir -p "$5"`, `cp '${join(directory, 'out.wcs')}' "$5/nebulosa.wcs"`] : []), ...(stderr ? [`echo '${stderr}' >&2`] : []), `exit ${exitCode}`]
		const executable = join(directory, 'solve-field')
		await Bun.write(executable, lines.join('\n'))
		await chmod(executable, 0o755)
		await settleExecutable(executable)
		return { executable, input, args }
	}

	// Awaits a plate solve that must fail, returning its error.
	async function solveError(promise: Promise<unknown>) {
		try {
			await promise
		} catch (error) {
			expect(error).toBeInstanceOf(PlateSolveError)
			return error as PlateSolveError
		}

		throw new Error('the plate solve did not fail')
	}

	test('builds the solution from the WCS and passes the backend configuration', async () => {
		const { executable, input, args } = await fakeSolveField({ wcs: SOLVED_WCS })
		const solution = await localAstrometryNetPlateSolve(input, { executable, config: 'backend.cfg', timeout: 60000 })

		expect(solution).toBeDefined()
		expect(solution!.widthInPixels).toBe(100)
		expect(solution!.heightInPixels).toBe(50)
		expect(toDeg(solution!.rightAscension)).toBeCloseTo(42, 6)

		const recorded = await Bun.file(args).text()
		expect(recorded).toContain('--config backend.cfg')
		expect(recorded).toContain('--cpulimit 60')
	})

	test('resolves undefined when solve-field wrote no WCS', async () => {
		const { executable, input } = await fakeSolveField({})
		expect(await localAstrometryNetPlateSolve(input, { executable })).toBeUndefined()
	})

	test('fails with the exit code and the error output', async () => {
		const { executable, input } = await fakeSolveField({ stderr: 'no index files', exitCode: 3 })
		const error = await solveError(localAstrometryNetPlateSolve(input, { executable }))

		expect(error.code).toBe('failed')
		expect(error.message).toContain('exit code 3')
		expect(error.message).toContain('no index files')
	})

	test('fails for a WCS that is not an equatorial TAN solution', async () => {
		const { executable, input } = await fakeSolveField({ wcs: { ...SOLVED_WCS, RADESYS: 'FK4' } })
		const error = await solveError(localAstrometryNetPlateSolve(input, { executable }))

		expect(error.code).toBe('failed')
	})

	test('fails as unavailable when the executable cannot be started', async () => {
		const { input } = await fakeSolveField({})
		const error = await solveError(localAstrometryNetPlateSolve(input, { executable: join(dirname(input), 'missing.exe') }))

		expect(error.code).toBe('unavailable')
	})

	test('kills solve-field when aborted', async () => {
		const { executable, input } = await fakeSolveField({ sleep: 5 })
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 300)
		const error = await solveError(localAstrometryNetPlateSolve(input, { executable }, controller.signal))

		expect(error.code).toBe('aborted')
	}, 15000)
})

test('nova plate solve fails when the login is refused', async () => {
	const paths: string[] = []

	using server = Bun.serve({
		port: 0,
		fetch(req) {
			paths.push(new URL(req.url).pathname)
			return Response.json({ status: 'error', errormessage: 'bad apikey' })
		},
	})

	try {
		await novaAstrometryNetPlateSolve('https://example.com/image.jpg', { apiUrl: server.url.origin, apiKey: 'wrong' })
		throw new Error('the plate solve did not fail')
	} catch (error) {
		expect(error).toBeInstanceOf(PlateSolveError)
		expect((error as PlateSolveError).code).toBe('unavailable')
		expect((error as PlateSolveError).message).toContain('bad apikey')
	}

	expect(paths).toEqual(['/api/login'])
})

test.skipIf(isLinuxSkipped())('local', async () => {
	const solution = await localAstrometryNetPlateSolve(join(dirname(__dirname), 'data', 'apod4.jpg'), {
		executable: 'solve-field',
	})

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(58.5073, 3)
	expect(toArcsec(solution!.scale)).toBeCloseTo(171.041, 3)
	expect(toHour(solution!.rightAscension)).toBeCloseTo(12.4786, 3)
	expect(toDeg(solution!.declination)).toBeCloseTo(56.7088, 3)
	expect(toDeg(solution!.width)).toBeCloseTo(34.11468, 3)
	expect(toDeg(solution!.height)).toBeCloseTo(24.08831, 3)
	expect(toDeg(solution!.radius)).toBeCloseTo(20.88096, 3)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(719)
	expect(solution!.heightInPixels).toBe(507)

	expect(solution!.CTYPE1).toBe(RA_TAN_SIP)
})
