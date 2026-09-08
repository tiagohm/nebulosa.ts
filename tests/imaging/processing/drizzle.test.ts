import { describe, expect, test } from 'bun:test'
import type { AffineTransform } from '../../../src/astrometry/matching/star.matching'
import { TAU } from '../../../src/core/constants'
import { cfaChannelAt, type CfaPattern, type Image } from '../../../src/imaging/model/types'
import { createDrizzleAccumulator, depositDrizzle, drizzleDropArea, drizzleMemoryBytes, drizzleNormalization, drizzleOverlap, prepareDrizzleFootprint } from '../../../src/imaging/processing/drizzle'
import { Bitpix } from '../../../src/io/formats/fits/fits'

const IDENTITY: AffineTransform = { m00: 1, m01: 0, m10: 0, m11: 1, tx: 0, ty: 0 }
const PATTERNS: CfaPattern[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']

function image(width: number, height: number, channels = 1, pixel: (x: number, y: number, c: number) => number = () => 0.4, pattern?: CfaPattern): Image {
	const raw = new Float64Array(width * height * channels)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[(y * width + x) * channels + c] = pixel(x, y, c)
	return { raw, header: {}, metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, pixelSizeInBytes: 8, strideInBytes: width * channels * 8, bitpix: Bitpix.DOUBLE, bayer: pattern } }
}

function state(width = 10, height = 10, channels = 1, cfa = false, scale = 1, counts = true) {
	return createDrizzleAccumulator(width, height, channels, cfa, scale, counts, counts, 8, 2 ** 30)
}

