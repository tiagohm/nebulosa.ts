import { expect, test } from 'bun:test'
import { analyzeImageStatistics, createImageStatisticsScan, IMAGE_STATISTICS_BINS, type ImagePlaneStatistics } from '../../../src/imaging/analysis/statistics'
import type { CfaPattern, Image } from '../../../src/imaging/model/types'
import { Bitpix } from '../../../src/io/formats/fits/fits'

function image(width: number, height: number, values: ArrayLike<number>, channels = 1, bitpix: Bitpix = Bitpix.DOUBLE, raw: Float32Array | Float64Array = new Float64Array(values.length)): Image {
	raw.set(Array.from(values))
	return { header: {}, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * raw.BYTES_PER_ELEMENT, pixelSizeInBytes: raw.BYTES_PER_ELEMENT, bitpix, bayer: undefined } }
}

function random(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0
		return state / 0x100000000
	}
}

function gaussian(next: () => number) {
	return () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
}

function reference(values: readonly number[]) {
	const sorted = values.toSorted((a, b) => a - b)
	const n = sorted.length
	const percentile = (p: number, list = sorted) => {
		const rank = p * (n - 1)
		const lower = Math.floor(rank)
		const upper = Math.ceil(rank)
		return list[lower] + (list[upper] - list[lower]) * (rank - lower)
	}
	const mean = values.reduce((a, b) => a + b, 0) / n
	const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n
	const median = percentile(0.5)
	const deviations = values.map((v) => Math.abs(v - median)).toSorted((a, b) => a - b)
	return { mean, std: Math.sqrt(variance), median, mad: percentile(0.5, deviations), p01: percentile(0.01), p99: percentile(0.99), min: sorted[0], max: sorted[n - 1] }
}

function histogramTotal(plane: ImagePlaneStatistics, domain: 'robust' | 'full') {
	const histogram = plane.histograms![domain]
	return histogram.counts.reduce((a, b) => a + b, 0) + histogram.belowDomain + histogram.aboveDomain
}

test('a constant image has zero dispersion and one occupied bin', () => {
	const [plane] = analyzeImageStatistics(image(8, 8, new Array(64).fill(0.25))).planes
	expect(plane.plane).toBe('mono')
	expect(plane.finiteCount).toBe(64)
	expect(plane.mean).toBeCloseTo(0.25, 14)
	expect(plane.standardDeviation).toBe(0)
	expect(plane.median).toBe(0.25)
	expect(plane.mad).toBe(0)
	expect(plane.quantileMethod).toBe('exact')
	expect(plane.histograms!.full.min).toBe(0.25)
	expect(plane.histograms!.full.max).toBe(0.25)
	expect(plane.histograms!.full.counts[0]).toBe(64)
	expect(histogramTotal(plane, 'robust')).toBe(64)
})

test('moments and quantiles of Gaussian noise match an independent reference', () => {
	const next = gaussian(random(7))
	const values = Array.from({ length: 64 * 48 }, () => 0.3 + 0.02 * next())
	const [plane] = analyzeImageStatistics(image(64, 48, values)).planes
	const expected = reference(values)
	expect(plane.min).toBe(expected.min)
	expect(plane.max).toBe(expected.max)
	expect(plane.mean).toBeCloseTo(expected.mean, 13)
	expect(plane.standardDeviation).toBeCloseTo(expected.std, 13)
	expect(plane.median).toBeCloseTo(expected.median, 14)
	expect(plane.mad).toBeCloseTo(expected.mad, 14)
	expect(plane.robustSigma).toBeCloseTo(expected.mad * 1.482602218505602, 14)
	expect(plane.p01).toBeCloseTo(expected.p01, 14)
	expect(plane.p99).toBeCloseTo(expected.p99, 14)
	expect(plane.quantileMethod).toBe('exact')
	expect(histogramTotal(plane, 'full')).toBe(values.length)
	expect(histogramTotal(plane, 'robust')).toBe(values.length)
	expect(plane.histograms!.robust.belowDomain).toBeGreaterThan(0)
	expect(plane.histograms!.full.belowDomain).toBe(0)
	expect(plane.histograms!.full.counts.length).toBe(IMAGE_STATISTICS_BINS)
})

test('unscaled 16-bit codes give exact order statistics without a sample', () => {
	const next = random(3)
	const codes = Array.from({ length: 300 * 300 }, () => Math.floor(next() * 1000) + 100)
	const values = codes.map((code) => code / 65535)
	const [plane] = analyzeImageStatistics(image(300, 300, values, 1, Bitpix.SHORT, new Float32Array(values.length))).planes
	const expected = reference(codes)
	expect(plane.quantileMethod).toBe('exact')
	expect(plane.quantileSamples).toBe(codes.length)
	expect(plane.median! * 65535).toBeCloseTo(expected.median, 6)
	expect(plane.mad! * 65535).toBeCloseTo(expected.mad, 6)
	expect(plane.p01! * 65535).toBeCloseTo(expected.p01, 6)
	expect(plane.p99! * 65535).toBeCloseTo(expected.p99, 6)
	expect(histogramTotal(plane, 'full')).toBe(codes.length)
})

test('non-integral 16-bit samples fall back to binned order statistics', () => {
	const values = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 65535)
	const [plane] = analyzeImageStatistics(image(10, 10, values, 1, Bitpix.SHORT)).planes
	expect(plane.quantileMethod).toBe('binned')
	expect(histogramTotal(plane, 'full')).toBe(100)
})

