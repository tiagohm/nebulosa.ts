import { expect, test, describe } from 'bun:test'
import { PI, TAU } from '../../../../src/core/constants'
import { deg } from '../../../../src/math/units/angle'
// oxfmt-ignore
import { derivativeEarthLimbOmega, EARTH_E2, earthLimbCircleIntersections, earthLimbExtremes, earthLimbOmega, earthLimbPoint, geoPolylinesToSvgPathData, hourAngleFromLongitude, longitudeFromHourAngle, pointsToSvgPathData, splitPolygonAtAntimeridian, splitPolylineAtAntimeridian, type EclipseGeoBranch } from '../../../../src/astronomy/events/eclipse/eclipse'
import type { Projection } from '../../../../src/astronomy/projections/projection'

test('longitude convention is east-positive and centralized in the hour-angle helpers', () => {
	const mu = deg(100)
	const correction = deg(0.0817)
	const H = deg(40)
	const longitude = longitudeFromHourAngle(H, mu, correction)

	// lambda = H - mu + correction, east-positive (Astrarium's west-positive mirror negated).
	expect(longitude).toBeCloseTo(deg(40 - 100 + 0.0817), 12)
	// The inverse helper round-trips exactly when no TAU wrap is involved.
	expect(hourAngleFromLongitude(longitude, mu, correction)).toBeCloseTo(H, 12)
})

describe('earth-limb ellipse geometry', () => {
	const E2 = EARTH_E2

	function omega(d: number) {
		return 1 / Math.sqrt(1 - E2 * Math.cos(d) * Math.cos(d))
	}

	test('earthLimbOmega and its derivative are consistent (finite difference)', () => {
		for (const d of [deg(-80), deg(-20), 0, deg(15), deg(60), deg(85)]) {
			expect(earthLimbOmega(d)).toBeCloseTo(omega(d), 12)
			const h = 1e-6
			const numeric = (earthLimbOmega(d + h) - earthLimbOmega(d - h)) / (2 * h)
			expect(derivativeEarthLimbOmega(d)).toBeCloseTo(numeric, 6)
		}
		// At the equator (d = 0) the flattening scale is maximal, so its derivative vanishes.
		expect(derivativeEarthLimbOmega(0)).toBeCloseTo(0, 12)
	})

	test('earthLimbPoint lies exactly on the limb ellipse x^2 + (omega y)^2 = 1', () => {
		const w = omega(deg(23))
		for (const theta of [0, 0.5, 1.3, PI, 4.2, 6]) {
			const [x, y] = earthLimbPoint(theta, w)
			expect(x * x + (w * y) ** 2).toBeCloseTo(1, 12)
		}
	})

	test('earthLimbExtremes finds the true nearest and farthest limb points', () => {
		const w = omega(deg(40))
		// A point inside the ellipse.
		const inside = earthLimbExtremes(0.2, -0.1, w)
		expect(inside.inside).toBe(true)
		expect(inside.minDistance).toBeLessThan(inside.maxDistance)
		// A point outside the ellipse.
		const outside = earthLimbExtremes(1.6, 0.9, w)
		expect(outside.inside).toBe(false)

		// The reported nearest/farthest distances are the global extrema over a dense theta scan.
		for (const sample of [inside, outside]) {
			const cx = sample === inside ? 0.2 : 1.6
			const cy = sample === inside ? -0.1 : 0.9
			let min = Infinity
			let max = -Infinity
			for (let k = 0; k < 2000; k++) {
				const [x, y] = earthLimbPoint((k / 2000) * TAU, w)
				const dist = Math.hypot(x - cx, y - cy)
				min = Math.min(min, dist)
				max = Math.max(max, dist)
			}
			expect(sample.minDistance).toBeLessThanOrEqual(min + 1e-6)
			expect(sample.maxDistance).toBeGreaterThanOrEqual(max - 1e-6)
			// The nearest point sits on the ellipse.
			const [nx, ny] = earthLimbPoint(sample.nearestTheta, w)
			expect(nx * nx + (w * ny) ** 2).toBeCloseTo(1, 10)
		}
	})

	test('earthLimbCircleIntersections solves the circle-ellipse system (two, tangent, none)', () => {
		const w = omega(deg(35))
		const cx = 0.3
		const cy = -0.2

		// Radius chosen so the shadow circle cuts the limb twice.
		const radius = 0.9
		const crossings = earthLimbCircleIntersections(cx, cy, w, radius)
		expect(crossings.length).toBeGreaterThanOrEqual(2)
		// Ordered by descending y, and each crossing satisfies BOTH equations.
		for (let i = 1; i < crossings.length; i++) expect(crossings[i - 1][1]).toBeGreaterThanOrEqual(crossings[i][1])
		for (const [x, y] of crossings) {
			expect(x * x + (w * y) ** 2).toBeCloseTo(1, 6)
			expect(Math.hypot(x - cx, y - cy)).toBeCloseTo(radius, 6)
		}

		// A radius larger than the farthest limb distance from a far-outside center: no intersection.
		expect(earthLimbCircleIntersections(5, 0, w, 0.5)).toHaveLength(0)
	})

	test('earthLimbCircleIntersections handles a high-declination (more flattened) limb near the pole', () => {
		const w = omega(deg(85))
		// Center near the pole region of the fundamental plane.
		const crossings = earthLimbCircleIntersections(0, 0.8, w, 0.6)
		expect(crossings.length).toBeGreaterThanOrEqual(2)
		for (const [x, y] of crossings) {
			expect(x * x + (w * y) ** 2).toBeCloseTo(1, 6)
			expect(Math.hypot(x - 0, y - 0.8)).toBeCloseTo(0.6, 6)
		}
	})
})

