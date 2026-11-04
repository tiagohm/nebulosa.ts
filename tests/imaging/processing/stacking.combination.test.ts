import { describe, expect, test } from 'bun:test'
import type { StackingCombinationMethod } from '../../../src/imaging/processing/stacker'
import { accumulateSamples, combineSamples, combineStrip, coverageBounds, coverageThreshold, createCombinationScratch, DEFAULT_COMBINATION_PARAMETERS, finalizeOnlineSamples, isOnlineCombinationMethod, resolveCombinationParameters } from '../../../src/imaging/processing/stacking.combination'
import { mulberry32, normal } from '../../../src/math/numerical/random'

const SAMPLE_METHODS = ['median', 'sigma-clip', 'weighted-sigma-clip', 'min-max-average', 'winsorized-mean', 'percentile-clip-average', 'average', 'weighted-average', 'sum'] as const satisfies readonly StackingCombinationMethod[]

function randomFrames(count: number, pixels: number, channels: number, seed: number) {
	const random = mulberry32(seed)
	const frames = []

	for (let i = 0; i < count; i++) {
		const raw = new Float32Array(pixels * channels)
		const valid = new Uint8Array(pixels)
		for (let p = 0; p < pixels; p++) valid[p] = random() < 0.9 ? 1 : 0
		for (let s = 0; s < raw.length; s++) raw[s] = 0.1 + 0.01 * random() + (random() < 0.02 ? 0.5 : 0)
		frames.push({ raw, valid, weight: 0.5 + random() })
	}

	return frames
}

function coverageOf(frames: readonly { readonly valid: Uint8Array }[], pixels: number) {
	const coverage = new Uint32Array(pixels)
	for (const frame of frames) for (let p = 0; p < pixels; p++) coverage[p] += frame.valid[p]
	return coverage
}

