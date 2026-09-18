import { PI, PIOVERTWO } from '../../../core/constants'
import type { Point, Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'

// Pure straight-streak geometry in a Cartesian image grid whose X axis points right and Y axis down.
// Functions allocate only their small returned records and never mutate caller-owned points.

// One weighted point used by the analytic 2x2 total-least-squares fit.
export interface WeightedLinePoint extends Point {
	// Non-negative relative contribution to the fit.
	readonly weight: number
}

// Finite weighted total-least-squares line and covariance evidence.
export interface WeightedLineFit {
	// Weighted centroid in the input coordinate system.
	readonly center: Readonly<Point>
	// Canonical axial tangent angle in radians in [0, PI).
	readonly angle: Angle
	// Signed normal-form distance from the input origin, in pixels.
	readonly rho: number
	// Larger weighted covariance eigenvalue, in squared pixels.
	readonly majorVariance: number
	// Smaller weighted covariance eigenvalue, in squared pixels.
	readonly minorVariance: number
	// Normalized anisotropy in [0, 1].
	readonly linearity: number
	// Weighted perpendicular RMS, in pixels.
	readonly rmsResidual: number
}

// Longitudinal relation between two segments after projection onto a common tangent.
export interface SegmentProjectionRelation {
	// Positive unsupported separation, or zero when projections touch or overlap, in pixels.
	readonly gap: number
	// Positive overlap length, or zero for disjoint projections, in pixels.
	readonly overlap: number
}

// Minimal segment geometry required for merge compatibility.
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

// Thresholds used to decide whether two refined fragments may seed a combined refit.
export interface StreakMergeTolerance {
	// Maximum axial angle difference, in radians.
	readonly angle: Angle
	// Maximum longitudinal gap, in pixels.
	readonly gap: number
	// Maximum perpendicular center-line separation, in pixels.
	readonly distance: number
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

// Clips the normal-form line dot(point, normal(angle)) = rho to inclusive pixel centers of a half-open rectangle.
export function clipStreakLineToArea(angle: Angle, rho: number, area: Readonly<Rect>): readonly [Readonly<Point>, Readonly<Point>] | undefined {
	const { tangent, normal } = streakLineVectors(angle)
	const origin = { x: normal.x * rho, y: normal.y * rho }
	const bounds = [area.left, area.right - 1, area.top, area.bottom - 1] as const

	let minimum = Number.NEGATIVE_INFINITY
	let maximum = Number.POSITIVE_INFINITY

	for (let axis = 0; axis < 2; axis++) {
		const position = axis === 0 ? origin.x : origin.y
		const direction = axis === 0 ? tangent.x : tangent.y
		const lower = bounds[axis * 2]
		const upper = bounds[axis * 2 + 1]

		if (Math.abs(direction) <= Number.EPSILON) {
			if (position < lower || position > upper) return undefined
			continue
		}

		let first = (lower - position) / direction
		let second = (upper - position) / direction
		if (first > second) [first, second] = [second, first]
		minimum = Math.max(minimum, first)
		maximum = Math.min(maximum, second)
		if (minimum > maximum) return undefined
	}

	if (!(maximum > minimum)) return undefined

	return canonicalizeStreakEndpoints({ x: origin.x + minimum * tangent.x, y: origin.y + minimum * tangent.y }, { x: origin.x + maximum * tangent.x, y: origin.y + maximum * tangent.y })
}

// Fits a line by weighted PCA of finite points, returning undefined for zero weight or coincident support.
export function fitWeightedStreakLine(points: readonly WeightedLinePoint[]): WeightedLineFit | undefined {
	let weightSum = 0
	let centerX = 0
	let centerY = 0

	for (let i = 0; i < points.length; i++) {
		const point = points[i]

		if (!(point.weight > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue

		weightSum += point.weight
		centerX += point.weight * point.x
		centerY += point.weight * point.y
	}

	if (!(weightSum > 0)) return undefined

	centerX /= weightSum
	centerY /= weightSum

	let xx = 0
	let xy = 0
	let yy = 0

	for (let i = 0; i < points.length; i++) {
		const point = points[i]

		if (!(point.weight > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue

		const x = point.x - centerX
		const y = point.y - centerY
		xx += point.weight * x * x
		xy += point.weight * x * y
		yy += point.weight * y * y
	}

	xx /= weightSum
	xy /= weightSum
	yy /= weightSum

	const discriminant = Math.hypot(xx - yy, 2 * xy)
	const majorVariance = Math.max(0, (xx + yy + discriminant) * 0.5)
	const minorVariance = Math.max(0, (xx + yy - discriminant) * 0.5)

	if (!(majorVariance > 0)) return undefined

	const angle = normalizeStreakAngle(0.5 * Math.atan2(2 * xy, xx - yy))
	const { normal } = streakLineVectors(angle)

	return {
		center: { x: centerX, y: centerY },
		angle,
		rho: centerX * normal.x + centerY * normal.y,
		majorVariance,
		minorVariance,
		linearity: Math.max(0, Math.min(1, 1 - minorVariance / majorVariance)),
		rmsResidual: Math.sqrt(minorVariance),
	}
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

// Tests axial, perpendicular, longitudinal, and broad width compatibility before a combined refit.
export function areStreakSegmentsMergeCompatible(first: StreakSegmentGeometry, second: StreakSegmentGeometry, tolerance: Readonly<StreakMergeTolerance>): boolean {
	if (streakAxialAngleDistance(first.angle, second.angle) > tolerance.angle) return false
	const angle = normalizeStreakAngle(0.5 * Math.atan2(Math.sin(2 * first.angle) + Math.sin(2 * second.angle), Math.cos(2 * first.angle) + Math.cos(2 * second.angle)))
	const { normal } = streakLineVectors(angle)
	const firstCenter = { x: (first.start.x + first.end.x) * 0.5, y: (first.start.y + first.end.y) * 0.5 }
	const secondCenter = { x: (second.start.x + second.end.x) * 0.5, y: (second.start.y + second.end.y) * 0.5 }
	const perpendicular = Math.abs((secondCenter.x - firstCenter.x) * normal.x + (secondCenter.y - firstCenter.y) * normal.y)
	if (perpendicular > Math.max(tolerance.distance, Math.min(first.width, second.width))) return false
	const relation = streakSegmentProjectionRelation(first, second, angle)
	if (relation.gap > tolerance.gap) return false
	const largerWidth = Math.max(first.width, second.width)
	return !(largerWidth > 0) || Math.min(first.width, second.width) / largerWidth >= 0.25
}

// Maps one native-plane coordinate to the corresponding received-image pixel coordinate.
export function streakPlanePointToImage(point: Readonly<Point>, sourceLeft: number, sourceTop: number, step: 1 | 2): Readonly<Point> {
	return { x: sourceLeft + point.x * step, y: sourceTop + point.y * step }
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
