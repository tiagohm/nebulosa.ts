import { describe, expect, test } from 'bun:test'
import { deg, normalizePI } from '../../../src/math/units/angle'
// oxfmt-ignore
import { AzimuthalEquidistant, Balthasart, Behrmann, Braun, CentralCylindrical, CylindricalEqualArea, CylindricalEquidistant, CylindricalStereographic, EllipsoidalMercator, Gall, GallPeters, Gnomonic, HoboDyer, LambertAzimuthalEqualArea, LambertCylindricalEqualArea, Mercator, Miller, Orthographic, PlateCarree, projectMany, projectPolyline, Stereographic, TrystanEdwards, WEB_MERCATOR_MAX_LATITUDE, WebMercator, } from '../../../src/astronomy/projections/projection'
import { PI, PIOVERTWO } from '../../../src/core/constants'
import { sphericalSeparation, type Point } from '../../../src/math/numerical/geometry'

describe('azimuthal projections round-trip', () => {
	const centerLongitude = deg(10)
	const centerLatitude = deg(-20)
	const longitude = deg(11.5)
	const latitude = deg(-19.25)

	const projections = [
		{ name: 'gnomonic', projection: new Gnomonic(centerLongitude, centerLatitude) },
		{ name: 'stereographic', projection: new Stereographic(centerLongitude, centerLatitude) },
		{ name: 'orthographic', projection: new Orthographic(centerLongitude, centerLatitude) },
		{ name: 'lambert azimuthal equal-area', projection: new LambertAzimuthalEqualArea(centerLongitude, centerLatitude) },
		{ name: 'azimuthal equidistant', projection: new AzimuthalEquidistant(centerLongitude, centerLatitude) },
	] as const

	for (const { name, projection } of projections) {
		test(name, () => {
			expect(projection.project(centerLongitude, centerLatitude)).toEqual({ x: 0, y: 0 })

			const projected = projection.project(longitude, latitude)
			expect(projected).toBeDefined()

			if (projected === undefined) return

			const unprojected = projection.unproject(projected.x, projected.y)
			expect(unprojected).toBeDefined()

			if (unprojected === undefined) return

			expect(unprojected.x).toBeCloseTo(longitude, 11)
			expect(unprojected.y).toBeCloseTo(latitude, 11)
		})
	}
})

describe('astronomy-oriented azimuthal projections have the expected equatorial radii', () => {
	const projections = [
		{ name: 'gnomonic', projection: new Gnomonic(0, 0), longitude: deg(45), latitude: 0, x: 1, y: 0 },
		{ name: 'stereographic', projection: new Stereographic(0, 0), longitude: deg(90), latitude: 0, x: 2, y: 0 },
		{ name: 'orthographic', projection: new Orthographic(0, 0), longitude: deg(90), latitude: 0, x: 1, y: 0 },
		{ name: 'lambert azimuthal equal-area', projection: new LambertAzimuthalEqualArea(0, 0), longitude: deg(90), latitude: 0, x: Math.SQRT2, y: 0 },
		{ name: 'azimuthal equidistant', projection: new AzimuthalEquidistant(0, 0), longitude: deg(90), latitude: 0, x: PIOVERTWO, y: 0 },
	] as const

	for (const { name, projection, longitude, latitude, x, y } of projections) {
		test(name, () => {
			const projected = projection.project(longitude, latitude)
			expect(projected).toBeDefined()

			if (projected === undefined) return

			expect(projected.x).toBeCloseTo(x, 14)
			expect(projected.y).toBeCloseTo(y, 14)
		})
	}
})

test('azimuthal equidistant preserves the center angular distance as plane radius', () => {
	const centerLongitude = deg(-30)
	const centerLatitude = deg(15)
	const longitude = deg(-5)
	const latitude = deg(22)

	const projected = new AzimuthalEquidistant(centerLongitude, centerLatitude).project(longitude, latitude)
	expect(projected).toBeDefined()

	if (projected === undefined) return

	expect(Math.hypot(projected.x, projected.y)).toBeCloseTo(sphericalSeparation(centerLongitude, centerLatitude, longitude, latitude), 12)
})

