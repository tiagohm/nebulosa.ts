import { PI } from '../../../core/constants'
import type { Point, Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'
import type { ImageAnalysisPlane } from '../plane'

// Public contracts for deterministic straight-streak detection in received-image pixel coordinates.
// Angles are axial radians in [0, PI); photometry remains in the input image's normalized units.

// Geometry, photometry, and quality measured for one approximately straight luminous structure.
export interface Streak {
	// Canonical first endpoint in received-image pixels; +X wins, with +Y breaking vertical ties.
	readonly start: Readonly<Point>
	// Canonical second endpoint in received-image pixels.
	readonly end: Readonly<Point>
	// Geometric midpoint of the two endpoints, in received-image pixels.
	readonly center: Readonly<Point>
	// Euclidean endpoint separation, in received-image pixels.
	readonly length: number
	// Equivalent transverse FWHM derived from flux moments, in received-image pixels.
	readonly width: number
	// Axial orientation from +X toward +Y, in radians in [0, PI); image Y grows downward.
	readonly angle: Angle
	// Covariance anisotropy in [0, 1], where one is ideally linear.
	readonly linearity: number
	// Robust RMS distance from accepted centroids to the fitted axis, in received-image pixels.
	readonly rmsResidual: number
	// Fraction of the endpoint interval containing accepted longitudinal support, in [0, 1].
	readonly coverage: number
	// Number of longitudinal/transverse samples accepted by final refinement.
	readonly supportPixels: number
	// Whether observed support reaches the analysis ROI boundary, so length may be truncated.
	readonly clippedAtBorder: boolean
	// Sum of positive background-subtracted samples in the final corridor, in image units.
	readonly flux: number
	// Mean positive background-subtracted signal among supported samples, in image units.
	readonly meanSignal: number
	// Maximum valid background-subtracted sample in the final corridor, in image units.
	readonly peakSignal: number
	// Background-noise detection SNR; absent when local noise is not measurable.
	readonly snr?: number
	// Fraction of evaluated valid corridor samples at or above the caller's saturation level.
	readonly saturationFraction?: number
	// Deterministic bounded quality score in [0, 1], not a physical-class probability.
	readonly confidence: number
}

// Configuration for native-plane streak detection; pixel distances are in received-image pixels.
export interface StreakDetectionOptions {
	// Native analysis plane; auto selects mono, RGB green, or CFA green1.
	readonly plane?: 'auto' | ImageAnalysisPlane
	// Half-open received-image ROI; the full frame is used when omitted.
	readonly area?: Readonly<Rect>
	// Minimum accepted observed segment length, in received-image pixels.
	readonly minLength?: number
	// Maximum accepted equivalent transverse FWHM, in received-image pixels.
	readonly maxWidth?: number
	// Minimum detection SNR when background noise is measurable.
	readonly minSNR?: number
	// Minimum covariance anisotropy in [0, 1].
	readonly minLinearity?: number
	// Maximum returned detections after merging and duplicate suppression.
	readonly maxStreaks?: number
	// Background-grid cell size in native-plane pixels.
	readonly backgroundCellSize?: number
	// Positive-signal candidate threshold in local background sigmas.
	readonly thresholdSigma?: number
	// Sobel-magnitude candidate threshold in local background sigmas.
	readonly gradientSigma?: number
	// Coarse axial Hough step, in radians.
	readonly angleStep?: Angle
	// Maximum axial difference between a local tangent and a Hough hypothesis, in radians.
	readonly orientationTolerance?: Angle
	// Hough rho-bin spacing in native-plane pixels.
	readonly distanceStep?: number
	// Maximum Hough hypotheses retained for geometric refinement.
	readonly maxCandidates?: number
	// Maximum axial difference for merging collinear fragments, in radians.
	readonly mergeAngleTolerance?: Angle
	// Maximum longitudinal unsupported gap for fragment merging, in received-image pixels.
	readonly mergeGap?: number
	// Maximum perpendicular center-line separation for merging, in received-image pixels.
	readonly mergeDistance?: number
	// Known saturation threshold in the original raw sample scale.
	readonly saturationLevel?: number
	// Whether detections truncated by the ROI boundary may be returned.
	readonly allowBorderClipping?: boolean
}

// Resolved operational defaults; values are algorithm settings rather than physical constants.
export const DEFAULT_STREAK_DETECTION_OPTIONS: Required<Omit<StreakDetectionOptions, 'area' | 'saturationLevel'>> = {
	plane: 'auto',
	minLength: 12,
	maxWidth: 16,
	minSNR: 5,
	minLinearity: 0.8,
	maxStreaks: 32,
	backgroundCellSize: 64,
	thresholdSigma: 2.5,
	gradientSigma: 1.5,
	angleStep: PI / 90,
	orientationTolerance: PI / 36,
	distanceStep: 1,
	maxCandidates: 128,
	mergeAngleTolerance: PI / 90,
	mergeGap: 12,
	mergeDistance: 3,
	allowBorderClipping: true,
}
