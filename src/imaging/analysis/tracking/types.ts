import type { FitsHeader } from '../../../io/formats/fits/fits'
import type { Angle } from '../../../math/units/angle'
import type { Streak } from '../streak/types'

// Contracts for field-wide stellar tracking analysis. Image pixels have their origin at the upper
// left, +X right and +Y down; sky components use local east and north in radians. No image is copied.

// Quality cuts and significance thresholds for measured stellar moments.
export interface TrackingQualityOptions {
	// Minimum detector SNR in the detector's normalized image scale; defaults to 2.
	readonly minSNR?: number
	// Minimum variance-derived trail proxy in pixels; defaults to 0.75.
	readonly minTrail?: number
	// Minimum trail proxy divided by minor-axis Gaussian FWHM; defaults to 0.25.
	readonly minTrailToCrossWidth?: number
	// Minimum significant stars before a field-wide score is assigned; defaults to 5.
	readonly minElongatedStars?: number
	// Optional peak threshold in the source image sample scale; stars at or above it are excluded.
	readonly saturationLevel?: number
}

// Optional measured streaks and image-to-sky calibration for the same received-image raster.
export interface TrackingQualityContext {
	// Measured long streaks; the first 32 corridors are checked for stellar contamination.
	// Supply the strongest detections first when more than 32 are available.
	readonly streaks?: readonly Streak[]
	// TAN/TAN-SIP FITS WCS for this raster. FITS CRPIX is one-based; star coordinates are zero-based.
	readonly wcs?: FitsHeader
	// Row-major image-to-local-tangent matrix [east/X, east/Y, north/X, north/Y], radians/pixel.
	// Used when no WCS is supplied. It may include rotation, reflection and unequal plate scales.
	readonly pixelToSky?: readonly [number, number, number, number]
}

// Local sky-axis measurement for the positive end of the unoriented image major axis.
export interface TrackingSkyQuality {
	// Axial orientation east toward north in [0, PI), radians.
	readonly angle: Angle
	// Median angular trail length in radians.
	readonly medianTrail: Angle
	// Signed east displacement in radians; changing the axial sign reverses both components.
	readonly east: Angle
	// Signed north displacement in radians; changing the axial sign reverses both components.
	readonly north: Angle
}

// Spatial and rejection diagnostics; all counts refer to the supplied star list.
export interface TrackingQualityDiagnostics {
	// Fraction of four image quadrants containing at least two significant elongated stars.
	readonly quadrantCoverage: number
	// Circular standard deviation of doubled axial angles, mapped back to radians.
	readonly angleDispersion?: Angle
	// Stars excluded by SNR, missing/invalid moments, saturation, or streak overlap.
	readonly rejectedStars: number
	// Heuristic flag for substantial elongation with weak alignment or limited field coverage.
	readonly opticalPatternSuspected: boolean
	// Among the first 32 streaks, external trails overlapping fewer than three stellar detections.
	readonly isolatedStreakCount: number
}

// Field-wide tracking measurement. The score is a bounded heuristic, not a calibrated probability.
export interface TrackingQuality {
	// Number of supplied star detections.
	readonly starCount: number
	// Number passing the quality cuts, including round stars.
	readonly usableStarCount: number
	// Significant elongated stars divided by usable stars, in [0, 1].
	readonly elongatedFraction: number
	// Double-angle axial coherence of significant stars, in [0, 1].
	readonly directionCoherence: number
	// Dominant unoriented image axis in [0, PI), radians, when significant stars exist.
	readonly angle?: Angle
	// Median significant-star uniform-line trail proxy, in pixels.
	readonly medianTrail?: number
	// 90th percentile of significant-star trail proxies, in pixels.
	readonly p90Trail?: number
	// Maximum significant-star trail proxy, in pixels.
	readonly maxTrail?: number
	// Median minor-axis Gaussian-equivalent FWHM of usable stars, in pixels.
	readonly medianCrossWidth?: number
	// Bounded [0, 1] evidence of coherent, spatially distributed elongation.
	readonly score: number
	// Sky-axis conversion when an image-to-sky calibration and dominant axis are available.
	readonly sky?: TrackingSkyQuality
	// Counts and field-pattern diagnostics.
	readonly diagnostics: TrackingQualityDiagnostics
}
