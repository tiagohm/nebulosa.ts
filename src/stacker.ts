import { Bitpix, type FitsHeader } from './fits'
import { bitpixInBytes } from './fits.util'
import type { Rect, Size } from './geometry'
import type { Image, ImageRawType, SigmaClipCenterMethod, SigmaClipDispersionMethod } from './image.types'
import { clamp } from './math'
import type { DetectedStar } from './star.detector'
import { type AffineTransform, invertTransform, matchStars, type SimilarityTransform, type StarMatchingConfig, type StarMatchingResult } from './star.matching'
import { meanOf, medianAbsoluteDeviationOf, medianOf } from './util'

export type StackingCombinationMethod = 'sum' | 'average' | 'weighted-average' | 'median' | 'sigma-clip' | 'min-max-average' | 'winsorized-mean' | 'percentile-clip-average'

export type StackingInterpolationMode = 'nearest' | 'bilinear'

export type StackingCropMode = 'union' | 'intersection'

export type StackingNormalizationMode = 'none' | 'scale' | 'background-scale' | 'percentile'

export type StackingWeightingMode = 'none' | 'snr' | 'inverse-hfd' | 'stars' | 'quality'

export type StackingColorHandlingMode = 'per-channel' | 'luminance'

export type BatchReferenceSelectionMode = 'first-accepted' | 'best-quality' | 'index'

export type FrameRejectionReason = 'combination-method-not-supported-in-live-mode' | 'invalid-image-shape' | 'channel-mismatch' | 'too-few-stars' | 'reference-has-no-stars' | 'match-failed' | 'invalid-transform' | 'transform-error-too-high' | 'transform-out-of-bounds' | 'no-overlap' | 'insufficient-overlap'

export interface StackingFrame {
	readonly image: Image
	readonly stars: readonly DetectedStar[]
	readonly id?: string | number
	readonly weight?: number
}

export interface BatchReferenceSelection {
	readonly mode?: BatchReferenceSelectionMode
	readonly index?: number
}

export interface SigmaClipStackingOptions {
	readonly sigmaLower?: number
	readonly sigmaUpper?: number
	readonly maxIterations?: number
	readonly centerMethod?: SigmaClipCenterMethod
	readonly dispersionMethod?: SigmaClipDispersionMethod
}

export interface MinMaxRejectionOptions {
	readonly low?: number
	readonly high?: number
}

export interface PercentileRangeOptions {
	readonly lower?: number
	readonly upper?: number
}

export interface StackingTransformSummary {
	readonly model: 'identity' | 'similarity' | 'affine'
	readonly translationX: number
	readonly translationY: number
	readonly scaleX: number
	readonly scaleY: number
	readonly rotation: number
	readonly shear: number
	readonly mirrored: boolean
	readonly inlierCount: number
	readonly rmsError: number
}

export interface StackingFrameQualityMetrics {
	readonly starCount: number
	readonly medianSNR: number
	readonly medianHFD: number
	readonly qualityScore: number
	readonly estimatedBackground: number
}

export interface FrameNormalizationSummary {
	readonly scales: readonly number[]
	readonly offsets: readonly number[]
	readonly weight: number
}

export interface FrameAcceptanceResult {
	readonly accepted: boolean
	readonly frameIndex: number
	readonly frameId?: string | number
	readonly reason?: FrameRejectionReason | string
	readonly transform?: StackingTransformSummary
	readonly overlapFraction: number
	readonly quality: StackingFrameQualityMetrics
	readonly normalization?: FrameNormalizationSummary
}

export interface StackBounds extends Readonly<Rect>, Readonly<Size> {}

export interface StackCombinationStatisticsSummary {
	readonly method: StackingCombinationMethod
	readonly normalizationMode: StackingNormalizationMode
	readonly weightingMode: StackingWeightingMode
	readonly liveExact: boolean
	readonly acceptedWeightSum: number
	readonly minimumCoverage: number
}

export interface StackResult {
	readonly finalImage?: Image
	readonly acceptedFrames: number
	readonly rejectedFrames: number
	readonly referenceFrameIndex: number
	readonly effectiveCropBounds?: StackBounds
	readonly diagnostics: readonly FrameAcceptanceResult[]
	readonly statistics: StackCombinationStatisticsSummary
	readonly coverageMap?: Uint32Array
	readonly validityMask?: Uint8Array
}

export interface StackingOptions {
	readonly combinationMethod?: StackingCombinationMethod
	readonly batchReference?: BatchReferenceSelection
	readonly interpolationMode?: StackingInterpolationMode
	readonly sigmaClip?: SigmaClipStackingOptions
	readonly minMaxRejection?: MinMaxRejectionOptions
	readonly winsorization?: PercentileRangeOptions
	readonly percentileClip?: PercentileRangeOptions
	readonly minAcceptedStars?: number
	readonly minAcceptedInliers?: number
	readonly maxAcceptedTransformError?: number
	readonly minOverlapFraction?: number
	readonly cropMode?: StackingCropMode
	readonly minimumCoverage?: number
	readonly normalizationMode?: StackingNormalizationMode
	readonly weightingMode?: StackingWeightingMode
	readonly colorHandlingMode?: StackingColorHandlingMode
	readonly keepPerPixelStatistics?: boolean
	readonly allowStarlessReference?: boolean
	readonly maxTranslation?: number
	readonly maxRotation?: number
	readonly minScale?: number
	readonly maxScale?: number
	readonly maxShear?: number
	readonly samplePrecision?: 32 | 64
	readonly matchStarsConfig?: StarMatchingConfig
}

interface ResolvedStackingOptions extends Required<Omit<StackingOptions, 'sigmaClip' | 'minMaxRejection' | 'winsorization' | 'percentileClip' | 'batchReference' | 'matchStarsConfig'>> {
	readonly sigmaClip: Required<SigmaClipStackingOptions>
	readonly minMaxRejection: Required<MinMaxRejectionOptions>
	readonly winsorization: Required<PercentileRangeOptions>
	readonly percentileClip: Required<PercentileRangeOptions>
	readonly batchReference: Required<BatchReferenceSelection>
	readonly matchStarsConfig: StarMatchingConfig
}

interface ResolvedTransform {
	readonly m00: number
	readonly m01: number
	readonly tx: number
	readonly m10: number
	readonly m11: number
	readonly ty: number
	readonly summary: StackingTransformSummary
}

interface AlignedFrame {
	readonly raw: ImageRawType
	readonly valid: Uint8Array
	readonly weight: number
	readonly index: number
	readonly id?: string | number
	readonly quality: StackingFrameQualityMetrics
	readonly normalization: FrameNormalizationSummary
	readonly transform: StackingTransformSummary
}

