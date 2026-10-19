import { describe, expect, test } from 'bun:test'
import type { DigitalImage, Image } from '../../../src/imaging/model/types'
import { aperturePhotometry, type PhotometryAperture } from '../../../src/imaging/stars/photometry'

function makeImage(width: number, height: number, value: (x: number, y: number) => number, channels: number = 1): Image {
	const raw = new Float64Array(width * height * channels)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[(y * width + x) * channels + c] = value(x, y) * (c + 1)
	return { header: {}, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined } }
}

// Analytic sky with deterministic structure plus a Gaussian star at (20.3, 18.6), reproduced exactly in NumPy.
const reference = makeImage(48, 40, (x, y) => 100 + 5 * Math.sin(0.7 * x + 1.3 * y) + 3 * Math.cos(1.1 * x - 0.4 * y) + 2000 * Math.exp(-((x - 20.3) ** 2 + (y - 18.6) ** 2) / (2 * 1.8 ** 2)))
const center = [{ x: 20.3, y: 18.6 }] as const
const circle: PhotometryAperture = { shape: 'circle', radius: 4.37, annulus: { inner: 8.4, outer: 13.7 } }
const ellipse: PhotometryAperture = { shape: 'ellipse', a: 5.2, b: 3.1, theta: 0.6, annulus: { inner: 8.4, outer: 13.7 } }

// Reference values from Photutils 3.1.1 (Astropy 8.0.2, NumPy 2.5.3): aperture_photometry sums,
// area_overlap, ApertureStats with SigmaClip(sigma=3, maxiters=10) and the center-method error sum.
describe('photutils comparison', () => {
	test('circular aperture sums and areas', () => {
		const exact = aperturePhotometry(reference, center, circle)[0]
		expect(exact.sum).toBeCloseTo(44432.486809259695, 8)
		expect(exact.area).toBeCloseTo(59.99468074633893, 12)
		const subpixel = aperturePhotometry(reference, center, circle, { method: 'subpixel', subpixels: 5 })[0]
		expect(subpixel.sum).toBeCloseTo(44444.64893344733, 8)
		expect(subpixel.area).toBeCloseTo(60, 12)
		const centered = aperturePhotometry(reference, center, circle, { method: 'center' })[0]
		expect(centered.sum).toBeCloseTo(44377.18572085144, 8)
		expect(centered.area).toBe(59)
	})

	test('elliptical aperture sums and areas', () => {
		const exact = aperturePhotometry(reference, center, ellipse)[0]
		expect(exact.sum).toBeCloseTo(40817.797531664626, 8)
		expect(exact.area).toBeCloseTo(50.64247357586747, 12)
		const subpixel = aperturePhotometry(reference, center, ellipse, { method: 'subpixel' })[0]
		expect(subpixel.sum).toBeCloseTo(40818.05695534527, 8)
		expect(subpixel.area).toBeCloseTo(50.64, 12)
		const centered = aperturePhotometry(reference, center, ellipse, { method: 'center' })[0]
		expect(centered.sum).toBeCloseTo(40726.54405886974, 8)
		expect(centered.area).toBe(51)
	})

	test('sigma-clipped annulus statistics', () => {
		const round = aperturePhotometry(reference, center, circle)[0]
		expect(round.background).toBeCloseTo(100.40027267355381, 12)
		expect(round.backgroundDeviation).toBeCloseTo(4.199320776010755, 12)
		const elongated = aperturePhotometry(reference, center, ellipse)[0]
		expect(elongated.background).toBeCloseTo(100.59298359704053, 12)
		expect(elongated.backgroundDeviation).toBeCloseTo(4.290464350698633, 12)
		expect(aperturePhotometry(reference, center, ellipse, { backgroundStatistic: 'mean' })[0].background).toBeCloseTo(100.83317331223907, 12)
		const unclipped = aperturePhotometry(reference, center, ellipse, { clipIterations: 0 })[0]
		expect(unclipped.background).toBeCloseTo(100.91637894713641, 12)
		expect(unclipped.backgroundRejected).toBe(0)
		expect(elongated.backgroundRejected).toBe(unclipped.backgroundCount - elongated.backgroundCount)
		expect(elongated.backgroundRejected).toBeGreaterThan(0)
	})

	test('truncated area at the borders', () => {
		const corner = aperturePhotometry(reference, [{ x: 1.2, y: 2.7 }], { shape: 'circle', radius: 4.3 })[0]
		expect(corner.area).toBeCloseTo(39.43197270773068, 12)
		expect(corner.truncatedArea).toBeCloseTo(58.08804816487527 - 39.43197270773068, 12)
		expect(corner.flags).toEqual(['truncated'])
		const opposite = aperturePhotometry(reference, [{ x: 45.9, y: 38.4 }], { shape: 'ellipse', a: 5.2, b: 3.1, theta: 0.6 })[0]
		expect(opposite.area).toBeCloseTo(27.318574235192337, 12)
		expect(opposite.truncatedArea).toBeCloseTo(50.64247357586747 - 27.318574235192337, 12)
	})

	test('error map propagation with the center method', () => {
		const variance = reference.raw.map((value) => Math.abs(value) / 2 + 25)
		const result = aperturePhotometry(reference, center, { shape: 'circle', radius: 4.3 }, { method: 'center', uncertainty: { kind: 'variance', data: variance } })[0]
		expect(result.sum).toBeCloseTo(43754.67111397754, 8)
		expect(result.fluxError).toBeCloseTo(152.56911731077417, 9)
		const weighted = aperturePhotometry(reference, center, { shape: 'circle', radius: 4.3 }, { method: 'center', uncertainty: { kind: 'inverseVariance', data: variance.map((v) => 1 / v) } })[0]
		expect(weighted.fluxError).toBeCloseTo(152.56911731077417, 9)
	})
})

