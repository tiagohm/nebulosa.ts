import { describe, expect, test } from 'bun:test'
import { advanceTrackingRateError, IDENTITY_TRACKING_RATE_ERROR_CONFIG, resetTrackingRateError, TRACKING_RATE_CALIBRATION_TEMPERATURE, type TrackingRateErrorConfig, trackingRateErrorState } from '../../../../src/devices/indi/simulator/mount.tracking'
import { mulberry32, normal } from '../../../../src/math/numerical/random'

// Unit coverage for the rate error of a tracking drive: its deterministic terms and the step-size
// invariance of its random walk.

// A drive running 50 ppm fast, losing 2 ppm per degree above its calibration temperature.
const DRIFTING: TrackingRateErrorConfig = { bias: 50, temperatureCoefficient: -2, temperature: TRACKING_RATE_CALIBRATION_TEMPERATURE, randomWalk: 0 }

// A standard normal source seeded so every run sees the same sequence.
function normalSource(seed = 1) {
	return normal(mulberry32(seed))
}

describe('tracking rate error', () => {
	test('is exactly zero for a perfect drive', () => {
		const state = trackingRateErrorState()
		expect(advanceTrackingRateError(state, 10, IDENTITY_TRACKING_RATE_ERROR_CONFIG, normalSource())).toBe(0)
		expect(state.walk).toBe(0)
	})

	test('reports the bias alone at the calibration temperature', () => {
		expect(advanceTrackingRateError(trackingRateErrorState(), 1, DRIFTING, normalSource())).toBe(50)
	})

	test('applies the temperature coefficient to the departure from calibration', () => {
		const cold: TrackingRateErrorConfig = { ...DRIFTING, temperature: TRACKING_RATE_CALIBRATION_TEMPERATURE - 10 }
		const warm: TrackingRateErrorConfig = { ...DRIFTING, temperature: TRACKING_RATE_CALIBRATION_TEMPERATURE + 10 }

		expect(advanceTrackingRateError(trackingRateErrorState(), 1, cold, normalSource())).toBeCloseTo(70, 12)
		expect(advanceTrackingRateError(trackingRateErrorState(), 1, warm, normalSource())).toBeCloseTo(30, 12)
	})

	test('does not wander without a random walk', () => {
		const state = trackingRateErrorState()
		for (let i = 0; i < 100; i++) advanceTrackingRateError(state, 1, DRIFTING, normalSource())
		expect(state.walk).toBe(0)
	})

	test('scales the wander with the square root of the elapsed time', () => {
		// The property that makes the walk independent of the tick rate: the variance accumulated over an
		// interval must depend on its length, not on how many steps it was cut into. Compared across many
		// realizations, since a single one says nothing about a random process.
		const config: TrackingRateErrorConfig = { ...DRIFTING, randomWalk: 4 }

		function spread(step: number, steps: number) {
			let sum = 0

			for (let run = 0; run < 400; run++) {
				const state = trackingRateErrorState()
				const source = normalSource(run + 1)
				for (let i = 0; i < steps; i++) advanceTrackingRateError(state, step, config, source)
				sum += state.walk * state.walk
			}

			return Math.sqrt(sum / 400)
		}

		const coarse = spread(1, 16)
		const fine = spread(0.25, 64)

		// Both cover sixteen seconds, so both should sit near randomWalk * sqrt(16) = 16 ppm.
		expect(coarse).toBeCloseTo(16, -0.5)
		expect(fine / coarse).toBeCloseTo(1, 0.5)
	})

	test('rails the wander instead of running away', () => {
		const state = trackingRateErrorState()
		const config: TrackingRateErrorConfig = { ...DRIFTING, randomWalk: 1000 }
		const source = normalSource()

		for (let i = 0; i < 20000; i++) advanceTrackingRateError(state, 1, config, source)

		expect(Math.abs(state.walk)).toBeLessThanOrEqual(10000)
	})

	test('forgets the wander when reset', () => {
		const state = trackingRateErrorState()
		advanceTrackingRateError(state, 100, { ...DRIFTING, randomWalk: 10 }, normalSource())
		expect(state.walk).not.toBe(0)

		resetTrackingRateError(state)
		expect(state.walk).toBe(0)
	})
})