const DEFAULT_STACKING_OPTIONS: ResolvedStackingOptions = {
	combinationMethod: 'average',
	batchReference: { mode: 'first-accepted', index: 0 },
	interpolationMode: 'bilinear',
	sigmaClip: {
		sigmaLower: 3,
		sigmaUpper: 3,
		maxIterations: 3,
		centerMethod: 'median',
		dispersionMethod: 'mad',
	},
	minMaxRejection: { low: 1, high: 1 },
	winsorization: { lower: 0.1, upper: 0.9 },
	percentileClip: { lower: 0.1, upper: 0.9 },
	minAcceptedStars: 6,
	minAcceptedInliers: 6,
	maxAcceptedTransformError: 2.5,
	minOverlapFraction: 0.1,
	cropMode: 'union',
	minimumCoverage: 0,
	normalizationMode: 'background-scale',
	weightingMode: 'none',
	colorHandlingMode: 'per-channel',
	keepPerPixelStatistics: true,
	allowStarlessReference: true,
	maxTranslation: Infinity,
	maxRotation: Infinity,
	minScale: 0.5,
	maxScale: 2,
	maxShear: 0.5,
	samplePrecision: 32,
	matchStarsConfig: {},
}

const FLOAT_EPSILON = 1e-12
const BACKGROUND_SAMPLE_LIMIT = 1024
const NORMALIZATION_SAMPLE_LIMIT = 8192

// Resolves caller overrides into deterministic internal defaults.
function resolveStackingOptions(options: StackingOptions = {}): ResolvedStackingOptions {
	return {
		...DEFAULT_STACKING_OPTIONS,
		...options,
		batchReference: {
			...DEFAULT_STACKING_OPTIONS.batchReference,
			...options.batchReference,
			mode: options.batchReference?.mode ?? DEFAULT_STACKING_OPTIONS.batchReference.mode,
			index: Math.max(0, Math.trunc(options.batchReference?.index ?? DEFAULT_STACKING_OPTIONS.batchReference.index)),
		},
		sigmaClip: {
			...DEFAULT_STACKING_OPTIONS.sigmaClip,
			...options.sigmaClip,
			sigmaLower: Math.max(0, options.sigmaClip?.sigmaLower ?? DEFAULT_STACKING_OPTIONS.sigmaClip.sigmaLower),
			sigmaUpper: Math.max(0, options.sigmaClip?.sigmaUpper ?? DEFAULT_STACKING_OPTIONS.sigmaClip.sigmaUpper),
			maxIterations: Math.max(1, Math.trunc(options.sigmaClip?.maxIterations ?? DEFAULT_STACKING_OPTIONS.sigmaClip.maxIterations)),
		},
		minMaxRejection: {
			low: Math.max(0, Math.trunc(options.minMaxRejection?.low ?? DEFAULT_STACKING_OPTIONS.minMaxRejection.low)),
			high: Math.max(0, Math.trunc(options.minMaxRejection?.high ?? DEFAULT_STACKING_OPTIONS.minMaxRejection.high)),
		},
		winsorization: {
			lower: clamp(options.winsorization?.lower ?? DEFAULT_STACKING_OPTIONS.winsorization.lower, 0, 1),
			upper: clamp(options.winsorization?.upper ?? DEFAULT_STACKING_OPTIONS.winsorization.upper, 0, 1),
		},
		percentileClip: {
			lower: clamp(options.percentileClip?.lower ?? DEFAULT_STACKING_OPTIONS.percentileClip.lower, 0, 1),
			upper: clamp(options.percentileClip?.upper ?? DEFAULT_STACKING_OPTIONS.percentileClip.upper, 0, 1),
		},
		minAcceptedStars: Math.max(0, Math.trunc(options.minAcceptedStars ?? DEFAULT_STACKING_OPTIONS.minAcceptedStars)),
		minAcceptedInliers: Math.max(0, Math.trunc(options.minAcceptedInliers ?? DEFAULT_STACKING_OPTIONS.minAcceptedInliers)),
		maxAcceptedTransformError: Math.max(0, options.maxAcceptedTransformError ?? DEFAULT_STACKING_OPTIONS.maxAcceptedTransformError),
		minOverlapFraction: clamp(options.minOverlapFraction ?? DEFAULT_STACKING_OPTIONS.minOverlapFraction, 0, 1),
		minimumCoverage: clamp(options.minimumCoverage ?? DEFAULT_STACKING_OPTIONS.minimumCoverage, 0, 1),
		maxTranslation: Math.max(0, options.maxTranslation ?? DEFAULT_STACKING_OPTIONS.maxTranslation),
		maxRotation: Math.max(0, options.maxRotation ?? DEFAULT_STACKING_OPTIONS.maxRotation),
		minScale: Math.max(FLOAT_EPSILON, options.minScale ?? DEFAULT_STACKING_OPTIONS.minScale),
		maxScale: Math.max(FLOAT_EPSILON, options.maxScale ?? DEFAULT_STACKING_OPTIONS.maxScale),
		maxShear: Math.max(0, options.maxShear ?? DEFAULT_STACKING_OPTIONS.maxShear),
		samplePrecision: options.samplePrecision ?? DEFAULT_STACKING_OPTIONS.samplePrecision,
		matchStarsConfig: { ...DEFAULT_STACKING_OPTIONS.matchStarsConfig, ...options.matchStarsConfig },
	}
}

// Checks whether the selected combination method has an exact online path.
export function isLiveCombinationMethodSupported(method: StackingCombinationMethod) {
	return method === 'sum' || method === 'average' || method === 'weighted-average'
}

// Implements live stacking and exposes a batch helper through the same API surface.
export class LiveStacker {
	private options: ResolvedStackingOptions = DEFAULT_STACKING_OPTIONS
	private referenceFrame?: StackingFrame
	private referenceIndex = -1
	private diagnostics: FrameAcceptanceResult[] = []
	private acceptedFrames = 0
	private rejectedFrames = 0
	private sum?: Float64Array
	private weightSum?: Float64Array
	private coverageMap?: Uint32Array
	private workRaw?: ImageRawType
	private workMask?: Uint8Array

	constructor(options: StackingOptions = {}) {
		this.initialize(options)
	}

	// Initializes or reinitializes the live stacker state.
	initialize(options: StackingOptions = {}) {
		this.options = resolveStackingOptions(options)
		this.reset()
	}

	// Clears the live stacking state.
	reset() {
		this.referenceFrame = undefined
		this.referenceIndex = -1
		this.diagnostics = []
		this.acceptedFrames = 0
		this.rejectedFrames = 0
		this.sum = undefined
		this.weightSum = undefined
		this.coverageMap = undefined
		this.workRaw = undefined
		this.workMask = undefined
	}

