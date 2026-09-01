import type { Point, Rect } from '../../../math/numerical/geometry'
import type { DigitalImage } from '../../model/types'
import type { ScalarSurfaceModel } from '../../processing/surface'
import type { SensorOperatingPoint, SensorPlane, SensorTileOptions } from '../sensor/types'

// Public contracts for deterministic flat-frame analysis in source digital-number units. Coordinates
// use the image origin with inclusive-exclusive rectangles; exposures use seconds, timestamps use Unix
// milliseconds, and no result assigns an optical or electronic cause to measured spatial structure.

// Mono, RGB, or separate non-debayered CFA plane analyzed without a luminance reduction.
export type FlatPlane = SensorPlane | 'green'

// Digital image and metadata that disambiguate CFA phase and camera operating point.
export interface FlatImageContext {
	// Image whose samples preserve source digital numbers.
	readonly image: DigitalImage
	// Offset applied once to metadata.bayer at image coordinate (0,0); omission means it is already local.
	readonly cfaOffset?: readonly [number, number]
	// Known acquisition configuration used for reference and sequence compatibility.
	readonly operatingPoint?: SensorOperatingPoint
}

// Pedestal reference subtracted only for corrected signal and spatial measurements.
export type FlatReference =
	| (FlatImageContext & {
			// Bias master acquired at the same affine digital-number scale.
			readonly kind: 'bias'
	  })
	| (FlatImageContext & {
			// Exposure-matched dark-flat master acquired at the same affine digital-number scale.
			readonly kind: 'darkFlat'
			// Dark-flat exposure duration, seconds.
			readonly exposure: number
	  })

// Descriptive illumination-source configuration attached to a captured frame.
export interface FlatIlluminationSetting {
	// Caller-defined source identifier.
	readonly source?: string
	// Caller-defined source brightness in device-native units.
	readonly brightness?: number
}

// One flat frame and acquisition metadata relevant to comparison or exposure selection.
export interface FlatFrame extends FlatImageContext {
	// Caller-defined frame identifier preserved in results.
	readonly id?: string
	// Exposure duration, seconds.
	readonly exposure?: number
	// Capture timestamp as Unix milliseconds.
	readonly timestamp?: number
	// Caller-defined filter identifier.
	readonly filter?: string
	// Illumination source and brightness setting.
	readonly illumination?: FlatIlluminationSetting
}

// Input for analysis of one already captured flat frame.
export interface FlatAnalysisInput {
	// Flat frame to analyze.
	readonly frame: FlatFrame
	// Optional bias or exposure-matched dark-flat master for corrected measurements.
	readonly reference?: FlatReference
	// Optional row-major per-pixel mask; nonzero pixels are excluded from every plane.
	readonly mask?: Readonly<Uint8Array>
}

// Explicit acceptable signal interval for one plane and measurement basis.
export interface FlatTarget {
	// Whether the interval applies before or after reference subtraction.
	readonly levelMode: 'observed' | 'corrected'
	// Ordered inclusive signal interval in digital numbers.
	readonly range: readonly [minimum: number, maximum: number]
}

// Optional target configuration indexed by physical image plane.
export type FlatPlaneTargets = Readonly<Partial<Record<FlatPlane, FlatTarget>>>

// Known effective observed clipping limits in digital numbers.
export interface FlatEffectiveClipLimits {
	// Effective lower clipping code; omission leaves that side unknown unless storage clipping is seen.
	readonly lower?: number
	// Effective upper clipping code; omission leaves that side unknown unless storage clipping is seen.
	readonly upper?: number
}

// Explicit checks that participate in the single-frame verdict.
export interface FlatQualityCriteria {
	// Acceptable per-plane signal intervals.
	readonly targets?: FlatPlaneTargets
	// Maximum allowed clipped fraction in any plane, side, or supported tile.
	readonly maximumClippedFraction?: number
	// Maximum allowed non-finite fraction in any plane or supported tile.
	readonly maximumNonFiniteFraction?: number
}