describe('geometry', () => {
	const uniform = makeImage(40, 40, () => 1)

	test('exact area is the ellipse area for any subpixel center', () => {
		for (const [x, y] of [
			[20, 20],
			[20.5, 20.5],
			[19.73, 20.21],
		]) {
			const [round, flat] = aperturePhotometry(
				uniform,
				[
					{ x, y },
					{ x, y },
				],
				[
					{ shape: 'circle', radius: 3.6 },
					{ shape: 'ellipse', a: 6.1, b: 2.3, theta: 2.2 },
				],
			)
			expect(round.area).toBeCloseTo(Math.PI * 3.6 * 3.6, 12)
			expect(round.sum).toBeCloseTo(round.area, 12)
			expect(flat.area).toBeCloseTo(Math.PI * 6.1 * 2.3, 12)
			expect(flat.flags).toEqual([])
		}
	})

	test('tiny aperture inside one pixel and finer subpixel sampling', () => {
		expect(aperturePhotometry(uniform, [{ x: 10.1, y: 10.2 }], { shape: 'circle', radius: 0.2 })[0].area).toBeCloseTo(Math.PI * 0.04, 14)
		expect(aperturePhotometry(uniform, [{ x: 10.43, y: 10.2 }], { shape: 'circle', radius: 0.2 })[0].area).toBeCloseTo(Math.PI * 0.04, 14)
		const fine = aperturePhotometry(uniform, [{ x: 19.73, y: 20.21 }], { shape: 'circle', radius: 3.6 }, { method: 'subpixel', subpixels: 64 })[0]
		expect(Math.abs(fine.area - Math.PI * 3.6 * 3.6)).toBeLessThan(5e-3)
	})

	test('orientation follows +X toward +Y', () => {
		const ramp = makeImage(40, 40, (x, y) => 1 + x + 3 * y)
		const along = aperturePhotometry(ramp, [{ x: 20.2, y: 19.6 }], { shape: 'ellipse', a: 5, b: 2, theta: Math.PI / 2 })[0]
		const swapped = aperturePhotometry(ramp, [{ x: 20.2, y: 19.6 }], { shape: 'ellipse', a: 2, b: 5, theta: 0 })[0]
		expect(along.sum).toBeCloseTo(swapped.sum, 10)
		expect(along.area).toBeCloseTo(Math.PI * 10, 12)
	})

	test('truncated area complements the in-image area', () => {
		const result = aperturePhotometry(uniform, [{ x: 0.3, y: 39.1 }], { shape: 'ellipse', a: 4.4, b: 2.7, theta: -0.4 })[0]
		expect(result.area + result.truncatedArea).toBeCloseTo(Math.PI * 4.4 * 2.7, 12)
		expect(result.flags).toEqual(['truncated'])
		const outside = aperturePhotometry(uniform, [{ x: -20, y: -20 }], { shape: 'circle', radius: 3 })[0]
		expect(outside.area).toBe(0)
		expect(outside.flux).toBe(0)
		expect(outside.flags).toEqual(['truncated', 'empty'])
	})
})

