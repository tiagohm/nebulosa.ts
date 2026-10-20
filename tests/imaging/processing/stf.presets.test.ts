import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { adf, histogram, median, medianAbsoluteDeviation } from '../../../src/imaging/processing/computation'
import { stf } from '../../../src/imaging/processing/stf'
import { AUTO_STF_PRESETS, type AutoStfPreset, type AutoStfQuantilePreset, autoStf } from '../../../src/imaging/processing/stf.presets'
import { makeImage } from './util'

const PRESETS: readonly AutoStfPreset[] = ['low', 'medium', 'high', 'moon', 'planet']

// Deterministic sky: a faint noisy background with a few bright stars.
function makeSky(width: number = 48, height: number = 48, channels: number = 1, sky: number = 0.05) {
	let seed = 7
	const raw = new Float32Array(width * height * channels)

	for (let i = 0; i < raw.length; i++) {
		seed = (seed * 1664525 + 1013904223) >>> 0
		raw[i] = sky + 0.004 * (i % channels) + (seed / 0xffffffff - 0.5) * 0.01
	}

	for (let i = 0; i < 12; i++) for (let c = 0; c < channels; c++) raw[((i * 173) % (width * height)) * channels + c] = 0.85

	return makeImage(width, height, channels, raw)
}

// Deterministic bright disk of radius 12 centered at (24, 24) with an albedo pattern over black sky.
function makeMoon(width: number = 48, height: number = 48) {
	const raw = new Float32Array(width * height)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - 24
			const dy = y - 24
			if (dx * dx + dy * dy <= 144) raw[y * width + x] = 0.45 + 0.35 * Math.sin(x * 0.7) * Math.cos(y * 0.45) + 0.004 * ((x * 7 + y * 3) % 11)
		}
	}

	return makeImage(width, height, 1, raw)
}

// Applies the transfer function to a single sample on a fresh one-pixel image.
function stretchValue(value: number, [midtone, shadow, highlight]: readonly [number, number, number]) {
	return stf(makeImage(1, 1, 1, [value]), midtone, shadow, highlight).raw[0]
}

describe('adaptive presets', () => {
	test('medium preset reproduces default ADF', () => {
		const image = makeSky()
		expect(autoStf(image)).toEqual(adf(image))
		expect(autoStf(image, 'medium', { area: { left: 4, top: 4, right: 30, bottom: 30 }, bits: 12 })).toEqual(adf(image, { area: { left: 4, top: 4, right: 30, bottom: 30 }, bits: 12 }))
	})

	test('low and high presets compute their own ADF parameters', () => {
		const image = makeSky()
		const med = median(image)
		const mad = medianAbsoluteDeviation(image, med, true)

		for (const [preset, meanBackground, clippingPoint] of [
			['low', 0.13, -3.5],
			['high', 0.35, -2],
		] as const) {
			const shadow = med + clippingPoint * mad
			const x = med - shadow
			const midtone = ((meanBackground - 1) * x) / ((2 * meanBackground - 1) * x - meanBackground)
			const [m, s, h] = autoStf(image, preset)

			expect(s).toBeCloseTo(shadow, 12)
			expect(m).toBeCloseTo(midtone, 12)
			expect(h).toBe(1)
		}
	})

	test('stronger presets brighten the sky background', () => {
		const image = makeSky()
		const med = median(image)
		const low = stretchValue(med, autoStf(image, 'low'))
		const medium = stretchValue(med, autoStf(image, 'medium'))
		const high = stretchValue(med, autoStf(image, 'high'))

		expect(low).toBeLessThan(medium)
		expect(medium).toBeLessThan(high)
		expect(autoStf(image, 'low')[1]).toBeLessThan(autoStf(image, 'high')[1])
	})
})

