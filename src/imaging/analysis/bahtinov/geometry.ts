import { PI, PIOVERTWO, TAU } from '../../../core/constants'
import { euclideanSquaredDistance, type Point, type Rect } from '../../../math/numerical/geometry'
import type { Angle } from '../../../math/units/angle'

// Geometry primitives for Bahtinov normal-form lines. Public coordinates use full-image pixel
// centers, angles are axial radians modulo PI, and functions return fresh values without mutation.

// Small determinant below which two unit-normal lines are numerically parallel.
const DEFAULT_MINIMUM_INTERSECTION_DETERMINANT = 1e-8

// Tolerance used only to merge duplicate line/rectangle intersections.
const CLIP_POINT_EPSILON = 1e-9

// Minimal normal-form line contract accepted by pure geometric helpers.
export interface BahtinovNormalLine {
	// Normal angle in radians; helpers accepting non-canonical values normalize it.
	readonly normalAngle: Angle
	// Signed normal-form distance from the applicable origin, in pixels.
	readonly distance: number
}

// Finite intersection and conditioning evidence for two normal-form lines.
export interface BahtinovLineIntersection {
	// Intersection point in the same coordinate system as the input distances.
	readonly point: Readonly<Point>
	// Signed determinant of the two unit normals.
	readonly determinant: number
	// Absolute determinant from 0 for parallel to 1 for orthogonal normals.
	readonly condition: number
}

// Focus geometry derived from one central and two external lines.
export interface BahtinovFocusGeometry {
	// Intersection of the two external lines.
	readonly reference: Readonly<Point>
	// Signed normal distance from the external intersection to the central line, in pixels.
	readonly error: number
	// Absolute focus error in pixels.
	readonly absoluteError: number
	// Continuous focus proximity from 0 to 1, with 0.5 at the supplied tolerance.
	readonly focusProximity: number
	// Absolute determinant of the external normals, from 0 to 1.
	readonly intersectionCondition: number
}

// Normalizes an axial line angle to `[0, PI)` while preserving the represented equation.
// `normalAngle` is in radians and `distance` is in pixels. The returned object is fresh.
export function canonicalizeBahtinovLine(normalAngle: Angle, distance: number): BahtinovNormalLine {
	if (!Number.isFinite(normalAngle)) throw new RangeError('normalAngle must be finite')
	if (!Number.isFinite(distance)) throw new RangeError('distance must be finite')

	let angle = normalAngle % TAU
	if (angle < 0) angle += TAU

	let canonicalDistance = distance

	if (angle >= PI) {
		angle -= PI
		canonicalDistance = -canonicalDistance
	}

	if (angle === PI) angle = 0
	return { normalAngle: angle, distance: canonicalDistance }
}

// Computes the unsigned axial separation of two line normals in `[0, PI / 2]`.
// Both input angles are radians and may be outside the canonical range.
export function bahtinovAxialAngleDistance(angleA: Angle, angleB: Angle): Angle {
	if (!Number.isFinite(angleA) || !Number.isFinite(angleB)) throw new RangeError('line angles must be finite')
	let delta = Math.abs(angleA - angleB) % PI
	if (delta > PIOVERTWO) delta = PI - delta
	return delta
}

// Converts a local-ROI normal distance to the equivalent full-image distance.
// `localDistance` and ROI offsets are pixels; `normalAngle` is radians.
export function bahtinovGlobalLineDistance(localDistance: number, normalAngle: Angle, area: Readonly<Rect>): number {
	if (!Number.isFinite(localDistance) || !Number.isFinite(normalAngle)) throw new RangeError('line parameters must be finite')
	validateBahtinovArea(area)
	return localDistance + area.left * Math.cos(normalAngle) + area.top * Math.sin(normalAngle)
}

