import { expect, test } from 'bun:test'
import { analyzeFlatSequence } from '../../../../src/imaging/analysis/flat/sequence'
import type { FlatFrame, FlatReference, FlatSequenceInput, FlatSequenceOptions } from '../../../../src/imaging/analysis/flat/types'
import { generateSyntheticFlatImage, type SyntheticFlatModel } from '../../../../src/imaging/synthetic/flat'

const FRAME_ANALYSIS = {
	effectiveClip: { lower: 0, upper: 65535 },
	criteria: {
		targets: { mono: { levelMode: 'observed', range: [500, 2000] } },
		maximumClippedFraction: 0,
		maximumNonFiniteFraction: 0,
	},
} as const

function completeFrame(index: number, model: Partial<SyntheticFlatModel> = {}, overrides: Partial<FlatFrame> = {}): FlatFrame {
	const image = generateSyntheticFlatImage({
		width: 64,
		height: 48,
		bias: 0,
		signal: 1000,
		vignetting: 0.15,
		lowerClip: 0,
		upperClip: 65535,
		quantizationStep: 1,
		...model,
	})
	return {
		id: `flat-${index}`,
		image,
		exposure: 1,
		timestamp: 1_000_000 + index * 1000,
		filter: 'L',
		illumination: { source: 'panel', brightness: 50 },
		operatingPoint: { gain: 100, offset: 20, temperature: -10 + index * 0.05, readoutMode: 'low-noise', binning: [1, 1], sensorOrigin: [0, 0] },
		...overrides,
	}
}

function sequenceOptions(overrides: Partial<FlatSequenceOptions> = {}): Partial<FlatSequenceOptions> {
	return {
		analysis: FRAME_ANALYSIS,
		temperatureTolerance: 0.5,
		maximumSignalVariation: 0,
		maximumSpatialVariation: 0,
		maximumProfileVariation: 0,
		maximumDriftPerFrame: 0,
		maximumDriftPerSecond: 0,
		...overrides,
	}
}

function asSequence(frames: FlatFrame[]): FlatSequenceInput['frames'] {
	if (frames.length < 3) throw new RangeError('test sequence requires three frames')
	return frames as unknown as FlatSequenceInput['frames']
}

test('accepts a stable homogeneous sequence and preserves frame order and identity', () => {
	const frames = [completeFrame(0), completeFrame(1), completeFrame(2), completeFrame(3), completeFrame(4)] as const
	const result = analyzeFlatSequence({ frames }, sequenceOptions())

	expect(result.assessment.verdict).toBe('accepted')
	expect(result.assessment).toMatchObject({
		frameQuality: { status: 'pass' },
		signalStability: { status: 'pass' },
		spatialStability: { status: 'pass' },
		profileStability: { status: 'pass' },
	})
	expect(result.frames.map((frame) => [frame.index, frame.id, frame.status])).toEqual([
		[0, 'flat-0', 'accepted'],
		[1, 'flat-1', 'accepted'],
		[2, 'flat-2', 'accepted'],
		[3, 'flat-3', 'accepted'],
		[4, 'flat-4', 'accepted'],
	])
	expect(result.planes[0]).toMatchObject({ plane: 'mono', basis: 'observed', medianSignal: 952.5, signalVariation: 0, spatialVariation: 0, rowVariation: 0, columnVariation: 0, driftPerFrame: 0, driftPerSecond: 0, outliers: [] })
})

test('uses the shared reference-corrected basis for every temporal signature', () => {
	const frames = [completeFrame(0, { bias: 100, signal: 900 }), completeFrame(1, { bias: 100, signal: 900 }), completeFrame(2, { bias: 100, signal: 900 })] as const
	const reference: FlatReference = {
		kind: 'bias',
		image: generateSyntheticFlatImage({ width: 64, height: 48, bias: 100, signal: 0, vignetting: 0, lowerClip: 0, upperClip: 65535, quantizationStep: 1 }),
		operatingPoint: { gain: 100, offset: 20, readoutMode: 'low-noise', binning: [1, 1], sensorOrigin: [0, 0] },
	}
	const result = analyzeFlatSequence({ frames, reference }, sequenceOptions())

	expect(result.assessment.verdict).toBe('accepted')
	expect(result.planes[0].basis).toBe('corrected')
	expect(result.planes[0].medianSignal).toBeLessThan(900)
	expect(result.planes[0].signalVariation).toBe(0)
})

