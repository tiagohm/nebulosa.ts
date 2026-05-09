import { describe, expect, test } from 'bun:test'
import { deg, normalizePI } from '../src/angle'
import { sphericalSeparation } from '../src/geometry'
import {
	WEB_MERCATOR_MAX_LATITUDE,
	azimuthalEquidistantProject,
	azimuthalEquidistantUnproject,
	gnomonicProject,
	gnomonicUnproject,
	lambertAzimuthalEqualAreaProject,
	lambertAzimuthalEqualAreaUnproject,
	orthographicProject,
	orthographicUnproject,
	projectLonLat,
	projectLonLatBatch,
	type SphericalPoint,
	stereographicProject,
	stereographicUnproject,
	unprojectLonLat,
	CylindricalStereographic,
	CylindricalEquidistant,
	Mercator,
	WebMercator,
	EllipsoidalMercator,
	CylindricalEqualArea,
	Miller,
	CentralCylindrical,
} from '../src/projection'
import { PI, PIOVERTWO } from '../src/constants'

describe('azimuthal projections round-trip near the projection center', () => {
	const centerLongitude = deg(10)
	const centerLatitude = deg(-20)
	const longitude = deg(11.5)
	const latitude = deg(-19.25)
	const projections = [
		{ name: 'gnomonic', project: gnomonicProject, unproject: gnomonicUnproject },
		{ name: 'stereographic', project: stereographicProject, unproject: stereographicUnproject },
		{ name: 'orthographic', project: orthographicProject, unproject: orthographicUnproject },
		{ name: 'lambert azimuthal equal-area', project: lambertAzimuthalEqualAreaProject, unproject: lambertAzimuthalEqualAreaUnproject },
		{ name: 'azimuthal equidistant', project: azimuthalEquidistantProject, unproject: azimuthalEquidistantUnproject },
	] as const

	for (const projection of projections) {
		test(projection.name, () => {
			expect(projection.project(centerLongitude, centerLatitude, centerLongitude, centerLatitude)).toEqual({ x: 0, y: 0 })

			const projected = projection.project(longitude, latitude, centerLongitude, centerLatitude)
			expect(projected).not.toBeFalse()

			if (projected === false) return

			const unprojected = projection.unproject(projected.x, projected.y, centerLongitude, centerLatitude)
			expect(unprojected).not.toBeFalse()

			if (unprojected === false) return

			expect(unprojected[0]).toBeCloseTo(longitude, 11)
			expect(unprojected[1]).toBeCloseTo(latitude, 11)
		})
	}
})

