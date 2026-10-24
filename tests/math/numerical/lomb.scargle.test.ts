import { describe, expect, test } from 'bun:test'
import { lombScargle, type LombScarglePeak } from '../../../src/math/numerical/lomb.scargle'
import { gaussian, mulberry32 } from '../../../src/math/numerical/random'

interface Series {
	readonly t: number[]
	readonly y: number[]
	readonly dy: number[]
}

// 60 quasi-random times over 40 days at a Julian Date offset with heteroscedastic errors and a 2.7 d
// sinusoid plus a deterministic pseudo-noise; the reference values below come from Astropy 8.0.2
// LombScargle(t, y, dy, fit_mean=True, center_data=True) with method='slow' (NumPy 2.5.3, SciPy 1.18.1).
function referenceSeries(): Series {
	const t: number[] = []
	const y: number[] = []
	const dy: number[] = []

	for (let i = 0; i < 60; i++) {
		const ti = 2460000 + 40 * ((i * 0.6180339887498949) % 1) + 0.05 * Math.sin(i)
		t.push(ti)
		y.push(10 + 0.8 * Math.cos((2 * Math.PI * (ti - 2460001.3)) / 2.7) + 0.3 * Math.sin(1.7 * i * i))
		dy.push(0.1 + 0.2 * ((i * 0.37) % 1))
	}

	return { t, y, dy }
}

// Random times inside a window of windowLength days starting at windowStart every night for nights
// nights, a sinusoid of the frequency (cycles per day) and amplitude, and Gaussian noise of sigma.
function nightlySeries(nights: number, perNight: number, windowStart: number, windowLength: number, frequency: number, amplitude: number, sigma: number, seed: number) {
	const random = mulberry32(seed)
	const noise = gaussian(mulberry32(seed + 1), sigma)
	const t: number[] = []
	const y: number[] = []

	for (let night = 0; night < nights; night++) {
		for (let j = 0; j < perNight; j++) {
			const ti = night + windowStart + windowLength * random()
			t.push(ti)
			y.push(5 + amplitude * Math.sin(2 * Math.PI * frequency * ti) + noise())
		}
	}

	return { t, y }
}

const FIXED_FREQUENCIES = [0.1, 0.37, 1 / 2.7, 0.5, 1.9]

function modelValue(peak: LombScarglePeak, time: number) {
	return peak.offset + peak.amplitude * Math.cos(2 * Math.PI * peak.frequency * (time - peak.epoch))
}

