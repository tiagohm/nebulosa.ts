import { describe, expect, test } from 'bun:test'
import { fitTransit, quadraticTransitFlux, scaledSemiMajorAxisFromDuration, type TransitFitOptions, type TransitParameters, transitFlux, transitFullDuration, transitInclination, transitLightCurve, transitSeparation, transitTotalDuration } from '../../../src/astronomy/events/exoplanet.lightcurve'
import { gaussian, mulberry32 } from '../../../src/math/numerical/random'

// A hot Jupiter: 1% deep, 3.2 h long transit every 3.5 days, with Sun-like limb darkening.
const HOT_JUPITER: TransitParameters = { epoch: 2460000.5, period: 3.5, radiusRatio: 0.1, impactParameter: 0.3, scaledSemiMajorAxis: 9, limbDarkening: [0.4, 0.26] }

const FIT_ALL: TransitFitOptions['free'] = ['epoch', 'radiusRatio', 'impactParameter', 'scaledSemiMajorAxis', 'limbDarkening', 'baseline']

// Evenly spaced times from `from` to `to` days with the step `step` days.
function grid(from: number, to: number, step: number) {
	return Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step)
}

// Model fluxes times `baseline` plus Gaussian noise of `sigma` (one value or one per sample).
function observe(time: readonly number[], parameters: TransitParameters, sigma: number | readonly number[], seed: number, baseline: number = 1, exposureTime: number = 0) {
	const noise = gaussian(mulberry32(seed), 1)
	return Array.from(transitLightCurve(time, parameters, { exposureTime }), (f, i) => baseline * f + (typeof sigma === 'number' ? sigma : sigma[i]) * noise())
}

describe('quadratic transit flux', () => {
	// Reference values from exoplanet-core 0.4.0 (Agol, Luger & Foreman-Mackey 2020), quad_limbdark_light_curve + 1:
	// [separation, radius ratio, u1, u2, flux].
	// oxfmt-ignore
	const REFERENCE = [
		[0, 0.1, 0.4, 0.26, 0.9878664434953114], // concentric
		[0.3, 0.1, 0.4, 0.26, 0.9880997416109193],
		[0.9, 0.1, 0.4, 0.26, 0.991830523026063], // internal tangency z = 1 - p
		[0.95, 0.1, 0.4, 0.26, 0.9940333433610121],
		[1.05, 0.1, 0.4, 0.26, 0.998848784866871],
		[0.1, 0.1, 0.4, 0.26, 0.9878911600693892], // planet limb on the stellar center z = p < 1/2
		[0.9, 0.1, 1, 0, 0.993792604279552], // linear limb darkening
		[0.5, 0.5, 0.4, 0.26, 0.7317146263368896], // z = p = 1/2 = 1 - p
		[0.3, 0.3, 0, 1, 0.8928325042941593],
		[0.7, 0.7, 2, -1, 0.6263893068528968], // z = p > 1/2
		[0.3, 0.7, 0.4, 0.26, 0.46527475636775983], // the planet covers the center and the limb
		[1.2, 0.7, 0.4, 0.26, 0.8818842422122445],
		[0.5, 1.3, 0.4, 0.26, 0.06706924768499689], // a planet larger than the star
		[1, 1.3, 0.1, 0.9, 0.37489199415091146],
		[0.7, 0.3, 0.4, 0.26, 0.9097921252493827], // internal tangency z = 1 - p
		[1, 0.01, 0.4, 0.26, 0.9999747266937089],
		[0.2, 0.0092, 0.3, 0.3, 0.9999010399912648], // Earth-Sun radius ratio
		[0.999, 0.0092, 0.3, 0.3, 0.999973065131124],
	] as const

	test('matches an independent analytic implementation', () => {
		for (const [z, p, u1, u2, flux] of REFERENCE) {
			expect(quadraticTransitFlux(z, p, [u1, u2])).toBeCloseTo(flux, 13)
		}
	})

	test('limits', () => {
		// Uniform disk: the occulted fraction is the area ratio.
		expect(quadraticTransitFlux(0.4, 0.1, [0, 0])).toBeCloseTo(0.99, 15)
		// No overlap, no planet and a star wholly covered.
		expect(quadraticTransitFlux(1.1, 0.1, [0.4, 0.26])).toBe(1)
		expect(quadraticTransitFlux(1.5, 0.1, [0.4, 0.26])).toBe(1)
		expect(quadraticTransitFlux(0, 0, [0.4, 0.26])).toBe(1)
		expect(quadraticTransitFlux(0.2, 1.5, [0.4, 0.26])).toBe(0)
		// The centered transit of a darkened star is deeper than p², because the center is brighter.
		expect(1 - quadraticTransitFlux(0, 0.1, [0.4, 0.26])).toBeGreaterThan(0.01)
	})

	test('is continuous across the special cases', () => {
		for (const p of [0.05, 0.3, 0.5, 0.7, 1.2]) {
			for (const z of [p, 1 - p, 1 + p, Math.abs(p - 1)]) {
				if (z < 0) continue
				const center = quadraticTransitFlux(z, p, [0.4, 0.26])

				for (const d of [1e-13, 1e-11, 1e-9]) {
					expect(Math.abs(quadraticTransitFlux(z + d, p, [0.4, 0.26]) - center)).toBeLessThan(1e-10 + d)
					if (z - d >= 0) expect(Math.abs(quadraticTransitFlux(z - d, p, [0.4, 0.26]) - center)).toBeLessThan(1e-10 + d)
				}
			}
		}
	})

	test('dims monotonically toward the center for a physical limb darkening', () => {
		let previous = 0

		for (let z = 1.1; z >= 0; z -= 0.01) {
			const flux = quadraticTransitFlux(z, 0.1, [0.4, 0.26])
			expect(flux).toBeLessThanOrEqual(previous === 0 ? 1 : previous + 1e-15)
			previous = flux
		}
	})
})

