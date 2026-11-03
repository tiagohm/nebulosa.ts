import { describe, expect, test } from 'bun:test'
import type { StackingCombinationMethod } from '../../../src/imaging/processing/stacker'
import { accumulateSamples, combineSamples, combineStrip, coverageBounds, coverageThreshold, createCombinationScratch, DEFAULT_COMBINATION_PARAMETERS, finalizeOnlineSamples, isOnlineCombinationMethod, resolveCombinationParameters } from '../../../src/imaging/processing/stacking.combination'
import { mulberry32 } from '../../../src/math/numerical/random'

const SAMPLE_METHODS = ['median', 'sigma-clip', 'min-max-average', 'winsorized-mean', 'percentile-clip-average', 'average', 'weighted-average', 'sum'] as const satisfies readonly StackingCombinationMethod[]

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

	test('rejection parameters are clamped to their domain', () => {
		const parameters = resolveCombinationParameters({ sigmaClip: { sigmaLower: -1, maxIterations: 0.5 }, minMaxRejection: { low: -2, high: 1.7 }, winsorization: { lower: -0.5, upper: 2 } })
		expect(parameters.sigmaClip.sigmaLower).toBe(0)
		expect(parameters.sigmaClip.maxIterations).toBe(1)
		expect(parameters.minMaxRejection).toEqual({ low: 0, high: 1 })
		expect(parameters.winsorization).toEqual({ lower: 0, upper: 1 })
		expect(combineSamples('median', Float64Array.of(3, 1, 2), new Float64Array(3), 3, parameters)).toBe(2)
	})
})
