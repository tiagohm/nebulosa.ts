import type { Point } from '../../math/numerical/geometry'
import type { Angle } from '../../math/units/angle'
import type { StarProfile } from '../stars/profile'

// Public numeric contracts for single-frame optical-aberration inspection.

// Identifies a scalar star measurement that can be aggregated spatially.
export type AberrationMetric = 'hfd' | 'fwhm' | 'eccentricity' | 'elongation'

// Identifies a profile-level reason that prevents spatial selection.
export type AberrationStarRejectionReason = 'invalidProfile' | 'nonFiniteCoordinate' | 'belowMinimumSNR' | 'saturated' | 'clipped' | 'blended' | 'spatialQuota'

// Identifies why one metric is unavailable or excluded from an aggregation.
export type AberrationMetricRejectionReason = 'unavailable' | 'lowSignal' | 'degenerateShape' | 'outlier'

// Identifies either an axial direction or a scalar metric in per-profile rejection details.
export type AberrationMeasuredQuantity = AberrationMetric | 'orientation'

// Records an exclusion of one measurement without rejecting unrelated profile data.
export interface AberrationMetricRejection {
	// Scalar metric or orientation excluded from a summary.
	readonly metric: AberrationMeasuredQuantity
	// Stable reason for the exclusion.
	readonly reason: AberrationMetricRejectionReason
}

// Encodes a non-localized inspection warning with optional numeric evidence.
export interface AberrationWarning {
	// Stable machine-readable warning identifier.
	readonly code: string
	// Numeric values supporting the warning, expressed in the documented units of their keys.
	readonly values?: Readonly<Record<string, number>>
}

// Identifies a limitation that constrains interpretation of an otherwise valid finding.
export type AberrationLimitationCode = 'singleFrameOnly' | 'insufficientStars' | 'insufficientCoverage' | 'lowOrientationCoherence' | 'missingPhysicalScale' | 'missingCalibration' | 'modelUncertaintyUnavailable'

// Selects an automatically generated spatial layout or caller-provided rectangular regions.
export type AberrationRegionLayout = 'grid' | 'centerAndCorners' | 'centerAndEdges' | 'octagonal' | 'custom'

// Defines one non-overlapping rectangular region in normalized sensor coordinates.
export interface AberrationRegionDefinition {
	// Stable caller-visible region identifier.
	readonly id: string
	// Inclusive normalized left sensor bound in -0.5..0.5.
	readonly left: number
	// Inclusive normalized top sensor bound in -0.5..0.5.
	readonly top: number
	// Exclusive normalized right sensor bound, except at the outer sensor edge.
	readonly right: number
	// Exclusive normalized bottom sensor bound, except at the outer sensor edge.
	readonly bottom: number
}

// Configures generated regions or validates custom normalized rectangles.
export interface AberrationRegionOptions {
	// Generated layout when `regions` is not supplied.
	readonly layout?: AberrationRegionLayout
	// Number of columns for a regular grid.
	readonly columns?: number
	// Number of rows for a regular grid.
	readonly rows?: number
	// Normalized border margin removed from generated layouts, in 0..0.5 sensor units.
	readonly margin?: number
	// Caller-provided non-overlapping normalized rectangles.
	readonly regions?: readonly AberrationRegionDefinition[]
}

// Configures balanced spatial selection after profile-level eligibility checks.
export interface SpatialStarSelectionOptions {
	// Number of balancing columns over the sensor.
	readonly columns?: number
	// Number of balancing rows over the sensor.
	readonly rows?: number
	// Maximum selected profiles per balancing cell.
	readonly maximumPerCell?: number
	// Maximum selected profiles over the full sensor.
	readonly maximumTotal?: number
	// Minimum SNR required for spatial selection.
	readonly minSNR?: number
	// Whether saturated profiles are rejected before quota selection.
	readonly rejectSaturated?: boolean
	// Whether clipped profiles are rejected before quota selection.
	readonly rejectClipped?: boolean
	// Whether blended profiles are rejected before quota selection.
	readonly rejectBlended?: boolean
}

// Configures robust scalar and axial summaries for each spatial region.
export interface AberrationSummaryOptions {
	// Minimum usable scalar samples required to publish a regional median.
	readonly minimumStars?: number
	// Minimum usable oriented samples required to publish an axial direction.
	readonly minimumOrientationStars?: number
	// Minimum eccentricity that makes a profile orientation meaningful.
	readonly minimumOrientationEccentricity?: number
	// Minimum axial coherence required to publish an orientation.
	readonly minimumOrientationCoherence?: number
}

// Configures regular scalar-field cells returned for heatmaps without interpolation.
export interface AberrationFieldOptions {
	// Number of field columns.
	readonly columns?: number
	// Number of field rows.
	readonly rows?: number
	// Minimum usable metric samples required to publish a cell value.
	readonly minimumStars?: number
}

// Carries a profile through normalized sensor coordinates and selection/rejection diagnostics.
export interface AberrationStar {
	// Original optical profile in image pixel coordinates.
	readonly profile: StarProfile
	// Normalized sensor X coordinate in -0.5..0.5.
	readonly u: number
	// Normalized sensor Y coordinate in -0.5..0.5, increasing downward.
	readonly v: number
	// Bounded aggregation weight derived from profile quality, SNR, and shape information.
	readonly weight: number
	// Whether this profile survived profile checks and balanced spatial quota selection.
	readonly selected: boolean
	// Profile-level reasons why the star was not selected.
	readonly selectionReasons: readonly AberrationStarRejectionReason[]
	// Metric-specific exclusions that do not discard unrelated measurements.
	readonly rejections: readonly AberrationMetricRejection[]
}