describe('sources and background', () => {
	// Sky of 100 plus a pixel-sampled circular Gaussian of total flux 10000 and sigma 1.5 pixels.
	const sky = 100
	const total = 10000
	const sigma = 1.5
	const star = (x: number, y: number, cx: number, cy: number) => (total / (2 * Math.PI * sigma * sigma)) * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma))
	const field = makeImage(64, 64, (x, y) => sky + star(x, y, 20.37, 30.81) + star(x, y, 44.62, 25.14))
	const apertures: PhotometryAperture = { shape: 'circle', radius: 8, annulus: { inner: 10, outer: 15 } }

	test('recovers the known flux of point sources', () => {
		const results = aperturePhotometry(
			field,
			[
				{ x: 20.37, y: 30.81 },
				{ x: 44.62, y: 25.14 },
			],
			apertures,
		)

		for (const result of results) {
			expect(result.background).toBeCloseTo(sky, 2)
			expect(result.flux! / total).toBeCloseTo(1, 4)
			expect(result.flags).toEqual([])
		}
	})

	test('rejects a contaminating star in the annulus', () => {
		const contaminated = makeImage(64, 64, (x, y) => sky + 2 * Math.sin(x * 1.7 + y * 0.9) + star(x, y, 20.37, 30.81) + 3 * star(x, y, 32.2, 30.5))
		const clipped = aperturePhotometry(contaminated, [{ x: 20.37, y: 30.81 }], apertures)[0]
		const raw = aperturePhotometry(contaminated, [{ x: 20.37, y: 30.81 }], apertures, { clipIterations: 0, backgroundStatistic: 'mean' })[0]
		expect(clipped.backgroundRejected).toBeGreaterThan(0)
		expect(Math.abs(clipped.background! - sky)).toBeLessThan(0.3)
		expect(raw.background! - sky).toBeGreaterThan(3)
		// The contaminating wings inside the aperture are real signal; only the sky estimate must be unbiased.
		expect(Math.abs(clipped.flux! - (clipped.sum - sky * clipped.area))).toBeLessThan(0.3 * clipped.area)
		expect(clipped.flux! - raw.flux!).toBeGreaterThan(3 * raw.area)
	})

	test('masks and non-finite samples are excluded', () => {
		const masked = makeImage(64, 64, (x, y) => sky + star(x, y, 20.37, 30.81))
		masked.raw[30 * 64 + 25] = Number.NaN
		const mask = new Uint8Array(64 * 64)
		mask[31 * 64 + 20] = 1
		const all = new Uint8Array(64 * 64).fill(1)
		const reference = aperturePhotometry(field, [{ x: 20.37, y: 30.81 }], apertures)[0]
		const result = aperturePhotometry(masked, [{ x: 20.37, y: 30.81 }], apertures, { mask })[0]
		expect(result.maskedArea).toBeCloseTo(2, 12)
		expect(result.area).toBeCloseTo(reference.area - 2, 12)
		expect(result.flags).toEqual(['masked'])
		expect(result.flux!).toBeLessThan(total - star(20, 31, 20.37, 30.81) + 1)

		const empty = aperturePhotometry(masked, [{ x: 20.37, y: 30.81 }], apertures, { mask: all })[0]
		expect(empty.flags).toEqual(['masked', 'noBackground', 'empty'])
		expect(empty.flux).toBeUndefined()
		expect(empty.fluxError).toBeUndefined()
		expect(empty.snr).toBeUndefined()
	})

	test('saturated pixels are flagged in the aperture and excluded from the sky', () => {
		const level = sky + star(20, 31, 20.37, 30.81)
		const result = aperturePhotometry(field, [{ x: 20.37, y: 30.81 }], apertures, { saturationLevel: level })[0]
		expect(result.saturatedCount).toBe(1)
		expect(result.flags).toEqual(['saturated'])
		const sky2 = makeImage(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) > 12 && (x + y) % 3 === 0 ? 1000 : sky))
		const excluded = aperturePhotometry(sky2, [{ x: 32, y: 32 }], apertures, { saturationLevel: 1000, clipIterations: 0, backgroundStatistic: 'mean' })[0]
		expect(excluded.background).toBe(sky)
		expect(excluded.saturatedCount).toBe(0)
	})

	test('no usable annulus sample gives no flux', () => {
		const result = aperturePhotometry(field, [{ x: 20.37, y: 30.81 }], { shape: 'circle', radius: 3, annulus: { inner: 200, outer: 300 } })[0]
		expect(result.flags).toEqual(['noBackground'])
		expect(result.background).toBeUndefined()
		expect(result.backgroundCount).toBe(0)
		expect(result.flux).toBeUndefined()
		expect(result.sum).toBeGreaterThan(0)
	})
})

