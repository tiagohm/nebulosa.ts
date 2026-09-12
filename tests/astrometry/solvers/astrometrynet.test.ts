import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'path'
import { localAstrometryNetPlateSolve, login, novaAstrometryNetPlateSolve, submissionStatus, type Upload, upload, wcsFile } from '../../../src/astrometry/solvers/astrometrynet'
import { RA_TAN_SIP, tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import { readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { arcmin, arcsec, deg, toArcsec, toDeg, toHour } from '../../../src/math/units/angle'
import { isLinuxSkipped, isNetworkTestSkipped } from '../../util'

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

test('radius-only solve-field hint does not force RA 0 Dec 90', async () => {
	const calls: string[][] = []
	const original = Bun.spawn
	Bun.spawn = ((cmd: string[]) => {
		calls.push([...cmd])
		return { exited: Promise.resolve(1) }
	}) as typeof Bun.spawn

	try {
		await localAstrometryNetPlateSolve('img.fit', { executable: 'solve-field', radius: deg(5) })
		expect(calls).toHaveLength(1)
		expect(calls[0]).not.toContain('--ra')
		expect(calls[0]).not.toContain('--dec')
		expect(calls[0]).not.toContain('--radius')

		await localAstrometryNetPlateSolve('img.fit', { executable: 'solve-field', rightAscension: deg(83.8), declination: deg(-5.4), radius: deg(5) })
		expect(calls).toHaveLength(2)
		const args = calls[1]
		expect(+args[args.indexOf('--ra') + 1]).toBeCloseTo(83.8, 4)
		expect(+args[args.indexOf('--dec') + 1]).toBeCloseTo(-5.4, 4)
		expect(args[args.indexOf('--radius') + 1]).toBe('5')
	} finally {
		Bun.spawn = original
	}
})

test('upload converts scale bounds into scaleUnits', async () => {
	const arcsecPerPix = await captureUploadJson({ scaleUnits: 'arcsecperpix', scaleLower: arcsec(1), scaleUpper: arcsec(5) })
	expect(arcsecPerPix.scale_units).toBe('arcsecperpix')
	expect(arcsecPerPix.scale_lower).toBeCloseTo(1, 12)
	expect(arcsecPerPix.scale_upper).toBeCloseTo(5, 12)

	const arcminWidth = await captureUploadJson({ scaleUnits: 'arcminwidth', scaleLower: arcmin(30), scaleUpper: arcmin(90), scaleType: 'ev', scaleEstimated: arcmin(60) })
	expect(arcminWidth.scale_units).toBe('arcminwidth')
	expect(arcminWidth.scale_lower).toBeCloseTo(30, 12)
	expect(arcminWidth.scale_upper).toBeCloseTo(90, 12)
	expect(arcminWidth.scale_est).toBeCloseTo(60, 12)

	const degWidth = await captureUploadJson({ scaleLower: deg(2), scaleUpper: deg(10) })
	expect(degWidth.scale_units).toBe('degwidth')
	expect(degWidth.scale_lower).toBeCloseTo(2, 12)
	expect(degWidth.scale_upper).toBeCloseTo(10, 12)

	const degDefaults = await captureUploadJson({})
	expect(degDefaults.scale_units).toBe('degwidth')
	expect(degDefaults.scale_lower).toBe(0.1)
	expect(degDefaults.scale_upper).toBe(180)

	const arcsecDefaults = await captureUploadJson({ scaleUnits: 'arcsecperpix' })
	expect(arcsecDefaults.scale_units).toBe('arcsecperpix')
	expect(arcsecDefaults.scale_lower).toBeUndefined()
	expect(arcsecDefaults.scale_upper).toBeUndefined()
})

async function captureUploadJson(options: Omit<Upload<string>, 'input'>) {
	const restore = globalThis.fetch
	let payload: Record<string, unknown> | undefined

	globalThis.fetch = ((_input, init) => {
		payload = uploadRequestJson(init?.body)
		return Promise.resolve(new Response(JSON.stringify({ status: 'success', subid: 1 }), { status: 200 }))
	}) as typeof fetch

	try {
		await upload({ input: 'https://example.com/img.fits', session: 'tok', ...options })
		return payload!
	} finally {
		globalThis.fetch = restore
	}
}

function uploadRequestJson(body: BodyInit | undefined | null) {
	if (body instanceof URLSearchParams) return JSON.parse(body.get('request-json') ?? '{}') as Record<string, unknown>
	if (typeof body === 'string') return JSON.parse(new URLSearchParams(body).get('request-json') ?? '{}') as Record<string, unknown>
	throw new Error('expected url-encoded nova request-json')
}
