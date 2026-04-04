import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { eraC2s, eraS2c, eraS2p } from '../src/erfa'
// biome-ignore format: too long
import { intersectLineAndSphere, midPoint, rectIntersection, type SphericalMountBasis, type SphericalTangentBasis, sphericalCoordinateBasis, sphericalDestination, sphericalDirectionVector, sphericalGreatCirclePole, sphericalInterpolate, sphericalMountBasis, sphericalMountDeclinationAxisVector, sphericalMountPolarAxisVector, sphericalOffsetVector, sphericalPoleVector, sphericalPositionAngle, sphericalProjectTangentPlane, sphericalSeparation, sphericalTangentBasis, sphericalUnprojectTangentPlane } from '../src/geometry'
import { type Vec3, vecCross, vecDot, vecLength, vecNormalize } from '../src/vec3'

// Checks a vector with one tolerance per component.
function expectVectorClose(actual: Vec3, expected: Vec3, digits: number = 14) {
	expect(actual[0]).toBeCloseTo(expected[0], digits)
	expect(actual[1]).toBeCloseTo(expected[1], digits)
	expect(actual[2]).toBeCloseTo(expected[2], digits)
}

// Checks that a spherical tangent basis is orthonormal and right-handed.
function expectOrthonormalBasis(basis: SphericalTangentBasis, digits: number = 14) {
	expect(vecLength(basis.origin)).toBeCloseTo(1, digits)
	expect(vecLength(basis.east)).toBeCloseTo(1, digits)
	expect(vecLength(basis.north)).toBeCloseTo(1, digits)
	expect(vecDot(basis.origin, basis.east)).toBeCloseTo(0, digits)
	expect(vecDot(basis.origin, basis.north)).toBeCloseTo(0, digits)
	expect(vecDot(basis.east, basis.north)).toBeCloseTo(0, digits)
	expectVectorClose(vecCross(basis.east, basis.north), basis.origin, digits)
}

// Checks that a mount basis is orthonormal and consistent with the right-handed axis convention.
function expectMountBasis(basis: SphericalMountBasis, digits: number = 14) {
	expect(vecLength(basis.origin)).toBeCloseTo(1, digits)
	expect(vecLength(basis.polarAxis)).toBeCloseTo(1, digits)
	expect(vecLength(basis.declinationAxis)).toBeCloseTo(1, digits)
	expect(vecLength(basis.hourAngleTangent)).toBeCloseTo(1, digits)
	expect(vecLength(basis.declinationTangent)).toBeCloseTo(1, digits)
	expect(vecDot(basis.origin, basis.declinationAxis)).toBeCloseTo(0, digits)
	expect(vecDot(basis.origin, basis.hourAngleTangent)).toBeCloseTo(0, digits)
	expect(vecDot(basis.origin, basis.declinationTangent)).toBeCloseTo(0, digits)
	expect(vecDot(basis.declinationAxis, basis.declinationTangent)).toBeCloseTo(0, digits)
	expectVectorClose(vecNormalize(vecCross(basis.polarAxis, basis.origin)), basis.hourAngleTangent, digits)
	expectVectorClose(vecNormalize(vecCross(basis.declinationAxis, basis.origin)), basis.declinationTangent, digits)
}

test('mid point', () => {
	expect(midPoint({ x: 1, y: 3 }, { x: 3, y: 9 })).toEqual({ x: 2, y: 6 })
})

test('rectangle intersection', () => {
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 5, top: 5, right: 15, bottom: 15 })).toEqual({ left: 5, right: 10, top: 5, bottom: 10 })
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 11, top: 11, right: 15, bottom: 15 })).toBeUndefined()
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 5, top: 5, right: 8, bottom: 8 })).toEqual({ left: 5, right: 8, top: 5, bottom: 8 })
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 9.99, top: 9.99, right: 15, bottom: 15 })).toEqual({ left: 9.99, right: 10, top: 9.99, bottom: 10 })
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 10, top: 10, right: 15, bottom: 15 })).toBeUndefined()
})

test('intersect line and sphere', () => {
	const res = intersectLineAndSphere([1, 0, 0], [0, 0, 0], 3)
	expect(res).not.toBeFalse()
	res && expect(res).toEqual([-3, 3])
})

test('spherical separation stays stable near the pole', () => {
	expect(sphericalSeparation(0, deg(89), Math.PI, deg(89))).toBeCloseTo(deg(2), 14)
	expect(sphericalSeparation(0, 0, deg(90), 0)).toBeCloseTo(deg(90), 14)
})

test('spherical position angle is measured east of north', () => {
	expect(sphericalPositionAngle(0, 0, 0, deg(45))).toBeCloseTo(0, 14)
	expect(sphericalPositionAngle(0, 0, deg(90), 0)).toBeCloseTo(deg(90), 14)
})