test('large floating-point populations are sampled deterministically', () => {
	const next = random(11)
	const values = Array.from({ length: 300 * 300 }, () => next())
	const first = analyzeImageStatistics(image(300, 300, values)).planes[0]
	const second = analyzeImageStatistics(image(300, 300, values)).planes[0]
	expect(first.quantileMethod).toBe('sampled')
	expect(first.quantileSamples).toBe(65536)
	expect(first.median).toBe(second.median)
	expect(first.median!).toBeCloseTo(0.5, 2)
	expect(first.p99!).toBeCloseTo(0.99, 2)
	expect(histogramTotal(first, 'full')).toBe(values.length)
})

test('non-finite samples are counted apart and never enter reductions', () => {
	const values = [0.1, Number.NaN, 0.3, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.2]
	const [plane] = analyzeImageStatistics(image(3, 2, values)).planes
	expect(plane.finiteCount).toBe(3)
	expect(plane.nonFiniteCount).toBe(3)
	expect(plane.mean).toBeCloseTo(0.2, 14)
	expect(plane.median).toBeCloseTo(0.2, 14)

	const [empty] = analyzeImageStatistics(image(2, 1, [Number.NaN, Number.NaN])).planes
	expect(empty.finiteCount).toBe(0)
	expect(empty.nonFiniteCount).toBe(2)
	expect(empty.mean).toBeUndefined()
	expect(empty.median).toBeUndefined()
	expect(empty.histograms).toBeUndefined()
})

test('negative and out-of-range processed samples are kept', () => {
	const [plane] = analyzeImageStatistics(image(2, 2, [-0.5, 0.25, 1.5, 0.75])).planes
	expect(plane.min).toBe(-0.5)
	expect(plane.max).toBe(1.5)
	expect(plane.mean).toBeCloseTo(0.5, 14)
})

test('an area restricts the population', () => {
	const values = Array.from({ length: 16 }, (_, i) => i)
	const [plane] = analyzeImageStatistics(image(4, 4, values), { area: { left: 1, top: 1, right: 3, bottom: 3 } }).planes
	expect(plane.finiteCount).toBe(4)
	expect(plane.min).toBe(5)
	expect(plane.max).toBe(10)
	expect(plane.mean).toBeCloseTo(7.5, 14)
	expect(() => analyzeImageStatistics(image(4, 4, values), { area: { left: 2, top: 0, right: 2, bottom: 4 } })).toThrow(RangeError)
})

test('RGB channels are separated and luminance uses BT.709 weights', () => {
	const values: number[] = []
	for (let i = 0; i < 4; i++) values.push(0.1, 0.2, 0.3)
	const { planes } = analyzeImageStatistics(image(2, 2, values, 3))
	expect(planes.map((p) => p.plane)).toEqual(['red', 'green', 'blue', 'luminance'])
	expect(planes[0].mean).toBeCloseTo(0.1, 14)
	expect(planes[1].mean).toBeCloseTo(0.2, 14)
	expect(planes[2].mean).toBeCloseTo(0.3, 14)
	expect(planes[3].mean).toBeCloseTo(0.2125 * 0.1 + 0.7154 * 0.2 + 0.0721 * 0.3, 14)
	expect(planes[3].background).toBeUndefined()
	expect(analyzeImageStatistics(image(2, 2, values, 3), { luminance: false }).planes).toHaveLength(3)
})

test('CFA phases follow absolute coordinates and keep both greens apart', () => {
	const levels = { R: 0.4, G: 0.2, B: 0.1 } as const
	const patterns: CfaPattern[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']

	for (const pattern of patterns) {
		const width = 7
		const height = 5
		const values = new Array<number>(width * height)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const slot = ((y & 1) << 1) | (x & 1)
				const color = pattern[slot] as keyof typeof levels
				const second = color === 'G' && pattern.indexOf('G') !== slot
				values[y * width + x] = levels[color] + (second ? 0.01 : 0)
			}
		}

		for (const area of [undefined, { left: 1, top: 1, right: 6, bottom: 4 }]) {
			const { planes } = analyzeImageStatistics(image(width, height, values), { cfa: pattern, area })
			expect(planes.map((p) => p.plane)).toEqual(['red', 'green1', 'green2', 'blue'])
			expect(planes[0].mean).toBeCloseTo(0.4, 14)
			expect(planes[1].mean).toBeCloseTo(0.2, 14)
			expect(planes[2].mean).toBeCloseTo(0.21, 14)
			expect(planes[3].mean).toBeCloseTo(0.1, 14)
			const total = planes.reduce((a, p) => a + p.finiteCount, 0)
			expect(total).toBe(area === undefined ? width * height : 15)
		}
	}
})

test('a mosaic without a trusted pattern is one mono plane', () => {
	const { planes } = analyzeImageStatistics(image(4, 4, new Array(16).fill(0.5)))
	expect(planes.map((p) => p.plane)).toEqual(['mono'])
})

test('numeric limits are counted only when declared known', () => {
	const values = [0, 0, 0.5, 1, 1, 1].map((v) => Math.round(v * 255) / 255)
	expect(analyzeImageStatistics(image(3, 2, values, 1, Bitpix.BYTE)).planes[0].numericLimits).toBeUndefined()
	expect(analyzeImageStatistics(image(3, 2, values, 1, Bitpix.BYTE), { numericLimits: true }).planes[0].numericLimits).toEqual({ lowCount: 2, highCount: 3 })
})

test('chunking does not change the result', () => {
	const next = gaussian(random(5))
	const values = Array.from({ length: 50 * 40 * 3 }, () => 0.5 + 0.1 * next())
	const whole = analyzeImageStatistics(image(50, 40, values, 3))
	const scan = createImageStatisticsScan(image(50, 40, values, 3))
	let chunks = 0
	while (!scan.consumeRows(3)) chunks++
	expect(chunks).toBeGreaterThan(10)
	expect(scan.done).toBeTrue()
	expect(scan.finish()).toEqual(whole)
})
