import { describe, expect, test } from 'bun:test'
import { advanceMechanicalAxis, IDENTITY_MECHANICAL_AXIS_CONFIG, type MechanicalAxisConfig, mechanicalAxisState, resetMechanicalAxisMotion } from '../../../../src/devices/indi/simulator/mount.axis'
import { arcsec, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage for the mechanical transmission of a mount axis. Pure state stepping, so no timers.

// Builds a config with only the named imperfections, everything else perfect.
function config(overrides: Partial<MechanicalAxisConfig>): MechanicalAxisConfig {
	return { ...IDENTITY_MECHANICAL_AXIS_CONFIG, ...overrides }
}

describe('mechanical axis', () => {
	test('follows the motor exactly with a perfect transmission', () => {
		const state = mechanicalAxisState()
		const rate = arcsec(10)

		for (let i = 0; i < 5; i++) {
			expect(advanceMechanicalAxis(state, rate, 1, IDENTITY_MECHANICAL_AXIS_CONFIG)).toBeCloseTo(rate, 15)
		}

		// Reversing costs nothing when there is no slack.
		expect(advanceMechanicalAxis(state, -rate, 1, IDENTITY_MECHANICAL_AXIS_CONFIG)).toBeCloseTo(-rate, 15)
	})

	test('is a no-op for a zero rate or a non-positive interval', () => {
		const state = mechanicalAxisState()
		expect(advanceMechanicalAxis(state, 0, 1, IDENTITY_MECHANICAL_AXIS_CONFIG)).toBe(0)
		expect(advanceMechanicalAxis(state, arcsec(10), 0, IDENTITY_MECHANICAL_AXIS_CONFIG)).toBe(0)
		expect(advanceMechanicalAxis(state, arcsec(10), -1, IDENTITY_MECHANICAL_AXIS_CONFIG)).toBe(0)
	})

	describe('backlash', () => {
		const backlash = arcsec(30)
		const backlashConfig = config({ backlash })

		test('does not delay the first motion, since the transmission starts unloaded', () => {
			const state = mechanicalAxisState()
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(10), 1, backlashConfig))).toBeCloseTo(10, 9)
		})

		test('swallows the whole reversal until the slack is taken up', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, backlashConfig)

			// Reversing opens the full gap: the next 30 arcsec of motor travel move nothing.
			expect(advanceMechanicalAxis(state, arcsec(-10), 1, backlashConfig)).toBe(0)
			expect(advanceMechanicalAxis(state, arcsec(-10), 1, backlashConfig)).toBe(0)
			expect(advanceMechanicalAxis(state, arcsec(-10), 1, backlashConfig)).toBe(0)

			// From here the axis follows again.
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(-10), 1, backlashConfig))).toBeCloseTo(-10, 9)
		})

		test('splits the step that finishes taking up the slack', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, backlashConfig)

			// 50 arcsec of reversal: 30 close the gap and 20 reach the axis.
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(-50), 1, backlashConfig))).toBeCloseTo(-20, 9)
		})

		test('does not reopen the gap while the direction holds', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(-50), 1, backlashConfig)

			for (let i = 0; i < 3; i++) {
				expect(toArcsec(advanceMechanicalAxis(state, arcsec(-10), 1, backlashConfig))).toBeCloseTo(-10, 9)
			}
		})

		test('stretches the reversal over more motor travel at a lower take-up rate', () => {
			const slow = config({ backlash, takeUpRate: 0.5 })
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, slow)

			// At half the take-up rate the 30 arcsec gap costs 60 arcsec of motor travel, so 80 arcsec
			// of reversal leaves 20 for the axis.
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(-80), 1, slow))).toBeCloseTo(-20, 9)
		})

		test('treats a non-positive take-up rate as immediate rather than deadlocking', () => {
			const degenerate = config({ backlash, takeUpRate: 0 })
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, degenerate)
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(-50), 1, degenerate))).toBeCloseTo(-20, 9)
		})

		test('keeps the transmission loaded across a stop', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, backlashConfig)
			resetMechanicalAxisMotion(state)

			// Resuming in the same direction is immediate; the slack is still closed on that flank.
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(10), 1, backlashConfig))).toBeCloseTo(10, 9)
		})
	})

	describe('stiction', () => {
		const staticThreshold = arcsec(5)
		const stictionConfig = config({ staticThreshold })

		test('ignores a command too small to break the axis free', () => {
			const state = mechanicalAxisState()
			expect(advanceMechanicalAxis(state, arcsec(1), 1, stictionConfig)).toBe(0)
		})

		test('accumulates small commands until the axis releases at once', () => {
			const state = mechanicalAxisState()

			for (let i = 0; i < 4; i++) {
				expect(advanceMechanicalAxis(state, arcsec(1), 1, stictionConfig)).toBe(0)
			}

			// The fifth arcsecond reaches the threshold, and everything held back arrives together.
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(1), 1, stictionConfig))).toBeCloseTo(5, 9)
		})

		test('follows the motor smoothly once moving', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, stictionConfig)

			// Kinetic friction only: a command below the static threshold now moves the axis.
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(1), 1, stictionConfig))).toBeCloseTo(1, 9)
		})

		test('sticks again after the axis comes to rest', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, stictionConfig)
			advanceMechanicalAxis(state, 0, 1, stictionConfig)
			expect(advanceMechanicalAxis(state, arcsec(1), 1, stictionConfig)).toBe(0)
		})

		test('sticks again after a reversal', () => {
			const state = mechanicalAxisState()
			advanceMechanicalAxis(state, arcsec(10), 1, stictionConfig)
			expect(advanceMechanicalAxis(state, arcsec(-1), 1, stictionConfig)).toBe(0)
		})

		test('discards the accumulated travel on a reversal', () => {
			const state = mechanicalAxisState()

			// Three arcseconds build up towards the threshold but do not reach it.
			expect(advanceMechanicalAxis(state, arcsec(3), 1, stictionConfig)).toBe(0)

			// Reversing moves the load to the other flank, so what had built up on the first one is
			// gone: this step starts a fresh accumulation rather than continuing at six arcseconds.
			expect(advanceMechanicalAxis(state, arcsec(-3), 1, stictionConfig)).toBe(0)
			expect(toArcsec(advanceMechanicalAxis(state, arcsec(-3), 1, stictionConfig))).toBeCloseTo(-6, 9)
		})
	})

	test('applies backlash before stiction on a reversal', () => {
		const both = config({ backlash: arcsec(20), staticThreshold: arcsec(5) })
		const state = mechanicalAxisState()
		advanceMechanicalAxis(state, arcsec(10), 1, both)

		// 22 arcsec of reversal: 20 close the gap, leaving 2 which is below the static threshold.
		expect(advanceMechanicalAxis(state, arcsec(-22), 1, both)).toBe(0)

		// 3 more arcsec reach the threshold and the accumulated 5 arrive together.
		expect(toArcsec(advanceMechanicalAxis(state, arcsec(-3), 1, both))).toBeCloseTo(-5, 9)
	})

	test('keeps the axes independent', () => {
		const both = config({ backlash: arcsec(20), staticThreshold: arcsec(5) })
		const first = mechanicalAxisState()
		const second = mechanicalAxisState()

		advanceMechanicalAxis(first, arcsec(10), 1, both)
		expect(second.loadDirection).toBe(0)
		expect(second.backlashRemaining).toBe(0)
		expect(toArcsec(advanceMechanicalAxis(second, arcsec(-10), 1, both))).toBeCloseTo(-10, 9)
	})
})