describe('Drizzle areas', () => {
	test('analytic rectangle fractions, edge contact, and a diamond triangle', () => {
		const polygon = new Float64Array(16)
		const clipped = new Float64Array(16)
		const square = prepareDrizzleFootprint(IDENTITY, 1, 1, 1, 1, 1)!
		expect(drizzleDropArea(square, 0.25, -0.25, polygon, clipped)).toBeCloseTo(0.75 ** 2, 14)
		expect(drizzleDropArea(square, 1, 0, polygon, clipped)).toBe(0)
		const diamond = prepareDrizzleFootprint({ ...IDENTITY, m00: 1, m01: -1, m10: 1, m11: 1 }, 1, 1, 1, 1, 1)!
		expect(drizzleDropArea(diamond, 0, 0, polygon, clipped)).toBeCloseTo(1, 14)
		expect(drizzleDropArea(diamond, 1, 0, polygon, clipped)).toBeCloseTo(0.25, 14)
	})

	test.each([IDENTITY, { ...IDENTITY, m00: -1 }, { ...IDENTITY, m00: 0, m01: 1.2, m10: -0.8, m11: 0 }, { ...IDENTITY, m00: 1.1, m01: 0.37, m10: 0.13, m11: 0.91 }, { ...IDENTITY, m00: Math.cos(0.3), m01: -Math.sin(0.3), m10: Math.sin(0.3), m11: Math.cos(0.3) }])(
		'partitions full drop area for %j, either winding and small footprints',
		(matrix) => {
			for (const scale of [1, 2, 2.3])
				for (const pixfrac of [1, 0.5, 0.02]) {
					const prepared = prepareDrizzleFootprint(matrix, scale, scale + 0.1, pixfrac, 10, 10)!
					const polygon = new Float64Array(16)
					const clipped = new Float64Array(16)
					let total = 0
					for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) total += drizzleDropArea(prepared, 0.371 - x, -0.219 - y, polygon, clipped) * prepared.inverseArea
					expect(total).toBeCloseTo(1, 10)
				}
		},
	)

	test('exact axis path agrees with polygon clipping without rounding small shears to zero', () => {
		const prepared = prepareDrizzleFootprint({ ...IDENTITY, m00: -1.2 }, 2, 1.7, 0.5, 10, 10)!
		const general = { ...prepared, axisAligned: false }
		const polygon = new Float64Array(16)
		const clipped = new Float64Array(16)
		for (let i = 0; i < 100; i++) {
			const x = ((i * 0.173) % 3) - 1.5
			const y = ((i * 0.231) % 3) - 1.5
			expect(drizzleDropArea(prepared, x, y, polygon, clipped)).toBeCloseTo(drizzleDropArea(general, x, y, polygon, clipped), 13)
		}
		expect(prepareDrizzleFootprint({ ...IDENTITY, m01: 1e-14 }, 1, 1, 1, 100000, 1)!.axisAligned).toBeFalse()
	})

	test.each([
		{ ...IDENTITY, m01: 4e-17, m10: -4e-17, tx: 0.37, ty: -0.21 },
		{ ...IDENTITY, m00: -1, m01: 4e-17, m10: -4e-17, tx: 30.37, ty: -0.21 },
		{ ...IDENTITY, m00: 4e-17, m01: 1, m10: 1, m11: -4e-17, tx: 0.37, ty: -0.21 },
	])('rounded rectangular corners use exact areas while retaining the full center matrix: %j', (matrix) => {
		// Translation fits can leave coefficients of this magnitude while Float64 corner sums
		// are exactly rectangular. Retain those coefficients for center positions, without epsilon snapping.
		const footprint = prepareDrizzleFootprint(matrix, 2, 2, 1, 32, 24)!
		expect(footprint.axisAligned).toBeTrue()
		expect(footprint.matrix.m00).toBe(2 * matrix.m00)
		expect(footprint.matrix.m01).toBe(2 * matrix.m01)
		expect(footprint.matrix.m10).toBe(2 * matrix.m10)
		expect(footprint.matrix.m11).toBe(2 * matrix.m11)
		const fast = state(32, 24, 3, false, 2)
		const general = state(32, 24, 3, false, 2)
		const source = image(32, 24, 3, (x, y, c) => 0.1 + x * 0.01 + y * 0.003 + c * 0.1)
		depositDrizzle(fast, source, footprint, [1, 1, 1], [0, 0, 0], 1, 1)
		depositDrizzle(general, source, { ...footprint, axisAligned: false }, [1, 1, 1], [0, 0, 0], 1, 1)
		for (let i = 0; i < fast.sum.length; i++) expect(fast.sum[i]).toBeCloseTo(general.sum[i], 14)
		for (let i = 0; i < fast.weights.length; i++) expect(fast.weights[i]).toBeCloseTo(general.weights[i], 14)
		expect(fast.coverage).toEqual(general.coverage)
	})

	test('large coordinates retain small footprints and wide scans conserve samples', () => {
		const s = state(100003, 1)
		const input = image(100003, 1)
		const f = prepareDrizzleFootprint({ ...IDENTITY, m01: 0.1 }, 1, 1, 0.02, 100003, 1)!
		depositDrizzle(s, input, f, [1], [0], 1, 1)
		let total = 0
		for (let p = 0; p < s.sum.length; p++) {
			total += s.sum[p]
			expect(s.sum[p] / s.weights[p]).toBeCloseTo(0.4, 12)
		}
		expect(total).toBeCloseTo(100003 * 0.4, 6)
		expect(prepareDrizzleFootprint(IDENTITY, 1, 1, 1e-20, 100003, 1)).toBeUndefined()
	})

	test('full sensor overlap uses transformed edges, independent of output scale', () => {
		const s = state()
		expect(drizzleOverlap(IDENTITY, 10, 10, 10, 10, s.polygon, s.clipped)).toBe(1)
		expect(drizzleOverlap({ ...IDENTITY, tx: 2.5 }, 10, 10, 10, 10, s.polygon, s.clipped)).toBeCloseTo(0.75, 14)
		expect(drizzleOverlap({ ...IDENTITY, tx: 10 }, 10, 10, 10, 10, s.polygon, s.clipped)).toBe(0)
		expect(drizzleOverlap({ ...IDENTITY, m00: -1, tx: 9 }, 10, 10, 10, 10, s.polygon, s.clipped)).toBe(1)
	})

	test('clipping through existing boundary vertices stays within the convex scratch capacity', () => {
		const polygon = new Float64Array(16)
		const clipped = new Float64Array(16)
		for (let i = 0; i < 300; i++) {
			const angle = i * 0.137
			const m = { ...IDENTITY, m00: Math.cos(angle), m01: -Math.sin(angle) + (i % 3) * 0.1, m10: Math.sin(angle), m11: Math.cos(angle) }
			const f = prepareDrizzleFootprint(m, 1 + (i % 4), 1.3, 0.7, 10, 10)!
			// Put an existing corner exactly on a cell corner, exercising endpoint intersections.
			const cx = 0.5 - f.corners[0]
			const cy = 0.5 - f.corners[1]
			let sum = 0
			for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) sum += drizzleDropArea(f, cx - x, cy - y, polygon, clipped) * f.inverseArea
			expect(sum).toBeCloseTo(1, 10)
		}
	})
})

