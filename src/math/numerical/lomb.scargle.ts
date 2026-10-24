import { TAU } from '../../core/constants'
import { validateNonNegativeInteger, validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import { clamp, type NumberArray } from './math'
import { brentMinimize } from './optimization'
import type { Random } from './random'
import { logGamma } from './statistics'

// Generalized weighted Lomb-Scargle periodogram (Zechmeister & Kürster 2009, A&A 496, 577) for unevenly
// sampled real-valued time series. At every trial frequency f the samples are fitted by weighted linear
// least squares with the floating-mean model offset + A cos(2π f t) + B sin(2π f t), weighted by the
// inverse variance of each measurement, and the power is the fraction of the weighted variance about the
// weighted mean that the sinusoid removes. Each frequency is evaluated directly in O(N), so a grid of M
// frequencies costs O(N × M) sine and cosine evaluations; no FFT or trigonometric recurrence is used, so
// any frequency grid is exact. The two sinusoid columns are centered on their weighted means and rotated
// by the time shift τ that decorrelates them (the eigenvectors of their 2×2 weighted covariance), and the
// variance of each rotated column is accumulated directly instead of by cancelling differences, so the
// poorly conditioned regimes (frequencies far below 1 / baseline, sampling commensurate with the period)
// lose accuracy only gracefully; a rotated column whose weighted variance falls below 1e-18 (an RMS of
// 1e-9 of the unit amplitude) is not constrained by the sampling and is dropped from that fit. Residuals
// are whitened by their errors before they are squared and the values are pre-scaled by a power of two,
// so the chi-square keeps every representable term even when the relative weights underflow, and values
// and errors may span the whole double range. Times are in one uniform unit and timescale chosen by the
// caller (for example BJD_TDB days); frequencies are in cycles per that unit and periods, epochs and the
// baseline in that unit; values are in any linear unit and their one-sigma errors in the same unit.
// Nothing is inferred about physical timescales. Pure function: the inputs are never mutated; the
// periodogram arrays are freshly allocated and owned by the caller, and the work arrays are typed arrays
// sized by the sample count, allocated per call after the estimated work has been bounded.

// Smallest number of usable samples: the model has three parameters and one residual degree of freedom
// is needed for the power to be informative.
const MIN_SAMPLES = 4

// Default grid frequencies per peak width 1 / baseline (Astropy's samples_per_peak).
const DEFAULT_SAMPLES_PER_PEAK = 5

// Default highest frequency of the grid in units of the average Nyquist frequency 0.5 N / baseline
// (Astropy's nyquist_factor).
const DEFAULT_NYQUIST_FACTOR = 5

// Default number of reported peaks.
const DEFAULT_MAX_PEAKS = 5

// Default spectral window power, in [0, 1], above which a weaker peak is marked as an alias of a stronger one.
const DEFAULT_ALIAS_WINDOW_POWER = 0.5

// Default bound on the estimated work, in sample-frequency evaluations (one sine and one cosine plus a few
// multiply-adds each, about 40 ns; several seconds of single-threaded work on a desktop CPU).
const DEFAULT_MAX_EVALUATIONS = 2e8

// Largest number of trial frequencies; bounds the four periodogram arrays to about 270 MB.
const MAX_FREQUENCIES = 1 << 23

// Weighted variance, with the weights normalized to unit sum, below which a decorrelated sinusoid column
// is treated as unconstrained by the sampling and dropped from the fit. Its square root, 1e-9 of the unit
// amplitude, is where the rounding of the columns (about 1e-16) would perturb the power by about 1e-6.
const DEGENERATE_VARIANCE = 1e-18

// Iterations of the Brent maximization refining each peak between its grid neighbors.
const REFINEMENT_ITERATIONS = 64

// Frequency evaluations of one refinement: the Brent iterations, its initial point and the final fit.
const REFINEMENT_EVALUATIONS = REFINEMENT_ITERATIONS + 2

// Refinement tolerance relative to the width of the bracket between the grid neighbors; the power is
// quadratic at a maximum, so the frequency is only determined to about sqrt(ε) of the peak width anyway.
const REFINEMENT_TOLERANCE = 1e-9

// Fewest grid frequencies per peak width 1 / baseline below which a narrow peak can fall between grid
// frequencies and the 'coarseGrid' flag is raised.
const MIN_SAMPLES_PER_PEAK = 2

// Normalization of the reported power. With p the standard power:
// 'standard': p = 1 - χ² / χ²_ref, in [0, 1], the fraction of the weighted variance about the weighted mean
// removed by the sinusoid.
// 'model': p / (1 - p) = χ²_ref / χ² - 1, in [0, Infinity], Infinity for an exact fit.
// 'log': -ln(1 - p) = ln(χ²_ref / χ²), in [0, Infinity], Infinity for an exact fit.
// 'psd': χ²_ref p / 2 = (χ²_ref - χ²) / 2, half the chi-square improvement, which follows an exponential
// distribution of unit mean under pure Gaussian noise only when the errors are the true one-sigma errors.
export type LombScargleNormalization = 'standard' | 'model' | 'log' | 'psd'

// False-alarm probability of the reported peaks: the probability that pure noise produces a highest peak at
// least as high anywhere in the searched band. Both methods test the standard power of a peak, whatever the
// normalization, and assume independent samples.
// 'baluev': the analytic upper bound of Baluev (2008, MNRAS 385, 1279, eq. 6, the 'standard' row of
// Table 1, as in Astropy), for Gaussian white noise whose errors are known up to one common scale factor and
// a band from 0 to the highest grid frequency. Accurate for small probabilities (below about 0.1) and
// conservative for large ones; it ignores the actual grid and the spectral window.
// 'bootstrap': samples resamples of the (value, error) pairs drawn with replacement by random at the
// original times; the probability is the fraction of resamples whose highest refined peak over the same
// grid is at least as high. It keeps the sampling and the error distribution but destroys any periodicity;
// its resolution is 1 / samples, so 0 means below that, and it multiplies the work by samples + 1.
export type LombScargleFalseAlarm = { readonly method: 'baluev' } | { readonly method: 'bootstrap'; readonly samples: number; readonly random: Random }

// Outcome of the periodogram.
// 'ok': the periodogram was evaluated.
// 'constant': every usable value with a non-zero weight is identical, so the power is undefined; there is
// no periodogram and no peak. Values that differ by a single ulp are a signal, not a constant.
// 'insufficientData': fewer than 4 usable samples or a zero baseline; there is no periodogram and no peak.
export type LombScargleStatus = 'ok' | 'constant' | 'insufficientData'

// Diagnostic flags of the periodogram.
// 'coarseGrid': the largest spacing between neighboring grid frequencies exceeds half the peak width
// 1 / baseline, so a narrow peak can fall between grid frequencies and be missed or underestimated.
// 'degenerateFrequencies': at some grid frequencies the sampling does not constrain one or both
// decorrelated sinusoid columns (conditioning 0), as at multiples of the sampling frequency of a regular
// cadence, at its Nyquist frequency, or far below 1 / baseline.
export type LombScargleFlag = 'coarseGrid' | 'degenerateFrequencies'

// Diagnostic flags of a peak. None of them rejects it.
// 'gridEdge': the grid maximum is the first or last grid frequency, so the true maximum may lie outside
// the searched band.
// 'belowBaseline': the frequency is below 1 / baseline, so less than one cycle was observed and a trend
// can mimic it.
// 'degenerate': the sampling does not constrain one of the sinusoid columns at the peak frequency.
// 'alias': aliasOf names a stronger peak that the spectral window links to this one.
export type LombScarglePeakFlag = 'gridEdge' | 'belowBaseline' | 'degenerate' | 'alias'

// Options of lombScargle. Frequencies are in cycles per time unit of the input times.
export interface LombScargleOptions {
	// Explicit trial frequencies, positive and finite, at least one, in any order (sorted ascending in the
	// periodogram). When omitted, the grid of Astropy's autofrequency is built: minFrequency + k * step for
	// k < count, with step = 1 / (samplesPerPeak * baseline) and
	// count = max(1, 1 + round((maxFrequency - minFrequency) / step)), so the last frequency may exceed
	// maxFrequency by up to half a step.
	readonly frequencies?: Readonly<NumberArray>
	// Lowest frequency of the default grid, positive. Defaults to half a step, 0.5 / (samplesPerPeak * baseline),
	// or to maxFrequency when that is lower, which leaves maxFrequency as the only frequency.
	readonly minFrequency?: number
	// Highest frequency of the default grid, positive, not below minFrequency. Defaults to nyquistFactor
	// times the average Nyquist frequency 0.5 * sampleCount / baseline.
	readonly maxFrequency?: number
	// Grid frequencies per peak width 1 / baseline of the default grid, positive. Defaults to 5.
	readonly samplesPerPeak?: number
	// Highest frequency of the default grid in average Nyquist frequencies, positive. Defaults to 5; irregular
	// sampling can resolve frequencies far above the average Nyquist frequency.
	readonly nyquistFactor?: number
	// Normalization of the reported power. Defaults to 'standard'.
	readonly normalization?: LombScargleNormalization
	// Maximum number of reported peaks, a non-negative integer. Defaults to 5.
	readonly maxPeaks?: number
	// Spectral window power, in [0, 1], at the difference or the sum of two peak frequencies above which the
	// weaker one is marked as an alias of the stronger one. Defaults to 0.5.
	readonly aliasWindowPower?: number
	// False-alarm probability of the reported peaks; omitted to skip it.
	readonly falseAlarm?: LombScargleFalseAlarm
	// Bound on the estimated work in sample-frequency evaluations: samples * (frequencies + the peak
	// refinements and alias checks), times bootstrap samples + 1 with a bootstrap. A larger estimate, or more
	// than 2^23 frequencies, throws a RangeError before any allocation instead of running for an unbounded
	// time. Defaults to 2e8.
	readonly maxEvaluations?: number
}

// Frequency grid diagnostics.
export interface LombScargleGrid {
	// Number of trial frequencies, at least 1.
	readonly count: number
	// Lowest and highest trial frequency, cycles per time unit.
	readonly minFrequency: number
	readonly maxFrequency: number
	// Largest spacing between neighboring trial frequencies, cycles per time unit; 0 for a single frequency.
	readonly maxStep: number
	// Peak width 1 / baseline, cycles per time unit: the resolution of the periodogram.
	readonly peakWidth: number
	// peakWidth / maxStep, the fewest grid frequencies per peak width; Infinity for a single frequency.
	readonly samplesPerPeak: number
	// Average Nyquist frequency 0.5 * sampleCount / baseline, cycles per time unit; only a reference scale for
	// irregular sampling, not a limit.
	readonly averageNyquistFrequency: number
	// Grid frequencies where at least one sinusoid column was dropped as unconstrained.
	readonly degenerateCount: number
}

// Periodogram over the grid. Every array has one entry per trial frequency.
export interface LombScarglePeriodogram {
	// Trial frequencies, ascending, cycles per time unit.
	readonly frequency: Float64Array
	// Power in the requested normalization.
	readonly power: Float64Array
	// Spectral window power |Σ w exp(2πi f t)|^2 / (Σ w)^2 of the weighted sampling, in [0, 1]: 1 where every
	// sample has the same phase (f = 0 or a multiple of a regular sampling frequency), so a peak at f0 leaks
	// to f0 ± f and f - f0 with about this power.
	readonly window: Float64Array
	// sqrt(λmin / λmax) of the weighted covariance of the two centered sinusoid columns, in [0, 1]: 1 for
	// orthogonal columns of equal variance, near 0 for a poorly conditioned fit, and 0 when a column was
	// dropped as unconstrained.
	readonly conditioning: Float64Array
}

// A local maximum of the periodogram, refined between its grid neighbors, with the fitted sinusoid
// value(t) = offset + amplitude * cos(2π frequency (t - epoch)).
export interface LombScarglePeak {
	// Refined frequency, cycles per time unit, between the grid neighbors of index, and its period, time unit.
	readonly frequency: number
	readonly period: number
	// Power at the refined frequency in the requested normalization, at least that at the grid frequency.
	readonly power: number
	// Standard power at the refined frequency, in [0, 1]; the statistic of the false-alarm probability.
	readonly standardPower: number
	// Index of the grid maximum in the periodogram.
	readonly index: number
	// Semi-amplitude of the fitted sinusoid, value unit, non-negative.
	readonly amplitude: number
	// Fitted offset (the floating mean), value unit.
	readonly offset: number
	// Time of a maximum of the fitted sinusoid, in [firstTime, firstTime + period), time unit.
	readonly epoch: number
	// Conditioning of the fit at the refined frequency, as in the periodogram.
	readonly conditioning: number
	// Spectral window power at the refined frequency.
	readonly window: number
	// False-alarm probability in [0, 1]; undefined without the falseAlarm option.
	readonly falseAlarmProbability?: number
	// Index in peaks of the strongest stronger peak whose frequency difference or sum has a spectral window
	// power of at least aliasWindowPower; undefined otherwise.
	readonly aliasOf?: number
	// Diagnostic flags, empty for a clean peak.
	readonly flags: readonly LombScarglePeakFlag[]
}

// Result of lombScargle.
export interface LombScargleResult {
	// Outcome of the periodogram.
	readonly status: LombScargleStatus
	// Normalization of the reported powers.
	readonly normalization: LombScargleNormalization
	// Usable samples: finite time and value and a finite positive error.
	readonly sampleCount: number
	// Samples skipped as unusable.
	readonly rejectedSampleCount: number
	// Earliest usable time and time span of the usable samples, time unit; 0 without usable samples.
	readonly firstTime: number
	readonly baseline: number
	// Inverse-variance weighted mean of the usable values, value unit; NaN without usable samples.
	readonly mean: number
	// Chi-square of the usable values about their weighted mean, Σ ((value - mean) / error)^2; 0 without
	// usable samples.
	readonly referenceChiSquare: number
	// Frequency grid diagnostics; undefined unless the status is 'ok'.
	readonly grid?: LombScargleGrid
	// Periodogram; undefined unless the status is 'ok'.
	readonly periodogram?: LombScarglePeriodogram
	// Peaks by decreasing power, at most maxPeaks.
	readonly peaks: readonly LombScarglePeak[]
	// Diagnostic flags of the periodogram, empty for a clean one.
	readonly flags: readonly LombScargleFlag[]
}

// Weighted samples prepared for the fits.
interface WeightedSamples {
	// Times minus the earliest usable time, time unit, non-negative; shared by the bootstrap resamples.
	readonly t: Float64Array
	// Inverse-variance weights normalized to unit sum.
	readonly w: Float64Array
	// Square roots of the weights, (minError / error) normalized so that their squares sum to 1; they enter
	// only the normal equations, where one that underflows to 0 (an error more than about 1e323 times the
	// smallest one) has no influence anyway.
	readonly r: Float64Array
	// Whitened residuals (value - mean) / error divided by the largest of them, in [-1, 1], formed without the
	// error ratio, so that a sample whose r underflowed still keeps its chi-square term.
	readonly y: Float64Array
	// Number of samples.
	readonly count: number
	// Weighted mean value, value unit.
	readonly mean: number
	// Value-unit scale of the coefficients fitted to y in units of r, as scale * 2^scaleExponent, kept as two
	// factors because the product can overflow or underflow; scale is 0 for a constant series.
	readonly scale: number
	readonly scaleExponent: number
	// Σ y^2, the weighted variance about the mean in units of the largest whitened residual, at least 1; 0
	// for a constant series.
	readonly variance: number
	// Chi-square of the values about their weighted mean.
	readonly referenceChiSquare: number
}

// Least-squares fit at one frequency, overwritten by every evaluation.
interface FrequencyFit {
	// Standard power, in [0, 1].
	power: number
	// Spectral window power, in [0, 1].
	window: number
	// sqrt(λmin / λmax), or 0 when a column was dropped.
	conditioning: number
	// Coefficients of cos(2π f t) and sin(2π f t) about their weighted means, in units of the samples'
	// scale * 2^scaleExponent.
	cosine: number
	sine: number
	// Weighted means of cos(2π f t) and sin(2π f t).
	meanCosine: number
	meanSine: number
}

// Evaluates the generalized weighted Lomb-Scargle periodogram of an uneven time series, extracts and
// refines its highest peaks with their fitted sinusoids and diagnostics, and optionally their false-alarm
// probabilities. time, value and error have one entry per sample (error may be a single error for every
// sample, such as 1 for an unweighted periodogram), in any order; a sample with a non-finite time or value,
// or a non-finite or non-positive error, is skipped, so a missing value may be NaN. Times are in one
// uniform unit and timescale; a large offset such as a Julian Date is removed internally. Throws a
// TypeError or RangeError when an option is out of its documented domain, and a RangeError when the array
// lengths differ, when explicit frequencies are empty, when minFrequency exceeds maxFrequency, or when the
// estimated work exceeds maxEvaluations or the grid exceeds 2^23 frequencies.
export function lombScargle(time: Readonly<NumberArray>, value: Readonly<NumberArray>, error: Readonly<NumberArray> | number, options: LombScargleOptions = {}): LombScargleResult {
	const n = time.length

	// Mismatched arrays would silently pair a time with another sample's value.
	if (value.length !== n || (typeof error !== 'number' && error.length !== n)) throw new RangeError('time, value and error must have equal lengths')

	const normalization = options.normalization ?? 'standard'
	const maxPeaks = validateNonNegativeInteger(options.maxPeaks ?? DEFAULT_MAX_PEAKS)
	const aliasWindowPower = options.aliasWindowPower ?? DEFAULT_ALIAS_WINDOW_POWER
	const maxEvaluations = validatePositiveFinite(options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS)
	const falseAlarm = options.falseAlarm
	const bootstrapSamples = falseAlarm?.method === 'bootstrap' ? validatePositiveInteger(falseAlarm.samples) : 0

	let explicit: Float64Array | undefined
	let samplesPerPeak = DEFAULT_SAMPLES_PER_PEAK
	let nyquistFactor = DEFAULT_NYQUIST_FACTOR
	let minFrequency: number | undefined
	let maxFrequency: number | undefined

	if (options.frequencies !== undefined) {
		// An empty grid has no frequency to evaluate and no band for the false-alarm probability.
		if (options.frequencies.length === 0) throw new RangeError('frequencies must not be empty')
		// Bounds the copy and the periodogram arrays.
		if (options.frequencies.length > MAX_FREQUENCIES) throw new RangeError('too many frequencies')

		explicit = new Float64Array(options.frequencies.length)
		for (let i = 0; i < explicit.length; i++) explicit[i] = validatePositiveFinite(options.frequencies[i])
		explicit.sort()
	} else {
		samplesPerPeak = validatePositiveFinite(options.samplesPerPeak ?? DEFAULT_SAMPLES_PER_PEAK)
		nyquistFactor = validatePositiveFinite(options.nyquistFactor ?? DEFAULT_NYQUIST_FACTOR)
		minFrequency = options.minFrequency === undefined ? undefined : validatePositiveFinite(options.minFrequency)
		maxFrequency = options.maxFrequency === undefined ? undefined : validatePositiveFinite(options.maxFrequency)

		// Swapped explicit bounds would silently search an unintended band.
		if (minFrequency !== undefined && maxFrequency !== undefined && !(minFrequency <= maxFrequency)) throw new RangeError('minFrequency must not exceed maxFrequency')
	}

	const usable = usableSamples(time, value, error)
	const { count, firstTime, baseline } = usable
	const rejectedSampleCount = n - count
	const empty = { normalization, sampleCount: count, rejectedSampleCount, firstTime, baseline, peaks: [], flags: [] } as const

	if (count < MIN_SAMPLES || !(baseline > 0)) {
		const samples = count > 0 ? weightedSamples(usable.t, usable.value, usable.error) : undefined
		return { ...empty, status: 'insufficientData', mean: samples?.mean ?? Number.NaN, referenceChiSquare: samples?.referenceChiSquare ?? 0 }
	}

	const samples = weightedSamples(usable.t, usable.value, usable.error)
	if (samples.variance === 0) return { ...empty, status: 'constant', mean: samples.mean, referenceChiSquare: samples.referenceChiSquare }

	let step = 0
	let frequencyCount: number

	if (explicit !== undefined) {
		frequencyCount = explicit.length
	} else {
		step = 1 / (samplesPerPeak * baseline)
		// A lone maxFrequency below the default lowest frequency must not move the band above it.
		minFrequency ??= maxFrequency === undefined ? 0.5 * step : Math.min(0.5 * step, maxFrequency)
		const highest = maxFrequency ?? nyquistFactor * 0.5 * (count / baseline)
		frequencyCount = Math.max(1, 1 + Math.round((highest - minFrequency) / step))
	}

	// Every frequency is evaluated over all the samples, for the data and for every bootstrap resample, and
	// each peak is refined and compared with the stronger ones. Bounds the run time and the periodogram arrays
	// before allocating them.
	const peakEvaluations = maxPeaks * (REFINEMENT_EVALUATIONS + 2 * maxPeaks)
	const evaluations = count * (frequencyCount + peakEvaluations + bootstrapSamples * (frequencyCount + REFINEMENT_EVALUATIONS))
	if (!(evaluations <= maxEvaluations)) throw new RangeError(`the periodogram needs about ${evaluations.toExponential(2)} evaluations, more than maxEvaluations`)
	if (frequencyCount > MAX_FREQUENCIES) throw new RangeError('too many frequencies; raise the lowest frequency, lower the highest one or lower samplesPerPeak')

	let frequency: Float64Array

	if (explicit !== undefined) {
		frequency = explicit
	} else {
		frequency = new Float64Array(frequencyCount)
		for (let i = 0; i < frequencyCount; i++) frequency[i] = minFrequency! + step * i
	}

	const power = new Float64Array(frequencyCount)
	const window = new Float64Array(frequencyCount)
	const conditioning = new Float64Array(frequencyCount)
	const c = new Float64Array(count)
	const s = new Float64Array(count)
	const fit: FrequencyFit = { power: 0, window: 0, conditioning: 0, cosine: 0, sine: 0, meanCosine: 0, meanSine: 0 }
	let degenerateCount = 0
	let maxStep = 0

	for (let i = 0; i < frequencyCount; i++) {
		fitFrequency(samples, frequency[i], c, s, fit)
		power[i] = fit.power
		window[i] = fit.window
		conditioning[i] = fit.conditioning
		if (fit.conditioning === 0) degenerateCount++
		if (i > 0 && frequency[i] - frequency[i - 1] > maxStep) maxStep = frequency[i] - frequency[i - 1]
	}

	const peakWidth = 1 / baseline
	const grid: LombScargleGrid = {
		count: frequencyCount,
		minFrequency: frequency[0],
		maxFrequency: frequency[frequencyCount - 1],
		maxStep,
		peakWidth,
		samplesPerPeak: frequencyCount > 1 ? peakWidth / maxStep : Number.POSITIVE_INFINITY,
		averageNyquistFrequency: 0.5 * (count / baseline),
		degenerateCount,
	}

	const flags: LombScargleFlag[] = []
	if (grid.samplesPerPeak < MIN_SAMPLES_PER_PEAK) flags.push('coarseGrid')
	if (degenerateCount > 0) flags.push('degenerateFrequencies')

	const peaks = extractPeaks(samples, frequency, power, maxPeaks, aliasWindowPower, c, s, fit, firstTime, baseline, normalization)

	if (falseAlarm !== undefined && peaks.length > 0) {
		// The Baluev band is the highest grid frequency times the effective baseline sqrt(4π Var(t)).
		const bandwidth = falseAlarm.method === 'baluev' ? frequency[frequencyCount - 1] * Math.sqrt(2 * TAU * weightedTimeVariance(samples)) : 0
		const probability = falseAlarm.method === 'baluev' ? (z: number) => baluevFalseAlarmProbability(z, count, bandwidth) : bootstrapFalseAlarmProbability(usable, frequency, bootstrapSamples, falseAlarm.random, c, s, fit)
		for (let i = 0; i < peaks.length; i++) peaks[i] = { ...peaks[i], falseAlarmProbability: probability(peaks[i].standardPower) }
	}

	for (let i = 0; i < frequencyCount; i++) power[i] = normalizePower(power[i], normalization, samples.referenceChiSquare)

	return { ...empty, status: 'ok', mean: samples.mean, referenceChiSquare: samples.referenceChiSquare, grid, periodogram: { frequency, power, window, conditioning }, peaks, flags }
}

// Usable samples in input order, relative to the earliest usable time.
interface UsableSamples {
	// Times minus firstTime, time unit, non-negative.
	readonly t: Float64Array
	// Values, value unit.
	readonly value: Float64Array
	// One-sigma errors, value unit, finite and positive.
	readonly error: Float64Array
	// Number of usable samples.
	readonly count: number
	// Earliest usable time, time unit; 0 without usable samples.
	readonly firstTime: number
	// Time span of the usable samples, time unit; 0 without usable samples.
	readonly baseline: number
}

// Collects the samples with a finite time and value and a finite positive error, in input order.
function usableSamples(time: Readonly<NumberArray>, value: Readonly<NumberArray>, error: Readonly<NumberArray> | number): UsableSamples {
	const n = time.length
	let count = 0
	let firstTime = Number.POSITIVE_INFINITY
	let lastTime = Number.NEGATIVE_INFINITY

	for (let i = 0; i < n; i++) {
		const e = typeof error === 'number' ? error : error[i]
		if (!Number.isFinite(time[i]) || !Number.isFinite(value[i]) || !Number.isFinite(e) || !(e > 0)) continue
		count++
		if (time[i] < firstTime) firstTime = time[i]
		if (time[i] > lastTime) lastTime = time[i]
	}

	const t = new Float64Array(count)
	const v = new Float64Array(count)
	const sigma = new Float64Array(count)

	if (count === 0) return { t, value: v, error: sigma, count, firstTime: 0, baseline: 0 }

	for (let i = 0, j = 0; i < n; i++) {
		const e = typeof error === 'number' ? error : error[i]
		if (!Number.isFinite(time[i]) || !Number.isFinite(value[i]) || !Number.isFinite(e) || !(e > 0)) continue
		t[j] = time[i] - firstTime
		v[j] = value[i]
		sigma[j++] = e
	}

	return { t, value: v, error: sigma, count, firstTime, baseline: lastTime - firstTime }
}

// Normalizes the inverse-variance weights to unit sum and whitens the values: each residual about the
// weighted mean is divided by its own error, through binary exponents rather than the error ratio, before
// anything is squared, so a sample whose relative weight (minError / error)^2 or even its square root
// underflows to 0 still contributes its chi-square term ((value - mean) / error)^2 whenever that term is
// representable, while it has no influence on the mean or the fitted coefficients. The values are first
// scaled by a power of two that brings the largest just below 2^1020, which is exact (barring values more
// than 2^2039 times smaller, which become subnormal), so their differences stay finite even when they span
// the whole double range; the centering is corrected by the
// weighted mean of the first residuals (the corrected two-pass algorithm), subtracted from the small
// residuals rather than added to the mean, where it would be rounded again to the ulp of a large offset.
// The series is constant only when every usable value is identical, so a signal of a few ulps on a large
// offset is kept. Requires at least one sample; the one with the smallest
// error always has a positive weight.
function weightedSamples(t: Float64Array, value: Float64Array, error: Float64Array): WeightedSamples {
	const count = t.length
	const w = new Float64Array(count)
	const r = new Float64Array(count)
	const y = new Float64Array(count)
	let minError = Number.POSITIVE_INFINITY

	for (let i = 0; i < count; i++) if (error[i] < minError) minError = error[i]

	let sumW = 0

	for (let i = 0; i < count; i++) {
		r[i] = minError / error[i]
		sumW += r[i] * r[i]
	}

	const norm = Math.sqrt(sumW)
	let constant = true
	let maxValue = 0
	let weightedReference = Number.NaN
	let weightedConstant = true

	for (let i = 0; i < count; i++) {
		r[i] /= norm
		w[i] = r[i] * r[i]
		if (value[i] !== value[0]) constant = false
		if (Math.abs(value[i]) > maxValue) maxValue = Math.abs(value[i])

		if (w[i] > 0) {
			if (Number.isNaN(weightedReference)) weightedReference = value[i]
			else if (value[i] !== weightedReference) weightedConstant = false
		}
	}

	if (constant) return { t, w, r, y, count, mean: value[0], scale: 0, scaleExponent: 0, variance: 0, referenceChiSquare: 0 }

	// Two distinct values make maxValue positive. The largest scaled value lies in [2^1017, 2^1020), so the
	// differences from the mean stay below 2^1021 and, divided by an error mantissa of at least 0.5, below
	// 2^1022, while every value down to 2^-2039 times the largest stays a normal double; a subnormal maxValue
	// is scaled by 2^1074 at most.
	const unitExponent = Math.max(-1074, binaryExponent(maxValue) - 1018)
	const unit = 2 ** unitExponent
	let mean = 0

	// When every value with a non-zero weight is identical (the sample with the smallest error always has
	// one), that value is the exact weighted mean, so their residuals are exactly 0 rather than a rounding
	// of the mean that a tiny error would magnify into a huge chi-square. Otherwise any two of them differ by
	// at least an ulp, which dwarfs the rounding of the centering.
	if (weightedConstant) mean = weightedReference / unit
	else for (let i = 0; i < count; i++) if (w[i] > 0) mean += w[i] * (value[i] / unit)

	let correction = 0

	for (let i = 0; i < count; i++) {
		y[i] = value[i] / unit - mean
		correction += w[i] * y[i]
	}

	mean = (mean + correction) * unit

	// The whitened residual (value - mean) / error = (d / m) * 2^(unitExponent - e), with d the scaled
	// residual and error = m * 2^e, is formed as a mantissa and an exponent and brought to the common
	// exponent of the largest one, so that it neither overflows nor underflows with the ratio of the errors.
	const exponent = new Int32Array(count)
	let largestExponent = Number.NEGATIVE_INFINITY

	for (let i = 0; i < count; i++) {
		const e = binaryExponent(error[i])
		const q = (y[i] - correction) / (error[i] / 2 ** e)
		y[i] = q
		exponent[i] = unitExponent - e

		if (q !== 0) {
			const k = exponent[i] + binaryExponent(Math.abs(q))
			if (k > largestExponent) largestExponent = k
		}
	}

	// Distinct values whose residuals all round to 0 are constant to working precision; this also keeps the
	// scaling below from dividing by zero.
	if (largestExponent === Number.NEGATIVE_INFINITY) return { t, w, r, y: y.fill(0), count, mean, scale: 0, scaleExponent: 0, variance: 0, referenceChiSquare: 0 }

	let maxResidual = 0

	for (let i = 0; i < count; i++) {
		y[i] = timesPowerOfTwo(y[i], exponent[i] - largestExponent)
		if (Math.abs(y[i]) > maxResidual) maxResidual = Math.abs(y[i])
	}

	let variance = 0

	for (let i = 0; i < count; i++) {
		y[i] /= maxResidual
		variance += y[i] * y[i]
	}

	// y = r * d * unit * norm / (minError * maxResidual * 2^largestExponent), so a fitted coefficient k of
	// y = k * r * column is the value-unit coefficient k * minError * maxResidual * 2^largestExponent / norm.
	const errorExponent = binaryExponent(minError)
	const scale = ((minError / 2 ** errorExponent) * maxResidual) / norm
	const scaleExponent = errorExponent + largestExponent
	const referenceChiSquare = timesPowerOfTwo(maxResidual * maxResidual * variance, 2 * largestExponent)

	return { t, w, r, y, count, mean, scale, scaleExponent, variance, referenceChiSquare }
}

// Exponent e of a power of two near a positive finite x, so that x / 2^e lies in [0.5, 4) and 2^e is
// representable: Math.log2 can round up across a power of two, notably to 1024 at Number.MAX_VALUE.
function binaryExponent(x: number) {
	return Math.min(1023, Math.floor(Math.log2(x)))
}

// x * 2^exponent for an integer exponent beyond the range of a single power of two, applied in exact
// steps of at most 2^±1023; the result overflows or underflows only when the true product does.
function timesPowerOfTwo(x: number, exponent: number) {
	while (exponent > 1023) {
		x *= 2 ** 1023
		exponent -= 1023
	}

	while (exponent < -1022) {
		x *= 2 ** -1022
		exponent += 1022
	}

	return x * 2 ** exponent
}

// Fits offset + A cos(2π f t) + B sin(2π f t) to the samples by weighted least squares and writes the
// standard power, window power, conditioning and coefficients into fit. c and s are scratch arrays of
// the sample count. Three passes: the sinusoid columns and their weighted means, the centered columns and
// their weighted covariance, and the variances of the columns rotated by the decorrelating angle, which
// are its eigenvalues accumulated without cancellation.
function fitFrequency(samples: WeightedSamples, frequency: number, c: Float64Array, s: Float64Array, fit: FrequencyFit) {
	const { t, w, r, y, count, variance } = samples
	const omega = TAU * frequency
	let meanCosine = 0
	let meanSine = 0

	for (let i = 0; i < count; i++) {
		const x = omega * t[i]
		c[i] = Math.cos(x)
		s[i] = Math.sin(x)
		meanCosine += w[i] * c[i]
		meanSine += w[i] * s[i]
	}

	let cc = 0
	let ss = 0
	let cs = 0
	let yc = 0
	let ys = 0

	for (let i = 0; i < count; i++) {
		const u = c[i] - meanCosine
		const v = s[i] - meanSine
		const wi = w[i]
		c[i] = u
		s[i] = v
		cc += wi * u * u
		ss += wi * v * v
		cs += wi * u * v
		yc += y[i] * (r[i] * u)
		ys += y[i] * (r[i] * v)
	}

	// The angle 2θ = atan2(2 cs, cc - ss) diagonalizes the covariance; the first rotated column has the
	// larger variance.
	const theta = 0.5 * Math.atan2(2 * cs, cc - ss)
	const ct = Math.cos(theta)
	const st = Math.sin(theta)
	let large = 0
	let small = 0

	for (let i = 0; i < count; i++) {
		const a = c[i] * ct + s[i] * st
		const b = s[i] * ct - c[i] * st
		large += w[i] * a * a
		small += w[i] * b * b
	}

	const ya = yc * ct + ys * st
	const yb = ys * ct - yc * st
	const ka = large > DEGENERATE_VARIANCE ? ya / large : 0
	const kb = small > DEGENERATE_VARIANCE ? yb / small : 0
	let explained = 0
	if (ka !== 0) explained += ya * ka
	if (kb !== 0) explained += yb * kb

	fit.power = clamp(explained / variance, 0, 1)
	fit.window = Math.min(1, meanCosine * meanCosine + meanSine * meanSine)
	fit.conditioning = small > DEGENERATE_VARIANCE ? Math.sqrt(small / large) : 0
	fit.cosine = ka * ct - kb * st
	fit.sine = ka * st + kb * ct
	fit.meanCosine = meanCosine
	fit.meanSine = meanSine
}

// Spectral window power |Σ w exp(2πi f t)|^2 of the normalized weights at one frequency.
function windowPower(samples: WeightedSamples, frequency: number) {
	const { t, w, count } = samples
	const omega = TAU * frequency
	let re = 0
	let im = 0

	for (let i = 0; i < count; i++) {
		const x = omega * t[i]
		re += w[i] * Math.cos(x)
		im += w[i] * Math.sin(x)
	}

	return Math.min(1, re * re + im * im)
}

// Maximizes the standard power between the grid neighbors of index with Brent's method and returns the
// better of the refined and the grid frequency; fit then holds the fit at the returned frequency.
function refinePeak(samples: WeightedSamples, frequency: Float64Array, power: Float64Array, index: number, c: Float64Array, s: Float64Array, fit: FrequencyFit) {
	const lo = frequency[index > 0 ? index - 1 : index]
	const hi = frequency[index < frequency.length - 1 ? index + 1 : index]
	let best = frequency[index]

	if (hi > lo) {
		const negativePower = (f: number) => {
			fitFrequency(samples, f, c, s, fit)
			return -fit.power
		}

		const { minimum, value } = brentMinimize(negativePower, lo, hi, { maxIterations: REFINEMENT_ITERATIONS, tolerance: REFINEMENT_TOLERANCE * (hi - lo) })
		if (-value > power[index]) best = minimum
	}

	fitFrequency(samples, best, c, s, fit)
	return best
}

// Finds the local maxima of the standard power (a plateau counts once, at its first frequency), keeps the
// maxPeaks highest, refines them, measures their sinusoids and marks the aliases. power holds standard
// powers.
function extractPeaks(samples: WeightedSamples, frequency: Float64Array, power: Float64Array, maxPeaks: number, aliasWindowPower: number, c: Float64Array, s: Float64Array, fit: FrequencyFit, firstTime: number, baseline: number, normalization: LombScargleNormalization): LombScarglePeak[] {
	if (maxPeaks === 0) return []

	const m = frequency.length
	const maxima: number[] = []

	for (let i = 0; i < m; i++) {
		if (power[i] > 0 && (i === 0 || power[i] > power[i - 1]) && (i === m - 1 || power[i] >= power[i + 1])) maxima.push(i)
	}

	maxima.sort((a, b) => power[b] - power[a] || a - b)
	if (maxima.length > maxPeaks) maxima.length = maxPeaks

	const peaks: LombScarglePeak[] = []

	for (const index of maxima) {
		const f = refinePeak(samples, frequency, power, index, c, s, fit)
		const period = 1 / f
		const phase = Math.atan2(fit.sine, fit.cosine)
		const flags: LombScarglePeakFlag[] = []

		if (m > 1 && (index === 0 || index === m - 1)) flags.push('gridEdge')
		if (f * baseline < 1) flags.push('belowBaseline')
		if (fit.conditioning === 0) flags.push('degenerate')

		peaks.push({
			frequency: f,
			period,
			power: normalizePower(fit.power, normalization, samples.referenceChiSquare),
			standardPower: fit.power,
			index,
			amplitude: timesPowerOfTwo(samples.scale * Math.hypot(fit.cosine, fit.sine), samples.scaleExponent),
			offset: samples.mean - timesPowerOfTwo(samples.scale * (fit.cosine * fit.meanCosine + fit.sine * fit.meanSine), samples.scaleExponent),
			epoch: firstTime + ((phase < 0 ? phase + TAU : phase) / TAU) * period,
			conditioning: fit.conditioning,
			window: fit.window,
			flags,
		})
	}

	peaks.sort((a, b) => b.standardPower - a.standardPower || a.index - b.index)

	// A signal at f0 leaks to every f with a high window power at f - f0 (side lobes and sampling aliases
	// such as ±1 cycle per day) or at f + f0 (aliases reflected about a sampling frequency).
	for (let j = 1; j < peaks.length; j++) {
		const fj = peaks[j].frequency

		for (let i = 0; i < j; i++) {
			const fi = peaks[i].frequency

			if (windowPower(samples, Math.abs(fj - fi)) >= aliasWindowPower || windowPower(samples, fj + fi) >= aliasWindowPower) {
				peaks[j] = { ...peaks[j], aliasOf: i, flags: [...peaks[j].flags, 'alias'] }
				break
			}
		}
	}

	return peaks
}

// Converts a standard power to the requested normalization.
function normalizePower(power: number, normalization: LombScargleNormalization, referenceChiSquare: number) {
	switch (normalization) {
		case 'standard':
			return power
		case 'model':
			return power / (1 - power)
		case 'log':
			return -Math.log1p(-power)
		case 'psd':
			return 0.5 * referenceChiSquare * power
	}
}

// Weighted variance of the sample times, time unit squared.
function weightedTimeVariance(samples: WeightedSamples) {
	const { t, w, count } = samples
	let mean = 0
	for (let i = 0; i < count; i++) mean += w[i] * t[i]
	let variance = 0
	for (let i = 0; i < count; i++) variance += w[i] * (t[i] - mean) * (t[i] - mean)
	return variance
}

// (1 - z)^exponent for z in [0, 1], accurate for small z; 0^0 is 1.
function powOneMinus(z: number, exponent: number) {
	if (z >= 1) return exponent === 0 ? 1 : 0
	return Math.exp(exponent * Math.log1p(-z))
}

// Baluev (2008) false-alarm probability of a standard power z of n samples over a band of width bandwidth
// times the effective baseline sqrt(4π Var(t)): 1 - (1 - (1 - z)^((n - 3) / 2)) exp(-τ), with the Davies
// bound τ = γ(n - 1) W (1 - z)^((n - 4) / 2) sqrt((n - 1) z / 2) and
// γ(N) = sqrt(2 / N) Γ(N / 2) / Γ((N - 1) / 2).
function baluevFalseAlarmProbability(z: number, n: number, bandwidth: number) {
	const nh = n - 1
	const nk = n - 3
	const gamma = Math.sqrt(2 / nh) * Math.exp(logGamma(0.5 * nh) - logGamma(0.5 * (nh - 1)))
	const single = powOneMinus(z, 0.5 * nk)
	const tau = gamma * bandwidth * powOneMinus(z, 0.5 * (nk - 1)) * Math.sqrt(0.5 * nh * z)
	const probability = -Math.expm1(-tau) + single * Math.exp(-tau)
	return clamp(probability, 0, 1)
}

// Draws the bootstrap resamples of the (value, error) pairs at the original times and returns the
// false-alarm probability of a standard power: the fraction of resamples whose refined highest peak over
// the grid is at least as high.
function bootstrapFalseAlarmProbability(usable: UsableSamples, frequency: Float64Array, bootstrapSamples: number, random: Random, c: Float64Array, s: Float64Array, fit: FrequencyFit) {
	const { t, count } = usable
	const value = new Float64Array(count)
	const error = new Float64Array(count)
	const power = new Float64Array(frequency.length)
	const maxima = new Float64Array(bootstrapSamples)

	for (let b = 0; b < bootstrapSamples; b++) {
		for (let i = 0; i < count; i++) {
			const k = Math.min(count - 1, Math.floor(random() * count))
			value[i] = usable.value[k]
			error[i] = usable.error[k]
		}

		const samples = weightedSamples(t, value, error)
		if (samples.variance === 0) continue

		let best = 0

		for (let i = 0; i < frequency.length; i++) {
			fitFrequency(samples, frequency[i], c, s, fit)
			power[i] = fit.power
			if (power[i] > power[best]) best = i
		}

		refinePeak(samples, frequency, power, best, c, s, fit)
		maxima[b] = fit.power
	}

	return (z: number) => {
		let exceeding = 0
		for (let b = 0; b < bootstrapSamples; b++) if (maxima[b] >= z) exceeding++
		return exceeding / bootstrapSamples
	}
}
