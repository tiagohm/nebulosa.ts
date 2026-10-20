import { describe, expect, test } from 'bun:test'
import { boxLeastSquares } from '../../../src/math/numerical/bls'
import { gaussian, mulberry32 } from '../../../src/math/numerical/random'

interface LightCurve {
	readonly t: number[]
	readonly f: number[]
}

interface Transit {
	readonly period: number
	readonly epoch: number
	readonly duration: number
	readonly depth: number
}

// Box transits sampled every cadence days during nightly windows of nightLength days starting nightStart
// days after start, with Gaussian noise of sigma.
function lightCurve(nights: number, start: number, nightStart: number, nightLength: number, cadence: number, sigma: number, seed: number, transits: readonly Transit[]): LightCurve {
	const noise = gaussian(mulberry32(seed), sigma)
	const t: number[] = []
	const f: number[] = []
	const perNight = Math.round(nightLength / cadence)

	for (let night = 0; night < nights; night++) {
		for (let j = 0; j < perNight; j++) {
			const ti = start + night + nightStart + j * cadence
			let fi = 1 + (sigma > 0 ? noise() : 0)

			for (const { period, epoch, duration, depth } of transits) {
				const phase = ti - epoch - Math.round((ti - epoch) / period) * period
				if (Math.abs(phase) < 0.5 * duration) fi -= depth
			}

			t.push(ti)
			f.push(fi)
		}
	}

	return { t, f }
}

// Reference values from Astropy 8.0.2 (NumPy 2.5.3) BoxLeastSquares(t, f, e).power(periods, [0.08, 0.1,
// 0.12, 0.14], objective='snr', oversample=10) and compute_stats at the best period, on this light curve.
function astropyLightCurve() {
	const noise = gaussian(mulberry32(237), 0.001)
	const t: number[] = []
	const f: number[] = []
	const e: number[] = []

	for (let night = 0; night < 12; night++) {
		for (let j = 0; j < 34; j++) {
			const ti = 2460000.1 + night + j * 0.01
			const phase = ((((ti - 2460000.35) % 1.7) + 1.7 + 0.85) % 1.7) - 0.85
			t.push(ti)
			f.push(1 + noise() - (Math.abs(phase) < 0.06 ? 0.004 : 0))
			e.push(0.001 * (1 + 0.2 * Math.sin(j)))
		}
	}

	return { t, f, e }
}