test('azimuthal projection singularities and inverse domains are rejected', () => {
	expect(new Gnomonic(0, 0).project(PI, 0)).toBeUndefined()
	expect(new Orthographic(0, 0).project(PI, 0)).toBeUndefined()
	expect(new Stereographic(0, 0).project(PI, 0)).toBeUndefined()
	expect(new LambertAzimuthalEqualArea(0, 0).project(PI, 0)).toBeUndefined()
	expect(new AzimuthalEquidistant(0, 0).project(PI, 0)).toBeUndefined()

	expect(new Orthographic(0, 0).unproject(1.000001, 0)).toBeUndefined()
	expect(new LambertAzimuthalEqualArea(0, 0).unproject(2.000001, 0)).toBeUndefined()
	expect(new AzimuthalEquidistant(0, 0).unproject(PI + 0.000001, 0)).toBeUndefined()
	expect(new Orthographic(0, 0).unproject(1.000001, 0)).toBeUndefined()
	expect(new LambertAzimuthalEqualArea(0, 0).unproject(2.000001, 0)).toBeUndefined()
	expect(new AzimuthalEquidistant(0, 0).unproject(PI + 0.000001, 0)).toBeUndefined()
})

test('azimuthal projections apply linear plane options like cylindrical', () => {
	const projection = new Stereographic(deg(10), deg(-20))
	const options = { scale: 100, radius: 2, falseEasting: 5, falseNorthing: -7, yAxisDirection: 'southUp' } as const

	// The projection center maps to (falseEasting, falseNorthing) instead of the raw origin.
	const center = projection.project(deg(10), deg(-20), undefined, options)
	expect(center?.x).toBeCloseTo(5, 12)
	expect(center?.y).toBeCloseTo(-7, 12)

	// The full linear transform (scale, radius, false offsets, y-axis flip) round-trips.
	const projected = projection.project(deg(11.5), deg(-19.25), undefined, options)
	expect(projected).toBeDefined()
	if (projected === undefined) return

	const unprojected = projection.unproject(projected.x, projected.y, undefined, options)
	expect(unprojected).toBeDefined()
	if (unprojected === undefined) return

	expect(normalizePI(unprojected.x - deg(11.5))).toBeCloseTo(0, 11)
	expect(unprojected.y).toBeCloseTo(deg(-19.25), 11)

	// Constructor options are honored and overridden by per-call options.
	const withDefaults = new Gnomonic(0, 0, { scale: 10 })
	expect(withDefaults.project(deg(45), 0)?.x).toBeCloseTo(10, 12)
	expect(withDefaults.project(deg(45), 0, undefined, { scale: 3 })?.x).toBeCloseTo(3, 12)
})

test('azimuthal projections support an east/west RA flip', () => {
	const projection = new Stereographic(deg(10), deg(0))
	const longitude = deg(25) // 15 degrees east of the center
	const latitude = deg(0)

	const east = projection.project(longitude, latitude, undefined, { raAxisDirection: 'east' })
	const west = projection.project(longitude, latitude, undefined, { raAxisDirection: 'west' })
	expect(east).toBeDefined()
	expect(west).toBeDefined()
	if (east === undefined || west === undefined) return

	// 'west' mirrors x about the declination axis and leaves y untouched.
	expect(east.x).toBeGreaterThan(0)
	expect(west.x).toBeCloseTo(-east.x, 12)
	expect(west.y).toBeCloseTo(east.y, 12)

	// The flipped projection still round-trips.
	const unprojected = projection.unproject(west.x, west.y, undefined, { raAxisDirection: 'west' })
	expect(unprojected).toBeDefined()
	if (unprojected === undefined) return
	expect(normalizePI(unprojected.x - longitude)).toBeCloseTo(0, 12)
	expect(unprojected.y).toBeCloseTo(latitude, 12)

	// Constructor-level direction is honored and overridable per call.
	const westDefault = new Gnomonic(0, 0, { raAxisDirection: 'west' })
	expect(westDefault.project(deg(45), 0)?.x).toBeCloseTo(-1, 12)
	expect(westDefault.project(deg(45), 0, undefined, { raAxisDirection: 'east' })?.x).toBeCloseTo(1, 12)
})