describe('Astropy comparison', () => {
	const { t, y, dy } = referenceSeries()

	test('default grid matches autofrequency', () => {
		const result = lombScargle(t, y, dy)
		const { grid, periodogram } = result

		expect(result.status).toBe('ok')
		expect(result.sampleCount).toBe(60)
		expect(result.rejectedSampleCount).toBe(0)
		expect(result.firstTime).toBe(2460000)
		expect(result.flags).toEqual([])
		expect(grid!.count).toBe(750)
		expect(grid!.minFrequency).toBeCloseTo(0.002523672840441225, 14)
		expect(grid!.maxFrequency).toBeCloseTo(3.7829855878213965, 12)
		expect(grid!.samplesPerPeak).toBeCloseTo(5, 9)
		expect(grid!.peakWidth).toBeCloseTo(1 / result.baseline, 15)
		expect(grid!.averageNyquistFrequency).toBeCloseTo(30 / result.baseline, 15)
		expect(grid!.degenerateCount).toBe(0)
		expect(periodogram!.power[0]).toBeCloseTo(0.021726088061842154, 9)
		expect(periodogram!.power[100]).toBeCloseTo(0.11895153540467479, 9)
		expect(periodogram!.power[73]).toBeCloseTo(0.9186008066333533, 9)
		expect(Math.max(...periodogram!.power)).toBe(periodogram!.power[73])
	})

	test('normalizations at fixed frequencies', () => {
		const expected = {
			standard: [0.04941509546316743, 0.9187507203774201, 0.9194934447061549, 0.10996084178885547, 0.005399822326672394],
			model: [0.05198388405635861, 11.307801430919904, 11.421348750422219, 0.12354607184908756, 0.005429138711099189],
			log: [0.05067779486011375, 2.510233323995227, 2.5194166656513644, 0.11648981923378465, 0.005414454063542139],
			psd: [22.655667620935446, 421.22575606234864, 421.5662778273696, 50.414478805236214, 2.4756924720783386],
		} as const

		for (const normalization of ['standard', 'model', 'log', 'psd'] as const) {
			const result = lombScargle(t, y, dy, { normalization, frequencies: FIXED_FREQUENCIES })
			expect(result.normalization).toBe(normalization)
			const power = result.periodogram!.power
			for (let i = 0; i < FIXED_FREQUENCIES.length; i++) expect(power[i] / expected[normalization][i]).toBeCloseTo(1, 8)
		}
	})

	test('unweighted', () => {
		const expected = [0.005488622542275158, 0.8938572637903096, 0.8958066888980885, 0.003241074887566545, 0.012365675169786799]
		const power = lombScargle(t, y, 1, { frequencies: FIXED_FREQUENCIES }).periodogram!.power
		for (let i = 0; i < expected.length; i++) expect(power[i] / expected[i]).toBeCloseTo(1, 8)
	})

	test('fitted model at one frequency', () => {
		const result = lombScargle(t, y, dy, { frequencies: [1 / 2.7] })
		const [peak] = result.peaks

		expect(result.mean).toBeCloseTo(9.893090892797666, 12)
		expect(peak.frequency).toBe(1 / 2.7)
		expect(peak.period).toBeCloseTo(2.7, 14)
		expect(peak.epoch).toBeGreaterThanOrEqual(2460000)
		expect(peak.epoch).toBeLessThan(2460000 + 2.7)
		expect(peak.epoch).toBeCloseTo(2460001.3, 1)
		expect(modelValue(peak, 2460000)).toBeCloseTo(9.079785290785516, 8)
		expect(modelValue(peak, 2460001.3)).toBeCloseTo(10.854410131493022, 8)
		expect(modelValue(peak, 2460010.123)).toBeCloseTo(9.854573963625347, 8)
	})

	// fap_baluev(z, fmax, t - 2460000, y, dy, 'standard') of Astropy 8.0.2 with fmax the only frequency.
	test('baluev false-alarm probability of a single-frequency band', () => {
		const cases = [
			[0.5, 0.7448090184748432],
			[1.9, 0.9999999999981908],
			[0.1, 0.7519206787613829],
			[1 / 2.7, 1.721057905865716e-29],
		] as const

		for (const [frequency, expected] of cases) {
			const [peak] = lombScargle(t, y, dy, { frequencies: [frequency], falseAlarm: { method: 'baluev' } }).peaks
			expect(peak.falseAlarmProbability! / expected).toBeCloseTo(1, 7)
		}
	})

	test('uniform sampling', () => {
		const t8 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
		const y8 = [1, 3, 2, 5, 4, 4.5, 1.5, 2.5]
		const expected = [0.5560508309070821, 0.6017438561301688, 0.4009659553095347, 0.029466929109205203]
		const power = lombScargle(t8, y8, 1, { frequencies: [0.1, 0.25, 0.4, 0.7] }).periodogram!.power
		for (let i = 0; i < expected.length; i++) expect(power[i] / expected[i]).toBeCloseTo(1, 10)

		const [peak] = lombScargle(t8, y8, 1, { frequencies: [0.4], falseAlarm: { method: 'baluev' } }).peaks
		expect(peak.falseAlarmProbability).toBeCloseTo(0.6088736019109307, 12)
	})
})