// Summarizes robust scalar and axial measurements for one normalized sensor region.
export interface AberrationRegionResult {
	// Stable region identifier.
	readonly id: string
	// Normalized rectangle summarized by this result.
	readonly bounds: AberrationRegionDefinition
	// Normalized sensor center of the region.
	readonly center: Readonly<Point>
	// Number of profiles assigned to the region before selection.
	readonly inputStarCount: number
	// Number of usable samples for each scalar metric and orientation.
	readonly usedStarCountByMetric: Readonly<Partial<Record<AberrationMeasuredQuantity, number>>>
	// Bounded support and profile-weight confidence for each published scalar metric.
	readonly confidenceByMetric?: Readonly<Partial<Record<AberrationMetric, number>>>
	// Median half-flux diameter in pixels.
	readonly medianHFD?: number
	// Median Gaussian-equivalent FWHM in pixels.
	readonly medianFWHM?: number
	// Median eccentricity in 0..1.
	readonly medianEccentricity?: number
	// Median major/minor axis ratio.
	readonly medianElongation?: number
	// Scaled MAD of HFD in pixels.
	readonly deviationHFD?: number
	// Scaled MAD of FWHM in pixels.
	readonly deviationFWHM?: number
	// Scaled MAD of eccentricity.
	readonly deviationEccentricity?: number
	// Axial mean orientation in [0, PI), clockwise in image coordinates.
	readonly orientation?: Angle
	// Axial orientation coherence in 0..1.
	readonly orientationCoherence?: number
	// Bounded HFD quality retained as the default regional confidence.
	readonly confidence: number
}

// Provides one vector-ready axial sample without prescribing any rendering format.
export interface AberrationVectorSample {
	// Region center X coordinate in image pixels.
	readonly x: number
	// Region center Y coordinate in image pixels.
	readonly y: number
	// Axial orientation in [0, PI), when coherent enough to publish.
	readonly theta?: Angle
	// Median elongation used as vector magnitude, when available.
	readonly magnitude?: number
	// Axial coherence in 0..1.
	readonly coherence?: number
	// Number of oriented profiles contributing to the vector.
	readonly count: number
}

// Summarizes one regular scalar-field cell for a UI heatmap or numeric export.
export interface AberrationFieldCell {
	// Zero-based field column.
	readonly column: number
	// Zero-based field row.
	readonly row: number
	// Normalized sensor center of the cell.
	readonly center: Readonly<Point>
	// Median scalar metric value when the cell has enough usable profiles.
	readonly value?: number
	// Scaled MAD of the scalar metric when available.
	readonly deviation?: number
	// Number of usable profiles contributing to the cell.
	readonly count: number
	// Bounded cell confidence from support and profile weights.
	readonly confidence: number
}

// Identifies a conservative qualitative pattern inferred from a single image.
export type AberrationFindingKind = 'singleFrameFocusGradient' | 'sensorTiltPattern' | 'fieldCurvature' | 'astigmaticCurvature' | 'backfocusMismatch' | 'fieldDegradation' | 'radialElongation' | 'tangentialElongation' | 'uniformElongation' | 'decenteredPattern' | 'insufficientData' | 'inconclusive'

// Provides one numeric observation used to support a finding.
export interface AberrationEvidence {
	// Stable evidence identifier.
	readonly code: string
	// Measured evidence value.
	readonly value: number
	// Optional comparison or threshold value in the same unit as `value`.
	readonly reference?: number
	// Bounded confidence in this evidence item.
	readonly confidence: number
}

// Publishes a qualified, non-definitive single-frame optical finding.
export interface AberrationFinding {
	// Pattern category inferred from numeric evidence.
	readonly kind: AberrationFindingKind
	// Bounded pattern strength relative to competing explanations.
	readonly likelihood: number
	// Bounded confidence based on coverage and measurement support.
	readonly confidence: number
	// Numeric evidence supporting the pattern.
	readonly evidence: readonly AberrationEvidence[]
	// Interpretation limits that must accompany the finding.
	readonly limitations: readonly AberrationLimitationCode[]
}

// Summarizes input support, coverage, warnings, and usable metric counts for an inspection.
export interface AberrationInspectionQuality {
	// Number of candidates detected when profiles were not supplied by the caller.
	readonly detectedStarCount: number
	// Number of profiles available to the inspection pipeline.
	readonly profiledStarCount: number
	// Number of profiles surviving balanced spatial selection.
	readonly selectedStarCount: number
	// Number of usable profiles for each scalar metric and orientation.
	readonly usedStarCountByMetric: Readonly<Partial<Record<AberrationMeasuredQuantity, number>>>
	// Number of profiles rejected from all scalar metrics or spatial selection.
	readonly fullyRejectedStarCount: number
	// Number of regions with at least one usable HFD sample.
	readonly occupiedRegionCount: number
	// Bounded overall single-frame inspection confidence.
	readonly confidence: number
	// Stable warnings describing insufficient support or degraded data.
	readonly warnings: readonly AberrationWarning[]
}

// Returns all numeric products of a deterministic one-image aberration inspection.
export interface AberrationInspectionResult {
	// Image width in pixels.
	readonly width: number
	// Image height in pixels.
	readonly height: number
	// One discriminated result for every input or detected profile in input order.
	readonly stars: readonly AberrationStar[]
	// Region summaries in requested layout order.
	readonly regions: readonly AberrationRegionResult[]
	// Vector-ready regional orientation samples.
	readonly vectors: readonly AberrationVectorSample[]
	// Support and warning diagnostics.
	readonly quality: AberrationInspectionQuality
	// Conservative findings with mandatory limitations.
	readonly findings: readonly AberrationFinding[]
}