describe('Drizzle accumulation', () => {
	test('scale two distributes quarters, preserving sum and mean separately', () => {
		const s = state(1, 1, 1, false, 2)
		depositDrizzle(s, image(1, 1), prepareDrizzleFootprint(IDENTITY, 2, 2, 1, 1, 1)!, [1], [0], 1, 1)
		expect(Array.from(s.sum)).toEqual([0.1, 0.1, 0.1, 0.1])
		expect(Array.from(s.weights)).toEqual([0.25, 0.25, 0.25, 0.25])
		expect(Array.from(s.coverage!)).toEqual([1, 1, 1, 1])
	})

	test('clipped drops with external centers lose only external area', () => {
		const s = state(1, 1)
		depositDrizzle(
			s,
			image(1, 1, 1, () => 1),
			prepareDrizzleFootprint({ ...IDENTITY, tx: -0.75 }, 1, 1, 1, 1, 1)!,
			[1],
			[0],
			1,
			1,
		)
		expect(s.sum[0]).toBe(0.25)
		expect(s.coverage![0]).toBe(1)
	})

	test('multiple input drops count once per frame and rejected overflow leaves buffers unchanged', () => {
		const s = state(1, 1)
		const f = prepareDrizzleFootprint({ ...IDENTITY, m00: 0.25, m11: 0.25, tx: -0.375, ty: -0.375 }, 1, 1, 1, 4, 4)!
		depositDrizzle(s, image(4, 4), f, [1], [0], 1, 0xffffffff)
		expect(s.weights[0]).toBe(16)
		expect(s.coverage![0]).toBe(1)
		const before = s.sum.slice()
		expect(() => depositDrizzle(s, image(4, 4), f, [1], [0], 1, 0x100000000)).toThrow(RangeError)
		expect(s.sum).toEqual(before)
	})

	test('RGB shares denominator and preserves channel intensity with tiny positive weights', () => {
		const s = state(4, 3, 3, false, 1.4, false)
		const input = image(4, 3, 3, (_x, _y, c) => [0.2, 0.5, 0.8][c])
		depositDrizzle(s, input, prepareDrizzleFootprint(IDENTITY, s.scaleX, s.scaleY, 1, 4, 3)!, [2, 1, 0.5], [0.1, 0, -0.1], 1e-100, 1)
		expect(s.scaleX).not.toBe(s.scaleY)
		expect(s.coverage).toBeUndefined()
		expect(s.stamp).toBeUndefined()
		for (let p = 0; p < s.weights.length; p++) for (let c = 0; c < 3; c++) expect(s.sum[p * 3 + c] / s.weights[p]).toBeCloseTo([0.5, 0.5, 0.3][c], 12)
	})

	test.each(PATTERNS)('CFA %s routes every photosite without channel leakage', (pattern) => {
		const s = state(5, 7, 3, true)
		const input = image(5, 7, 1, (x, y) => [0.2, 0.5, 0.8][cfaChannelAt(pattern, x, y)], pattern)
		depositDrizzle(s, input, prepareDrizzleFootprint(IDENTITY, 1, 1, 1, 5, 7)!, [1, 1, 1], [0, 0, 0], 1, 1)
		for (let y = 0; y < 7; y++)
			for (let x = 0; x < 5; x++)
				for (let c = 0; c < 3; c++) {
					const expected = cfaChannelAt(pattern, x, y) === c ? [0.2, 0.5, 0.8][c] : 0
					expect(s.sum[(y * 5 + x) * 3 + c]).toBe(expected)
				}
	})

	test('scale three small drops create holes; scale two small drops still touch four children', () => {
		for (const scale of [2, 3]) {
			const s = state(1, 1, 1, false, scale)
			depositDrizzle(s, image(1, 1), prepareDrizzleFootprint(IDENTITY, scale, scale, 0.2, 1, 1)!, [1], [0], 1, 1)
			expect(s.weights.filter((v) => v > 0).length).toBe(scale === 2 ? 4 : 1)
		}
	})

	test('budget includes result and optional count/map buffers', () => {
		const scratch = drizzleMemoryBytes(0, 1, 1, true, true, 8)
		expect(drizzleMemoryBytes(100, 1, 1, true, true, 8) - scratch).toBe(4500)
		expect(drizzleMemoryBytes(100, 3, 1, true, true, 8) - scratch).toBe(7700)
		expect(drizzleMemoryBytes(100, 3, 3, true, true, 8) - scratch).toBe(10900)
		expect(drizzleMemoryBytes(100, 1, 1, false, false, 4) - scratch).toBe(2100)
		expect(() => createDrizzleAccumulator(6000, 4000, 3, true, 2, true, true, 8, 2 ** 30)).toThrow(RangeError)
		expect(() => createDrizzleAccumulator(2, 2, 1, false, 1e100, false, false, 4, Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
	})
})

describe('Drizzle sparse normalization', () => {
	test.each(['scale', 'background-scale', 'percentile'] as const)('%s recovers per-channel gain and optional offset from common sky only', (mode) => {
		const s = state(32, 23, 3)
		const sky = (x: number, y: number, c: number) => 0.1 + c * 0.1 + x * 0.01 + y * 0.003
		const reference = image(32, 23, 3, sky)
		const target = image(19, 23, 3, (x, y, c) => (sky(x + 7, y, c) - (mode === 'scale' ? 0 : 0.07)) / [2, 3, 4][c])
		const result = drizzleNormalization(s, reference, target, { ...IDENTITY, tx: -7 }, mode, 'per-channel')
		for (let c = 0; c < 3; c++) {
			expect(result.scales[c]).toBeCloseTo([2, 3, 4][c], 10)
			expect(result.offsets[c]).toBeCloseTo(mode === 'scale' ? 0 : 0.07, 10)
		}
		expect(s.referenceSamples.length).toBe(0)
		expect(s.currentSamples.length).toBe(0)
	})

	test.each(PATTERNS)('CFA %s preserves photometry within photosite spacing with a different target pattern', (pattern) => {
		const s = state(45, 33, 3, true)
		const other = PATTERNS[(PATTERNS.indexOf(pattern) + 1) % PATTERNS.length]
		const sky = (x: number, y: number, c: number) => 0.1 + c * 0.1 + x * 0.01 + y * 0.003
		const reference = image(45, 33, 1, (x, y) => sky(x, y, cfaChannelAt(pattern, x, y)), pattern)
		const target = image(45, 33, 1, (x, y) => (sky(x, y, cfaChannelAt(other, x, y)) - 0.04) / 2, other)
		const result = drizzleNormalization(s, reference, target, IDENTITY, 'background-scale', 'per-channel')
		for (let c = 0; c < 3; c++) {
			// Different CFA origins cannot supply the same original color sample at the same sky
			// position. Bound the fitted intensity error by this ramp's variation across one CFA cell,
			// rather than requiring the exact linear interpolation that attenuated the noise.
			for (const [x, y] of [
				[0, 0],
				[22, 16],
				[44, 32],
			]) {
				const expected = sky(x, y, c)
				expect(Math.abs(((expected - 0.04) / 2) * result.scales[c] + result.offsets[c] - expected)).toBeLessThanOrEqual(2 * (0.01 + 0.003))
			}
		}
	})

	test.each((['background-scale', 'percentile'] as const).flatMap((mode) => ([1, 3, ...PATTERNS] as const).map((variant) => [mode, variant] as const)))('%s preserves raw noise gain for %s across subpixel shifts', (mode, variant) => {
		let seed = 123456789

		function uniform() {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return (seed + 0.5) / 4294967296
		}

		function noise() {
			return 0.01 * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(TAU * uniform())
		}

		const pattern = typeof variant === 'string' ? variant : undefined
		const channels = typeof variant === 'number' ? variant : 1
		const other = pattern === undefined ? undefined : PATTERNS[(PATTERNS.indexOf(pattern) + 1) % PATTERNS.length]
		const reference = image(256, 256, channels, (x, y, c) => 0.2 + (pattern === undefined ? c : cfaChannelAt(pattern, x, y)) * 0.2 + noise(), pattern)
		const target = image(256, 256, channels, (x, y, c) => (0.2 + (other === undefined ? c : cfaChannelAt(other, x, y)) * 0.2 + noise() - 0.03) / 1.7, other)
		const s = state(256, 256, pattern === undefined ? channels : 3, pattern !== undefined)

		for (const shift of [0, 0.5, 1]) {
			for (const colorMode of ['per-channel', 'luminance'] as const) {
				const result = drizzleNormalization(s, reference, target, { ...IDENTITY, tx: shift, ty: shift }, mode, colorMode)
				// Finite Gaussian quantiles have sampling error; interpolation previously inflated
				// the half-pixel gain toward 3.4 instead of the known raw-sample gain of 1.7.
				for (const scale of result.scales) expect(Math.abs(scale / 1.7 - 1)).toBeLessThan(0.08)
			}
		}
	})

	test('none bypasses sampling, collapsed quantiles match background, luminance broadcasts', () => {
		const s = state(4, 4, 3)
		const reference = image(4, 4, 3, () => 0.6)
		const target = image(4, 4, 3, () => 0.2)
		expect(drizzleNormalization(s, reference, target, IDENTITY, 'none', 'per-channel')).toEqual({ scales: [1, 1, 1], offsets: [0, 0, 0] })
		const result = drizzleNormalization(s, reference, target, IDENTITY, 'percentile', 'luminance')
		expect(result.scales).toEqual([1, 1, 1])
		for (const offset of result.offsets) expect(offset).toBeCloseTo(0.4, 12)
		expect(drizzleNormalization(s, reference, target, { ...IDENTITY, tx: 100 }, 'scale', 'per-channel')).toEqual({ scales: [1, 1, 1], offsets: [0, 0, 0] })
	})

	test('thin overlap fallback finds samples missed by stratification, including skinny images', () => {
		for (const [w, h] of [
			[1, 20000],
			[20000, 1],
			[1000, 100],
		]) {
			const s = state(w, h)
			const reference = image(w, h, 1, () => 0.6)
			const target = image(1, 1, 1, () => 0.3)
			const result = drizzleNormalization(s, reference, target, IDENTITY, 'scale', 'per-channel')
			expect(result.scales[0]).toBeCloseTo(2, 12)
		}
	})
})
