import { describe, expect, test } from 'bun:test'
import { Gnomonic } from '../../../../src/astronomy/projections/projection'
import { timeNow } from '../../../../src/astronomy/time/time'
import { PIOVERTWO } from '../../../../src/core/constants'
import { boresightOffsetInPixels, clampDeclination, pointingOffsetInPixels, shortestRotatorDelta, wrapRotatorAngle } from '../../../../src/devices/indi/simulator/util'
import type { Point } from '../../../../src/math/numerical/geometry'
import { arcsec, deg, hour, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage for the numerical helpers shared by the device simulators. These are pure functions,
// so they run without the timers and connections the simulator integration tests need.

describe('pointing offset in pixels', () => {
	// 2 arcsec/pixel is a typical wide-field imaging scale.
	const pixelScale = arcsec(2)
	const rightAscension = hour(5)
	const declination = deg(20)

	test('shifts the field towards positive x for a boresight moved east', () => {
		// 20 pixels of on-sky angle, converted to a right ascension delta at this declination.
		const delta = (20 * pixelScale) / Math.cos(declination)
		const offset: Point = { x: 0, y: 0 }

		expect(pointingOffsetInPixels(rightAscension, declination, rightAscension + delta, declination, pixelScale, offset)).toBeTrue()
		expect(offset.x).toBeCloseTo(20, 3)
		// Not exactly zero: a pure right ascension displacement follows a parallel, not a great circle,
		// so it leaves a second-order residual in y of well under a hundredth of a pixel.
		expect(offset.y).toBeCloseTo(0, 2)

		// The opposite displacement mirrors it, which is what makes a drift reverse direction.
		expect(pointingOffsetInPixels(rightAscension, declination, rightAscension - delta, declination, pixelScale, offset)).toBeTrue()
		expect(offset.x).toBeCloseTo(-20, 3)
	})

	test('shifts the field towards positive y for a boresight moved north', () => {
		const offset: Point = { x: 0, y: 0 }

		expect(pointingOffsetInPixels(rightAscension, declination, rightAscension, declination + 20 * pixelScale, pixelScale, offset)).toBeTrue()
		expect(offset.x).toBeCloseTo(0, 6)
		expect(offset.y).toBeCloseTo(20, 3)

		expect(pointingOffsetInPixels(rightAscension, declination, rightAscension, declination - 20 * pixelScale, pixelScale, offset)).toBeTrue()
		expect(offset.y).toBeCloseTo(-20, 3)
	})

	test('scales the right ascension delta by the cosine of the declination', () => {
		// The same coordinate delta covers half the on-sky angle at 60 degrees, where cos is 0.5.
		const delta = arcsec(60)
		const atEquator: Point = { x: 0, y: 0 }
		const atSixty: Point = { x: 0, y: 0 }

		pointingOffsetInPixels(rightAscension, 0, rightAscension + delta, 0, pixelScale, atEquator)
		pointingOffsetInPixels(rightAscension, deg(60), rightAscension + delta, deg(60), pixelScale, atSixty)

		expect(atEquator.x / atSixty.x).toBeCloseTo(2, 3)
	})

	test('agrees with re-projecting the field around the boresight', () => {
		// The shortcut translates the field rigidly instead of re-projecting it. This checks that the
		// two agree well within a pixel for a realistic error and an off-axis star.
		const boresightRightAscension = rightAscension + (20 * pixelScale) / Math.cos(declination)
		const boresightDeclination = declination + 7 * pixelScale
		const starRightAscension = rightAscension + arcsec(300) / Math.cos(declination)
		const starDeclination = declination + arcsec(180)
		const point: Point = { x: 0, y: 0 }

		new Gnomonic(boresightRightAscension, boresightDeclination).project(starRightAscension, starDeclination, point)
		const reprojectedX = -point.x / pixelScale
		const reprojectedY = -point.y / pixelScale

		new Gnomonic(rightAscension, declination).project(starRightAscension, starDeclination, point)
		const nominalX = -point.x / pixelScale
		const nominalY = -point.y / pixelScale

		const offset: Point = { x: 0, y: 0 }
		pointingOffsetInPixels(rightAscension, declination, boresightRightAscension, boresightDeclination, pixelScale, offset)

		expect(nominalX + offset.x).toBeCloseTo(reprojectedX, 1)
		expect(nominalY + offset.y).toBeCloseTo(reprojectedY, 1)
	})

	test('reports no displacement and leaves the output untouched when there is no error', () => {
		const offset: Point = { x: 123, y: 456 }

		expect(pointingOffsetInPixels(rightAscension, declination, rightAscension, declination, pixelScale, offset)).toBeFalse()
		expect(offset).toEqual({ x: 123, y: 456 })

		expect(pointingOffsetInPixels(rightAscension, declination, rightAscension + arcsec(1), declination, 0, offset)).toBeFalse()
		expect(offset).toEqual({ x: 123, y: 456 })
	})
})

describe('rotator angle helpers', () => {
	test('wraps angles into [0, 360)', () => {
		expect(wrapRotatorAngle(0)).toBe(0)
		expect(wrapRotatorAngle(360)).toBe(0)
		expect(wrapRotatorAngle(370)).toBeCloseTo(10, 12)
		expect(wrapRotatorAngle(-10)).toBeCloseTo(350, 12)
	})

	test('returns the shortest signed delta', () => {
		expect(shortestRotatorDelta(10, 350)).toBeCloseTo(20, 12)
		expect(shortestRotatorDelta(350, 10)).toBeCloseTo(-20, 12)
		expect(shortestRotatorDelta(180, 0)).toBe(180)
	})
})

describe('declination clamp', () => {
	test('bounds the declination to the poles', () => {
		expect(clampDeclination(PIOVERTWO * 2)).toBe(PIOVERTWO)
		expect(clampDeclination(-PIOVERTWO * 2)).toBe(-PIOVERTWO)
		expect(clampDeclination(0.5)).toBe(0.5)
	})
})

describe('boresight offset in pixels', () => {
	// About two arcseconds per pixel, the scale of the simulated camera on its default telescope.
	const PIXEL_SCALE = arcsec(2.1454)

	test('expresses the offset in the J2000 plane the scene is drawn in', () => {
		const time = timeNow(true)
		const center: readonly [number, number] = [hour(5), deg(20)]
		// A hundred pixels due east of the centre, on the sky of date.
		const sample: readonly [number, number] = [center[0] + (100 * PIXEL_SCALE) / Math.cos(center[1]), center[1]]

		const offset: Point = { x: 0, y: 0 }
		expect(boresightOffsetInPixels(center[0], center[1], sample[0], sample[1], PIXEL_SCALE, time, offset)).toBeTrue()

		// Same displacement projected in the frame of date, which is what the catalog is not drawn in.
		const ofDate: Point = { x: 0, y: 0 }
		pointingOffsetInPixels(center[0], center[1], sample[0], sample[1], PIXEL_SCALE, ofDate)

		// The travel itself survives the change of frame, since it is the same angle on the sky.
		expect(offset.x).toBeCloseTo(ofDate.x, 2)

		// The tangent basis does not: precession and nutation rotate it, so a purely eastward move of a
		// hundred pixels acquires a fraction of a pixel of north-south displacement in the frame the
		// stars were projected into. Leaving the samples in the frame of date drops exactly this.
		expect(Math.abs(offset.y - ofDate.y)).toBeGreaterThan(0.2)
		expect(Math.abs(offset.y - ofDate.y)).toBeLessThan(1)
	})

	test('reports no offset for a boresight on the centre', () => {
		const offset: Point = { x: 0, y: 0 }
		expect(boresightOffsetInPixels(hour(5), deg(20), hour(5), deg(20), PIXEL_SCALE, timeNow(true), offset)).toBeFalse()
		expect(boresightOffsetInPixels(hour(5), deg(20), hour(5) + arcsec(10), deg(20), 0, timeNow(true), offset)).toBeFalse()
	})
})