// Configuration for single-frame digital flat analysis.
export interface FlatAnalysisOptions {
	// Inclusive-exclusive image region used for clipping and spatial measurements.
	readonly area?: Readonly<Rect>
	// Inclusive-exclusive subregion used for reported signal and target checks; defaults to area.
	readonly targetArea?: Readonly<Rect>
	// Physical planes to analyze; defaults to every plane supported by the image layout.
	readonly planes?: readonly FlatPlane[]
	// Effective observed clipping limits in digital numbers.
	readonly effectiveClip?: FlatEffectiveClipLimits
	// Checks that participate in the transparent acceptance verdict.
	readonly criteria?: FlatQualityCriteria
	// Tile dimensions in output image pixels; defaults are derived from image geometry.
	readonly tile?: Readonly<SensorTileOptions>
	// Symmetric robust rejection threshold in scaled median absolute deviations.
	readonly rejectionSigma?: number
	// Full-resolution spatial maps to retain; none avoids image-sized output allocations.
	readonly maps?: 'none' | 'illumination' | 'residual' | 'all'
	// Optional descriptive profiles and smooth-depression candidates; neither affects the verdict.
	readonly artifacts?: FlatArtifactOptions
}

// Default rejection and allocation policy for flat analysis.
export const DEFAULT_FLAT_ANALYSIS_OPTIONS = {
	rejectionSigma: 4,
	maps: 'none',
} as const satisfies Partial<FlatAnalysisOptions>

// Configuration for optional multiscale smooth-depression candidate detection.
export interface FlatDustDetectionOptions {
	// Three strictly increasing Gaussian dilation scales in output image pixels.
	readonly scales?: readonly [small: number, medium: number, large: number]
	// Minimum fractional attenuation represented by a candidate.
	readonly minimumContrast?: number
	// Minimum connected support area in square output pixels.
	readonly minimumArea?: number
	// Maximum strongest candidates retained per plane.
	readonly maximumCandidates?: number
}

// Default bounded multiscale candidate-detection policy.
export const DEFAULT_FLAT_DUST_DETECTION_OPTIONS = {
	scales: [2, 4, 8],
	minimumContrast: 0.02,
	minimumArea: 16,
	maximumCandidates: 64,
} as const satisfies Required<FlatDustDetectionOptions>

// Optional non-causal spatial inspection products.
export interface FlatArtifactOptions {
	// Retain detrended selected-plane row and column profiles.
	readonly profiles?: boolean
	// Detect smooth dark candidates with defaults or caller-supplied bounded settings.
	readonly dust?: boolean | Partial<FlatDustDetectionOptions>
}

// Robust summary of finite, non-masked samples in one region and plane.
export interface FlatSampleStatistics {
	// Number of finite, non-masked samples reduced.
	readonly count: number
	// Number of plane samples excluded by the per-pixel mask.
	readonly masked: number
	// Number of non-finite, non-masked samples excluded from reductions.
	readonly nonFinite: number
	// Smallest finite retained-population value, in digital numbers.
	readonly minimum?: number
	// Largest finite retained-population value, in digital numbers.
	readonly maximum?: number
	// Arithmetic mean of all finite reduced values, in digital numbers.
	readonly mean?: number
	// Exact or reservoir-approximated median, in digital numbers.
	readonly median?: number
	// Exact or reservoir-approximated median absolute deviation, in digital numbers.
	readonly mad?: number
	// Number of finite samples retained for median and MAD.
	readonly retainedSamples: number
	// True when median and MAD use a bounded sample rather than every finite value.
	readonly approximate: boolean
}

// Clipping measurement for one lower or upper observed limit.
export interface FlatClippingSide {
	// Whether the limit represents effective sensor clipping or only storage capacity.
	readonly source: 'effective' | 'storage'
	// Observed limit in digital numbers.
	readonly limit: number
	// Number of finite, non-masked plane samples touching or crossing the limit.
	readonly count: number
	// Count divided by finite, non-masked plane samples.
	readonly fraction: number
	// Presence is conclusive; absence is conclusive only for an effective limit.
	readonly status: 'present' | 'absent' | 'unknown'
}

// Observed lower and upper clipping measurements when corresponding limits are known.
export interface FlatClipping {
	// Lower-side clipping measurement.
	readonly lower?: FlatClippingSide
	// Upper-side clipping measurement.
	readonly upper?: FlatClippingSide
}

// One spatial tile summarized for one physical image plane.
export interface FlatTile {
	// Inclusive-exclusive tile area in image pixel coordinates.
	readonly area: Readonly<Rect>
	// Statistics before reference subtraction.
	readonly observed: FlatSampleStatistics
	// Statistics after reference subtraction when a reference is available.
	readonly corrected?: FlatSampleStatistics
	// Clipping measured on observed samples only.
	readonly clipping: FlatClipping
}