describe('quantile presets', () => {
	test('STF maps the chosen quantile pivot to the requested target', () => {
		const image = makeMoon()
		const area = { left: 14, top: 14, right: 34, bottom: 34 }

		for (const preset of ['moon', 'planet'] as const) {
			const { black, pivot, white, target } = AUTO_STF_PRESETS[preset] as AutoStfQuantilePreset
			const h = histogram(image, { area })
			const params = autoStf(image, preset, { area })

			expect(params[1]).toBe(h.quantile(black))
			expect(params[2]).toBe(h.quantile(white))
			expect(stretchValue(h.quantile(pivot), params)).toBeCloseTo(target, 6)
		}
	})

	test('quantile preset clips the endpoints and is monotonic between them', () => {
		const params = autoStf(makeMoon(), 'moon', { area: { left: 14, top: 14, right: 34, bottom: 34 } })
		const [, shadow, highlight] = params

		expect(stretchValue(shadow * 0.5, params)).toBe(0)
		expect(stretchValue(Math.min(1, highlight + 1e-3), params)).toBe(1)

		let previous = -1

		for (let i = 0; i <= 200; i++) {
			const value = stretchValue(shadow + ((highlight - shadow) * i) / 200, params)
			expect(value).toBeGreaterThanOrEqual(previous)
			previous = value
		}
	})

	test('quantile pivot behaves correctly for bright lunar data', () => {
		const image = makeMoon()
		const area = { left: 18, top: 18, right: 30, bottom: 30 }
		const [midtone, shadow, highlight] = autoStf(image, 'moon', { area })

		// The disk median is close to 0.45, far above the sky, so the curve is driven by the disk anchors.
		expect(shadow).toBeGreaterThan(0.05)
		expect(highlight).toBeLessThan(0.85)
		expect(midtone).toBeGreaterThan(0)
		expect(midtone).toBeLessThan(1)
		expect(stretchValue(histogram(image, { area }).median, [midtone, shadow, highlight])).toBeCloseTo(0.5, 6)
	})

	test('planetary ROI excludes surrounding black pixels', () => {
		const image = makeMoon()
		const global = autoStf(image, 'planet')
		const roi = autoStf(image, 'planet', { area: { left: 18, top: 18, right: 30, bottom: 30 } })

		// Most of the frame is black sky, so the global black point sits at the empty bin.
		expect(global[1]).toBeLessThan(1e-4)
		expect(roi[1]).toBeGreaterThan(0.05)
		expect(roi[1]).toBeGreaterThan(global[1])
	})

	test('quantile preset handles zero sample variation', () => {
		const image = makeImage(8, 8, 1, new Float32Array(64).fill(0.4))

		// The constant bin still interpolates distinct quantiles, which must not create a stretch.
		expect(histogram(image).quantile(0.01)).toBeLessThan(histogram(image).quantile(0.995))
		expect(autoStf(image, 'moon')).toEqual([0.5, 0, 1])
		expect(autoStf(image, 'planet')).toEqual([0.5, 0, 1])
	})

	test('quantile preset handles empty accepted sample population', () => {
		const image = makeMoon()
		expect(autoStf(image, 'moon', { sigmaClip: new Uint8Array(image.metadata.pixelCount).fill(1) })).toEqual([0.5, 0, 1])
		// A region in the black corner holds only one level.
		expect(autoStf(image, 'planet', { area: { left: 0, top: 0, right: 5, bottom: 5 } })).toEqual([0.5, 0, 1])
	})

	test('quantile preset handles collapsed black and pivot', () => {
		const raw = new Float32Array(100)
		raw[99] = 0.6
		const params = autoStf(makeImage(10, 10, 1, raw), 'moon')

		expect(params.every(Number.isFinite)).toBe(true)
		expect(params[0]).toBeGreaterThan(0)
		expect(params[0]).toBeLessThan(1)
		expect(params[1]).toBeLessThan(params[2])
	})

	test('quantile preset handles collapsed pivot and white', () => {
		const raw = new Float32Array(100).fill(1)
		for (let i = 0; i < 20; i++) raw[i] = i * 0.01
		expect(autoStf(makeImage(10, 10, 1, raw), 'moon')).toEqual([0.5, 0, 1])
	})

	test('hot pixel rejection protects the upper quantile', () => {
		const raw = new Float32Array(100)
		for (let i = 0; i < 100; i++) raw[i] = 0.2 + 0.002 * i
		raw[57] = 1
		const image = makeImage(10, 10, 1, raw)
		const before = new Float32Array(raw)
		const mask = new Uint8Array(100)
		mask[57] = 1

		const unmasked = autoStf(image, 'moon')
		const masked = autoStf(image, 'moon', { sigmaClip: mask })

		expect(unmasked[2]).toBeGreaterThan(0.45)
		expect(masked[2]).toBeLessThan(0.4)
		expect(image.raw).toEqual(before)
	})

	test('quantiles are stable under pixel permutation', () => {
		const image = makeMoon()
		const shuffled = makeImage(48, 48, 1, image.raw.toReversed())

		expect(autoStf(shuffled, 'moon')).toEqual(autoStf(image, 'moon'))
		expect(autoStf(shuffled, 'planet')).toEqual(autoStf(image, 'planet'))
	})

	test('quantile computation honors histogram bin resolution', () => {
		const image = makeMoon()
		const area = { left: 14, top: 14, right: 34, bottom: 34 }
		const reference = autoStf(image, 'moon', { area, bits: 20 })

		for (const bits of [8, 12, 16]) {
			const params = autoStf(image, 'moon', { area, bits })
			const width = 2 / 2 ** bits
			expect(Math.abs(params[1] - reference[1])).toBeLessThan(width)
			expect(Math.abs(params[2] - reference[2])).toBeLessThan(width)
		}
	})
})