	// Adds a single frame to the live stack when the method supports exact incremental updates.
	add(frame: StackingFrame): FrameAcceptanceResult {
		const frameIndex = this.diagnostics.length
		const quality = computeFrameQuality(frame)

		if (!isImageShapeValid(frame.image)) return this.reject(frameIndex, frame, quality, 'invalid-image-shape')
		if (!isLiveCombinationMethodSupported(this.options.combinationMethod)) return this.reject(frameIndex, frame, quality, 'combination-method-not-supported-in-live-mode')

		if (this.referenceFrame === undefined) {
			if (!this.options.allowStarlessReference && frame.stars.length < this.options.minAcceptedStars) return this.reject(frameIndex, frame, quality, 'too-few-stars')
			this.acceptReferenceFrame(frame, frameIndex, quality)

			const accepted: FrameAcceptanceResult = {
				accepted: true,
				frameIndex,
				frameId: frame.id,
				overlapFraction: 1,
				quality,
				transform: identityTransformSummary(),
				normalization: { scales: channelArray(frame.image.metadata.channels, 1), offsets: channelArray(frame.image.metadata.channels, 0), weight: resolveFrameWeight(frame, quality, this.options) },
			}

			this.diagnostics.push(accepted)

			return accepted
		}

		if (frame.image.metadata.channels !== this.referenceFrame.image.metadata.channels) return this.reject(frameIndex, frame, quality, 'channel-mismatch')
		if (frame.stars.length < this.options.minAcceptedStars) return this.reject(frameIndex, frame, quality, 'too-few-stars')
		if (this.referenceFrame.stars.length < this.options.minAcceptedStars) return this.reject(frameIndex, frame, quality, 'reference-has-no-stars')

		const matched = matchStars(this.referenceFrame.stars, frame.stars, this.options.matchStarsConfig)
		if (!matched.success || matched.inlierCount < this.options.minAcceptedInliers) return this.reject(frameIndex, frame, quality, 'match-failed')
		if ((matched.rmsError ?? Infinity) > this.options.maxAcceptedTransformError) return this.reject(frameIndex, frame, quality, 'transform-error-too-high')

		const transform = resolveTransform(matched)
		if (transform === undefined) return this.reject(frameIndex, frame, quality, 'invalid-transform')
		if (!transformWithinBounds(transform.summary, this.options)) return this.reject(frameIndex, frame, quality, 'transform-out-of-bounds')

		const inverse = invertTransform(matched.model === 'affine' ? matched.affine! : matched.similarity!)
		if (inverse === undefined) return this.reject(frameIndex, frame, quality, 'invalid-transform')

		this.ensureWorkBuffers(this.referenceFrame.image.metadata.pixelCount * this.referenceFrame.image.metadata.channels)
		alignIntoReference(frame.image, inverse, this.referenceFrame.image.metadata.width, this.referenceFrame.image.metadata.height, this.options.interpolationMode, this.workRaw!, this.workMask!)
		const overlapFraction = computeOverlapFraction(this.workMask!)
		if (overlapFraction <= 0) return this.reject(frameIndex, frame, quality, 'no-overlap')
		if (overlapFraction < this.options.minOverlapFraction) return this.reject(frameIndex, frame, quality, 'insufficient-overlap')

		const normalization = computeNormalization(this.workRaw!, this.workMask!, frame, this.referenceFrame, quality, this.options)
		applyNormalizationInPlace(this.workRaw!, this.workMask!, frame.image.metadata.channels, normalization.scales, normalization.offsets)
		accumulateAlignedFrame(this.referenceFrame.image.metadata.channels, this.workRaw!, this.workMask!, this.sum!, this.weightSum!, this.coverageMap!, this.options.combinationMethod, normalization.weight)

		this.acceptedFrames++

		const accepted: FrameAcceptanceResult = {
			accepted: true,
			frameIndex,
			frameId: frame.id,
			overlapFraction,
			quality,
			transform: transform.summary,
			normalization,
		}

		this.diagnostics.push(accepted)

		return accepted
	}

	// Returns the current live stacking result without mutating the stack.
	snapshot(): StackResult | undefined {
		if (this.referenceFrame === undefined || this.sum === undefined || this.weightSum === undefined || this.coverageMap === undefined) return undefined
		return buildOnlineResult(this.referenceFrame, this.referenceIndex, this.acceptedFrames, this.rejectedFrames, this.diagnostics, this.options, this.sum, this.weightSum, this.coverageMap)
	}

	// Initializes the live stack with the first accepted reference frame.
	private acceptReferenceFrame(frame: StackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics) {
		const { channels, pixelCount } = frame.image.metadata
		this.referenceFrame = frame
		this.referenceIndex = frameIndex
		this.acceptedFrames = 1
		this.sum = new Float64Array(pixelCount * channels)
		this.weightSum = new Float64Array(pixelCount)
		this.coverageMap = new Uint32Array(pixelCount)
		this.workRaw = undefined
		this.workMask = undefined
		const weight = resolveFrameWeight(frame, quality, this.options)
		accumulateAlignedFrame(channels, frame.image.raw, fullMask(pixelCount), this.sum, this.weightSum, this.coverageMap, this.options.combinationMethod, weight)
	}

	// Records a structured rejection result.
	private reject(frameIndex: number, frame: StackingFrame, quality: StackingFrameQualityMetrics, reason: FrameRejectionReason): FrameAcceptanceResult {
		this.rejectedFrames++
		const result: FrameAcceptanceResult = { accepted: false, frameIndex, frameId: frame.id, overlapFraction: 0, quality, reason }
		this.diagnostics.push(result)
		return result
	}

	// Reuses alignment working buffers between live add calls.
	private ensureWorkBuffers(length: number) {
		const ImageType = this.options.samplePrecision === 64 ? Float64Array : Float32Array
		if (this.workRaw === undefined || this.workRaw.length !== length) this.workRaw = new ImageType(length)
		if (this.workMask === undefined || this.workMask.length !== length / (this.referenceFrame?.image.metadata.channels ?? 1)) this.workMask = new Uint8Array(length / (this.referenceFrame?.image.metadata.channels ?? 1))
	}
}