// Spatial response measurements for one physical image plane.
export interface FlatSpatialAnalysis {
	// Measurement basis used for tile levels and fitted illumination.
	readonly basis: 'observed' | 'corrected'
	// Supported per-tile summaries covering the analysis area.
	readonly tiles: readonly FlatTile[]
	// Ratio of the fifth to ninety-fifth percentile valid tile level.
	readonly uniformity?: number
	// Robust level of disjoint central tiles, in digital numbers.
	readonly centerLevel?: number
	// Robust level of disjoint non-corner edge tiles, in digital numbers.
	readonly edgeLevel?: number
	// Robust level of corner tiles, in digital numbers.
	readonly cornerLevel?: number
	// One minus edgeLevel divided by centerLevel; may be negative.
	readonly edgeFalloff?: number
	// One minus cornerLevel divided by centerLevel; may be negative.
	readonly cornerFalloff?: number
	// Fitted fractional edge-to-edge change along image X and Y axes.
	readonly gradient?: Readonly<Point>
	// Interior maximum of a well-conditioned concave illumination surface, in image pixels.
	readonly illuminationCenter?: Readonly<Point>
	// Dimensionless confidence derived from fit curvature, conditioning, coverage, and residual.
	readonly illuminationCenterConfidence?: number
	// Degree-two scalar illumination model fitted to valid tile centers.
	readonly model?: ScalarSurfaceModel
	// Requested fitted illumination values on the full row-major image-pixel grid over area.
	readonly illuminationMap?: Float32Array
	// Requested sample/illumination minus one values on the full row-major image-pixel grid over area.
	readonly residualMap?: Float32Array
	// Residual-map validity, one for finite unmasked plane samples and zero for unavailable entries.
	readonly residualMapValidity?: Uint8Array
	// Optional static detrended row and column profiles.
	readonly profiles?: FlatProfiles
	// Optional smooth dark-depression candidates without an assigned optical cause.
	readonly dustCandidates?: readonly FlatDustCandidate[]
}

// One detrended axis profile and the robust strength of its supported values.
export interface FlatAxisProfile {
	// Dimensionless residual means in selected-plane row or column order; unsupported entries are zero.
	readonly values: Float32Array
	// One for supported profile entries and zero for entries without finite unmasked samples.
	readonly validity: Uint8Array
	// Scaled median absolute deviation of supported profile values.
	readonly strength?: number
	// Number of supported values retained for the robust strength estimate.
	readonly retainedSamples: number
	// True when strength used bounded sampling rather than every supported entry.
	readonly approximate: boolean
}

// Static surface-detrended profiles for one physical image plane.
export interface FlatProfiles {
	// Profile over selected-plane rows in increasing image Y.
	readonly row: FlatAxisProfile
	// Profile over selected-plane columns in increasing image X.
	readonly column: FlatAxisProfile
}

// One connected multiscale smooth-depression candidate in output image coordinates.
export interface FlatDustCandidate {
	// Response-weighted center in image pixels, with X rightward and Y downward.
	readonly center: Readonly<Point>
	// RMS semi-major support axis in output image pixels.
	readonly semiMajor: number
	// RMS semi-minor support axis in output image pixels.
	readonly semiMinor: number
	// Major-axis angle in image coordinates, radians clockwise in [0, PI).
	readonly angle: number
	// Largest measured fractional attenuation inside the component.
	readonly contrast: number
	// Approximate connected support area in square output pixels.
	readonly supportArea: number
}

// Transparent policy check whose unknown state preserves missing evidence.
export interface FlatCheck {
	// Check result.
	readonly status: 'pass' | 'fail' | 'unknown'
	// Signal basis used by this check when applicable.
	readonly basis?: 'observed' | 'corrected'
	// Worst or representative finite value used by the check.
	readonly value?: number
	// Ordered limits applied by the check.
	readonly limits?: readonly [number, number]
}

// Complete measurements and checks for one physical image plane.
export interface FlatPlaneAnalysis {
	// Physical plane selected before debayering or luminance conversion.
	readonly plane: FlatPlane
	// Observed statistics over targetArea.
	readonly observed: FlatSampleStatistics
	// Corrected statistics over targetArea when a reference is available.
	readonly corrected?: FlatSampleStatistics
	// Observed clipping over the entire analysis area.
	readonly clipping: FlatClipping
	// Per-plane target check over targetArea.
	readonly target: FlatCheck
	// Tile and fitted response measurements over the entire analysis area.
	readonly spatial: FlatSpatialAnalysis
}

// Single-frame verdict derived only from explicitly configured checks.
export interface FlatAssessment {
	// Accepted, rejected, or inconclusive aggregate result.
	readonly verdict: 'accepted' | 'rejected' | 'inconclusive'
	// Aggregate configured target check.
	readonly target: FlatCheck
	// Aggregate configured clipping check.
	readonly clipping: FlatCheck
	// Aggregate configured finite-sample check.
	readonly finiteSamples: FlatCheck
	// Stable diagnostic codes contributing to the verdict.
	readonly reasons: readonly FlatDiagnosticCode[]
}