describe('cylindrical projections round-trip', () => {
	const points: readonly Point[] = [
		{ x: 0, y: 0 },
		{ x: deg(12), y: deg(5) },
		{ x: deg(-80), y: deg(45) },
		{ x: deg(170), y: deg(-65) },
	] as const

	const projections = [
		{ name: 'plateCarree', projection: new PlateCarree(), points },
		{ name: 'cylindricalEquidistant', projection: new CylindricalEquidistant(deg(30)), points },
		{ name: 'mercator', projection: new Mercator(), points },
		{ name: 'webMercator', projection: new WebMercator(), points },
		{ name: 'ellipsoidalMercator', projection: new EllipsoidalMercator({ eccentricity: 0.08181919084262149 }), points },
		{ name: 'miller', projection: new Miller(), points },
		{ name: 'centralCylindrical', projection: new CentralCylindrical(), points: points.slice(0, 3) },
		{ name: 'cylindricalEqualArea', projection: new CylindricalEqualArea(deg(30)), points },
		{ name: 'lambertCylindricalEqualArea', projection: new LambertCylindricalEqualArea(), points },
		{ name: 'behrmann', projection: new Behrmann(), points },
		{ name: 'gallPeters', projection: new GallPeters(), points },
		{ name: 'hoboDyer', projection: new HoboDyer(), points },
		{ name: 'balthasart', projection: new Balthasart(), points },
		{ name: 'trystanEdwards', projection: new TrystanEdwards(), points },
		{ name: 'cylindricalStereographic', projection: new CylindricalStereographic(deg(30)), points },
		{ name: 'gall', projection: new Gall(), points },
		{ name: 'braun', projection: new Braun(), points },
	] as const

	for (const { name, projection, points } of projections) {
		test(name, () => {
			for (const point of points) {
				const projected = projection.project(point.x, point.y)
				expect(projected).toBeDefined()

				if (projected === undefined) continue

				const unprojected = projection.unproject(projected.x, projected.y)
				expect(unprojected).toBeDefined()

				if (unprojected === undefined) continue

				expect(normalizePI(unprojected.x - point.x)).toBeCloseTo(0, 12)
				expect(unprojected.y).toBeCloseTo(point.y, 12)
			}
		})
	}
})

test('standard-parallel projections round-trip with a non-zero central meridian', () => {
	// These previously failed: the equal-area and stereographic projects scaled the longitude by
	// cos(standardParallel) before subtracting the central meridian, and the stereographic inverse
	// dropped the per-call options. Both break the round-trip unless the central meridian is zero.
	const samples: Point[] = [
		{ x: deg(10), y: deg(20) },
		{ x: deg(-30), y: deg(-15) },
		{ x: deg(120), y: deg(40) },
	]

	const cases = [
		{ projection: new CylindricalEqualArea(deg(30)), options: { centralMeridian: deg(45) } },
		{ projection: new GallPeters(), options: { centralMeridian: deg(60) } },
		{ projection: new CylindricalStereographic(deg(20)), options: { centralMeridian: deg(10) } },
		{ projection: new Braun(), options: { centralMeridian: deg(45) } },
	] as const

	for (const { projection, options } of cases) {
		for (const point of samples) {
			const projected = projection.project(point.x, point.y, undefined, options)
			expect(projected).toBeDefined()
			if (projected === undefined) continue

			const unprojected = projection.unproject(projected.x, projected.y, undefined, options)
			expect(unprojected).toBeDefined()
			if (unprojected === undefined) continue

			expect(normalizePI(unprojected.x - point.x)).toBeCloseTo(0, 12)
			expect(unprojected.y).toBeCloseTo(point.y, 12)
		}
	}
})

describe('cylindrical projections match expected known values', () => {
	const projections = [
		{ name: 'plateCarree', projection: new PlateCarree(0, { centralMeridian: deg(10) }), longitude: deg(20), latitude: deg(30), x: deg(10), y: deg(30) },
		{ name: 'equirectangular', projection: new CylindricalEquidistant(deg(60), 0, { centralMeridian: deg(10) }), longitude: deg(20), latitude: deg(30), x: deg(5), y: deg(30) },
		{ name: 'lambertCylindricalEqualArea', projection: new LambertCylindricalEqualArea(0), longitude: deg(20), latitude: deg(30), x: deg(20), y: 0.5 },
		{ name: 'mercatorNorth', projection: new Mercator(), longitude: 0, latitude: deg(45), x: 0, y: 0.8813735870195429 },
		{ name: 'mercatorSouth', projection: new Mercator(), longitude: 0, latitude: -deg(45), x: 0, y: -0.8813735870195429 },
		{ name: 'webMercator I', projection: new WebMercator(), longitude: 0, latitude: PIOVERTWO, x: 0, y: PI },
		{ name: 'webMercator II', projection: new WebMercator(), longitude: 0, latitude: WEB_MERCATOR_MAX_LATITUDE, x: 0, y: PI },
	] as const

	for (const { name, projection, longitude, latitude, x, y } of projections) {
		test(name, () => {
			const projected = projection.project(longitude, latitude)
			expect(projected).toBeDefined()

			if (projected === undefined) return

			expect(projected.x).toBeCloseTo(x, 14)
			expect(projected.y).toBeCloseTo(y, 14)
		})
	}
})