describe('peaks', () => {
	test('irregular noisy sinusoid', () => {
		const random = mulberry32(7)
		const noise = gaussian(mulberry32(8), 0.2)
		const t: number[] = []
		const y: number[] = []
		const dy: number[] = []

		for (let i = 0; i < 200; i++) {
			const ti = 100 * random()
			const sigma = 0.1 + 0.3 * random()
			t.push(ti)
			y.push(3 + 0.5 * Math.cos(2 * Math.PI * 0.31 * (ti - 1.2)) + (sigma / 0.2) * noise())
			dy.push(sigma)
		}

		const result = lombScargle(t, y, dy, { falseAlarm: { method: 'baluev' } })
		const [best] = result.peaks

		expect(result.status).toBe('ok')
		expect(result.peaks).toHaveLength(5)
		expect(best.frequency).toBeCloseTo(0.31, 3)
		expect(best.period).toBe(1 / best.frequency)
		expect(best.power).toBe(best.standardPower)
		expect(best.power).toBeGreaterThanOrEqual(result.periodogram!.power[best.index])
		expect(best.amplitude).toBeCloseTo(0.5, 1)
		expect(best.offset).toBeCloseTo(3, 1)
		expect(best.epoch - result.firstTime).toBeLessThan(best.period)
		const cycles = (best.epoch - 1.2) / best.period
		expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(0.02)
		expect(best.flags).toEqual([])
		expect(best.falseAlarmProbability).toBeLessThan(1e-20)

		for (let i = 1; i < result.peaks.length; i++) {
			expect(result.peaks[i].standardPower).toBeLessThanOrEqual(result.peaks[i - 1].standardPower)
			expect(result.peaks[i].falseAlarmProbability).toBeGreaterThan(best.falseAlarmProbability!)
		}
	})

	test('daily aliases are linked to the true peak', () => {
		// 30 nights of 20 samples between 0.3 and 0.6 d; a 0.7 d period.
		const { t, y } = nightlySeries(30, 20, 0.3, 0.3, 1 / 0.7, 0.4, 0.15, 3)
		const result = lombScargle(t, y, 0.15, { maxFrequency: 4, maxPeaks: 6 })
		const [best, ...others] = result.peaks

		expect(best.frequency).toBeCloseTo(1 / 0.7, 3)
		expect(best.aliasOf).toBeUndefined()

		// The ±1 cycle per day aliases are reported and linked to the true peak through the window.
		for (const alias of [1 / 0.7 - 1, 1 / 0.7 + 1]) {
			const peak = others.find((p) => Math.abs(p.frequency - alias) < 0.01)
			expect(peak).toBeDefined()
			expect(peak!.aliasOf).toBe(0)
			expect(peak!.flags).toContain('alias')
		}

		// The window has its daily side lobe near 1 cycle per day.
		const { frequency, window } = result.periodogram!
		let daily = 0
		for (let i = 0; i < frequency.length; i++) if (Math.abs(frequency[i] - 1) < 0.01) daily = Math.max(daily, window[i])
		expect(daily).toBeGreaterThan(0.7)
	})

	test('grid edge and below-baseline flags', () => {
		const t: number[] = []
		const y: number[] = []

		for (let i = 0; i < 50; i++) {
			t.push(i * 0.37 + 0.1 * Math.sin(i))
			y.push(Math.sin(2 * Math.PI * 0.02 * t[i]) + 0.01 * Math.cos(5 * i))
		}

		const [peak] = lombScargle(t, y, 0.01, { minFrequency: 0.02, maxFrequency: 0.5 }).peaks
		expect(peak.index).toBe(0)
		expect(peak.flags).toContain('gridEdge')
		expect(peak.flags).toContain('belowBaseline')
	})

	test('maxPeaks', () => {
		const { t, y, dy } = referenceSeries()
		expect(lombScargle(t, y, dy, { maxPeaks: 0 }).peaks).toEqual([])
		expect(lombScargle(t, y, dy, { maxPeaks: 2 }).peaks).toHaveLength(2)
	})

	test('coarse grid', () => {
		const { t, y, dy } = referenceSeries()
		const result = lombScargle(t, y, dy, { samplesPerPeak: 1 })
		expect(result.grid!.samplesPerPeak).toBeCloseTo(1, 9)
		expect(result.flags).toEqual(['coarseGrid'])

		const single = lombScargle(t, y, dy, { frequencies: [0.3] })
		expect(single.grid!.maxStep).toBe(0)
		expect(single.grid!.samplesPerPeak).toBe(Number.POSITIVE_INFINITY)
		expect(single.flags).toEqual([])
	})
})

