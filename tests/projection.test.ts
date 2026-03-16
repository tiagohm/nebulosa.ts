import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { sphericalSeparation } from '../src/geometry'
import { azimuthalEquidistantProject, azimuthalEquidistantUnproject, gnomonicProject, gnomonicUnproject, lambertAzimuthalEqualAreaProject, lambertAzimuthalEqualAreaUnproject, orthographicProject, orthographicUnproject, stereographicProject, stereographicUnproject } from '../src/projection'

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
		expect(equidistant.x).toBeCloseTo(Math.PI / 2, 12)
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
	expect(gnomonicProject(Math.PI, 0, 0, 0)).toBeFalse()
	expect(orthographicProject(Math.PI, 0, 0, 0)).toBeFalse()
	expect(stereographicProject(Math.PI, 0, 0, 0)).toBeFalse()
	expect(lambertAzimuthalEqualAreaProject(Math.PI, 0, 0, 0)).toBeFalse()
	expect(azimuthalEquidistantProject(Math.PI, 0, 0, 0)).toBeFalse()

	expect(orthographicUnproject(1.000001, 0, 0, 0)).toBeFalse()
	expect(lambertAzimuthalEqualAreaUnproject(2.000001, 0, 0, 0)).toBeFalse()
	expect(azimuthalEquidistantUnproject(Math.PI + 0.000001, 0, 0, 0)).toBeFalse()
})