test('measures and rejects robust global drift without inventing spatial variation', () => {
	const frames = asSequence([0, 1, 2, 3, 4].map((index) => completeFrame(index, { signal: 1000 + index * 20 })))
	const result = analyzeFlatSequence({ frames }, sequenceOptions({ maximumSignalVariation: 1, maximumDriftPerFrame: 0.01, maximumDriftPerSecond: undefined }))

	expect(result.planes[0].driftPerFrame).toBeGreaterThan(0.018)
	expect(result.planes[0].driftPerFrame).toBeLessThan(0.021)
	expect(result.planes[0].spatialVariation).toBeLessThan(0.001)
	expect(result.assessment.signalStability.status).toBe('fail')
	expect(result.assessment.verdict).toBe('rejected')
	expect(result.assessment.reasons).toContain('sequenceDrift')
})

test('detects temporal tile and axis-profile variation independently of global level', () => {
	const spatialFrames = asSequence([0, 1, 2, 3, 4].map((index) => completeFrame(index, { gradient: { x: index * 0.02, y: 0 } })))
	const spatial = analyzeFlatSequence({ frames: spatialFrames }, sequenceOptions({ maximumSignalVariation: 1, maximumSpatialVariation: 0.001, maximumProfileVariation: 1, maximumDriftPerFrame: 1, maximumDriftPerSecond: undefined }))
	expect(spatial.planes[0].spatialVariation).toBeGreaterThan(0.001)
	expect(spatial.assessment.spatialStability.status).toBe('fail')

	const profileFrames = asSequence(
		[0, 1, 2, 3, 4].map((index) =>
			completeFrame(index, {
				rowBanding: { amplitude: index * 0.01, period: 16 },
				columnBanding: { amplitude: index * 0.008, period: 12 },
			}),
		),
	)
	const profiles = analyzeFlatSequence({ frames: profileFrames }, sequenceOptions({ maximumSignalVariation: 1, maximumSpatialVariation: 1, maximumProfileVariation: 0.002, maximumDriftPerFrame: 1, maximumDriftPerSecond: undefined }))
	expect(profiles.planes[0].rowVariation).toBeGreaterThan(0.002)
	expect(profiles.planes[0].columnVariation).toBeGreaterThan(0.002)
	expect(profiles.assessment.profileStability.status).toBe('fail')
})

test('marks only a configured multivariate outlier frame while rejecting the stack', () => {
	const frames = asSequence([0, 1, 2, 3, 4, 5, 6].map((index) => completeFrame(index, { signal: index === 3 ? 1400 : 1000 })))
	const result = analyzeFlatSequence(
		{ frames },
		{
			analysis: FRAME_ANALYSIS,
			temperatureTolerance: 0.5,
			outlierSigma: 3,
		},
	)

	expect(result.planes[0].outliers).toEqual([3])
	expect(result.frames[3]).toMatchObject({ index: 3, id: 'flat-3', status: 'rejected', reasons: ['sequenceOutlier'] })
	expect(result.frames.filter((frame) => frame.index !== 3).every((frame) => frame.status === 'accepted')).toBeTrue()
	expect(result.assessment.frameQuality.status).toBe('fail')
	expect(result.assessment.verdict).toBe('rejected')
})

test('keeps per-second drift unknown for missing or non-monotonic timestamps', () => {
	const missing = [completeFrame(0), completeFrame(1, {}, { timestamp: undefined }), completeFrame(2)] as const
	const missingResult = analyzeFlatSequence({ frames: missing }, sequenceOptions({ maximumSignalVariation: undefined, maximumSpatialVariation: undefined, maximumProfileVariation: undefined, maximumDriftPerFrame: undefined }))
	expect(missingResult.planes[0].driftPerSecond).toBeUndefined()
	expect(missingResult.assessment.signalStability.status).toBe('unknown')
	expect(missingResult.assessment.verdict).toBe('inconclusive')
	expect(missingResult.assessment.reasons).toContain('sequenceMetadataUnknown')

	const nonMonotonic = [completeFrame(0), completeFrame(1), completeFrame(2, {}, { timestamp: 1_000_500 })] as const
	const nonMonotonicResult = analyzeFlatSequence({ frames: nonMonotonic }, sequenceOptions({ maximumSignalVariation: undefined, maximumSpatialVariation: undefined, maximumProfileVariation: undefined, maximumDriftPerFrame: undefined }))
	expect(nonMonotonicResult.planes[0].driftPerSecond).toBeUndefined()
	expect(nonMonotonicResult.assessment.verdict).toBe('inconclusive')

	const overflowing = [completeFrame(0, {}, { timestamp: -Number.MAX_VALUE }), completeFrame(1, {}, { timestamp: 0 }), completeFrame(2, {}, { timestamp: Number.MAX_VALUE })] as const
	const overflowingResult = analyzeFlatSequence({ frames: overflowing }, sequenceOptions({ maximumSignalVariation: undefined, maximumSpatialVariation: undefined, maximumProfileVariation: undefined, maximumDriftPerFrame: undefined }))
	expect(overflowingResult.planes[0].driftPerSecond).toBeUndefined()
	expect(overflowingResult.assessment.verdict).toBe('inconclusive')
})

