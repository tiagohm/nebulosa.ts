import { describe, expect, test } from 'bun:test'
import { eraC2s } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { gcrsToItrsRotationMatrix, type Time, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, PI, SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import { matMulVec, matTransposeMulVec } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecAngle, vecCross, vecNormalize, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { arcsec, deg, toArcsec } from '../../../src/math/units/angle'
import { ThreePointPolarAlignment, type ThreePointPolarAlignmentResult, threePointPolarAlignmentAfterAdjustment, threePointPolarAlignmentError } from '../../../src/observation/alignment/polaralignment'
import { applyMountAdjustment } from '../../../src/observation/alignment/polaralignment.util'

// Exact rigid-mount geometry, independent of the simulator's first-order TPoint model and ASTAP.
// All boresights lie on one circle in ITRS even when their ICRF coordinates span hours or days.
function rigidMount(latitude: number, azimuthError: number = arcsec(300), altitudeError: number = arcsec(300)) {
	const location = geodeticLocation(deg(-45), latitude)
	const time = timeYMDHMS(2026, 9, 9, 0, 30, 0)
	time.location = location
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const sinLon = Math.sin(location.longitude)
	const cosLon = Math.cos(location.longitude)
	const north: Vec3 = [-sinLat * cosLon, -sinLat * sinLon, cosLat]
	const east: Vec3 = [-sinLon, cosLon, 0]
	const up: Vec3 = [cosLat * cosLon, cosLat * sinLon, sinLat]
	const azimuth = (latitude > 0 ? 0 : PI) + azimuthError
	const altitude = Math.abs(latitude) + (latitude > 0 ? 1 : -1) * altitudeError
	const n = Math.cos(altitude) * Math.cos(azimuth)
	const e = Math.cos(altitude) * Math.sin(azimuth)
	const u = Math.sin(altitude)
	const pole: Vec3 = [north[0] * n + east[0] * e + up[0] * u, north[1] * n + east[1] * e + up[1] * u, north[2] * n + up[2] * u]
	const start = vecNormalize(vecCross(pole, up))
	const rate = SIDEREAL_DRIFT_RATE
	const direction = latitude > 0 ? -1 : 1
	return { time, pole, start, up, east, rate, direction }
}

function plateSolve(vector: Vec3, time: Time) {
	return [...eraC2s(...matTransposeMulVec(gcrsToItrsRotationMatrix(time), vector)), time] as const
}

function expectPole(result: ThreePointPolarAlignmentResult | false, pole: Vec3, time: Time, tolerance: number = 0.0001) {
	expect(result).not.toBeFalse()
	if (!result) throw new Error('alignment must be defined after three distinct poses')
	expect(result.time).toBe(time)
	const actual = matMulVec(gcrsToItrsRotationMatrix(time), result.pole)
	expect(toArcsec(vecAngle(actual, pole))).toBeLessThan(tolerance)
	return result
}

for (const latitude of [deg(-22), deg(40)]) {
	describe(`timestamped polar alignment at latitude ${latitude}`, () => {
		test.each([0, 1200])('fits a stationary terrestrial axis with %i seconds between seed exposures', (gap) => {
			const mount = rigidMount(latitude)
			const alignment = new ThreePointPolarAlignment(false)
			const firstTime = mount.time
			const secondTime = timeShift(firstTime, gap / DAYSEC)
			const thirdTime = timeShift(firstTime, (2 * gap) / DAYSEC)
			const first = plateSolve(mount.start, firstTime)
			const second = plateSolve(vecRotateByRodrigues(mount.start, mount.pole, 0.4), secondTime)
			const third = plateSolve(vecRotateByRodrigues(mount.start, mount.pole, 0.8), thirdTime)
			expect(alignment.add(...first)).toBeFalse()
			expect(alignment.add(...second)).toBeFalse()
			expectPole(alignment.add(...third), mount.pole, thirdTime)
			expectPole(threePointPolarAlignmentError(first, second, third, false, thirdTime.location), mount.pole, thirdTime)
		})

		test.each([0, SIDEREAL_DRIFT_RATE])('refreshes for 36 hours without inventing adjustments at tracking rate %f', (rate) => {
			const mount = rigidMount(latitude)
			const alignment = new ThreePointPolarAlignment(false, rate)
			let reference: Vec3 = mount.start
			let referenceTime = mount.time
			let seed: ThreePointPolarAlignmentResult | undefined

			for (let i = 0; i < 3; i++) {
				referenceTime = timeShift(mount.time, (i * 1200) / DAYSEC)
				reference = vecRotateByRodrigues(mount.start, mount.pole, i * 0.4)
				const result = alignment.add(...plateSolve(reference, referenceTime))
				if (i === 2) seed = expectPole(result, mount.pole, referenceTime)
			}

			// Cross meridian/horizon geometry, date boundaries and a whole sidereal rotation.
			for (let i = 1; i <= 108; i++) {
				const seconds = i * 1200
				const time = timeShift(referenceTime, seconds / DAYSEC)
				const boresight = vecRotateByRodrigues(reference, mount.pole, mount.direction * rate * seconds)
				const result = expectPole(alignment.add(...plateSolve(boresight, time)), mount.pole, time)
				expect(Math.abs(toArcsec(result.azimuthError - seed!.azimuthError))).toBeLessThan(0.1)
				expect(Math.abs(toArcsec(result.altitudeError - seed!.altitudeError))).toBeLessThan(0.1)
				expect(Math.abs(toArcsec(result.azimuthAdjustment))).toBeLessThan(0.0001)
				expect(Math.abs(toArcsec(result.altitudeAdjustment))).toBeLessThan(0.0001)
			}
		})

		test('retains a real base adjustment after tracking across an hour', () => {
			const mount = rigidMount(latitude)
			const alignment = new ThreePointPolarAlignment(false)
			const reference = vecRotateByRodrigues(mount.start, mount.pole, 0.8)
			for (let i = 0; i < 3; i++) alignment.add(...plateSolve(vecRotateByRodrigues(mount.start, mount.pole, i * 0.4), mount.time))
			const time = timeShift(mount.time, 1 / 24)
			const azimuth = arcsec(20)
			const altitude = arcsec(-30)
			const tracked = vecRotateByRodrigues(reference, mount.pole, mount.direction * mount.rate * 3600)
			const adjusted = applyMountAdjustment(tracked, mount.up, mount.east, azimuth, altitude)
			const adjustedPole = applyMountAdjustment(mount.pole, mount.up, mount.east, azimuth, altitude)
			const result = expectPole(alignment.add(...plateSolve(adjusted, time)), adjustedPole, time, 0.02)
			expect(Math.abs(toArcsec(result.azimuthAdjustment - azimuth))).toBeLessThan(0.02)
			expect(Math.abs(toArcsec(result.altitudeAdjustment - altitude))).toBeLessThan(0.02)
			const later = timeShift(time, 1200 / DAYSEC)
			const next = vecRotateByRodrigues(adjusted, adjustedPole, mount.direction * mount.rate * 1200)
			expectPole(alignment.add(...plateSolve(next, later)), adjustedPole, later, 0.03)
		})

		test('reset discards the previous exposure epochs as well as the pole', () => {
			const mount = rigidMount(latitude)

			const alignment = new ThreePointPolarAlignment(false)
			for (let i = 0; i < 3; i++) alignment.add(...plateSolve(vecRotateByRodrigues(mount.start, mount.pole, i * 0.4), mount.time))
			alignment.reset()

			for (let i = 0; i < 3; i++) {
				const time = timeShift(mount.time, 2 + (i * 1200) / DAYSEC)
				const point = vecRotateByRodrigues(mount.start, mount.pole, i * 0.5)
				const result = alignment.add(...plateSolve(point, time))
				if (i < 2) expect(result).toBeFalse()
				else expectPole(result, mount.pole, time)
			}
		})
	})
}

test('same-epoch unchanged refresh preserves the pole and reports no adjustment', () => {
	const mount = rigidMount(deg(-22))
	const first = plateSolve(mount.start, mount.time)
	const second = plateSolve(vecRotateByRodrigues(mount.start, mount.pole, 0.4), mount.time)
	const third = plateSolve(vecRotateByRodrigues(mount.start, mount.pole, 0.8), mount.time)
	const seed = threePointPolarAlignmentError(first, second, third, false)
	if (!seed) throw new Error('non-degenerate fixture')
	const updated = threePointPolarAlignmentAfterAdjustment(seed, third, third, false)
	expect(updated.pole).toBe(seed.pole)
	expect(updated.azimuthAdjustment).toBe(0)
	expect(updated.altitudeAdjustment).toBe(0)
})
