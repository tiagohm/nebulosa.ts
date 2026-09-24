import { expect, test } from 'bun:test'
import { parallacticAngle } from '../../../src/astronomy/coordinates/astrometry'
import { derotatorAngle, derotatorTrack, fieldRotation } from '../../../src/astronomy/coordinates/field'
import { DEG2RAD, PI, PIOVERTWO, SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'

test('field rotation is the sidereal rate on the equator looking due north and is undefined at the zenith', () => {
	const north = fieldRotation(0, 0, 0, 1, 1000)
	expect(north).toBeDefined()
	expect(north!.radiansPerSecond).toBeCloseTo(SIDEREAL_DRIFT_RATE, 12)
	expect(north!.radiansPerMinute).toBeCloseTo(SIDEREAL_DRIFT_RATE * 60, 12)
	expect(north!.maxExposureSeconds).toBeCloseTo(1 / (SIDEREAL_DRIFT_RATE * 1000), 8)
	expect(fieldRotation(0, PIOVERTWO, 0, 1, 1000)?.maxExposureSeconds).toBe(Number.POSITIVE_INFINITY)
	expect(fieldRotation(0, PIOVERTWO, 0)?.radiansPerSecond).toBeCloseTo(0, 12)
	expect(fieldRotation(0, PI, 0)!.radiansPerSecond).toBeCloseTo(-SIDEREAL_DRIFT_RATE, 12)
	expect(fieldRotation(0, 0, PIOVERTWO)).toBeUndefined()
})

test('derotator angle cancels the parallactic angle and advances with sidereal hour angle', () => {
	expect(derotatorAngle(0, 0, 45 * DEG2RAD)).toBeCloseTo(0, 12)
	expect(derotatorAngle(0, 0, 45 * DEG2RAD, PIOVERTWO)).toBeCloseTo(PIOVERTWO, 12)
	expect(derotatorAngle(0.3, 0.2, 0.6, 0.1)).toBeCloseTo(0.1 - parallacticAngle(0.3, 0.2, 0.6), 12)
	const duration = 3600
	const track = derotatorTrack(0, 0, 45 * DEG2RAD, duration, 600)
	expect(track.at(0)).toEqual({ seconds: 0, angle: 0 })
	expect(track.at(-1)?.seconds).toBe(duration)
	expect(track.at(-1)?.angle).toBeCloseTo(derotatorAngle(SIDEREAL_DRIFT_RATE * duration, 0, 45 * DEG2RAD), 12)
	expect(derotatorTrack(0, 0, 45 * DEG2RAD, 0, 1)).toEqual([{ seconds: 0, angle: 0 }])
	expect(() => derotatorTrack(0, 0, 45 * DEG2RAD, 10, 0)).toThrow('derotator step must be positive')
})