describe('uncertainty', () => {
	// Flat calibrated sky of S DN per pixel; the center method gives unit weights, so the CCD equation is exact.
	const S = 400
	const flat = makeImage(50, 50, () => S)
	const aperture: PhotometryAperture = { shape: 'circle', radius: 4.2 }
	const at = [{ x: 25, y: 25 }]
	const n = aperturePhotometry(flat, at, aperture, { method: 'center' })[0].area

	test('poisson dominated regime', () => {
		const result = aperturePhotometry(flat, at, aperture, { method: 'center', noise: { gain: 2 }, background: { level: S } })[0]
		expect(result.flux).toBe(0)
		expect(result.fluxError).toBeCloseTo(Math.sqrt((n * S) / 2), 12)
		expect(result.snr).toBe(0)
	})

	test('read-noise and dark dominated regime with pedestal', () => {
		const pedestal = makeImage(50, 50, () => 1000 + 3)
		const result = aperturePhotometry(pedestal, at, aperture, { method: 'center', noise: { gain: 0.5, readNoise: 12, dark: { current: 0.2, exposureTime: 300 }, offset: 1000 }, background: { level: 1003, error: 0.1 } })[0]
		const variance = n * (3 / 0.5 + (144 + 60) / 0.25) + n * n * 0.01
		expect(result.fluxError).toBeCloseTo(Math.sqrt(variance), 10)
	})

	test('fractional weights enter squared', () => {
		const exact = aperturePhotometry(flat, [{ x: 25.31, y: 24.77 }], aperture, { noise: { gain: 1 }, background: { level: 0 } })[0]
		expect(exact.fluxError! ** 2).toBeLessThan(exact.area * S)
		expect(exact.fluxError! ** 2).toBeGreaterThan(exact.area * S * 0.9)
	})

	test('empirical sky noise, background error and noise correlation', () => {
		const noisy = makeImage(60, 60, (x, y) => 50 + 4 * Math.sin(x * 2.1 + y * 1.3))
		const annulus: PhotometryAperture = { shape: 'circle', radius: 3, annulus: { inner: 6, outer: 12 } }
		const result = aperturePhotometry(noisy, [{ x: 30, y: 30 }], annulus, { method: 'center' })[0]
		const deviation = result.backgroundDeviation!
		const backgroundError = deviation * Math.sqrt(Math.PI / 2 / result.backgroundCount)
		expect(result.backgroundError).toBeCloseTo(backgroundError, 14)
		expect(result.fluxError).toBeCloseTo(Math.sqrt(deviation * deviation * result.area + result.area * result.area * backgroundError * backgroundError), 12)
		const mean = aperturePhotometry(noisy, [{ x: 30, y: 30 }], annulus, { method: 'center', backgroundStatistic: 'mean' })[0]
		expect(mean.backgroundError).toBeCloseTo(mean.backgroundDeviation! / Math.sqrt(mean.backgroundCount), 14)
		const correlated = aperturePhotometry(noisy, [{ x: 30, y: 30 }], annulus, { method: 'center', noiseCorrelation: 4 })[0]
		expect(correlated.fluxError).toBeCloseTo(2 * result.fluxError!, 12)
		expect(aperturePhotometry(noisy, [{ x: 30, y: 30 }], { shape: 'circle', radius: 3 })[0].fluxError).toBeUndefined()
	})

	test('invalid uncertainty map entries mask pixels', () => {
		const variance = new Float64Array(2500).fill(4)
		variance[25 * 50 + 25] = -1
		const result = aperturePhotometry(flat, at, aperture, { method: 'center', uncertainty: { kind: 'variance', data: variance } })[0]
		expect(result.maskedArea).toBe(1)
		expect(result.fluxError).toBeCloseTo(Math.sqrt(4 * (n - 1)), 12)
	})
})

describe('inputs', () => {
	test('digital image and channel selection', () => {
		const color = makeImage(30, 30, () => 10, 3)
		const green = aperturePhotometry(color, [{ x: 15, y: 15 }], { shape: 'circle', radius: 2 }, { channel: 'GREEN' })[0]
		expect(green.sum).toBeCloseTo(20 * Math.PI * 4, 10)
		const digital: DigitalImage = { ...makeImage(30, 30, () => 1000), sampleScale: 'digital' }
		expect(aperturePhotometry(digital, [{ x: 15, y: 15 }], { shape: 'circle', radius: 2 })[0].sum).toBeCloseTo(4000 * Math.PI, 9)
	})

	test('rejects mismatched inputs', () => {
		const image = makeImage(10, 10, () => 1)
		const at = [{ x: 5, y: 5 }]
		const aperture: PhotometryAperture = { shape: 'circle', radius: 2 }
		expect(() => aperturePhotometry(image, at, [aperture, aperture])).toThrow(RangeError)
		expect(() => aperturePhotometry(image, at, aperture, { mask: new Uint8Array(5) })).toThrow(RangeError)
		expect(() => aperturePhotometry(image, at, aperture, { uncertainty: { kind: 'variance', data: new Float64Array(5) } })).toThrow(RangeError)
		expect(() => aperturePhotometry(image, at, aperture, { channel: 'BLUE' })).toThrow(RangeError)
		expect(() => aperturePhotometry(image, at, aperture, { method: 'subpixel', subpixels: 0 })).toThrow(TypeError)
		expect(aperturePhotometry(image, [], aperture)).toEqual([])
	})
})
