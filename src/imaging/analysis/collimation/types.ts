import type { EllipseGeometry } from '../../../math/numerical/ellipse.geometry'
import type { Point, Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'
import type { Image, ImageRawType } from '../../model/types'
import type { SeparableSmoothingKernel } from '../../processing/convolution'
import type { ImageAnalysisPlane } from '../plane'
import type { RobustReservoir } from '../robust'

// Contracts for one complete, isolated defocused annulus in a linear normalized image and for
// caller-grouped measurement sequences. Pixel centers are integer coordinates, X right and Y down.
// Results own their storage in the received image frame, ignoring sensor header origins. These
// measure apparent geometry and never diagnose optical collimation itself.

// Explicit selection of one annulus with external background; the image is never mutated.
export interface CollimationAnalysisInput {
	// Normalized linear unstretched image; negative or above-unity samples are allowed.
	readonly image: Image
	// Integer half-open ROI in image pixels, containing one complete annulus and external background.
	readonly area: Readonly<Rect>
	// Point inside the shadow, in image pixels; defaults to the ROI pixel-center midpoint.
	readonly center?: Readonly<Point>
	// Externally established optical-field reference in the same received-image frame.
	readonly field?: CollimationFieldReference
}

// Caller-established field reference; the ROI and sensor midpoints do not imply an optical axis.
export interface CollimationFieldReference {
	// Known reference position in image pixels.
	readonly center: Readonly<Point>
	// Maximum accepted Euclidean distance from the reference, in image pixels.
	readonly maximumDistance: number
}

// Optional controls resolved once with per-property defaults; numerical thresholds are operational.
export interface CollimationAnalysisOptions {
	// Native plane, default auto: mono, RGB green, or CFA green1. No debayering or color mixing.
	readonly plane?: 'auto' | ImageAnalysisPlane
	// Known saturation threshold in the original raw scale; absent means unknown, never assumed 1.
	readonly saturationLevel?: number
	// Gaussian sigma in selected-plane pixels, default 1; zero disables it, maximum capacity 32.
	readonly smoothingSigma?: number
	// Uniform angular sectors, default 360; integer capacity from 12 through 2048.
	readonly angularSamples?: number
	// Minimum accepted sector fraction per boundary, default 0.8, in [0, 1].
	readonly minimumCoverage?: number
	// Maximum circular rejected-sector gap in radians, default PI/3.
	readonly maximumGap?: number
	// Maximum robust boundary RMS in selected-plane pixels, default 0.5.
	readonly maximumEdgeResidual?: number
	// Required annulus signal / measurable background noise, default 8; no noise means no SNR.
	readonly minimumSignalToNoise?: number
	// Optional maximum offset / outer equivalent radius; no universal optical default.
	readonly tolerance?: number
	// Reusable scratch memory; no simultaneous analyses may share it.
	readonly workspace?: CollimationWorkspace
}

// Content failures do not fabricate partial geometry; structural/capacity violations throw at entry.
export type CollimationFailureReason = 'unsupportedPlane' | 'patternNotFound' | 'ambiguousPattern' | 'insufficientBackground' | 'lowSignal' | 'saturated' | 'cropped' | 'unresolvedEdges' | 'insufficientCoverage' | 'fitFailed' | 'inconsistentGeometry'

// Extra interpretation limits, without duplicate failure text or unvalidated confidence scores.
export type CollimationDiagnostic = 'saturationUnknown' | 'noiseUnresolved' | 'fieldReferenceMissing' | 'outsideFieldReference' | 'unstableMeasurement' | 'photometryUnavailable' | 'directionUnresolved'

// Geometric tolerance assessment; these names do not mean optically collimated or miscollimated.
export type CollimationAssessment = 'withinTolerance' | 'outsideTolerance' | 'inconclusive'

// Independent boundary measurement in received-image pixels; no sensor-origin offsets are added.
export interface CollimationBoundaryFit {
	// Canonical ellipse, axes in image pixels and theta in [0, PI), +X toward +Y.
	readonly ellipse: EllipseGeometry
	// sqrt(semiMajor * semiMinor), in received-image pixels.
	readonly equivalentRadius: number
	// Robust normal-distance RMS in received-image pixels.
	readonly rms: number
	// Accepted fraction of the full requested angular grid.
	readonly coverage: number
	// Largest circular gap in accepted angular support, radians.
	readonly maximumGap: number
	// Number of accepted sectors after robust outlier rejection.
	readonly sectors: number
}

// Apparent offset in the received sampling grid; no correction for rectangular pixels or binning.
export interface CollimationGeometry {
	// Obstruction center minus outer center, in image pixels.
	readonly offset: Readonly<Point>
	// Euclidean offset magnitude, in image pixels.
	readonly distance: number
	// Distance divided by the outer equivalent radius, dimensionless.
	readonly normalizedDistance: number
	// Apparent inner/outer equivalent-radius ratio, not a hardware obstruction ratio.
	readonly obstructionRatio: number
	// Resolved direction in [0, TAU), +X toward +Y; omitted when sensitivity cannot resolve it.
	readonly direction?: Angle
}

// Descriptive support and signal measurements; no compound confidence score is computed.
export interface CollimationQuality {
	// Fitted background at the ROI native-plane midpoint, in original normalized raw units.
	readonly background: number
	// External residual normalized MAD in raw units, absent when unresolved.
	readonly backgroundNoise?: number
	// Robust annulus signal above background, in original normalized raw units.
	readonly signal: number
	// Signal / measurable background noise, absent when noise is unresolved.
	readonly signalToNoise?: number
	// Fraction of evaluated annular support that is nonfinite, independent of ROI padding.
	readonly invalidFraction: number
	// Fraction of evaluated annular support saturated at the supplied level; absent when unknown.
	readonly saturatedFraction?: number
	// Outer center relative to an explicit optical-field reference in the received-image frame.
	readonly field: 'withinReference' | 'outsideReference' | 'unknown'
}

// Area-normalized azimuthal brightness variation; it neither measures offset nor identifies a cause.
export interface CollimationPhotometry {
	// 1.4826 * MAD(sector mean brightness) / median brightness, dimensionless.
	readonly relativeVariation: number
	// Fraction of sectors with sufficient usable interior photometric area.
	readonly coverage: number
	// Largest circular photometric support gap in radians.
	readonly maximumGap: number
}

// Paired angular-block deletion sensitivity, not a covariance or confidence interval.
export interface CollimationStability {
	// Maximum change of the complete offset vector on paired block deletion, image pixels.
	readonly offsetSpread: number
	// Maximum change of each replicate vector normalized by that replicate's outer radius.
	readonly normalizedOffsetSpread: number
	// Empirically bounded sampling-resolution floor in image pixels, within the documented domain.
	readonly resolutionFloor: number
}

// Successful apparent annulus geometry; all result objects survive input/workspace reuse intact.
export interface CollimationAnalysisSuccess {
	// Both boundaries and their continuous containment passed content checks.
	readonly success: true
	// Independent copy of the integer half-open ROI in received-image pixels.
	readonly area: Readonly<Rect>
	// Selected mono/RGB/CFA plane; CFA geometry is mapped back by its factor of two.
	readonly plane: ImageAnalysisPlane
	// Outer boundary measurement.
	readonly outer: CollimationBoundaryFit
	// Central shadow boundary measurement, fitted independently.
	readonly obstruction: CollimationBoundaryFit
	// Offset from outer to obstruction center, in the received grid.
	readonly geometry: CollimationGeometry
	// Independent physical-unit signal and support diagnostics.
	readonly quality: CollimationQuality
	// Descriptive annulus photometry, omitted when its interior support is insufficient.
	readonly photometry?: CollimationPhotometry
	// Paired deletion sensitivity, omitted outside its supported domain or if any replicate fails.
	readonly stability?: CollimationStability
	// Present only when the caller supplied a geometric tolerance.
	readonly assessment?: CollimationAssessment
	// Additional interpretation limitations without an optical diagnosis.
	readonly diagnostics: readonly CollimationDiagnostic[]
}

// Expected content failure without partial or fabricated geometry.
export interface CollimationAnalysisFailure {
	// Failure discriminator.
	readonly success: false
	// Observed reason that the two-boundary measurement could not be accepted.
	readonly reason: CollimationFailureReason
	// Independent copy of the half-open ROI in received-image pixels.
	readonly area: Readonly<Rect>
	// Additional interpretation limitations known at failure.
	readonly diagnostics: readonly CollimationDiagnostic[]
}

// Image-content failures are values; structural/capacity violations are entry-point exceptions.
export type CollimationAnalysis = CollimationAnalysisSuccess | CollimationAnalysisFailure

// Optional operational threshold for a caller-grouped comparable sequence.
export interface CollimationSequenceOptions {
	// Maximum temporal vector dispersion divided by median outer radius; absent means no comparison.
	readonly tolerance?: number
}

// Per-input eligibility in original order. Usable frames can still fail the sequence-wide plane,
// radius or numerical compatibility checks; no quantitative summary is fabricated in that case.
export type CollimationSequenceEntry =
	| {
			// Zero-based input position, preserved even when other inputs are excluded.
			readonly index: number
			// This individual frame meets the success, stability and field-position requirements.
			readonly usable: true
	  }
	| {
			// Zero-based input position.
			readonly index: number
			// This input cannot enter quantitative aggregation.
			readonly usable: false
			// The image analyzer could not measure this frame.
			readonly reason: 'analysisFailed'
			// Original image-content failure retained without replacement.
			readonly analysisReason: CollimationFailureReason
	  }
	| {
			// Zero-based input position.
			readonly index: number
			// This input cannot enter quantitative aggregation.
			readonly usable: false
			// Stable individual reason for exclusion; unknown field reference is permitted.
			readonly reason: 'stabilityUnavailable' | 'outsideFieldReference'
	  }

// Cartesian temporal summary; dispersion is descriptive and is never divided by sqrt(frame count).
export interface CollimationSequenceSuccess {
	// At least five usable frames share a supported quantitative summary.
	readonly success: true
	// Individually usable frame count, including offsets pointing in different directions.
	readonly usableCount: number
	// Independent eligibility records in input order, including every excluded frame.
	readonly entries: readonly CollimationSequenceEntry[]
	// Common native plane; orientation, target, focus side and sampling are caller preconditions.
	readonly plane: ImageAnalysisPlane
	// Approximate geometric median of offsets, in common received-image pixels.
	readonly offset: Readonly<Point>
	// Median of usable outer equivalent radii, in image pixels.
	readonly referenceRadius: number
	// Median offset divided by referenceRadius, dimensionless Cartesian components.
	readonly normalizedOffset: Readonly<Point>
	// Norm of the median offset, in image pixels.
	readonly distance: number
	// Norm of normalizedOffset, dimensionless.
	readonly normalizedDistance: number
	// Largest distance of a usable offset from the geometric median, in image pixels.
	readonly dispersion: number
	// Dispersion divided by referenceRadius, dimensionless.
	readonly normalizedDispersion: number
	// Largest input sampling-resolution floor in image pixels; no frame-count scaling.
	readonly resolutionFloor: number
	// Direction in [0, TAU) only when distance > 3*max(dispersion, resolutionFloor).
	readonly direction?: Angle
	// Present only with a caller tolerance; compares normalized dispersion, not optical collimation.
	readonly dispersionExceedsTolerance?: boolean
}

// Sequence failure without a median or zero vector standing in for unavailable measurements.
export interface CollimationSequenceFailure {
	// No quantitative aggregate was supported.
	readonly success: false
	// Insufficient usable frames, or incompatible planes/radii/unsupported numerical median.
	readonly reason: 'insufficientFrames' | 'incompatibleMeasurements'
	// Count that passed individual eligibility, even if collective compatibility failed.
	readonly usableCount: number
	// Independent eligibility records for every input, in original order.
	readonly entries: readonly CollimationSequenceEntry[]
}

// Discriminated temporal result without hidden capture, tracking, registration or acquisition state.
export type CollimationSequence = CollimationSequenceSuccess | CollimationSequenceFailure

// Capacity options for scratch allocation, independent of the active native-plane dimensions.
export interface CollimationWorkspaceOptions {
	// Raw-buffer precision in bits, default 32; must match the received image.
	readonly precision?: 32 | 64
	// Maximum angular samples, default 360 and at most 2048.
	readonly angularSamples?: number
}

// Caller-owned bounded scratch storage. Active regions are reset on reuse; no arrays escape in an
// analysis result. Create through createCollimationWorkspace rather than constructing this manually.
export interface CollimationWorkspace {
	// Maximum ROI width in image pixels, at most 1024.
	readonly width: number
	// Maximum ROI height in image pixels, at most 1024.
	readonly height: number
	// Raw precision, in bits.
	readonly precision: 32 | 64
	// Maximum number of sectors, at most 2048.
	readonly angularCapacity: number
	// Original selected samples, with masked content replaced only internally by zero.
	readonly plane: ImageRawType
	// Background-subtracted plane, retaining its original signed scale.
	readonly signal: ImageRawType
	// Mask-normalized smoothed signal.
	readonly smoothed: ImageRawType
	// Nonaliasing separable-pass intermediate.
	readonly temporary: ImageRawType
	// Original validity weights, zero or one.
	readonly validity: ImageRawType
	// Gaussian-smoothed validity weights.
	readonly support: ImageRawType
	// Original per-pixel bit mask: invalid = 1, saturated = 2.
	readonly mask: Uint8Array
	// Horizontal support mask used by bounded separable dilation.
	readonly horizontalMask: Uint8Array
	// Expanded mask excluding every pixel whose filter support intersects missing content.
	readonly expandedMask: Uint8Array
	// Fixed-memory robust statistics reservoir, reset per operation.
	readonly statistics: RobustReservoir
	// Reusable statistics scratch, capped by the reservoir's maximum population.
	readonly scratch: Float64Array
	// One radial profile at half-plane-pixel spacing, bounded by the ROI diagonal.
	readonly profile: Float64Array
	// Inner edge x coordinates, in active plane pixels.
	readonly innerX: Float64Array
	// Inner edge y coordinates, in active plane pixels.
	readonly innerY: Float64Array
	// Outer edge x coordinates, in active plane pixels.
	readonly outerX: Float64Array
	// Outer edge y coordinates, in active plane pixels.
	readonly outerY: Float64Array
	// Inner edge precision weights; zero for rejected sectors.
	readonly innerWeight: Float64Array
	// Outer edge precision weights; zero for rejected sectors.
	readonly outerWeight: Float64Array
	// Inner boundary sector rejection codes, documented by the edge extractor.
	readonly innerReason: Uint8Array
	// Outer boundary sector rejection codes, documented by the edge extractor.
	readonly outerReason: Uint8Array
	// Cached sine of each active sampling angle.
	readonly sin: Float64Array
	// Cached cosine of each active sampling angle.
	readonly cos: Float64Array
	// One cache owned by this workspace; no global or historical frame cache exists.
	readonly cache: CollimationWorkspaceCache
}

// Small mutable cache updated when the active angular grid or smoothing sigma changes.
export interface CollimationWorkspaceCache {
	// Angular count represented by sin/cos; zero before first use.
	angularSamples: number
	// Sigma in plane pixels associated with kernel, absent before first use.
	sigma?: number
	// Gaussian kernel with support ceil(3*sigma), absent when smoothing is disabled.
	kernel?: SeparableSmoothingKernel
}
