import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { LiveStacker, type StackingFrame, type StackingOptions, stackFrames } from '../../../src/imaging/processing/stacker'
import type { DetectedStar } from '../../../src/imaging/stars/detector'
import { Bitpix } from '../../../src/io/formats/fits/fits'

const DEFAULT_STACK_OPTIONS = {
	minAcceptedStars: 3,
	minAcceptedInliers: 3,
	maxAcceptedTransformError: 0.5,
	minOverlapFraction: 0.25,
	normalizationMode: 'none',
	matchStarsConfig: {
		maxStars: 8,
		minStars: 3,
		minInliers: 3,
		allowAffineFallback: false,
		initialMatchRadius: 4,
		finalMatchRadius: 0.5,
		maxResidual: 0.5,
	},
} as const satisfies StackingOptions

// Builds a synthetic floating-point image.
function makeImage(width: number, height: number, channels: number, pixel: number | ((x: number, y: number, channel: number) => number)): Image {
	const raw = new Float32Array(width * height * channels)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const base = (y * width + x) * channels
			for (let channel = 0; channel < channels; channel++) raw[base + channel] = typeof pixel === 'number' ? pixel : pixel(x, y, channel)
		}
	}

	return {
		header: {},
		raw,
		metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
	}
}

// Translates a reference image into the current-image coordinate system for integer shifts.
function translateImage(reference: Image, tx: number, ty: number): Image {
	return makeImage(reference.metadata.width, reference.metadata.height, reference.metadata.channels, (x, y, channel) => {
		const refX = x + tx
		const refY = y + ty
		if (refX < 0 || refY < 0 || refX >= reference.metadata.width || refY >= reference.metadata.height) return 0
		return reference.raw[(refY * reference.metadata.width + refX) * reference.metadata.channels + channel]
	})
}

// Builds stable synthetic star lists with an optional translation applied.
function makeStars(tx: number = 0, ty: number = 0, qualityBoost: number = 1): readonly DetectedStar[] {
	return [
		{ x: 3 + tx, y: 3 + ty, flux: 1800 * qualityBoost, snr: 16 * qualityBoost, hfd: 2.2 },
		{ x: 10 + tx, y: 4 + ty, flux: 2100 * qualityBoost, snr: 18 * qualityBoost, hfd: 2.1 },
		{ x: 5 + tx, y: 9 + ty, flux: 2200 * qualityBoost, snr: 17 * qualityBoost, hfd: 2.3 },
		{ x: 12 + tx, y: 8 + ty, flux: 2600 * qualityBoost, snr: 21 * qualityBoost, hfd: 2 },
		{ x: 7 + tx, y: 12 + ty, flux: 2400 * qualityBoost, snr: 19 * qualityBoost, hfd: 2.4 },
		{ x: 14 + tx, y: 13 + ty, flux: 2800 * qualityBoost, snr: 23 * qualityBoost, hfd: 2.2 },
	] as const
}

// Wraps image and stars into one stacking frame.
function makeFrame(image: Image, stars: readonly DetectedStar[], weight?: number): StackingFrame {
	return { image, stars, weight }
}