describe('false-alarm probability', () => {
	test('bootstrap is deterministic and separates signal from noise', () => {
		const { t, y } = nightlySeries(10, 8, 0.2, 0.5, 1 / 0.7, 0.4, 0.15, 11)
		const options = { maxFrequency: 3, maxPeaks: 3, falseAlarm: { method: 'bootstrap', samples: 50, random: mulberry32(5) } } as const
		const signal = lombScargle(t, y, 0.15, options)

		expect(signal.peaks[0].falseAlarmProbability).toBe(0)
		expect(lombScargle(t, y, 0.15, { ...options, falseAlarm: { ...options.falseAlarm, random: mulberry32(5) } }).peaks).toEqual(signal.peaks)

		const noise = gaussian(mulberry32(13), 1)
		const pure = lombScargle(
			t,
			t.map(() => noise()),
			1,
			{ ...options, falseAlarm: { ...options.falseAlarm, random: mulberry32(5) } },
		)

		expect(pure.peaks[0].falseAlarmProbability).toBeGreaterThan(0.05)
		for (const peak of pure.peaks) expect(peak.falseAlarmProbability! * 50).toBe(Math.round(peak.falseAlarmProbability! * 50))
	})

	test('bootstrap and baluev agree in order of magnitude for noise', () => {
		const noise = gaussian(mulberry32(21), 1)
		const random = mulberry32(22)
		const t = Array.from({ length: 80 }, () => 30 * random())
		const y = t.map(() => noise())
		const baluev = lombScargle(t, y, 1, { maxPeaks: 1, falseAlarm: { method: 'baluev' } }).peaks[0].falseAlarmProbability!
		const bootstrap = lombScargle(t, y, 1, { maxPeaks: 1, falseAlarm: { method: 'bootstrap', samples: 100, random: mulberry32(23) } }).peaks[0].falseAlarmProbability!

		expect(baluev).toBeGreaterThan(0.05)
		expect(bootstrap).toBeGreaterThan(0.05)
		expect(Math.abs(baluev - bootstrap)).toBeLessThan(0.5)
	})
})

describe('numerical robustness', () => {
	test('invariant to sample order and time offset', () => {
		const { t, y, dy } = referenceSeries()
		const order = t.map((_, i) => (i * 37) % t.length)
		const frequencies = { frequencies: FIXED_FREQUENCIES }
		const reference = lombScargle(t, y, dy, frequencies).periodogram!.power
		const shuffled = lombScargle(
			order.map((i) => t[i]),
			order.map((i) => y[i]),
			order.map((i) => dy[i]),
			frequencies,
		).periodogram!.power
		const shifted = lombScargle(
			t.map((ti) => ti - 2460000),
			y,
			dy,
			frequencies,
		).periodogram!.power

		for (let i = 0; i < reference.length; i++) {
			expect(shuffled[i]).toBeCloseTo(reference[i], 12)
			expect(shifted[i]).toBeCloseTo(reference[i], 9)
		}
	})

	test('wide dynamic range of values and errors', () => {
		const t: number[] = []
		const y: number[] = []

		for (let i = 0; i < 40; i++) {
			t.push(2460000 + i * 0.731 + 0.2 * Math.sin(3 * i))
			y.push(1e6 + 1e-3 * Math.cos(2 * Math.PI * 0.4 * (t[i] - 2460000.25)))
		}

		const [peak] = lombScargle(t, y, 1e-6, { frequencies: [0.4] }).peaks
		expect(peak.standardPower).toBeCloseTo(1, 6)
		expect(peak.amplitude).toBeCloseTo(1e-3, 9)
		expect(peak.offset).toBeCloseTo(1e6, 6)
		expect(peak.epoch).toBeCloseTo(2460000.25, 4)

		// Scaling values and errors by 1e200 changes neither the standard power nor the chi-square.
		const reference = referenceSeries()
		const base = lombScargle(reference.t, reference.y, reference.dy, { frequencies: FIXED_FREQUENCIES, normalization: 'psd' })
		const scaled = lombScargle(
			reference.t,
			reference.y.map((v) => v * 1e200),
			reference.dy.map((e) => e * 1e200),
			{ frequencies: FIXED_FREQUENCIES, normalization: 'psd' },
		)

		expect(scaled.referenceChiSquare / base.referenceChiSquare).toBeCloseTo(1, 12)
		for (let i = 0; i < FIXED_FREQUENCIES.length; i++) expect(scaled.periodogram!.power[i] / base.periodogram!.power[i]).toBeCloseTo(1, 12)

		// Errors spanning 200 orders of magnitude leave finite powers.
		const extreme = lombScargle(
			reference.t,
			reference.y,
			reference.dy.map((e, i) => e * 10 ** ((i % 5) * 50 - 100)),
			{ frequencies: FIXED_FREQUENCIES },
		)
		for (const p of extreme.periodogram!.power) expect(p).toBeGreaterThanOrEqual(0)
		for (const p of extreme.periodogram!.power) expect(p).toBeLessThanOrEqual(1)
	})

	test('differing error bars down-weight an outlier', () => {
		const { t, y, dy } = referenceSeries()
		const frequencies = { frequencies: [1 / 2.7] }
		const clean = lombScargle(t, y, dy, frequencies).periodogram!.power[0]
		const outlierWithLargeError = lombScargle([...t, 2460020.5], [...y, 50], [...dy, 1e4], frequencies).periodogram!.power[0]
		const outlierWithSmallError = lombScargle([...t, 2460020.5], [...y, 50], [...dy, 0.1], frequencies).periodogram!.power[0]

		expect(outlierWithLargeError).toBeCloseTo(clean, 6)
		expect(clean).toBeGreaterThan(0.9)
		expect(outlierWithSmallError).toBeLessThan(0.2)
	})

	test('uniform sampling reflects about the Nyquist frequency and degenerates at the sampling frequency', () => {
		const t = Array.from({ length: 32 }, (_, i) => i * 0.25)
		const y = t.map((ti, i) => Math.sin(2 * Math.PI * 0.6 * ti) + 0.1 * Math.sin(7 * i * i))
		const result = lombScargle(t, y, 1, { frequencies: [1e-9, 0.6, 2, 4 - 0.6, 4] })
		const { power, conditioning, window } = result.periodogram!

		expect(power[3]).toBeCloseTo(power[1], 9)
		expect(conditioning[3]).toBeCloseTo(conditioning[1], 9)
		expect(power[1]).toBeGreaterThan(0.9)
		// The sine column vanishes at the Nyquist frequency, every phase coincides at the sampling frequency
		// and far below 1 / baseline.
		expect(conditioning[2]).toBe(0)
		expect(power[2]).toBeGreaterThan(0)
		expect(conditioning[4]).toBe(0)
		expect(power[4]).toBe(0)
		expect(window[4]).toBeCloseTo(1, 12)
		expect(conditioning[0]).toBe(0)
		expect(result.grid!.degenerateCount).toBe(3)
		expect(result.flags).toEqual(['coarseGrid', 'degenerateFrequencies'])
	})

	test('poor conditioning at low frequency stays finite and bounded', () => {
		const { t, y, dy } = referenceSeries()
		const baseline = Math.max(...t) - Math.min(...t)
		const result = lombScargle(t, y, dy, { frequencies: [1e-3 / baseline, 1e-2 / baseline, 1e-1 / baseline] })
		const { power, conditioning } = result.periodogram!

		for (let i = 0; i < 3; i++) {
			expect(power[i]).toBeGreaterThanOrEqual(0)
			expect(power[i]).toBeLessThanOrEqual(1)
			expect(conditioning[i]).toBeGreaterThan(0)
		}

		expect(conditioning[2]).toBeGreaterThan(conditioning[1])
		expect(conditioning[1]).toBeGreaterThan(conditioning[0])
		expect(conditioning[0]).toBeLessThan(1e-2)
		// Toward zero frequency the sinusoid tends to a quadratic trend, so the power converges.
		expect(power[0]).toBeCloseTo(power[1], 3)
		expect(result.peaks[0].flags).toContain('belowBaseline')
	})
})