describe('astropy parity', () => {
	const { t, f, e } = astropyLightCurve()
	const periods = Array.from({ length: 81 }, (_, i) => 1.6 + i * 0.0025)
	const result = boxLeastSquares(t, f, e, { durations: [0.08, 0.1, 0.12, 0.14], periods, minTransits: 1, minInTransitPoints: 1 })
	const pg = result.periodogram!

	test('periodogram', () => {
		expect(result.status).toBe('ok')
		expect(result.sampleCount).toBe(408)
		expect(result.rejectedSampleCount).toBe(0)

		// index, depth_snr, depth, duration, transit_time - 2460000
		const reference = [
			[0, 6.567395748971601, 0.0011119008595724038, 0.12, 0.7519999998621643],
			[20, 11.660237839571, 0.0020099756208243552, 0.144, 0.5160000002942979],
			[40, 21.217296851834544, 0.00393195097904636, 0.12, 0.3519999999552965],
			[60, 12.535845852490091, 0.0023343748636685765, 0.104, 0.1600000001490116],
			[80, 12.94790467655874, 0.002487683962006595, 0.144, 1.7639999999664724],
		] as const

		for (const [i, snr, depth, duration, epoch] of reference) {
			expect(pg.periods[i]).toBeCloseTo(periods[i], 14)
			expect(pg.snr[i]).toBeCloseTo(snr, 10)
			expect(pg.power[i]).toBeCloseTo(0.5 * snr * snr, 8)
			expect(pg.depth[i]).toBeCloseTo(depth, 14)
			expect(pg.duration[i]).toBeCloseTo(duration, 12)
			expect(pg.epoch[i] - 2460000).toBeCloseTo(epoch, 8)
		}
	})

	test('best candidate and stats', () => {
		const best = result.candidates[0]

		expect(best.period).toBeCloseTo(1.7, 12)
		expect(best.epoch - 2460000).toBeCloseTo(0.3519999999552965, 8)
		expect(best.duration).toBeCloseTo(0.12, 12)
		expect(best.depth).toBeCloseTo(0.00393195097904636, 14)
		expect(best.depthError).toBeCloseTo(0.00018531818669004414, 15)
		expect(best.snr).toBeCloseTo(21.217296851834544, 10)
		expect(best.evenDepth).toBeCloseTo(0.003933289797470874, 14)
		expect(best.evenDepthError).toBeCloseTo(0.00020447088818178002, 15)
		expect(best.oddDepth).toBeCloseTo(0.00392624614239756, 14)
		expect(best.oddDepthError).toBeCloseTo(0.00041218180891239184, 15)
		expect(best.secondaryDepth).toBeCloseTo(4.2896726087482406e-5, 14)
		expect(best.secondaryDepthError).toBeCloseTo(0.00017827774268730178, 15)
		// depth_half / its error.
		expect(best.halfPeriodSnr).toBeCloseTo(0.0018996278616038031 / 0.00013396446661701904, 8)
		// transit_times with per_transit_count [12, 2, 0, 4, 12].
		expect(best.events.map((event) => [event.index, event.sampleCount])).toEqual([
			[0, 12],
			[1, 2],
			[3, 4],
			[4, 12],
		])
		expect(best.events[2].time - 2460000).toBeCloseTo(5.452000000048429, 8)
		expect(best.transitCount).toBe(4)
		expect(best.expectedTransitCount).toBe(7)
		expect(best.inTransitCount).toBe(30)
		expect(best.outOfTransitLevel - best.inTransitLevel).toBeCloseTo(best.depth, 15)
		expect(best.flags).toEqual([])
	})
})

