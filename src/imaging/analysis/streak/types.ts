import type { Point } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'

// Public contracts for deterministic straight-streak detection in received-image pixel coordinates.
// Pixel coordinates have their origin at the center of the upper-left sample, +X right and +Y down.
// Angles are axial radians in [0, PI); photometry remains in the input image's normalized units.

// Geometry, photometry, and quality measured for one straight luminous trail.
export interface Streak {
	// Canonical first endpoint in received-image pixels; +X wins, with +Y breaking vertical ties.
	readonly start: Readonly<Point>
	// Canonical second endpoint in received-image pixels.
	readonly end: Readonly<Point>
	// Geometric midpoint of the two endpoints, in received-image pixels.
	readonly center: Readonly<Point>
	// Euclidean endpoint separation, in received-image pixels.
	readonly length: number
	// Transverse FWHM of the median trail profile, in received-image pixels; at least one analysis pixel.
	readonly width: number
	// Axial orientation from +X toward +Y, in radians in [0, PI); image Y grows downward.
	readonly angle: Angle
	// Anisotropy in [0, 1] of a uniform segment of this length and width, one minus the ratio of the transverse to the
	// longitudinal variance; one is ideally linear.
	readonly linearity: number
	// Weighted RMS distance of the trail centroids along its length from the fitted line, in received-image pixels.
	readonly rmsResidual: number
	// Fraction, in [0, 1], of the measured blocks along the trail whose signal is significant; stars and other masked
	// sources lying on the trail are not counted against it.
	readonly coverage: number
	// Whether the trail reaches the image border, so its length may be truncated.
	readonly clippedAtBorder: boolean
	// Background-subtracted flux of the trail profile integrated over its length, in image units times pixels.
	readonly flux: number
	// Peak of the median transverse profile above the local background, in image units.
	readonly meanSignal: number
	// Largest background-subtracted centerline sample along the trail, in image units.
	readonly peakSignal: number
	// Detection significance: the median ridge contrast in units of its noise over the whole trail. Always set by the
	// detector; absent for a streak assembled by a caller without a noise measurement.
	readonly snr?: number
	// Fraction of centerline samples at or above the caller's saturation level; absent when no level was given.
	readonly saturationFraction?: number
	// Deterministic bounded quality score in [0, 1], not a physical-class probability.
	readonly confidence: number
}

// Configuration of the streak detector. The detection thresholds are fixed and self-calibrated on each image's noise
// and texture; only the shortest reported trail is configurable.
export interface StreakDetectionOptions {
	// Shortest reported streak, in received-image pixels; at least a few analysis pixels.
	readonly minLength?: number
	// Known saturation level in the normalized sample scale of the image; only fills `saturationFraction`.
	readonly saturationLevel?: number
}

// Defaults of the configurable detector options.
export const DEFAULT_STREAK_DETECTION_OPTIONS: Required<Omit<StreakDetectionOptions, 'saturationLevel'>> = {
	minLength: 40,
}