// Intersects two normal-form lines or returns undefined when their unit normals are too parallel.
// `minimumDeterminant` is dimensionless and must lie in `(0, 1]`.
export function intersectBahtinovLines(first: BahtinovNormalLine, second: BahtinovNormalLine, minimumDeterminant: number = DEFAULT_MINIMUM_INTERSECTION_DETERMINANT): BahtinovLineIntersection | undefined {
	validateNormalLine(first)
	validateNormalLine(second)
	if (!Number.isFinite(minimumDeterminant) || minimumDeterminant <= 0 || minimumDeterminant > 1) throw new RangeError('minimumDeterminant must be in (0, 1]')

	const firstCos = Math.cos(first.normalAngle)
	const firstSin = Math.sin(first.normalAngle)
	const secondCos = Math.cos(second.normalAngle)
	const secondSin = Math.sin(second.normalAngle)
	const determinant = firstCos * secondSin - firstSin * secondCos
	const condition = Math.abs(determinant)
	if (condition < minimumDeterminant) return undefined

	const x = (first.distance * secondSin - firstSin * second.distance) / determinant
	const y = (firstCos * second.distance - first.distance * secondCos) / determinant
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
	return { point: { x, y }, determinant, condition }
}

// Returns the short-arc and perpendicular axial bisectors of two non-parallel line axes.
// Returned angles are radians in `[0, PI)` and are separated by `PI / 2`.
export function bahtinovAxialBisectors(angleA: Angle, angleB: Angle): readonly [Angle, Angle] {
	if (!Number.isFinite(angleA) || !Number.isFinite(angleB)) throw new RangeError('line angles must be finite')
	const first = canonicalizeBahtinovLine(angleA, 0).normalAngle
	const second = canonicalizeBahtinovLine(angleB, 0).normalAngle
	let delta = second - first
	if (delta > PIOVERTWO) delta -= PI
	else if (delta < -PIOVERTWO) delta += PI

	const primary = canonicalizeBahtinovLine(first + delta * 0.5, 0).normalAngle
	const secondary = canonicalizeBahtinovLine(primary + PIOVERTWO, 0).normalAngle
	return [primary, secondary]
}

// Clips an infinite normal-form line to the inclusive pixel-center domain of a half-open ROI.
// Returns the farthest two finite boundary intersections, or undefined when no segment exists.
export function clipBahtinovLineToArea(line: BahtinovNormalLine, area: Readonly<Rect>): readonly [Readonly<Point>, Readonly<Point>] | undefined {
	validateNormalLine(line)
	validateBahtinovArea(area)

	const xMinimum = area.left
	const xMaximum = area.right - 1
	const yMinimum = area.top
	const yMaximum = area.bottom - 1
	const normalX = Math.cos(line.normalAngle)
	const normalY = Math.sin(line.normalAngle)
	const points: Point[] = []

	if (Math.abs(normalY) > Number.EPSILON) {
		addClipPoint(points, xMinimum, (line.distance - normalX * xMinimum) / normalY, xMinimum, xMaximum, yMinimum, yMaximum)
		addClipPoint(points, xMaximum, (line.distance - normalX * xMaximum) / normalY, xMinimum, xMaximum, yMinimum, yMaximum)
	}

	if (Math.abs(normalX) > Number.EPSILON) {
		addClipPoint(points, (line.distance - normalY * yMinimum) / normalX, yMinimum, xMinimum, xMaximum, yMinimum, yMaximum)
		addClipPoint(points, (line.distance - normalY * yMaximum) / normalX, yMaximum, xMinimum, xMaximum, yMinimum, yMaximum)
	}

	if (points.length < 2) return undefined

	let first = points[0]
	let second = points[1]
	let maximumSquaredDistance = euclideanSquaredDistance(first, second)

	for (let i = 0; i < points.length - 1; i++) {
		for (let j = i + 1; j < points.length; j++) {
			const squared = euclideanSquaredDistance(points[i], points[j])
			if (squared > maximumSquaredDistance) {
				first = points[i]
				second = points[j]
				maximumSquaredDistance = squared
			}
		}
	}

	return maximumSquaredDistance > 0
		? [
				{ x: first.x, y: first.y },
				{ x: second.x, y: second.y },
			]
		: undefined
}

