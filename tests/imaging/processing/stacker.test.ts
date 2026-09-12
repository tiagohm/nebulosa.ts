import { describe, expect, test } from 'bun:test'
import { readImageFromBuffer } from '../../../src/imaging/model/image'
import { type CfaPattern, type Image, shiftCfaPattern } from '../../../src/imaging/model/types'
import { bayer } from '../../../src/imaging/processing/debayer'
import { LiveStacker, type StackingFrame, type StackingOptions, stackFrames } from '../../../src/imaging/processing/stacker'
import type { DetectedStar } from '../../../src/imaging/stars/detector'
import { Bitpix, writeFits } from '../../../src/io/formats/fits/fits'
import { bufferSink } from '../../../src/io/io'

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

const DRIZZLE_OPTIONS = { ...DEFAULT_STACK_OPTIONS, reconstructionMode: 'drizzle', samplePrecision: 64 } as const satisfies StackingOptions

describe('Drizzle stacker integration', () => {
	test('default photometry does not amplify a noisy background after a half-pixel dither', () => {
		let seed = 123456789
		const source = makeImage(256, 256, 1, () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
			return 0.2 + 0.04 * (seed / 4294967296 - 0.5)
		})
		const frames = [makeFrame(source, makeStars()), makeFrame(source, makeStars(-0.5, -0.5))]
		const options = { reconstructionMode: 'drizzle', samplePrecision: 64, matchStarsConfig: DEFAULT_STACK_OPTIONS.matchStarsConfig } as const satisfies StackingOptions
		const batch = stackFrames(frames, options)
		const live = new LiveStacker(options)
		for (const frame of frames) live.add(frame)
		expect(batch.acceptedFrames).toBe(2)
		expect(batch.statistics.normalizationMode).toBe('background-scale')
		expect(Math.abs(batch.diagnostics[1].normalization!.scales[0] - 1)).toBeLessThan(0.08)
		expect(live.snapshot()!.diagnostics).toEqual(batch.diagnostics)
	})

	test('registration preserves rotated, mirrored and affine fields from differently sized targets', () => {
		for (const [a, b, c, d, tx, ty] of [
			[Math.cos(0.2), -Math.sin(0.2), Math.sin(0.2), Math.cos(0.2), 1, -1],
			[-1, 0, 0, 1, 17, 0],
			[1.02, 0.08, 0.03, 0.98, 0.2, 0.4],
		]) {
			const stars = makeStars()
			const det = a * d - b * c
			const targetStars = stars.map((s) => ({ ...s, x: (d * (s.x - tx) - b * (s.y - ty)) / det, y: (-c * (s.x - tx) + a * (s.y - ty)) / det }))
			const result = stackFrames([makeFrame(makeImage(18, 18, 1, 0.4), stars), makeFrame(makeImage(21, 20, 1, 0.4), targetStars)], {
				...DRIZZLE_OPTIONS,
				minimumCoverage: 1,
				matchStarsConfig: { ...DEFAULT_STACK_OPTIONS.matchStarsConfig, allowAffineFallback: true, modelPreference: 'affine', maxResidual: 2, finalMatchRadius: 2 },
			})
			expect(result.acceptedFrames).toBe(2)
			expect(result.diagnostics[1].transform!.translationX).toBeCloseTo(tx, 7)
			expect(result.diagnostics[1].transform!.translationY).toBeCloseTo(ty, 7)
			expect(result.diagnostics[1].transform!.mirrored).toBe(det < 0)
			for (let p = 0; p < result.validityMask!.length; p++) {
				if (result.validityMask![p]) expect(result.finalImage!.raw[p]).toBeCloseTo(0.4, 6)
			}
		}
	})

	test('weighted mean uses resolved frame weights, and minimum coverage counts frames rather than weights', () => {
		// Keep the tested boundary away from an exact integer contact: the fitted affine may carry
		// roundoff-sized positive overlaps, which deliberately count as support without an epsilon.
		const frames = [makeFrame(makeImage(18, 18, 1, 0.2), makeStars(), 1), makeFrame(makeImage(18, 18, 1, 0.8), makeStars(-2.25, 0), 3)]
		const result = stackFrames(frames, { ...DRIZZLE_OPTIONS, combinationMethod: 'weighted-average', minimumCoverage: 1, drizzle: { scale: 1 } })
		expect(result.statistics.acceptedWeightSum).toBe(4)
		for (let y = 0; y < 18; y++) {
			for (let x = 0; x < 18; x++) {
				const p = y * 18 + x
				expect(result.validityMask![p]).toBe(x >= 2 ? 1 : 0)
				expect(result.finalImage!.raw[p]).toBeCloseTo(x === 2 ? (0.2 + 0.8 * 3 * 0.75) / (1 + 3 * 0.75) : x > 2 ? 0.65 : 0, 6)
			}
		}
	})

	test('global normalization is shared by batch/live and effective CFA scales have three channels', () => {
		for (const reconstructionMode of ['drizzle', 'cfaDrizzle'] as const) {
			const rgb = makeImage(18, 18, 3, (x, y, c) => 0.1 + x * 0.01 + y * 0.003 + c * 0.1)
			const targetRgb = makeImage(18, 18, 3, (x, y, c) => (0.1 + x * 0.01 + y * 0.003 + c * 0.1 - 0.03) / 2)
			const reference = reconstructionMode === 'drizzle' ? rgb : bayer(rgb, 'RGGB')!
			const target = reconstructionMode === 'drizzle' ? targetRgb : bayer(targetRgb, 'RGGB')!
			const frames = [makeFrame(reference, makeStars()), makeFrame(target, makeStars())]
			const options = { ...DRIZZLE_OPTIONS, reconstructionMode, normalizationMode: 'background-scale' } as const
			const batch = stackFrames(frames, options)
			const live = new LiveStacker(options)
			for (const frame of frames) live.add(frame)
			expect(live.snapshot()!.weightMap).toEqual(batch.weightMap)
			expect(live.snapshot()!.diagnostics).toEqual(batch.diagnostics)
			expect(batch.diagnostics[0].normalization!.scales).toEqual([1, 1, 1])
			for (const scale of batch.diagnostics[1].normalization!.scales) expect(scale).toBeCloseTo(2, 5)
			for (const offset of batch.diagnostics[1].normalization!.offsets) expect(offset).toBeCloseTo(0.03, 5)
		}
	})

	test('Float32 override and automatic reference precision describe the final raw', () => {
		const single = makeFrame(makeImage(3, 2, 3, 0.4), [])
		const double: StackingFrame = { ...single, image: { ...single.image, raw: Float64Array.from(single.image.raw) } }
		for (const samplePrecision of [32, 64, 'auto'] as const) {
			for (const frame of [single, double]) {
				const result = stackFrames([frame], { ...DRIZZLE_OPTIONS, samplePrecision }).finalImage!
				const bytes = samplePrecision === 'auto' ? frame.image.raw.BYTES_PER_ELEMENT : samplePrecision / 8
				expect(result.raw.BYTES_PER_ELEMENT).toBe(bytes)
				expect(result.metadata.pixelSizeInBytes).toBe(bytes)
				expect(result.metadata.strideInBytes).toBe(result.metadata.stride * bytes)
			}
		}
	})

	test('identity scale one preserves pixels; scale two separates intensity and total sum', () => {
		const source = makeImage(3, 2, 1, (x, y) => (x + y + 1) / 8)
		for (const combinationMethod of ['average', 'sum'] as const) {
			const single = stackFrames([makeFrame(source, [])], { ...DRIZZLE_OPTIONS, combinationMethod, drizzle: { scale: 1 } })
			expectRawClose(single.finalImage!.raw, source.raw, 1e-12)
			const doubled = stackFrames([makeFrame(source, [])], { ...DRIZZLE_OPTIONS, combinationMethod })
			expect(doubled.finalImage!.metadata.width).toBe(6)
			expect(doubled.finalImage!.metadata.height).toBe(4)
			for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) expect(doubled.finalImage!.raw[y * 6 + x]).toBeCloseTo(source.raw[Math.floor(y / 2) * 3 + Math.floor(x / 2)] / (combinationMethod === 'sum' ? 4 : 1), 12)
			expect(doubled.weightMap!.channels).toBe(1)
			expect(doubled.statistics.drizzle).toEqual({ scale: 2, pixfrac: 1, outputWidth: 6, outputHeight: 4 })
		}
	})

	test.each(['sum', 'average', 'weighted-average'] as const)('%s batch/live agree after subpixel and integer translations, crop and rejected frames', (combinationMethod) => {
		const source = makeImage(18, 18, 3, (_x, _y, c) => [0.2, 0.5, 0.8][c])
		const frames = [makeFrame(source, makeStars(), 0.5), makeFrame(source, makeStars(-2, 1), 2), makeFrame(source, makeStars(-0.37, 0.21), 3), makeFrame(source, [], 5)]
		const options = { ...DRIZZLE_OPTIONS, combinationMethod, cropMode: 'intersection', drizzle: { scale: 1.7, pixfrac: 0.7 } } as const
		const live = new LiveStacker(options)
		for (const frame of frames) live.add(frame)
		const batch = stackFrames(frames, options)
		const snapshot = live.snapshot()!
		expect(batch.acceptedFrames).toBe(3)
		expect(batch.rejectedFrames).toBe(1)
		expectRawClose(snapshot.finalImage!.raw, batch.finalImage!.raw, 1e-12)
		expect(snapshot.coverageMap).toEqual(batch.coverageMap)
		expect(snapshot.validityMask).toEqual(batch.validityMask)
		expect(snapshot.weightMap!.raw).toEqual(batch.weightMap!.raw)
		expect(snapshot.effectiveCropBounds).toEqual(batch.effectiveCropBounds)
		expect(snapshot.statistics.acceptedWeightSum).toBe(5.5)
		expect(snapshot.coverageMap!.every((v) => v <= 3)).toBeTrue()
		expect(snapshot.finalImage!.metadata.width).toBeLessThan(snapshot.weightMap!.width)
		expect(snapshot.finalImage!.metadata.strideInBytes).toBe(snapshot.finalImage!.metadata.width * 3 * 8)
	})

	test('rejected overlap leaves maps intact; accepted geometric overlap need not imply full drop support', () => {
		const source = makeImage(18, 18, 1, 0.4)
		const live = new LiveStacker({ ...DRIZZLE_OPTIONS, minOverlapFraction: 0.99 })
		live.add(makeFrame(source, makeStars()))
		const before = live.snapshot()!
		const result = live.add(makeFrame(source, makeStars(-2, 1)))
		expect(result.reason).toBe('insufficient-overlap')
		expect(result.overlapFraction).toBeCloseTo((16 * 17) / 324, 10)
		expect(live.snapshot()!.weightMap).toEqual(before.weightMap)
		expect(live.snapshot()!.coverageMap).toEqual(before.coverageMap)
		expect(live.snapshot()!.finalImage!.raw).toEqual(before.finalImage!.raw)
	})

	test('map-free output retains mask, holes are real, intersection writes directly to inclusive bounds', () => {
		const source = makeImage(2, 2, 1, 0.4)
		const options = { ...DRIZZLE_OPTIONS, drizzle: { scale: 3, pixfrac: 0.2 }, keepPerPixelStatistics: false } as const
		const union = stackFrames([makeFrame(source, [])], options)
		expect(union.coverageMap).toBeUndefined()
		expect(union.weightMap).toBeUndefined()
		expect(union.validityMask!.reduce((a, b) => a + b, 0)).toBe(4)
		expect(union.finalImage!.raw.filter((v) => v > 0).length).toBe(4)
		const intersection = stackFrames([makeFrame(source, [])], { ...options, cropMode: 'intersection' })
		expect(intersection.effectiveCropBounds).toEqual({ left: 1, top: 1, right: 4, bottom: 4, width: 4, height: 4 })
		expect(intersection.finalImage!.raw.length).toBe(16)
		expect(intersection.validityMask!.length).toBe(36)
	})

	test.each(['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG'] as CfaPattern[])('CFA %s reconstructs RGB intensity from dithers, with both greens sharing one denominator', (pattern) => {
		const color = makeImage(18, 18, 3, (_x, _y, c) => [0.2, 0.5, 0.8][c])
		const mosaic = bayer(color, pattern)!
		const frames = [makeFrame(mosaic, makeStars()), makeFrame(mosaic, makeStars(-1, 0)), makeFrame(mosaic, makeStars(0, -1)), makeFrame(mosaic, makeStars(-1, -1))]
		const options = { ...DRIZZLE_OPTIONS, reconstructionMode: 'cfaDrizzle', colorHandlingMode: 'luminance', drizzle: { scale: 1 }, cropMode: 'intersection' } as const
		const live = new LiveStacker(options)
		live.add(frames[0])
		const early = live.snapshot()!
		expect(early.acceptedFrames).toBe(1)
		expect(early.finalImage).toBeUndefined()
		expect(early.effectiveCropBounds).toBeUndefined()
		expect(early.weightMap).toBeDefined()
		for (let i = 1; i < frames.length; i++) live.add(frames[i])
		const result = live.snapshot()!
		expect(result.acceptedFrames).toBe(4)
		expect(result.finalImage!.metadata.bayer).toBeUndefined()
		expect(result.statistics.colorHandlingMode).toBe('per-channel')
		expectRawClose(result.finalImage!.raw, stackFrames(frames, options).finalImage!.raw, 1e-12)
		for (let i = 0; i < result.finalImage!.raw.length; i++) expect(result.finalImage!.raw[i]).toBeCloseTo([0.2, 0.5, 0.8][i % 3], 6)
		const sum = stackFrames(frames, { ...options, combinationMethod: 'sum' })
		for (let i = 0; i < sum.finalImage!.raw.length; i++) expect(sum.finalImage!.raw[i]).toBeCloseTo([0.2, 1, 0.8][i % 3], 6)
		expect(early.weightMap!.raw).not.toEqual(result.weightMap!.raw)
		expect(early.validityMask!.every((v) => v === 0)).toBeTrue()
	})

	test('reference eligibility supports first/best/index and live recovery after incompatible reference', () => {
		const mono = makeImage(18, 18, 1, 0.4)
		const mosaic = bayer(makeImage(18, 18, 3, 0.4), 'RGGB')!
		for (const reconstructionMode of ['drizzle', 'cfaDrizzle'] as const) {
			const bad = makeFrame(reconstructionMode === 'drizzle' ? mosaic : mono, makeStars(0, 0, 10))
			const good = makeFrame(reconstructionMode === 'drizzle' ? mono : mosaic, makeStars())
			const options = { ...DRIZZLE_OPTIONS, reconstructionMode }
			for (const mode of ['first-accepted', 'best-quality'] as const) {
				const result = stackFrames([bad, good], { ...options, batchReference: { mode } })
				expect(result.referenceFrameIndex).toBe(1)
				expect(result.acceptedFrames).toBe(1)
				expect(result.rejectedFrames).toBe(1)
			}
			const explicit = stackFrames([bad, good], { ...options, batchReference: { mode: 'index', index: 0 } })
			expect(explicit.acceptedFrames).toBe(0)
			expect(explicit.referenceFrameIndex).toBe(0)
			const none = stackFrames([bad, bad], options)
			expect(none.referenceFrameIndex).toBe(-1)
			expect(none.diagnostics.length).toBe(2)
			expect(none.statistics.drizzle).toBeUndefined()
			const live = new LiveStacker(options)
			expect(live.add(bad).accepted).toBeFalse()
			expect(live.snapshot()).toBeUndefined()
			expect(live.add(good).accepted).toBeTrue()
			expect(live.snapshot()!.referenceFrameIndex).toBe(1)
		}
	})

	test('incompatible configuration fails before frames; resample ignores obsolete drizzle block', () => {
		for (const options of [{ combinationMethod: 'median' }, { normalizationMode: 'local' }] as const) {
			expect(() => stackFrames([], { ...DRIZZLE_OPTIONS, ...options })).toThrow(RangeError)
			expect(() => new LiveStacker({ ...DRIZZLE_OPTIONS, ...options })).toThrow(RangeError)
		}
		expect(() => stackFrames([], { ...DRIZZLE_OPTIONS, drizzle: { scale: Infinity } })).toThrow(RangeError)
		expect(() => stackFrames([], { ...DRIZZLE_OPTIONS, reconstructionMode: 'resample', drizzle: { scale: Infinity, maxMemoryBytes: -1 } })).not.toThrow()
	})

	test('memory overrun never installs a reference; snapshots survive add/reset/initialize independently', () => {
		const frame = makeFrame(makeImage(18, 18, 1, 0.4), makeStars())
		const live = new LiveStacker({ ...DRIZZLE_OPTIONS, drizzle: { maxMemoryBytes: 1 } })
		expect(() => live.add(frame)).toThrow(RangeError)
		expect(live.snapshot()).toBeUndefined()
		live.initialize(DRIZZLE_OPTIONS)
		live.add(frame)
		const saved = live.snapshot()!
		const raw = saved.finalImage!.raw.slice()
		const weights = saved.weightMap!.raw.slice()
		const coverage = saved.coverageMap!.slice()
		live.add(frame)
		live.reset()
		expect(live.snapshot()).toBeUndefined()
		live.initialize({ ...DRIZZLE_OPTIONS, drizzle: { scale: 1 } })
		live.add(frame)
		expect(saved.finalImage!.raw).toEqual(raw)
		expect(saved.weightMap!.raw).toEqual(weights)
		expect(saved.coverageMap).toEqual(coverage)
		expect(saved.diagnostics.length).toBe(1)
	})

	test.each([1, 3])('FITS %i-channel round trip clears Rice/table/scaling metadata and preserves reference', async (channels) => {
		const source = makeImage(5, 3, channels, (x, y, c) => (x + y + c + 1) / 16)
		Object.assign(source.header, {
			XTENSION: 'BINTABLE',
			BITPIX: 8,
			NAXIS: 2,
			NAXIS1: 8,
			NAXIS2: 3,
			PCOUNT: 200,
			GCOUNT: 1,
			TFIELDS: 1,
			TTYPE1: 'COMPRESSED_DATA',
			TFORM1: '1PB',
			ZIMAGE: true,
			ZCMPTYPE: 'RICE_1',
			ZBITPIX: 16,
			ZNAXIS: 2,
			ZNAXIS1: 5,
			ZNAXIS2: 3,
			ZTILE1: 5,
			BSCALE: 2,
			BZERO: 100,
			BLANK: 0,
			CHECKSUM: 'stale',
			DATASUM: 'stale',
			IMAGEW: 5,
			IMAGEH: 3,
			OBJECT: 'M31',
			ZFOCUS: 5,
			TELESCOP: 'scope',
		})
		const original = { ...source.header }
		const result = stackFrames([makeFrame(source, [])], { ...DRIZZLE_OPTIONS, drizzle: { scale: 1.3 } }).finalImage!
		expect(source.header).toEqual(original)
		expect(result.header.ZIMAGE).toBeUndefined()
		expect(result.header.BSCALE).toBeUndefined()
		expect(result.header.TFORM1).toBeUndefined()
		expect(result.header.CHECKSUM).toBeUndefined()
		expect(result.header.ZFOCUS).toBe(5)
		expect(result.header.TELESCOP).toBe('scope')
		expect(result.header.BITPIX).toBe(Bitpix.DOUBLE)
		expect(result.header.NAXIS3).toBe(channels === 3 ? 3 : undefined)
		expect(result.metadata.strideInBytes).toBe(result.metadata.width * channels * 8)
		const storage = Buffer.alloc(32768)
		const sink = bufferSink(storage)
		await writeFits(sink, [result])
		const restored = (await readImageFromBuffer(storage.subarray(0, sink.position), { raw: 64 }))!
		expect(restored.metadata.width).toBe(result.metadata.width)
		expect(restored.metadata.height).toBe(result.metadata.height)
		expect(restored.metadata.channels).toBe(channels)
		expectRawClose(restored.raw, result.raw, 1e-12)
	})
})

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

	test('intersection crop rewrites FITS geometry and CFA phase to the output raster', async () => {
		const reference = makeImage(18, 18, 1, (x, y) => ((x * 3 + y * 5) % 11) / 32)
		Object.assign(reference.metadata, { bayer: 'RGGB' })
		Object.assign(reference.header, {
			BITPIX: Bitpix.FLOAT,
			NAXIS: 2,
			NAXIS1: 18,
			NAXIS2: 18,
			CRPIX1: 9.5,
			CRPIX2: 9.5,
			CRVAL1: 10,
			CRVAL2: 20,
			CTYPE1: 'RA---TAN',
			CTYPE2: 'DEC--TAN',
			CD1_1: -0.001,
			CD1_2: 0,
			CD2_1: 0,
			CD2_2: 0.001,
			BAYERPAT: 'RGGB',
		})
		const current = translateImage(reference, 4, -3)
		Object.assign(current.metadata, { bayer: 'RGGB' })
		const frames = [makeFrame(reference, makeStars()), makeFrame(current, makeStars(-4, 3))]
		const result = stackFrames(frames, { ...DEFAULT_STACK_OPTIONS, cropMode: 'intersection', interpolationMode: 'nearest' })
		const image = result.finalImage!
		const bounds = result.effectiveCropBounds!

		expect(result.acceptedFrames).toBe(2)
		expect(image.metadata.width).toBe(bounds.width)
		expect(image.metadata.height).toBe(bounds.height)
		expect(image.metadata.width).toBeLessThan(18)
		expect(image.header.NAXIS1).toBe(image.metadata.width)
		expect(image.header.NAXIS2).toBe(image.metadata.height)
		expect(image.header.CRPIX1).toBeCloseTo(9.5 - bounds.left, 10)
		expect(image.header.CRPIX2).toBeCloseTo(9.5 - bounds.top, 10)
		expect(image.metadata.bayer).toBe(shiftCfaPattern('RGGB', bounds.left, bounds.top))
		expect(image.header.BAYERPAT).toBe(image.metadata.bayer)
		// Coverage and validity stay on the documented pre-crop reference grid.
		expect(result.validityMask!.length).toBe(18 * 18)
		expect(result.coverageMap!.length).toBe(18 * 18)

		const storage = Buffer.alloc(32768)
		const sink = bufferSink(storage)
		await writeFits(sink, [image])
		const restored = (await readImageFromBuffer(storage.subarray(0, sink.position), { raw: 32 }))!
		expect(restored.metadata.width).toBe(image.metadata.width)
		expect(restored.metadata.height).toBe(image.metadata.height)
		expectRawClose(restored.raw, image.raw, 1e-5)
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
