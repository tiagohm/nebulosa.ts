import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { intersectLineAndSphere, midPoint, rectIntersection, sphericalDestination, sphericalInterpolate, sphericalPositionAngle, sphericalSeparation } from '../src/geometry'

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