// Executes a full batch stack with deterministic diagnostics.
export function stackFrames(frames: readonly StackingFrame[], options: StackingOptions = {}): StackResult {
	const resolved = resolveStackingOptions(options)
	if (frames.length === 0) return emptyStackResult(resolved, -1, [])
	const qualities = frames.map(computeFrameQuality)
	const referenceIndex = selectReferenceFrameIndex(frames, qualities, resolved)
	const referenceFrame = frames[referenceIndex]

	if (!isImageShapeValid(referenceFrame.image)) {
		return emptyStackResult(resolved, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 0, quality: qualities[referenceIndex], reason: 'invalid-image-shape' }])
	}

	const accepted: AlignedFrame[] = []
	const diagnostics: FrameAcceptanceResult[] = []
	const pixelCount = referenceFrame.image.metadata.pixelCount
	const channels = referenceFrame.image.metadata.channels
	const coverageMap = new Uint32Array(pixelCount)
	const sum = new Float64Array(pixelCount * channels)
	const weightSum = new Float64Array(pixelCount)
	const referenceWeight = resolveFrameWeight(referenceFrame, qualities[referenceIndex], resolved)
	const referenceNormalization = { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight: referenceWeight }

	const referenceAligned = makeAlignedReference(referenceFrame, referenceIndex, qualities[referenceIndex], referenceNormalization, sum, weightSum, resolved.combinationMethod)
	accepted.push(referenceAligned)

	incrementCoverage(coverageMap, referenceAligned.valid)
	diagnostics.push({ accepted: true, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 1, quality: qualities[referenceIndex], transform: identityTransformSummary(), normalization: referenceNormalization })

	for (let i = 0; i < frames.length; i++) {
		if (i === referenceIndex) continue

		const frame = frames[i]
		const quality = qualities[i]

		if (!isImageShapeValid(frame.image)) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'invalid-image-shape' })
			continue
		}

		if (frame.image.metadata.channels !== channels) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'channel-mismatch' })
			continue
		}

		if (frame.stars.length < resolved.minAcceptedStars) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'too-few-stars' })
			continue
		}

		if (referenceFrame.stars.length < resolved.minAcceptedStars) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'reference-has-no-stars' })
			continue
		}

		const matched = matchStars(referenceFrame.stars, frame.stars, resolved.matchStarsConfig)

		if (!matched.success || matched.inlierCount < resolved.minAcceptedInliers) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'match-failed' })
			continue
		}

		if ((matched.rmsError ?? Infinity) > resolved.maxAcceptedTransformError) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'transform-error-too-high' })
			continue
		}

		const transform = resolveTransform(matched)

		if (transform === undefined) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'invalid-transform' })
			continue
		}

		if (!transformWithinBounds(transform.summary, resolved)) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'transform-out-of-bounds' })
			continue
		}

		const inverse = invertTransform(matched.model === 'affine' ? matched.affine! : matched.similarity!)

		if (inverse === undefined) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'invalid-transform' })
			continue
		}

		const aligned = createAlignedFrame(frame, i, quality, referenceFrame, inverse, resolved, transform.summary)
		const overlapFraction = computeOverlapFraction(aligned.valid)

		if (overlapFraction <= 0) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'no-overlap' })
			continue
		}

		if (overlapFraction < resolved.minOverlapFraction) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction, quality, reason: 'insufficient-overlap', transform: transform.summary })
			continue
		}

		accepted.push(aligned)
		incrementCoverage(coverageMap, aligned.valid)

		if (resolved.combinationMethod === 'sum' || resolved.combinationMethod === 'average' || resolved.combinationMethod === 'weighted-average') {
			accumulateAlignedFrame(channels, aligned.raw, aligned.valid, sum, weightSum, new Uint32Array(pixelCount), resolved.combinationMethod, aligned.weight)
		}

		diagnostics.push({ accepted: true, frameIndex: i, frameId: frame.id, overlapFraction, quality, transform: transform.summary, normalization: aligned.normalization })
	}

	const finalized = resolved.combinationMethod === 'sum' || resolved.combinationMethod === 'average' || resolved.combinationMethod === 'weighted-average' ? finalizeOnlineImage(referenceFrame, resolved, sum, weightSum, coverageMap, accepted.length) : finalizeBatchImage(referenceFrame, resolved, accepted, coverageMap)
	const cropBounds = computeEffectiveCropBounds(referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, coverageMap, accepted.length, resolved)

	return {
		finalImage: finalized.image,
		acceptedFrames: accepted.length,
		rejectedFrames: frames.length - accepted.length,
		referenceFrameIndex: referenceIndex,
		effectiveCropBounds: cropBounds,
		diagnostics,
		statistics: {
			method: resolved.combinationMethod,
			normalizationMode: resolved.normalizationMode,
			weightingMode: resolved.weightingMode,
			liveExact: isLiveCombinationMethodSupported(resolved.combinationMethod),
			acceptedWeightSum: accepted.reduce((total, item) => total + item.weight, 0),
			minimumCoverage: resolved.cropMode === 'intersection' ? 1 : resolved.minimumCoverage,
		},
		coverageMap: resolved.keepPerPixelStatistics ? coverageMap : undefined,
		validityMask: buildValidityMask(coverageMap, accepted.length, resolved, referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, cropBounds),
	}
}

// Computes deterministic frame quality metrics from stars and coarse image background.
function computeFrameQuality(frame: StackingFrame): StackingFrameQualityMetrics {
	const starCount = frame.stars.length
	const snr = new Float64Array(starCount)
	const hfd = new Float64Array(starCount)

	for (let i = 0; i < starCount; i++) {
		snr[i] = frame.stars[i].snr
		hfd[i] = frame.stars[i].hfd
	}

	snr.sort()
	hfd.sort()

	const medianSNR = starCount > 0 ? medianOf(snr) : 0
	const medianHFD = starCount > 0 ? medianOf(hfd) : Infinity
	const estimatedBackground = estimateImageBackground(frame.image)
	const qualityScore = starCount > 0 ? clamp((Math.sqrt(starCount) * Math.max(medianSNR, 1)) / Math.max(medianHFD, 0.5), 0, 1e6) : 0

	return { starCount, medianSNR, medianHFD, qualityScore, estimatedBackground }
}

// Estimates a coarse image background from a sparse raw sample.
function estimateImageBackground(image: Image) {
	const sample = sampleImageValues(image.raw, image.metadata.channels, image.metadata.width, image.metadata.height, BACKGROUND_SAMPLE_LIMIT, true)
	return sample.length === 0 ? 0 : medianOf(sample.sort())
}

// Selects the reference frame according to the configured batch strategy.
function selectReferenceFrameIndex(frames: readonly StackingFrame[], qualities: readonly StackingFrameQualityMetrics[], options: ResolvedStackingOptions) {
	if (options.batchReference.mode === 'index') {
		if (options.batchReference.index < 0 || options.batchReference.index >= frames.length) throw new RangeError(`reference frame index ${options.batchReference.index} is out of range for ${frames.length} frames`)
		return options.batchReference.index
	}

	if (options.batchReference.mode === 'best-quality') {
		let bestIndex = -1
		let bestScore = -Infinity

		for (let i = 0; i < frames.length; i++) {
			if (!isImageShapeValid(frames[i].image)) continue
			if (!options.allowStarlessReference && qualities[i].starCount < options.minAcceptedStars) continue

			const quality = qualities[i]
			const starPenalty = quality.starCount >= options.minAcceptedStars ? 1 : 0.25
			const score = quality.qualityScore * starPenalty - quality.estimatedBackground

			if (score > bestScore) {
				bestScore = score
				bestIndex = i
			}
		}

		if (bestIndex >= 0) return bestIndex
	}

	for (let i = 0; i < frames.length; i++) {
		if (!isImageShapeValid(frames[i].image)) continue
		if (!options.allowStarlessReference && qualities[i].starCount < options.minAcceptedStars) continue
		return i
	}

	return 0
}

// Creates a stored aligned batch sample for the reference frame.
function makeAlignedReference(frame: StackingFrame, index: number, quality: StackingFrameQualityMetrics, normalization: FrameNormalizationSummary, sum: Float64Array, weightSum: Float64Array, method: StackingCombinationMethod): AlignedFrame {
	const { pixelCount, channels } = frame.image.metadata
	const raw = cloneRaw(frame.image.raw)
	const valid = fullMask(pixelCount)

	if (method === 'sum' || method === 'average' || method === 'weighted-average') {
		accumulateAlignedFrame(channels, raw, valid, sum, weightSum, new Uint32Array(pixelCount), method, normalization.weight)
	}

	return { raw, valid, weight: normalization.weight, index, id: frame.id, quality, normalization, transform: identityTransformSummary() }
}