describe('transit geometry', () => {
	test('durations and inclination', () => {
		// Seager & Mallén-Ornelas (2003): sin(π T14 / P) = sqrt((1 + p)² - b²) / (a sin i).
		const inclination = transitInclination(HOT_JUPITER)
		expect(inclination).toBeCloseTo(Math.acos(0.3 / 9), 15)
		const t14 = transitTotalDuration(HOT_JUPITER)
		const t23 = transitFullDuration(HOT_JUPITER)
		expect(Math.sin((Math.PI * t14) / 3.5)).toBeCloseTo(Math.sqrt(1.1 * 1.1 - 0.09) / (9 * Math.sin(inclination)), 15)
		expect(Math.sin((Math.PI * t23) / 3.5)).toBeCloseTo(Math.sqrt(0.9 * 0.9 - 0.09) / (9 * Math.sin(inclination)), 15)
		expect(t14).toBeCloseTo(0.13138, 5)
		expect(t23).toBeCloseTo(0.10525, 5)

		// The separation is 1 + p at the first and fourth contacts and 1 - p at the second and third ones.
		expect(transitSeparation(HOT_JUPITER.epoch - t14 / 2, HOT_JUPITER)!).toBeCloseTo(1.1, 8)
		expect(transitSeparation(HOT_JUPITER.epoch + t23 / 2 + 7 * 3.5, HOT_JUPITER)!).toBeCloseTo(0.9, 8)
		expect(transitSeparation(HOT_JUPITER.epoch, HOT_JUPITER)!).toBeCloseTo(0.3, 14)
		// Behind the star, half a period later.
		expect(transitSeparation(HOT_JUPITER.epoch + 1.75, HOT_JUPITER)).toBeUndefined()

		expect(scaledSemiMajorAxisFromDuration(3.5, t14, 0.1, 0.3)).toBeCloseTo(9, 12)
	})

	test('grazing, non-transiting and pole-on orbits', () => {
		const grazing = { ...HOT_JUPITER, impactParameter: 1.05 }
		expect(transitTotalDuration(grazing)).toBeGreaterThan(0)
		expect(transitFullDuration(grazing)).toBe(0)
		expect(transitTotalDuration({ ...HOT_JUPITER, impactParameter: 1.1 })).toBe(0)
		expect(transitTotalDuration({ ...HOT_JUPITER, radiusRatio: 0 })).toBe(0)
		expect(transitFullDuration({ ...HOT_JUPITER, radiusRatio: 1.2 })).toBe(0)
		// A planet whose orbit stays within 1 + p of the stellar center overlaps the star during the whole front half.
		expect(transitTotalDuration({ ...HOT_JUPITER, scaledSemiMajorAxis: 1.05, impactParameter: 0 })).toBe(1.75)
		// b > a/R* is a pole-on orbit.
		expect(transitInclination({ impactParameter: 12, scaledSemiMajorAxis: 9 })).toBe(0)
		expect(transitSeparation(HOT_JUPITER.epoch, { ...HOT_JUPITER, impactParameter: 12 })).toBeCloseTo(9, 14)
	})
})