describe('shared behavior', () => {
	test('preset calculation never mutates image samples', () => {
		for (const image of [makeSky(), makeSky(16, 16, 3), makeMoon()]) {
			const before = new Float32Array(image.raw)
			for (const preset of PRESETS) autoStf(image, preset)
			expect(image.raw).toEqual(before)
		}
	})

	test('auto stretch returns finite normalized parameters', () => {
		const images: Image[] = [makeSky(), makeSky(16, 16, 3), makeSky(48, 48, 1, 0.7), makeMoon(), makeImage(4, 4, 1, new Float32Array(16)), makeImage(4, 4, 1, new Float32Array(16).fill(1))]

		for (const image of images) {
			for (const preset of PRESETS) {
				const [midtone, shadow, highlight] = autoStf(image, preset)

				for (const value of [midtone, shadow, highlight]) {
					expect(Number.isFinite(value)).toBe(true)
					expect(value).toBeGreaterThanOrEqual(0)
					expect(value).toBeLessThanOrEqual(1)
				}

				expect(shadow).toBeLessThanOrEqual(highlight)
			}
		}
	})

	test('RGB linked profiles use one shared curve and channel selection changes the sample', () => {
		const raw = new Float32Array(16 * 16 * 3)
		for (let i = 0; i < 256; i++) {
			raw[i * 3] = 0.2 + 0.001 * i
			raw[i * 3 + 1] = 0.4 + 0.0005 * i
			raw[i * 3 + 2] = 0.1 + 0.002 * (i % 64)
		}
		const image = makeImage(16, 16, 3, raw)
		const gray = makeImage(
			16,
			16,
			1,
			new Float32Array(256).map((_, i) => raw[i * 3] * 0.2125 + raw[i * 3 + 1] * 0.7154 + raw[i * 3 + 2] * 0.0721),
		)

		for (const preset of ['medium', 'moon'] as const) {
			const linked = autoStf(image, preset)
			const expected = autoStf(gray, preset)

			for (let i = 0; i < 3; i++) expect(linked[i]).toBeCloseTo(expected[i], 4)

			const red = autoStf(image, preset, { channel: 'RED' })
			const green = autoStf(image, preset, { channel: 'GREEN' })
			expect(red).not.toEqual(green)
			expect(red).toEqual(
				autoStf(
					makeImage(
						16,
						16,
						1,
						new Float32Array(256).map((_, i) => raw[i * 3]),
					),
					preset,
				),
			)
		}
	})

	test('per pixel rejection mask applies to RGB pixels', () => {
		const image = makeSky(16, 16, 3)
		const mask = new Uint8Array(256)
		for (let i = 0; i < 256; i += 3) mask[i] = 1
		const masked = autoStf(image, 'planet', { sigmaClip: mask })

		const filtered = new Float32Array(256 * 3)
		let n = 0
		for (let i = 0; i < 256; i++) {
			if (mask[i] !== 0) continue
			filtered.set(image.raw.subarray(i * 3, i * 3 + 3), n * 3)
			n++
		}

		expect(masked).toEqual(autoStf(makeImage(n, 1, 3, filtered.subarray(0, n * 3)), 'planet'))
	})

	test('auto stretch reuses a caller-owned bin buffer', () => {
		const bits = new Int32Array(4096)
		const image = makeMoon()

		expect(autoStf(image, 'moon', { bits })).toEqual(autoStf(image, 'moon', { bits: 12 }))
		expect(bits.some((count) => count !== 0)).toBe(true)
		expect(autoStf(image, 'high', { bits })).toEqual(autoStf(image, 'high', { bits: 12 }))
	})
})
