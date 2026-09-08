import type { StarMatchingConfig } from '../../astrometry/matching/star.matching'
import { scaleAndCropFitsWcs } from '../../astrometry/wcs/fits.wcs'
import { Bitpix, type FitsHeader } from '../../io/formats/fits/fits'
import { bitpixInBytes } from '../../io/formats/fits/util'
import type { Rect, Size } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import { meanOf, medianAbsoluteDeviationOf, medianOf } from '../../math/numerical/statistics'
import { type Image, type ImageRawPrecision, type ImageRawType, makeImageRawTypedArray } from '../model/types'
import type { DetectedStar } from '../stars/detector'
import type { SigmaClipCenterMethod, SigmaClipDispersionMethod } from './computation'
import { createDrizzleAccumulator, depositDrizzle, type DrizzleAccumulator, drizzleNormalization, drizzleOverlap, prepareDrizzleFootprint } from './drizzle'
// oxfmt-ignore
import { applyGlobalNormalizationInPlace, applyLocalNormalizationInPlace, broadcastNormalizationPlanes, DEFAULT_LOCAL_NORMALIZATION_OPTIONS, type FrameNormalizationSummary, fitLocalNormalizationRaw, type GlobalNormalizationMode, isLocalNormalizationFallback, type LocalNormalizationFallbackReason, type LocalNormalizationModel, type LocalNormalizationOptions, localNormalizationFailureReason, localNormalizationSummary, type NormalizationColorMode, resolveLocalNormalizationOptions, solveGlobalNormalizationPlanes } from './normalization'
import { type ImageInterpolationMode, type ImageRegistrationFailureReason, type ImageRegistrationSuccess, registerImage, registerStars, toAffineMatrix } from './registration'
import { measureSubframeQuality, type SubframeQualityMetrics } from './subframe.selector'

// Image stacking pipeline: registers a set of frames to a reference using star matching, normalizes
// and weights them, then combines the aligned pixels with a selectable rejection method (average,
// median, sigma-clip, min/max, winsorized mean, percentile clip). Produces the stacked image plus
// per-frame acceptance diagnostics, coverage, and combination statistics. Drizzle deposits square
// drops without resampling, optionally reconstructing CFA as RGB. Means preserve normalized intensity
// (which may exceed [0,1]); Drizzle sum preserves distributed samples before masking/cropping.

// Reconstruction following registration; resample preserves the existing interpolation pipeline.
export type StackingReconstructionMode = 'resample' | 'drizzle' | 'cfaDrizzle'

// Square-drop reconstruction on the fixed reference field; checked before large allocations.
export interface DrizzleStackingOptions {
	// Finite output samples per reference pixel, >=1. Default 2; rounding defines effective axis scales.
	readonly scale?: number
	// Drop side in input pixels, in (0,1]. Default 1; sub-resolution footprints are rejected.
	readonly pixfrac?: number
	// Positive safe integer byte budget for numeric buffers and one result. Default 1 GiB.
	readonly maxMemoryBytes?: number
}

// Pixel-combination algorithm applied across the aligned frame stack.
export type StackingCombinationMethod = 'sum' | 'average' | 'weighted-average' | 'median' | 'sigma-clip' | 'min-max-average' | 'winsorized-mean' | 'percentile-clip-average'

// Resampling kernel used when warping a frame onto the reference grid.
export type StackingInterpolationMode = ImageInterpolationMode

// Output extent: the union (full coverage) or intersection (common area) of the frames.
export type StackingCropMode = 'union' | 'intersection'

// Per-frame normalization strategy applied before combination. The global estimators match the whole
// overlap with one scale/offset pair per channel; `local` keeps that pair as its anchor and additionally
// models the smooth spatial residual around it (see `LocalNormalizationOptions`).
export type StackingNormalizationMode = 'none' | GlobalNormalizationMode | 'local'

// Per-frame weighting strategy in weighted combinations.
export type StackingWeightingMode = 'none' | 'snr' | 'inverse-hfd' | 'stars' | 'quality'

// How color images are combined: each channel independently or via a shared luminance alignment.
export type StackingColorHandlingMode = NormalizationColorMode

// How the reference frame for a batch is chosen.
export type BatchReferenceSelectionMode = 'first-accepted' | 'best-quality' | 'index'

// Reason a frame was rejected from the stack.
export type FrameRejectionReason =
	| 'bayer-image-requires-cfa-drizzle'
	| 'cfa-image-required'
	| 'combination-method-not-supported-in-live-mode'
	| 'invalid-image-shape'
	| 'channel-mismatch'
	| 'too-few-stars'
	| 'reference-has-no-stars'
	| 'match-failed'
	| 'invalid-transform'
	| 'transform-error-too-high'
	| 'transform-out-of-bounds'
	| 'no-overlap'
	| 'insufficient-overlap'
	| 'normalization-failed'

// One input frame: its image, detected stars, and optional identity/weight.
export interface StackingFrame {
	readonly image: Image
	readonly stars: readonly DetectedStar[]
	readonly id?: string | number
	readonly weight?: number
}

// Selection of the batch reference frame.
export interface BatchReferenceSelection {
	// Selection strategy.
	readonly mode?: BatchReferenceSelectionMode
	// Explicit frame index when mode is 'index'.
	readonly index?: number
}

// Sigma-clip rejection parameters for the 'sigma-clip' combination.
export interface SigmaClipStackingOptions {
	readonly sigmaLower?: number
	readonly sigmaUpper?: number
	readonly maxIterations?: number
	readonly centerMethod?: SigmaClipCenterMethod
	readonly dispersionMethod?: SigmaClipDispersionMethod
}

// Min/max rejection counts (number of lowest/highest samples discarded per pixel).
export interface MinMaxRejectionOptions {
	readonly low?: number
	readonly high?: number
}

// Lower/upper percentile fractions (0..1) for winsorization or percentile clipping.
export interface PercentileRangeOptions {
	readonly lower?: number
	readonly upper?: number
}

// Summary of the geometric transform aligning a frame to the reference.
export interface StackingTransformSummary {
	// Transform family that was fitted.
	readonly model: 'identity' | 'similarity' | 'affine'
	readonly translationX: number
	readonly translationY: number
	readonly scaleX: number
	readonly scaleY: number
	// Rotation, radians.
	readonly rotation: number
	readonly shear: number
	// True when the transform includes a reflection.
	readonly mirrored: boolean
	// Number of star matches kept as inliers.
	readonly inlierCount: number
	// RMS residual of the inlier matches, pixels.
	readonly rmsError: number
}

