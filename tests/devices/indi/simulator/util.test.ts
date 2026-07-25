import { describe, expect, test } from 'bun:test'
import { PIOVERTWO } from '../../../../src/core/constants'
import { clampDeclination, periodicErrorOffset, shortestRotatorDelta, wrapRotatorAngle } from '../../../../src/devices/indi/simulator/util'
import { toArcsec } from '../../../../src/math/units/angle'

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
