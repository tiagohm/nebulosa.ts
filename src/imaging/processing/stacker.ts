import type { StarMatchingConfig } from '../../astrometry/matching/star.matching'
import { scaleAndCropFitsWcs } from '../../astrometry/wcs/fits.wcs'
import { Bitpix, type FitsHeader } from '../../io/formats/fits/fits'
import { bitpixInBytes } from '../../io/formats/fits/util'
import type { Rect, Size } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import type { StreakClass, StreakClassification, StreakClassificationContext, StreakClassifierOptions } from '../analysis/streak/classification.types'
import { classifyStreaks } from '../analysis/streak/classifier'
import { detectStreaks } from '../analysis/streak/detector'
import { createStreakMask, type StreakMask, type StreakMaskOptions } from '../analysis/streak/mask'
import type { Streak, StreakDetectionOptions } from '../analysis/streak/types'
import type { StreakDetectionWorkspace } from '../analysis/streak/workspace'
import { type Image, type ImageRawPrecision, type ImageRawType, makeImageRawTypedArray, shiftCfaPattern } from '../model/types'
import type { DetectedStar } from '../stars/detector'
import type { SigmaClipCenterMethod, SigmaClipDispersionMethod } from './computation'
import { createDrizzleAccumulator, depositDrizzle, type DrizzleAccumulator, drizzleNormalization, drizzleOverlap, prepareDrizzleFootprint } from './drizzle'
import {
	applyGlobalNormalizationInPlace,
	applyLocalNormalizationInPlace,
	broadcastNormalizationPlanes,
	DEFAULT_LOCAL_NORMALIZATION_OPTIONS,
	type FrameNormalizationSummary,
	fitLocalNormalizationRaw,
	type GlobalNormalizationMode,
	isLocalNormalizationFallback,
	type LocalNormalizationFallbackReason,
	type LocalNormalizationModel,
	type LocalNormalizationOptions,
	localNormalizationFailureReason,
	localNormalizationSummary,
	MIN_GLOBAL_NORMALIZATION_SAMPLES,
	type NormalizationColorMode,
	resolveLocalNormalizationOptions,
	solveGlobalNormalizationPlanes,
} from './normalization'
import { type ImageInterpolationMode, type ImageRegistrationFailureReason, type ImageRegistrationSuccess, registerImage, registerStars, toAffineMatrix, warpImage } from './registration'
import { accumulateSamples, combineStrip, coverageBounds, coverageThreshold as countThreshold, createCombinationScratch, DEFAULT_COMBINATION_PARAMETERS, finalizeOnlineSamples, frameWeight, isOnlineCombinationMethod, resolveCombinationParameters } from './stacking.combination'
import { measureSubframeQuality, type SubframeQualityMetrics } from './subframe.selector'

// Image stacking pipeline: registers a set of frames to a reference using star matching, normalizes
// and weights them, then combines the aligned pixels with a selectable rejection method (average,
// median, sigma-clip, weighted sigma-clip, min/max, winsorized mean, percentile clip). Produces the stacked image plus
// per-frame acceptance diagnostics, coverage, and combination statistics. Drizzle deposits square
// drops without resampling, optionally reconstructing CFA as RGB. Means preserve normalized intensity
// (which may exceed [0,1]); Drizzle sum preserves distributed samples before masking/cropping.
// Optional source-coordinate streak masks exclude kernel support, normalization pairs and drops.

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

// Pixel-combination algorithm applied across the aligned frame stack. weighted-sigma-clip rejects with
// the sigma-clip bounds and averages the retained samples with their frame weights; sigma-clip ignores weights.
export type StackingCombinationMethod = 'sum' | 'average' | 'weighted-average' | 'median' | 'sigma-clip' | 'weighted-sigma-clip' | 'min-max-average' | 'winsorized-mean' | 'percentile-clip-average'

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
	| 'streak-contamination-too-high'

// One input frame: its image, detected stars, and optional identity/weight.
export interface StackingFrame {
	readonly image: Image
	readonly stars: readonly DetectedStar[]
	readonly id?: string | number
	readonly weight?: number
	// Precomputed detections in this image's zero-based pixel centers, x right and y down.
	readonly streaks?: readonly Streak[]
	// Authoritative source-grid rejection mask, even when streaks or class filters are supplied.
	readonly streakMask?: StreakMask
	// Optional classifications in streak order, avoiding duplicate analysis when filtering classes.
	readonly streakClassifications?: readonly StreakClassification[]
	// Optional frame-specific evidence used only when classification policy requires classification.
	readonly streakClassificationContext?: Readonly<StreakClassificationContext>
}

// Opt-in streak analysis; no detector or classifier runs while disabled.
// Mask-aware normalization rejects insufficient finite support with normalization-failed, independently
// of maxMaskedFraction. The floor is 32 pairs per fitted plane, capped by pre-mask finite
// correspondences so complete small or sparse overlaps remain usable in every reconstruction mode.
export interface StackingStreakOptions {
	// Defaults to false, including when only precomputed frame masks are present.
	readonly enabled?: boolean
	// Detection settings used only when neither a mask nor detections were supplied.
	readonly detection?: StreakDetectionOptions
	// Source-pixel dilation and width policy for supplied or detected segments.
	readonly mask?: StreakMaskOptions
	// Classes to mask. Absent means every detection; an empty list preserves all classes.
	readonly classes?: readonly StreakClass[]
	// Minimum classifier confidence in [0,1], distinct from detector confidence; default zero.
	readonly minClassificationConfidence?: number
	// Optional classifier settings; classification runs only when classes or confidence are specified.
	readonly classification?: StreakClassifierOptions
	// Reject a whole frame only when its masked fraction exceeds this optional [0,1] threshold.
	readonly maxMaskedFraction?: number
	// Caller-owned detector workspace reused synchronously; must fit the detector's analysis plane.
	readonly workspace?: StreakDetectionWorkspace
}