// Creates an aligned and normalized batch sample against the reference frame grid.
function createAlignedFrame(frame: StackingFrame, index: number, quality: StackingFrameQualityMetrics, referenceFrame: StackingFrame, inverseTransform: SimilarityTransform | AffineTransform, options: ResolvedStackingOptions, transform: StackingTransformSummary): AlignedFrame {
	const { pixelCount, channels, width, height } = referenceFrame.image.metadata
	const raw = options.samplePrecision === 64 ? new Float64Array(pixelCount * channels) : new Float32Array(pixelCount * channels)
	const valid = new Uint8Array(pixelCount)
	alignIntoReference(frame.image, inverseTransform, width, height, options.interpolationMode, raw, valid)
	const normalization = computeNormalization(raw, valid, frame, referenceFrame, quality, options)
	applyNormalizationInPlace(raw, valid, channels, normalization.scales, normalization.offsets)
	return { raw, valid, weight: normalization.weight, index, id: frame.id, quality, normalization, transform }
}

// Builds the current live result from online accumulators.
function buildOnlineResult(referenceFrame: StackingFrame, referenceIndex: number, acceptedFrames: number, rejectedFrames: number, diagnostics: readonly FrameAcceptanceResult[], options: ResolvedStackingOptions, sum: Float64Array, weightSum: Float64Array, coverageMap: Uint32Array): StackResult {
	const finalized = finalizeOnlineImage(referenceFrame, options, sum, weightSum, coverageMap, acceptedFrames)
	const cropBounds = computeEffectiveCropBounds(referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, coverageMap, acceptedFrames, options)

	return {
		finalImage: finalized.image,
		acceptedFrames,
		rejectedFrames,
		referenceFrameIndex: referenceIndex,
		effectiveCropBounds: cropBounds,
		diagnostics,
		statistics: {
			method: options.combinationMethod,
			normalizationMode: options.normalizationMode,
			weightingMode: options.weightingMode,
			liveExact: true,
			acceptedWeightSum: sumAcceptedWeights(diagnostics),
			minimumCoverage: options.cropMode === 'intersection' ? 1 : options.minimumCoverage,
		},
		coverageMap: options.keepPerPixelStatistics ? coverageMap : undefined,
		validityMask: buildValidityMask(coverageMap, acceptedFrames, options, referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, cropBounds),
	}
}

// Finalizes an online-capable stack from sum and weight buffers.
function finalizeOnlineImage(referenceFrame: StackingFrame, options: ResolvedStackingOptions, sum: Float64Array, weightSum: Float64Array, coverageMap: Uint32Array, acceptedFrames: number) {
	const cropBounds = computeEffectiveCropBounds(referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, coverageMap, acceptedFrames, options)
	const threshold = coverageThreshold(acceptedFrames, options)
	const raw = createLike(referenceFrame.image.raw, referenceFrame.image.metadata.pixelCount * referenceFrame.image.metadata.channels)

	for (let pixel = 0; pixel < referenceFrame.image.metadata.pixelCount; pixel++) {
		if (coverageMap[pixel] < threshold) continue
		const denominator = options.combinationMethod === 'sum' ? 1 : weightSum[pixel]
		if (!(denominator > 0)) continue
		const base = pixel * referenceFrame.image.metadata.channels
		for (let channel = 0; channel < referenceFrame.image.metadata.channels; channel++) raw[base + channel] = sum[base + channel] / denominator
	}

	return { image: maybeCropImage(referenceFrame.image, raw, cropBounds, options) }
}

// Finalizes a sample-based batch method.
function finalizeBatchImage(referenceFrame: StackingFrame, options: ResolvedStackingOptions, accepted: readonly AlignedFrame[], coverageMap: Uint32Array) {
	const cropBounds = computeEffectiveCropBounds(referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, coverageMap, accepted.length, options)
	const threshold = coverageThreshold(accepted.length, options)
	const raw = createLike(referenceFrame.image.raw, referenceFrame.image.metadata.pixelCount * referenceFrame.image.metadata.channels)
	const values = new Float64Array(accepted.length)
	const weights = new Float64Array(accepted.length)

	for (let pixel = 0; pixel < referenceFrame.image.metadata.pixelCount; pixel++) {
		if (coverageMap[pixel] < threshold) continue
		const base = pixel * referenceFrame.image.metadata.channels
		for (let channel = 0; channel < referenceFrame.image.metadata.channels; channel++) {
			let used = 0
			for (let i = 0; i < accepted.length; i++) {
				if (accepted[i].valid[pixel] === 0) continue
				values[used] = accepted[i].raw[base + channel]
				weights[used] = accepted[i].weight
				used++
			}
			if (used === 0) continue
			raw[base + channel] = combineValues(options.combinationMethod, values, weights, used, options)
		}
	}

	return { image: maybeCropImage(referenceFrame.image, raw, cropBounds, options) }
}

// Combines one per-pixel sample vector according to the selected method.
function combineValues(method: StackingCombinationMethod, values: Float64Array, weights: Float64Array, count: number, options: ResolvedStackingOptions) {
	const sorted = values.subarray(0, count)
	const sortedWeights = weights.subarray(0, count)

	switch (method) {
		case 'sum': {
			let sum = 0
			for (let i = 0; i < count; i++) sum += sorted[i]
			return sum
		}
		case 'average': {
			let sum = 0
			for (let i = 0; i < count; i++) sum += sorted[i]
			return sum / count
		}
		case 'weighted-average': {
			let weighted = 0
			let weightSum = 0

			for (let i = 0; i < count; i++) {
				weighted += sorted[i] * sortedWeights[i]
				weightSum += sortedWeights[i]
			}

			return weightSum > 0 ? weighted / weightSum : 0
		}
		case 'median':
			sorted.sort()
			return medianOf(sorted, count)
		case 'min-max-average':
			sorted.sort()
			return combineMinMaxAverage(sorted, count, options.minMaxRejection.low, options.minMaxRejection.high)
		case 'winsorized-mean':
			sorted.sort()
			return combineWinsorizedMean(sorted, count, options.winsorization.lower, options.winsorization.upper)
		case 'percentile-clip-average':
			sorted.sort()
			return combinePercentileClipAverage(sorted, count, options.percentileClip.lower, options.percentileClip.upper)
		case 'sigma-clip':
			sorted.sort()
			return combineSigmaClip(sorted, count, options.sigmaClip)
	}
}

// Computes a deterministic min/max rejection average.
function combineMinMaxAverage(values: Float64Array, count: number, lowReject: number, highReject: number) {
	const start = Math.min(lowReject, Math.max(0, count - 1))
	const end = Math.max(start, count - Math.min(highReject, Math.max(0, count - start - 1)))
	if (end <= start) return meanOf(values.subarray(0, count))
	let sum = 0
	for (let i = start; i < end; i++) sum += values[i]
	return sum / (end - start)
}

// Computes a winsorized mean with percentile clamping.
function combineWinsorizedMean(values: Float64Array, count: number, lower: number, upper: number) {
	if (count <= 2) return meanOf(values.subarray(0, count))
	const low = percentileSorted(values, count, lower)
	const high = percentileSorted(values, count, Math.max(lower, upper))
	let sum = 0
	for (let i = 0; i < count; i++) sum += clamp(values[i], low, high)
	return sum / count
}