describe('circle-ellipse intersection multiplicity and tangency', () => {
	// A circle and an ellipse can meet in four points; the solver must return all of them.
	// Synthetic flattened limb x^2 + (2y)^2 = 1 (omega = 2) and a concentric circle of radius 0.7 cut at
	// the four points (+-0.566, +-0.412).
	test('earthLimbCircleIntersections returns four crossings when the geometry has four', () => {
		const omega = 2
		const radius = 0.7
		const crossings = earthLimbCircleIntersections(0, 0, omega, radius)

		expect(crossings).toHaveLength(4)
		// Ordered by descending y, and each crossing lies on BOTH the ellipse and the circle.
		for (let i = 1; i < crossings.length; i++) expect(crossings[i - 1][1]).toBeGreaterThanOrEqual(crossings[i][1])
		for (const [x, y] of crossings) {
			expect(x * x + (omega * y) ** 2).toBeCloseTo(1, 6)
			expect(Math.hypot(x, y)).toBeCloseTo(radius, 6)
		}
	})

	// A grazing (tangential) contact is a double root that never changes sign; placed off the 2-degree scan
	// grid it would be missed without explicit tangency detection.
	test('earthLimbCircleIntersections detects an off-grid tangency with no sign change', () => {
		const omega = 2
		const theta0 = 0.05
		const px = Math.cos(theta0)
		const py = Math.sin(theta0) / omega
		// Outward ellipse normal at P = grad(x^2 + (omega y)^2) = (2x, 2 omega^2 y), normalized.
		const gradientX = 2 * px
		const gradientY = 2 * omega * omega * py
		const gradientLength = Math.hypot(gradientX, gradientY)
		// Radius below the local radius of curvature (~0.25 near the vertex) so the circle is tangent from
		// outside at exactly one point rather than cutting the ellipse twice.
		const radius = 0.15
		const cx = px + (radius * gradientX) / gradientLength
		const cy = py + (radius * gradientY) / gradientLength

		const crossings = earthLimbCircleIntersections(cx, cy, omega, radius)
		expect(crossings).toHaveLength(1)
		expect(Math.hypot(crossings[0][0] - px, crossings[0][1] - py)).toBeLessThan(0.02)
	})
})