// Quality metrics estimated for one frame.
export type StackingFrameQualityMetrics = SubframeQualityMetrics

// Acceptance outcome and diagnostics for one frame.
export interface FrameAcceptanceResult {
	readonly accepted: boolean
	readonly frameIndex: number
	readonly frameId?: string | number
	// Rejection reason when not accepted.
	readonly reason?: FrameRejectionReason
	readonly transform?: StackingTransformSummary
	// Fraction of the reference area the frame covers.
	readonly overlapFraction: number
	readonly quality: StackingFrameQualityMetrics
	readonly normalization?: FrameNormalizationSummary
}

// Pixel bounds of the stacked output (a rectangle with its size).
export interface StackBounds extends Readonly<Rect>, Readonly<Size> {}

// Summary statistics of the combination step.
export interface StackCombinationStatisticsSummary {
	// Effective reconstruction mode.
	readonly reconstructionMode: StackingReconstructionMode
	// Effective photometric color mode; CFA always uses per-channel.
	readonly colorHandlingMode: StackingColorHandlingMode
	// Requested drop parameters and pre-crop dimensions; absent without an accepted reference.
	readonly drizzle?: {
		// Requested output samples per reference pixel.
		readonly scale: number
		// Input-pixel drop side.
		readonly pixfrac: number
		// Pre-crop reconstruction width, pixels.
		readonly outputWidth: number
		// Pre-crop reconstruction height, pixels.
		readonly outputHeight: number
	}
	readonly method: StackingCombinationMethod
	readonly normalizationMode: StackingNormalizationMode
	readonly weightingMode: StackingWeightingMode
	// True when an exact (non-incremental) live combination was used.
	readonly liveExact: boolean
	// Sum of accepted frame weights.
	readonly acceptedWeightSum: number
	// Minimum per-pixel frame coverage required to keep an output pixel.
	readonly minimumCoverage: number
}

// Dimensionless Drizzle denominator on the reconstruction grid before cropping; not an exposure or
// variance map. Live results own copies; a completed batch may transfer its accumulator directly.
export interface StackWeightMap {
	// Pre-crop width, pixels.
	readonly width: number
	// Pre-crop height, pixels.
	readonly height: number
	// Shared standard denominator or interleaved CFA RGB denominators.
	readonly channels: 1 | 3
	// Row-major frame weights times fractional drop overlaps.
	readonly raw: Float64Array
}

// Full result of a stack: the image, counts, crop, per-frame diagnostics, and optional coverage maps.
export interface StackResult {
	readonly finalImage?: Image
	readonly acceptedFrames: number
	readonly rejectedFrames: number
	readonly referenceFrameIndex: number
	// Inclusive bounds of valid pixels on the pre-crop grid; the rectangle may contain invalid holes.
	readonly effectiveCropBounds?: StackBounds
	readonly diagnostics: readonly FrameAcceptanceResult[]
	readonly statistics: StackCombinationStatisticsSummary
	// Pre-crop per-pixel count of contributing frames, when requested.
	readonly coverageMap?: Uint32Array
	// Drizzle denominator when per-pixel statistics are requested.
	readonly weightMap?: StackWeightMap
	// Pre-crop validity mask; returned whenever there is an accepted reference.
	readonly validityMask?: Uint8Array
}

// Public stacking configuration; omitted fields use the module defaults.
export interface StackingOptions {
	// Defaults to resample. Drizzle supports sum/average/weighted-average and global normalization.
	readonly reconstructionMode?: StackingReconstructionMode
	// Ignored in resample, as is interpolationMode in Drizzle.
	readonly drizzle?: DrizzleStackingOptions
	readonly combinationMethod?: StackingCombinationMethod
	readonly batchReference?: BatchReferenceSelection
	readonly interpolationMode?: StackingInterpolationMode
	readonly sigmaClip?: SigmaClipStackingOptions
	readonly minMaxRejection?: MinMaxRejectionOptions
	readonly winsorization?: PercentileRangeOptions
	readonly percentileClip?: PercentileRangeOptions
	// Minimum detected stars for a frame to be eligible.
	readonly minAcceptedStars?: number
	// Minimum inlier matches for an accepted registration.
	readonly minAcceptedInliers?: number
	// Maximum RMS registration error, pixels.
	readonly maxAcceptedTransformError?: number
	// Minimum overlap fraction with the reference.
	readonly minOverlapFraction?: number
	readonly cropMode?: StackingCropMode
	// Minimum per-pixel coverage to keep an output pixel.
	readonly minimumCoverage?: number
	readonly normalizationMode?: StackingNormalizationMode
	// Tuning for `normalizationMode: 'local'`; ignored by every other mode.
	readonly localNormalization?: LocalNormalizationOptions
	readonly weightingMode?: StackingWeightingMode
	readonly colorHandlingMode?: StackingColorHandlingMode
	// Expose per-pixel coverage and Drizzle weights. Validity masks are returned independently.
	readonly keepPerPixelStatistics?: boolean
	// Allow a reference frame with no detected stars.
	readonly allowStarlessReference?: boolean
	// Registration sanity bounds (translation pixels, rotation radians, scale, shear).
	readonly maxTranslation?: number
	readonly maxRotation?: number
	readonly minScale?: number
	readonly maxScale?: number
	readonly maxShear?: number
	// Sample precision; Drizzle always accumulates in Float64 and applies this to the final raw.
	readonly samplePrecision?: ImageRawPrecision
	readonly matchStarsConfig?: StarMatchingConfig
}

// StackingOptions with every field resolved to a concrete value.
interface ResolvedStackingOptions extends Required<Omit<StackingOptions, 'sigmaClip' | 'minMaxRejection' | 'winsorization' | 'percentileClip' | 'batchReference' | 'matchStarsConfig' | 'localNormalization' | 'drizzle'>> {
	// Drop parameters and numeric-buffer budget, resolved only for Drizzle reconstruction.
	readonly drizzle: Required<DrizzleStackingOptions>
	readonly sigmaClip: Required<SigmaClipStackingOptions>
	readonly minMaxRejection: Required<MinMaxRejectionOptions>
	readonly winsorization: Required<PercentileRangeOptions>
	readonly percentileClip: Required<PercentileRangeOptions>
	readonly batchReference: Required<BatchReferenceSelection>
	readonly matchStarsConfig: StarMatchingConfig
	readonly localNormalization: Required<LocalNormalizationOptions>
}