// Computes a percentile-clipped average.
function combinePercentileClipAverage(values: Float64Array, count: number, lower: number, upper: number) {
	if (count <= 2) return meanOf(values.subarray(0, count))
	const low = percentileSorted(values, count, lower)
	const high = percentileSorted(values, count, Math.max(lower, upper))
	let sum = 0
	let kept = 0

	for (let i = 0; i < count; i++) {
		const value = values[i]
		if (value < low || value > high) continue
		sum += value
		kept++
	}

	return kept > 0 ? sum / kept : meanOf(values.subarray(0, count))
}

// Computes a conservative sigma-clipped average for one sample vector.
function combineSigmaClip(values: Float64Array, count: number, options: Required<SigmaClipStackingOptions>) {
	if (count <= 2) return meanOf(values.subarray(0, count))
	const scratch = new Float64Array(count)
	scratch.set(values.subarray(0, count))
	let active = count

	for (let iteration = 0; iteration < options.maxIterations; iteration++) {
		const sorted = scratch.subarray(0, active)
		sorted.sort()
		const center = options.centerMethod === 'mean' ? meanOf(sorted) : medianOf(sorted, active)
		let sigma = 0

		if (options.dispersionMethod === 'std') {
			let sumSq = 0

			for (let i = 0; i < active; i++) {
				const delta = sorted[i] - center
				sumSq += delta * delta
			}

			sigma = Math.sqrt(sumSq / active)
		} else {
			sigma = medianAbsoluteDeviationOf(sorted, center, true, active)
		}

		if (!(sigma > 0)) return center

		const low = center - options.sigmaLower * sigma
		const high = center + options.sigmaUpper * sigma
		let kept = 0

		for (let i = 0; i < active; i++) if (sorted[i] >= low && sorted[i] <= high) scratch[kept++] = sorted[i]

		if (kept === 0) return center
		if (kept === active) return meanOf(sorted)

		active = kept
	}

	return meanOf(scratch.subarray(0, active))
}

// Computes normalization parameters from overlap samples against the reference frame.
function computeNormalization(alignedRaw: ImageRawType, valid: Uint8Array, frame: StackingFrame, referenceFrame: StackingFrame, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions): FrameNormalizationSummary {
	const weight = resolveFrameWeight(frame, quality, options)
	const channels = referenceFrame.image.metadata.channels
	if (options.normalizationMode === 'none') return { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight }

	const overlap = collectNormalizationSamples(alignedRaw, valid, referenceFrame.image.raw, channels, referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, options.colorHandlingMode)
	if (overlap.reference.length === 0 || overlap.current.length === 0) return { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight }

	if (options.colorHandlingMode === 'luminance' && channels === 3) {
		const parameters = solveNormalization(overlap.reference[0], overlap.current[0], options.normalizationMode)
		return { scales: channelArray(channels, parameters.scale), offsets: channelArray(channels, parameters.offset), weight }
	}

	const scales = new Array<number>(channels)
	const offsets = new Array<number>(channels)

	for (let channel = 0; channel < channels; channel++) {
		const parameters = solveNormalization(overlap.reference[channel], overlap.current[channel], options.normalizationMode)
		scales[channel] = parameters.scale
		offsets[channel] = parameters.offset
	}

	return { scales, offsets, weight }
}

// Collects overlap samples for robust normalization.
function collectNormalizationSamples(alignedRaw: ImageRawType, valid: Uint8Array, referenceRaw: ImageRawType, channels: number, width: number, height: number, colorMode: StackingColorHandlingMode) {
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / NORMALIZATION_SAMPLE_LIMIT)))
	const current: number[][] = colorMode === 'luminance' && channels === 3 ? [[]] : new Array<number[]>(channels)
	const reference: number[][] = colorMode === 'luminance' && channels === 3 ? [[]] : new Array<number[]>(channels)

	if (!(colorMode === 'luminance' && channels === 3)) {
		for (let channel = 0; channel < channels; channel++) {
			current[channel] = []
			reference[channel] = []
		}
	}

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const pixel = y * width + x
			if (valid[pixel] === 0) continue
			const base = pixel * channels

			if (colorMode === 'luminance' && channels === 3) {
				const currentLum = 0.2125 * alignedRaw[base] + 0.7154 * alignedRaw[base + 1] + 0.0721 * alignedRaw[base + 2]
				const referenceLum = 0.2125 * referenceRaw[base] + 0.7154 * referenceRaw[base + 1] + 0.0721 * referenceRaw[base + 2]
				current[0].push(currentLum)
				reference[0].push(referenceLum)
			} else {
				for (let channel = 0; channel < channels; channel++) {
					current[channel].push(alignedRaw[base + channel])
					reference[channel].push(referenceRaw[base + channel])
				}
			}
		}
	}

	return { current, reference }
}

// Solves a robust linear normalization y = scale * x + offset.
function solveNormalization(reference: readonly number[], current: readonly number[], mode: StackingNormalizationMode) {
	if (reference.length === 0 || current.length === 0) return { scale: 1, offset: 0 }

	const ref = Float64Array.from(reference).sort()
	const cur = Float64Array.from(current).sort()
	const refMedian = medianOf(ref)
	const curMedian = medianOf(cur)

	switch (mode) {
		case 'scale': {
			const scale = Math.abs(curMedian) > FLOAT_EPSILON ? refMedian / curMedian : 1
			return { scale: finiteOr(scale, 1), offset: 0 }
		}
		case 'background-scale': {
			const refBg = percentileSorted(ref, ref.length, 0.25)
			const curBg = percentileSorted(cur, cur.length, 0.25)
			const refSpan = Math.max(percentileSorted(ref, ref.length, 0.75) - refBg, FLOAT_EPSILON)
			const curSpan = Math.max(percentileSorted(cur, cur.length, 0.75) - curBg, FLOAT_EPSILON)
			const scale = refSpan / curSpan
			return { scale: finiteOr(scale, 1), offset: refBg - scale * curBg }
		}
		case 'percentile': {
			const refBg = percentileSorted(ref, ref.length, 0.1)
			const curBg = percentileSorted(cur, cur.length, 0.1)
			const refSpan = Math.max(percentileSorted(ref, ref.length, 0.9) - refBg, FLOAT_EPSILON)
			const curSpan = Math.max(percentileSorted(cur, cur.length, 0.9) - curBg, FLOAT_EPSILON)
			const scale = refSpan / curSpan
			return { scale: finiteOr(scale, 1), offset: refBg - scale * curBg }
		}
		case 'none':
			return { scale: 1, offset: 0 }
	}
}

// Applies per-channel normalization in place on aligned sample data.
function applyNormalizationInPlace(raw: ImageRawType, valid: Uint8Array, channels: number, scales: readonly number[], offsets: readonly number[]) {
	for (let pixel = 0; pixel < valid.length; pixel++) {
		if (valid[pixel] === 0) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) raw[base + channel] = raw[base + channel] * scales[channel] + offsets[channel]
	}
}

