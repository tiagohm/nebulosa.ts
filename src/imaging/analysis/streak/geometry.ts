import { PI, PIOVERTWO } from '../../../core/constants'
import type { Point } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'

// Pure straight-streak geometry in a Cartesian image grid whose X axis points right and Y axis down.
// Functions allocate only their small returned records and never mutate caller-owned points.

// Longitudinal relation between two segments after projection onto a common tangent.
export interface SegmentProjectionRelation {
	// Positive unsupported separation, or zero when projections touch or overlap, in pixels.
	readonly gap: number
	// Positive overlap length, or zero for disjoint projections, in pixels.
	readonly overlap: number
}

// Minimal segment geometry of a projection comparison.
export interface StreakSegmentGeometry {
	// First endpoint in a common pixel coordinate system.
	readonly start: Readonly<Point>
	// Second endpoint in the same coordinate system.
	readonly end: Readonly<Point>
	// Canonical axial orientation in radians.
	readonly angle: Angle
	// Equivalent transverse FWHM in pixels.
	readonly width: number
}

// Normalizes a finite axial orientation to [0, PI).
export function normalizeStreakAngle(angle: Angle): Angle {
	let normalized = angle % PI
	if (normalized < 0) normalized += PI
	return normalized === PI ? 0 : normalized
}

// Returns the unsigned axial separation of two orientations in [0, PI / 2].
export function streakAxialAngleDistance(first: Angle, second: Angle): Angle {
	let delta = Math.abs(normalizeStreakAngle(first) - normalizeStreakAngle(second))
	if (delta > PIOVERTWO) delta = PI - delta
	return delta
}

// Returns unit tangent and left-handed unit normal vectors for an axial image angle.
export function streakLineVectors(angle: Angle): { readonly tangent: Readonly<Point>; readonly normal: Readonly<Point> } {
	const canonical = normalizeStreakAngle(angle)
	const x = Math.cos(canonical)
	const y = Math.sin(canonical)
	return { tangent: { x, y }, normal: { x: -y, y: x } }
}

// Returns the signed longitudinal projection of a point relative to an origin, in pixels.
export function projectStreakPoint(point: Readonly<Point>, origin: Readonly<Point>, angle: Angle): number {
	const { tangent } = streakLineVectors(angle)
	return (point.x - origin.x) * tangent.x + (point.y - origin.y) * tangent.y
}

// Returns the absolute perpendicular distance from a point to a normal-form line, in pixels.
export function streakLineDistance(point: Readonly<Point>, angle: Angle, rho: number): number {
	const { normal } = streakLineVectors(angle)
	return Math.abs(point.x * normal.x + point.y * normal.y - rho)
}

// Computes gap and overlap after projecting two segments onto a common axial orientation.
export function streakSegmentProjectionRelation(first: StreakSegmentGeometry, second: StreakSegmentGeometry, angle: Angle): SegmentProjectionRelation {
	const origin = first.start
	const firstA = projectStreakPoint(first.start, origin, angle)
	const firstB = projectStreakPoint(first.end, origin, angle)
	const secondA = projectStreakPoint(second.start, origin, angle)
	const secondB = projectStreakPoint(second.end, origin, angle)
	const firstMinimum = Math.min(firstA, firstB)
	const firstMaximum = Math.max(firstA, firstB)
	const secondMinimum = Math.min(secondA, secondB)
	const secondMaximum = Math.max(secondA, secondB)

	return {
		gap: Math.max(0, Math.max(firstMinimum, secondMinimum) - Math.min(firstMaximum, secondMaximum)),
		overlap: Math.max(0, Math.min(firstMaximum, secondMaximum) - Math.max(firstMinimum, secondMinimum)),
	}
}

// Orders segment endpoints deterministically toward +X, using +Y for effectively vertical segments.
export function canonicalizeStreakEndpoints(first: Readonly<Point>, second: Readonly<Point>): readonly [Readonly<Point>, Readonly<Point>] {
	const x = second.x - first.x
	const y = second.y - first.y

	return x > 0 || (Math.abs(x) <= Number.EPSILON && y >= 0)
		? [
				{ x: first.x, y: first.y },
				{ x: second.x, y: second.y },
			]
		: [
				{ x: second.x, y: second.y },
				{ x: first.x, y: first.y },
			]
}