// One frame after warping onto the reference grid: its resampled pixels, validity, and per-frame metadata.
interface AlignedFrame {
	readonly raw: ImageRawType
	readonly valid: Uint8Array
	readonly weight: number
	readonly coveredPixels: number
	readonly index: number
	readonly id?: string | number
	readonly quality: StackingFrameQualityMetrics
	readonly normalization: FrameNormalizationSummary
	readonly transform: StackingTransformSummary
}

// Default resolved stacking options.
const DEFAULT_STACKING_OPTIONS: ResolvedStackingOptions = {
	reconstructionMode: 'resample',
	drizzle: { scale: 2, pixfrac: 1, maxMemoryBytes: 2 ** 30 },
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
	localNormalization: DEFAULT_LOCAL_NORMALIZATION_OPTIONS,
	weightingMode: 'none',
	colorHandlingMode: 'per-channel',
	keepPerPixelStatistics: true,
	allowStarlessReference: true,
	maxTranslation: Infinity,
	maxRotation: Infinity,
	minScale: 0.5,
	maxScale: 2,
	maxShear: 0.5,
	samplePrecision: 'auto',
	matchStarsConfig: {},
}

// Small epsilon guarding divisions and degeneracy tests.
const FLOAT_EPSILON = 1e-12

// Resolves caller overrides into deterministic internal defaults.
function resolveStackingOptions(options: StackingOptions = {}): ResolvedStackingOptions {
	const reconstructionMode = options.reconstructionMode ?? DEFAULT_STACKING_OPTIONS.reconstructionMode
	const drizzle = reconstructionMode === 'resample' ? DEFAULT_STACKING_OPTIONS.drizzle : { scale: options.drizzle?.scale ?? 2, pixfrac: options.drizzle?.pixfrac ?? 1, maxMemoryBytes: options.drizzle?.maxMemoryBytes ?? 2 ** 30 }

	if (reconstructionMode !== 'resample') {
		// These combinations would otherwise silently change the requested algorithm.
		if (!isLiveCombinationMethodSupported(options.combinationMethod ?? DEFAULT_STACKING_OPTIONS.combinationMethod) || options.normalizationMode === 'local') throw new RangeError('Drizzle requires sum, average or weighted-average and global normalization')
		// Scale and budget govern potentially enormous scale-squared allocations.
		if (!Number.isFinite(drizzle.scale) || !(drizzle.scale >= 1) || !Number.isSafeInteger(drizzle.maxMemoryBytes) || !(drizzle.maxMemoryBytes > 0)) throw new RangeError('Drizzle requires finite scale >= 1 and a positive safe integer memory budget')
	}

	return {
		...DEFAULT_STACKING_OPTIONS,
		...options,
		reconstructionMode,
		drizzle,
		colorHandlingMode: reconstructionMode === 'cfaDrizzle' ? 'per-channel' : (options.colorHandlingMode ?? DEFAULT_STACKING_OPTIONS.colorHandlingMode),
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
		// `localNormalization` is documented as ignored outside local mode, so it is only resolved — and
		// therefore only validated — when that mode is selected. Otherwise switching a configuration away
		// from `local` would still be rejected by a stale local block it no longer uses.
		localNormalization: (options.normalizationMode ?? DEFAULT_STACKING_OPTIONS.normalizationMode) === 'local' ? resolveLocalNormalizationOptions(options.localNormalization) : DEFAULT_LOCAL_NORMALIZATION_OPTIONS,
	}
}

// Projects stacking registration policy onto the reusable image-registration API.
function registrationOptions(options: ResolvedStackingOptions, outputRaw?: ImageRawType, validityMask?: Uint8Array) {
	return {
		matchStarsConfig: options.matchStarsConfig,
		interpolationMode: options.interpolationMode,
		outputPrecision: options.samplePrecision,
		outputRaw,
		validityMask,
		acceptance: {
			minInliers: options.minAcceptedInliers,
			maxRmsError: options.maxAcceptedTransformError,
			maxTranslation: options.maxTranslation,
			maxRotation: options.maxRotation,
			minScale: options.minScale,
			maxScale: options.maxScale,
			maxShear: options.maxShear,
		},
	}
}

// Converts generic registration failures into the stacker's established diagnostics.
function stackingRegistrationFailureReason(reason: ImageRegistrationFailureReason): FrameRejectionReason {
	switch (reason) {
		case 'invalid-reference-image':
		case 'invalid-target-image':
			return 'invalid-image-shape'
		case 'channel-mismatch':
			return 'channel-mismatch'
		default:
			return reason
	}
}

// Checks whether the selected combination method has an exact online path.
export function isLiveCombinationMethodSupported(method: StackingCombinationMethod) {
	return method === 'sum' || method === 'average' || method === 'weighted-average'
}

// Implements live stacking and exposes a batch helper through the same API surface.
export class LiveStacker {
	#options: ResolvedStackingOptions = DEFAULT_STACKING_OPTIONS
	#referenceFrame?: StackingFrame
	#referenceIndex = -1
	#diagnostics: FrameAcceptanceResult[] = []
	#acceptedFrames = 0
	#rejectedFrames = 0
	#sum?: Float64Array
	#weightSum?: Float64Array
	#coverageMap?: Uint32Array
	#workRaw?: ImageRawType
	#workMask?: Uint8Array
	// Owns Drizzle buffers exclusively; resampling work buffers stay unallocated in this mode.
	#drizzle?: DrizzleAccumulator

	constructor(options: StackingOptions = {}) {
		this.initialize(options)
	}

	// Initializes or reinitializes the live stacker state.
	initialize(options: StackingOptions = {}) {
		this.#options = resolveStackingOptions(options)
		this.reset()
	}

	// Clears the live stacking state.
	reset() {
		this.#referenceFrame = undefined
		this.#referenceIndex = -1
		this.#diagnostics = []
		this.#acceptedFrames = 0
		this.#rejectedFrames = 0
		this.#sum = undefined
		this.#weightSum = undefined
		this.#coverageMap = undefined
		this.#workRaw = undefined
		this.#workMask = undefined
		this.#drizzle = undefined
	}

