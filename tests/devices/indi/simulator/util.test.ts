import { describe, expect, test } from 'bun:test'
import { Gnomonic } from '../../../../src/astronomy/projections/projection'
import { PIOVERTWO } from '../../../../src/core/constants'
import { clampDeclination, periodicErrorOffset, pointingOffsetInPixels, shortestRotatorDelta, wrapRotatorAngle } from '../../../../src/devices/indi/simulator/util'
import type { Point } from '../../../../src/math/numerical/geometry'
import { arcsec, deg, hour, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage for the numerical helpers shared by the device simulators. These are pure functions,
// so they run without the timers and connections the simulator integration tests need.

describe('periodic error offset', () => {
	// A 480 s worm period with a 5 arcsec semi-amplitude is a typical small equatorial mount.
	const period = 480
	const amplitude = 5

	test('follows the sine over one full cycle', () => {
		expect(toArcsec(periodicErrorOffset(period, amplitude, 0))).toBeCloseTo(0, 9)
		expect(toArcsec(periodicErrorOffset(period, amplitude, period * 250))).toBeCloseTo(amplitude, 9)
		expect(toArcsec(periodicErrorOffset(period, amplitude, period * 500))).toBeCloseTo(0, 9)
		expect(toArcsec(periodicErrorOffset(period, amplitude, period * 750))).toBeCloseTo(-amplitude, 9)
	})

	test('is periodic across cycle boundaries', () => {
		const periodMilliseconds = period * 1000

		for (const fraction of [0.1, 0.37, 0.5, 0.82]) {
			const time = periodMilliseconds * fraction
			expect(periodicErrorOffset(period, amplitude, time + periodMilliseconds * 7)).toBeCloseTo(periodicErrorOffset(period, amplitude, time), 15)
		}
	})

	test('is an absolute offset, not an increment', () => {
		// The regression this guards: evaluating twice at the same instant used to return the full
		// offset first and then only the difference from the previous call, which was zero.
		const time = period * 137
		const first = periodicErrorOffset(period, amplitude, time)
		const second = periodicErrorOffset(period, amplitude, time)
		expect(second).toBe(first)
		expect(first).not.toBe(0)

		// Advancing the clock a little must change the offset by a little, not reset it.
		const later = periodicErrorOffset(period, amplitude, time + 1000)
		expect(later).not.toBe(first)
		expect(Math.abs(toArcsec(later - first))).toBeLessThan(amplitude)
	})

	test('is disabled by a non-positive period or a zero amplitude', () => {
		expect(periodicErrorOffset(0, amplitude, 12345)).toBe(0)
		expect(periodicErrorOffset(-period, amplitude, 12345)).toBe(0)
		expect(periodicErrorOffset(period, 0, 12345)).toBe(0)
	})

	test('scales linearly with the amplitude', () => {
		const time = period * 250
		expect(periodicErrorOffset(period, 2 * amplitude, time)).toBeCloseTo(2 * periodicErrorOffset(period, amplitude, time), 15)
	})
})

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
