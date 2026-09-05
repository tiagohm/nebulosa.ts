import { PI } from '../../core/constants'
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