describe('detection', () => {
	const transit = { period: 2.345, epoch: 2460000.7, duration: 0.1, depth: 0.003 }

	test('night gaps and aliases', () => {
		// 30 nights of 8.4 h: every observed night falls on the same 4 of the 13 transits, so 3/2 and 3 times
		// the period fold exactly the same in-transit samples and cannot be told apart by the data.
		const { t, f } = lightCurve(30, 2460000, 0.25, 0.35, 0.005, 0.001, 42, [transit])
		const result = boxLeastSquares(t, f, 0.001, { durations: [0.05, 0.1, 0.15], minPeriod: 1, maxPeriod: 8 })
		const [best, threeHalves, triple, ...others] = result.candidates

		expect(result.status).toBe('ok')
		expect(result.candidates).toHaveLength(5)
		// Within the peak width, the phase drift of one duration across the baseline.
		expect(Math.abs(best.period - 2.345)).toBeLessThan((0.1 * 2.345) / result.baseline)
		expect(best.epoch).toBeCloseTo(2460000.7, 2)
		expect(best.duration).toBeCloseTo(0.1, 12)
		expect(Math.abs(best.depth - 0.003)).toBeLessThan(3 * best.depthError)
		expect(best.transitCount).toBe(4)
		expect(best.expectedTransitCount).toBe(13)
		expect(best.coverage).toBe(1)
		expect(best.sde!).toBeGreaterThan(5)
		expect(best.flags).toEqual([])
		expect(best.aliasOf).toBeUndefined()

		expect(threeHalves).toMatchObject({ aliasOf: 0, aliasRatio: 1.5, transitCount: 4 })
		expect(threeHalves.snr).toBeCloseTo(best.snr, 10)
		expect(triple).toMatchObject({ aliasOf: 0, aliasRatio: 3, transitCount: 4 })
		expect(triple.snr).toBeCloseTo(best.snr, 10)
		// Half of 3P is 3P/2, which is as significant.
		expect(triple.flags).toContain('halfPeriodAlias')

		// At 3P/4 every other event is empty: a classical odd/even mismatch.
		const subharmonic = others.find((c) => Math.abs(c.period - 0.75 * 2.345) < 0.01)!
		expect(subharmonic).toMatchObject({ aliasOf: 1, aliasRatio: 0.5 })
		expect(subharmonic.flags).toContain('oddEvenMismatch')
		expect(subharmonic.flags).toContain('doublePeriodAlias')
		expect(subharmonic.doublePeriodSnr!).toBeGreaterThan(subharmonic.snr)

		for (let i = 1; i < result.candidates.length; i++) expect(result.candidates[i].power).toBeLessThanOrEqual(result.candidates[i - 1].power)
	})

	test('outliers', () => {
		const durations = [0.05, 0.1, 0.15]
		const clean = lightCurve(10, 2460000, 0, 1, 0.005, 0.001, 7, [transit])
		const { t, f } = lightCurve(10, 2460000, 0, 1, 0.005, 0.001, 7, [transit])

		// Strong single-point outliers (cosmic rays, a satellite) and a three-point dropout.
		for (const [i, delta] of [
			[100, 0.02],
			[777, -0.015],
			[1300, -0.012],
			[1111, 0.03],
			[500, -0.01],
			[501, -0.01],
			[502, -0.01],
		]) {
			f[i] += delta
		}

		const reference = boxLeastSquares(clean.t, clean.f, 0.001, { durations, minPeriod: 1, maxPeriod: 5 }).candidates[0]
		const best = boxLeastSquares(t, f, 0.001, { durations, minPeriod: 1, maxPeriod: 5 }).candidates[0]

		expect(best.period).toBe(reference.period)
		expect(best.epoch).toBe(reference.epoch)
		expect(best.duration).toBeCloseTo(0.1, 12)
		expect(Math.abs(best.depth - 0.003)).toBeLessThan(3 * best.depthError)
		expect(best.transitCount).toBe(4)
		expect(best.flags).toEqual([])
	})

	test.each([
		[2 / 1440, 1 / 24],
		[2 / 1440, 3 / 24],
		[10 / 1440, 1 / 24],
		[10 / 1440, 3 / 24],
		[30 / 1440, 2 / 24],
		[30 / 1440, 4 / 24],
	])('cadence %p and duration %p', (cadence, duration) => {
		// Continuous coverage over 12 days.
		const { t, f } = lightCurve(12, 2460000, 0, 1, cadence, 0.002, 11, [{ period: 3.1, epoch: 2460001.234, duration, depth: 0.005 }])
		const durations = [0.5, 1, 1.5, 2, 3, 4, 5].map((h) => h / 24)
		const result = boxLeastSquares(t, f, 0.002, { durations, minPeriod: 1, maxPeriod: 5, oversample: 4, frequencyFactor: 2 })
		const best = result.candidates[0]
		// One search phase bin.
		const bin = 0.5 / 24 / 4

		// Within the peak width, the phase drift of one duration across the baseline.
		expect(Math.abs(best.period - 3.1)).toBeLessThan((duration * 3.1) / result.baseline)
		expect(Math.abs(best.duration - duration)).toBeLessThanOrEqual(Math.max(cadence, bin) + 1e-12)
		expect(Math.abs(best.epoch - 2460001.234)).toBeLessThanOrEqual(Math.max(cadence, bin))
		expect(Math.abs(best.depth - 0.005)).toBeLessThan(4 * best.depthError)
		// 4 events of 2 to 120 samples each, 2.5 sigma deep per sample.
		expect(best.snr).toBeGreaterThan(6)
	})

	test('eclipsing binary', () => {
		// Primary 1% and secondary 0.5% eclipses half an orbit apart, continuously sampled.
		const primary = { period: 2.4, epoch: 2460000.5, duration: 0.12, depth: 0.01 }
		const secondary = { ...primary, epoch: primary.epoch + 1.2, depth: 0.005 }
		const { t, f } = lightCurve(12, 2460000, 0, 1, 0.01, 0.002, 3, [primary, secondary])
		const result = boxLeastSquares(t, f, 0.002, { durations: [0.08, 0.12, 0.16], minPeriod: 0.5, maxPeriod: 3, maxCandidates: 10 })

		// Folding both eclipses at 1.2 d gives the larger power, with unequal odd and even depths.
		const half = result.candidates.find((c) => Math.abs(c.period - 1.2) < 0.01)!
		expect(half.flags).toContain('oddEvenMismatch')
		expect(half.oddEvenSigma!).toBeGreaterThan(10)
		// The grid period is slightly off 1.2 d, so the boxes drift across the eclipses and lose some depth.
		expect(Math.max(half.evenDepth!, half.oddDepth!)).toBeCloseTo(0.01, 2)
		expect(Math.min(half.evenDepth!, half.oddDepth!)).toBeCloseTo(0.005, 2)

		// The true period has the secondary eclipse at phase 0.5.
		const full = result.candidates.find((c) => Math.abs(c.period - 2.4) < 0.01)!
		expect(full.flags).toContain('secondaryEclipse')
		expect(full.flags).not.toContain('oddEvenMismatch')
		expect(full.secondaryDepth!).toBeCloseTo(0.005, 2)
		expect(full.depth).toBeCloseTo(0.01, 2)
		expect(full.flags).toContain('halfPeriodAlias')
		expect(full.aliasOf).toBe(result.candidates.indexOf(half))
		expect(full.aliasRatio).toBe(2)
	})

	test('transit straddling the first sample', () => {
		const { t, f } = lightCurve(10, 2460000, 0, 1, 0.005, 0.001, 5, [{ period: 1.5, epoch: 2460000.01, duration: 0.08, depth: 0.004 }])
		const result = boxLeastSquares(t, f, 0.001, { durations: [0.04, 0.08], minPeriod: 1, maxPeriod: 2 })
		const best = result.candidates[0]

		expect(best.period).toBeCloseTo(1.5, 3)
		expect(best.epoch).toBeGreaterThanOrEqual(2460000)
		expect(best.epoch).toBeLessThan(2460000 + best.period)
		// The epoch is either the partial first event or the one before it, folded forward by one period.
		const offset = (best.epoch - 2460000.01) / 1.5
		expect(Math.abs(offset - Math.round(offset))).toBeLessThan(0.005)
		expect(best.events[0].time).toBeCloseTo(2460000.01, 2)
	})
})