// Complete analysis of one flat frame.
export interface FlatAnalysis {
	// Caller-defined frame identifier.
	readonly frameId?: string
	// Inclusive-exclusive area used for clipping and spatial measurements.
	readonly area: Readonly<Rect>
	// Inclusive-exclusive area used for signal and target measurements.
	readonly targetArea: Readonly<Rect>
	// Measurements in requested plane order.
	readonly planes: readonly FlatPlaneAnalysis[]
	// Transparent aggregate policy result.
	readonly assessment: FlatAssessment
	// Structured quality and uncertainty diagnostics.
	readonly diagnostics: readonly FlatDiagnostic[]
}

// Stable machine-readable reason emitted by flat or sequence analysis.
export type FlatDiagnosticCode =
	| 'effectiveClipUnknown'
	| 'storageClipping'
	| 'effectiveClipping'
	| 'targetUnavailable'
	| 'targetBelowRange'
	| 'targetAboveRange'
	| 'nonFiniteSamples'
	| 'insufficientSamples'
	| 'pedestalNotRemoved'
	| 'referenceMetadataUnknown'
	| 'illuminationFitFailed'
	| 'illuminationCenterUnknown'
	| 'sequenceMetadataUnknown'
	| 'sequenceDrift'
	| 'sequenceVariation'
	| 'sequenceOutlier'

// Human-readable diagnostic with stable code and optional plane or frame context.
export interface FlatDiagnostic {
	// Diagnostic importance without directly determining acceptance.
	readonly severity: 'info' | 'warning' | 'error'
	// Stable machine-readable reason.
	readonly code: FlatDiagnosticCode
	// Human-readable explanation.
	readonly message: string
	// Physical plane associated with the diagnostic.
	readonly plane?: FlatPlane
	// Zero-based frame index associated with a sequence diagnostic.
	readonly frame?: number
	// Finite measured value associated with the diagnostic.
	readonly value?: number
	// Finite threshold or limit associated with the diagnostic.
	readonly limit?: number
}

// One approved scalar signal measurement used to estimate a subsequent flat exposure.
export interface FlatExposureObservation {
	// Exposure duration, seconds.
	readonly exposure: number
	// Observed or pedestal-corrected level for one explicitly selected plane, in digital numbers.
	readonly level: number
}

// Scalar exposure-estimation input for one explicitly selected physical plane.
export interface FlatExposureInput {
	// One or more approved, non-clipped observations in acquisition order; the final item is current.
	readonly observations: readonly [FlatExposureObservation, ...FlatExposureObservation[]]
	// Whether levels include an unknown pedestal or were reference-corrected.
	readonly levelMode: 'observed' | 'corrected'
	// Ordered inclusive target interval in digital numbers.
	readonly targetRange: readonly [minimum: number, maximum: number]
	// Ordered inclusive allowed exposure interval, seconds.
	readonly exposureRange: readonly [minimum: number, maximum: number]
	// Maximum absolute change from the current exposure, seconds.
	readonly maximumStep?: number
}

// Recommended next exposure and the model used to derive it.
export interface FlatExposureEstimate {
	// Whether to retain, increase, decrease, or accept a range-bound result.
	readonly status: 'accepted' | 'increase' | 'decrease' | 'belowMinimum' | 'aboveMaximum' | 'invalid'
	// Scalar model used for the recommendation.
	readonly method: 'ratio' | 'interpolation' | 'affine' | 'none'
	// Recommended exposure after step and allowed-range limits, seconds.
	readonly recommendedExposure?: number
	// Finite model prediction at recommendedExposure, in digital numbers.
	readonly predictedLevel?: number
	// Structured reasons for invalid or limited estimates.
	readonly diagnostics: readonly FlatDiagnostic[]
}

// Input stack for temporal analysis of three or more nominally homogeneous final flats.
export interface FlatSequenceInput {
	// Frames in acquisition order; exposure-search ramps do not belong in this stack.
	readonly frames: readonly [FlatFrame, FlatFrame, FlatFrame, ...FlatFrame[]]
	// Optional bias or exposure-matched dark-flat master shared by every frame.
	readonly reference?: FlatReference
	// Optional row-major per-pixel exclusion mask shared by every frame.
	readonly mask?: Readonly<Uint8Array>
}