// Resolves the deterministic weight attached to one frame.
function resolveFrameWeight(frame: StackingFrame, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions) {
	const base = Math.max(FLOAT_EPSILON, frame.weight ?? 1)

	switch (options.weightingMode) {
		case 'none':
			return base
		case 'snr':
			return base * clamp(Math.max(quality.medianSNR, 1) / 10, 0.25, 4)
		case 'inverse-hfd':
			return base * clamp(2.5 / Math.max(quality.medianHFD, 0.5), 0.25, 4)
		case 'stars':
			return base * clamp(Math.max(quality.starCount, 1) / Math.max(options.minAcceptedStars, 1), 0.25, 4)
		case 'quality':
			return base * clamp((Math.sqrt(Math.max(quality.starCount, 1)) * Math.max(quality.medianSNR, 1)) / Math.max(quality.medianHFD * 10, 1), 0.25, 6)
	}
}

// Converts matchStars output into a generic affine-form transform summary.
function resolveTransform(match: StarMatchingResult): ResolvedTransform | undefined {
	if (!match.success || match.model === undefined) return undefined

	if (match.model === 'similarity' && match.similarity !== undefined) {
		const { a, b, tx, ty, mirrored } = match.similarity
		const scale = Math.hypot(a, b)

		return {
			m00: a,
			m01: mirrored ? b : -b,
			tx,
			m10: b,
			m11: mirrored ? -a : a,
			ty,
			summary: {
				model: 'similarity',
				translationX: tx,
				translationY: ty,
				scaleX: scale,
				scaleY: scale,
				rotation: Math.atan2(b, a),
				shear: 0,
				mirrored,
				inlierCount: match.inlierCount,
				rmsError: match.rmsError ?? Infinity,
			},
		}
	}

	if (match.model === 'affine' && match.affine !== undefined) {
		const { m00, m01, tx, m10, m11, ty } = match.affine
		const scaleX = Math.hypot(m00, m10)
		const scaleY = Math.hypot(m01, m11)
		const shear = Math.abs(m00 * m01 + m10 * m11) / Math.max(scaleX * scaleY, FLOAT_EPSILON)

		return {
			m00,
			m01,
			tx,
			m10,
			m11,
			ty,
			summary: {
				model: 'affine',
				translationX: tx,
				translationY: ty,
				scaleX,
				scaleY,
				rotation: Math.atan2(m10, m00),
				shear,
				mirrored: m00 * m11 - m01 * m10 < 0,
				inlierCount: match.inlierCount,
				rmsError: match.rmsError ?? Infinity,
			},
		}
	}

	return undefined
}

// Verifies transform plausibility against caller limits.
function transformWithinBounds(transform: StackingTransformSummary, options: ResolvedStackingOptions) {
	const translation = Math.hypot(transform.translationX, transform.translationY)
	if (translation > options.maxTranslation) return false
	if (Math.abs(transform.rotation) > options.maxRotation) return false
	if (transform.scaleX < options.minScale || transform.scaleX > options.maxScale) return false
	if (transform.scaleY < options.minScale || transform.scaleY > options.maxScale) return false
	if (transform.shear > options.maxShear) return false
	return true
}

// Aligns one source image into the reference frame coordinate grid.
function alignIntoReference(image: Image, inverseTransform: SimilarityTransform | AffineTransform, outWidth: number, outHeight: number, interpolation: StackingInterpolationMode, outRaw: ImageRawType, outMask: Uint8Array) {
	const matrix = toAffineMatrix(inverseTransform)
	outRaw.fill(0)
	outMask.fill(0)

	for (let y = 0; y < outHeight; y++) {
		let sourceX = matrix.m01 * y + matrix.tx
		let sourceY = matrix.m11 * y + matrix.ty

		for (let x = 0; x < outWidth; x++) {
			const pixel = y * outWidth + x
			if (sampleInto(image.raw, image.metadata.width, image.metadata.height, image.metadata.channels, sourceX, sourceY, interpolation, outRaw, pixel * image.metadata.channels)) outMask[pixel] = 1
			sourceX += matrix.m00
			sourceY += matrix.m10
		}
	}
}

// Samples a source image at one floating coordinate into the destination buffer.
function sampleInto(raw: ImageRawType, width: number, height: number, channels: number, x: number, y: number, interpolation: StackingInterpolationMode, out: ImageRawType, outIndex: number) {
	if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return false

	if (interpolation === 'nearest') {
		const ix = Math.round(x)
		const iy = Math.round(y)
		const base = (iy * width + ix) * channels
		for (let channel = 0; channel < channels; channel++) out[outIndex + channel] = raw[base + channel]
		return true
	}

	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	const x1 = Math.min(x0 + 1, width - 1)
	const y1 = Math.min(y0 + 1, height - 1)
	const tx = x - x0
	const ty = y - y0
	const w00 = (1 - tx) * (1 - ty)
	const w10 = tx * (1 - ty)
	const w01 = (1 - tx) * ty
	const w11 = tx * ty
	const base00 = (y0 * width + x0) * channels
	const base10 = (y0 * width + x1) * channels
	const base01 = (y1 * width + x0) * channels
	const base11 = (y1 * width + x1) * channels

	for (let channel = 0; channel < channels; channel++) {
		out[outIndex + channel] = raw[base00 + channel] * w00 + raw[base10 + channel] * w10 + raw[base01 + channel] * w01 + raw[base11 + channel] * w11
	}

	return true
}

// Converts similarity or affine parameters into a common matrix representation.
function toAffineMatrix(transform: SimilarityTransform | AffineTransform) {
	if ('mirrored' in transform) {
		return { m00: transform.a, m01: transform.mirrored ? transform.b : -transform.b, tx: transform.tx, m10: transform.b, m11: transform.mirrored ? -transform.a : transform.a, ty: transform.ty }
	}

	return transform
}

// Accumulates an aligned frame into online sum and weight buffers.
function accumulateAlignedFrame(channels: number, raw: ArrayLike<number>, valid: Uint8Array, sum: Float64Array, weightSum: Float64Array, coverageMap: Uint32Array, method: StackingCombinationMethod, weight: number) {
	const effectiveWeight = method === 'weighted-average' ? weight : 1

	for (let pixel = 0; pixel < valid.length; pixel++) {
		if (valid[pixel] === 0) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) sum[base + channel] += raw[base + channel] * effectiveWeight
		weightSum[pixel] += method === 'sum' ? 1 : effectiveWeight
		coverageMap[pixel]++
	}
}

// Computes overlap fraction from a validity mask.
function computeOverlapFraction(valid: Uint8Array) {
	let covered = 0
	for (let i = 0; i < valid.length; i++) covered += valid[i]
	return covered / Math.max(valid.length, 1)
}

// Builds the final validity mask for the requested crop policy.
function buildValidityMask(coverageMap: Uint32Array, acceptedFrames: number, options: ResolvedStackingOptions, width: number, height: number, cropBounds?: StackBounds) {
	const threshold = coverageThreshold(acceptedFrames, options)
	const mask = new Uint8Array(coverageMap.length)
	const bounds = cropBounds ?? { left: 0, top: 0, right: width - 1, bottom: height - 1, width, height }

	for (let y = bounds.top; y <= bounds.bottom; y++) {
		for (let x = bounds.left; x <= bounds.right; x++) {
			const pixel = y * width + x
			if (coverageMap[pixel] >= threshold) mask[pixel] = 1
		}
	}

	return mask
}

