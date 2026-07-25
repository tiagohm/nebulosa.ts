import { describe, expect, test } from 'bun:test'
import { type GuidePulse, type GuideResponseConfig, IDENTITY_GUIDE_RESPONSE_CONFIG, integrateGuidePulses, quantizeGuideDuration, retireGuidePulses } from '../../../../src/devices/indi/simulator/mount.guiding'

// Unit coverage for the guide-pulse response: duration admission and the analytic integration that
// makes a pulse independent of the simulation step.

// Builds a response config with only the named imperfections.
function config(overrides: Partial<GuideResponseConfig>): GuideResponseConfig {
	return { ...IDENTITY_GUIDE_RESPONSE_CONFIG, ...overrides }
}

// A pulse of `duration` ms starting at `start`, running at one radian per second for easy arithmetic.
function pulse(start: number, duration: number, rate = 1): GuidePulse {
	return { start, end: start + duration, rate }
}

describe('guide duration admission', () => {
	test('passes a duration through unchanged with an ideal controller', () => {
		expect(quantizeGuideDuration(137, IDENTITY_GUIDE_RESPONSE_CONFIG)).toBe(137)
	})

	test('rejects a non-positive duration', () => {
		expect(quantizeGuideDuration(0, IDENTITY_GUIDE_RESPONSE_CONFIG)).toBe(0)
		expect(quantizeGuideDuration(-50, IDENTITY_GUIDE_RESPONSE_CONFIG)).toBe(0)
	})

	test('rejects a pulse below the minimum', () => {
		const minimum = config({ minimumPulse: 50 })
		expect(quantizeGuideDuration(49, minimum)).toBe(0)
		expect(quantizeGuideDuration(50, minimum)).toBe(50)
	})

	test('rounds to the quantization step', () => {
		const quantized = config({ durationQuantization: 20 })
		expect(quantizeGuideDuration(50, quantized)).toBe(60)
		expect(quantizeGuideDuration(49, quantized)).toBe(40)
		expect(quantizeGuideDuration(100, quantized)).toBe(100)
	})

	test('rejects before rounding, so a short pulse is not rounded up into acceptance', () => {
		const both = config({ minimumPulse: 50, durationQuantization: 100 })
		expect(quantizeGuideDuration(40, both)).toBe(0)
		expect(quantizeGuideDuration(60, both)).toBe(100)
	})

	test('treats rounding down to zero as a rejection', () => {
		expect(quantizeGuideDuration(20, config({ durationQuantization: 100 }))).toBe(0)
	})
})

describe('guide pulse integration', () => {
	test('delivers a pulse shorter than the step in full', () => {
		// The regression this exists for: a 30 ms pulse crossed by a 100 ms step used to be sampled and
		// so produced either a whole step of motion or none at all.
		const pulses = [pulse(1000, 30)]
		expect(integrateGuidePulses(pulses, 1000, 1100)).toBeCloseTo(0.03, 12)
	})

	test('splits a pulse across the steps it spans', () => {
		const pulses = [pulse(1000, 250)]
		const first = integrateGuidePulses(pulses, 1000, 1100)
		const second = integrateGuidePulses(pulses, 1100, 1200)
		const third = integrateGuidePulses(pulses, 1200, 1300)

		expect(first).toBeCloseTo(0.1, 12)
		expect(second).toBeCloseTo(0.1, 12)
		expect(third).toBeCloseTo(0.05, 12)
		expect(first + second + third).toBeCloseTo(0.25, 12)
	})

	test('is independent of how the interval is subdivided', () => {
		const pulses = [pulse(1000, 250)]
		const whole = integrateGuidePulses(pulses, 1000, 1300)

		let stepped = 0
		for (let time = 1000; time < 1300; time += 7) stepped += integrateGuidePulses(pulses, time, Math.min(time + 7, 1300))

		expect(stepped).toBeCloseTo(whole, 12)
	})

	test('ignores a pulse that has not started or is already over', () => {
		const pulses = [pulse(2000, 100)]
		expect(integrateGuidePulses(pulses, 1000, 1500)).toBe(0)
		expect(integrateGuidePulses(pulses, 3000, 3500)).toBe(0)
	})

	test('sums overlapping pulses on the same axis', () => {
		// Two corrections that overlap must add, not replace one another.
		const pulses = [pulse(1000, 200), pulse(1100, 200)]
		expect(integrateGuidePulses(pulses, 1100, 1200)).toBeCloseTo(0.2, 12)
	})

	test('cancels opposing pulses that overlap', () => {
		const pulses = [pulse(1000, 200, 1), pulse(1000, 200, -1)]
		expect(integrateGuidePulses(pulses, 1000, 1200)).toBeCloseTo(0, 12)
	})

	test('scales with the pulse rate', () => {
		expect(integrateGuidePulses([pulse(1000, 100, 3)], 1000, 1100)).toBeCloseTo(0.3, 12)
	})

	test('returns zero for an empty queue or an empty interval', () => {
		expect(integrateGuidePulses([], 1000, 1100)).toBe(0)
		expect(integrateGuidePulses([pulse(1000, 100)], 1050, 1050)).toBe(0)
	})
})

describe('guide pulse retirement', () => {
	test('drops only the pulses that have ended', () => {
		const pulses = [pulse(1000, 100), pulse(1000, 500), pulse(2000, 100)]
		expect(retireGuidePulses(pulses, 1200)).toBeTrue()
		expect(pulses).toHaveLength(2)
		expect(pulses[0].end).toBe(1500)
		expect(pulses[1].start).toBe(2000)
	})

	test('reports an empty queue once everything has ended', () => {
		const pulses = [pulse(1000, 100)]
		expect(retireGuidePulses(pulses, 1100)).toBeFalse()
		expect(pulses).toHaveLength(0)
	})

	test('keeps a pulse that is still running', () => {
		const pulses = [pulse(1000, 100)]
		expect(retireGuidePulses(pulses, 1050)).toBeTrue()
		expect(pulses).toHaveLength(1)
	})
})
