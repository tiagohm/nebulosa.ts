import { describe, expect, test } from 'bun:test'
import { advanceSettling, exciteSettling, IDENTITY_SETTLING_CONFIG, isSettling, resetSettling, type SettlingConfig, settlingState } from '../../../../src/devices/indi/simulator/mount.settling'
import { arcsec, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage for the elastic settling of an axis: excitation, ring-down, and the invariant that a
// whole episode leaves the axis exactly where it was commanded.

// A springy mount: two hertz, lightly damped, overshooting five arcseconds at full speed.
const SPRINGY: SettlingConfig = { frequency: 2, dampingRatio: 0.15, overshoot: arcsec(5) }

// Runs the ring-down to completion and returns the peak excursion and the accumulated displacement.
function ringDown(config: SettlingConfig, severity = 1, step = 0.005, duration = 20) {
	const state = settlingState()
	exciteSettling(state, severity, config)

	let peak = 0
	let travelled = 0

	for (let time = 0; time < duration; time += step) {
		travelled += advanceSettling(state, step, config)
		peak = Math.max(peak, Math.abs(state.offset))
	}

	return { peak, travelled, state }
}

describe('axis settling', () => {
	test('is inert with a perfectly stiff axis', () => {
		const state = settlingState()
		exciteSettling(state, 1, IDENTITY_SETTLING_CONFIG)
		expect(isSettling(state)).toBeFalse()
		expect(advanceSettling(state, 1, IDENTITY_SETTLING_CONFIG)).toBe(0)
	})

	test('ignores a non-positive interval or severity', () => {
		const state = settlingState()
		exciteSettling(state, 0, SPRINGY)
		expect(isSettling(state)).toBeFalse()

		exciteSettling(state, 1, SPRINGY)
		expect(advanceSettling(state, 0, SPRINGY)).toBe(0)
		expect(advanceSettling(state, -1, SPRINGY)).toBe(0)
	})

	test('overshoots by about the configured peak', () => {
		const { peak } = ringDown(SPRINGY)

		// The relation between the initial velocity and the peak is exact only without damping, so a
		// lightly damped axis falls a little short of the requested excursion.
		expect(toArcsec(peak)).toBeGreaterThan(3.5)
		expect(toArcsec(peak)).toBeLessThan(5)
	})

	test('scales the overshoot with the severity of the stop', () => {
		const full = ringDown(SPRINGY, 1)
		const half = ringDown(SPRINGY, 0.5)
		expect(half.peak / full.peak).toBeCloseTo(0.5, 6)
	})

	test('clamps the severity at one', () => {
		expect(ringDown(SPRINGY, 4).peak).toBeCloseTo(ringDown(SPRINGY, 1).peak, 12)
	})

	test('returns the axis exactly to where it was commanded', () => {
		// The invariant that makes settling safe to add to the mechanical position: the excursion is
		// borrowed and paid back, so a slew still lands on target once the ringing dies away.
		const { travelled, state } = ringDown(SPRINGY)

		expect(toArcsec(Math.abs(state.offset))).toBeLessThan(1e-6)
		expect(toArcsec(Math.abs(travelled))).toBeLessThan(1e-6)
	})

	test('oscillates when underdamped and does not when stiff', () => {
		const springy = settlingState()
		exciteSettling(springy, 1, SPRINGY)

		let crossings = 0
		let previous = springy.offset

		for (let time = 0; time < 4; time += 0.005) {
			advanceSettling(springy, 0.005, SPRINGY)
			if (previous > 0 !== springy.offset > 0) crossings++
			previous = springy.offset
		}

		expect(crossings).toBeGreaterThan(4)

		// A heavily damped axis creeps back without ever crossing the target.
		const stiff = settlingState()
		const stiffConfig: SettlingConfig = { ...SPRINGY, dampingRatio: 1 }
		exciteSettling(stiff, 1, stiffConfig)

		let stiffCrossings = 0
		previous = stiff.offset

		for (let time = 0; time < 4; time += 0.005) {
			advanceSettling(stiff, 0.005, stiffConfig)
			if (previous > 0 !== stiff.offset > 0) stiffCrossings++
			previous = stiff.offset
		}

		// Not exactly zero: the damping ratio is clamped just below one, which leaves a sliver of
		// oscillation whose period is far longer than the ring-down itself, so it can cross once.
		expect(stiffCrossings).toBeLessThanOrEqual(1)
		expect(stiffCrossings).toBeLessThan(crossings)
	})

	test('settles faster the heavier the damping', () => {
		function remaining(dampingRatio: number) {
			const state = settlingState()
			const config: SettlingConfig = { ...SPRINGY, dampingRatio }
			exciteSettling(state, 1, config)
			for (let time = 0; time < 1; time += 0.005) advanceSettling(state, 0.005, config)
			return Math.abs(state.offset) + Math.abs(state.velocity)
		}

		expect(remaining(0.5)).toBeLessThan(remaining(0.05))
	})

	test('is independent of the step size, being a closed-form solution', () => {
		// The reason for not stepping the differential equation: at the simulation tick a structural
		// resonance is badly under-sampled, and an explicit integrator would drift or blow up.
		const fine = settlingState()
		const coarse = settlingState()
		exciteSettling(fine, 1, SPRINGY)
		exciteSettling(coarse, 1, SPRINGY)

		for (let i = 0; i < 200; i++) advanceSettling(fine, 0.005, SPRINGY)
		advanceSettling(coarse, 1, SPRINGY)

		expect(coarse.offset).toBeCloseTo(fine.offset, 12)
		expect(coarse.velocity).toBeCloseTo(fine.velocity, 9)
	})

	test('drops the ring-down when reset', () => {
		const state = settlingState()
		exciteSettling(state, 1, SPRINGY)
		advanceSettling(state, 0.05, SPRINGY)
		expect(isSettling(state)).toBeTrue()

		resetSettling(state)
		expect(isSettling(state)).toBeFalse()
	})
})
