import type { Point, Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'
import type { Image, ImageChannelOrGray, ImageRawType } from '../../model/types'

// Public contracts for detecting and describing a Bahtinov diffraction pattern. Coordinates and
// distances use full-image pixel centers, angles are radians, and image inputs remain immutable.

// Image plane used to reduce a normalized image to the mono samples analyzed by the detector.
export type BahtinovPlane = 'auto' | ImageChannelOrGray | 'green1' | 'green2'

// Optional angular prior for a known three-spike mask layout.
export interface BahtinovExpectedPattern {
	// Expected normal angle of the central spike in radians, modulo PI.
	readonly centralNormalAngle: Angle
	// Expected normal angles of the two external spikes in radians, modulo PI.
	readonly externalNormalAngles: readonly [Angle, Angle]
	// Maximum axial difference accepted between detected and expected normals, in radians.
	readonly maximumAngleDelta?: Angle
}

// Analysis request using either an explicit half-open ROI or an approximate center and square size.
export type BahtinovAnalysisInput = {
	// Normalized mono, RGB, or CFA image. The analyzer never mutates it.
	readonly image: Image
	// Optional mask-layout prior used only to rank otherwise supported candidates.
	readonly expected?: BahtinovExpectedPattern
} & (
	| {
			// Half-open full-image ROI `[left, right) x [top, bottom)`.
			readonly area: Readonly<Rect>
			// Optional approximate star center in full-image pixel coordinates.
			readonly center?: Readonly<Point>
			// Disallowed when an explicit area is supplied.
			readonly size?: undefined
	  }
	| {
			// Omitted when the analyzer must construct a square ROI around `center`.
			readonly area?: undefined
			// Approximate star center in full-image pixel coordinates.
			readonly center: Readonly<Point>
			// Requested square ROI side in pixels; defaults to the analyzer ROI size.
			readonly size?: number
	  }
)

// Tunable thresholds and resource controls for one analysis.
export interface BahtinovAnalysisOptions {
	// Image plane or luminance weighting; `auto` selects mono or BT.709.
	readonly plane?: BahtinovPlane
	// Minimum robust spike signal-to-noise ratio.
	readonly minimumSignalToNoise?: number
	// Highest source-sample quantile eligible for background estimation, from 0 to 1.
	readonly backgroundUpperQuantile?: number
	// Normalized sample value considered saturated, from 0 to 1.
	readonly saturationLevel?: number
	// Number of pixels used to dilate saturated support.
	readonly saturationDilation?: number
	// Initial circular core-mask radius in pixels.
	readonly coreRadius?: number
	// Whether a connected saturated core may expand the initial core radius.
	readonly autoCoreRadius?: boolean
	// Monotonic intensity transform applied after background subtraction.
	readonly transform?: 'linear' | 'sqrt' | 'log'
	// Narrow Gaussian sigma of the Difference of Gaussians, in pixels.
	readonly smallBlurSigma?: number
	// Wide Gaussian sigma of the Difference of Gaussians, in pixels.
	readonly largeBlurSigma?: number
	// Robust response threshold in noise-sigma units.
	readonly ridgeSigma?: number
	// Coarse Hough normal-angle step in radians.
	readonly angleStep?: Angle
	// Local normal-angle refinement step in radians.
	readonly refinementStep?: Angle
	// Half-range of local normal-angle refinement in radians.
	readonly refinementRange?: Angle
	// Hough normal-distance bin size in pixels.
	readonly distanceStep?: number
	// Maximum number of angular candidates retained after non-maximum suppression.
	readonly maximumAngleCandidates?: number
	// Maximum number of spatially sampled ridge points.
	readonly maximumRidgePoints?: number
	// Minimum axial separation between distinct spike normals, in radians.
	readonly minimumAxialSeparation?: Angle
	// Maximum central-spike difference from an external-line bisector, in radians.
	readonly maximumBisectorError?: Angle
	// Non-negative pixel margin allowing the external intersection outside the ROI.
	readonly intersectionMargin?: number
	// Minimum relative score separation between the chosen and runner-up triplets, from 0 to 1.
	readonly minimumCandidateSeparation?: number
	// Minimum longitudinal segment coverage, from 0 to 1.
	readonly minimumCoverage?: number
	// Minimum bilateral support balance, from 0 to 1.
	readonly minimumBalance?: number
	// Maximum robust orthogonal line residual in pixels.
	readonly maximumResidual?: number
	// Absolute focus-error tolerance in pixels.
	readonly focusTolerance?: number
	// Maximum uncertainty eligible for discrete focus classification, in pixels.
	readonly maximumUncertainty?: number
	// Confidence interval multiplier applied to focus uncertainty.
	readonly focusSigma?: number
	// Minimum aggregate confidence required for a determinate focus state, from 0 to 1.
	readonly minimumConfidence?: number
	// Whether to snapshot intermediate buffers and candidates.
	readonly includeDebug?: boolean
	// Reusable buffers sized for at least the resolved ROI and search grid.
	readonly workspace?: BahtinovWorkspace
}

// Fitted normal-form line and its measured spike support.
export interface BahtinovLine {
	// Canonical normal angle in `[0, PI)`, in radians.
	readonly normalAngle: Angle
	// Signed normal-form distance from the full-image origin, in pixels.
	readonly distance: number
	// Integrated fitted line strength in normalized image units.
	readonly strength: number
	// Robust line signal-to-noise ratio.
	readonly signalToNoise: number
	// Transverse full width at half maximum in pixels.
	readonly fwhm: number
	// Fraction of the available longitudinal span supported by ridge samples, from 0 to 1.
	readonly coverage: number
	// Weaker-to-stronger longitudinal-arm support ratio, from 0 to 1.
	readonly balance: number
	// Robust orthogonal fit residual in pixels.
	readonly residual: number
	// `[varianceAngle, covarianceAngleDistance, varianceDistance]` when estimable.
	readonly covariance?: readonly [number, number, number]
	// Visible fitted segment clipped to the ROI pixel-center domain.
	readonly segment: readonly [Readonly<Point>, Readonly<Point>]
}

// Normalized evidence components used to form aggregate confidence.
export interface BahtinovQuality {
	// Overall source signal quality, from 0 to 1.
	readonly signal: number
	// Weakest normalized fitted-line strength, from 0 to 1.
	readonly lineStrength: number
	// Weakest longitudinal line coverage, from 0 to 1.
	readonly lineCoverage: number
	// Weakest bilateral support balance, from 0 to 1.
	readonly lineBalance: number
	// Worst normalized line-fit quality, from 0 to 1.
	readonly lineFit: number
	// Agreement of the central normal with an external-line bisector, from 0 to 1.
	readonly angularSymmetry: number
	// Numerical conditioning of the external-line intersection, from 0 to 1.
	readonly intersectionCondition: number
	// Fraction of useful spike support retained after saturation masking, from 0 to 1.
	readonly saturationRetention: number
	// Fraction of the expected line span retained by the ROI, from 0 to 1.
	readonly cropCoverage: number
	// Separation between the chosen triplet score and competing triplets, from 0 to 1.
	readonly candidateSeparation: number
}

// Discrete focus classification after uncertainty and confidence gates.
export type BahtinovFocusState = 'focused' | 'defocused' | 'indeterminate'

// Stable failure reason for image content that cannot produce a trustworthy measurement.
export type BahtinovFailureReason = 'unsupportedPlane' | 'insufficientArea' | 'lowSignal' | 'insufficientSupport' | 'patternNotFound' | 'ambiguousPattern' | 'saturated' | 'illConditioned'

// Stable non-fatal diagnostic code attached to a successful or failed measurement.
export type BahtinovWarningCode = 'backgroundUnstable' | 'coreSaturated' | 'spikesSaturated' | 'patternCropped' | 'lineCoverageLow' | 'lineSupportUnbalanced' | 'lineResidualHigh' | 'intersectionOutsideArea' | 'expectedPatternMismatch' | 'uncertaintyUnavailable' | 'uncertaintyHigh'

// Structured warning whose human-readable text belongs to the caller.
export interface BahtinovWarning {
	// Stable warning identifier.
	readonly code: BahtinovWarningCode
	// Optional finite numeric evidence associated with the warning.
	readonly values?: Readonly<Record<string, number>>
}

// Robust pedestal and noise estimate for the extracted ROI plane.
export interface BahtinovBackground {
	// Estimated normalized background pedestal.
	readonly level: number
	// Normalized median-absolute-deviation noise scale.
	readonly deviation: number
	// Number of finite, unmasked samples used by the estimate.
	readonly sampleCount: number
}

// Reusable structure-of-arrays view of spatially selected ridge samples.
export interface BahtinovRidgePoints {
	// Local ROI x coordinates in pixels; capacity may exceed `count`.
	readonly x: Float32Array
	// Local ROI y coordinates in pixels; capacity may exceed `count`.
	readonly y: Float32Array
	// Non-negative ridge weights; capacity may exceed `count`.
	readonly weight: Float32Array
	// Number of valid entries in the three arrays.
	readonly count: number
}

// Optional immutable snapshot of intermediate analysis evidence.
export interface BahtinovDebugData {
	// Extracted mono ROI before filtering.
	readonly source?: ImageRawType
	// Robust background estimate for the ROI.
	readonly background?: BahtinovBackground
	// Signed Difference-of-Gaussians response.
	readonly response?: ImageRawType
	// Saturation and core exclusion mask.
	readonly mask?: Uint8Array
	// Copied valid ridge samples.
	readonly ridgePoints?: Readonly<{
		// Local ROI x coordinates in pixels.
		readonly x: Float32Array
		// Local ROI y coordinates in pixels.
		readonly y: Float32Array
		// Non-negative ridge weights.
		readonly weight: Float32Array
	}>
	// Best normal-distance score for each coarse normal angle.
	readonly angleScore?: Float64Array
	// Retained line candidates in local or global coordinates documented by the producer.
	readonly peaks?: readonly Readonly<{
		// Candidate normal angle in `[0, PI)`, in radians.
		readonly normalAngle: Angle
		// Candidate normal-form distance in pixels.
		readonly distance: number
		// Normalized candidate score.
		readonly score: number
	}>[]
	// Ranked triplet index combinations.
	readonly triplets?: readonly Readonly<{
		// Candidate index selected as the central spike.
		readonly central: number
		// Candidate indices selected as the two external spikes.
		readonly external: readonly [number, number]
		// Normalized triplet score.
		readonly score: number
	}>[]
}

// Successful finite Bahtinov measurement in full-image coordinates.
export interface BahtinovAnalysisSuccess {
	// Success discriminator.
	readonly success: true
	// Half-open full-image ROI used by the analysis.
	readonly area: Readonly<Rect>
	// Intersection of the two external fitted lines, in full-image pixels.
	readonly reference: Readonly<Point>
	// Fitted central diffraction spike.
	readonly centralLine: BahtinovLine
	// Fitted external diffraction spikes, sorted by canonical normal angle.
	readonly externalLines: readonly [BahtinovLine, BahtinovLine]
	// Signed normal distance from the external intersection to the central line, in pixels.
	readonly error: number
	// Absolute focus error in pixels.
	readonly absoluteError: number
	// Continuous geometric proximity in `[0, 1]`, where 1 is zero error and 0.5 is the tolerance.
	readonly focusProximity: number
	// Propagated one-sigma focus-error uncertainty in pixels, when estimable.
	readonly uncertainty?: number
	// Discrete classification after confidence and uncertainty gates.
	readonly focusState: BahtinovFocusState
	// Aggregate evidence score from 0 to 1; it is not a probability.
	readonly confidence: number
	// Individual normalized evidence components.
	readonly quality: BahtinovQuality
	// Stable non-fatal diagnostics.
	readonly warnings: readonly BahtinovWarning[]
	// Optional copied intermediate evidence.
	readonly debug?: BahtinovDebugData
}

// Content-level analysis failure without fabricated geometry.
export interface BahtinovAnalysisFailure {
	// Failure discriminator.
	readonly success: false
	// Stable reason the pattern could not be measured.
	readonly reason: BahtinovFailureReason
	// Resolved half-open ROI when input validation reached that stage.
	readonly area?: Readonly<Rect>
	// Stable non-fatal diagnostics collected before failure.
	readonly warnings: readonly BahtinovWarning[]
	// Optional copied intermediate evidence.
	readonly debug?: BahtinovDebugData
}

// Discriminated result of one stateless analysis.
export type BahtinovAnalysisResult = BahtinovAnalysisSuccess | BahtinovAnalysisFailure

// Capacity and precision controls for reusable analysis storage.
export interface BahtinovWorkspaceOptions {
	// Floating-point precision of radiometric buffers; defaults to 32 bits.
	readonly precision?: 32 | 64
	// Maximum retained ridge-point capacity.
	readonly maximumRidgePoints?: number
	// Coarse Hough normal-angle step in radians used to size angular buffers.
	readonly angleStep?: Angle
	// Hough normal-distance bin size in pixels used to size the accumulator.
	readonly distanceStep?: number
}

// Reusable buffers for an ROI no larger than `width x height`.
export interface BahtinovWorkspace {
	// Maximum ROI width in pixels.
	readonly width: number
	// Maximum ROI height in pixels.
	readonly height: number
	// Maximum number of retained ridge points.
	readonly maximumRidgePoints: number
	// Coarse angular resolution in radians used to allocate lookup tables.
	readonly angleStep: Angle
	// Normal-distance resolution in pixels used to allocate the accumulator.
	readonly distanceStep: number
	// Number of coarse normal-angle samples.
	readonly angleCount: number
	// Number of normal-distance bins available per angle.
	readonly distanceBinCount: number
	// Largest local normal distance represented by the accumulator, in pixels.
	readonly rhoMax: number
	// Extracted mono ROI.
	readonly source: ImageRawType
	// Separable-convolution intermediate buffer.
	readonly intermediate: ImageRawType
	// Narrow Gaussian response.
	readonly blurredSmall: ImageRawType
	// Wide Gaussian response.
	readonly blurredLarge: ImageRawType
	// Signed Difference-of-Gaussians response.
	readonly response: ImageRawType
	// Reusable scratch for robust statistics.
	readonly statistics: ImageRawType
	// Saturation and core mask.
	readonly mask: Uint8Array
	// Local x coordinates of retained ridge points.
	readonly ridgeX: Float32Array
	// Local y coordinates of retained ridge points.
	readonly ridgeY: Float32Array
	// Weights of retained ridge points.
	readonly ridgeWeight: Float32Array
	// Coarse Hough accumulator.
	readonly accumulator: Float64Array
	// Best score per coarse normal angle.
	readonly angleScore: Float64Array
	// Best normal distance per coarse normal angle.
	readonly angleDistance: Float64Array
	// Sine lookup for coarse normal angles.
	readonly angleSin: Float64Array
	// Cosine lookup for coarse normal angles.
	readonly angleCos: Float64Array
}