describe('constraints and degenerate input', () => {
	test('constant flux has no candidate', () => {
		const { t, f } = lightCurve(5, 2460000, 0, 0.5, 0.01, 0, 1, [])
		const result = boxLeastSquares(t, f, 0.001, { durations: [0.05, 0.1] })

		expect(result.status).toBe('noCandidate')
		expect(result.candidates).toHaveLength(0)
		expect(result.periodogram!.power.every((p) => p === 0)).toBeTrue()
		expect(result.periodogram!.depth.every(Number.isNaN)).toBeTrue()
	})

	test('pure noise is not significant', () => {
		const { t, f } = lightCurve(10, 2460000, 0, 0.4, 0.005, 0.001, 99, [])
		const result = boxLeastSquares(t, f, 0.001, { durations: [0.05, 0.1], minPeriod: 0.5, maxPeriod: 5 })
		const best = result.candidates[0]

		expect(result.status).toBe('ok')
		expect(best.snr).toBeLessThan(6)
		expect(best.sde!).toBeLessThan(6)
	})

	test('a single deep event', () => {
		const { t, f } = lightCurve(10, 2460000, 0, 1, 0.005, 0.001, 8, [{ period: 100, epoch: 2460004.5, duration: 0.1, depth: 0.01 }])

		// With the default minTransits = 2 the event is paired with any other event holding samples; every such
		// candidate is flagged, since its depth does not survive without the deep event.
		const strict = boxLeastSquares(t, f, 0.001, { durations: [0.1], minPeriod: 1, maxPeriod: 9 })
		expect(strict.candidates[0].snr).toBeGreaterThan(30)

		for (const c of strict.candidates) {
			expect(c.transitCount).toBeGreaterThanOrEqual(2)
			expect(c.snrWithoutStrongestEvent!).toBeLessThan(3)
			expect(c.flags).toContain('singleEventDominated')
		}

		const single = boxLeastSquares(t, f, 0.001, { durations: [0.1], minPeriod: 6, maxPeriod: 9, minTransits: 1 })
		const best = single.candidates[0]
		expect(best.transitCount).toBe(1)
		expect(best.snrWithoutStrongestEvent).toBeUndefined()
		expect(best.flags).toContain('singleEventDominated')
		expect(best.depth).toBeCloseTo(0.01, 3)
	})

	test('unusable samples are skipped', () => {
		const { t, f } = lightCurve(6, 2460000, 0, 1, 0.01, 0.001, 4, [{ period: 1.3, epoch: 2460000.4, duration: 0.1, depth: 0.005 }])
		const e = f.map(() => 0.001)
		f[3] = Number.NaN
		t[10] = Infinity
		e[20] = 0
		e[30] = -1

		const result = boxLeastSquares(t, f, e, { durations: [0.1], minPeriod: 1, maxPeriod: 2 })

		expect(result.sampleCount).toBe(t.length - 4)
		expect(result.rejectedSampleCount).toBe(4)
		expect(result.candidates[0].period).toBeCloseTo(1.3, 2)
	})

	test('insufficient data', () => {
		expect(boxLeastSquares([], [], 1, { durations: [0.1] }).status).toBe('insufficientData')
		expect(boxLeastSquares([1, 2, 3], [1, 1, 1], 1, { durations: [0.1] }).status).toBe('insufficientData')
		const sameTime = boxLeastSquares([5, 5, 5, 5, 5], [1, 0, 1, 0, 1], 1, { durations: [0.1] })
		expect(sameTime).toMatchObject({ status: 'insufficientData', sampleCount: 5, baseline: 0 })
		expect(sameTime.periodogram).toBeUndefined()

		// A 1 day baseline holds 3 events of 0.5 d only, below minPeriod.
		const t = Array.from({ length: 100 }, (_, i) => i * 0.01)
		const f = t.map(() => 1)
		const result = boxLeastSquares(t, f, 0.001, { durations: [0.1], minPeriod: 0.6, minTransits: 3 })
		expect(result).toMatchObject({ status: 'insufficientData', sampleCount: 100, candidates: [] })
		expect(result.baseline).toBeCloseTo(0.99, 12)
	})

	test('explicit periods are sorted', () => {
		const { t, f } = lightCurve(6, 2460000, 0, 1, 0.01, 0.001, 4, [{ period: 1.3, epoch: 2460000.4, duration: 0.1, depth: 0.005 }])
		const result = boxLeastSquares(t, f, 0.001, { durations: [0.1], periods: [1.4, 1.2, 1.3] })

		expect(Array.from(result.periodogram!.periods)).toEqual([1.2, 1.3, 1.4])
		expect(result.candidates[0].period).toBe(1.3)
	})

	test('invalid configuration throws', () => {
		const t = Array.from({ length: 100 }, (_, i) => i * 0.1)
		const f = t.map(() => 1)

		expect(() => boxLeastSquares(t, f.slice(1), 0.001, { durations: [0.1] })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, [0.001], { durations: [0.1] })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [] })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.1, 0] })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.1], periods: [] })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.6], periods: [1, 2] })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.6], minPeriod: 1 })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.1], minPeriod: 3, maxPeriod: 2 })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.1], oversample: 0.5 })).toThrow(TypeError)
		// A pathological grid fails fast instead of hanging or allocating without bound.
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.1], frequencyFactor: 1e-9 })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [1e-6], periods: [1, 2], maxOperations: 1e30 })).toThrow(RangeError)
		expect(() => boxLeastSquares(t, f, 0.001, { durations: [0.1], maxOperations: 1000 })).toThrow(RangeError)
	})
})