// Compares two floating buffers within a tight tolerance.
function expectRawClose(actual: ArrayLike<number>, expected: ArrayLike<number>, epsilon: number = 1e-6) {
	expect(actual.length).toBe(expected.length)
	for (let i = 0; i < actual.length; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(epsilon)
}

describe('stacker live mode', () => {
	test('first accepted frame becomes the live reference and translated mean stack aligns back to reference', () => {
		const reference = makeImage(18, 18, 1, (x, y) => (x === y || x + y === 17 ? 1 : ((x * 3 + y * 5) % 11) / 32))
		const current = translateImage(reference, 2, -1)
		const referenceStars = makeStars()
		const currentStars = makeStars(-2, 1)
		const stacker = new LiveStacker({ ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average', interpolationMode: 'nearest' })

		expect(stacker.add(makeFrame(reference, referenceStars)).accepted).toBeTrue()
		expect(stacker.add(makeFrame(current, currentStars)).accepted).toBeTrue()

		const snapshot = stacker.snapshot()
		expect(snapshot?.acceptedFrames).toBe(2)
		expect(snapshot?.referenceFrameIndex).toBe(0)
		expect(snapshot?.finalImage).toBeDefined()
		expectRawClose(snapshot!.finalImage!.raw, reference.raw)
	})

	test('snapshot is an independent point-in-time view not mutated by later frames', () => {
		const reference = makeImage(18, 18, 1, (x, y) => (x === y || x + y === 17 ? 1 : ((x * 3 + y * 5) % 11) / 32))
		const current = translateImage(reference, 2, -1)
		const stacker = new LiveStacker({ ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average', interpolationMode: 'nearest', keepPerPixelStatistics: true })

		stacker.add(makeFrame(reference, makeStars()))
		stacker.add(makeFrame(current, makeStars(-2, 1)))

		const snapshot = stacker.snapshot()!
		expect(snapshot.acceptedFrames).toBe(2)
		const diagnosticsLength = snapshot.diagnostics.length
		const coverageBefore = Array.from(snapshot.coverageMap!)

		// Continue stacking after the snapshot was taken; the earlier snapshot must not change.
		stacker.add(makeFrame(current, makeStars(-2, 1)))

		expect(snapshot.acceptedFrames).toBe(2)
		expect(snapshot.diagnostics.length).toBe(diagnosticsLength)
		expect(Array.from(snapshot.coverageMap!)).toEqual(coverageBefore)
	})

	test('rejects live methods that are not exact online', () => {
		const image = makeImage(8, 8, 1, () => 1)
		const stacker = new LiveStacker({ ...DEFAULT_STACK_OPTIONS, combinationMethod: 'median' })
		const result = stacker.add(makeFrame(image, makeStars()))
		expect(result.accepted).toBeFalse()
		expect(result.reason).toBe('combination-method-not-supported-in-live-mode')
	})
})

describe('stacker batch mode', () => {
	test('returns an empty result for no frames', () => {
		const result = stackFrames([], DEFAULT_STACK_OPTIONS)
		expect(result.acceptedFrames).toBe(0)
		expect(result.rejectedFrames).toBe(0)
		expect(result.referenceFrameIndex).toBe(-1)
		expect(result.finalImage).toBeUndefined()
	})

	test('a single frame stacks to itself as the reference', () => {
		const image = makeImage(10, 10, 1, (x, y) => ((x * 3 + y * 5) % 11) / 32)
		const result = stackFrames([makeFrame(image, makeStars())], { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average' })
		expect(result.acceptedFrames).toBe(1)
		expect(result.referenceFrameIndex).toBe(0)
		expectRawClose(result.finalImage!.raw, image.raw)
	})

	test('rejects an invalid reference image shape with diagnostics', () => {
		const image = makeImage(0, 10, 1, () => 1)
		const result = stackFrames([makeFrame(image, makeStars())], DEFAULT_STACK_OPTIONS)

		expect(result.acceptedFrames).toBe(0)
		expect(result.rejectedFrames).toBe(1)
		expect(result.referenceFrameIndex).toBe(0)
		expect(result.finalImage).toBeUndefined()
		expect(result.diagnostics[0].reason).toBe('invalid-image-shape')
	})

	test('uses explicit reference selection and weighted average', () => {
		const stars = makeStars()
		const frames = [makeFrame(makeImage(12, 12, 1, 1), stars, 1), makeFrame(makeImage(12, 12, 1, 2), stars, 2), makeFrame(makeImage(12, 12, 1, 4), stars, 1)]
		const result = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'weighted-average', batchReference: { mode: 'index', index: 1 } })
		expect(result.referenceFrameIndex).toBe(1)
		expect(result.acceptedFrames).toBe(3)
		expect(result.finalImage?.raw[0]).toBeCloseTo(2.25, 8)
	})

	test('computes an exact median for a small outlier set', () => {
		const stars = makeStars()
		const frames = [makeFrame(makeImage(10, 10, 1, 1), stars), makeFrame(makeImage(10, 10, 1, 100), stars), makeFrame(makeImage(10, 10, 1, 3), stars)]
		const result = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'median' })
		expect(result.acceptedFrames).toBe(3)
		expect(result.finalImage?.raw[0]).toBeCloseTo(3, 8)
	})

	test('sigma clip rejects a bright outlier frame', () => {
		const stars = makeStars()
		const frames = [makeFrame(makeImage(10, 10, 1, 1), stars), makeFrame(makeImage(10, 10, 1, 1.2), stars), makeFrame(makeImage(10, 10, 1, 20), stars)]
		const result = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'sigma-clip', sigmaClip: { sigmaLower: 1.5, sigmaUpper: 1.5, maxIterations: 3, centerMethod: 'median', dispersionMethod: 'mad' } })
		expect(result.acceptedFrames).toBe(3)
		expect(result.finalImage?.raw[0]).toBeCloseTo(1.1, 6)
	})

	test('selects the best-quality reference frame deterministically', () => {
		const image = makeImage(10, 10, 1, () => 1)
		const frames = [makeFrame(image, makeStars(0, 0, 0.8).slice(0, 4)), makeFrame(image, makeStars(0, 0, 1.4)), makeFrame(image, makeStars(0, 0, 0.9))]
		const result = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, batchReference: { mode: 'best-quality' } })
		expect(result.referenceFrameIndex).toBe(1)
		expect(result.acceptedFrames).toBe(3)
	})

	test('rejects a frame with too few stars during batch stacking', () => {
		const image = makeImage(10, 10, 1, () => 1)
		const frames = [makeFrame(image, makeStars()), makeFrame(image, makeStars().slice(0, 2))]
		const result = stackFrames(frames, DEFAULT_STACK_OPTIONS)
		expect(result.acceptedFrames).toBe(1)
		expect(result.rejectedFrames).toBe(1)
		expect(result.diagnostics.find((entry) => entry.accepted === false)?.reason).toBe('too-few-stars')
	})

	test('preserves RGB channel values consistently after alignment', () => {
		const reference = makeImage(16, 16, 3, (x, y, channel) => (channel === 0 ? x / 16 : channel === 1 ? y / 16 : (x + y) / 32))
		const current = translateImage(reference, -1, 2)
		const result = stackFrames([makeFrame(reference, makeStars()), makeFrame(current, makeStars(1, -2))], { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average', interpolationMode: 'nearest' })

		expect(result.acceptedFrames).toBe(2)
		expect(result.finalImage).toBeDefined()
		expectRawClose(result.finalImage!.raw, reference.raw)
	})
})

describe('stacker normalization modes', () => {
	// A frame large enough for a local grid, with enough structure for the cell estimators.
	function localFrames(scale: (x: number, y: number) => number, offset: (x: number, y: number) => number) {
		const reference = makeImage(64, 64, 1, (x, y) => 0.1 + 0.05 * (x / 64) + 0.06 * Math.sin(x / 7) * Math.cos(y / 9) + (((x * 7 + y * 13) % 17) / 17) * 0.01)
		const current = makeImage(64, 64, 1, (x, y) => (reference.raw[y * 64 + x] - offset(x, y)) / scale(x, y))
		return { reference, current }
	}

	function meanError(actual: ArrayLike<number>, expected: ArrayLike<number>) {
		let sum = 0
		for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i] - expected[i])
		return sum / actual.length
	}

	const LOCAL_OPTIONS = {
		...DEFAULT_STACK_OPTIONS,
		combinationMethod: 'average',
		normalizationMode: 'local',
		localNormalization: { gridSize: 4, minSamplesPerCell: 32, offsetDegree: 2, scaleDegree: 1 },
	} as const satisfies StackingOptions

	test('local mode reports the global anchor and local diagnostics', () => {
		const { reference, current } = localFrames(
			() => 1.3,
			(x) => 0.01 + 0.02 * (x / 64),
		)
		const result = stackFrames([makeFrame(reference, makeStars()), makeFrame(current, makeStars())], LOCAL_OPTIONS)

		expect(result.acceptedFrames).toBe(2)

		const summary = result.diagnostics[1].normalization
		expect(summary).toBeDefined()
		expect(summary!.scales).toHaveLength(1)
		expect(summary!.local).toBeDefined()
		expect(summary!.local!.estimator).toBe('background-scale')
		expect(summary!.local!.model).toBe('polynomial')
		expect(summary!.local!.channels).toHaveLength(1)
		expect(summary!.local!.fallback).toBe(false)
	})

	test('local diagnostics stay compact and never retain the full model', () => {
		const { reference, current } = localFrames(
			() => 1.2,
			() => 0.02,
		)
		const result = stackFrames([makeFrame(reference, makeStars()), makeFrame(current, makeStars())], LOCAL_OPTIONS)

		const summary = result.diagnostics[1].normalization!
		expect(Object.keys(summary).sort()).toEqual(['local', 'offsets', 'scales', 'weight'])
		expect(Object.keys(summary.local!).sort()).toEqual(['channels', 'estimator', 'fallback', 'model'])
		for (const channel of summary.local!.channels) {
			expect(Object.keys(channel)).not.toContain('coefficients')
			expect(Object.keys(channel)).not.toContain('samples')
		}
	})

	test('local mode corrects a spatial offset field better than the global mode', () => {
		const offset = (x: number, y: number) => 0.01 + 0.02 * (x / 64) - 0.015 * (y / 64)
		const { reference, current } = localFrames(() => 1, offset)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]

		const local = stackFrames(frames, LOCAL_OPTIONS)
		const global = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average', normalizationMode: 'background-scale' })

		expect(meanError(local.finalImage!.raw, reference.raw)).toBeLessThan(meanError(global.finalImage!.raw, reference.raw))
	})

	test('live and batch produce the same local normalization', () => {
		const { reference, current } = localFrames(
			(x) => 1.1 + 0.1 * (x / 64),
			(x) => 0.01 * (x / 64),
		)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]

		const batch = stackFrames(frames, LOCAL_OPTIONS)

		const live = new LiveStacker(LOCAL_OPTIONS)
		for (const frame of frames) live.add(frame)
		const snapshot = live.snapshot()!

		expectRawClose(snapshot.finalImage!.raw, batch.finalImage!.raw, 1e-9)

		const batchSummary = batch.diagnostics[1].normalization!
		const liveSummary = snapshot.diagnostics[1].normalization!
		expect(liveSummary.scales).toEqual(batchSummary.scales)
		expect(liveSummary.offsets).toEqual(batchSummary.offsets)
		expect(liveSummary.local!.channels).toEqual(batchSummary.local!.channels)
	})

	test('overlap rejection outranks a local normalization failure in both paths', () => {
		// The frame registers but covers too little of the reference, and its local fit would fail too.
		// Coverage is the documented reason, and batch must agree with live on that precedence.
		const { reference } = localFrames(
			() => 1.2,
			() => 0.01,
		)
		const shifted = translateImage(reference, -56, 56)
		const frames = [makeFrame(reference, makeStars()), makeFrame(shifted, makeStars(56, -56))]
		const options = {
			...LOCAL_OPTIONS,
			minOverlapFraction: 0.95,
			localNormalization: { gridSize: 4, minSamplesPerCell: 100000, fallback: 'reject' },
		} as const satisfies StackingOptions

		const batch = stackFrames(frames, options)
		expect(batch.diagnostics[1].reason).toBe('insufficient-overlap')

		const live = new LiveStacker(options)
		live.add(frames[0])
		expect(live.add(frames[1]).reason).toBe('insufficient-overlap')
	})
	test('a reject fallback drops the frame as normalization-failed', () => {
		const { reference, current } = localFrames(
			() => 1.2,
			() => 0.01,
		)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]
		// No cell can supply that many pairs, so every plane falls back.
		const options = { ...LOCAL_OPTIONS, localNormalization: { gridSize: 4, minSamplesPerCell: 100000, fallback: 'reject' } } as const satisfies StackingOptions

		const batch = stackFrames(frames, options)
		expect(batch.acceptedFrames).toBe(1)
		expect(batch.diagnostics[1].reason).toBe('normalization-failed')

		const live = new LiveStacker(options)
		live.add(frames[0])
		expect(live.add(frames[1]).reason).toBe('normalization-failed')
	})

	test('a global fallback keeps the frame and flags the diagnostics', () => {
		const { reference, current } = localFrames(
			() => 1.2,
			() => 0.01,
		)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]
		const options = { ...LOCAL_OPTIONS, localNormalization: { gridSize: 4, minSamplesPerCell: 100000, fallback: 'global' } } as const satisfies StackingOptions

		const result = stackFrames(frames, options)
		expect(result.acceptedFrames).toBe(2)
		expect(result.diagnostics[1].normalization!.local!.fallback).toBe(true)
		expect(result.diagnostics[1].normalization!.local!.channels[0].reason).toBeDefined()
	})

	test('the reference frame keeps identity in local mode', () => {
		const { reference, current } = localFrames(
			() => 1.4,
			() => 0.03,
		)
		const referenceCopy = Float32Array.from(reference.raw)
		const result = stackFrames([makeFrame(reference, makeStars()), makeFrame(current, makeStars())], LOCAL_OPTIONS)

		expect(result.diagnostics[0].normalization!.scales).toEqual([1])
		expect(result.diagnostics[0].normalization!.offsets).toEqual([0])
		expectRawClose(reference.raw, referenceCopy, 0)
	})

	test('RGB local normalization runs per channel and in luminance', () => {
		const reference = makeImage(64, 64, 3, (x, y, channel) => 0.1 + 0.03 * channel + 0.05 * (x / 64) + 0.05 * Math.sin(x / 7) * Math.cos(y / 9))
		const current = makeImage(64, 64, 3, (x, y, channel) => (reference.raw[(y * 64 + x) * 3 + channel] - 0.01) / 1.2)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]

		const perChannel = stackFrames(frames, LOCAL_OPTIONS)
		expect(perChannel.diagnostics[1].normalization!.local!.channels).toHaveLength(3)

		const luminance = stackFrames(frames, { ...LOCAL_OPTIONS, colorHandlingMode: 'luminance' })
		expect(luminance.diagnostics[1].normalization!.local!.channels).toHaveLength(1)
		expect(luminance.diagnostics[1].normalization!.scales).toHaveLength(3)
	})

	test('global modes are unaffected by local normalization options', () => {
		const { reference, current } = localFrames(
			() => 1.3,
			() => 0.02,
		)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]

		for (const mode of ['none', 'scale', 'background-scale', 'percentile'] as const) {
			const plain = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average', normalizationMode: mode })
			const withOptions = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, combinationMethod: 'average', normalizationMode: mode, localNormalization: { gridSize: 4 } })

			expectRawClose(withOptions.finalImage!.raw, plain.finalImage!.raw, 0)
			expect(withOptions.diagnostics[1].normalization!.local).toBeUndefined()
		}
	})

	test('a stale local configuration is ignored outside local mode', () => {
		const image = makeImage(10, 10, 1, () => 1)
		const frames = [makeFrame(image, makeStars())]
		const stale = { gridSize: Number.NaN, relativeScaleRange: [2, 0.5] } as const

		for (const mode of ['none', 'scale', 'background-scale', 'percentile'] as const) {
			expect(() => stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, normalizationMode: mode, localNormalization: stale })).not.toThrow()
			expect(() => new LiveStacker({ ...DEFAULT_STACK_OPTIONS, normalizationMode: mode, localNormalization: stale })).not.toThrow()
		}

		// The same block is still validated when local mode actually uses it.
		expect(() => new LiveStacker({ ...DEFAULT_STACK_OPTIONS, normalizationMode: 'local', localNormalization: stale })).toThrow()
	})

	test('a normalization rejection reports the coverage the frame actually had', () => {
		const { reference, current } = localFrames(
			() => 1.2,
			() => 0.01,
		)
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars())]
		const options = { ...LOCAL_OPTIONS, localNormalization: { gridSize: 4, minSamplesPerCell: 100000, fallback: 'reject' } } as const satisfies StackingOptions

		const batch = stackFrames(frames, options)
		const rejected = batch.diagnostics[1]
		expect(rejected.reason).toBe('normalization-failed')
		// The frames are identical in geometry, so coverage is full and must not read as no-overlap.
		expect(rejected.overlapFraction).toBeGreaterThan(0.9)

		const live = new LiveStacker(options)
		live.add(frames[0])
		expect(live.add(frames[1]).overlapFraction).toBeGreaterThan(0.9)
	})
})
