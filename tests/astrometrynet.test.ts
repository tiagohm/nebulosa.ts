import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'path/posix'
import { toArcsec, toDeg, toHour } from '../src/angle'
import { localAstrometryNetPlateSolve, login, novaAstrometryNetPlateSolve, submissionStatus, upload, wcsFile } from '../src/astrometrynet'
import { readFits } from '../src/fits'
import { bufferSource } from '../src/io'
import { Wcs } from '../src/wcs'

describe.skip('nova', () => {
	test('login', async () => {
		const session = await login()

		expect(session).not.toBeUndefined()
		expect(session!.status).toBe('success')
		expect(session!.session).not.toBeEmpty()
	})

	test('upload url', async () => {
		const session = await login()

		expect(session).not.toBeUndefined()

		if (session) {
			const input = 'https://github.com/dstndstn/astrometry.net/blob/main/demo/apod1.jpg?raw=true'
			const submission = await upload({ input, session })

			expect(submission).not.toBeUndefined()
			expect(submission!.status).toBe('success')
			expect(submission!.subid).not.toBeUndefined()
		}
	})

	test('submission status', async () => {
		const session = await login()

		expect(session).not.toBeUndefined()

		if (session) {
			const status = await submissionStatus(12174168, { session })

			expect(status!.processing_started).not.toBeEmpty()
			expect(status!.processing_finished).not.toBeEmpty()
			expect(status!.jobs).not.toBeEmpty()
		}
	})

	test('wcs', async () => {
		const session = await login()

		expect(session).not.toBeUndefined()

		if (session) {
			const status = await wcsFile(13003925, { session })

			expect(status).not.toBeUndefined()
			expect(status!.size).toBe(63360)

			const buffer = Buffer.from(await status!.arrayBuffer())
			const fits = await readFits(bufferSource(buffer))
			using wcs = new Wcs(fits?.hdus[0].header)

			const [ra, dec] = wcs.pixToSky(400.5, 263.5)!

			expect(toDeg(ra)).toBeCloseTo(100.215755, 6)
			expect(toDeg(dec)).toBeCloseTo(9.831592, 6)
		}
	})

	// https://nova.astrometry.net/status/12190450
	test('plate solve url', async () => {
		const input = 'https://github.com/dstndstn/astrometry.net/blob/main/demo/apod1.jpg?raw=true'
		const solution = await novaAstrometryNetPlateSolve(input)

		expect(solution).not.toBeUndefined()

		using wcs = new Wcs(solution)

		const [ra, dec] = wcs.pixToSky(400.5, 263.5)!

		expect(toDeg(ra)).toBeCloseTo(100.215755, 6)
		expect(toDeg(dec)).toBeCloseTo(9.831592, 6)
	}, 300000)

	// https://nova.astrometry.net/status/12189544
	test('plate solve file', async () => {
		const input = Bun.file('data/apod4.jpg')
		const solution = await novaAstrometryNetPlateSolve(input)

		expect(solution).not.toBeUndefined()

		using wcs = new Wcs(solution)

		const [ra, dec] = wcs.pixToSky(359.5, 253.5)!

		expect(toDeg(ra)).toBeCloseTo(187.1252286, 6)
		expect(toDeg(dec)).toBeCloseTo(56.720194049, 6)
	}, 300000)
})

test.skip('local', async () => {
	const solution = await localAstrometryNetPlateSolve(join(dirname(__dirname), 'data', 'apod4.jpg'), {
		executable: 'solve-field',
	})

	expect(solution).not.toBeUndefined()
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

	expect(solution!.CTYPE1).toBe('RA---TAN-SIP')
})