// Computes a stable continuous focus-proximity measure from absolute pixel error and tolerance.
// Returns 1 at zero error, 0.5 at the tolerance, and approaches 0 monotonically.
export function bahtinovFocusProximity(absoluteError: number, focusTolerance: number): number {
	if (!Number.isFinite(absoluteError) || absoluteError < 0) throw new RangeError('absoluteError must be finite and non-negative')
	if (!Number.isFinite(focusTolerance) || focusTolerance <= 0) throw new RangeError('focusTolerance must be finite and positive')

	if (absoluteError <= focusTolerance) {
		const ratio = absoluteError / focusTolerance
		return 1 / (1 + ratio)
	}

	const reciprocal = focusTolerance / absoluteError
	return reciprocal / (1 + reciprocal)
}

// Derives finite reference, signed error, proximity, and intersection conditioning from three lines.
// Distances and `focusTolerance` are pixels. Returns undefined for ill-conditioned external lines.
export function computeBahtinovFocusGeometry(central: BahtinovNormalLine, externalFirst: BahtinovNormalLine, externalSecond: BahtinovNormalLine, focusTolerance: number, minimumDeterminant: number = DEFAULT_MINIMUM_INTERSECTION_DETERMINANT): BahtinovFocusGeometry | undefined {
	validateNormalLine(central)
	const intersection = intersectBahtinovLines(externalFirst, externalSecond, minimumDeterminant)
	if (!intersection) return undefined

	const normalX = Math.cos(central.normalAngle)
	const normalY = Math.sin(central.normalAngle)
	const error = normalX * intersection.point.x + normalY * intersection.point.y - central.distance
	const absoluteError = Math.abs(error)
	if (!Number.isFinite(error) || !Number.isFinite(absoluteError)) return undefined
	const focusProximity = bahtinovFocusProximity(absoluteError, focusTolerance)

	return {
		reference: intersection.point,
		error,
		absoluteError,
		focusProximity,
		intersectionCondition: intersection.condition,
	}
}

// Validates one half-open integer ROI without applying image-bound constraints.
function validateBahtinovArea(area: Readonly<Rect>): void {
	if (!Number.isInteger(area.left) || !Number.isInteger(area.top) || !Number.isInteger(area.right) || !Number.isInteger(area.bottom)) throw new RangeError('Bahtinov area edges must be integers')
	if (area.left >= area.right || area.top >= area.bottom) throw new RangeError('Bahtinov area must have positive width and height')
}

// Validates one finite normal-form line.
function validateNormalLine(line: BahtinovNormalLine): void {
	if (!Number.isFinite(line.normalAngle) || !Number.isFinite(line.distance)) throw new RangeError('Bahtinov line parameters must be finite')
}

// Adds one finite in-bounds rectangle intersection unless it duplicates an existing point.
function addClipPoint(points: Point[], x: number, y: number, xMinimum: number, xMaximum: number, yMinimum: number, yMaximum: number): void {
	if (!Number.isFinite(x) || !Number.isFinite(y) || x < xMinimum - CLIP_POINT_EPSILON || x > xMaximum + CLIP_POINT_EPSILON || y < yMinimum - CLIP_POINT_EPSILON || y > yMaximum + CLIP_POINT_EPSILON) return

	const clampedX = Math.min(xMaximum, Math.max(xMinimum, x))
	const clampedY = Math.min(yMaximum, Math.max(yMinimum, y))
	for (let i = 0; i < points.length; i++) if (Math.abs(points[i].x - clampedX) <= CLIP_POINT_EPSILON && Math.abs(points[i].y - clampedY) <= CLIP_POINT_EPSILON) return
	points.push({ x: clampedX, y: clampedY })
}