test('pointsToSvgPathData emits one M..L.. subpath per piece and closes polygons', () => {
	const open = pointsToSvgPathData([
		[
			{ x: 1, y: 2 },
			{ x: 3, y: 4 },
			{ x: 5, y: 6 },
		],
	])

	expect(open).toBe('M1 2L3 4L5 6')

	const closed = pointsToSvgPathData(
		[
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
				{ x: 10, y: 10 },
			],
		],
		true,
	)

	expect(closed.startsWith('M0 0')).toBe(true)
	expect(closed.endsWith('Z')).toBe(true)

	// Two pieces produce two subpaths; degenerate pieces are dropped; empty input yields an empty string.
	expect(
		pointsToSvgPathData([
			[
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			],
			[
				{ x: 2, y: 2 },
				{ x: 3, y: 3 },
			],
		]).match(/M/g),
	).toHaveLength(2)

	expect(pointsToSvgPathData([[{ x: 0, y: 0 }]])).toBe('')
	expect(pointsToSvgPathData([])).toBe('')
})

test('pointsToSvgPathData rounds coordinates to the requested precision', () => {
	expect(
		pointsToSvgPathData(
			[
				[
					{ x: 1.23456, y: 2.98765 },
					{ x: 3.1, y: 4 },
				],
			],
			false,
			3,
		),
	).toBe('M1.235 2.988L3.1 4')
})

test('antimeridian splitting keeps segments within a hemisphere and continuous across the seam', () => {
	const line: EclipseGeoBranch = [
		{ x: deg(150), y: deg(5) },
		{ x: deg(178), y: deg(8) },
		{ x: deg(-176), y: deg(11) },
		{ x: deg(-150), y: deg(14) },
	]

	const segments = splitPolylineAtAntimeridian(line)
	expect(segments).toHaveLength(2)

	for (const segment of segments) for (let i = 1; i < segment.length; i++) expect(Math.abs(segment[i].x - segment[i - 1].x)).toBeLessThanOrEqual(PI)

	const seamEnd = segments[0].at(-1)!
	const seamStart = segments[1][0]
	expect(Math.abs(seamEnd.x)).toBeCloseTo(PI, 10)
	expect(Math.abs(seamStart.x)).toBeCloseTo(PI, 10)
	expect(seamEnd.x).toBe(-seamStart.x)
	// Latitude is continuous across the inserted seam point.
	expect(seamEnd.y).toBeCloseTo(seamStart.y, 10)
})

test('split helpers avoid direct antimeridian joins', () => {
	const line: EclipseGeoBranch = [
		{ x: deg(170), y: deg(10) },
		{ x: deg(-170), y: deg(12) },
		{ x: deg(-160), y: deg(15) },
	]

	const segments = splitPolylineAtAntimeridian(line)
	const rings = splitPolygonAtAntimeridian(line)

	expect(segments.length).toBeGreaterThan(1)
	expect(rings.length).toBeGreaterThan(1)
	expect(segments[0].at(-1)!.x).toBe(PI)
	expect(segments[1][0].x).toBe(-PI)

	const point = [{ x: 0, y: 0 }]
	expect(splitPolylineAtAntimeridian(point)).toHaveLength(0)
	expect(splitPolygonAtAntimeridian(point)).toHaveLength(0)
})

test('projected path serialization breaks at projection gaps', () => {
	const clippedProjection: Projection = {
		project(longitude, latitude) {
			return Math.abs(latitude) > deg(80) ? undefined : { x: longitude / deg(1), y: latitude / deg(1) }
		},
		unproject() {
			return undefined
		},
	}
	const path = geoPolylinesToSvgPathData(
		[
			[
				{ x: deg(-10), y: deg(70) },
				{ x: 0, y: deg(85) },
				{ x: deg(10), y: deg(70) },
			],
		],
		clippedProjection,
	)

	expect(path).toBe('')
})
