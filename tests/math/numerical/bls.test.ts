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

// Reference values from Astropy 8.0.2 (NumPy 2.5.3) BoxLeastSquares(t, f, e).power(periods, durations,
// objective='snr', oversample=10) and compute_stats at the best period, on this light curve. The durations
// and the periods n / 128 are exact binary multiples of the bin width 1/128, so both implementations fold
// into the same equal phase bins.
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

// Independent reference: every box of the search grid (equal bins of period / ceil(period / binWidth),
// each duration rounded to whole bins) evaluated directly from the samples with weights 1 / error^2, the
// events of the box counted with a set. Returns the largest log-likelihood improvement of an eligible box.
function bruteForcePower(t: readonly number[], f: readonly number[], e: readonly number[], period: number, durations: readonly number[], oversample: number, minTransits: number, minInTransitPoints: number) {
	const first = Math.min(...t)
	const bins = Math.ceil(period / (Math.min(...durations) / oversample))
	const width = period / bins
	const lengths = new Set(durations.map((d) => Math.max(1, Math.round(d / width))))
	let best = 0

	for (const k of lengths) {
		for (let s = 0; s < bins; s++) {
			let wIn = 0
			let yIn = 0
			let nIn = 0
			let wOut = 0
			let yOut = 0
			const events = new Set<number>()

			for (let i = 0; i < t.length; i++) {
				const x = t[i] - first - s * width
				const cycle = Math.floor(x / period)
				const w = 1 / (e[i] * e[i])

				if (x - cycle * period < k * width) {
					wIn += w
					yIn += w * f[i]
					nIn++
					events.add(cycle)
				} else {
					wOut += w
					yOut += w * f[i]
				}
			}

			if (nIn < minInTransitPoints || wOut === 0 || events.size < minTransits) continue

			const depth = yOut / wOut - yIn / wIn
			if (depth > 0) best = Math.max(best, (0.5 * depth * depth) / (1 / wIn + 1 / wOut))
		}
	}

	return best
}