describe('degenerate data', () => {
	test('constant signal', () => {
		const { t, dy } = referenceSeries()
		const result = lombScargle(
			t,
			t.map(() => 0.1),
			dy,
		)

		expect(result.status).toBe('constant')
		expect(result.mean).toBe(0.1)
		expect(result.referenceChiSquare).toBe(0)
		expect(result.periodogram).toBeUndefined()
		expect(result.grid).toBeUndefined()
		expect(result.peaks).toEqual([])

		expect(
			lombScargle(
				t,
				t.map(() => 1e10),
				dy,
			).status,
		).toBe('constant')

		// Every value with a non-zero square-root weight is identical: the error ratio 1e-330 underflows to 0.
		const zeroWeight = lombScargle(
			t,
			t.map((_, i) => (i === 7 ? 100 : 3)),
			t.map((_, i) => (i === 7 ? 1e10 : 1e-320)),
		)
		expect(zeroWeight.status).toBe('constant')
		expect(zeroWeight.mean).toBe(3)

		for (const extreme of [Number.MAX_VALUE, Number.MIN_VALUE]) {
			const constant = lombScargle(
				t,
				t.map(() => extreme),
				dy,
			)
			expect(constant.status).toBe('constant')
			expect(constant.mean).toBe(extreme)
		}
	})

	// Regression: an error ratio of 1e-170 underflows the relative weight to 0, but the chi-square term of a
	// sample one sigma away, ((1e10 - 0) / 1e10)^2 = 1, used to be dropped, reporting a perfect fit. The four
	// other samples fit the cosine exactly and fix the model, so chi-square goes from 5 to 1.
	test('chi-square term of a sample with an underflowed weight', () => {
		const a = 1e-160
		const time = [0, 1, 2, 3, 4]
		const options = { frequencies: [0.5], falseAlarm: { method: 'bootstrap', samples: 20, random: mulberry32(1) } } as const

		for (const k of [1, 1e100, 1e-100]) {
			const value = [a, -a, a, -a, 1e10].map((v) => v * k)
			const error = [a, a, a, a, 1e10].map((e) => e * k)
			const standard = lombScargle(time, value, error, { ...options, falseAlarm: { ...options.falseAlarm, random: mulberry32(1) } })
			const psd = lombScargle(time, value, error, { ...options, normalization: 'psd' })

			expect(standard.status).toBe('ok')
			expect(standard.referenceChiSquare).toBeCloseTo(5, 12)
			expect(standard.periodogram!.power[0]).toBeCloseTo(0.8, 12)
			expect(psd.periodogram!.power[0]).toBeCloseTo(2, 12)
			expect(standard.peaks[0].amplitude / (a * k)).toBeCloseTo(1, 12)
			expect(standard.peaks[0].falseAlarmProbability).toBeGreaterThanOrEqual(0)
			expect(standard.peaks[0].falseAlarmProbability).toBeLessThanOrEqual(1)
		}
	})

	// Regression: an extreme value whose relative weight (1e-170)^2 underflows to 0 used to scale to Infinity
	// and turn the sums into NaN. It is 1e138 sigma away, so it dominates the chi-square (1 + 1e276) while
	// leaving the fit, which the sinusoid cannot bend toward it, unchanged: the power is about 1e-276.
	test('extreme value with an underflowed weight', () => {
		const frequencies = { frequencies: [0.5] }
		const base = lombScargle([0, 1, 2, 3], [0, 1, 0, 1], 1, frequencies)
		expect(base.periodogram!.power[0]).toBeCloseTo(1, 15)

		for (const extreme of [1e308, -1e308]) {
			const result = lombScargle([0, 1, 2, 3, 4], [0, 1, 0, 1, extreme], [1, 1, 1, 1, 1e170], { ...frequencies, falseAlarm: { method: 'bootstrap', samples: 20, random: mulberry32(1) } })
			expect(result.status).toBe('ok')
			expect(result.sampleCount).toBe(5)
			expect(result.mean).toBe(base.mean)
			expect(result.referenceChiSquare / 1e276).toBeCloseTo(1, 12)
			expect(result.periodogram!.power[0] / 1e-276).toBeCloseTo(1, 6)
			expect(result.peaks[0].amplitude).toBeCloseTo(base.peaks[0].amplitude, 12)
			expect(result.peaks[0].falseAlarmProbability).toBeGreaterThanOrEqual(0)
			expect(result.peaks[0].falseAlarmProbability).toBeLessThanOrEqual(1)
		}

		// A large error with a negligible normalized residual, 0.3 / 1e170, leaves the result unchanged.
		const negligible = lombScargle([0, 1, 2, 3, 4], [0, 1, 0, 1, 0.3], [1, 1, 1, 1, 1e170], { ...frequencies, falseAlarm: { method: 'bootstrap', samples: 20, random: mulberry32(1) } })
		expect(negligible.mean).toBe(base.mean)
		expect(negligible.referenceChiSquare).toBe(base.referenceChiSquare)
		expect(negligible.periodogram!.power[0]).toBe(base.periodogram!.power[0])
	})

	// Regression: a fixed tolerance relative to the largest value used to drop this resolved signal as constant.
	test('signal on a large offset', () => {
		const t = Array.from({ length: 40 }, (_, i) => 0.27 * i + 0.05 * (i % 3))
		const y = t.map((x) => 1e10 + 5e-5 * Math.cos(2 * Math.PI * 0.31 * x))
		const frequencies = { frequencies: [0.31] }
		const offset = lombScargle(t, y, 1e-6, frequencies)
		const centered = lombScargle(
			t,
			y.map((v) => v - 1e10),
			1e-6,
			frequencies,
		)

		expect(offset.status).toBe('ok')
		expect(offset.periodogram!.power[0]).toBeGreaterThan(0.99)
		// Subtracting the offset is exact, so the quantized samples and their power are the same.
		expect(offset.periodogram!.power[0]).toBeCloseTo(centered.periodogram!.power[0], 12)
		expect(offset.peaks[0].amplitude).toBeCloseTo(centered.peaks[0].amplitude, 15)
		expect(offset.peaks[0].amplitude / 5e-5).toBeCloseTo(1, 1)
		// The offset near 1e10 is representable only to its ulp, 2^-19.
		expect(Math.abs(offset.peaks[0].offset - (1e10 + centered.peaks[0].offset))).toBeLessThanOrEqual(2 ** -19)
	})

	// Regression: with values near ±1.5e308 and a weighted mean near -1e308, the centered values overflowed
	// to Infinity and the power collapsed to 0 with a NaN chi-square.
	test('values spanning almost the whole double range', () => {
		const t = Array.from({ length: 40 }, (_, i) => 0.37 * i + 0.1 * Math.sin(i))
		const pattern = t.map((x) => (Math.cos(2 * Math.PI * 0.2 * x) > 0.5 ? 1 : -1))
		const frequencies = { frequencies: [0.2] }
		const unit = lombScargle(t, pattern, 1, frequencies)

		for (const k of [1.5e308, 1e-310, Number.MIN_VALUE]) {
			const scaled = lombScargle(
				t,
				pattern.map((p) => k * p),
				k,
				frequencies,
			)

			expect(scaled.status).toBe('ok')
			expect(scaled.referenceChiSquare).toBeCloseTo(unit.referenceChiSquare, 10)
			expect(scaled.periodogram!.power[0]).toBeCloseTo(unit.periodogram!.power[0], 12)

			// The mean, amplitude and offset are not representable as multiples of Number.MIN_VALUE.
			if (k === Number.MIN_VALUE) continue

			expect(scaled.mean / k).toBeCloseTo(unit.mean, 12)
			expect(scaled.peaks[0].amplitude / k).toBeCloseTo(unit.peaks[0].amplitude, 12)
			expect(scaled.peaks[0].offset / k).toBeCloseTo(unit.peaks[0].offset, 12)
		}
	})

	// Regression: Math.log2(Number.MAX_VALUE) rounds to 1024, which made the pre-scaling unit Infinity and
	// reported this series as constant.
	test('values at Number.MAX_VALUE', () => {
		const hi = Number.MAX_VALUE
		const t = [0, 1, 2, 3, 4, 5, 6, 7]
		const sign = [1, -1, 1, -1, 1, -1, 1, -1]
		const frequencies = { frequencies: [0.5] }
		const unit = lombScargle(t, sign, 1, frequencies)
		const extreme = lombScargle(
			t,
			sign.map((s) => s * hi),
			hi,
			frequencies,
		)

		expect(extreme.status).toBe('ok')
		expect(extreme.mean).toBe(0)
		expect(extreme.referenceChiSquare).toBeCloseTo(unit.referenceChiSquare, 12)
		expect(extreme.periodogram!.power[0]).toBeCloseTo(unit.periodogram!.power[0], 12)
		expect(extreme.peaks[0].amplitude / hi).toBeCloseTo(unit.peaks[0].amplitude, 12)
	})

	test('signal of one ulp', () => {
		// 1e10 lies in [2^33, 2^34), so its ulp is 2^-19; a square wave between two adjacent doubles.
		const ulp = 2 ** -19
		const t = Array.from({ length: 50 }, (_, i) => 0.37 * i + 0.1 * Math.sin(i))
		const wave = t.map((x) => (Math.cos(2 * Math.PI * 0.2 * x) > 0 ? ulp : 0))
		const frequencies = { frequencies: [0.2] }
		const offset = lombScargle(
			t,
			wave.map((v) => 1e10 + v),
			ulp,
			frequencies,
		)
		const zero = lombScargle(t, wave, ulp, frequencies)

		expect(offset.status).toBe('ok')
		expect(offset.periodogram!.power[0]).toBeGreaterThan(0.7)
		expect(offset.periodogram!.power[0]).toBeCloseTo(zero.periodogram!.power[0], 12)
	})

	test('insufficient data', () => {
		const three = lombScargle([0, 1, 2], [1, 2, 3], 1)
		expect(three.status).toBe('insufficientData')
		expect(three.sampleCount).toBe(3)
		expect(three.mean).toBe(2)
		expect(three.periodogram).toBeUndefined()

		const rejected = lombScargle([0, 1, Number.NaN, 3, 4, 5], [1, Number.NaN, 2, 3, 4, 5], [1, 1, 1, 0, -1, Number.POSITIVE_INFINITY])
		expect(rejected.status).toBe('insufficientData')
		expect(rejected.sampleCount).toBe(1)
		expect(rejected.rejectedSampleCount).toBe(5)

		const sameTime = lombScargle([5, 5, 5, 5, 5], [1, 2, 3, 4, 5], 1)
		expect(sameTime.status).toBe('insufficientData')
		expect(sameTime.baseline).toBe(0)

		const empty = lombScargle([], [], 1)
		expect(empty.status).toBe('insufficientData')
		expect(empty.mean).toBeNaN()
		expect(empty.firstTime).toBe(0)
	})

	test('skips unusable samples', () => {
		const { t, y, dy } = referenceSeries()
		const result = lombScargle([...t, Number.NaN, 2460001], [...y, 1, Number.NaN], [...dy, 1, 1], { frequencies: FIXED_FREQUENCIES })
		const reference = lombScargle(t, y, dy, { frequencies: FIXED_FREQUENCIES })

		expect(result.sampleCount).toBe(60)
		expect(result.rejectedSampleCount).toBe(2)
		expect(result.periodogram!.power).toEqual(reference.periodogram!.power)
	})
})

