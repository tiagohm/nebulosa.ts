import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { gnomonicProject, gnomonicUnproject } from '../src/projection'

test('gnomonic projection round-trips near the tangent point', () => {
	const centerLongitude = deg(10)
	const centerLatitude = deg(-20)
	const longitude = deg(11.5)
	const latitude = deg(-19.25)

	expect(gnomonicProject(centerLongitude, centerLatitude, centerLongitude, centerLatitude)).toEqual({ x: 0, y: 0 })

	const projected = gnomonicProject(longitude, latitude, centerLongitude, centerLatitude)
	expect(projected).not.toBeFalse()

	if (projected) {
		const [unprojectedLongitude, unprojectedLatitude] = gnomonicUnproject(projected.x, projected.y, centerLongitude, centerLatitude)
		expect(unprojectedLongitude).toBeCloseTo(longitude, 11)
		expect(unprojectedLatitude).toBeCloseTo(latitude, 11)
	}

	expect(gnomonicProject(Math.PI, 0, 0, 0)).toBeFalse()
})