// Explicit compatibility and temporal-stability policy for a flat sequence.
export interface FlatSequenceOptions {
	// Per-frame analysis options; discarded full-resolution maps and artifact products are forbidden.
	readonly analysis?: Partial<Omit<FlatAnalysisOptions, 'maps' | 'artifacts'>>
	// Maximum absolute exposure mismatch, seconds; defaults to numerical equality tolerance.
	readonly exposureTolerance?: number
	// Maximum sensor-temperature spread, degrees Celsius; omission does not require temperature.
	readonly temperatureTolerance?: number
	// Maximum robust fractional signal dispersion across frames.
	readonly maximumSignalVariation?: number
	// Maximum temporal dispersion at any normalized tile coordinate.
	readonly maximumSpatialVariation?: number
	// Maximum temporal dispersion at any normalized row or column coordinate.
	readonly maximumProfileVariation?: number
	// Maximum absolute fractional signal drift per frame index.
	readonly maximumDriftPerFrame?: number
	// Maximum absolute fractional signal drift per elapsed second.
	readonly maximumDriftPerSecond?: number
	// Positive robust score threshold that makes a multivariate frame an outlier.
	readonly outlierSigma?: number
}

// Reduced per-plane frame representation retained by temporal analysis.
export interface FlatSignature {
	// Positive observed or pedestal-corrected robust signal, in digital numbers.
	readonly signal: number
	// Row-major tile levels normalized by signal; NaN marks unavailable support.
	readonly tiles: Float32Array
	// Selected-plane row means normalized by signal and centered on zero.
	readonly rowProfile: Float32Array
	// Selected-plane column means normalized by signal and centered on zero.
	readonly columnProfile: Float32Array
}

// Per-frame temporal result preserving acquisition order and caller identity.
export interface FlatSequenceFrameAnalysis {
	// Zero-based acquisition-order index.
	readonly index: number
	// Caller-defined frame identifier.
	readonly id?: string
	// Result after configured frame, temporal, and outlier checks.
	readonly status: 'accepted' | 'rejected' | 'inconclusive'
	// Stable diagnostic codes explaining rejection or missing evidence.
	readonly reasons: readonly FlatDiagnosticCode[]
}

// Temporal stability measurements for one physical image plane.
export interface FlatSequencePlaneAnalysis {
	// Physical mono, RGB, or CFA plane.
	readonly plane: FlatPlane
	// Signal and signature basis shared by every frame.
	readonly basis: 'observed' | 'corrected'
	// Robust median signal across frames, in digital numbers.
	readonly medianSignal?: number
	// Scaled-MAD signal dispersion divided by absolute median signal.
	readonly signalVariation?: number
	// Worst scaled-MAD dispersion among normalized tile coordinates.
	readonly spatialVariation?: number
	// Worst scaled-MAD dispersion among normalized selected-plane rows.
	readonly rowVariation?: number
	// Worst scaled-MAD dispersion among normalized selected-plane columns.
	readonly columnVariation?: number
	// Signed robust signal slope divided by median signal, per frame index.
	readonly driftPerFrame?: number
	// Signed robust signal slope divided by median signal, per elapsed second.
	readonly driftPerSecond?: number
	// Zero-based frame indices exceeding the configured multivariate score threshold.
	readonly outliers: readonly number[]
}

// Aggregate transparent checks for a final flat sequence.
export interface FlatSequenceAssessment {
	// Accepted, rejected, or inconclusive aggregate result.
	readonly verdict: 'accepted' | 'rejected' | 'inconclusive'
	// Aggregate configured per-frame quality and outlier check.
	readonly frameQuality: FlatCheck
	// Aggregate configured signal-variation and drift check.
	readonly signalStability: FlatCheck
	// Aggregate configured normalized-tile stability check.
	readonly spatialStability: FlatCheck
	// Aggregate configured row and column stability check.
	readonly profileStability: FlatCheck
	// Stable diagnostic codes contributing to the verdict.
	readonly reasons: readonly FlatDiagnosticCode[]
}

// Complete temporal analysis of a nominally homogeneous final flat stack.
export interface FlatSequenceAnalysis {
	// Per-frame results in original acquisition order.
	readonly frames: readonly FlatSequenceFrameAnalysis[]
	// Per-plane temporal metrics in single-frame analysis order.
	readonly planes: readonly FlatSequencePlaneAnalysis[]
	// Transparent aggregate policy result.
	readonly assessment: FlatSequenceAssessment
	// Structured compatibility, stability, and outlier diagnostics.
	readonly diagnostics: readonly FlatDiagnostic[]
}
