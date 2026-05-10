import { describe, expect, test } from 'bun:test'
import { deg, normalizePI } from '../src/angle'
import { sphericalSeparation, type Point } from '../src/geometry'
// oxfmt-ignore
import { WEB_MERCATOR_MAX_LATITUDE, azimuthalEquidistantProject, azimuthalEquidistantUnproject, AzimuthalEquidistant, gnomonicProject, Gnomonic, lambertAzimuthalEqualAreaProject, lambertAzimuthalEqualAreaUnproject, LambertAzimuthalEqualArea, orthographicProject, orthographicUnproject, Orthographic, projectLonLat, projectLonLatBatch, stereographicProject, stereographicUnproject, Stereographic, unprojectLonLat, CylindricalStereographic, CylindricalEquidistant, Mercator, WebMercator, EllipsoidalMercator, CylindricalEqualArea, Miller, CentralCylindrical, } from '../src/projection'
import { PI, PIOVERTWO } from '../src/constants'

const AZIMUTHAL_ROUND_TRIP_CASES = [
	{ name: 'gnomonic', projection: Gnomonic.default },
	{ name: 'stereographic', projection: Stereographic.default, project: stereographicProject, unproject: stereographicUnproject },
	{ name: 'orthographic', projection: Orthographic.default, project: orthographicProject, unproject: orthographicUnproject },
	{ name: 'lambert azimuthal equal-area', projection: LambertAzimuthalEqualArea.default, project: lambertAzimuthalEqualAreaProject, unproject: lambertAzimuthalEqualAreaUnproject },
	{ name: 'azimuthal equidistant', projection: AzimuthalEquidistant.default, project: azimuthalEquidistantProject, unproject: azimuthalEquidistantUnproject },
] as const

describe('azimuthal projections round-trip near the projection center', () => {
	const centerLongitude = deg(10)
	const centerLatitude = deg(-20)
	const longitude = deg(11.5)
	const latitude = deg(-19.25)
	const options = { centralMeridian: centerLongitude, latitudeOfOrigin: centerLatitude }

	for (const { name, projection } of AZIMUTHAL_ROUND_TRIP_CASES) {
		test(name, () => {
			expect(projection.forward(centerLongitude, centerLatitude, options)).toEqual({ x: 0, y: 0 })
			expect(projectLonLat(projection, centerLongitude, centerLatitude, options)).toEqual({ x: 0, y: 0 })

			const projected = projection.forward(longitude, latitude, options)
			expect(projected).toBeDefined()

			if (projected === undefined) return

			const classProjected = projectLonLat(projection, longitude, latitude, options)
			expect(classProjected).toBeDefined()

			if (classProjected !== undefined) {
				expect(classProjected.x).toBeCloseTo(projected.x, 12)
				expect(classProjected.y).toBeCloseTo(projected.y, 12)
			}

			const unprojected = projection.inverse(projected.x, projected.y, options)
			expect(unprojected).toBeDefined()

			if (unprojected === undefined) return

			expect(unprojected.x).toBeCloseTo(longitude, 11)
			expect(unprojected.y).toBeCloseTo(latitude, 11)

			if (classProjected !== undefined) {
				const classUnprojected = unprojectLonLat(projection, classProjected.x, classProjected.y, options)
				expect(classUnprojected).toBeDefined()

				if (classUnprojected !== undefined) {
					expect(classUnprojected.x).toBeCloseTo(longitude, 11)
					expect(classUnprojected.y).toBeCloseTo(latitude, 11)
				}
			}
		})
	}
})

test('astronomy-oriented azimuthal projections have the expected equatorial radii', () => {
	const gnomonic = gnomonicProject(deg(45), 0, 0, 0)
	expect(gnomonic).not.toBeFalse()

	if (gnomonic !== undefined) {
		expect(gnomonic.x).toBeCloseTo(1, 12)
		expect(gnomonic.y).toBeCloseTo(0, 12)
	}

	const stereographic = stereographicProject(deg(90), 0, 0, 0)
	expect(stereographic).not.toBeFalse()

	if (stereographic !== undefined) {
		expect(stereographic.x).toBeCloseTo(2, 12)
		expect(stereographic.y).toBeCloseTo(0, 12)
	}

	const orthographic = orthographicProject(deg(90), 0, 0, 0)
	expect(orthographic).not.toBeFalse()

	if (orthographic !== undefined) {
		expect(orthographic.x).toBeCloseTo(1, 12)
		expect(orthographic.y).toBeCloseTo(0, 12)
	}

	const lambert = lambertAzimuthalEqualAreaProject(deg(90), 0, 0, 0)
	expect(lambert).not.toBeFalse()

	if (lambert !== undefined) {
		expect(lambert.x).toBeCloseTo(Math.SQRT2, 12)
		expect(lambert.y).toBeCloseTo(0, 12)
	}

	const equidistant = azimuthalEquidistantProject(deg(90), 0, 0, 0)
	expect(equidistant).not.toBeFalse()

	if (equidistant !== undefined) {
		expect(equidistant.x).toBeCloseTo(PIOVERTWO, 12)
		expect(equidistant.y).toBeCloseTo(0, 12)
	}
})