	// Adds a single frame to the live stack when the method supports exact incremental updates.
	add(frame: StackingFrame): FrameAcceptanceResult {
		const frameIndex = this.#diagnostics.length
		const quality = measureSubframeQuality(frame)

		if (!isImageShapeValid(frame.image)) return this.#reject(frameIndex, frame, quality, 'invalid-image-shape')
		if (!isLiveCombinationMethodSupported(this.#options.combinationMethod)) return this.#reject(frameIndex, frame, quality, 'combination-method-not-supported-in-live-mode')
		if (this.#options.reconstructionMode !== 'resample') {
			const incompatibility = drizzleFrameFailure(frame, this.#options)
			if (incompatibility !== undefined) return this.#reject(frameIndex, frame, quality, incompatibility)
			if (this.#referenceFrame === undefined) {
				if (!this.#options.allowStarlessReference && frame.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'too-few-stars')
				const initial = initializeDrizzleReference(frame, frameIndex, quality, this.#options)
				if (initial === undefined) return this.#reject(frameIndex, frame, quality, 'invalid-transform')
				this.#drizzle = initial.state
				this.#referenceFrame = frame
				this.#referenceIndex = frameIndex
				this.#acceptedFrames = 1
				this.#diagnostics.push(initial.diagnostic)
				return initial.diagnostic
			}

			const result = addDrizzleFrame(this.#drizzle!, this.#referenceFrame, frame, frameIndex, quality, this.#acceptedFrames, this.#options)
			if (result.accepted) this.#acceptedFrames++
			else this.#rejectedFrames++
			this.#diagnostics.push(result)
			return result
		}

		if (this.#referenceFrame === undefined) {
			if (!this.#options.allowStarlessReference && frame.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'too-few-stars')
			this.#acceptReferenceFrame(frame, frameIndex, quality)

			const accepted: FrameAcceptanceResult = {
				accepted: true,
				frameIndex,
				frameId: frame.id,
				overlapFraction: 1,
				quality,
				transform: identityTransformSummary(),
				normalization: { scales: channelArray(frame.image.metadata.channels, 1), offsets: channelArray(frame.image.metadata.channels, 0), weight: resolveFrameWeight(frame, quality, this.#options) },
			}

			this.#diagnostics.push(accepted)

			return accepted
		}

		if (frame.image.metadata.channels !== this.#referenceFrame.image.metadata.channels) return this.#reject(frameIndex, frame, quality, 'channel-mismatch')
		if (frame.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'too-few-stars')
		if (this.#referenceFrame.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'reference-has-no-stars')

		this.#ensureWorkBuffers(this.#referenceFrame.image.metadata.pixelCount * this.#referenceFrame.image.metadata.channels, this.#referenceFrame.image.raw.BYTES_PER_ELEMENT)
		const registration = registerImage(this.#referenceFrame, frame, registrationOptions(this.#options, this.#workRaw, this.#workMask))
		if (!registration.success) return this.#reject(frameIndex, frame, quality, stackingRegistrationFailureReason(registration.reason))

		const { raw } = registration.image
		const valid = registration.validityMask
		const overlapFraction = registration.coveredPixels / Math.max(valid.length, 1)
		if (overlapFraction <= 0) return this.#reject(frameIndex, frame, quality, 'no-overlap')
		if (overlapFraction < this.#options.minOverlapFraction) return this.#reject(frameIndex, frame, quality, 'insufficient-overlap')

		const normalization = computeNormalization(raw, valid, frame, this.#referenceFrame, quality, this.#options)
		if (normalization.transform.kind === 'rejected') return this.#reject(frameIndex, frame, quality, 'normalization-failed', overlapFraction)
		applyNormalizationInPlace(raw, valid, frame.image.metadata.channels, normalization.transform)
		accumulateAlignedFrame(this.#referenceFrame.image.metadata.channels, raw, valid, this.#sum!, this.#weightSum!, this.#coverageMap, this.#options.combinationMethod, normalization.summary.weight)

		this.#acceptedFrames++

		const accepted: FrameAcceptanceResult = {
			accepted: true,
			frameIndex,
			frameId: frame.id,
			overlapFraction,
			quality,
			transform: registration.transform.summary,
			normalization: normalization.summary,
		}

		this.#diagnostics.push(accepted)

		return accepted
	}

	// Returns the current live stacking result without mutating the stack.
	snapshot(): StackResult | undefined {
		if (this.#referenceFrame !== undefined && this.#drizzle !== undefined) return buildDrizzleResult(this.#drizzle, this.#referenceFrame, this.#referenceIndex, this.#acceptedFrames, this.#diagnostics, this.#options, true)
		if (this.#referenceFrame === undefined || this.#sum === undefined || this.#weightSum === undefined || this.#coverageMap === undefined) return undefined
		return buildOnlineResult(this.#referenceFrame, this.#referenceIndex, this.#acceptedFrames, this.#rejectedFrames, this.#diagnostics, this.#options, this.#sum, this.#weightSum, this.#coverageMap)
	}

	// Initializes the live stack with the first accepted reference frame.
	#acceptReferenceFrame(frame: StackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics) {
		const { channels, pixelCount } = frame.image.metadata
		this.#referenceFrame = frame
		this.#referenceIndex = frameIndex
		this.#acceptedFrames = 1
		this.#sum = new Float64Array(pixelCount * channels)
		this.#weightSum = new Float64Array(pixelCount)
		this.#coverageMap = new Uint32Array(pixelCount)
		this.#workRaw = undefined
		this.#workMask = undefined
		const weight = resolveFrameWeight(frame, quality, this.#options)
		accumulateAlignedFrame(channels, frame.image.raw, fullMask(pixelCount), this.#sum, this.#weightSum, this.#coverageMap, this.#options.combinationMethod, weight)
	}

	// Records a structured rejection result. `overlapFraction` defaults to 0 for the failures that happen
	// before registration measures any coverage; a frame dropped after a successful registration passes
	// the coverage it actually had, so the diagnostics stay distinguishable from a no-overlap frame.
	#reject(frameIndex: number, frame: StackingFrame, quality: StackingFrameQualityMetrics, reason: FrameRejectionReason, overlapFraction = 0): FrameAcceptanceResult {
		this.#rejectedFrames++
		const result: FrameAcceptanceResult = { accepted: false, frameIndex, frameId: frame.id, overlapFraction, quality, reason }
		this.#diagnostics.push(result)
		return result
	}

	// Reuses registration output buffers between live add calls.
	#ensureWorkBuffers(length: number, byteLength: number) {
		const samplePrecision = this.#options.samplePrecision === 'auto' ? byteLength * 8 : this.#options.samplePrecision
		const ImageType = samplePrecision === 64 ? Float64Array : Float32Array
		if (this.#workRaw === undefined || this.#workRaw.length !== length) this.#workRaw = new ImageType(length)
		if (this.#workMask === undefined || this.#workMask.length !== length / (this.#referenceFrame?.image.metadata.channels ?? 1)) this.#workMask = new Uint8Array(length / (this.#referenceFrame?.image.metadata.channels ?? 1))
	}
}

// Executes a full batch stack with deterministic diagnostics.
export function stackFrames(frames: readonly StackingFrame[], options: StackingOptions = {}): StackResult {
	const resolved = resolveStackingOptions(options)
	if (frames.length === 0) return emptyStackResult(resolved, -1, [])
	const qualities = frames.map(measureSubframeQuality)
	const referenceIndex = selectReferenceFrameIndex(frames, qualities, resolved)
	if (resolved.reconstructionMode !== 'resample') return stackDrizzleFrames(frames, qualities, referenceIndex, resolved)
	const referenceFrame = frames[referenceIndex]

	if (!isImageShapeValid(referenceFrame.image)) {
		return emptyStackResult(resolved, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 0, quality: qualities[referenceIndex], reason: 'invalid-image-shape' }])
	}

	const accepted: AlignedFrame[] = []
	const diagnostics: FrameAcceptanceResult[] = []
	const pixelCount = referenceFrame.image.metadata.pixelCount
	const channels = referenceFrame.image.metadata.channels
	const sampleBasedMethod = !(resolved.combinationMethod === 'sum' || resolved.combinationMethod === 'average' || resolved.combinationMethod === 'weighted-average')
	const coverageMap = new Uint32Array(pixelCount)
	const sum = new Float64Array(pixelCount * channels)
	const weightSum = new Float64Array(pixelCount)
	const referenceWeight = resolveFrameWeight(referenceFrame, qualities[referenceIndex], resolved)
	const referenceNormalization = { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight: referenceWeight }
	const referenceValid = fullMask(pixelCount)
	let acceptedCount = 1
	incrementCoverage(coverageMap, referenceValid)

	if (sampleBasedMethod) {
		accepted.push(makeAlignedReference(referenceFrame, referenceIndex, qualities[referenceIndex], referenceNormalization, sum, weightSum, resolved.combinationMethod))
	} else {
		accumulateAlignedFrame(channels, referenceFrame.image.raw, referenceValid, sum, weightSum, undefined, resolved.combinationMethod, referenceWeight)
	}

	diagnostics.push({ accepted: true, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 1, quality: qualities[referenceIndex], transform: identityTransformSummary(), normalization: referenceNormalization })
	let acceptedWeightSum = referenceWeight

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

		const registration = registerImage(referenceFrame, frame, registrationOptions(resolved))

		if (!registration.success) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: stackingRegistrationFailureReason(registration.reason) })
			continue
		}

		// Coverage decides acceptance before the frame is normalized, matching the live path: a frame that
		// cannot contribute keeps its documented rejection reason instead of being reported as a
		// normalization failure, and an expensive local fit never runs on a frame that is about to be
		// dropped anyway.
		const overlapFraction = registration.coveredPixels / Math.max(registration.validityMask.length, 1)

		if (overlapFraction <= 0) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'no-overlap' })
			continue
		}

		if (overlapFraction < resolved.minOverlapFraction) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction, quality, reason: 'insufficient-overlap', transform: registration.transform.summary })
			continue
		}

		const aligned = createAlignedFrame(frame, i, quality, referenceFrame, registration, resolved)

		if (aligned === undefined) {
			// The frame registered and covered enough of the reference; only its normalization failed, so
			// report the coverage it had rather than 0, which would read as a no-overlap frame.
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction, quality, reason: 'normalization-failed', transform: registration.transform.summary })
			continue
		}

		acceptedCount++
		acceptedWeightSum += aligned.weight
		incrementCoverage(coverageMap, aligned.valid)

		if (sampleBasedMethod) {
			accepted.push(aligned)
		} else {
			accumulateAlignedFrame(channels, aligned.raw, aligned.valid, sum, weightSum, undefined, resolved.combinationMethod, aligned.weight)
		}

		diagnostics.push({ accepted: true, frameIndex: i, frameId: frame.id, overlapFraction, quality, transform: registration.transform.summary, normalization: aligned.normalization })
	}

	const finalized = sampleBasedMethod ? finalizeBatchImage(referenceFrame, resolved, accepted, coverageMap) : finalizeOnlineImage(referenceFrame, resolved, sum, weightSum, coverageMap, acceptedCount)
	const cropBounds = computeEffectiveCropBounds(referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, coverageMap, acceptedCount, resolved)

	return {
		finalImage: finalized.image,
		acceptedFrames: acceptedCount,
		rejectedFrames: frames.length - acceptedCount,
		referenceFrameIndex: referenceIndex,
		effectiveCropBounds: cropBounds,
		diagnostics,
		statistics: {
			method: resolved.combinationMethod,
			reconstructionMode: resolved.reconstructionMode,
			colorHandlingMode: resolved.colorHandlingMode,
			normalizationMode: resolved.normalizationMode,
			weightingMode: resolved.weightingMode,
			liveExact: isLiveCombinationMethodSupported(resolved.combinationMethod),
			acceptedWeightSum,
			minimumCoverage: resolved.cropMode === 'intersection' ? 1 : resolved.minimumCoverage,
		},
		coverageMap: resolved.keepPerPixelStatistics ? coverageMap : undefined,
		validityMask: buildValidityMask(coverageMap, acceptedCount, resolved, referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, cropBounds),
	}
}

// Selects the reference frame according to the configured batch strategy.
function selectReferenceFrameIndex(frames: readonly StackingFrame[], qualities: readonly StackingFrameQualityMetrics[], options: ResolvedStackingOptions) {
	if (options.batchReference.mode === 'index') {
		if (!(options.batchReference.index >= 0) || options.batchReference.index >= frames.length) throw new RangeError(`reference frame index ${options.batchReference.index} is out of range for ${frames.length} frames`)
		return options.batchReference.index
	}

	if (options.batchReference.mode === 'best-quality') {
		let bestIndex = -1
		let bestScore = -Infinity

		for (let i = 0; i < frames.length; i++) {
			if (!isImageShapeValid(frames[i].image)) continue
			if (options.reconstructionMode !== 'resample' && drizzleFrameFailure(frames[i], options) !== undefined) continue
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
		if (options.reconstructionMode !== 'resample' && drizzleFrameFailure(frames[i], options) !== undefined) continue
		if (!options.allowStarlessReference && qualities[i].starCount < options.minAcceptedStars) continue
		return i
	}

	return options.reconstructionMode === 'resample' ? 0 : -1
}

// Creates a stored aligned batch sample for the reference frame.
function makeAlignedReference(frame: StackingFrame, index: number, quality: StackingFrameQualityMetrics, normalization: FrameNormalizationSummary, sum: Float64Array, weightSum: Float64Array, method: StackingCombinationMethod): AlignedFrame {
	const { pixelCount, channels } = frame.image.metadata
	const raw = frame.image.raw
	const valid = fullMask(pixelCount)

	if (method === 'sum' || method === 'average' || method === 'weighted-average') {
		accumulateAlignedFrame(channels, raw, valid, sum, weightSum, undefined, method, normalization.weight)
	}

	return { raw, valid, weight: normalization.weight, coveredPixels: pixelCount, index, id: frame.id, quality, normalization, transform: identityTransformSummary() }
}

// Creates an aligned and normalized batch sample against the reference frame grid. Returns undefined
// when a `reject` local-normalization fallback fired, so the caller can drop the frame.
function createAlignedFrame(frame: StackingFrame, index: number, quality: StackingFrameQualityMetrics, referenceFrame: StackingFrame, registration: ImageRegistrationSuccess, options: ResolvedStackingOptions): AlignedFrame | undefined {
	const { channels } = referenceFrame.image.metadata
	const { raw } = registration.image
	const valid = registration.validityMask
	const coveredPixels = registration.coveredPixels
	const normalization = computeNormalization(raw, valid, frame, referenceFrame, quality, options)
	if (normalization.transform.kind === 'rejected') return undefined
	applyNormalizationInPlace(raw, valid, channels, normalization.transform)
	return { raw, valid, weight: normalization.summary.weight, coveredPixels, index, id: frame.id, quality, normalization: normalization.summary, transform: registration.transform.summary }
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
		// Copy the live diagnostics so the snapshot stays a stable point-in-time view that later add() calls cannot mutate.
		diagnostics: diagnostics.slice(),
		statistics: {
			method: options.combinationMethod,
			reconstructionMode: options.reconstructionMode,
			colorHandlingMode: options.colorHandlingMode,
			normalizationMode: options.normalizationMode,
			weightingMode: options.weightingMode,
			liveExact: true,
			acceptedWeightSum: sumAcceptedWeights(diagnostics),
			minimumCoverage: options.cropMode === 'intersection' ? 1 : options.minimumCoverage,
		},
		// Copy the live coverage buffer so the snapshot is not mutated in place by subsequent add() calls.
		coverageMap: options.keepPerPixelStatistics ? coverageMap.slice() : undefined,
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
		case 'sum':
		default: {
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
	let active = count

	for (let iteration = 0; iteration < options.maxIterations; iteration++) {
		const sorted = values.subarray(0, active).sort()
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

		for (let i = 0; i < active; i++) if (sorted[i] >= low && sorted[i] <= high) values[kept++] = sorted[i]

		if (kept === 0) return center
		if (kept === active) return meanOf(sorted)

		active = kept
	}

	return meanOf(values.subarray(0, active))
}

// How a frame's pixels are transformed before combination. Kept separate from the retained summary so
// the full local model — coefficients, control points, node grids, per-cell samples — stays transient
// and never accumulates in the per-frame diagnostics of a long live session.
type NormalizationTransform =
	| {
			readonly kind: 'global'
			readonly scales: readonly number[]
			readonly offsets: readonly number[]
	  }
	| {
			readonly kind: 'local'
			readonly model: LocalNormalizationModel
	  }
	| {
			readonly kind: 'rejected'
			readonly reason: LocalNormalizationFallbackReason
	  }

// The transform to apply plus the compact summary to retain for the frame.
interface ComputedNormalization {
	readonly transform: NormalizationTransform
	readonly summary: FrameNormalizationSummary
}

// Computes the normalization of one aligned frame against the reference.
//
// In `local` mode the global solution is still computed first and reported as `scales`/`offsets`: it is
// the anchor the local model corrects around, and it is what a caller inspecting the summary expects to
// see. A `reject` fallback surfaces here as a `rejected` transform, not as an exception.
function computeNormalization(alignedRaw: ImageRawType, valid: Uint8Array, frame: StackingFrame, referenceFrame: StackingFrame, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions): ComputedNormalization {
	const weight = resolveFrameWeight(frame, quality, options)
	const { width, height, channels } = referenceFrame.image.metadata

	if (options.normalizationMode === 'none') {
		const scales = channelArray(channels, 1)
		const offsets = channelArray(channels, 0)
		return { transform: { kind: 'global', scales, offsets }, summary: { scales, offsets, weight } }
	}

	if (options.normalizationMode === 'local') {
		const model = fitLocalNormalizationRaw(referenceFrame.image.raw, alignedRaw, width, height, channels, options.colorHandlingMode, valid, options.localNormalization)
		const { scales, offsets } = broadcastNormalizationPlanes(model.global, channels)
		const summary: FrameNormalizationSummary = { scales, offsets, weight, local: localNormalizationSummary(model) }

		if (options.localNormalization.fallback === 'reject' && isLocalNormalizationFallback(model)) {
			return { transform: { kind: 'rejected', reason: localNormalizationFailureReason(model) ?? 'surface-fit-failed' }, summary }
		}

		return { transform: { kind: 'local', model }, summary }
	}

	const planes = solveGlobalNormalizationPlanes(alignedRaw, valid, referenceFrame.image.raw, channels, width, height, options.normalizationMode, options.colorHandlingMode)
	const { scales, offsets } = broadcastNormalizationPlanes(planes, channels)
	return { transform: { kind: 'global', scales, offsets }, summary: { scales, offsets, weight } }
}

// Applies a computed transform in place on aligned sample data. A rejected frame is never applied.
function applyNormalizationInPlace(raw: ImageRawType, valid: Uint8Array, channels: number, transform: NormalizationTransform) {
	if (transform.kind === 'global') applyGlobalNormalizationInPlace(raw, valid, channels, transform.scales, transform.offsets)
	else if (transform.kind === 'local') applyLocalNormalizationInPlace(raw, valid, transform.model)
}

// Resolves the deterministic weight attached to one frame.
function resolveFrameWeight(frame: StackingFrame, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions) {
	const base = Math.max(FLOAT_EPSILON, frame.weight ?? 1)

	switch (options.weightingMode) {
		case 'none':
		default:
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

// Accumulates an aligned frame into online sum and weight buffers.
function accumulateAlignedFrame(channels: number, raw: ArrayLike<number>, valid: Uint8Array, sum: Float64Array, weightSum: Float64Array, coverageMap: Uint32Array | undefined, method: StackingCombinationMethod, weight: number) {
	const effectiveWeight = method === 'weighted-average' ? weight : 1
	const sumMode = method === 'sum'

	for (let pixel = 0; pixel < valid.length; pixel++) {
		if (valid[pixel] === 0) continue
		const base = pixel * channels
		for (let channel = 0; channel < channels; channel++) sum[base + channel] += raw[base + channel] * effectiveWeight
		weightSum[pixel] += sumMode ? 1 : effectiveWeight
		if (coverageMap !== undefined) coverageMap[pixel]++
	}
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
			strideInBytes: width * channels * bitpixInBytes(bitpix),
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
			reconstructionMode: options.reconstructionMode,
			colorHandlingMode: options.colorHandlingMode,
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

// Computes a percentile from a sorted numeric array.
function percentileSorted(values: Float64Array, count: number, percentile: number) {
	if (count <= 0) return Number.NaN
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

// Rejects inconsistent image shapes or CFA routing before registration or reference selection.
function drizzleFrameFailure(frame: StackingFrame, options: ResolvedStackingOptions): FrameRejectionReason | undefined {
	if (!isImageShapeValid(frame.image)) return 'invalid-image-shape'
	if (options.reconstructionMode === 'drizzle' && frame.image.metadata.bayer !== undefined) return 'bayer-image-requires-cfa-drizzle'
	if (options.reconstructionMode === 'cfaDrizzle' && (frame.image.metadata.channels !== 1 || frame.image.metadata.bayer === undefined)) return 'cfa-image-required'
	return undefined
}

// Prepares identity geometry before allocation, then deposits the reference into a private state.
// Returns undefined for an unrepresentable footprint; allocation errors leave the live owner empty.
function initializeDrizzleReference(frame: StackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions) {
	const { width, height } = frame.image.metadata
	const { scale, pixfrac, maxMemoryBytes } = options.drizzle
	const outputWidth = Math.round(width * scale)
	const outputHeight = Math.round(height * scale)
	// An overflowing requested grid is an allocation error, not a failed geometric registration.
	if (!Number.isSafeInteger(outputWidth * outputHeight) || !(outputWidth > 0 && outputHeight > 0)) throw new RangeError('Drizzle grid exceeds safe allocation dimensions')
	const footprint = prepareDrizzleFootprint({ m00: 1, m01: 0, m10: 0, m11: 1, tx: 0, ty: 0 }, outputWidth / width, outputHeight / height, pixfrac, width, height)
	if (footprint === undefined) return undefined
	const cfa = options.reconstructionMode === 'cfaDrizzle'
	const channels = cfa ? 3 : frame.image.metadata.channels
	const sampleBytes = options.samplePrecision === 'auto' ? frame.image.raw.BYTES_PER_ELEMENT : options.samplePrecision / 8
	const state = createDrizzleAccumulator(width, height, channels, cfa, scale, options.keepPerPixelStatistics || options.cropMode === 'intersection' || options.minimumCoverage > 0, options.keepPerPixelStatistics, sampleBytes, maxMemoryBytes)
	const normalization = { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight: resolveFrameWeight(frame, quality, options) }
	depositDrizzle(state, frame.image, footprint, normalization.scales, normalization.offsets, options.combinationMethod === 'weighted-average' ? normalization.weight : 1, 1)
	const diagnostic: FrameAcceptanceResult = { accepted: true, frameIndex, frameId: frame.id, quality, overlapFraction: 1, transform: identityTransformSummary(), normalization }
	return { state, diagnostic }
}

// Registers, checks overlap, normalizes and deposits one target without retaining its pixels.
// Rejections occur before accumulator mutation. Geometry is forward; photometric pairs use its inverse.
function addDrizzleFrame(state: DrizzleAccumulator, reference: StackingFrame, frame: StackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics, acceptedFrames: number, options: ResolvedStackingOptions): FrameAcceptanceResult {
	let reason = drizzleFrameFailure(frame, options)
	let overlapFraction = 0
	let transform: StackingTransformSummary | undefined

	if (reason === undefined && frame.image.metadata.channels !== reference.image.metadata.channels) reason = 'channel-mismatch'
	if (reason === undefined && frame.stars.length < options.minAcceptedStars) reason = 'too-few-stars'
	if (reason === undefined && reference.stars.length < options.minAcceptedStars) reason = 'reference-has-no-stars'
	if (reason === undefined) {
		const registration = registerStars(reference.stars, frame.stars, registrationOptions(options))
		if (!registration.success) reason = stackingRegistrationFailureReason(registration.reason)
		else {
			transform = registration.transform.summary
			const matrix = toAffineMatrix(registration.transform.transform)
			const { width, height } = frame.image.metadata
			const footprint = prepareDrizzleFootprint(matrix, state.scaleX, state.scaleY, options.drizzle.pixfrac, width, height)

			if (footprint === undefined) reason = 'invalid-transform'
			else {
				overlapFraction = drizzleOverlap(matrix, width, height, reference.image.metadata.width, reference.image.metadata.height, state.polygon, state.clipped)
				if (!(overlapFraction > 0)) reason = 'no-overlap'
				else if (overlapFraction < options.minOverlapFraction) reason = 'insufficient-overlap'
				else {
					// Local mode was rejected once in resolveStackingOptions, before any frame was accepted.
					const mode = options.normalizationMode as 'none' | GlobalNormalizationMode
					const normalization = { ...drizzleNormalization(state, reference.image, frame.image, toAffineMatrix(registration.transform.inverseTransform), mode, options.colorHandlingMode), weight: resolveFrameWeight(frame, quality, options) }
					depositDrizzle(state, frame.image, footprint, normalization.scales, normalization.offsets, options.combinationMethod === 'weighted-average' ? normalization.weight : 1, acceptedFrames + 1)
					return { accepted: true, frameIndex, frameId: frame.id, overlapFraction, quality, transform, normalization }
				}
			}
		}
	}

	return { accepted: false, frameIndex, frameId: frame.id, overlapFraction, quality, transform, reason }
}

// Executes Drizzle batch reference selection/diagnostics with the same primitive operations as live.
// Targets are processed in input order after the reference; only one pixel accumulator is retained.
function stackDrizzleFrames(frames: readonly StackingFrame[], qualities: readonly StackingFrameQualityMetrics[], referenceIndex: number, options: ResolvedStackingOptions): StackResult {
	if (referenceIndex < 0) {
		const diagnostics = frames.map((frame, frameIndex): FrameAcceptanceResult => ({ accepted: false, frameIndex, frameId: frame.id, overlapFraction: 0, quality: qualities[frameIndex], reason: drizzleFrameFailure(frame, options) ?? 'too-few-stars' }))
		return emptyStackResult(options, -1, diagnostics)
	}

	const reference = frames[referenceIndex]
	const quality = qualities[referenceIndex]

	const reason = drizzleFrameFailure(reference, options) ?? (!options.allowStarlessReference && reference.stars.length < options.minAcceptedStars ? 'too-few-stars' : undefined)
	if (reason !== undefined) return emptyStackResult(options, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: reference.id, overlapFraction: 0, quality, reason }])

	const initial = initializeDrizzleReference(reference, referenceIndex, quality, options)
	if (initial === undefined) return emptyStackResult(options, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: reference.id, overlapFraction: 0, quality, reason: 'invalid-transform' }])

	const diagnostics = [initial.diagnostic]
	let accepted = 1

	for (let index = 0; index < frames.length; index++) {
		if (index === referenceIndex) continue
		const result = addDrizzleFrame(initial.state, reference, frames[index], index, qualities[index], accepted, options)
		diagnostics.push(result)
		if (result.accepted) accepted++
	}

	return buildDrizzleResult(initial.state, reference, referenceIndex, accepted, diagnostics, options, false)
}

// FITS table and tile-compression structural cards invalidated by a new floating-point image.
const DRIZZLE_STRUCTURE_PATTERN = /^(?:XTENSION|PCOUNT|GCOUNT|TFIELDS|THEAP|T(?:TYPE|FORM|UNIT|NULL|SCAL|ZERO|DISP|DIM|BCOL)\d+|Z(?:IMAGE|CMPTYPE|BITPIX|NAXIS\d*|TILE\d+|NAME\d+|VAL\d+|QUANTIZ|DITHER0|BLANK|SCALE|ZERO|SIMPLE|EXTEND|BLOCKED|PCOUNT|GCOUNT|HECKSUM|DATASUM)|BAYERPAT|BSCALE|BZERO|BLANK|CHECKSUM|DATASUM)$/

// Builds a floating-point image with one cloned header and coherent post-crop metadata. Removes stale
// compression/table cards so writeFits cannot inherit Rice compression for the new float raw.
function buildDrizzleImage(reference: Image, raw: ImageRawType, width: number, height: number, channels: number, scaleX: number, scaleY: number, left: number, top: number): Image {
	const bitpix = raw instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT
	const image = buildImage(raw, reference.header, width, height, channels, bitpix, undefined)
	const { header } = image
	for (const key in header) if (DRIZZLE_STRUCTURE_PATTERN.test(key) || (/^NAXIS\d+$/.test(key) && +key.slice(5) > 2)) delete header[key]
	header.BITPIX = bitpix
	header.NAXIS = channels === 3 ? 3 : 2
	header.NAXIS1 = width
	header.NAXIS2 = height
	if (channels === 3) header.NAXIS3 = 3
	if (header.IMAGEW !== undefined) header.IMAGEW = width
	if (header.IMAGEH !== undefined) header.IMAGEH = height
	scaleAndCropFitsWcs(header, scaleX, scaleY, left, top)
	return image
}

// Builds one pre-crop mask/bounds pass and writes directly into the final raw, avoiding a full-image
// intermediate for intersection. CFA requires positive support in all RGB channels. No valid pixel
// yields no image/bounds, while maps and accepted diagnostics remain available.
function buildDrizzleResult(state: DrizzleAccumulator, reference: StackingFrame, referenceIndex: number, acceptedFrames: number, diagnostics: readonly FrameAcceptanceResult[], options: ResolvedStackingOptions, live: boolean): StackResult {
	const { width, height, channels, weights, weightChannels, coverage, sum } = state
	const mask = new Uint8Array(width * height)
	const threshold = coverageThreshold(acceptedFrames, options)
	let left = width
	let top = height
	let right = -1
	let bottom = -1

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = y * width + x

			if (coverage !== undefined && coverage[p] < threshold) continue
			const w = p * weightChannels

			if (!(weights[w] > 0) || (weightChannels === 3 && !(weights[w + 1] > 0 && weights[w + 2] > 0))) continue
			mask[p] = 1

			left = Math.min(left, x)
			right = Math.max(right, x)
			top = Math.min(top, y)
			bottom = Math.max(bottom, y)
		}
	}

	const bounds: StackBounds | undefined = right < left ? undefined : { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
	let finalImage: Image | undefined

	if (bounds !== undefined) {
		const crop = options.cropMode === 'intersection'
		const outWidth = crop ? bounds.width : width
		const outHeight = crop ? bounds.height : height
		const outLeft = crop ? left : 0
		const outTop = crop ? top : 0
		const raw = makeImageRawTypedArray(options.samplePrecision === 'auto' ? reference.image.raw : options.samplePrecision, outWidth * outHeight * channels)

		for (let y = 0; y < outHeight; y++) {
			for (let x = 0; x < outWidth; x++) {
				const p = (y + outTop) * width + x + outLeft
				if (mask[p] === 0) continue
				const output = (y * outWidth + x) * channels
				for (let channel = 0; channel < channels; channel++) raw[output + channel] = options.combinationMethod === 'sum' ? sum[p * channels + channel] : sum[p * channels + channel] / weights[weightChannels === 3 ? p * 3 + channel : p]
			}
		}

		finalImage = buildDrizzleImage(reference.image, raw, outWidth, outHeight, channels, state.scaleX, state.scaleY, outLeft, outTop)
	}

	return {
		finalImage,
		acceptedFrames,
		rejectedFrames: diagnostics.length - acceptedFrames,
		referenceFrameIndex: referenceIndex,
		effectiveCropBounds: bounds,
		diagnostics: live ? diagnostics.slice() : diagnostics,
		statistics: {
			method: options.combinationMethod,
			reconstructionMode: options.reconstructionMode,
			colorHandlingMode: options.colorHandlingMode,
			normalizationMode: options.normalizationMode,
			weightingMode: options.weightingMode,
			liveExact: true,
			acceptedWeightSum: sumAcceptedWeights(diagnostics),
			minimumCoverage: options.cropMode === 'intersection' ? 1 : options.minimumCoverage,
			drizzle: { scale: options.drizzle.scale, pixfrac: options.drizzle.pixfrac, outputWidth: width, outputHeight: height },
		},
		validityMask: mask,
		coverageMap: options.keepPerPixelStatistics ? (live ? coverage!.slice() : coverage) : undefined,
		weightMap: options.keepPerPixelStatistics ? { width, height, channels: weightChannels, raw: live ? weights.slice() : weights } : undefined,
	}
}
