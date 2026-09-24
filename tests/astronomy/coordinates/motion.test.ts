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

test('constant-speed inclined great-circle motion has no tangential acceleration', () => {
	const inclination = 45 * DEG2RAD
	const sample = (timeDays: number) => {
		const x = Math.cos(timeDays)
		const y = Math.cos(inclination) * Math.sin(timeDays)
		const z = Math.sin(inclination) * Math.sin(timeDays)
		return { longitude: Math.atan2(y, x), latitude: Math.asin(z), timeDays }
	}
	const motion = angularMotionOrDifferentialTrackingRate([sample(0.5), sample(0.6), sample(0.7)])
	expect(motion?.angularRatePerDay).toBeCloseTo(1, 12)
	expect(motion?.angularAccelerationPerDaySquared).toBeCloseTo(0, 12)
})

test('tangential acceleration supports non-uniform samples and longitude wrap', () => {
	const sample = (timeDays: number) => ({ longitude: 359.9 * DEG2RAD + 0.5 * timeDays * timeDays, latitude: 0, timeDays })
	const motion = angularMotionOrDifferentialTrackingRate([sample(0), sample(0.001), sample(0.003)])
	expect(motion?.longitudeAccelerationPerDaySquared).toBeCloseTo(1, 8)
	expect(motion?.latitudeAccelerationPerDaySquared).toBeCloseTo(0, 12)
	expect(motion?.angularAccelerationPerDaySquared).toBeCloseTo(1, 5)

	const meridian = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: -0.1, timeDays: 0 },
		{ longitude: 0, latitude: 0, timeDays: 0.1 },
		{ longitude: 0, latitude: 0.1, timeDays: 0.2 },
	])
	expect(meridian?.angularAccelerationPerDaySquared).toBeCloseTo(0, 12)
})

test('antipodal legs omit their undefined tangent without rejecting ordinary long legs', () => {
	const equatorialAntipode = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: 0, timeDays: 0 },
		{ longitude: Math.PI, latitude: 0, timeDays: 1 },
		{ longitude: Math.PI + 0.1, latitude: 0, timeDays: 2 },
	])
	expect(equatorialAntipode?.angularAccelerationPerDaySquared).toBeUndefined()

	const polarAntipode = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: PIOVERTWO, timeDays: 0 },
		{ longitude: 0, latitude: -PIOVERTWO, timeDays: 1 },
		{ longitude: 0, latitude: -PIOVERTWO + 0.1, timeDays: 2 },
	])
	expect(polarAntipode?.angularAccelerationPerDaySquared).toBeUndefined()

	const longButDefined = angularMotionOrDifferentialTrackingRate([
		{ longitude: 0, latitude: 0, timeDays: 0 },
		{ longitude: Math.PI - 1e-5, latitude: 0, timeDays: 1 },
		{ longitude: Math.PI - 1e-5 + 0.1, latitude: 0, timeDays: 2 },
	])
	expect(longButDefined?.angularAccelerationPerDaySquared).toBeFinite()

	const wrapped = angularMotionOrDifferentialTrackingRate([
		{ longitude: 359 * DEG2RAD, latitude: 0, timeDays: 0 },
		{ longitude: 0, latitude: 0, timeDays: 1 },
		{ longitude: DEG2RAD, latitude: 0, timeDays: 2 },
	])
	expect(wrapped?.angularAccelerationPerDaySquared).toBeDefined()
})