describe('transit light curve', () => {
	// batman-package 2.5.3 (Kreidberg 2015), e = 0, ω = 90°, averaged over the midpoint sub-exposure times
	// ((j + 0.5) / N - 0.5) * exposure; times are days from the mid-transit of cycle 2. batman's elliptic
	// integrals are polynomial approximations good to about 1e-8.
	const OFFSETS = [-0.07, -0.06, -0.05, -0.03, 0, 0.02, 0.055, 0.065, 0.1]
	// oxfmt-ignore
	const BATMAN = [
		['moderate', 0.5, 0, 1, [1, 0.9998762983319024, 0.9939336693998977, 0.9895152039545104, 0.9885838213705181, 0.9889583439370112, 0.9974733402252737, 1, 1]],
		['grazing', 1.05, 0, 1, [1, 1, 1, 1, 0.9988487793535675, 0.9999922729213624, 1, 1, 1]],
		['kepler long cadence', 0.3, 0.0204, 30, [0.9996726711603258, 0.9964888806266509, 0.9919820136992384, 0.9889033364488132, 0.9881246776480861, 0.9884399958528809, 0.9941874412628658, 0.9984818861652021, 1]],
	] as const

	test('matches batman', () => {
		for (const [, impactParameter, exposureTime, supersample, expected] of BATMAN) {
			const parameters = { ...HOT_JUPITER, impactParameter }
			const time = OFFSETS.map((dt) => HOT_JUPITER.epoch + 2 * HOT_JUPITER.period + dt)
			const flux = transitLightCurve(time, parameters, { exposureTime, supersample })

			for (let i = 0; i < time.length; i++) {
				expect(Math.abs(flux[i] - expected[i])).toBeLessThan(2e-8)
				expect(transitFlux(time[i], parameters, { exposureTime, supersample })).toBe(flux[i])
			}
		}
	})

	test('averages long exposures', () => {
		const time = grid(HOT_JUPITER.epoch - 0.1, HOT_JUPITER.epoch + 0.1, 0.001)
		const exposureTime = 0.0204
		const exact = transitLightCurve(time, HOT_JUPITER, { exposureTime, supersample: 1000 })
		const instant = transitLightCurve(time, HOT_JUPITER)
		// The default 1-minute sub-exposures (30 here).
		const averaged = transitLightCurve(time, HOT_JUPITER, { exposureTime })
		let instantError = 0
		let averagedError = 0

		for (let i = 0; i < time.length; i++) {
			instantError = Math.max(instantError, Math.abs(instant[i] - exact[i]))
			averagedError = Math.max(averagedError, Math.abs(averaged[i] - exact[i]))
		}

		expect(instantError).toBeGreaterThan(1e-3)
		expect(averagedError).toBeLessThan(2e-6)
		expect(transitLightCurve(time, HOT_JUPITER, { exposureTime: 0.0204, supersample: 30 })).toEqual(averaged)
		expect(transitLightCurve(time, HOT_JUPITER, { exposureTime: 0.0204, supersample: 1 })).toEqual(instant)
	})

	test('writes into the output', () => {
		const out = new Float64Array(3)
		expect(transitLightCurve([HOT_JUPITER.epoch, HOT_JUPITER.epoch + 1, HOT_JUPITER.epoch - 3.5], HOT_JUPITER, undefined, out)).toBe(out)
		expect(out[0]).toBeCloseTo(quadraticTransitFlux(0.3, 0.1, [0.4, 0.26]), 14)
		expect(out[1]).toBe(1)
		expect(out[2]).toBeCloseTo(out[0], 12)
	})

	test('rejects exposures that would run without bound', () => {
		// An exposure of 1800 s passed as days.
		expect(() => transitFlux(HOT_JUPITER.epoch, HOT_JUPITER, { exposureTime: 1800 })).toThrow(RangeError)
		expect(() => transitFlux(HOT_JUPITER.epoch, HOT_JUPITER, { exposureTime: -1 })).toThrow(RangeError)
		expect(() => transitFlux(HOT_JUPITER.epoch, HOT_JUPITER, { exposureTime: 0.01, supersample: 2.5 })).toThrow()
	})
})