test('azimuthal equidistant preserves the center angular distance as plane radius', () => {
	const centerLongitude = deg(-30)
	const centerLatitude = deg(15)
	const longitude = deg(-5)
	const latitude = deg(22)
	const projected = azimuthalEquidistantProject(longitude, latitude, centerLongitude, centerLatitude)
	expect(projected).not.toBeFalse()

	if (projected !== undefined) {
		expect(Math.hypot(projected.x, projected.y)).toBeCloseTo(sphericalSeparation(centerLongitude, centerLatitude, longitude, latitude), 12)
	}
})

test('azimuthal projection singularities and inverse domains are rejected', () => {
	expect(gnomonicProject(PI, 0, 0, 0)).toBeUndefined()
	expect(orthographicProject(PI, 0, 0, 0)).toBeUndefined()
	expect(stereographicProject(PI, 0, 0, 0)).toBeUndefined()
	expect(lambertAzimuthalEqualAreaProject(PI, 0, 0, 0)).toBeUndefined()
	expect(azimuthalEquidistantProject(PI, 0, 0, 0)).toBeUndefined()
	expect(projectLonLat(Gnomonic.default, PI, 0)).toBeUndefined()
	expect(projectLonLat(Orthographic.default, PI, 0)).toBeUndefined()
	expect(projectLonLat(Stereographic.default, PI, 0)).toBeUndefined()
	expect(projectLonLat(LambertAzimuthalEqualArea.default, PI, 0)).toBeUndefined()
	expect(projectLonLat(AzimuthalEquidistant.default, PI, 0)).toBeUndefined()

	expect(orthographicUnproject(1.000001, 0, 0, 0)).toBeUndefined()
	expect(lambertAzimuthalEqualAreaUnproject(2.000001, 0, 0, 0)).toBeUndefined()
	expect(azimuthalEquidistantUnproject(PI + 0.000001, 0, 0, 0)).toBeUndefined()
	expect(unprojectLonLat(Orthographic.default, 1.000001, 0)).toBeUndefined()
	expect(unprojectLonLat(LambertAzimuthalEqualArea.default, 2.000001, 0)).toBeUndefined()
	expect(unprojectLonLat(AzimuthalEquidistant.default, PI + 0.000001, 0)).toBeUndefined()
})

test('finite azimuthal projections expose projected world bounds', () => {
	expect(Gnomonic.default.bounds()).toBeUndefined()
	expect(Stereographic.default.bounds()).toBeUndefined()
	expect(Orthographic.default.bounds()).toEqual({ minX: -1, maxX: 1, minY: -1, maxY: 1 })
	expect(LambertAzimuthalEqualArea.default.bounds()).toEqual({ minX: -2, maxX: 2, minY: -2, maxY: 2 })
	expect(AzimuthalEquidistant.default.bounds()).toEqual({ minX: -PI, maxX: PI, minY: -PI, maxY: PI })
})

const ROUND_TRIP_POINTS: readonly Point[] = [
	{ x: 0, y: 0 },
	{ x: deg(12), y: deg(5) },
	{ x: deg(-80), y: deg(45) },
	{ x: deg(170), y: deg(-65) },
] as const

const CYLINDRICAL_ROUND_TRIP_CASES = [
	{ name: 'plateCarree', projection: CylindricalEquidistant.plateCarree },
	{ name: 'cylindricalEquidistant', projection: new CylindricalEquidistant(deg(30)) },
	{ name: 'mercator', projection: Mercator.default },
	{ name: 'webMercator', projection: WebMercator.default },
	{ name: 'ellipsoidalMercator', projection: new EllipsoidalMercator(0.08181919084262149) },
	{ name: 'miller', projection: Miller.default },
	{ name: 'centralCylindrical', projection: CentralCylindrical.default },
	{ name: 'cylindricalEqualArea', projection: new CylindricalEqualArea(deg(30)) },
	{ name: 'lambertCylindricalEqualArea', projection: CylindricalEqualArea.lambertCylindricalEqualArea },
	{ name: 'behrmann', projection: CylindricalEqualArea.behrmann },
	{ name: 'gallPeters', projection: CylindricalEqualArea.gallPeters },
	{ name: 'hoboDyer', projection: CylindricalEqualArea.hoboDyer },
	{ name: 'balthasart', projection: CylindricalEqualArea.balthasart },
	{ name: 'trystanEdwards', projection: CylindricalEqualArea.trystanEdwards },
	{ name: 'cylindricalStereographic', projection: new CylindricalStereographic(deg(30)) },
	{ name: 'gallStereographic', projection: CylindricalStereographic.gall },
	{ name: 'braunStereographic', projection: CylindricalStereographic.braun },
] as const