test('spherical destination preserves distance and position angle', () => {
	const longitude = deg(12)
	const latitude = deg(30)
	const positionAngle = deg(60)
	const distance = deg(25)
	const [nextLongitude, nextLatitude] = sphericalDestination(longitude, latitude, positionAngle, distance)

	expect(sphericalSeparation(longitude, latitude, nextLongitude, nextLatitude)).toBeCloseTo(distance, 11)
	expect(sphericalPositionAngle(longitude, latitude, nextLongitude, nextLatitude)).toBeCloseTo(positionAngle, 11)
})

test('spherical interpolation follows the great-circle arc', () => {
	let [longitude, latitude] = sphericalInterpolate(0, 0, deg(90), 0, 0.5)
	expect(longitude).toBeCloseTo(deg(45), 14)
	expect(latitude).toBeCloseTo(0, 14)

	;[longitude, latitude] = sphericalInterpolate(0, 0, Math.PI, 0, 0.5)
	expect(sphericalSeparation(0, 0, longitude, latitude)).toBeCloseTo(deg(90), 11)
	expect(sphericalSeparation(Math.PI, 0, longitude, latitude)).toBeCloseTo(deg(90), 11)
})

test('spherical vectors round-trip through spherical coordinates', () => {
	const longitude = deg(123)
	const latitude = deg(-34)
	const radius = 2.5
	const vector = eraS2p(longitude, latitude, radius)
	const [nextLongitude, nextLatitude] = eraC2s(...vector)

	expect(vecLength(vector)).toBeCloseTo(radius, 14)
	expect(nextLongitude).toBeCloseTo(longitude, 14)
	expect(nextLatitude).toBeCloseTo(latitude, 14)

	const unit = eraS2c(longitude, latitude)
	expect(vecLength(unit)).toBeCloseTo(1, 14)
	expectVectorClose(unit, [vector[0] / radius, vector[1] / radius, vector[2] / radius], 14)
})

test('spherical coordinate basis is orthonormal and aligned with lon-lat directions', () => {
	const longitude = deg(42)
	const latitude = deg(28)
	const basis = sphericalCoordinateBasis(longitude, latitude)

	expectOrthonormalBasis(basis)
	expectVectorClose(basis.origin, eraS2c(longitude, latitude), 14)
	expectVectorClose(basis.east, [-Math.sin(longitude), Math.cos(longitude), 0], 14)
})

test('spherical tangent basis matches coordinate basis away from the pole', () => {
	const longitude = deg(17)
	const latitude = deg(41)
	const expected = sphericalCoordinateBasis(longitude, latitude)
	const actual = sphericalTangentBasis(eraS2p(longitude, latitude, 3))

	expectOrthonormalBasis(actual)
	expectVectorClose(actual.origin, expected.origin, 14)
	expectVectorClose(actual.east, expected.east, 14)
	expectVectorClose(actual.north, expected.north, 14)
})

test('spherical tangent basis stays stable at the pole and zero vector', () => {
	const poleBasis = sphericalTangentBasis([0, 0, 9])
	expectOrthonormalBasis(poleBasis)
	expectVectorClose(poleBasis.origin, [0, 0, 1], 14)
	expectVectorClose(poleBasis.east, [0, 1, 0], 14)
	expectVectorClose(poleBasis.north, [-1, 0, 0], 14)

	const zeroBasis = sphericalTangentBasis([0, 0, 0])
	expectVectorClose(zeroBasis.origin, [0, 0, 0], 14)
	expectVectorClose(zeroBasis.east, [1, 0, 0], 14)
	expectVectorClose(zeroBasis.north, [0, 1, 0], 14)
})

test('spherical direction and pole vectors follow position angle', () => {
	const longitude = deg(33)
	const latitude = deg(-15)
	const positionAngle = deg(64)
	const origin = eraS2c(longitude, latitude)
	const basis = sphericalCoordinateBasis(longitude, latitude)
	const direction = sphericalDirectionVector(origin, positionAngle)
	const pole = sphericalPoleVector(origin, positionAngle)

	expect(vecLength(direction)).toBeCloseTo(1, 14)
	expect(vecLength(pole)).toBeCloseTo(1, 14)
	expect(vecDot(direction, origin)).toBeCloseTo(0, 14)
	expect(vecDot(pole, origin)).toBeCloseTo(0, 14)
	expect(vecDot(pole, direction)).toBeCloseTo(0, 14)
	expect(vecDot(direction, basis.east)).toBeCloseTo(Math.sin(positionAngle), 14)
	expect(vecDot(direction, basis.north)).toBeCloseTo(Math.cos(positionAngle), 14)
	expectVectorClose(vecCross(pole, origin), direction, 14)
})