describe('astropy parity', () => {
	const { t, f, e } = astropyLightCurve()
	const periods = Array.from({ length: 26 }, (_, i) => (205 + i) / 128)
	const durations = [10, 12, 16, 18].map((k) => k / 128)
	const result = boxLeastSquares(t, f, e, { durations, periods, minTransits: 1, minInTransitPoints: 1 })
	const pg = result.periodogram!

	test('periodogram', () => {
		expect(result.status).toBe('ok')
		expect(result.sampleCount).toBe(408)
		expect(result.rejectedSampleCount).toBe(0)

		// 128 * period, depth_snr, depth, duration, transit_time - 2460000
		const reference = [
			[205, 6.488507732204275, 0.0010718025951401643, 0.125, 0.7562500000931323],
			[206, 7.426023101503795, 0.001244177807904893, 0.125, 0.7250000000931323],
			[207, 7.642487596647537, 0.0012990947089398183, 0.125, 0.6937500000931323],
			[208, 7.952038544469662, 0.0015673252333489607, 0.09375, 0.6468750000931323],
			[209, 9.357460348276794, 0.0016817785751849566, 0.125, 0.6312500000931323],
			[210, 10.419308495081276, 0.0017095606189804233, 0.140625, 0.5375000000931323],
			[211, 11.617796818881414, 0.002042059146846917, 0.125, 0.5140625000931323],
			[212, 12.386273452053448, 0.002164989474862987, 0.140625, 0.49843750009313226],
			[213, 14.095374608263485, 0.0024460130409448954, 0.140625, 0.45937500009313226],
			[214, 15.9084995312014, 0.002818687009919383, 0.140625, 0.44375000009313226],
			[215, 17.823521348300815, 0.0031654549999028964, 0.140625, 0.42031250009313226],
			[216, 19.798927611686583, 0.0036570038299821674, 0.125, 0.38125000009313226],
			[217, 20.887168349705636, 0.00364125008657554, 0.140625, 0.36562500009313226],
			[218, 20.934910812349248, 0.0037848196308521843, 0.125, 0.34218750009313226],
			[219, 19.55607341741455, 0.0034099716150570937, 0.140625, 0.33437500009313226],
			[220, 16.888083461487057, 0.003005679568813972, 0.140625, 0.30312500009313226],
			[221, 14.775055176886477, 0.002590260087495825, 0.140625, 0.27187500009313226],
			[222, 12.43834266102924, 0.002229570305825595, 0.125, 0.22500000009313226],
			[223, 12.435698522276168, 0.0025735813821334995, 0.09375, 0.20156250009313226],
			[224, 11.899198313732489, 0.0025022044238465608, 0.078125, 0.17812500009313226],
			[225, 11.86609181974606, 0.0025606520557810873, 0.078125, 0.14687500009313226],
			[226, 11.377396094748184, 0.0025267951701577825, 0.09375, 1.8578125000931323],
			[227, 12.762159472737311, 0.002880688949568256, 0.09375, 1.8421875000931323],
			[228, 13.97652325489809, 0.003270126856503033, 0.09375, 1.8265625000931323],
			[229, 13.371514357914185, 0.0026694345405069877, 0.125, 1.7953125000931323],
			[230, 12.947904676558752, 0.0024876839620066, 0.140625, 1.7718750000931323],
		] as const

		for (let i = 0; i < reference.length; i++) {
			const [n, snr, depth, duration, epoch] = reference[i]
			expect(pg.periods[i]).toBe(n / 128)

			// Astropy scans a box start only while the whole box fits in its bins plus oversample copied bins, so
			// at 224/128 to 227/128 it misses the best boxes, which straddle phase 0 by more than 10 bins: there
			// the result is the brute-force optimum and at least as significant as Astropy's.
			if (n >= 224 && n <= 227) {
				expect(pg.snr[i]).toBeGreaterThan(snr)
				expect(pg.power[i]).toBeCloseTo(bruteForcePower(t, f, e, n / 128, durations, 10, 1, 1), 9)
				continue
			}

			expect(pg.snr[i]).toBeCloseTo(snr, 10)
			expect(pg.power[i]).toBeCloseTo(0.5 * snr * snr, 8)
			expect(pg.depth[i]).toBeCloseTo(depth, 14)
			expect(pg.duration[i]).toBe(duration)
			expect(pg.epoch[i] - 2460000).toBeCloseTo(epoch, 8)
		}
	})

	test('best candidate and stats', () => {
		const best = result.candidates[0]

		expect(best.period).toBe(218 / 128)
		expect(best.epoch - 2460000).toBeCloseTo(0.34218750009313226, 8)
		expect(best.duration).toBe(0.125)
		expect(best.depth).toBeCloseTo(0.0037848196308521843, 14)
		expect(best.depthError).toBeCloseTo(0.00018078986171842518, 15)
		expect(best.snr).toBeCloseTo(20.934910812349248, 10)
		expect(best.evenDepth).toBeCloseTo(0.003790699215349913, 14)
		expect(best.evenDepthError).toBeCloseTo(0.00020032694722826852, 15)
		expect(best.oddDepth).toBeCloseTo(0.003761018144868511, 14)
		expect(best.oddDepthError).toBeCloseTo(0.0003933261504882432, 15)
		// transit_times with per_transit_count [13, 1, 0, 5, 12].
		expect(best.events.map((event) => [event.index, event.sampleCount])).toEqual([
			[0, 13],
			[1, 1],
			[3, 5],
			[4, 12],
		])
		expect(best.events[2].time - 2460000).toBeCloseTo(5.451562500093132, 8)
		expect(best.transitCount).toBe(4)
		expect(best.expectedTransitCount).toBe(7)
		expect(best.inTransitCount).toBe(31)
		expect(best.outOfTransitLevel - best.inTransitLevel).toBeCloseTo(best.depth, 15)
		// Astropy's depth_phased (-4.5e-5 +- 1.8e-4) uses open window edges; both are consistent with no secondary.
		expect(Math.abs(best.secondaryDepth!)).toBeLessThan(best.secondaryDepthError!)
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
		// Within half a phase bin (0.005 d) of the trial duration.
		expect(Math.abs(best.duration - 0.1)).toBeLessThan(0.0025)
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
		// Within half a phase bin (0.005 d) of the trial duration.
		expect(Math.abs(best.duration - 0.1)).toBeLessThan(0.0025)
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

describe('search exactness and conditioning', () => {
	test('minTransits is enforced on every box', () => {
		// The 0.5 dip at phase 0.1 is observed in two cycles only; the 0.9 dip at phase 0.6 in all three.
		const t: number[] = []
		const f: number[] = []

		for (let cycle = 0; cycle < 3; cycle++) {
			for (let j = 0; j < 10; j++) {
				if (cycle === 2 && j === 1) continue
				t.push(cycle + j / 10)
				f.push(j === 1 ? 0.5 : j === 6 ? 0.9 : 1)
			}
		}

		const result = boxLeastSquares(t, f, 1, { periods: [1], durations: [0.1], oversample: 10, minTransits: 3, minInTransitPoints: 1 })
		const best = result.candidates[0]

		expect(result.status).toBe('ok')
		expect(best.transitCount).toBe(3)
		expect(best.inTransitCount).toBe(3)
		// The out-of-transit level keeps the two 0.5 samples: (24 + 1) / 26.
		expect(best.depth).toBeCloseTo(25 / 26 - 0.9, 14)
		expect(best.events.map((e) => e.index)).toEqual([0, 1, 2])
		expect(boxLeastSquares(t, f, 1, { periods: [1], durations: [0.1], oversample: 10, minTransits: 4, minInTransitPoints: 1 }).status).toBe('noCandidate')
	})

	// Random times over 7 cycles of 1.37 d with cycles 2 and 5 unobserved, a transit straddling phase 0 and
	// unequal errors; random times keep the samples off the bin edges, where the reference could round differently.
	const random = mulberry32(2024)
	const noise = gaussian(mulberry32(17), 1)
	const t: number[] = []
	const f: number[] = []
	const e: number[] = []

	while (t.length < 160) {
		const ti = 2460000 + 7 * 1.37 * random()
		const cycle = Math.floor((ti - 2460000) / 1.37)
		if (cycle === 2 || cycle === 5) continue
		const phase = (ti - 2460000.02) / 1.37 - Math.round((ti - 2460000.02) / 1.37)
		const error = 0.001 * (0.5 + random())
		t.push(ti)
		e.push(error)
		f.push(1 + error * noise() - (Math.abs(phase * 1.37) < 0.06 ? 0.004 : 0))
	}

	test.each([1, 2, 3, 4, 6])('periodogram is the brute-force optimum with minTransits %p', (minTransits) => {
		const durations = [0.06, 0.12]
		const periods = [0.9, 1.0234, 1.37, 1.5111, 2.7, 4.1]
		const result = boxLeastSquares(t, f, e, { durations, periods, oversample: 5, minTransits, minInTransitPoints: 2 })

		for (let i = 0; i < periods.length; i++) {
			const reference = bruteForcePower(t, f, e, periods[i], durations, 5, minTransits, 2)
			expect(result.periodogram!.power[i]).toBeCloseTo(reference, 8)
		}

		// 4.1 d holds at most 3 cycles of the 9.6 d span.
		if (minTransits >= 4) expect(result.periodogram!.power[5]).toBe(0)
		for (const c of result.candidates) expect(c.transitCount).toBeGreaterThanOrEqual(minTransits)
	})

	test('candidates are measured with the box of the search', () => {
		// The period 1.03 is not a multiple of the requested bin width 0.1: its 11 bins are 0.0936 wide.
		const time: number[] = []
		const flux: number[] = []

		for (let cycle = 0; cycle < 2; cycle++) {
			for (const phase of [0, 0.05, 0.3, 0.5, 0.7, 1.025]) {
				time.push(cycle * 1.03 + phase)
				flux.push(phase === 1.025 ? 0.8 : 1)
			}
		}

		const result = boxLeastSquares(time, flux, 0.01, { periods: [1.03], durations: [0.1], oversample: 1, minInTransitPoints: 1 })
		const best = result.candidates[0]

		expect(result.periodogram!.depth[0]).toBeCloseTo(0.2, 14)
		expect(best.depth).toBeCloseTo(result.periodogram!.depth[0], 14)
		expect(best.snr).toBeCloseTo(result.periodogram!.snr[0], 12)
		expect(best.duration).toBeCloseTo(1.03 / 11, 14)
		expect(best.inTransitCount).toBe(2)

		// The reported epoch and duration select exactly the in-transit samples; the samples at phase 0 lie on
		// the excluded end of the half-open window, which rounding of this subtraction would blur.
		const inside = time.filter((ti) => {
			const x = ti - (best.epoch - 0.5 * best.duration)
			return x - Math.floor(x / 1.03) * 1.03 < best.duration - 1e-12
		})
		expect(inside).toEqual([1.025, 1.03 + 1.025])
	})

	test('default grid stays inside the period bounds', () => {
		const time = [0, 0.5, 1, 1.5, 2]
		const flux = [1, 1, 1, 1, 1]
		const grid = (frequencyFactor: number, minPeriod = 1, maxPeriod = 2) => Array.from(boxLeastSquares(time, flux, 1, { durations: [0.1], minPeriod, maxPeriod, frequencyFactor, minInTransitPoints: 1 }).periodogram!.periods)

		// Steps of 0.3 and 1 in frequency over [0.5, 1].
		expect(grid(12)).toEqual([1, 1 / 0.7])
		expect(grid(40)).toEqual([1])
		expect(grid(1, 1.5, 1.5)).toEqual([1.5])

		for (const frequencyFactor of [0.37, 1, 3.3, 9.999, 10, 11, 1e6]) {
			const periods = grid(frequencyFactor)

			expect(periods.length).toBeGreaterThan(0)

			for (let i = 0; i < periods.length; i++) {
				expect(Number.isFinite(periods[i])).toBeTrue()
				expect(periods[i]).toBeGreaterThanOrEqual(1)
				expect(periods[i]).toBeLessThanOrEqual(2)
				if (i > 0) expect(periods[i]).toBeGreaterThan(periods[i - 1])
			}
		}
	})

	test('extreme weights keep the out-of-transit group', () => {
		// The in-transit weight 1e16 + 1 would swallow the out-of-transit weight 2 in a total minus the box.
		const result = boxLeastSquares([0, 0.5, 1, 1.5], [0.9, 1, 0.9, 1], [1e-8, 1, 1, 1], { periods: [1], durations: [0.25], minTransits: 1, minInTransitPoints: 1 })
		const best = result.candidates[0]

		expect(result.status).toBe('ok')
		expect(result.periodogram!.depth[0]).toBeCloseTo(0.1, 14)
		expect(best.depth).toBeCloseTo(0.1, 14)
		expect(best.depthError).toBeCloseTo(Math.sqrt(1 / (1e16 + 1) + 1 / 2), 14)
		expect(best.inTransitLevel).toBeCloseTo(0.9, 14)
		expect(best.outOfTransitLevel).toBeCloseTo(1, 14)
		expect(best.events.every((event) => Number.isFinite(event.snr))).toBeTrue()
	})

	test.each([1e-200, 1e-150, 1e150, 1e200])('flux and error scale %p', (scale) => {
		const options = { durations: [0.06, 0.12], periods: [1.2, 1.37, 1.5], oversample: 5 }
		const reference = boxLeastSquares(t, f, e, options).candidates[0]
		const scaled = boxLeastSquares(
			t,
			f.map((v) => v * scale),
			e.map((v) => v * scale),
			options,
		).candidates[0]

		expect(scaled.period).toBe(reference.period)
		expect(scaled.epoch).toBe(reference.epoch)
		expect(scaled.snr).toBeCloseTo(reference.snr, 9)
		expect(scaled.power).toBeCloseTo(reference.power, 7)
		expect(scaled.depth / scale).toBeCloseTo(reference.depth, 12)
		expect(scaled.depthError / scale).toBeCloseTo(reference.depthError, 12)
		expect(scaled.outOfTransitLevel / scale).toBeCloseTo(reference.outOfTransitLevel, 12)
		expect(scaled.oddEvenSigma!).toBeCloseTo(reference.oddEvenSigma!, 9)
	})

	test('wide boxes on a monotonic trend', () => {
		// Two cycles of 1000 sampled every unit with a steadily fading flux: the best box keeps improving as it
		// slides, the worst case for counting events only when the score improves.
		const time = Array.from({ length: 2000 }, (_, i) => i)
		const flux = time.map((ti) => 1 - 1e-4 * (ti % 1000))
		const error = time.map(() => 0.01)
		const durations = [1, 400]

		for (const minTransits of [2, 3]) {
			const result = boxLeastSquares(time, flux, error, { periods: [1000], durations, oversample: 1, minTransits, minInTransitPoints: 1 })
			expect(result.periodogram!.power[0]).toBeCloseTo(bruteForcePower(time, flux, error, 1000, durations, 1, minTransits, 1), 9)
		}
	})
})