test('astronomy-oriented azimuthal projections have the expected equatorial radii', () => {
	const gnomonic = gnomonicProject(deg(45), 0, 0, 0)
	expect(gnomonic).not.toBeFalse()

	if (gnomonic !== false) {
		expect(gnomonic.x).toBeCloseTo(1, 12)
		expect(gnomonic.y).toBeCloseTo(0, 12)
	}

	const stereographic = stereographicProject(deg(90), 0, 0, 0)
	expect(stereographic).not.toBeFalse()

	if (stereographic !== false) {
		expect(stereographic.x).toBeCloseTo(2, 12)
		expect(stereographic.y).toBeCloseTo(0, 12)
	}

	const orthographic = orthographicProject(deg(90), 0, 0, 0)
	expect(orthographic).not.toBeFalse()

	if (orthographic !== false) {
		expect(orthographic.x).toBeCloseTo(1, 12)
		expect(orthographic.y).toBeCloseTo(0, 12)
	}

	const lambert = lambertAzimuthalEqualAreaProject(deg(90), 0, 0, 0)
	expect(lambert).not.toBeFalse()

	if (lambert !== false) {
		expect(lambert.x).toBeCloseTo(Math.SQRT2, 12)
		expect(lambert.y).toBeCloseTo(0, 12)
	}

	const equidistant = azimuthalEquidistantProject(deg(90), 0, 0, 0)
	expect(equidistant).not.toBeFalse()

	if (equidistant !== false) {
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

	if (projected !== false) {
		expect(Math.hypot(projected.x, projected.y)).toBeCloseTo(sphericalSeparation(centerLongitude, centerLatitude, longitude, latitude), 12)
	}
})

test('azimuthal projection singularities and inverse domains are rejected', () => {
	expect(gnomonicProject(PI, 0, 0, 0)).toBeFalse()
	expect(orthographicProject(PI, 0, 0, 0)).toBeFalse()
	expect(stereographicProject(PI, 0, 0, 0)).toBeFalse()
	expect(lambertAzimuthalEqualAreaProject(PI, 0, 0, 0)).toBeFalse()
	expect(azimuthalEquidistantProject(PI, 0, 0, 0)).toBeFalse()

	expect(orthographicUnproject(1.000001, 0, 0, 0)).toBeFalse()
	expect(lambertAzimuthalEqualAreaUnproject(2.000001, 0, 0, 0)).toBeFalse()
	expect(azimuthalEquidistantUnproject(PI + 0.000001, 0, 0, 0)).toBeFalse()
})

const ROUND_TRIP_POINTS: readonly SphericalPoint[] = [
	[0, 0],
	[deg(12), deg(5)],
	[deg(-80), deg(45)],
	[deg(170), deg(-65)],
] as const

const CYLINDRICAL_ROUND_TRIP_CASES = [
	{ id: 'plateCarree', projection: CylindricalEquidistant.plateCarree },
	{ id: 'cylindricalEquidistant', projection: new CylindricalEquidistant(deg(30)) },
	{ id: 'mercator', projection: Mercator.default },
	{ id: 'webMercator', projection: WebMercator.default },
	{ id: 'ellipsoidalMercator', projection: new EllipsoidalMercator(0.08181919084262149) },
	{ id: 'miller', projection: Miller.default },
	{ id: 'centralCylindrical', projection: CentralCylindrical.default },
	{ id: 'cylindricalEqualArea', projection: new CylindricalEqualArea(deg(30)) },
	{ id: 'lambertCylindricalEqualArea', projection: CylindricalEqualArea.lambertCylindricalEqualArea },
	{ id: 'behrmann', projection: CylindricalEqualArea.behrmann },
	{ id: 'gallPeters', projection: CylindricalEqualArea.gallPeters },
	{ id: 'hoboDyer', projection: CylindricalEqualArea.hoboDyer },
	{ id: 'balthasart', projection: CylindricalEqualArea.balthasart },
	{ id: 'trystanEdwards', projection: CylindricalEqualArea.trystanEdwards },
	{ id: 'cylindricalStereographic', projection: new CylindricalStereographic(deg(30)) },
	{ id: 'gallStereographic', projection: CylindricalStereographic.gall },
	{ id: 'braunStereographic', projection: CylindricalStereographic.braun },
] as const

describe('cylindrical projections round-trip', () => {
	for (const projectionCase of CYLINDRICAL_ROUND_TRIP_CASES) {
		test(projectionCase.id, () => {
			const points = projectionCase.id === 'centralCylindrical' ? ROUND_TRIP_POINTS.slice(0, 3) : ROUND_TRIP_POINTS

			for (const point of points) {
				const projected = projectLonLat(projectionCase.projection, point[0], point[1], undefined)
				expect(projected).toBeDefined()

				if (projected === undefined) continue

				const unprojected = unprojectLonLat(projectionCase.projection, projected[0], projected[1], undefined)
				expect(unprojected).toBeDefined()

				if (unprojected === undefined) continue

				expect(normalizePI(unprojected[0] - point[0])).toBeCloseTo(0, 10)
				expect(unprojected[1]).toBeCloseTo(point[1], 10)
			}
		})
	}
})

test('cylindrical projections match expected known values', () => {
	const plateCarree = projectLonLat(CylindricalEquidistant.plateCarree, deg(20), deg(30), { centralMeridian: deg(10) })
	expect(plateCarree).toBeDefined()

	if (plateCarree !== undefined) {
		expect(plateCarree[0]).toBeCloseTo(deg(10), 12)
		expect(plateCarree[1]).toBeCloseTo(deg(30), 12)
	}

	const equirectangular = projectLonLat(CylindricalEquidistant.default, deg(20), deg(30), { centralMeridian: deg(10), standardParallel1: deg(60) })
	expect(equirectangular).toBeDefined()

	if (equirectangular !== undefined) {
		expect(equirectangular[0]).toBeCloseTo(deg(5), 12)
		expect(equirectangular[1]).toBeCloseTo(deg(30), 12)
	}

	const mercatorNorth = projectLonLat(Mercator.default, 0, deg(45))
	const mercatorSouth = projectLonLat(Mercator.default, 0, deg(-45))
	expect(mercatorNorth).toBeDefined()
	expect(mercatorSouth).toBeDefined()

	if (mercatorNorth !== undefined && mercatorSouth !== undefined) {
		expect(mercatorNorth[0]).toBeCloseTo(0, 12)
		expect(mercatorNorth[1]).toBeCloseTo(-mercatorSouth[1], 12)
	}

	const lambert = projectLonLat(CylindricalEqualArea.lambertCylindricalEqualArea, deg(20), deg(30))
	expect(lambert).toBeDefined()

	if (lambert !== undefined) {
		expect(lambert[0]).toBeCloseTo(deg(20), 12)
		expect(lambert[1]).toBeCloseTo(0.5, 12)
	}

	expect(projectLonLat(WebMercator.default, 0, PIOVERTWO)?.[1]).toBeCloseTo(PI, 12)
	expect(projectLonLat(WebMercator.default, 0, WEB_MERCATOR_MAX_LATITUDE)?.[1]).toBeCloseTo(PI, 12)
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
		expect(west[0]).toBeCloseTo(-east[0], 12)
		expect(west[1]).toBeCloseTo(east[1], 12)

		const unprojected = unprojectLonLat(CylindricalEquidistant.plateCarree, west[0], west[1], { centralMeridian: 0, raAxisDirection: 'west' })
		expect(unprojected).toBeDefined()

		if (unprojected !== undefined) {
			expect(normalizePI(unprojected[0] - deg(10))).toBeCloseTo(0, 12)
			expect(unprojected[1]).toBeCloseTo(deg(5), 12)
		}
	}

	const wrapped = projectLonLat(CylindricalEquidistant.plateCarree, deg(359), 0, { centralMeridian: 0 })
	expect(wrapped?.[0]).toBeCloseTo(deg(-1), 12)
})

test('batch projection reuses the provided output buffer', () => {
	const out = [1, 2, 3, 4]
	const projected = projectLonLatBatch(
		CylindricalEquidistant.plateCarree,
		[
			[0, 0],
			[deg(10), deg(5)],
		],
		undefined,
		out,
	)

	expect(projected).toBe(out)
	expect(projected?.[0]).toBeCloseTo(0, 12)
	expect(projected?.[1]).toBeCloseTo(0, 12)
	expect(projected?.[2]).toBeCloseTo(deg(10), 12)
	expect(projected?.[3]).toBeCloseTo(deg(5), 12)
})

test('anti-meridian polylines are split before projection', () => {
	const projection = CylindricalEquidistant.plateCarree

	const lines = projection.splitPolyline([
		[deg(179), 0],
		[deg(-179), 0],
	])

	expect(lines).toHaveLength(2)
	expect(lines[0]).toHaveLength(1)
	expect(lines[1]).toHaveLength(1)
})