describe('stacking combination', () => {
	test('strips of any height reproduce the whole-frame combination exactly', () => {
		const width = 17
		const height = 13
		const channels = 3
		const pixels = width * height
		const frames = randomFrames(9, pixels, channels, 3)
		const coverage = coverageOf(frames, pixels)
		const parameters = resolveCombinationParameters({})

		for (const method of SAMPLE_METHODS) {
			const whole = new Float32Array(pixels * channels)
			combineStrip(frames, pixels, channels, coverage, 2, method, parameters, whole, createCombinationScratch(frames.length))

			for (const rows of [1, 4, 13]) {
				const strips = new Float32Array(pixels * channels)
				const scratch = createCombinationScratch(frames.length)

				for (let top = 0; top < height; top += rows) {
					const count = Math.min(rows, height - top) * width
					const first = top * width
					const views = frames.map((frame) => ({ raw: frame.raw.subarray(first * channels), valid: frame.valid.subarray(first), weight: frame.weight }))
					combineStrip(views, count, channels, coverage.subarray(first), 2, method, parameters, strips.subarray(first * channels), scratch)
				}

				expect(strips).toEqual(whole)
			}
		}
	})

	test('online accumulation equals the sample-based mean of the valid samples', () => {
		const pixels = 40
		const frames = randomFrames(7, pixels, 1, 9)
		const coverage = coverageOf(frames, pixels)
		const parameters = DEFAULT_COMBINATION_PARAMETERS

		for (const method of ['sum', 'average', 'weighted-average'] as const) {
			expect(isOnlineCombinationMethod(method)).toBeTrue()
			const sum = new Float64Array(pixels)
			const weightSum = new Float64Array(pixels)
			const counted = new Uint32Array(pixels)
			for (const frame of frames) accumulateSamples(1, frame.raw, frame.valid, sum, weightSum, counted, method, frame.weight)
			expect(counted).toEqual(coverage)

			const online = new Float64Array(pixels).fill(Number.NaN)
			finalizeOnlineSamples(sum, weightSum, counted, 1, 1, method, online)
			const sampled = new Float64Array(pixels).fill(Number.NaN)
			combineStrip(frames, pixels, 1, coverage, 1, method, parameters, sampled, createCombinationScratch(frames.length))

			for (let p = 0; p < pixels; p++) {
				if (coverage[p] === 0) {
					expect(online[p]).toBeNaN()
					expect(sampled[p]).toBeNaN()
				} else expect(online[p]).toBeCloseTo(sampled[p], 12)
			}
		}

		expect(isOnlineCombinationMethod('median')).toBeFalse()
	})

	test('pixels below the coverage threshold keep the caller no-data value', () => {
		const frames = randomFrames(4, 6, 1, 1)
		const coverage = Uint32Array.of(4, 3, 2, 1, 0, 4)
		const out = new Float32Array(6).fill(Number.NaN)
		combineStrip(frames, 6, 1, coverage, 3, 'median', DEFAULT_COMBINATION_PARAMETERS, out, createCombinationScratch(4))
		expect(Number.isNaN(out[2]) && Number.isNaN(out[3]) && Number.isNaN(out[4])).toBeTrue()
	})

	test('coverage threshold and bounds follow the crop policy', () => {
		expect(coverageThreshold(0, 'union', 0.5)).toBe(0)
		expect(coverageThreshold(10, 'intersection', 0)).toBe(10)
		expect(coverageThreshold(10, 'union', 0)).toBe(1)
		expect(coverageThreshold(10, 'union', 0.25)).toBe(3)

		const coverage = new Uint32Array(5 * 4)
		coverage[1 * 5 + 1] = 3
		coverage[2 * 5 + 3] = 3
		expect(coverageBounds(5, 4, coverage, 3)).toEqual({ left: 1, top: 1, right: 3, bottom: 2, width: 3, height: 2 })
		expect(coverageBounds(5, 4, coverage, 4)).toBeUndefined()
	})

	test('weighted sigma clipping rejects outliers and weights the retained samples', () => {
		const parameters = resolveCombinationParameters({})
		const values = Float64Array.of(1, 1.02, 0.98, 1.01, 0.99, 1.03, 0.97, 5)
		const weights = Float64Array.of(1, 4, 1, 1, 1, 1, 1, 100)
		const scratch = createCombinationScratch(8)
		scratch.values.set(values)
		scratch.weights.set(weights)
		const result = combineSamples('weighted-sigma-clip', scratch.values, scratch.weights, 8, parameters, scratch)
		// The heavily weighted outlier is rejected and the inliers average with their own weights.
		expect(result).toBeCloseTo((1 + 4 * 1.02 + 0.98 + 1.01 + 0.99 + 1.03 + 0.97) / 10, 12)
		// Values stay paired with their weights after the call.
		expect(scratch.values).toEqual(values)
	})

	test('weighted sigma clipping with equal weights matches sigma clipping', () => {
		const random = mulberry32(17)
		const parameters = resolveCombinationParameters({ sigmaClip: { sigmaLower: 2, sigmaUpper: 2, maxIterations: 5 } })

		for (let trial = 0; trial < 200; trial++) {
			const count = 1 + Math.floor(random() * 12)
			const values = new Float64Array(count)
			for (let i = 0; i < count; i++) values[i] = random() + (random() < 0.15 ? 3 * random() : 0)
			const weights = new Float64Array(count).fill(2)
			const plain = combineSamples('sigma-clip', values.slice(), weights, count, parameters)
			const weighted = combineSamples('weighted-sigma-clip', values.slice(), weights, count, parameters)
			expect(weighted).toBeCloseTo(plain, 12)
		}
	})

	test('weighted sigma clipping keeps every sample of tiny stacks and falls back to the center', () => {
		const parameters = resolveCombinationParameters({})
		expect(combineSamples('weighted-sigma-clip', Float64Array.of(1, 10), Float64Array.of(3, 1), 2, parameters)).toBeCloseTo(13 / 4, 12)
		expect(combineSamples('weighted-sigma-clip', Float64Array.of(2, 2, 2, 9), Float64Array.of(1, 1, 1, 1), 4, parameters)).toBe(2)
		expect(isOnlineCombinationMethod('weighted-sigma-clip')).toBeFalse()
	})

	test('averaging N independent frames scales the noise by 1/sqrt(N), weighting included', () => {
		const pixels = 20000
		const sigma = 0.01
		const random = normal(mulberry32(23), 0, sigma)

		for (const count of [4, 16]) {
			const frames = []
			for (let i = 0; i < count; i++) frames.push({ raw: Float64Array.from({ length: pixels }, () => 0.2 + random()), valid: new Uint8Array(pixels).fill(1), weight: i % 2 ? 1 : 3 })
			const coverage = coverageOf(frames, pixels)

			for (const method of ['average', 'weighted-average'] as const) {
				const out = new Float64Array(pixels)
				combineStrip(frames, pixels, 1, coverage, 1, method, DEFAULT_COMBINATION_PARAMETERS, out, createCombinationScratch(count))
				let sumSq = 0
				for (let p = 0; p < pixels; p++) sumSq += (out[p] - 0.2) ** 2
				const measured = Math.sqrt(sumSq / pixels)
				// Weights 3 and 1 alternating: the variance of the weighted mean is sigma^2 * sum(w^2) / sum(w)^2.
				const expected = method === 'average' ? sigma / Math.sqrt(count) : sigma * Math.sqrt(((count / 2) * 10) / (2 * count) ** 2)
				// 20000 samples estimate a standard deviation within about 1 % (1 sigma); allow 4 %.
				expect(Math.abs(measured / expected - 1)).toBeLessThan(0.04)
			}
		}
	})

	test('rejection parameters are clamped to their domain', () => {
		const parameters = resolveCombinationParameters({ sigmaClip: { sigmaLower: -1, maxIterations: 0.5 }, minMaxRejection: { low: -2, high: 1.7 }, winsorization: { lower: -0.5, upper: 2 } })
		expect(parameters.sigmaClip.sigmaLower).toBe(0)
		expect(parameters.sigmaClip.maxIterations).toBe(1)
		expect(parameters.minMaxRejection).toEqual({ low: 0, high: 1 })
		expect(parameters.winsorization).toEqual({ lower: 0, upper: 1 })
		expect(combineSamples('median', Float64Array.of(3, 1, 2), new Float64Array(3), 3, parameters)).toBe(2)
	})
})