// Computes the final effective crop bounds from the coverage map.
function computeEffectiveCropBounds(width: number, height: number, coverageMap: Uint32Array, acceptedFrames: number, options: ResolvedStackingOptions): StackBounds | undefined {
	if (acceptedFrames <= 0) return undefined

	const threshold = coverageThreshold(acceptedFrames, options)

	let left = width
	let top = height
	let right = -1
	let bottom = -1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = y * width + x

			if (coverageMap[pixel] < threshold) continue
			if (x < left) left = x
			if (y < top) top = y
			if (x > right) right = x
			if (y > bottom) bottom = y
		}
	}

	if (right < left || bottom < top) return undefined

	return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
}

// Computes the count threshold implied by crop mode and minimum coverage.
function coverageThreshold(acceptedFrames: number, options: ResolvedStackingOptions) {
	if (acceptedFrames <= 0) return 0
	if (options.cropMode === 'intersection') return acceptedFrames
	return Math.max(1, Math.ceil(options.minimumCoverage * acceptedFrames))
}

// Crops the final image for intersection mode while preserving reference metadata shape otherwise.
function maybeCropImage(referenceImage: Image, raw: ImageRawType, cropBounds: StackBounds | undefined, options: ResolvedStackingOptions): Image {
	if (options.cropMode !== 'intersection' || cropBounds === undefined) return buildImage(raw, referenceImage.header, referenceImage.metadata.width, referenceImage.metadata.height, referenceImage.metadata.channels, raw instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT, referenceImage.metadata.bayer)

	const cropped = createLike(raw, cropBounds.width * cropBounds.height * referenceImage.metadata.channels)
	let outPixel = 0

	for (let y = cropBounds.top; y <= cropBounds.bottom; y++) {
		for (let x = cropBounds.left; x <= cropBounds.right; x++) {
			const sourceBase = (y * referenceImage.metadata.width + x) * referenceImage.metadata.channels
			const targetBase = outPixel++ * referenceImage.metadata.channels
			for (let channel = 0; channel < referenceImage.metadata.channels; channel++) cropped[targetBase + channel] = raw[sourceBase + channel]
		}
	}

	return buildImage(cropped, referenceImage.header, cropBounds.width, cropBounds.height, referenceImage.metadata.channels, cropped instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT, referenceImage.metadata.bayer)
}

// Builds a valid Image structure from raw data and metadata pieces.
function buildImage(raw: ImageRawType, header: FitsHeader, width: number, height: number, channels: number, bitpix: Bitpix, bayer: Image['metadata']['bayer']): Image {
	return {
		header: { ...header },
		raw,
		metadata: {
			width,
			height,
			channels,
			pixelCount: width * height,
			stride: width * channels,
			strideInBytes: width * bitpixInBytes(bitpix),
			pixelSizeInBytes: bitpixInBytes(bitpix),
			bitpix,
			bayer,
		},
	}
}

// Creates an empty stack result when no usable frame exists.
function emptyStackResult(options: ResolvedStackingOptions, referenceFrameIndex: number, diagnostics: readonly FrameAcceptanceResult[]): StackResult {
	return {
		finalImage: undefined,
		acceptedFrames: 0,
		rejectedFrames: diagnostics.length,
		referenceFrameIndex,
		effectiveCropBounds: undefined,
		diagnostics,
		statistics: {
			method: options.combinationMethod,
			normalizationMode: options.normalizationMode,
			weightingMode: options.weightingMode,
			liveExact: isLiveCombinationMethodSupported(options.combinationMethod),
			acceptedWeightSum: 0,
			minimumCoverage: options.cropMode === 'intersection' ? 1 : options.minimumCoverage,
		},
		coverageMap: undefined,
		validityMask: undefined,
	}
}

// Creates a full-valid mask for the reference frame.
function fullMask(length: number) {
	const mask = new Uint8Array(length)
	mask.fill(1)
	return mask
}

// Increments coverage counts from a validity mask.
function incrementCoverage(coverageMap: Uint32Array, valid: Uint8Array) {
	for (let i = 0; i < valid.length; i++) coverageMap[i] += valid[i]
}

// Creates a typed raw buffer matching the reference storage class.
function createLike(reference: ImageRawType, length: number) {
	return reference instanceof Float64Array ? new Float64Array(length) : new Float32Array(length)
}

// Clones a raw pixel buffer without changing its numeric type.
function cloneRaw(reference: ImageRawType) {
	const out = createLike(reference, reference.length)
	out.set(reference)
	return out
}

// Samples sparse luminance or grayscale values from an image.
function sampleImageValues(raw: ImageRawType, channels: number, width: number, height: number, limit: number, luminance: boolean) {
	const step = Math.max(1, Math.floor(Math.sqrt((width * height) / Math.max(limit, 1))))
	const values: number[] = []

	for (let y = 0; y < height; y += step) {
		for (let x = 0; x < width; x += step) {
			const base = (y * width + x) * channels
			if (channels === 1 || !luminance) values.push(raw[base])
			else values.push(0.2125 * raw[base] + 0.7154 * raw[base + 1] + 0.0721 * raw[base + 2])
		}
	}

	return Float64Array.from(values)
}

// Computes a percentile from a sorted numeric array.
function percentileSorted(values: Float64Array, count: number, percentile: number) {
	if (count <= 0) return NaN
	if (count === 1) return values[0]
	const clamped = clamp(percentile, 0, 1)
	const index = clamped * (count - 1)
	const lower = Math.floor(index)
	const upper = Math.min(lower + 1, count - 1)
	const fraction = index - lower
	return values[lower] + (values[upper] - values[lower]) * fraction
}

// Verifies that the decoded image shape is internally consistent.
function isImageShapeValid(image: Image) {
	return image.metadata.width > 0 && image.metadata.height > 0 && (image.metadata.channels === 1 || image.metadata.channels === 3) && image.raw.length === image.metadata.pixelCount * image.metadata.channels
}

// Sums accepted normalization weights from diagnostics.
function sumAcceptedWeights(diagnostics: readonly FrameAcceptanceResult[]) {
	let total = 0
	for (let i = 0; i < diagnostics.length; i++) if (diagnostics[i].accepted) total += diagnostics[i].normalization?.weight ?? 1
	return total
}

// Creates a constant-valued channel array.
function channelArray(channels: number, value: number) {
	const out = new Array<number>(channels)
	for (let i = 0; i < channels; i++) out[i] = value
	return out
}

// Returns the deterministic identity transform summary.
function identityTransformSummary(): StackingTransformSummary {
	return { model: 'identity', translationX: 0, translationY: 0, scaleX: 1, scaleY: 1, rotation: 0, shear: 0, mirrored: false, inlierCount: 0, rmsError: 0 }
}

// Replaces non-finite scalars with a stable fallback.
function finiteOr(value: number, fallback: number) {
	return Number.isFinite(value) ? value : fallback
}
