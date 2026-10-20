import { validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import type { NumberArray } from './math'

// Weighted Box Least Squares (BLS) search for periodic transits and eclipses (Kovács, Zucker & Mazeh
// 2002, A&A 391, 369; binned like Astropy's BoxLeastSquares). The light curve is modeled by two levels,
// a constant out-of-transit flux and a lower in-transit flux inside a box of one trial duration
// repeating with one trial period; both levels are inverse-variance weighted means, so the box with
// the largest improvement in chi-square over a constant level is the best fit. For every trial period
// the samples are folded into phase bins of minDuration / oversample, every trial duration is rounded
// to a whole number of bins and every bin edge is tried as the box start, which makes the search
// O(periods * (samples + bins * durations)); the ranked candidates are then re-measured exactly from the
// samples with diagnostics against eclipsing binaries, aliases and sparse sampling. Times may be in any
// uniform unit and timescale (for example BJD_TDB days); periods, durations and epochs are in that same
// unit, and fluxes are in any linear unit. BLS is a detector, not a physical transit model. Pure
// function: inputs are never mutated; the work arrays are typed arrays allocated per call, sized by the
// sample count and by the phase bins of the longest period, both bounded before allocation.

// Default phase bins per shortest trial duration (Astropy's default).
const DEFAULT_OVERSAMPLE = 10

// Default minimum number of distinct transit events with in-transit samples.
const DEFAULT_MIN_TRANSITS = 2

// Default minimum number of in-transit samples of a box.
const DEFAULT_MIN_IN_TRANSIT_POINTS = 3

// Default number of reported candidates.
const DEFAULT_MAX_CANDIDATES = 5

// Default significance, in standard deviations, of the odd/even, secondary eclipse and single-event flags.
const DEFAULT_DIAGNOSTIC_SIGMA = 3

// Default bound on the estimated search work, in inner-loop operations (several seconds of single-threaded
// work on a desktop CPU).
const DEFAULT_MAX_OPERATIONS = 5e8

// Largest number of phase bins of one trial period; bounds the five work arrays to about 150 MB.
const MAX_PHASE_BINS = 1 << 22

// Largest numerator or denominator of the period ratios tested when marking a candidate as an alias.
const MAX_ALIAS_ORDER = 3

// Outcome of the search.
// 'ok': at least one candidate passed the constraints.
// 'noCandidate': the search ran, but no box with a positive depth satisfied minTransits and
// minInTransitPoints (for example a constant light curve).
// 'insufficientData': too few usable samples for a box with minInTransitPoints samples and at least one
// out-of-transit sample, a zero baseline, or a default period range that cannot hold minTransits events;
// the search did not run and there is no periodogram.
export type BoxLeastSquaresStatus = 'ok' | 'noCandidate' | 'insufficientData'

// Diagnostic flags of a candidate. None of them rejects it.
// 'oddEvenMismatch': odd and even events differ in depth by more than diagnosticSigma, typical of an
// eclipsing binary with unequal eclipses found at half its period.
// 'secondaryEclipse': a dip deeper than diagnosticSigma at phase 0.5, typical of an eclipsing binary.
// 'halfPeriodAlias': the box folded at half the period through the same epoch is at least as
// significant, so the period may be twice the true one.
// 'doublePeriodAlias': a box at twice the period on only the odd or only the even events is more
// significant, so the period may be half the true one.
// 'singleEventDominated': without its most significant event the depth is below diagnosticSigma (or
// there is a single event), so one event, possibly an outlier or a systematic, carries the detection.
export type BoxLeastSquaresFlag = 'oddEvenMismatch' | 'secondaryEclipse' | 'halfPeriodAlias' | 'doublePeriodAlias' | 'singleEventDominated'

// Options of boxLeastSquares. Periods, durations and times share the unit of the input times.
export interface BoxLeastSquaresOptions {
	// Trial box durations, positive, at most half the shortest trial period; at least one. Each is rounded to
	// a whole number of phase bins of min(durations) / oversample.
	readonly durations: Readonly<NumberArray>
	// Explicit trial periods, positive, at least one, in any order (sorted ascending in the periodogram).
	// When omitted, a grid uniform in frequency is built from minPeriod to maxPeriod with the step
	// frequencyFactor * min(durations) / baseline^2, fine enough that the phase drift across the baseline
	// between neighbors is a fraction of the shortest duration.
	readonly periods?: Readonly<NumberArray>
	// Shortest period of the default grid, positive. Defaults to twice the longest duration.
	readonly minPeriod?: number
	// Longest period of the default grid, positive. Defaults to baseline / (minTransits - 1), the longest
	// period with minTransits events inside the baseline, or the baseline when minTransits is 1.
	readonly maxPeriod?: number
	// Frequency step factor of the default grid, positive; smaller is finer. Defaults to 1.
	readonly frequencyFactor?: number
	// Phase bins per shortest duration, a positive integer; larger resolves epochs and durations more
	// finely at a proportional cost. Defaults to 10.
	readonly oversample?: number
	// Minimum number of distinct transit events with in-transit samples, a positive integer. A box whose
	// samples come from fewer events is skipped in the periodogram (only the 1-versus-2 distinction is
	// enforced there) and a candidate with fewer events is rejected. Defaults to 2.
	readonly minTransits?: number
	// Minimum number of in-transit samples of a box, a positive integer. Defaults to 3.
	readonly minInTransitPoints?: number
	// Maximum number of reported candidates, a positive integer. Defaults to 5.
	readonly maxCandidates?: number
	// Threshold, in standard deviations, of the oddEvenMismatch, secondaryEclipse and singleEventDominated
	// flags. Defaults to 3.
	readonly diagnosticSigma?: number
	// Bound on the estimated work, sum over periods of samples + (phase bins) * (durations + 1). A grid
	// above it, or a period with more than 2^22 phase bins, throws a RangeError before any allocation
	// instead of running for an unbounded time. Defaults to 5e8.
	readonly maxOperations?: number
}

// Best box of each trial period, binned. Every array has one entry per period; a period without a box
// satisfying minInTransitPoints, a positive depth and (for minTransits >= 2) two events has power and
// snr 0 and NaN depth, duration and epoch.
export interface BoxLeastSquaresPeriodogram {
	// Trial periods, ascending, time unit.
	readonly periods: Float64Array
	// Improvement in log-likelihood over a constant level, snr^2 / 2, dimensionless; the objective.
	readonly power: Float64Array
	// Depth over its one-sigma uncertainty.
	readonly snr: Float64Array
	// Out-of-transit minus in-transit level, flux unit, positive for a dip.
	readonly depth: Float64Array
	// Box duration, a whole number of phase bins, time unit.
	readonly duration: Float64Array
	// Mid-transit time of the box, in [firstTime, firstTime + period), time unit.
	readonly epoch: Float64Array
}

// One transit event of a candidate that contains in-transit samples.
export interface BoxLeastSquaresEvent {
	// Event number counted from the candidate epoch (0); -1 for an event straddling the first sample.
	readonly index: number
	// Mid-transit time, epoch + index * period, time unit.
	readonly time: number
	// In-transit samples of this event.
	readonly sampleCount: number
	// Out-of-transit level minus the weighted mean of this event, flux unit, and its one-sigma uncertainty.
	readonly depth: number
	readonly depthError: number
	// depth / depthError.
	readonly snr: number
}

// A ranked candidate, measured exactly from the samples with in-transit membership
// epoch - duration / 2 <= time < epoch + duration / 2 modulo the period.
export interface BoxLeastSquaresCandidate {
	// Period, mid-transit time of a reference event in [firstTime, firstTime + period) and box
	// duration, time unit.
	readonly period: number
	readonly epoch: number
	readonly duration: number
	// Out-of-transit minus in-transit level, flux unit, positive, and its one-sigma uncertainty
	// sqrt(1 / sumWeightsIn + 1 / sumWeightsOut) from the flux errors.
	readonly depth: number
	readonly depthError: number
	// depth / depthError.
	readonly snr: number
	// Improvement in log-likelihood (half the chi-square improvement) over a constant level, snr^2 / 2.
	readonly power: number
	// Signal detection efficiency (snr - mean) / standard deviation of the periodogram snr over the
	// periods with a box, at the candidate's periodogram peak; undefined with fewer than 2 such periods
	// or no spread. Compare it between searches of similar grids, not as a false-alarm probability.
	readonly sde?: number
	// Weighted mean in-transit and out-of-transit levels, flux unit.
	readonly inTransitLevel: number
	readonly outOfTransitLevel: number
	// In-transit samples.
	readonly inTransitCount: number
	// Events with in-transit samples, and events whose window overlaps the time span of the samples.
	readonly transitCount: number
	readonly expectedTransitCount: number
	// Fraction of the search phase bins (min(durations) / oversample wide) inside the box holding at least
	// one sample, in (0, 1];
	// low when only part of the transit (for example the ingress) was observed.
	readonly coverage: number
	// Depth of the even-numbered (index 0, 2, ...) and odd-numbered events against the common
	// out-of-transit level, with one-sigma uncertainties; undefined without samples of that parity.
	readonly evenDepth?: number
	readonly evenDepthError?: number
	readonly oddDepth?: number
	readonly oddDepthError?: number
	// |evenDepth - oddDepth| over its one-sigma uncertainty; undefined without both parities.
	readonly oddEvenSigma?: number
	// Depth of a box of the same duration at phase 0.5 against the remaining out-of-transit samples, and its
	// uncertainty; undefined without samples there. Negative when that phase is brighter.
	readonly secondaryDepth?: number
	readonly secondaryDepthError?: number
	// Signed snr of the box folded at period / 2 through the same epoch (in-transit samples plus phase 0.5);
	// undefined when that box has no in-transit or no out-of-transit sample.
	readonly halfPeriodSnr?: number
	// Larger signed snr of the boxes at 2 * period through the even or the odd events; undefined when no
	// such box has out-of-transit samples.
	readonly doublePeriodSnr?: number
	// snr of the box without its most significant event, against the same out-of-transit level;
	// undefined with a single event.
	readonly snrWithoutStrongestEvent?: number
	// Events with in-transit samples, by increasing index.
	readonly events: readonly BoxLeastSquaresEvent[]
	// Index in candidates of a stronger candidate whose period times aliasRatio (a ratio of integers up
	// to 3, such as 1/2, 2 or 2/3) equals this period within the peak width; undefined otherwise.
	readonly aliasOf?: number
	readonly aliasRatio?: number
	// Diagnostic flags, empty for a clean candidate.
	readonly flags: readonly BoxLeastSquaresFlag[]
}

// Result of boxLeastSquares.
export interface BoxLeastSquaresResult {
	// Outcome of the search.
	readonly status: BoxLeastSquaresStatus
	// Usable samples: finite time and flux and a finite positive flux error.
	readonly sampleCount: number
	// Samples skipped as unusable.
	readonly rejectedSampleCount: number
	// Time span of the usable samples, time unit; 0 without usable samples.
	readonly baseline: number
	// Best box per trial period; undefined for 'insufficientData'.
	readonly periodogram?: BoxLeastSquaresPeriodogram
	// Candidates by decreasing power, at most maxCandidates, each a distinct periodogram peak: a period
	// whose phase drifts from a stronger examined peak by less than that peak's duration across the
	// baseline belongs to it.
	readonly candidates: readonly BoxLeastSquaresCandidate[]
	// Periodogram peaks examined and rejected for fewer than minTransits events or minInTransitPoints
	// samples, or a non-positive exact depth.
	readonly rejectedCandidateCount: number
}

// Usable samples relative to the first time, with the flux centered on its weighted mean.
interface BoxLeastSquaresSamples {
	// Times minus firstTime, time unit, non-negative.
	readonly t: Float64Array
	// Flux minus the weighted mean flux, flux unit.
	readonly y: Float64Array
	// Inverse-variance weights.
	readonly w: Float64Array
	// Number of usable samples.
	readonly count: number
	// Earliest usable time, time unit.
	readonly firstTime: number
	// Weighted mean flux, flux unit.
	readonly mean: number
	// Time span of the usable samples, time unit.
	readonly baseline: number
	// Sum of the weights.
	readonly sumW: number
	// Sum of weight * centered flux (zero up to rounding).
	readonly sumWY: number
}

// Candidate measurement before ranking and alias marking.
type MeasuredCandidate = Omit<BoxLeastSquaresCandidate, 'sde' | 'aliasOf' | 'aliasRatio'>

// Searches a light curve for periodic box-shaped dips with weighted Box Least Squares and returns the
// periodogram and the ranked candidates with their diagnostics. time, flux and fluxError have one
// entry per sample (fluxError may be a single error for every sample), in any order; a sample with a
// non-finite time or flux, or a non-finite or non-positive error, is skipped, so a missing value may
// be NaN. Times are in one uniform unit and timescale; a large offset such as a Julian Date is removed
// internally before folding. Only dips (positive depth) are detected. Throws a TypeError or RangeError
// when an option is out of its documented domain, and a RangeError when the array lengths differ, when
// a duration exceeds half the shortest period, when an explicit minPeriod exceeds maxPeriod, or when the
// grid exceeds maxOperations or the phase bins of one period exceed 2^22.
export function boxLeastSquares(time: Readonly<NumberArray>, flux: Readonly<NumberArray>, fluxError: Readonly<NumberArray> | number, options: BoxLeastSquaresOptions): BoxLeastSquaresResult {
	const n = time.length

	// Mismatched arrays would silently pair a time with another sample's flux.
	if (flux.length !== n || (typeof fluxError !== 'number' && fluxError.length !== n)) throw new RangeError('time, flux and fluxError must have equal lengths')

	const { durations } = options
	const oversample = validatePositiveInteger(options.oversample ?? DEFAULT_OVERSAMPLE)
	const minTransits = validatePositiveInteger(options.minTransits ?? DEFAULT_MIN_TRANSITS)
	const minInTransitPoints = validatePositiveInteger(options.minInTransitPoints ?? DEFAULT_MIN_IN_TRANSIT_POINTS)
	const maxCandidates = validatePositiveInteger(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
	const diagnosticSigma = options.diagnosticSigma ?? DEFAULT_DIAGNOSTIC_SIGMA
	const maxOperations = validatePositiveFinite(options.maxOperations ?? DEFAULT_MAX_OPERATIONS)

	// An empty or non-positive duration list leaves no box to fit and no phase-bin width.
	if (durations.length === 0) throw new RangeError('durations must not be empty')

	let minDuration = Infinity
	let maxDuration = 0

	for (let i = 0; i < durations.length; i++) {
		const duration = validatePositiveFinite(durations[i])
		if (duration < minDuration) minDuration = duration
		if (duration > maxDuration) maxDuration = duration
	}

	const samples = usableSamples(time, flux, fluxError)
	const rejectedSampleCount = n - samples.count
	const insufficient = { status: 'insufficientData', sampleCount: samples.count, rejectedSampleCount, baseline: samples.baseline, candidates: [], rejectedCandidateCount: 0 } as const

	let periods: Float64Array | undefined
	let minPeriod: number
	let maxPeriod: number | undefined
	let frequencyFactor = 1

	if (options.periods !== undefined) {
		// An empty grid has no period to search and no shortest period to bound the durations.
		if (options.periods.length === 0) throw new RangeError('periods must not be empty')

		periods = new Float64Array(options.periods.length)
		for (let i = 0; i < periods.length; i++) periods[i] = validatePositiveFinite(options.periods[i])
		periods.sort()
		minPeriod = periods[0]
	} else {
		minPeriod = options.minPeriod === undefined ? 2 * maxDuration : validatePositiveFinite(options.minPeriod)
		maxPeriod = options.maxPeriod === undefined ? undefined : validatePositiveFinite(options.maxPeriod)
		frequencyFactor = validatePositiveFinite(options.frequencyFactor ?? 1)

		// Swapped explicit bounds would silently search an empty or unintended range.
		if (maxPeriod !== undefined && !(minPeriod <= maxPeriod)) throw new RangeError('minPeriod must not exceed maxPeriod')
	}

	// A box longer than half the period would leave the dip as the majority state and overlap its own
	// phase 0.5 diagnostics; the pad of the folded bins also relies on it.
	if (2 * maxDuration > minPeriod) throw new RangeError('durations must not exceed half the shortest period')
	if (!(samples.baseline > 0) || samples.count <= minInTransitPoints) return insufficient

	if (periods === undefined) {
		const longest = maxPeriod ?? (minTransits > 1 ? samples.baseline / (minTransits - 1) : samples.baseline)
		if (!(longest >= minPeriod)) return insufficient
		periods = frequencyGrid(minPeriod, longest, (frequencyFactor * minDuration) / (samples.baseline * samples.baseline), samples.count, maxOperations)
	}

	const binWidth = minDuration / oversample
	const durationBins = uniqueDurationBins(durations, binWidth)
	const maxDurationBins = durationBins.at(-1)!

	let operations = 0
	let maxBins = 0

	for (let p = 0; p < periods.length; p++) {
		const bins = Math.ceil(periods[p] / binWidth)
		if (bins > maxBins) maxBins = bins
		operations += samples.count + (bins + maxDurationBins) * (durationBins.length + 1)
	}

	// Bounds the run time and the work arrays before allocating them.
	if (!(operations <= maxOperations)) throw new RangeError(`the search needs about ${operations.toExponential(2)} operations, more than maxOperations`)
	if (maxBins > MAX_PHASE_BINS) throw new RangeError('the longest period has too many phase bins; raise the shortest duration or lower oversample')

	const { periodogram, phases } = searchPeriods(samples, periods, binWidth, durationBins, minInTransitPoints, minTransits > 1)
	const { candidates, rejectedCandidateCount } = rankCandidates(samples, periodogram, phases, binWidth, minTransits, minInTransitPoints, maxCandidates, diagnosticSigma)

	return { status: candidates.length > 0 ? 'ok' : 'noCandidate', sampleCount: samples.count, rejectedSampleCount, baseline: samples.baseline, periodogram, candidates, rejectedCandidateCount }
}

// Collects the usable samples relative to the earliest time, with inverse-variance weights and the flux
// centered on its weighted mean so that the binned sums do not cancel.
function usableSamples(time: Readonly<NumberArray>, flux: Readonly<NumberArray>, fluxError: Readonly<NumberArray> | number): BoxLeastSquaresSamples {
	const n = time.length
	const t = new Float64Array(n)
	const y = new Float64Array(n)
	const w = new Float64Array(n)
	let count = 0
	let firstTime = Infinity
	let lastTime = -Infinity
	let sumW = 0
	let sumWY = 0

	for (let i = 0; i < n; i++) {
		const ti = time[i]
		const yi = flux[i]
		const error = typeof fluxError === 'number' ? fluxError : fluxError[i]

		if (!Number.isFinite(ti) || !Number.isFinite(yi) || !Number.isFinite(error) || !(error > 0)) continue

		const wi = 1 / (error * error)
		t[count] = ti
		y[count] = yi
		w[count] = wi
		count++
		if (ti < firstTime) firstTime = ti
		if (ti > lastTime) lastTime = ti
		sumW += wi
		sumWY += wi * yi
	}

	if (count === 0) return { t, y, w, count, firstTime: 0, mean: 0, baseline: 0, sumW: 0, sumWY: 0 }

	const mean = sumWY / sumW
	sumWY = 0

	for (let i = 0; i < count; i++) {
		t[i] -= firstTime
		y[i] -= mean
		sumWY += w[i] * y[i]
	}

	return { t: t.subarray(0, count), y: y.subarray(0, count), w: w.subarray(0, count), count, firstTime, mean, baseline: lastTime - firstTime, sumW, sumWY }
}

// Builds periods ascending from minPeriod to maxPeriod, uniform in frequency with step frequencyStep
// (Astropy's autoperiod rule). Throws before allocating when the grid alone would exceed the budget.
function frequencyGrid(minPeriod: number, maxPeriod: number, frequencyStep: number, sampleCount: number, maxOperations: number) {
	const minFrequency = 1 / maxPeriod
	const maxFrequency = 1 / minPeriod
	const count = 1 + Math.round((maxFrequency - minFrequency) / frequencyStep)

	// Each period costs at least one pass over the samples; a huge count must not reach the allocation.
	if (!(count * sampleCount <= maxOperations)) throw new RangeError(`the period grid has ${count.toExponential(2)} periods, more than maxOperations allows`)

	const periods = new Float64Array(count)
	for (let i = 0; i < count; i++) periods[i] = 1 / (maxFrequency - frequencyStep * i)
	return periods
}

// Rounds every duration to a whole number of phase bins, at least 1, and returns the distinct counts ascending.
function uniqueDurationBins(durations: Readonly<NumberArray>, binWidth: number) {
	const bins = new Set<number>()
	for (let i = 0; i < durations.length; i++) bins.add(Math.max(1, Math.round(durations[i] / binWidth)))
	return Int32Array.from(bins).sort()
}

// Phase-binned sums of one trial period, as 1-based prefix sums after foldSamples. Allocated once per
// search for the longest period and overwritten for every period.
interface PhaseBins {
	// Prefix sums of weight * centered flux, of weight and of sample count.
	readonly sumY: Float64Array
	readonly sumWeight: Float64Array
	readonly sampleCount: Int32Array
	// Smallest and largest event number of the samples of each bin (not prefix sums); +-Infinity when empty.
	readonly firstEvent: Float64Array
	readonly lastEvent: Float64Array
}

// Folds the samples at every trial period into phase bins and finds the box of each duration and start
// bin with the largest log-likelihood improvement. Also returns the mid-transit phases relative to
// firstTime, which keep the precision a large time offset would remove.
function searchPeriods(samples: BoxLeastSquaresSamples, periods: Float64Array, binWidth: number, durationBins: Int32Array, minInTransitPoints: number, needTwoEvents: boolean) {
	const { count, sumW, sumWY, firstTime } = samples
	const pad = durationBins.at(-1)!
	const capacity = Math.ceil(periods.at(-1)! / binWidth) + pad + 1
	const workspace: PhaseBins = { sumY: new Float64Array(capacity), sumWeight: new Float64Array(capacity), sampleCount: new Int32Array(capacity), firstEvent: new Float64Array(capacity), lastEvent: new Float64Array(capacity) }
	const { sumY, sumWeight, sampleCount, firstEvent, lastEvent } = workspace
	const wy = new Float64Array(count)
	for (let i = 0; i < count; i++) wy[i] = samples.w[i] * samples.y[i]

	const power = new Float64Array(periods.length)
	const snr = new Float64Array(periods.length)
	const depth = new Float64Array(periods.length).fill(Number.NaN)
	const duration = new Float64Array(periods.length).fill(Number.NaN)
	const epoch = new Float64Array(periods.length).fill(Number.NaN)
	const phases = new Float64Array(periods.length).fill(Number.NaN)

	for (let p = 0; p < periods.length; p++) {
		const period = periods[p]
		const bins = Math.ceil(period / binWidth)
		foldSamples(samples.t, samples.w, wy, period, bins, binWidth, pad, workspace)

		let best = 0
		let bestDepth = Number.NaN
		let bestStart = 0
		let bestBins = 0

		for (let d = 0; d < durationBins.length; d++) {
			const k = durationBins[d]

			for (let start = 0; start < bins; start++) {
				const inCount = sampleCount[start + k] - sampleCount[start]
				if (inCount < minInTransitPoints || inCount >= count) continue

				const wIn = sumWeight[start + k] - sumWeight[start]
				const yIn = sumY[start + k] - sumY[start]
				const wOut = sumW - wIn
				const boxDepth = (sumWY - yIn) / wOut - yIn / wIn
				if (!(boxDepth > 0)) continue

				const boxPower = (0.5 * boxDepth * boxDepth * wIn * wOut) / sumW

				if (boxPower > best && (!needTwoEvents || spansTwoEvents(firstEvent, lastEvent, start, k))) {
					best = boxPower
					bestDepth = boxDepth
					bestStart = start
					bestBins = k
				}
			}
		}

		if (best > 0) {
			let mid = (bestStart + 0.5 * bestBins) * binWidth
			if (mid >= period) mid -= period
			power[p] = best
			snr[p] = Math.sqrt(2 * best)
			depth[p] = bestDepth
			duration[p] = bestBins * binWidth
			epoch[p] = firstTime + mid
			phases[p] = mid
		}
	}

	const periodogram: BoxLeastSquaresPeriodogram = { periods, power, snr, depth, duration, epoch }
	return { periodogram, phases }
}

// Accumulates the samples folded at period into bins phase bins of binWidth (the last one possibly
// narrower) and converts the sums to 1-based prefix sums. The first pad bins are repeated after the last
// one, with their event numbers lowered by one, so a box can straddle phase 0 and still count the samples
// of one event as one event; pad must not exceed bins.
function foldSamples(t: Float64Array, w: Float64Array, wy: Float64Array, period: number, bins: number, binWidth: number, pad: number, workspace: PhaseBins) {
	const { sumY, sumWeight, sampleCount, firstEvent, lastEvent } = workspace
	const size = bins + pad

	sumY.fill(0, 0, size + 1)
	sumWeight.fill(0, 0, size + 1)
	sampleCount.fill(0, 0, size + 1)
	firstEvent.fill(Infinity, 0, size + 1)
	lastEvent.fill(-Infinity, 0, size + 1)

	for (let i = 0; i < t.length; i++) {
		let event = Math.floor(t[i] / period)
		let phase = t[i] - event * period

		if (phase >= period) {
			phase -= period
			event++
		}

		const bin = Math.min(Math.floor(phase / binWidth), bins - 1) + 1
		sumY[bin] += wy[i]
		sumWeight[bin] += w[i]
		sampleCount[bin]++
		if (event < firstEvent[bin]) firstEvent[bin] = event
		if (event > lastEvent[bin]) lastEvent[bin] = event
	}

	for (let m = 1; m <= pad; m++) {
		const j = bins + m
		sumY[j] = sumY[m]
		sumWeight[j] = sumWeight[m]
		sampleCount[j] = sampleCount[m]
		firstEvent[j] = firstEvent[m] - 1
		lastEvent[j] = lastEvent[m] - 1
	}

	for (let j = 1; j <= size; j++) {
		sumY[j] += sumY[j - 1]
		sumWeight[j] += sumWeight[j - 1]
		sampleCount[j] += sampleCount[j - 1]
	}
}

// Whether the bins start + 1 .. start + k hold samples of at least two distinct events.
function spansTwoEvents(firstEvent: Float64Array, lastEvent: Float64Array, start: number, k: number) {
	let first = Infinity
	let last = -Infinity

	for (let j = start + 1; j <= start + k; j++) {
		if (firstEvent[j] < first) first = firstEvent[j]
		if (lastEvent[j] > last) last = lastEvent[j]
	}

	return last > first
}

// Picks the periodogram peaks by decreasing power, measures each exactly, rejects those failing the
// event and sample constraints, merges weaker peaks within the width of an examined one, and marks
// period aliases. phases are the mid-transit phases relative to firstTime.
function rankCandidates(samples: BoxLeastSquaresSamples, periodogram: BoxLeastSquaresPeriodogram, phases: Float64Array, binWidth: number, minTransits: number, minInTransitPoints: number, maxCandidates: number, diagnosticSigma: number) {
	const { periods, power, snr, duration } = periodogram
	const peaks: number[] = []
	let valid = 0
	let sum = 0
	let sumSquares = 0

	for (let p = 0; p < periods.length; p++) {
		if (!(power[p] > 0)) continue

		valid++
		sum += snr[p]
		sumSquares += snr[p] * snr[p]

		const left = p === 0 ? 0 : power[p - 1]
		const right = p === periods.length - 1 ? 0 : power[p + 1]
		if (power[p] > left && power[p] >= right) peaks.push(p)
	}

	peaks.sort((a, b) => power[b] - power[a] || a - b)

	const snrMean = valid > 0 ? sum / valid : 0
	const snrDeviation = valid > 1 ? Math.sqrt(Math.max(0, (sumSquares - valid * snrMean * snrMean) / (valid - 1))) : 0
	// Periods inside the width of an examined peak; each period is claimed once, so merging is linear.
	const claimed = new Uint8Array(periods.length)
	const accepted: { candidate: MeasuredCandidate; sde?: number }[] = []
	let rejectedCandidateCount = 0

	for (let i = 0; i < peaks.length && accepted.length < maxCandidates; i++) {
		const p = peaks[i]
		if (claimed[p]) continue

		const period = periods[p]
		const boxDuration = duration[p]
		claimed[p] = 1
		for (let q = p - 1; q >= 0 && !claimed[q] && samePeak(period, periods[q], boxDuration, samples.baseline); q--) claimed[q] = 1
		for (let q = p + 1; q < periods.length && !claimed[q] && samePeak(period, periods[q], boxDuration, samples.baseline); q++) claimed[q] = 1

		const candidate = measureCandidate(samples, period, phases[p], boxDuration, binWidth, diagnosticSigma)

		if (candidate === undefined || candidate.transitCount < minTransits || candidate.inTransitCount < minInTransitPoints) {
			rejectedCandidateCount++
			continue
		}

		accepted.push({ candidate, sde: snrDeviation > 0 ? (snr[p] - snrMean) / snrDeviation : undefined })
	}

	accepted.sort((a, b) => b.candidate.power - a.candidate.power || a.candidate.period - b.candidate.period)

	const candidates: BoxLeastSquaresCandidate[] = []

	for (const { candidate, sde } of accepted) {
		let aliasOf: number | undefined
		let aliasRatio: number | undefined

		for (let j = 0; j < candidates.length && aliasOf === undefined; j++) {
			const ratio = aliasRatioOf(candidates[j].period, candidate.period, Math.max(candidates[j].duration, candidate.duration), samples.baseline)

			if (ratio !== undefined) {
				aliasOf = j
				aliasRatio = ratio
			}
		}

		candidates.push({ ...candidate, sde, aliasOf, aliasRatio })
	}

	return { candidates, rejectedCandidateCount }
}

// Whether two periods belong to the same periodogram peak: their phase drift across the baseline,
// |a - b| * baseline / max(a, b), is shorter than the duration.
function samePeak(a: number, b: number, duration: number, baseline: number) {
	return Math.abs(a - b) * baseline < duration * Math.max(a, b)
}

// Returns q / r when period = (q / r) * reference for coprime integers q, r <= MAX_ALIAS_ORDER, other
// than 1, within the peak width of period; undefined otherwise.
function aliasRatioOf(reference: number, period: number, duration: number, baseline: number) {
	for (let r = 1; r <= MAX_ALIAS_ORDER; r++) {
		for (let q = 1; q <= MAX_ALIAS_ORDER; q++) {
			if (q === r || greatestCommonDivisor(q, r) !== 1) continue
			if (samePeak((reference * q) / r, period, duration, baseline)) return q / r
		}
	}

	return undefined
}

// Greatest common divisor of two positive integers.
function greatestCommonDivisor(a: number, b: number) {
	while (b !== 0) [a, b] = [b, a % b]
	return a
}

// Signed snr of the two-level box with in-transit sums (wIn, yIn) and out-of-transit sums (wOut, yOut),
// using centered fluxes; undefined when either side is empty.
function boxSnr(wIn: number, yIn: number, wOut: number, yOut: number) {
	if (!(wIn > 0) || !(wOut > 0)) return undefined
	return (yOut / wOut - yIn / wIn) / Math.sqrt(1 / wIn + 1 / wOut)
}

// In-transit sums of one event.
interface EventSums {
	w: number
	y: number
	n: number
}

// Measures the box of period, relative epoch (from firstTime) and duration exactly from the samples, with
// its diagnostics. Returns undefined when the box has no in-transit or no out-of-transit sample, or a
// non-positive depth.
function measureCandidate(samples: BoxLeastSquaresSamples, period: number, epoch: number, duration: number, binWidth: number, diagnosticSigma: number): MeasuredCandidate | undefined {
	const { t, y, w, count, sumW, sumWY, mean, firstTime, baseline } = samples
	const start = epoch - 0.5 * duration
	const half = 0.5 * period
	const coverageBins = Math.max(1, Math.round(duration / binWidth))
	const covered = new Uint8Array(coverageBins)
	const events = new Map<number, EventSums>()
	let wIn = 0
	let yIn = 0
	let inCount = 0
	let wSecondary = 0
	let ySecondary = 0
	let secondaryCount = 0
	const wParity = [0, 0]
	const yParity = [0, 0]

	for (let i = 0; i < count; i++) {
		const r = t[i] - start
		let event = Math.floor(r / period)
		let phase = r - event * period

		if (phase >= period) {
			phase -= period
			event++
		} else if (phase < 0) {
			phase += period
			event--
		}

		if (phase < duration) {
			const parity = ((event % 2) + 2) % 2
			wIn += w[i]
			yIn += w[i] * y[i]
			inCount++
			wParity[parity] += w[i]
			yParity[parity] += w[i] * y[i]
			covered[Math.min(Math.floor(phase / binWidth), coverageBins - 1)] = 1

			const sums = events.get(event)

			if (sums === undefined) {
				events.set(event, { w: w[i], y: w[i] * y[i], n: 1 })
			} else {
				sums.w += w[i]
				sums.y += w[i] * y[i]
				sums.n++
			}
		} else if (phase >= half && phase < half + duration) {
			wSecondary += w[i]
			ySecondary += w[i] * y[i]
			secondaryCount++
		}
	}

	if (inCount === 0 || inCount === count) return undefined

	const wOut = sumW - wIn
	const yOut = sumWY - yIn
	const outLevel = yOut / wOut
	const inLevel = yIn / wIn
	const depth = outLevel - inLevel

	if (!(depth > 0)) return undefined

	const depthError = Math.sqrt(1 / wIn + 1 / wOut)
	const snr = depth / depthError
	const flags: BoxLeastSquaresFlag[] = []

	let evenDepth: number | undefined
	let evenDepthError: number | undefined
	let oddDepth: number | undefined
	let oddDepthError: number | undefined
	let oddEvenSigma: number | undefined

	if (wParity[0] > 0) {
		evenDepth = outLevel - yParity[0] / wParity[0]
		evenDepthError = Math.sqrt(1 / wParity[0] + 1 / wOut)
	}

	if (wParity[1] > 0) {
		oddDepth = outLevel - yParity[1] / wParity[1]
		oddDepthError = Math.sqrt(1 / wParity[1] + 1 / wOut)
	}

	if (evenDepth !== undefined && oddDepth !== undefined) {
		// The common out-of-transit level cancels in the difference.
		oddEvenSigma = Math.abs(evenDepth - oddDepth) / Math.sqrt(1 / wParity[0] + 1 / wParity[1])
		if (oddEvenSigma > diagnosticSigma) flags.push('oddEvenMismatch')
	}

	let secondaryDepth: number | undefined
	let secondaryDepthError: number | undefined

	if (secondaryCount > 0 && inCount + secondaryCount < count) {
		const wRest = wOut - wSecondary
		secondaryDepth = (yOut - ySecondary) / wRest - ySecondary / wSecondary
		secondaryDepthError = Math.sqrt(1 / wSecondary + 1 / wRest)
		if (secondaryDepth > diagnosticSigma * secondaryDepthError) flags.push('secondaryEclipse')
	}

	const halfPeriodSnr = inCount + secondaryCount < count ? boxSnr(wIn + wSecondary, yIn + ySecondary, wOut - wSecondary, yOut - ySecondary) : undefined
	if (halfPeriodSnr !== undefined && halfPeriodSnr >= snr) flags.push('halfPeriodAlias')

	let doublePeriodSnr: number | undefined

	for (let parity = 0; parity < 2; parity++) {
		const value = boxSnr(wParity[parity], yParity[parity], sumW - wParity[parity], sumWY - yParity[parity])
		if (value !== undefined && (doublePeriodSnr === undefined || value > doublePeriodSnr)) doublePeriodSnr = value
	}

	if (doublePeriodSnr !== undefined && doublePeriodSnr > snr) flags.push('doublePeriodAlias')

	const indices = Array.from(events.keys()).sort((a, b) => a - b)
	const eventList: BoxLeastSquaresEvent[] = new Array(indices.length)
	let strongest: EventSums | undefined
	let strongestSnr = -Infinity

	for (let e = 0; e < indices.length; e++) {
		const index = indices[e]
		const sums = events.get(index)!
		const eventDepth = outLevel - sums.y / sums.w
		const eventDepthError = Math.sqrt(1 / sums.w + 1 / wOut)
		const eventSnr = eventDepth / eventDepthError
		eventList[e] = { index, time: firstTime + epoch + index * period, sampleCount: sums.n, depth: eventDepth, depthError: eventDepthError, snr: eventSnr }

		if (eventSnr > strongestSnr) {
			strongestSnr = eventSnr
			strongest = sums
		}
	}

	// The strongest event is dropped from the in-transit sums; the out-of-transit level stays the same.
	const snrWithoutStrongestEvent = indices.length > 1 ? boxSnr(wIn - strongest!.w, yIn - strongest!.y, wOut, yOut) : undefined
	if (snrWithoutStrongestEvent === undefined || snrWithoutStrongestEvent < diagnosticSigma) flags.push('singleEventDominated')

	let coveredBins = 0
	for (let j = 0; j < coverageBins; j++) coveredBins += covered[j]

	// Events whose window [start + c * period, start + c * period + duration) overlaps [0, baseline].
	const firstExpected = Math.floor((-start - duration) / period) + 1
	const lastExpected = Math.floor((baseline - start) / period)

	return {
		period,
		epoch: firstTime + epoch,
		duration,
		depth,
		depthError,
		snr,
		power: 0.5 * snr * snr,
		inTransitLevel: mean + inLevel,
		outOfTransitLevel: mean + outLevel,
		inTransitCount: inCount,
		transitCount: indices.length,
		expectedTransitCount: Math.max(0, lastExpected - firstExpected + 1),
		coverage: coveredBins / coverageBins,
		evenDepth,
		evenDepthError,
		oddDepth,
		oddDepthError,
		oddEvenSigma,
		secondaryDepth,
		secondaryDepthError,
		halfPeriodSnr,
		doublePeriodSnr,
		snrWithoutStrongestEvent,
		events: eventList,
		flags,
	}
}
