import type { Point, Rect } from '../../../math/numerical/geometry'
import type { Image, ImageRawType } from '../../model/types'
import type { SeparableSmoothingKernel } from '../../processing/convolution'
import type { ImageAnalysisPlane } from '../plane'
import type { RobustReservoir } from '../robust'

// Contracts for one complete, isolated defocused annulus in a linear normalized image. Pixel centers
// are integer coordinates, X right and Y down. Results use the received image frame, ignoring sensor
// header origins. This measures apparent geometry and never diagnoses optical collimation itself.

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
	// Radial profile support/rejection codes; only its active prefix is used.
	readonly profileMask: Uint8Array
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