describe('transit fit', () => {
	const time = grid(HOT_JUPITER.epoch - 0.2, HOT_JUPITER.epoch + 0.2, 1 / 720)

	test('recovers noiseless parameters from an offset start', () => {
		const flux = observe(time, HOT_JUPITER, 0, 1, 1.03)
		const result = fitTransit(time, flux, 1e-4, { ...HOT_JUPITER, epoch: HOT_JUPITER.epoch + 0.01, radiusRatio: 0.08, impactParameter: 0, scaledSemiMajorAxis: 12, limbDarkening: [0.3, 0.2] }, { free: FIT_ALL })

		expect(result.status).toBe('ok')
		expect(result.parameters.epoch).toBeCloseTo(HOT_JUPITER.epoch, 8)
		expect(result.parameters.radiusRatio).toBeCloseTo(0.1, 6)
		expect(result.parameters.impactParameter).toBeCloseTo(0.3, 4)
		expect(result.parameters.scaledSemiMajorAxis).toBeCloseTo(9, 4)
		expect(result.parameters.limbDarkening[0]).toBeCloseTo(0.4, 4)
		expect(result.parameters.limbDarkening[1]).toBeCloseTo(0.26, 4)
		expect(result.parameters.period).toBe(3.5)
		expect(result.baseline).toBeCloseTo(1.03, 8)
		expect(result.chiSquare).toBeLessThan(1e-6)
		expect(result.parameterNames).toEqual(['epoch', 'radiusRatio', 'impactParameter', 'scaledSemiMajorAxis', 'u1', 'u2', 'baseline'])
		expect(result.covariance!.length).toBe(49)
		expect(result.inclination).toBeCloseTo(Math.acos(0.3 / 9), 4)
		expect(result.totalDuration).toBeCloseTo(transitTotalDuration(HOT_JUPITER), 6)
		expect(result.sampleCount).toBe(time.length)
		expect(result.degreesOfFreedom).toBe(time.length - 7)
	})

	test('recovers noisy heteroscedastic photometry within its uncertainties', () => {
		const sigma = time.map((_, i) => 1e-4 + 1e-4 * (i % 5) * 0.25)
		const pulls = { epoch: [] as number[], radiusRatio: [] as number[], baseline: [] as number[] }

		for (let seed = 1; seed <= 12; seed++) {
			const result = fitTransit(time, observe(time, HOT_JUPITER, sigma, seed), sigma, { ...HOT_JUPITER, epoch: HOT_JUPITER.epoch + 0.003, radiusRatio: 0.09, impactParameter: 0.5, scaledSemiMajorAxis: 8 })
			expect(result.status).toBe('ok')
			expect(result.reducedChiSquare!).toBeGreaterThan(0.75)
			expect(result.reducedChiSquare!).toBeLessThan(1.25)

			const uncertainties = result.uncertainties!
			pulls.epoch.push((result.parameters.epoch - HOT_JUPITER.epoch) / uncertainties.epoch!)
			pulls.radiusRatio.push((result.parameters.radiusRatio - 0.1) / uncertainties.radiusRatio!)
			pulls.baseline.push((result.baseline - 1) / uncertainties.baseline!)

			// At this signal-to-noise the impact parameter is loosely constrained, and some fits rest on b = 0, where the
			// other uncertainties are conditional on b = 0.
			if (result.atBound.includes('impactParameter')) {
				expect(result.parameters.impactParameter).toBe(0)
				expect(uncertainties.impactParameter).toBeUndefined()
				expect(result.parameterNames).not.toContain('impactParameter')
			} else {
				expect(Math.abs(result.parameters.impactParameter - 0.3)).toBeLessThan(4 * uncertainties.impactParameter!)
				expect(Math.abs(result.parameters.scaledSemiMajorAxis - 9)).toBeLessThan(4 * uncertainties.scaledSemiMajorAxis!)
			}
		}

		for (const pull of Object.values(pulls)) for (const value of pull) expect(Math.abs(value)).toBeLessThan(4)

		// The flux-like parameters are nearly linear, so their Fisher errors match the scatter of the fits.
		for (const pull of Object.values(pulls)) {
			const rms = Math.sqrt(pull.reduce((sum, p) => sum + p * p, 0) / pull.length)
			expect(rms).toBeGreaterThan(0.5)
			expect(rms).toBeLessThan(1.6)
		}
	})

	test('ignores samples with a huge error and skips unusable samples', () => {
		const flux = observe(time, HOT_JUPITER, 0, 1)
		const sigma = time.map(() => 1e-4)

		// A corrupted block in transit with enormous errors.
		for (let i = 140; i < 150; i++) {
			flux[i] = 0.5
			sigma[i] = 1e6
		}

		flux[3] = Number.NaN
		sigma[4] = 0
		sigma[5] = Number.POSITIVE_INFINITY

		const result = fitTransit(time, flux, sigma, HOT_JUPITER)
		expect(result.status).toBe('ok')
		expect(result.rejectedSampleCount).toBe(3)
		expect(result.sampleCount).toBe(time.length - 3)
		expect(result.parameters.radiusRatio).toBeCloseTo(0.1, 6)
		expect(result.parameters.epoch).toBeCloseTo(HOT_JUPITER.epoch, 8)
	})

	test('fits the period across several transits', () => {
		const multi = [...time, ...time.map((t) => t + 3 * 3.5), ...time.map((t) => t + 8 * 3.5)]
		const truth = { ...HOT_JUPITER, period: 3.50012 }
		const result = fitTransit(multi, observe(multi, truth, 0, 1), 1e-4, { ...truth, period: 3.5, epoch: HOT_JUPITER.epoch + 0.002 }, { free: ['epoch', 'period', 'radiusRatio', 'impactParameter', 'scaledSemiMajorAxis', 'baseline'] })

		expect(result.status).toBe('ok')
		expect(result.parameters.period).toBeCloseTo(3.50012, 8)
		expect(result.parameters.epoch).toBeCloseTo(HOT_JUPITER.epoch, 8)
		expect(result.uncertainties!.period!).toBeGreaterThan(0)
		expect(result.inTransitCount).toBeGreaterThanOrEqual(3 * 94)
		expect(result.inTransitCount).toBeLessThanOrEqual(3 * 96)
	})

	test('handles long exposures', () => {
		const sparse = grid(HOT_JUPITER.epoch - 0.3, HOT_JUPITER.epoch + 0.3, 0.0204)
		const exposureTime = 0.0204
		const flux = observe(sparse, HOT_JUPITER, 0, 1, 1, exposureTime)

		const averaged = fitTransit(sparse, flux, 1e-4, { ...HOT_JUPITER, impactParameter: 0.5 }, { exposureTime })
		expect(averaged.status).toBe('ok')
		expect(averaged.parameters.radiusRatio).toBeCloseTo(0.1, 5)
		expect(averaged.parameters.scaledSemiMajorAxis).toBeCloseTo(9, 2)

		// Fitting the same data as instantaneous samples smears the ingress into a shorter, more grazing chord.
		const instant = fitTransit(sparse, flux, 1e-4, { ...HOT_JUPITER, impactParameter: 0.5 })
		expect(instant.chiSquare).toBeGreaterThan(100 * averaged.chiSquare + 10)
		expect(instant.flags).toContain('poorFit')
	})

	test('flags a central transit at the impact parameter bound', () => {
		const central = { ...HOT_JUPITER, impactParameter: 0 }
		const result = fitTransit(time, observe(time, central, 5e-4, 7), 5e-4, central)

		expect(result.status).toBe('ok')
		expect(result.atBound).toEqual(['impactParameter'])
		expect(result.flags).toContain('parameterAtBound')
		expect(result.parameters.impactParameter).toBeLessThan(0.05)
	})

	test('flags a grazing transit and its degeneracy', () => {
		const grazing = { ...HOT_JUPITER, impactParameter: 1.02 }
		const result = fitTransit(time, observe(time, grazing, 2e-4, 1), 2e-4, { ...grazing, impactParameter: 0.9, radiusRatio: 0.12 })

		expect(result.status).toBe('ok')
		expect(result.flags).toContain('grazing')
		expect(result.flags).toContain('strongDegeneracy')
		expect(result.fullDuration).toBe(0)
		expect(result.fullDurationError).toBeUndefined()
		expect(result.totalDurationError!).toBeGreaterThan(0)
	})

	test('flags a missing ingress', () => {
		const egressOnly = grid(HOT_JUPITER.epoch, HOT_JUPITER.epoch + 0.2, 1 / 720)
		const result = fitTransit(egressOnly, observe(egressOnly, HOT_JUPITER, 5e-4, 2), 5e-4, HOT_JUPITER)

		expect(result.status).toBe('ok')
		expect(result.flags).toContain('missingIngress')
		expect(result.flags).not.toContain('missingEgress')
		// The epoch rests on one side of the transit, so it is much less certain.
		const full = fitTransit(time, observe(time, HOT_JUPITER, 5e-4, 2), 5e-4, HOT_JUPITER)
		expect(result.uncertainties!.epoch!).toBeGreaterThan(5 * full.uncertainties!.epoch!)
	})

	test('flags the period degeneracy of a single transit', () => {
		const result = fitTransit(time, observe(time, HOT_JUPITER, 5e-4, 3), 5e-4, HOT_JUPITER, { free: ['epoch', 'period', 'radiusRatio', 'impactParameter', 'scaledSemiMajorAxis', 'baseline'] })
		expect(result.flags.some((flag) => flag === 'strongDegeneracy' || flag === 'singularCovariance')).toBeTrue()
	})

	test('finds no transit in a flat light curve', () => {
		const result = fitTransit(time, observe(time, { ...HOT_JUPITER, radiusRatio: 0 }, 5e-4, 4), 5e-4, HOT_JUPITER)
		expect(result.flags).toContain('noTransit')
		expect(result.flags).toContain('singularCovariance')
		expect(result.covariance).toBeUndefined()
		expect(result.uncertainties).toBeUndefined()
		expect(result.inTransitCount).toBe(0)
		expect(result.totalDuration).toBe(0)
	})

	test('flags underestimated errors', () => {
		const result = fitTransit(time, observe(time, HOT_JUPITER, 1e-3, 5), 3e-4, HOT_JUPITER)
		expect(result.flags).toContain('poorFit')
		expect(result.reducedChiSquare!).toBeGreaterThan(5)
	})

	test('respects explicit bounds', () => {
		const result = fitTransit(time, observe(time, HOT_JUPITER, 0, 1), 1e-4, HOT_JUPITER, { bounds: { radiusRatio: [0.02, 0.09] } })
		expect(result.parameters.radiusRatio).toBeCloseTo(0.09, 5)
		expect(result.atBound).toContain('radiusRatio')
		expect(result.flags).toContain('parameterAtBound')
	})

	test('reports insufficient data without fitting', () => {
		// Out-of-transit samples only.
		const before = grid(HOT_JUPITER.epoch - 0.4, HOT_JUPITER.epoch - 0.1, 1 / 720)
		const outside = fitTransit(before, observe(before, HOT_JUPITER, 5e-4, 6), 5e-4, HOT_JUPITER)
		expect(outside.status).toBe('insufficientData')
		expect(outside.parameters).toEqual(HOT_JUPITER)
		expect(outside.covariance).toBeUndefined()
		expect(outside.predictedImprovement).toBeUndefined()
		expect(outside.inTransitCount).toBe(0)
		expect(outside.baseline).toBeCloseTo(1, 3)

		// As many samples as free parameters.
		const few = [HOT_JUPITER.epoch - 0.01, HOT_JUPITER.epoch, HOT_JUPITER.epoch + 0.01, HOT_JUPITER.epoch + 0.02, HOT_JUPITER.epoch + 0.3]
		expect(fitTransit(few, observe(few, HOT_JUPITER, 0, 1), 1e-4, HOT_JUPITER).status).toBe('insufficientData')

		// No positive out-of-transit level.
		expect(
			fitTransit(
				time,
				time.map(() => 0),
				1e-4,
				HOT_JUPITER,
			).status,
		).toBe('insufficientData')

		// No usable sample at all.
		const empty = fitTransit([], [], 1e-4, HOT_JUPITER)
		expect(empty.status).toBe('insufficientData')
		expect(empty.chiSquare).toBe(0)
		expect(empty.reducedChiSquare).toBeUndefined()
	})

	test('rejects structurally invalid input', () => {
		expect(() => fitTransit([1, 2], [1], 1e-3, HOT_JUPITER)).toThrow(RangeError)
		expect(() => fitTransit([1, 2], [1, 1], [1e-3], HOT_JUPITER)).toThrow(RangeError)
		expect(() => fitTransit(time, time, 1e-3, { ...HOT_JUPITER, impactParameter: 1.2 })).toThrow(RangeError)
		expect(() => fitTransit(time, time, 1e-3, { ...HOT_JUPITER, radiusRatio: 0 })).toThrow(RangeError)
		expect(() => fitTransit(time, time, 1e-3, HOT_JUPITER, { bounds: { radiusRatio: [0.2, 0.1] } })).toThrow(RangeError)
	})
})