describe('cylindrical projections round-trip', () => {
	for (const { name, projection } of CYLINDRICAL_ROUND_TRIP_CASES) {
		test(name, () => {
			const points = name === 'centralCylindrical' ? ROUND_TRIP_POINTS.slice(0, 3) : ROUND_TRIP_POINTS

			for (const point of points) {
				const projected = projectLonLat(projection, point.x, point.y, undefined)
				expect(projected).toBeDefined()

				if (projected === undefined) continue

				const unprojected = unprojectLonLat(projection, projected.x, projected.y, undefined)
				expect(unprojected).toBeDefined()

				if (unprojected === undefined) continue

				expect(normalizePI(unprojected.x - point.x)).toBeCloseTo(0, 12)
				expect(unprojected.y).toBeCloseTo(point.y, 12)
			}
		})
	}
})

test('cylindrical projections match expected known values', () => {
	const plateCarree = projectLonLat(CylindricalEquidistant.plateCarree, deg(20), deg(30), { centralMeridian: deg(10) })
	expect(plateCarree).toBeDefined()

	if (plateCarree !== undefined) {
		expect(plateCarree.x).toBeCloseTo(deg(10), 12)
		expect(plateCarree.y).toBeCloseTo(deg(30), 12)
	}

	const equirectangular = projectLonLat(CylindricalEquidistant.default, deg(20), deg(30), { centralMeridian: deg(10), standardParallel1: deg(60) })
	expect(equirectangular).toBeDefined()

	if (equirectangular !== undefined) {
		expect(equirectangular.x).toBeCloseTo(deg(5), 12)
		expect(equirectangular.y).toBeCloseTo(deg(30), 12)
	}

	const mercatorNorth = projectLonLat(Mercator.default, 0, deg(45))
	const mercatorSouth = projectLonLat(Mercator.default, 0, deg(-45))
	expect(mercatorNorth).toBeDefined()
	expect(mercatorSouth).toBeDefined()

	if (mercatorNorth !== undefined && mercatorSouth !== undefined) {
		expect(mercatorNorth.x).toBeCloseTo(0, 12)
		expect(mercatorNorth.y).toBeCloseTo(-mercatorSouth.y, 12)
	}

	const lambert = projectLonLat(CylindricalEqualArea.lambertCylindricalEqualArea, deg(20), deg(30))
	expect(lambert).toBeDefined()

	if (lambert !== undefined) {
		expect(lambert.x).toBeCloseTo(deg(20), 12)
		expect(lambert.y).toBeCloseTo(0.5, 12)
	}

	expect(projectLonLat(WebMercator.default, 0, PIOVERTWO)?.y).toBeCloseTo(PI, 12)
	expect(projectLonLat(WebMercator.default, 0, WEB_MERCATOR_MAX_LATITUDE)?.y).toBeCloseTo(PI, 12)
})

test('projection options validate domains and parameters', () => {
	expect(projectLonLat(CylindricalEquidistant.plateCarree, 0, PIOVERTWO + 1e-6)).toBeUndefined()
	expect(projectLonLat(CylindricalEquidistant.plateCarree, 0, 0, { radius: 0 })).toBeUndefined()
	expect(projectLonLat(CylindricalEquidistant.default, 0, 0, { standardParallel1: PIOVERTWO })).toBeUndefined()
	expect(projectLonLat(EllipsoidalMercator.default, 0, 0, { eccentricity: 1 })).toBeUndefined()
	expect(projectLonLat(Mercator.default, 0, PIOVERTWO)).toBeUndefined()
})

test('RA axis direction and wrapping are configurable', () => {
	const east = projectLonLat(CylindricalEquidistant.plateCarree, deg(10), deg(5), { centralMeridian: 0 })
	const west = projectLonLat(CylindricalEquidistant.plateCarree, deg(10), deg(5), { centralMeridian: 0, raAxisDirection: 'west' })
	expect(east).toBeDefined()
	expect(west).toBeDefined()

	if (east !== undefined && west !== undefined) {
		expect(west.x).toBeCloseTo(-east.x, 12)
		expect(west.y).toBeCloseTo(east.y, 12)

		const unprojected = unprojectLonLat(CylindricalEquidistant.plateCarree, west.x, west.y, { centralMeridian: 0, raAxisDirection: 'west' })
		expect(unprojected).toBeDefined()

		if (unprojected !== undefined) {
			expect(normalizePI(unprojected.x - deg(10))).toBeCloseTo(0, 12)
			expect(unprojected.y).toBeCloseTo(deg(5), 12)
		}
	}

	const wrapped = projectLonLat(CylindricalEquidistant.plateCarree, deg(359), 0, { centralMeridian: 0 })
	expect(wrapped?.x).toBeCloseTo(deg(-1), 12)
})

test('batch projection reuses the provided output buffer', () => {
	const out: Point[] = []
	const projected = projectLonLatBatch(
		CylindricalEquidistant.plateCarree,
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

test('anti-meridian polylines are split before projection', () => {
	const projection = CylindricalEquidistant.plateCarree

	const lines = projection.splitPolyline([
		{ x: deg(179), y: 0 },
		{ x: deg(-179), y: 0 },
	])

	expect(lines).toHaveLength(2)
	expect(lines[0]).toHaveLength(1)
	expect(lines[1]).toHaveLength(1)
})
