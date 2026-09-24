import { PI } from '../../core/constants'
import { medianBySelectionOf } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'

// Shared principal-axis measurements derived from normalized central second moments in image pixels.

// Describes the finite principal-axis shape implied by a 2D central-moment matrix.
export interface StarMomentShape {
	// Largest central-moment eigenvalue in pixels squared.
	readonly majorVariance?: number
	// Smallest central-moment eigenvalue in pixels squared.
	readonly minorVariance?: number
	// Eccentricity from 0 for round shapes toward 1 for elongated shapes.
	readonly eccentricity?: number
	// Major/minor axis ratio, at least 1.
	readonly elongation?: number
	// Major-axis orientation in [0, PI), measured clockwise in image coordinates because Y grows downward.
	readonly theta?: Angle
}

// Derives principal variances, axial shape, and orientation from normalized central moments.
// Returns an empty object when the moment matrix is non-finite or degenerate.
export function starMomentShape(momentXX: number, momentXY: number, momentYY: number): StarMomentShape {
	if (!Number.isFinite(momentXX) || !Number.isFinite(momentXY) || !Number.isFinite(momentYY)) return {}

	const trace = momentXX + momentYY
	const determinant = momentXX * momentYY - momentXY * momentXY
	const discriminant = Math.max(0, 0.25 * trace * trace - determinant)
	const root = Math.sqrt(discriminant)
	const majorVariance = 0.5 * trace + root
	const minorVariance = 0.5 * trace - root

	if (!(majorVariance > Number.EPSILON) || !(minorVariance > Number.EPSILON)) return {}

	const ratio = minorVariance / majorVariance
	let theta = 0.5 * Math.atan2(2 * momentXY, momentXX - momentYY)
	if (theta < 0) theta += PI

	return {
		majorVariance,
		minorVariance,
		eccentricity: Math.sqrt(Math.max(0, 1 - ratio)),
		elongation: Math.sqrt(1 / ratio),
		theta,
	}
}

// How the elongated stars of one frame are arranged.
// `round` means the median eccentricity is below the round threshold.
// `aligned` means the elongated stars share one axis, the signature of tracking error or wind.
// `mixed` means they are elongated without a shared axis.
// `insufficient` means there are not enough oriented stars to judge.
export type StarShapeAssessment = 'round' | 'aligned' | 'mixed' | 'insufficient'

// One star's shape, as published by detection or by starMomentShape. Missing fields are skipped.
export interface StarShapeSample {
	// Eccentricity from 0 (round) toward 1 (elongated).
	readonly eccentricity?: number
	// Major/minor axis ratio, at least 1.
	readonly elongation?: number
	// Major-axis orientation in radians, meaningful modulo π.
	readonly theta?: Angle
}

// Aggregate shape of a star list.
export interface StarShapeStatistics {
	// Number of samples that carried a finite eccentricity.
	readonly count: number
	// Median eccentricity of those samples.
	readonly medianEccentricity?: number
	// Median elongation of the samples that carried one.
	readonly medianElongation?: number
	// Number of stars elongated enough to vote on orientation.
	readonly orientedCount: number
	// Axial mean orientation in [0, π). Absent when no star voted.
	readonly orientation?: Angle
	// Length of the double-angle mean vector, from 0 (no shared axis) to 1 (one axis).
	readonly coherence?: number
	// Reading of the field.
	readonly assessment: StarShapeAssessment
}

// Options for the aggregate.
export interface StarShapeStatisticsOptions {
	// Median eccentricity below which the field is called round. Defaults to 0.2.
	readonly roundEccentricity?: number
	// Eccentricity a star must reach to vote on orientation. Defaults to 0.05, matching the point at
	// which a moment angle stops being noise.
	readonly minimumOrientationEccentricity?: number
	// Coherence at and above which an elongated field is called aligned. Defaults to 0.6.
	readonly alignedCoherence?: number
	// Oriented stars required before alignment is judged. Defaults to 5.
	readonly minimumOrientedStars?: number
}

// Median of a copied finite list. Undefined when the list is empty.
function median(values: number[]) {
	if (values.length === 0) return undefined
	const buffer = Float64Array.from(values)
	return medianBySelectionOf(buffer, buffer.length)
}

// Folds an axial angle into [0, π).
function axialAngle(theta: number) {
	const turns = theta / PI
	const fraction = turns - Math.floor(turns)
	return fraction * PI
}

// Aggregate eccentricity, elongation, and orientation of a star field.
// Parameters: stars are the measured shapes. options overrides the round, alignment, and sample
// thresholds. Orientation uses the double-angle mean, because a major axis at θ and at θ+π is the
// same line. Returns the medians, the coherence, and an assessment. An empty list is insufficient.
export function starShapeStatistics(stars: readonly StarShapeSample[], options: StarShapeStatisticsOptions = {}): StarShapeStatistics {
	const roundEccentricity = options.roundEccentricity ?? 0.2
	const minimumOrientationEccentricity = options.minimumOrientationEccentricity ?? 0.05
	const alignedCoherence = options.alignedCoherence ?? 0.6
	const minimumOrientedStars = options.minimumOrientedStars ?? 5
	const eccentricities: number[] = []
	const elongations: number[] = []
	let cosine = 0
	let sine = 0
	let orientedCount = 0

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		if (star === undefined) continue
		if (star.eccentricity !== undefined && Number.isFinite(star.eccentricity)) eccentricities.push(star.eccentricity)
		if (star.elongation !== undefined && Number.isFinite(star.elongation)) elongations.push(star.elongation)
		if (star.theta === undefined || !Number.isFinite(star.theta) || star.eccentricity === undefined || !(star.eccentricity >= minimumOrientationEccentricity)) continue
		cosine += Math.cos(2 * star.theta)
		sine += Math.sin(2 * star.theta)
		orientedCount++
	}

	const medianEccentricity = median(eccentricities)
	const medianElongation = median(elongations)
	const coherence = orientedCount > 0 ? Math.hypot(cosine, sine) / orientedCount : undefined
	let orientation: Angle | undefined
	if (orientedCount > 0) {
		const doubled = Math.atan2(sine, cosine)
		orientation = axialAngle(doubled / 2)
		if (orientation < 0) orientation += PI
	}

	let assessment: StarShapeAssessment = 'insufficient'
	if (medianEccentricity !== undefined && medianEccentricity < roundEccentricity) assessment = 'round'
	else if (orientedCount >= minimumOrientedStars && coherence !== undefined) assessment = coherence >= alignedCoherence ? 'aligned' : 'mixed'

	return { count: eccentricities.length, medianEccentricity, medianElongation, orientedCount, orientation, coherence, assessment }
}