test('throws on known heterogeneous metadata and reports absent compatibility metadata', () => {
	const base = completeFrame(0)
	const wrongExposure = completeFrame(1, {}, { exposure: 1.1 })
	const last = completeFrame(2)
	expect(() => analyzeFlatSequence({ frames: [base, wrongExposure, last] }, { exposureTolerance: 0.01 })).toThrow('exposure')
	expect(() => analyzeFlatSequence({ frames: [base, completeFrame(1, {}, { filter: 'R' }), last] })).toThrow('filter')
	expect(() => analyzeFlatSequence({ frames: [base, completeFrame(1, {}, { operatingPoint: { ...base.operatingPoint!, gain: 200 } }), last] })).toThrow('gain')
	expect(() => analyzeFlatSequence({ frames: [base, completeFrame(1, {}, { operatingPoint: { ...base.operatingPoint!, sensorOrigin: [2, 0] } }), last] })).toThrow('sensor origins')
	const firstWithoutGain = completeFrame(0, {}, { operatingPoint: { offset: 20, temperature: -10, readoutMode: 'low-noise', binning: [1, 1], sensorOrigin: [0, 0] } })
	expect(() => analyzeFlatSequence({ frames: [firstWithoutGain, completeFrame(1), completeFrame(2, {}, { operatingPoint: { ...base.operatingPoint!, gain: 200 } })] })).toThrow('gains')

	const unknownFrames = asSequence([0, 1, 2].map((index) => ({ id: `unknown-${index}`, image: generateSyntheticFlatImage({ width: 32, height: 24, bias: 0, signal: 1000, vignetting: 0 }) })))
	const unknown = analyzeFlatSequence({ frames: unknownFrames }, { maximumSignalVariation: 0 })
	expect(unknown.assessment.verdict).toBe('inconclusive')
	expect(unknown.assessment.reasons).toContain('sequenceMetadataUnknown')
	expect(unknown.diagnostics.some((diagnostic) => diagnostic.code === 'sequenceMetadataUnknown')).toBeTrue()
})

test('keeps a configured outlier check unknown when a frame signature loses support', () => {
	const damaged = completeFrame(1)
	damaged.image.raw.fill(Number.NaN, 0, damaged.image.metadata.width)
	const frames = [completeFrame(0), damaged, completeFrame(2)] as const
	const result = analyzeFlatSequence({ frames }, { temperatureTolerance: 0.5, outlierSigma: 3 })

	expect(result.planes[0].outliers).toEqual([])
	expect(result.assessment.frameQuality.status).toBe('unknown')
	expect(result.assessment.verdict).toBe('inconclusive')
	expect(result.frames.every((frame) => frame.status === 'inconclusive')).toBeTrue()
	expect(result.assessment.reasons).toContain('insufficientSamples')
})

test('keeps unavailable frame signals inconclusive instead of dereferencing sparse signatures', () => {
	const frames = [completeFrame(0, { vignetting: 0 }), completeFrame(1, { signal: 0, vignetting: 0 }), completeFrame(2, { vignetting: 0 })] as const
	const result = analyzeFlatSequence({ frames }, { maximumSignalVariation: 0 })

	expect(result.planes[0].medianSignal).toBe(1000)
	expect(result.planes[0].signalVariation).toBeUndefined()
	expect(result.assessment.signalStability.status).toBe('unknown')
	expect(result.assessment.verdict).toBe('inconclusive')

	const unavailable = analyzeFlatSequence({ frames: [completeFrame(0, { signal: 0 }), completeFrame(1, { signal: 0 }), completeFrame(2, { signal: 0 })] })
	expect(unavailable.planes[0].medianSignal).toBeUndefined()
})

test('rejects map options and undersized runtime tuples before allocating sequence work', () => {
	const frames = [completeFrame(0), completeFrame(1), completeFrame(2)] as const
	expect(() => analyzeFlatSequence({ frames }, { analysis: { maps: 'all' } } as Partial<FlatSequenceOptions>)).toThrow('map options')
	expect(() => analyzeFlatSequence({ frames: frames.slice(0, 2) as unknown as FlatSequenceInput['frames'] })).toThrow('at least three')
})