// Compact source-grid statistics retained after processing; contains no image or mask buffers.
export interface FrameStreakDiagnostics {
	// Number of supplied or detected streaks before class filtering; zero for a mask alone.
	readonly detectedCount: number
	// Number of excluded input pixels, counting overlaps once.
	readonly maskedPixels: number
	// Excluded fraction of the input image, before interpolation support expansion.
	readonly maskedFraction: number
	// Counts before policy filtering, present only when classifications are available.
	readonly classes?: Readonly<Record<StreakClass, number>>
}

// Ephemeral source analysis. Live stacking retains only the reference mask for photometric pairing.
interface PreparedStackingFrame extends StackingFrame {
	// Mask used by numerical paths; absent when disabled or empty.
	readonly rejectionMask?: Uint8Array
	// Compact diagnostics; absent when disabled or the image shape is invalid.
	readonly streakDiagnostics?: FrameStreakDiagnostics
	// Whether the explicitly configured contamination limit was exceeded.
	readonly streakRejected?: boolean
}

// Selection of the batch reference frame.
export interface BatchReferenceSelection {
	// Selection strategy.
	readonly mode?: BatchReferenceSelectionMode
	// Explicit frame index when mode is 'index'.
	readonly index?: number
}

// Sigma-clip rejection parameters for the 'sigma-clip' and 'weighted-sigma-clip' combinations.
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
	// Source-frame contamination measurements, unaffected by output cropping or registration.
	readonly streaks?: FrameStreakDiagnostics
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
	// Optional localized rejection, disabled by default.
	readonly streaks?: StackingStreakOptions
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
interface ResolvedStackingOptions extends Required<Omit<StackingOptions, 'sigmaClip' | 'minMaxRejection' | 'winsorization' | 'percentileClip' | 'batchReference' | 'matchStarsConfig' | 'localNormalization' | 'drizzle' | 'streaks'>> {
	// Unresolved opt-in analysis settings; ignored unless enabled is true.
	readonly streaks?: StackingStreakOptions
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
	...DEFAULT_COMBINATION_PARAMETERS,
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
		...resolveCombinationParameters(options),
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

// Resolves source analysis once. Supplied masks bypass both detection and classification; their
// dimensions must match the image, otherwise rejection would silently target unrelated pixels.
// Classification arrays correspond to the full detection list, before filtering by caller policy.
function prepareStackingFrame(frame: StackingFrame, options: StackingStreakOptions | undefined): PreparedStackingFrame {
	if (!options?.enabled || !isImageShapeValid(frame.image)) return frame
	const { width, height } = frame.image.metadata
	let mask = frame.streakMask
	const streaks = frame.streaks ?? (mask === undefined ? detectStreaks(frame.image, options.detection, options.workspace) : [])
	let classifications = frame.streakClassifications
	let selected = streaks
	if (mask === undefined && (options.classes !== undefined || options.minClassificationConfidence !== undefined)) {
		classifications ??= classifyStreaks(streaks, { image: frame.image, stars: frame.stars, ...frame.streakClassificationContext }, options.classification)
		// A misaligned classification list could preserve a contaminated trail under another's class.
		if (classifications.length !== streaks.length) throw new RangeError('streak classifications must correspond to the supplied streaks')
		const classified = classifications
		selected = streaks.filter((_streak, index) => (options.classes === undefined || options.classes.includes(classified[index].class)) && classified[index].confidence >= (options.minClassificationConfidence ?? 0))
	}
	if (mask === undefined && selected.length > 0) mask = createStreakMask(width, height, selected, options.mask)
	if (mask !== undefined && (mask.width !== width || mask.height !== height || mask.raw.length !== width * height)) throw new RangeError('streak mask must match the source image dimensions')
	let classes: Record<StreakClass, number> | undefined
	if (classifications !== undefined) {
		classes = { meteor: 0, satellite: 0, airplane: 0, movingObject: 0, trackingFailure: 0, opticalArtifact: 0, sensorArtifact: 0, unknown: 0 }
		for (const classification of classifications) classes[classification.class]++
	}
	const diagnostics: FrameStreakDiagnostics = { detectedCount: streaks.length, maskedPixels: mask?.maskedPixels ?? 0, maskedFraction: mask?.maskedFraction ?? 0, classes }
	// Do not retain classifier evidence or caller-supplied historical images with a live reference.
	return { image: frame.image, stars: frame.stars, id: frame.id, weight: frame.weight, rejectionMask: mask?.maskedPixels ? mask.raw : undefined, streakDiagnostics: diagnostics, streakRejected: options.maxMaskedFraction !== undefined && diagnostics.maskedFraction > options.maxMaskedFraction }
}

// Allocates source-grid validity for reference accumulation; rejection bytes exclude all channels.
function sourceValidity(frame: PreparedStackingFrame): Uint8Array {
	const valid = fullMask(frame.image.metadata.pixelCount)
	if (frame.rejectionMask !== undefined) {
		for (let pixel = 0; pixel < valid.length; pixel++) if (frame.rejectionMask[pixel] !== 0) valid[pixel] = 0
	}
	return valid
}

// Projects stacking registration policy onto the reusable image-registration API.
function registrationOptions(options: ResolvedStackingOptions, outputRaw?: ImageRawType, validityMask?: Uint8Array, rejectionMask?: Uint8Array, referenceRejectionMask?: Uint8Array) {
	return {
		matchStarsConfig: options.matchStarsConfig,
		interpolationMode: options.interpolationMode,
		outputPrecision: options.samplePrecision,
		outputRaw,
		validityMask,
		rejectionMask,
		finitePairSupport: options.normalizationMode !== 'none' && (rejectionMask !== undefined || referenceRejectionMask !== undefined) ? { limit: MIN_GLOBAL_NORMALIZATION_SAMPLES, luminance: options.colorHandlingMode === 'luminance' } : undefined,
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
	return isOnlineCombinationMethod(method)
}

// Geometric reference shared by the live stacks of one field, such as one stack per filter. Every frame
// of such a stack is registered against these stars and resampled onto this grid, while its photometric
// normalization reference is the first frame the stack itself accepts, so frames of one filter are never
// normalized to the brightness of another. The field never changes after it is created.
export interface LiveStackingField {
	// Frame whose pixel grid (width, height, channels and CFA phase) every frame is resampled onto. Its
	// samples are read only when that same image object is added, as the field reference itself.
	readonly image: Image
	// Stars of the field reference, in its zero-based pixel centers, x right and y down.
	readonly stars: readonly DetectedStar[]
}

// Returns the bytes a resampling `LiveStacker` retains for a grid of `width` × `height` pixels of
// `channels` samples of `sampleBytes` (4 or 8) bytes: the Float64 sums and weights, the coverage
// counts, the photometric reference and the reused warp and normalization buffers. A snapshot
// allocates another image of samples, a coverage copy and a validity mask on top of it.
export function liveStackerMemoryBytes(width: number, height: number, channels: number, sampleBytes: number) {
	const pixels = width * height
	return pixels * (channels * 8 + 8 + 4 + channels * sampleBytes * 3 + 2)
}

// Implements live stacking and exposes a batch helper through the same API surface.
export class LiveStacker {
	#options: ResolvedStackingOptions = DEFAULT_STACKING_OPTIONS
	// External geometric reference; absent when the first accepted frame is the field itself.
	#field?: LiveStackingField
	// Photometric reference on the stack grid: the first accepted frame, resampled onto the field when there is one.
	#referenceFrame?: PreparedStackingFrame
	#referenceIndex = -1
	#diagnostics: FrameAcceptanceResult[] = []
	#acceptedFrames = 0
	#rejectedFrames = 0
	#sum?: Float64Array
	#weightSum?: Float64Array
	#coverageMap?: Uint32Array
	#workRaw?: ImageRawType
	#workMask?: Uint8Array
	// Reusable nearest-neighbour resampling the normalization of a frame is measured on.
	#normalizationRaw?: ImageRawType
	#normalizationMask?: Uint8Array
	// Owns Drizzle buffers exclusively; resampling work buffers stay unallocated in this mode.
	#drizzle?: DrizzleAccumulator

	// Creates a stacker whose reference is its first accepted frame, or, with a `field`, a stacker that
	// registers every frame onto that shared grid (see `initialize`).
	constructor(options: StackingOptions = {}, field?: LiveStackingField) {
		this.initialize(options, field)
	}

	// Initializes or reinitializes the live stacker state. With a `field`, which only the resampling
	// reconstruction supports (a `RangeError` otherwise, since drizzle grids are built from their own
	// reference), every frame is registered against the stars of the field and resampled onto its grid,
	// and the first frame accepted becomes the photometric reference only.
	initialize(options: StackingOptions = {}, field?: LiveStackingField) {
		const resolved = resolveStackingOptions(options)
		// A drizzle reconstruction would silently ignore the shared grid.
		if (field !== undefined && resolved.reconstructionMode !== 'resample') throw new RangeError('a live stacking field requires the resample reconstruction')
		this.#options = resolved
		this.#field = field
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
		this.#normalizationRaw = undefined
		this.#normalizationMask = undefined
		this.#drizzle = undefined
	}

	// Adds a single frame to the live stack when the method supports exact incremental updates.
	add(frame: StackingFrame): FrameAcceptanceResult {
		const prepared = prepareStackingFrame(frame, this.#options.streaks)
		const result = this.#add(prepared)
		if (prepared.streakDiagnostics === undefined) return result
		const diagnostic = { ...result, streaks: prepared.streakDiagnostics }
		this.#diagnostics[this.#diagnostics.length - 1] = diagnostic
		return diagnostic
	}

	// Accumulates one prepared frame; incoming masks are not stored in the diagnostic history.
	#add(frame: PreparedStackingFrame): FrameAcceptanceResult {
		const frameIndex = this.#diagnostics.length
		const quality = measureSubframeQuality(frame)

		if (!isImageShapeValid(frame.image)) return this.#reject(frameIndex, frame, quality, 'invalid-image-shape')
		if (frame.streakRejected) return this.#reject(frameIndex, frame, quality, 'streak-contamination-too-high')
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

		if (this.#referenceFrame === undefined && this.#field !== undefined && frame.image !== this.#field.image) return this.#addFirstFieldFrame(this.#field, frame, frameIndex, quality)

		if (this.#referenceFrame === undefined) {
			if (this.#field !== undefined && frame.image.metadata.channels !== this.#field.image.metadata.channels) return this.#reject(frameIndex, frame, quality, 'channel-mismatch')
			if (!this.#options.allowStarlessReference && frame.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'too-few-stars')
			this.#acceptReferenceFrame(this.#field === undefined ? frame : { ...frame, stars: this.#field.stars }, frameIndex, quality)

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

		this.#ensureWorkBuffers(this.#referenceFrame.image.metadata.pixelCount, this.#referenceFrame.image.metadata.channels, this.#referenceFrame.image.raw.BYTES_PER_ELEMENT)
		const registration = registerImage(this.#referenceFrame, frame, registrationOptions(this.#options, this.#workRaw, this.#workMask, frame.rejectionMask, this.#referenceFrame.rejectionMask))
		if (!registration.success) return this.#reject(frameIndex, frame, quality, stackingRegistrationFailureReason(registration.reason))

		const { raw } = registration.image
		const valid = registration.validityMask
		const overlapFraction = registration.coveredPixels / Math.max(valid.length, 1)
		if (overlapFraction <= 0) return this.#reject(frameIndex, frame, quality, 'no-overlap')
		if (overlapFraction < this.#options.minOverlapFraction) return this.#reject(frameIndex, frame, quality, 'insufficient-overlap', overlapFraction, registration.transform.summary)

		const samples = normalizationSamples(frame, this.#referenceFrame, registration, this.#options, this.#normalizationRaw, this.#normalizationMask)

		if (samples.raw !== raw) {
			this.#normalizationRaw = samples.raw
			this.#normalizationMask = samples.valid
		}

		const normalization = computeNormalization(samples, frame, this.#referenceFrame, quality, this.#options)
		if (normalization.transform.kind === 'rejected') return this.#reject(frameIndex, frame, quality, 'normalization-failed', overlapFraction, registration.transform.summary)
		applyNormalizationInPlace(raw, valid, frame.image.metadata.channels, normalization.transform)
		accumulateSamples(this.#referenceFrame.image.metadata.channels, raw, valid, this.#sum!, this.#weightSum!, this.#coverageMap, this.#options.combinationMethod, normalization.summary.weight)

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
	#acceptReferenceFrame(frame: PreparedStackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics) {
		const { channels, pixelCount } = frame.image.metadata
		this.#referenceFrame = frame
		this.#referenceIndex = frameIndex
		this.#acceptedFrames = 1
		this.#sum = new Float64Array(pixelCount * channels)
		this.#weightSum = new Float64Array(pixelCount)
		this.#coverageMap = new Uint32Array(pixelCount)
		this.#workRaw = undefined
		this.#workMask = undefined
		this.#normalizationRaw = undefined
		this.#normalizationMask = undefined
		const weight = resolveFrameWeight(frame, quality, this.#options)
		accumulateSamples(channels, frame.image.raw, sourceValidity(frame), this.#sum, this.#weightSum, this.#coverageMap, this.#options.combinationMethod, weight)
	}

	// Records a structured rejection result. `overlapFraction` defaults to 0 for the failures that happen
	// before registration measures any coverage; a frame dropped after a successful registration passes
	// the coverage it actually had, so the diagnostics stay distinguishable from a no-overlap frame.
	// `transform` is the fitted summary when registration succeeded before the rejection.
	#reject(frameIndex: number, frame: StackingFrame, quality: StackingFrameQualityMetrics, reason: FrameRejectionReason, overlapFraction = 0, transform?: StackingTransformSummary): FrameAcceptanceResult {
		this.#rejectedFrames++
		const result: FrameAcceptanceResult = transform === undefined ? { accepted: false, frameIndex, frameId: frame.id, overlapFraction, quality, reason } : { accepted: false, frameIndex, frameId: frame.id, overlapFraction, quality, reason, transform }
		this.#diagnostics.push(result)
		return result
	}

	// Reuses registration output buffers between live add calls, for a grid of `pixels` with `channels`
	// samples each of `byteLength` bytes in the source.
	#ensureWorkBuffers(pixels: number, channels: number, byteLength: number) {
		const samplePrecision = this.#options.samplePrecision === 'auto' ? byteLength * 8 : this.#options.samplePrecision
		const ImageType = samplePrecision === 64 ? Float64Array : Float32Array
		const length = pixels * channels
		if (this.#workRaw === undefined || this.#workRaw.length !== length || this.#workRaw.BYTES_PER_ELEMENT !== ImageType.BYTES_PER_ELEMENT) this.#workRaw = new ImageType(length)
		if (this.#workMask === undefined || this.#workMask.length !== pixels) this.#workMask = new Uint8Array(pixels)
	}

	// Accepts the first frame of a stack on an external field, which is not the field reference itself:
	// it is registered against the field and resampled onto its grid, and its nearest-neighbour samples,
	// NaN where it does not cover the grid, become the photometric reference of the stack. Nothing is
	// retained when the frame is rejected. Its own contribution is the interpolated resampling with an
	// identity normalization.
	#addFirstFieldFrame(field: LiveStackingField, frame: PreparedStackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics): FrameAcceptanceResult {
		const { width, height, channels, pixelCount, bayer } = field.image.metadata
		if (frame.image.metadata.channels !== channels) return this.#reject(frameIndex, frame, quality, 'channel-mismatch')
		if (frame.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'too-few-stars')
		if (field.stars.length < this.#options.minAcceptedStars) return this.#reject(frameIndex, frame, quality, 'reference-has-no-stars')

		this.#ensureWorkBuffers(pixelCount, channels, field.image.raw.BYTES_PER_ELEMENT)
		const fieldFrame: PreparedStackingFrame = { image: field.image, stars: field.stars }
		const registration = registerImage(fieldFrame, frame, registrationOptions(this.#options, this.#workRaw, this.#workMask, frame.rejectionMask))
		if (!registration.success) return this.#reject(frameIndex, frame, quality, stackingRegistrationFailureReason(registration.reason))

		const { raw } = registration.image
		const valid = registration.validityMask
		const overlapFraction = registration.coveredPixels / Math.max(valid.length, 1)
		if (overlapFraction <= 0) return this.#reject(frameIndex, frame, quality, 'no-overlap')
		if (overlapFraction < this.#options.minOverlapFraction) return this.#reject(frameIndex, frame, quality, 'insufficient-overlap', overlapFraction, registration.transform.summary)

		// The reference keeps the samples of the frame as they are (see normalizationSamples), copied before
		// the warp buffers they may alias are reused.
		const samples = normalizationSamples(frame, fieldFrame, registration, this.#options)
		const reference = createLike(raw, pixelCount * channels)
		reference.set(samples.raw)

		for (let pixel = 0; pixel < pixelCount; pixel++) {
			if (samples.valid[pixel] !== 0) continue
			for (let channel = 0; channel < channels; channel++) reference[pixel * channels + channel] = Number.NaN
		}

		const header: FitsHeader = { ...frame.image.header, NAXIS1: width, NAXIS2: height }
		const image = buildImage(reference, header, width, height, channels, reference instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT, bayer)
		this.#referenceFrame = { image, stars: field.stars, id: frame.id, weight: frame.weight }
		this.#referenceIndex = frameIndex
		this.#acceptedFrames = 1
		this.#sum = new Float64Array(pixelCount * channels)
		this.#weightSum = new Float64Array(pixelCount)
		this.#coverageMap = new Uint32Array(pixelCount)
		const weight = resolveFrameWeight(frame, quality, this.#options)
		accumulateSamples(channels, raw, valid, this.#sum, this.#weightSum, this.#coverageMap, this.#options.combinationMethod, weight)

		const accepted: FrameAcceptanceResult = {
			accepted: true,
			frameIndex,
			frameId: frame.id,
			overlapFraction,
			quality,
			transform: registration.transform.summary,
			normalization: { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight },
		}

		this.#diagnostics.push(accepted)

		return accepted
	}
}

// Executes a full batch stack with deterministic diagnostics.
export function stackFrames(frames: readonly StackingFrame[], options: StackingOptions = {}): StackResult {
	const resolved = resolveStackingOptions(options)
	const prepared: readonly PreparedStackingFrame[] = resolved.streaks?.enabled ? frames.map((frame) => prepareStackingFrame(frame, resolved.streaks)) : frames
	const result = stackPreparedFrames(prepared, resolved)
	if (!resolved.streaks?.enabled) return result
	return { ...result, diagnostics: result.diagnostics.map((diagnostic) => Object.assign({}, diagnostic, { streaks: prepared[diagnostic.frameIndex].streakDiagnostics })) }
}

// Stacks prepared frames without invoking analysis from registration or combination loops.
function stackPreparedFrames(frames: readonly PreparedStackingFrame[], resolved: ResolvedStackingOptions): StackResult {
	if (frames.length === 0) return emptyStackResult(resolved, -1, [])
	const qualities = frames.map(measureSubframeQuality)
	const referenceIndex = selectReferenceFrameIndex(frames, qualities, resolved)
	if (resolved.reconstructionMode !== 'resample') return stackDrizzleFrames(frames, qualities, referenceIndex, resolved)
	if (referenceIndex < 0) {
		const result = frames.map((frame, frameIndex): FrameAcceptanceResult => ({
			accepted: false,
			frameIndex,
			frameId: frame.id,
			overlapFraction: 0,
			quality: qualities[frameIndex],
			reason: frame.streakRejected ? 'streak-contamination-too-high' : !isImageShapeValid(frame.image) ? 'invalid-image-shape' : 'too-few-stars',
		}))
		return emptyStackResult(resolved, -1, result)
	}

	const referenceFrame = frames[referenceIndex]
	if (referenceFrame.streakRejected) return emptyStackResult(resolved, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 0, quality: qualities[referenceIndex], reason: 'streak-contamination-too-high' }])

	if (!isImageShapeValid(referenceFrame.image)) {
		return emptyStackResult(resolved, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 0, quality: qualities[referenceIndex], reason: 'invalid-image-shape' }])
	}

	if (!resolved.allowStarlessReference && referenceFrame.stars.length < resolved.minAcceptedStars) {
		return emptyStackResult(resolved, referenceIndex, [{ accepted: false, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 0, quality: qualities[referenceIndex], reason: 'too-few-stars' }])
	}

	const accepted: AlignedFrame[] = []
	const diagnostics: FrameAcceptanceResult[] = []
	const pixelCount = referenceFrame.image.metadata.pixelCount
	const channels = referenceFrame.image.metadata.channels
	const sampleBasedMethod = !isOnlineCombinationMethod(resolved.combinationMethod)
	const coverageMap = new Uint32Array(pixelCount)
	const sum = new Float64Array(pixelCount * channels)
	const weightSum = new Float64Array(pixelCount)
	const referenceWeight = resolveFrameWeight(referenceFrame, qualities[referenceIndex], resolved)
	const referenceNormalization = { scales: channelArray(channels, 1), offsets: channelArray(channels, 0), weight: referenceWeight }
	const referenceValid = sourceValidity(referenceFrame)
	let acceptedCount = 1
	incrementCoverage(coverageMap, referenceValid)

	if (sampleBasedMethod) {
		accepted.push(makeAlignedReference(referenceFrame, referenceIndex, qualities[referenceIndex], referenceNormalization, sum, weightSum, resolved.combinationMethod))
	} else {
		accumulateSamples(channels, referenceFrame.image.raw, referenceValid, sum, weightSum, undefined, resolved.combinationMethod, referenceWeight)
	}

	diagnostics.push({ accepted: true, frameIndex: referenceIndex, frameId: referenceFrame.id, overlapFraction: 1, quality: qualities[referenceIndex], transform: identityTransformSummary(), normalization: referenceNormalization })
	let acceptedWeightSum = referenceWeight

	for (let i = 0; i < frames.length; i++) {
		if (i === referenceIndex) continue

		const frame = frames[i]
		const quality = qualities[i]

		if (frame.streakRejected) {
			diagnostics.push({ accepted: false, frameIndex: i, frameId: frame.id, overlapFraction: 0, quality, reason: 'streak-contamination-too-high' })
			continue
		}

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

		const registration = registerImage(referenceFrame, frame, registrationOptions(resolved, undefined, undefined, frame.rejectionMask, referenceFrame.rejectionMask))

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
			accumulateSamples(channels, aligned.raw, aligned.valid, sum, weightSum, undefined, resolved.combinationMethod, aligned.weight)
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
function selectReferenceFrameIndex(frames: readonly PreparedStackingFrame[], qualities: readonly StackingFrameQualityMetrics[], options: ResolvedStackingOptions) {
	if (options.batchReference.mode === 'index') {
		if (!(options.batchReference.index >= 0) || options.batchReference.index >= frames.length) throw new RangeError(`reference frame index ${options.batchReference.index} is out of range for ${frames.length} frames`)
		return options.batchReference.index
	}

	if (options.batchReference.mode === 'best-quality') {
		let bestIndex = -1
		let bestScore = -Infinity

		for (let i = 0; i < frames.length; i++) {
			if (frames[i].streakRejected) continue
			if (!isImageShapeValid(frames[i].image)) continue
			if (options.reconstructionMode !== 'resample' && drizzleFrameFailure(frames[i], options) !== undefined) continue
			if (!options.allowStarlessReference && qualities[i].starCount < options.minAcceptedStars) continue

			const score = referenceQualityScore(qualities[i], options.minAcceptedStars, frames[i].streakDiagnostics?.maskedFraction)

			if (score > bestScore) {
				bestScore = score
				bestIndex = i
			}
		}

		if (bestIndex >= 0) return bestIndex
	}

	for (let i = 0; i < frames.length; i++) {
		if (frames[i].streakRejected) continue
		if (!isImageShapeValid(frames[i].image)) continue
		if (options.reconstructionMode !== 'resample' && drizzleFrameFailure(frames[i], options) !== undefined) continue
		if (!options.allowStarlessReference && qualities[i].starCount < options.minAcceptedStars) continue
		return i
	}

	return options.reconstructionMode === 'resample' && !options.streaks?.enabled ? 0 : -1
}

// Creates a stored aligned batch sample for the reference frame.
function makeAlignedReference(frame: PreparedStackingFrame, index: number, quality: StackingFrameQualityMetrics, normalization: FrameNormalizationSummary, sum: Float64Array, weightSum: Float64Array, method: StackingCombinationMethod): AlignedFrame {
	const { pixelCount, channels } = frame.image.metadata
	const raw = frame.image.raw
	const valid = sourceValidity(frame)

	if (isOnlineCombinationMethod(method)) {
		accumulateSamples(channels, raw, valid, sum, weightSum, undefined, method, normalization.weight)
	}

	return { raw, valid, weight: normalization.weight, coveredPixels: pixelCount, index, id: frame.id, quality, normalization, transform: identityTransformSummary() }
}

// Creates an aligned and normalized batch sample against the reference frame grid. Returns undefined
// when a `reject` local-normalization fallback fired, so the caller can drop the frame.
function createAlignedFrame(frame: PreparedStackingFrame, index: number, quality: StackingFrameQualityMetrics, referenceFrame: PreparedStackingFrame, registration: ImageRegistrationSuccess, options: ResolvedStackingOptions): AlignedFrame | undefined {
	const { channels } = referenceFrame.image.metadata
	const { raw } = registration.image
	const valid = registration.validityMask
	const coveredPixels = registration.coveredPixels
	const normalization = computeNormalization(normalizationSamples(frame, referenceFrame, registration, options), frame, referenceFrame, quality, options)
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
	finalizeOnlineSamples(sum, weightSum, coverageMap, referenceFrame.image.metadata.channels, threshold, options.combinationMethod, raw)

	return { image: maybeCropImage(referenceFrame.image, raw, cropBounds, options) }
}

// Finalizes a sample-based batch method.
function finalizeBatchImage(referenceFrame: StackingFrame, options: ResolvedStackingOptions, accepted: readonly AlignedFrame[], coverageMap: Uint32Array) {
	const cropBounds = computeEffectiveCropBounds(referenceFrame.image.metadata.width, referenceFrame.image.metadata.height, coverageMap, accepted.length, options)
	const threshold = coverageThreshold(accepted.length, options)
	const raw = createLike(referenceFrame.image.raw, referenceFrame.image.metadata.pixelCount * referenceFrame.image.metadata.channels)
	combineStrip(accepted, referenceFrame.image.metadata.pixelCount, referenceFrame.image.metadata.channels, coverageMap, threshold, options.combinationMethod, options, raw, createCombinationScratch(accepted.length))

	return { image: maybeCropImage(referenceFrame.image, raw, cropBounds, options) }
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
			readonly reason: LocalNormalizationFallbackReason | 'insufficient-global-samples'
	  }

// The transform to apply plus the compact summary to retain for the frame.
interface ComputedNormalization {
	readonly transform: NormalizationTransform
	readonly summary: FrameNormalizationSummary
}

// Samples of a registered frame on the reference grid that its normalization is measured on.
interface NormalizationSamples {
	// Interleaved samples on the reference grid.
	readonly raw: ImageRawType
	// One byte per reference pixel; nonzero where raw holds a sample of the frame.
	readonly valid: Uint8Array
	// Pre-mask finite pairs per fitted plane, capped as the registration capped them; undefined unless requested.
	readonly availableSamples?: readonly number[]
}

// Returns the samples of a registered frame that its normalization is measured on. Interpolation smooths the noise
// of a resampled frame by an amount that depends on its subpixel phase, which every dispersion-based gain estimator
// reads as a gain (up to 2 for bilinear at half a pixel in both axes), so an interpolated registration is measured
// on a nearest-neighbour resampling through the same inverse transform, which keeps the samples of the frame and the
// overlap of the registration. outputRaw and validityMask are reused when their sizes fit; the registered samples are
// returned as they are when the registration did not interpolate or nothing is normalized.
function normalizationSamples(frame: PreparedStackingFrame, referenceFrame: PreparedStackingFrame, registration: ImageRegistrationSuccess, options: ResolvedStackingOptions, outputRaw?: ImageRawType, validityMask?: Uint8Array): NormalizationSamples {
	if (options.normalizationMode === 'none' || options.interpolationMode === 'nearest') return { raw: registration.image.raw, valid: registration.validityMask, availableSamples: registration.finitePairCounts }
	const { pixelCount, channels } = referenceFrame.image.metadata
	const finitePairSupport = registration.finitePairCounts === undefined ? undefined : { limit: MIN_GLOBAL_NORMALIZATION_SAMPLES, luminance: options.colorHandlingMode === 'luminance' }
	const reusable = outputRaw?.length === pixelCount * channels && outputRaw.BYTES_PER_ELEMENT === registration.image.raw.BYTES_PER_ELEMENT && validityMask?.length === pixelCount
	const warped = warpImage(frame.image, referenceFrame.image, registration.transform.inverseTransform, {
		interpolationMode: 'nearest',
		outputPrecision: options.samplePrecision,
		outputRaw: reusable ? outputRaw : undefined,
		validityMask: reusable ? validityMask : undefined,
		rejectionMask: frame.rejectionMask,
		finitePairSupport,
	})
	return { raw: warped.image.raw, valid: warped.validityMask, availableSamples: warped.finitePairCounts }
}

// Computes the normalization of one aligned frame against the reference, measured on its normalization samples and
// applied by the caller to the registered samples.
//
// In `local` mode the global solution is still computed first and reported as `scales`/`offsets`: it is
// the anchor the local model corrects around, and it is what a caller inspecting the summary expects to
// see. A `reject` fallback surfaces here as a `rejected` transform, not as an exception.
// With streak masks, availableSamples holds pre-mask finite pairs per fitted plane, capped at 32
// during registration. Each plane must retain that support and contain at least one usable pair.
function computeNormalization(samples: NormalizationSamples, frame: PreparedStackingFrame, referenceFrame: PreparedStackingFrame, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions): ComputedNormalization {
	const { raw: alignedRaw, availableSamples } = samples
	let valid = samples.valid
	const weight = resolveFrameWeight(frame, quality, options)
	const { width, height, channels } = referenceFrame.image.metadata

	if (options.normalizationMode === 'none') {
		const scales = channelArray(channels, 1)
		const offsets = channelArray(channels, 0)
		return { transform: { kind: 'global', scales, offsets }, summary: { scales, offsets, weight } }
	}

	// Pairwise fitting excludes reference contamination without removing clean target contributions
	// at those same positions. The accumulation mask remains owned by the registration output.
	if (referenceFrame.rejectionMask !== undefined) {
		valid = valid.slice()
		for (let pixel = 0; pixel < valid.length; pixel++) if (referenceFrame.rejectionMask[pixel] !== 0) valid[pixel] = 0
	}
	const sampleCounts = availableSamples === undefined ? undefined : []

	if (options.normalizationMode === 'local') {
		const model = fitLocalNormalizationRaw(referenceFrame.image.raw, alignedRaw, width, height, channels, options.colorHandlingMode, valid, options.localNormalization, sampleCounts)
		const { scales, offsets } = broadcastNormalizationPlanes(model.global, channels)
		const summary: FrameNormalizationSummary = { scales, offsets, weight, local: localNormalizationSummary(model) }
		if (availableSamples !== undefined && sampleCounts?.some((count, plane) => count === 0 || count < availableSamples[plane])) return { transform: { kind: 'rejected', reason: 'insufficient-global-samples' }, summary }

		if (options.localNormalization.fallback === 'reject' && isLocalNormalizationFallback(model)) {
			return { transform: { kind: 'rejected', reason: localNormalizationFailureReason(model) ?? 'surface-fit-failed' }, summary }
		}

		return { transform: { kind: 'local', model }, summary }
	}

	const planes = solveGlobalNormalizationPlanes(alignedRaw, valid, referenceFrame.image.raw, channels, width, height, options.normalizationMode, options.colorHandlingMode, sampleCounts)
	const { scales, offsets } = broadcastNormalizationPlanes(planes, channels)
	if (availableSamples !== undefined && sampleCounts?.some((count, plane) => count === 0 || count < availableSamples[plane])) return { transform: { kind: 'rejected', reason: 'insufficient-global-samples' }, summary: { scales, offsets, weight } }
	return { transform: { kind: 'global', scales, offsets }, summary: { scales, offsets, weight } }
}

// Applies a computed transform in place on aligned sample data. A rejected frame is never applied.
function applyNormalizationInPlace(raw: ImageRawType, valid: Uint8Array, channels: number, transform: NormalizationTransform) {
	if (transform.kind === 'global') applyGlobalNormalizationInPlace(raw, valid, channels, transform.scales, transform.offsets)
	else if (transform.kind === 'local') applyLocalNormalizationInPlace(raw, valid, transform.model)
}

// Resolves the deterministic weight attached to one frame.
function resolveFrameWeight(frame: StackingFrame, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions) {
	return frameWeight(frame.weight, quality, options.weightingMode, options.minAcceptedStars)
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
	return coverageBounds(width, height, coverageMap, coverageThreshold(acceptedFrames, options))
}

// Computes the count threshold implied by crop mode and minimum coverage.
function coverageThreshold(acceptedFrames: number, options: ResolvedStackingOptions) {
	return countThreshold(acceptedFrames, options.cropMode, options.minimumCoverage)
}

// Crops the final image for intersection mode while preserving reference metadata shape otherwise.
// The cloned FITS header is rewritten to the cropped raster so NAXIS/CRPIX/CFA match `raw`; coverage
// and validity maps stay on the pre-crop reference grid documented by `StackResult`.
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

	const bayer = shiftCfaPattern(referenceImage.metadata.bayer, cropBounds.left, cropBounds.top)
	const image = buildImage(cropped, referenceImage.header, cropBounds.width, cropBounds.height, referenceImage.metadata.channels, cropped instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT, bayer)
	const { header } = image
	header.NAXIS = referenceImage.metadata.channels === 3 ? 3 : 2
	header.NAXIS1 = cropBounds.width
	header.NAXIS2 = cropBounds.height
	if (referenceImage.metadata.channels === 3) header.NAXIS3 = 3
	else delete header.NAXIS3
	if (header.IMAGEW !== undefined) header.IMAGEW = cropBounds.width
	if (header.IMAGEH !== undefined) header.IMAGEH = cropBounds.height
	if (bayer !== undefined) header.BAYERPAT = bayer
	scaleAndCropFitsWcs(header, 1, 1, cropBounds.left, cropBounds.top)
	return image
}

// Score ranking candidate batch references by best-quality: the quality score, a quarter of it below
// `minAcceptedStars`, reduced by the streak-masked fraction (0..1), minus the background level. Higher
// is better; only frames of one acquisition setup are comparable.
export function referenceQualityScore(quality: StackingFrameQualityMetrics, minAcceptedStars: number, maskedFraction: number = 0) {
	const starPenalty = quality.starCount >= minAcceptedStars ? 1 : 0.25
	return quality.qualityScore * starPenalty * (1 - maskedFraction) - quality.estimatedBackground
}

// FITS table, tile-compression, integer-scaling, and checksum cards invalidated by a new floating-point image.
const STALE_STRUCTURE_PATTERN = /^(?:XTENSION|PCOUNT|GCOUNT|TFIELDS|THEAP|T(?:TYPE|FORM|UNIT|NULL|SCAL|ZERO|DISP|DIM|BCOL)\d+|Z(?:IMAGE|CMPTYPE|BITPIX|NAXIS\d*|TILE\d+|NAME\d+|VAL\d+|QUANTIZ|DITHER0|BLANK|SCALE|ZERO|SIMPLE|EXTEND|BLOCKED|PCOUNT|GCOUNT|HECKSUM|DATASUM)|BSCALE|BZERO|BLANK|CHECKSUM|DATASUM)$/

// Builds a valid Image structure from raw data and metadata pieces. The header is a copy of `header`
// whose BITPIX describes the floating-point raw, without the cards of the source storage, so a writer
// never quantizes the result back to the reference's integer type or compression.
function buildImage(raw: ImageRawType, header: FitsHeader, width: number, height: number, channels: number, bitpix: Bitpix, bayer: Image['metadata']['bayer']): Image {
	const output: FitsHeader = { ...header, BITPIX: bitpix }
	for (const key in output) if (STALE_STRUCTURE_PATTERN.test(key)) delete output[key]

	return {
		header: output,
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
function drizzleFrameFailure(frame: PreparedStackingFrame, options: ResolvedStackingOptions): FrameRejectionReason | undefined {
	if (!isImageShapeValid(frame.image)) return 'invalid-image-shape'
	if (frame.streakRejected) return 'streak-contamination-too-high'
	if (options.reconstructionMode === 'drizzle' && frame.image.metadata.bayer !== undefined) return 'bayer-image-requires-cfa-drizzle'
	if (options.reconstructionMode === 'cfaDrizzle' && (frame.image.metadata.channels !== 1 || frame.image.metadata.bayer === undefined)) return 'cfa-image-required'
	return undefined
}

// Prepares identity geometry before allocation, then deposits the reference into a private state.
// Returns undefined for an unrepresentable footprint; allocation errors leave the live owner empty.
function initializeDrizzleReference(frame: PreparedStackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics, options: ResolvedStackingOptions) {
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
	depositDrizzle(state, frame.image, footprint, normalization.scales, normalization.offsets, options.combinationMethod === 'weighted-average' ? normalization.weight : 1, 1, frame.rejectionMask)
	const diagnostic: FrameAcceptanceResult = { accepted: true, frameIndex, frameId: frame.id, quality, overlapFraction: 1, transform: identityTransformSummary(), normalization }
	return { state, diagnostic }
}

// Registers, checks overlap, normalizes and deposits one target without retaining its pixels.
// Rejections occur before accumulator mutation. Geometry is forward; photometric pairs use its inverse.
function addDrizzleFrame(state: DrizzleAccumulator, reference: PreparedStackingFrame, frame: PreparedStackingFrame, frameIndex: number, quality: StackingFrameQualityMetrics, acceptedFrames: number, options: ResolvedStackingOptions): FrameAcceptanceResult {
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
					const photometry = drizzleNormalization(state, reference.image, frame.image, toAffineMatrix(registration.transform.inverseTransform), mode, options.colorHandlingMode, reference.rejectionMask, frame.rejectionMask)
					if (photometry === undefined) return { accepted: false, frameIndex, frameId: frame.id, overlapFraction, quality, transform, reason: 'normalization-failed' }
					const normalization = { ...photometry, weight: resolveFrameWeight(frame, quality, options) }
					depositDrizzle(state, frame.image, footprint, normalization.scales, normalization.offsets, options.combinationMethod === 'weighted-average' ? normalization.weight : 1, acceptedFrames + 1, frame.rejectionMask)
					return { accepted: true, frameIndex, frameId: frame.id, overlapFraction, quality, transform, normalization }
				}
			}
		}
	}

	return { accepted: false, frameIndex, frameId: frame.id, overlapFraction, quality, transform, reason }
}

// Executes Drizzle batch reference selection/diagnostics with the same primitive operations as live.
// Targets are processed in input order after the reference; only one pixel accumulator is retained.
function stackDrizzleFrames(frames: readonly PreparedStackingFrame[], qualities: readonly StackingFrameQualityMetrics[], referenceIndex: number, options: ResolvedStackingOptions): StackResult {
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

// Builds a floating-point image with one cloned header and coherent post-crop metadata. The CFA pattern
// and higher axes of the source go too, since Drizzle reconstructs a plain mono or RGB raster.
function buildDrizzleImage(reference: Image, raw: ImageRawType, width: number, height: number, channels: number, scaleX: number, scaleY: number, left: number, top: number): Image {
	const bitpix = raw instanceof Float64Array ? Bitpix.DOUBLE : Bitpix.FLOAT
	const image = buildImage(raw, reference.header, width, height, channels, bitpix, undefined)
	const { header } = image
	for (const key in header) if (key === 'BAYERPAT' || (/^NAXIS\d+$/.test(key) && +key.slice(5) > 2)) delete header[key]
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
