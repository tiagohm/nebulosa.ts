import { describe, expect, test } from 'bun:test'
import { Bitpix } from '../src/fits'
import type { Image } from '../src/image.types'
import { LiveStacker, type StackingFrame, type StackingOptions, stackFrames } from '../src/stacker'
import type { DetectedStar } from '../src/star.detector'

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

	test('rejects live methods that are not exact online', () => {
		const image = makeImage(8, 8, 1, () => 1)
		const stacker = new LiveStacker({ ...DEFAULT_STACK_OPTIONS, combinationMethod: 'median' })
		const result = stacker.add(makeFrame(image, makeStars()))
		expect(result.accepted).toBeFalse()
		expect(result.reason).toBe('combination-method-not-supported-in-live-mode')
	})
})

describe('stacker batch mode', () => {
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