test('spherical offset and great-circle pole vectors agree with spherical destination', () => {
	const longitude = deg(12)
	const latitude = deg(30)
	const positionAngle = deg(60)
	const distance = deg(25)
	const origin = eraS2c(longitude, latitude)
	const offset = sphericalOffsetVector(origin, positionAngle, distance)
	const [nextLongitude, nextLatitude] = sphericalDestination(longitude, latitude, positionAngle, distance)
	const expected = eraS2c(nextLongitude, nextLatitude)
	const pole = sphericalPoleVector(origin, positionAngle)
	const greatCirclePole = sphericalGreatCirclePole(origin, offset)

	expectVectorClose(offset, expected, 13)
	expect(vecDot(offset, pole)).toBeCloseTo(0, 13)
	expectVectorClose(greatCirclePole, pole, 13)
})

test('spherical tangent-plane projection round-trips and follows the expected gnomonic scale', () => {
	const longitude = deg(25)
	const latitude = deg(-18)
	const positionAngle = deg(35)
	const distance = deg(7)
	const origin = eraS2c(longitude, latitude)
	const direction = sphericalOffsetVector(origin, positionAngle, distance)
	const projected = sphericalProjectTangentPlane(direction, origin)

	expect(projected).not.toBeFalse()
	if (projected === false) throw new Error('expected tangent-plane projection')

	expect(projected.x).toBeCloseTo(Math.tan(distance) * Math.sin(positionAngle), 14)
	expect(projected.y).toBeCloseTo(Math.tan(distance) * Math.cos(positionAngle), 14)
	expect(projected.denominator).toBeCloseTo(Math.cos(distance), 14)

	const unprojected = sphericalUnprojectTangentPlane(projected.x, projected.y, origin)
	expectVectorClose(unprojected, direction, 14)
	expect(sphericalProjectTangentPlane(eraS2c(longitude + Math.PI, -latitude), origin)).toBeFalse()
})

test('spherical mount polar axis vector uses hemisphere-aware polar error signs', () => {
	expectVectorClose(sphericalMountPolarAxisVector(deg(52), deg(10), deg(-2)), eraS2c(deg(10), deg(50)), 14)
	expectVectorClose(sphericalMountPolarAxisVector(deg(-35), deg(7), deg(-3)), eraS2c(Math.PI + deg(7), deg(38)), 14)
})

test('spherical mount basis aligns with equatorial east and north for a standard polar axis', () => {
	const longitude = deg(40)
	const latitude = deg(25)
	const basis = sphericalCoordinateBasis(longitude, latitude)
	const mountBasis = sphericalMountBasis(basis.origin)

	expectMountBasis(mountBasis)
	expectVectorClose(mountBasis.origin, basis.origin, 14)
	expectVectorClose(mountBasis.polarAxis, [0, 0, 1], 14)
	expectVectorClose(mountBasis.declinationAxis, [-basis.east[0], -basis.east[1], -basis.east[2]], 14)
	expectVectorClose(mountBasis.hourAngleTangent, basis.east, 14)
	expectVectorClose(mountBasis.declinationTangent, basis.north, 14)

	const declinationAxis = sphericalMountDeclinationAxisVector(basis.origin)
	expectVectorClose(declinationAxis, mountBasis.declinationAxis, 14)
})

test('spherical mount basis falls back deterministically at the pole and zero vector', () => {
	const poleBasis = sphericalMountBasis([0, 0, 1], [0, 0, 3])
	expect(vecLength(poleBasis.origin)).toBeCloseTo(1, 14)
	expect(vecLength(poleBasis.polarAxis)).toBeCloseTo(1, 14)
	expectVectorClose(poleBasis.origin, [0, 0, 1], 14)
	expectVectorClose(poleBasis.polarAxis, [0, 0, 1], 14)
	expectVectorClose(poleBasis.declinationAxis, [0, -1, 0], 14)
	expectVectorClose(poleBasis.hourAngleTangent, [0, 1, 0], 14)
	expectVectorClose(poleBasis.declinationTangent, [-1, 0, 0], 14)

	const zeroBasis = sphericalMountBasis([0, 0, 0], [0, 0, 0])
	expectVectorClose(zeroBasis.origin, [0, 0, 0], 14)
	expectVectorClose(zeroBasis.polarAxis, [0, 0, 1], 14)
	expectVectorClose(zeroBasis.declinationAxis, [0, -1, 0], 14)
	expectVectorClose(zeroBasis.hourAngleTangent, [0, 1, 0], 14)
	expectVectorClose(zeroBasis.declinationTangent, [-1, 0, 0], 14)
})
