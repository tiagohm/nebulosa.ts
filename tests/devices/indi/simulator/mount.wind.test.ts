import { describe, expect, test } from 'bun:test'
import { advanceWind, IDENTITY_WIND_CONFIG, isWindy, resetWind, type WindConfig, windState } from '../../../../src/devices/indi/simulator/mount.wind'
import { mulberry32, normal } from '../../../../src/math/numerical/random'
import { arcsec, toArcsec } from '../../../../src/math/units/angle'

// Unit coverage for the wind disturbance: that it settles at the configured spread, forgets a gust at
// the configured rate, and stays bounded instead of wandering off like a random walk.

// A breezy site: two arcseconds of buffeting with a five second memory.
const BREEZY: WindConfig = { amplitude: arcsec(2), correlationTime: 5 }

// A standard normal source seeded so every run sees the same sequence.
function normalSource(seed = 1) {
	return normal(mulberry32(seed))
}

// A source that never disturbs anything, which isolates the decay from the noise.
function silent() {
	return 0
}

// Root mean square of the right-ascension deflection over a long run, arcseconds.
function settledSpread(config: WindConfig, step: number, samples = 20000) {
	const state = windState()
	const source = normalSource()
	let sum = 0

	// Discarded so the measurement starts from the settled distribution rather than from zero.
	for (let i = 0; i < 500; i++) advanceWind(state, step, config, source)

	for (let i = 0; i < samples; i++) {
		advanceWind(state, step, config, source)
		sum += state.rightAscension * state.rightAscension
	}

	return toArcsec(Math.sqrt(sum / samples))
}

describe('wind', () => {
	test('leaves a still site undisturbed', () => {
		const state = windState()
		advanceWind(state, 10, IDENTITY_WIND_CONFIG, normalSource())
		expect(isWindy(state)).toBeFalse()
	})

	test('ignores a non-positive interval or correlation time', () => {
		const state = windState()
		advanceWind(state, 0, BREEZY, normalSource())
		advanceWind(state, -1, BREEZY, normalSource())
		advanceWind(state, 1, { ...BREEZY, correlationTime: 0 }, normalSource())
		expect(isWindy(state)).toBeFalse()
	})

	test('settles at the configured spread', () => {
		expect(settledSpread(BREEZY, 0.1)).toBeCloseTo(2, 0)
	})

	test('settles at the same spread whatever the step', () => {
		// The reason for using the exact update instead of stepping the equation: a naive integrator ties
		// the amount of noise injected to the tick rate, so a simulation run at a different step would
		// see a different amount of wind.
		const coarse = settledSpread(BREEZY, 1)
		const fine = settledSpread(BREEZY, 0.05)
		expect(fine / coarse).toBeCloseTo(1, 0.5)
	})

	test('forgets a gust by a factor of e over the correlation time', () => {
		const state = windState()
		state.rightAscension = arcsec(10)
		state.declination = arcsec(-4)

		advanceWind(state, BREEZY.correlationTime, BREEZY, silent)

		expect(toArcsec(state.rightAscension)).toBeCloseTo(10 / Math.E, 9)
		expect(toArcsec(state.declination)).toBeCloseTo(-4 / Math.E, 9)
	})

	test('decays at the same rate whatever the step', () => {
		const coarse = windState()
		const fine = windState()
		coarse.rightAscension = arcsec(10)
		fine.rightAscension = arcsec(10)

		advanceWind(coarse, 4, BREEZY, silent)
		for (let i = 0; i < 80; i++) advanceWind(fine, 0.05, BREEZY, silent)

		expect(coarse.rightAscension).toBeCloseTo(fine.rightAscension, 15)
	})

	test('stays bounded instead of wandering off', () => {
		// The property that separates it from the tracking-rate walk, which has no bound at all. Over a
		// hundred times the correlation time the deflection must still sit within a few sigma.
		const state = windState()
		const source = normalSource()
		let peak = 0

		for (let i = 0; i < 50000; i++) {
			advanceWind(state, 0.1, BREEZY, source)
			peak = Math.max(peak, Math.abs(toArcsec(state.rightAscension)))
		}

		expect(peak).toBeLessThan(5 * 2)
		expect(peak).toBeGreaterThan(2)
	})

	test('drives the two axes independently', () => {
		const state = windState()
		const source = normalSource()
		let sum = 0

		for (let i = 0; i < 4000; i++) {
			advanceWind(state, 0.5, BREEZY, source)
			sum += state.rightAscension * state.declination
		}

		// Uncorrelated axes leave the mean product near zero, well below the variance of either.
		expect(Math.abs(sum / 4000)).toBeLessThan(0.2 * BREEZY.amplitude * BREEZY.amplitude)
	})

	test('seeds from the settled distribution rather than from zero', () => {
		// Averaged over many seeds, a settled draw has the configured spread from the very first step,
		// instead of taking several correlation times to build up to it.
		let sum = 0

		for (let seed = 1; seed <= 2000; seed++) {
			const state = windState()
			resetWind(state, BREEZY, normalSource(seed))
			sum += state.rightAscension * state.rightAscension
		}

		expect(toArcsec(Math.sqrt(sum / 2000))).toBeCloseTo(2, 0)
	})

	test('stills the telescope when reset to a calm site', () => {
		const state = windState()
		resetWind(state, BREEZY, normalSource())
		expect(isWindy(state)).toBeTrue()

		resetWind(state, IDENTITY_WIND_CONFIG, normalSource())
		expect(isWindy(state)).toBeFalse()
	})
})
