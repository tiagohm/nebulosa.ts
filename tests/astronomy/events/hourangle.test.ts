import { expect, test } from 'bun:test'
import { hourAngle, hourAngleWindows, timeUntilMeridian } from '../../../src/astronomy/events/hourangle'
import { PI, PIOVERFOUR, PIOVERTWO, SIDEREAL_DAYSEC, SIDEREAL_DRIFT_RATE, TAU } from '../../../src/core/constants'

test('hour angle and the wait to the meridian follow the sidereal rate', () => {
	expect(hourAngle(0, 0)).toBe(0)
	expect(hourAngle(0, PIOVERTWO)).toBeCloseTo(-PIOVERTWO, 12)
	expect(timeUntilMeridian(0)).toBe(0)
	expect(timeUntilMeridian(-SIDEREAL_DRIFT_RATE)).toBeCloseTo(1, 9)
	expect(timeUntilMeridian(PIOVERTWO)).toBeCloseTo(0.75 * SIDEREAL_DAYSEC, 6)
	expect(timeUntilMeridian(-PI)).toBeCloseTo(0.5 * SIDEREAL_DAYSEC, 6)
})

test('hour-angle windows are the future stretches inside the signed bounds', () => {
	const start = -PIOVERFOUR
	const enter = PI / 12 / SIDEREAL_DRIFT_RATE
	const exit = (PI / 6 - start) / SIDEREAL_DRIFT_RATE
	const windows = hourAngleWindows(start, -PI / 6, PI / 6, SIDEREAL_DAYSEC)
	expect(windows[0]?.startSeconds).toBeCloseTo(enter, 6)
	expect(windows[0]?.endSeconds).toBeCloseTo(exit, 6)
	expect(hourAngleWindows(0, -PI, PI, 1000)).toEqual([{ startSeconds: 0, endSeconds: 1000 }])
	expect(hourAngleWindows(0, 1, 1, 100)).toEqual([])

	const wrapping = hourAngleWindows(0, 2, -2, SIDEREAL_DAYSEC)
	const inside = wrapping.reduce((sum, window) => sum + window.endSeconds - window.startSeconds, 0)
	expect(inside).toBeCloseTo((TAU - 4) / SIDEREAL_DRIFT_RATE, 4)
	expect(() => hourAngleWindows(0, -1, 1, SIDEREAL_DAYSEC * 100_001)).toThrow('hour-angle window is too long')
})