test('projection options validate domains and parameters', () => {
	expect(new PlateCarree().project(0, PIOVERTWO + 1e-6)).toBeUndefined()
	expect(new PlateCarree(0, { radius: 0 }).project(0, 0)).toBeUndefined()
	expect(() => new CylindricalEquidistant(PIOVERTWO).project(0, 0)).toThrow('invalid standardParallel')
	expect(() => new EllipsoidalMercator({ eccentricity: 1 }).project(0, 0)).toThrow('invalid eccentricity')
	expect(new Mercator().project(0, PIOVERTWO)).toBeUndefined()
})

test('RA axis direction and wrapping are configurable', () => {
	const east = new PlateCarree(0, { centralMeridian: 0 })
	const west = new PlateCarree(0, { centralMeridian: 0, raAxisDirection: 'west' })

	const eastProjected = east.project(deg(10), deg(5))
	const westProjected = west.project(deg(10), deg(5))

	expect(eastProjected).toBeDefined()
	expect(westProjected).toBeDefined()

	if (eastProjected !== undefined && westProjected !== undefined) {
		expect(westProjected.x).toBeCloseTo(-eastProjected.x, 12)
		expect(westProjected.y).toBeCloseTo(eastProjected.y, 12)

		const unprojected = west.unproject(westProjected.x, westProjected.y)
		expect(unprojected).toBeDefined()

		if (unprojected !== undefined) {
			expect(normalizePI(unprojected.x - deg(10))).toBeCloseTo(0, 12)
			expect(unprojected.y).toBeCloseTo(deg(5), 12)
		}
	}

	const wrapped = east.unproject(deg(359), 0, undefined, { centralMeridian: 0 })
	expect(wrapped?.x).toBeCloseTo(deg(-1), 12)
})

test('linear projection options are applied to project and unproject', () => {
	const projection = new PlateCarree(0, {
		centralMeridian: deg(30),
		falseEasting: 5,
		falseNorthing: -7,
		radius: 2,
		scale: 3,
		yAxisDirection: 'southUp',
	})
	const projected = projection.project(deg(45), deg(10))
	expect(projected).toBeDefined()

	if (projected === undefined) return

	expect(projected.x).toBeCloseTo(5 + deg(15) * 6, 12)
	expect(projected.y).toBeCloseTo(-7 - deg(10) * 6, 12)

	const unprojected = projection.unproject(projected.x, projected.y)
	expect(unprojected).toBeDefined()

	if (unprojected === undefined) return

	expect(normalizePI(unprojected.x - deg(45))).toBeCloseTo(0, 12)
	expect(unprojected.y).toBeCloseTo(deg(10), 12)
})

test('per-call projection options override constructor defaults', () => {
	const projection = new PlateCarree(0, { centralMeridian: deg(10), falseEasting: -1, falseNorthing: -2, radius: 8, scale: 9 })
	const projected = projection.project(deg(15), deg(2), undefined, { centralMeridian: deg(20), falseEasting: 1, falseNorthing: 2, raAxisDirection: 'west', radius: 4, scale: 3, yAxisDirection: 'southUp' })
	expect(projected).toBeDefined()

	if (projected === undefined) return

	expect(projected.x).toBeCloseTo(1 + deg(5) * 12, 12)
	expect(projected.y).toBeCloseTo(2 - deg(2) * 12, 12)
})

test('longitude wrap modes control inverse normalization', () => {
	const projection = new PlateCarree()

	expect(projection.unproject(deg(359), 0)?.x).toBeCloseTo(deg(-1), 12)
	expect(projection.unproject(deg(359), 0, undefined, { longitudeWrapMode: 'tau' })?.x).toBeCloseTo(deg(359), 12)
	expect(projection.unproject(PI * 3, 0, undefined, { longitudeWrapMode: 'none' })?.x).toBeCloseTo(PI * 3, 12)
})

