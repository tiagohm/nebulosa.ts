import { expect, test } from 'bun:test'
import { angularMotionOrDifferentialTrackingRate } from '../../../src/astronomy/coordinates/motion'
import { DAYSEC, DEG2RAD, PIOVERTWO } from '../../../src/core/constants'

test('two equatorial samples give a wrapped rate, a great-circle speed, and a position angle', () => {
	const east = angularMotionOrDifferentialTrackingRate([
		{ longitude: 1 * DEG2RAD, latitude: 0, timeDays: 1 },
		{ longitude: 359 * DEG2RAD, latitude: 0, timeDays: 0 },
	])
	expect(east).toBeDefined()
	expect(east!.longitudeRatePerDay).toBeCloseTo(2 * DEG2RAD, 12)
	expect(east!.latitudeRatePerDay).toBeCloseTo(0, 12)
	expect(east!.angularRatePerDay).toBeCloseTo(2 * DEG2RAD, 12)
	expect(east!.angularRatePerSecond).toBeCloseTo((2 * DEG2RAD) / DAYSEC, 14)
	expect(east!.positionAngle).toBeCloseTo(PIOVERTWO, 12)
	expect(east!.longitudeAccelerationPerDaySquared).toBeUndefined()

	const north = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: 0, timeDays: 0 },
		{ longitude: 0, latitude: DEG2RAD, timeDays: 1 },
	])
	expect(north!.latitudeRatePerDay).toBeCloseTo(DEG2RAD, 12)
	expect(north!.positionAngle).toBeCloseTo(0, 12)
	expect(angularMotionOrDifferentialTrackingRate([{ longitude: 0, latitude: 0, timeDays: 0 }])).toBeUndefined()
})

test('three samples publish the central rate and the change of rate', () => {
	const motion = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: 0, timeDays: 0 },
		{ longitude: DEG2RAD, latitude: 0, timeDays: 1 },
		{ longitude: 3 * DEG2RAD, latitude: 0, timeDays: 2 },
	])
	expect(motion!.longitudeRatePerDay).toBeCloseTo(1.5 * DEG2RAD, 12)
	expect(motion!.longitudeAccelerationPerDaySquared).toBeCloseTo(DEG2RAD, 12)
	expect(motion!.angularAccelerationPerDaySquared).toBeCloseTo(DEG2RAD, 12)
	expect(motion!.positionAngle).toBeCloseTo(PIOVERTWO, 12)
})

test('total motion is the exact great-circle arc away from the equator', () => {
	const motion = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: 60 * DEG2RAD, timeDays: 0 },
		{ longitude: 90 * DEG2RAD, latitude: 60 * DEG2RAD, timeDays: 1 },
	])
	expect(motion?.angularRatePerDay).toBeCloseTo(Math.acos(0.75), 12)
})