describe('options', () => {
	const { t, y, dy } = referenceSeries()

	test('explicit frequencies are sorted', () => {
		const result = lombScargle(t, y, dy, { frequencies: [0.5, 0.1, 0.3] })
		expect([...result.periodogram!.frequency]).toEqual([0.1, 0.3, 0.5])
		expect(result.grid!.maxStep).toBeCloseTo(0.2, 15)
	})

	test('default grid bounds', () => {
		const result = lombScargle(t, y, dy, { minFrequency: 0.2, maxFrequency: 0.5, samplesPerPeak: 10 })
		const { frequency } = result.periodogram!
		expect(frequency[0]).toBe(0.2)
		expect(frequency[1] - frequency[0]).toBeCloseTo(0.1 / result.baseline, 15)
		expect(Math.abs(frequency.at(-1)! - 0.5)).toBeLessThanOrEqual((0.05 / result.baseline) * (1 + 1e-9))
	})

	// Regression: the default lowest frequency 0.02 used to be searched although above maxFrequency.
	test('lone maxFrequency below the default lowest frequency', () => {
		const result = lombScargle([0, 1, 2, 3, 4, 5], [1, 2, 1, 0, 2, 0], 1, { maxFrequency: 0.01 })
		expect([...result.periodogram!.frequency]).toEqual([0.01])
		expect(result.grid!.maxFrequency).toBe(0.01)

		const above = lombScargle([0, 1, 2, 3, 4, 5], [1, 2, 1, 0, 2, 0], 1, { maxFrequency: 0.5 })
		expect(above.periodogram!.frequency[0]).toBeCloseTo(0.02, 15)
	})

	test('throws on invalid input', () => {
		expect(() => lombScargle([0, 1], [1], 1)).toThrow(RangeError)
		expect(() => lombScargle(t, y, [1, 2])).toThrow(RangeError)
		expect(() => lombScargle(t, y, dy, { frequencies: [] })).toThrow(RangeError)
		expect(() => lombScargle(t, y, dy, { frequencies: [0.1, Number.NaN] })).toThrow(TypeError)
		expect(() => lombScargle(t, y, dy, { minFrequency: 1, maxFrequency: 0.5 })).toThrow(RangeError)
		expect(() => lombScargle(t, y, dy, { samplesPerPeak: 0 })).toThrow(RangeError)
		expect(() => lombScargle(t, y, dy, { maxPeaks: 1.5 })).toThrow(TypeError)
		expect(() => lombScargle(t, y, dy, { falseAlarm: { method: 'bootstrap', samples: 0, random: mulberry32(1) } })).toThrow(TypeError)
		expect(() => lombScargle(t, y, dy, { maxEvaluations: 1000 })).toThrow(RangeError)
		expect(() => lombScargle(t, y, dy, { nyquistFactor: 1e12 })).toThrow(RangeError)
	})
})