test('latitude options clamp to the configured maximum latitude', () => {
	const maxLatitude = deg(60)
	const clamped = new Mercator({ clampLatitude: true, maxLatitude }).project(0, deg(70))

	expect(new Mercator({ maxLatitude }).project(0, deg(70))).toBeUndefined()
	expect(clamped).toBeDefined()

	if (clamped === undefined) return

	expect(clamped.y).toBeCloseTo(Math.asinh(Math.tan(maxLatitude)), 12)
})

test('ellipsoidal projection options select the eccentricity model and inverse tolerance', () => {
	const latitude = deg(45)
	const eccentricity = 0.08181919084262149
	const flattening = 1 - Math.sqrt(1 - eccentricity * eccentricity)
	const eccentricProjected = new EllipsoidalMercator({ eccentricity }).project(0, latitude)
	const flatteningProjected = new EllipsoidalMercator({ flattening }).project(0, latitude)
	const sphericalProjected = new EllipsoidalMercator({ eccentricity, sphericalOnly: true }).project(0, latitude)
	const mercatorProjected = new Mercator().project(0, latitude)

	expect(eccentricProjected).toBeDefined()
	expect(flatteningProjected).toBeDefined()
	expect(sphericalProjected).toBeDefined()
	expect(mercatorProjected).toBeDefined()

	if (eccentricProjected === undefined || flatteningProjected === undefined || sphericalProjected === undefined || mercatorProjected === undefined) return

	expect(flatteningProjected.y).toBeCloseTo(eccentricProjected.y, 12)
	expect(sphericalProjected.y).toBeCloseTo(mercatorProjected.y, 12)
	expect(new EllipsoidalMercator({ eccentricity }).unproject(eccentricProjected.x, eccentricProjected.y, undefined, { maxIterations: 0 })).toBeUndefined()

	const unprojected = new EllipsoidalMercator({ eccentricity }).unproject(eccentricProjected.x, eccentricProjected.y, undefined, { epsilon: 1e-14, maxIterations: 12 })
	expect(unprojected).toBeDefined()

	if (unprojected === undefined) return

	expect(unprojected.y).toBeCloseTo(latitude, 12)
})

test('project and unproject reuse the provided output point', () => {
	const projection = new Gnomonic(deg(10), deg(-20))
	const projectOut: Point = { x: 0, y: 0 }
	const projected = projection.project(deg(11.5), deg(-19.25), projectOut)

	expect(projected).toBe(projectOut)
	if (projected === undefined) return

	const unprojectOut: Point = { x: 0, y: 0 }
	const unprojected = projection.unproject(projected.x, projected.y, unprojectOut)

	expect(unprojected).toBe(unprojectOut)
	if (unprojected === undefined) return

	expect(unprojected.x).toBeCloseTo(deg(11.5), 11)
	expect(unprojected.y).toBeCloseTo(deg(-19.25), 11)
})

test('batch projection reuses the provided output buffer', () => {
	const out: Point[] = []
	const projected = projectMany(
		new PlateCarree(),
		[
			{ x: 0, y: 0 },
			{ x: deg(10), y: deg(5) },
		],
		undefined,
		out,
	)

	expect(projected).toBe(out)
	expect(projected![0].x).toBeCloseTo(0, 12)
	expect(projected![0].y).toBeCloseTo(0, 12)
	expect(projected![1].x).toBeCloseTo(deg(10), 12)
	expect(projected![1].y).toBeCloseTo(deg(5), 12)
})

test('batch projection rejects points outside the projection domain', () => {
	const projected = projectMany(new Orthographic(0, 0), [
		{ x: 0, y: 0 },
		{ x: PI, y: 0 },
	])

	expect(projected).toBeUndefined()
})

test('anti-meridian polylines are split before projection', () => {
	const projection = new PlateCarree()

	const lines = projectPolyline(projection, [
		{ x: deg(179), y: 0 },
		{ x: deg(-179), y: 0 },
	])

	expect(lines).toHaveLength(2)
	expect(lines[0]).toHaveLength(1)
	expect(lines[1]).toHaveLength(1)
})
