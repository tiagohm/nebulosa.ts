import { validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import type { NumberArray } from './math'

// Weighted Box Least Squares (BLS) search for periodic transits and eclipses (Kovács, Zucker & Mazeh
// 2002, A&A 391, 369; binned like Astropy's BoxLeastSquares). The light curve is modeled by two levels,
// a constant out-of-transit flux and a lower in-transit flux inside a box of one trial duration
// repeating with one trial period; both levels are inverse-variance weighted means, so the box with
// the largest improvement in chi-square over a constant level is the best fit. For every trial period
// the samples are folded into equal phase bins of period / ceil(period / (minDuration / oversample)),
// every trial duration is rounded to a whole number of those bins and every bin edge is tried as the box
// start; a box is eligible only with minInTransitPoints samples from minTransits distinct events, which
// sliding windows count exactly in time linear in the bins (and in the samples when minTransits >= 3).
// The ranked candidates are re-measured from the samples with the box the search scored, adding
// diagnostics against eclipsing binaries, aliases and sparse sampling. Weights are normalized by the
// smallest flux error and the phase-bin sums are compensated prefix sums whose in- and out-of-transit
// parts are both differences of prefixes, so weights spanning many orders of magnitude neither overflow
// nor cancel. Times may be in any uniform unit and timescale (for example BJD_TDB days); periods,
// durations and epochs are in that same unit, and fluxes are in any linear unit. BLS is a detector, not
// a physical transit model. Pure function: inputs are never mutated; the work arrays are typed arrays
// allocated per call, sized by the sample count and by the phase bins of the longest period, both
// bounded before allocation.

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

// Largest number of phase bins (with the wrap-around copies) of one trial period; bounds the work
// arrays to about 150 MB.
const MAX_PHASE_BINS = 1 << 21

// Estimated work per trial period of ranking the periodogram peaks (sorting and merging).
const RANKING_OPERATIONS_PER_PERIOD = 64

// Estimated work per sample of one exact candidate measurement.
const MEASUREMENT_OPERATIONS_PER_SAMPLE = 4

// Largest numerator or denominator of the period ratios tested when marking a candidate as an alias.
const MAX_ALIAS_ORDER = 3

// Outcome of the search.
// 'ok': at least one candidate was found.
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
	// Trial box durations, positive, at most half the shortest trial period; at least one. For each period
	// each is rounded to a whole number of its phase bins (at least one).
	readonly durations: Readonly<NumberArray>
	// Explicit trial periods, positive, at least one, in any order (sorted ascending in the periodogram).
	// When omitted, a grid uniform in frequency is built from minPeriod with the step
	// frequencyFactor * min(durations) / baseline^2, fine enough that the phase drift across the baseline
	// between neighbors is a fraction of the shortest duration, for as many steps as fit before maxPeriod;
	// every period lies in [minPeriod, maxPeriod], and a step wider than the range leaves minPeriod alone.
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
	// Minimum number of distinct transit events with in-transit samples of a box, a positive integer,
	// enforced exactly for every box of the search. Defaults to 2.
	readonly minTransits?: number
	// Minimum number of in-transit samples of a box, a positive integer. Defaults to 3.
	readonly minInTransitPoints?: number
	// Maximum number of reported candidates, a positive integer. Defaults to 5.
	readonly maxCandidates?: number
	// Threshold, in standard deviations, of the oddEvenMismatch, secondaryEclipse and singleEventDominated
	// flags. Defaults to 3.
	readonly diagnosticSigma?: number
	// Bound on the estimated work: per period, the folding, the box scan over (phase bins) * (durations + 2)
	// and the exact event counting, plus the ranking and the candidate measurements. A grid above it, or a
	// period with more than 2^21 phase bins, throws a RangeError before any allocation instead of running for
	// an unbounded time. Defaults to 5e8.
	readonly maxOperations?: number
}

// Best box of each trial period. Every array has one entry per period; a period without a box
// satisfying minInTransitPoints, minTransits, at least one out-of-transit sample and a positive depth
// has power and snr 0 and NaN depth, duration and epoch.
export interface BoxLeastSquaresPeriodogram {
	// Trial periods, ascending, time unit.
	readonly periods: Float64Array
	// Improvement in log-likelihood over a constant level, snr^2 / 2, dimensionless; the objective. It
	// overflows to Infinity only above an snr of about 1e154.
	readonly power: Float64Array
	// Depth over its one-sigma uncertainty.
	readonly snr: Float64Array
	// Out-of-transit minus in-transit level, flux unit, positive for a dip.
	readonly depth: Float64Array
	// Box duration, a whole number of phase bins of the period, time unit.
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

// A ranked candidate, measured from the samples with the box of the search: the samples whose phase bin
// lies in the duration starting duration / 2 before the epoch, modulo the period. Up to the floating-point
// placement of a sample on a bin edge this is epoch - duration / 2 <= time < epoch + duration / 2.
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
	// Improvement in log-likelihood (half the chi-square improvement) over a constant level, snr^2 / 2;
	// Infinity only above an snr of about 1e154.
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
	// Fraction of the phase bins inside the box holding at least one sample, in (0, 1]; low when only part
	// of the transit (for example the ingress) was observed.
	readonly coverage: number
	// Depth of the even-numbered (index 0, 2, ...) and odd-numbered events against the common
	// out-of-transit level, with one-sigma uncertainties; undefined without samples of that parity.
	readonly evenDepth?: number
	readonly evenDepthError?: number
	readonly oddDepth?: number
	readonly oddDepthError?: number
	// |evenDepth - oddDepth| over its one-sigma uncertainty; undefined without both parities.
	readonly oddEvenSigma?: number
	// Depth of a box of the same duration half a period away (to one phase bin) against the remaining
	// out-of-transit samples, and its uncertainty; undefined without samples there. Negative when that
	// phase is brighter.
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
	// Candidates by decreasing snr, at most maxCandidates, each a distinct periodogram peak: a period
	// whose phase drifts from a stronger examined peak by less than that peak's duration across the
	// baseline belongs to it.
	readonly candidates: readonly BoxLeastSquaresCandidate[]
}

// Usable samples sorted by time, relative to the first time, with normalized weights and fluxes.
interface BoxLeastSquaresSamples {
	// Times minus firstTime, ascending, time unit, non-negative.
	readonly t: Float64Array
	// (scale / fluxError)^2, in (0, 1].
	readonly w: Float64Array
	// w * (flux - mean) / scale.
	readonly wz: Float64Array
	// Number of usable samples.
	readonly count: number
	// Earliest usable time, time unit.
	readonly firstTime: number
	// Weighted mean flux, flux unit.
	readonly mean: number
	// Smallest flux error, flux unit; the unit of the normalized fluxes.
	readonly scale: number
	// Time span of the usable samples, time unit.
	readonly baseline: number
}

// Box geometry of one trial period, in its phase bins.
interface PeriodBox {
	// Number of equal phase bins of the period.
	readonly bins: number
	// First bin of the box, 0-based, in [0, bins).
	readonly start: number
	// Box length in bins, at least 1.
	readonly length: number
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
// grid exceeds maxOperations or the phase bins of one period exceed 2^21.
export function boxLeastSquares(time: Readonly<NumberArray>, flux: Readonly<NumberArray>, fluxError: Readonly<NumberArray> | number, options: BoxLeastSquaresOptions): BoxLeastSquaresResult {
	const n = time.length

	// Mismatched arrays would silently pair a time with another sample's flux.
	if (flux.length !== n || (typeof fluxError !== 'number' && fluxError.length !== n)) throw new RangeError('time, flux and fluxError must have equal lengths')

	const oversample = validatePositiveInteger(options.oversample ?? DEFAULT_OVERSAMPLE)
	const minTransits = validatePositiveInteger(options.minTransits ?? DEFAULT_MIN_TRANSITS)
	const minInTransitPoints = validatePositiveInteger(options.minInTransitPoints ?? DEFAULT_MIN_IN_TRANSIT_POINTS)
	const maxCandidates = validatePositiveInteger(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
	const diagnosticSigma = options.diagnosticSigma ?? DEFAULT_DIAGNOSTIC_SIGMA
	const maxOperations = validatePositiveFinite(options.maxOperations ?? DEFAULT_MAX_OPERATIONS)

	// An empty or non-positive duration list leaves no box to fit and no phase-bin width.
	if (options.durations.length === 0) throw new RangeError('durations must not be empty')

	const durations = new Float64Array(options.durations.length)
	for (let i = 0; i < durations.length; i++) durations[i] = validatePositiveFinite(options.durations[i])
	durations.sort()

	const minDuration = durations[0]
	const maxDuration = durations.at(-1)!
	const samples = usableSamples(time, flux, fluxError)
	const rejectedSampleCount = n - samples.count
	const insufficient = { status: 'insufficientData', sampleCount: samples.count, rejectedSampleCount, baseline: samples.baseline, candidates: [] } as const

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
	// phase 0.5 diagnostics; the wrap-around copies of the folded bins also rely on it.
	if (2 * maxDuration > minPeriod) throw new RangeError('durations must not exceed half the shortest period')
	if (!(samples.baseline > 0) || samples.count <= minInTransitPoints) return insufficient

	let grid: FrequencyGrid | undefined

	if (periods === undefined) {
		const longest = maxPeriod ?? (minTransits > 1 ? samples.baseline / (minTransits - 1) : samples.baseline)
		if (!(longest >= minPeriod)) return insufficient
		grid = frequencyGrid(minPeriod, longest, (frequencyFactor * minDuration) / (samples.baseline * samples.baseline))
	}

	const binWidth = minDuration / oversample
	const count = samples.count
	const boxCount = durations.length
	const periodCount = periods?.length ?? grid!.count
	const fixedOperations = 2 * maxCandidates * count * MEASUREMENT_OPERATIONS_PER_SAMPLE

	// Every period costs at least its ranking, one pass over the samples and the scan of the bins of the
	// shortest period. This lower bound of the estimate below takes O(1), so a huge default grid is rejected
	// before its periods are generated or stored.
	const minimumOperations = fixedOperations + periodCount * (RANKING_OPERATIONS_PER_PERIOD + count + (Math.ceil(minPeriod / binWidth) + 1) * (boxCount + 2))
	if (!(minimumOperations <= maxOperations)) throw new RangeError(`the search needs at least ${minimumOperations.toExponential(2)} operations, more than maxOperations`)

	let operations = fixedOperations + periodCount * RANKING_OPERATIONS_PER_PERIOD
	let capacity = 0

	for (let p = 0; p < periodCount; p++) {
		const period = periods !== undefined ? periods[p] : gridPeriod(grid!, p)
		const bins = Math.ceil(period / binWidth)
		const size = bins + Math.max(1, Math.round((maxDuration * bins) / period))

		if (size > capacity) capacity = size
		// Folding, the compensated prefix sums and the box scan.
		operations += count + size * (boxCount + 2)
		// The exact event counting: sliding minimum and maximum, or the event ids, their bin order and the
		// sliding counters, which add and remove every (bin, event) pair once per duration.
		if (minTransits === 2) operations += 2 * size * boxCount
		else if (minTransits > 2) operations += 2 * count + boxCount * (4 * count + size)
	}

	// Bounds the run time and the work arrays before allocating them.
	if (!(operations <= maxOperations)) throw new RangeError(`the search needs about ${operations.toExponential(2)} operations, more than maxOperations`)
	if (capacity > MAX_PHASE_BINS) throw new RangeError('the longest period has too many phase bins; raise the shortest duration or lower oversample')

	periods ??= gridPeriods(grid!)
	const { periodogram, boxes } = searchPeriods(samples, periods, binWidth, durations, minInTransitPoints, minTransits, capacity)
	const candidates = rankCandidates(samples, periodogram, boxes, maxCandidates, diagnosticSigma)

	return { status: candidates.length > 0 ? 'ok' : 'noCandidate', sampleCount: count, rejectedSampleCount, baseline: samples.baseline, periodogram, candidates }
}

// Collects the usable samples sorted by time and relative to the earliest time. The weights are
// normalized by the smallest error, (scale / error)^2 in (0, 1], so they cannot overflow, and the fluxes
// are centered on their weighted mean and expressed in units of that error so that the sums stay small.
function usableSamples(time: Readonly<NumberArray>, flux: Readonly<NumberArray>, fluxError: Readonly<NumberArray> | number): BoxLeastSquaresSamples {
	const n = time.length
	const usable: number[] = []
	let scale = Infinity

	for (let i = 0; i < n; i++) {
		const error = typeof fluxError === 'number' ? fluxError : fluxError[i]
		if (!Number.isFinite(time[i]) || !Number.isFinite(flux[i]) || !Number.isFinite(error) || !(error > 0)) continue
		usable.push(i)
		if (error < scale) scale = error
	}

	const count = usable.length
	const t = new Float64Array(count)
	const w = new Float64Array(count)
	const wz = new Float64Array(count)

	if (count === 0) return { t, w, wz, count, firstTime: 0, mean: 0, scale: 1, baseline: 0 }

	usable.sort((a, b) => time[a] - time[b])

	const firstTime = time[usable[0]]
	let sumW = 0
	let sumWY = 0

	for (let j = 0; j < count; j++) {
		const i = usable[j]
		const ratio = scale / (typeof fluxError === 'number' ? fluxError : fluxError[i])
		t[j] = time[i] - firstTime
		w[j] = ratio * ratio
		sumW += w[j]
		sumWY += w[j] * flux[i]
	}

	const mean = sumWY / sumW
	for (let j = 0; j < count; j++) wz[j] = (w[j] * (flux[usable[j]] - mean)) / scale

	return { t, w, wz, count, firstTime, mean, scale, baseline: t[count - 1] }
}

// Default period grid, uniform in frequency, described without materializing its periods.
interface FrequencyGrid {
	// Number of periods; Infinity when the step underflows.
	readonly count: number
	// Bounds of the periods, time unit.
	readonly minPeriod: number
	readonly maxPeriod: number
	// 1 / minPeriod and the frequency step, per time unit.
	readonly maxFrequency: number
	readonly step: number
}

// Describes the periods ascending from minPeriod toward maxPeriod, uniform in frequency with step
// frequencyStep (Astropy's autoperiod rule), keeping only the steps that do not pass maxPeriod.
function frequencyGrid(minPeriod: number, maxPeriod: number, frequencyStep: number): FrequencyGrid {
	const minFrequency = 1 / maxPeriod
	const maxFrequency = 1 / minPeriod
	const count = maxFrequency > minFrequency ? 1 + Math.floor((maxFrequency - minFrequency) / frequencyStep) : 1
	return { count, minPeriod, maxPeriod, maxFrequency, step: frequencyStep }
}

// Period i of the grid, with the rounding at both ends clamped into [minPeriod, maxPeriod].
function gridPeriod(grid: FrequencyGrid, i: number) {
	return Math.min(grid.maxPeriod, Math.max(grid.minPeriod, 1 / (grid.maxFrequency - grid.step * i)))
}

// Allocates and fills the periods of the grid; called only once its work estimate is within the budget.
function gridPeriods(grid: FrequencyGrid) {
	const periods = new Float64Array(grid.count)
	for (let i = 0; i < grid.count; i++) periods[i] = gridPeriod(grid, i)
	return periods
}

// Rounds the ascending durations to whole bins of width, at least 1, writing the distinct counts
// ascending into out; returns how many were written.
function durationBins(durations: Float64Array, width: number, out: Int32Array) {
	let count = 0

	for (let i = 0; i < durations.length; i++) {
		const k = Math.max(1, Math.round(durations[i] / width))
		if (count === 0 || k !== out[count - 1]) out[count++] = k
	}

	return count
}

// Error of the floating-point sum = fl(a + b) (Knuth's TwoSum), so that a + b = sum + error exactly.
function sumError(a: number, b: number, sum: number) {
	const bb = sum - a
	return a - (sum - bb) + (b - bb)
}

// Phase-binned sums of one trial period, allocated once per search for the longest period and
// overwritten for every period. Bins are 1-based; index 0 is the empty prefix.
interface PhaseBins {
	// Compensated prefix sums of weight and of weight * normalized flux: each prefix is hi + lo.
	readonly wHi: Float64Array
	readonly wLo: Float64Array
	readonly yHi: Float64Array
	readonly yLo: Float64Array
	// Prefix counts of samples.
	readonly sampleCount: Int32Array
	// Whether the box starting at each 0-based bin has samples from minTransits events.
	readonly eligible: Uint8Array
}

// Event bookkeeping for minTransits = 2: the smallest and largest event number of each bin.
interface EventSpan {
	readonly first: Float64Array
	readonly last: Float64Array
	// Monotonic deques of bin indices for the sliding minimum of first and maximum of last.
	readonly minQueue: Int32Array
	readonly maxQueue: Int32Array
}

// Event bookkeeping for minTransits >= 3. Samples are in time order, so their event numbers never
// decrease and get dense ids: 2d for the d-th distinct event, and for the wrap-around copy (the same
// samples seen as the end of the previous event) the id of the previous event when it has samples, or a
// fresh odd id 2d - 1 when it does not.
interface EventIds {
	// Dense id of each sample's event and of its wrap-around copy.
	readonly id: Int32Array
	readonly wrapId: Int32Array
	// 0-based bin of each sample.
	readonly bin: Int32Array
	// Samples grouped by bin (time order inside a bin) and the first position of each 0-based bin, with
	// binStart[bins] the sample count.
	readonly order: Int32Array
	readonly binStart: Int32Array
	// Samples of each id inside the sliding window; all zero between windows.
	readonly counter: Int32Array
}

// Folds the samples at every trial period into equal phase bins and finds the eligible box of each
// duration and start bin with the largest log-likelihood improvement. Also returns the box geometry of
// each period's best box, so that candidates are measured with exactly the box the search scored.
function searchPeriods(samples: BoxLeastSquaresSamples, periods: Float64Array, binWidth: number, durations: Float64Array, minInTransitPoints: number, minTransits: number, capacity: number) {
	const { t, w, wz, count, firstTime, scale } = samples
	const size = capacity + 1
	const phaseBins: PhaseBins = { wHi: new Float64Array(size), wLo: new Float64Array(size), yHi: new Float64Array(size), yLo: new Float64Array(size), sampleCount: new Int32Array(size), eligible: new Uint8Array(size) }
	const span: EventSpan | undefined = minTransits === 2 ? { first: new Float64Array(size), last: new Float64Array(size), minQueue: new Int32Array(size), maxQueue: new Int32Array(size) } : undefined
	const ids: EventIds | undefined = minTransits > 2 ? { id: new Int32Array(count), wrapId: new Int32Array(count), bin: new Int32Array(count), order: new Int32Array(count), binStart: new Int32Array(size), counter: new Int32Array(2 * count + 2) } : undefined
	const { wHi, wLo, yHi, yLo, sampleCount, eligible } = phaseBins
	const lengths = new Int32Array(durations.length)

	const power = new Float64Array(periods.length)
	const snr = new Float64Array(periods.length)
	const depth = new Float64Array(periods.length).fill(Number.NaN)
	const duration = new Float64Array(periods.length).fill(Number.NaN)
	const epoch = new Float64Array(periods.length).fill(Number.NaN)
	const boxes: (PeriodBox | undefined)[] = new Array(periods.length)

	for (let p = 0; p < periods.length; p++) {
		const period = periods[p]
		const bins = Math.ceil(period / binWidth)
		const width = period / bins
		const boxCount = durationBins(durations, width, lengths)

		foldSamples(t, w, wz, period, bins, lengths[boxCount - 1], phaseBins, span, ids)

		let best = 0
		let bestDepth = 0
		let bestStart = 0
		let bestLength = 0

		for (let d = 0; d < boxCount; d++) {
			const k = lengths[d]

			if (span !== undefined) markTwoEventWindows(span, bins, k, eligible)
			else if (ids !== undefined) markEventWindows(ids, bins, k, minTransits, eligible)

			for (let start = 0; start < bins; start++) {
				const end = start + k
				const inCount = sampleCount[end] - sampleCount[start]
				if (inCount < minInTransitPoints || inCount >= count || (minTransits > 1 && eligible[start] === 0)) continue

				const wIn = wHi[end] - wHi[start] + (wLo[end] - wLo[start])
				const yIn = yHi[end] - yHi[start] + (yLo[end] - yLo[start])
				let wOut: number
				let yOut: number

				// The out-of-transit bins are a prefix difference too, never the total minus the box, which
				// would cancel when the box holds almost all the weight.
				if (end <= bins) {
					wOut = wHi[start] + wLo[start] + (wHi[bins] - wHi[end] + (wLo[bins] - wLo[end]))
					yOut = yHi[start] + yLo[start] + (yHi[bins] - yHi[end] + (yLo[bins] - yLo[end]))
				} else {
					const wrapped = end - bins
					wOut = wHi[start] - wHi[wrapped] + (wLo[start] - wLo[wrapped])
					yOut = yHi[start] - yHi[wrapped] + (yLo[start] - yLo[wrapped])
				}

				const boxDepth = yOut / wOut - yIn / wIn
				if (!(boxDepth > 0)) continue

				const boxPower = (0.5 * boxDepth * boxDepth * wIn * wOut) / (wIn + wOut)

				if (boxPower > best) {
					best = boxPower
					bestDepth = boxDepth
					bestStart = start
					bestLength = k
				}
			}
		}

		if (best > 0) {
			let mid = (bestStart + 0.5 * bestLength) * width
			if (mid >= period) mid -= period
			power[p] = best
			snr[p] = Math.sqrt(2 * best)
			depth[p] = bestDepth * scale
			duration[p] = bestLength * width
			epoch[p] = firstTime + mid
			boxes[p] = { bins, start: bestStart, length: bestLength }
		}
	}

	const periodogram: BoxLeastSquaresPeriodogram = { periods, power, snr, depth, duration, epoch }
	return { periodogram, boxes }
}

// Folds the time-sorted samples at period into bins equal phase bins and builds the compensated prefix
// sums. The first pad bins are repeated after the last one, as the start of the next period seen from the
// end of this one, so a box can straddle phase 0; pad must not exceed bins. Fills the event bookkeeping
// that the minTransits constraint needs.
function foldSamples(t: Float64Array, w: Float64Array, wz: Float64Array, period: number, bins: number, pad: number, phaseBins: PhaseBins, span: EventSpan | undefined, ids: EventIds | undefined) {
	const { wHi, wLo, yHi, yLo, sampleCount } = phaseBins
	const width = period / bins
	const size = bins + pad

	wHi.fill(0, 0, size + 1)
	wLo.fill(0, 0, size + 1)
	yHi.fill(0, 0, size + 1)
	yLo.fill(0, 0, size + 1)
	sampleCount.fill(0, 0, size + 1)

	if (span !== undefined) {
		span.first.fill(Infinity, 0, size + 1)
		span.last.fill(-Infinity, 0, size + 1)
	}

	let previousEvent = Number.NaN
	let dense = 0
	let wrapId = 0

	for (let i = 0; i < t.length; i++) {
		let event = Math.floor(t[i] / period)
		let phase = t[i] - event * period

		if (phase >= period) {
			phase -= period
			event++
		} else if (phase < 0) {
			phase += period
			event--
		}

		const bin = Math.min(Math.floor(phase / width), bins - 1) + 1
		wHi[bin] += w[i]
		yHi[bin] += wz[i]
		sampleCount[bin]++

		if (span !== undefined) {
			if (event < span.first[bin]) span.first[bin] = event
			if (event > span.last[bin]) span.last[bin] = event
		} else if (ids !== undefined) {
			if (event !== previousEvent) {
				dense++
				wrapId = event === previousEvent + 1 ? 2 * (dense - 1) : 2 * dense - 1
				previousEvent = event
			}

			ids.id[i] = 2 * dense
			ids.wrapId[i] = wrapId
			ids.bin[i] = bin - 1
		}
	}

	if (ids !== undefined) {
		// Counting sort of the samples by bin, keeping time order inside a bin.
		const { binStart, order, bin } = ids
		binStart[0] = 0
		for (let j = 1; j <= bins; j++) binStart[j] = binStart[j - 1] + sampleCount[j]
		for (let i = 0; i < t.length; i++) order[binStart[bin[i]]++] = i
		for (let j = bins; j > 0; j--) binStart[j] = binStart[j - 1]
		binStart[0] = 0
	}

	for (let m = 1; m <= pad; m++) {
		const j = bins + m
		wHi[j] = wHi[m]
		yHi[j] = yHi[m]
		sampleCount[j] = sampleCount[m]

		if (span !== undefined) {
			span.first[j] = span.first[m] - 1
			span.last[j] = span.last[m] - 1
		}
	}

	for (let j = 1; j <= size; j++) {
		const wSum = wHi[j - 1] + wHi[j]
		const ySum = yHi[j - 1] + yHi[j]
		wLo[j] = wLo[j - 1] + sumError(wHi[j - 1], wHi[j], wSum)
		yLo[j] = yLo[j - 1] + sumError(yHi[j - 1], yHi[j], ySum)
		wHi[j] = wSum
		yHi[j] = ySum
		sampleCount[j] += sampleCount[j - 1]
	}
}

// Marks the boxes of k bins starting at each 0-based bin whose samples come from at least two events:
// the largest event number of the window exceeds the smallest. Monotonic deques give the sliding extrema
// in O(bins + k).
function markTwoEventWindows(span: EventSpan, bins: number, k: number, eligible: Uint8Array) {
	const { first, last, minQueue, maxQueue } = span
	let minHead = 0
	let minTail = 0
	let maxHead = 0
	let maxTail = 0

	// The window of start covers the bins start + 1 .. start + k.
	for (let j = 1; j < bins + k; j++) {
		while (minTail > minHead && first[minQueue[minTail - 1]] >= first[j]) minTail--
		minQueue[minTail++] = j
		while (maxTail > maxHead && last[maxQueue[maxTail - 1]] <= last[j]) maxTail--
		maxQueue[maxTail++] = j

		const start = j - k
		if (start < 0) continue

		while (minQueue[minHead] <= start) minHead++
		while (maxQueue[maxHead] <= start) maxHead++
		eligible[start] = last[maxQueue[maxHead]] > first[minQueue[minHead]] ? 1 : 0
	}
}

// Marks the boxes of k bins starting at each 0-based bin whose samples come from at least minTransits
// distinct events, with a sliding count of the samples of every event id. Each (bin, event) pair enters
// and leaves the window once, so the work is O(samples + bins + k); the counters are zero again on return.
function markEventWindows(ids: EventIds, bins: number, k: number, minTransits: number, eligible: Uint8Array) {
	let distinct = 0

	// The window of start covers the bins start + 1 .. start + k.
	for (let j = 1; j <= k; j++) distinct += updateWindow(ids, bins, j, 1)

	for (let start = 0; start < bins; start++) {
		eligible[start] = distinct >= minTransits ? 1 : 0
		distinct += updateWindow(ids, bins, start + 1, -1)
		distinct += updateWindow(ids, bins, start + k + 1, 1)
	}

	for (let j = bins + 1; j <= bins + k; j++) updateWindow(ids, bins, j, -1)
}

// Adds (delta 1) or removes (delta -1) the samples of the 1-based bin j, a wrap-around copy when j > bins,
// to the sliding counters, and returns the change in the number of distinct ids.
function updateWindow(ids: EventIds, bins: number, j: number, delta: number) {
	const { order, binStart, counter } = ids
	const wrap = j > bins
	const bin = (wrap ? j - bins : j) - 1
	const source = wrap ? ids.wrapId : ids.id
	let change = 0

	for (let p = binStart[bin]; p < binStart[bin + 1]; p++) {
		const id = source[order[p]]
		const before = counter[id]
		counter[id] = before + delta
		if (before === 0) change++
		else if (before + delta === 0) change--
	}

	return change
}

// Picks the periodogram peaks by decreasing snr, measures each with its box, merges weaker peaks within
// the width of an examined one, and marks period aliases.
function rankCandidates(samples: BoxLeastSquaresSamples, periodogram: BoxLeastSquaresPeriodogram, boxes: readonly (PeriodBox | undefined)[], maxCandidates: number, diagnosticSigma: number) {
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

		const left = p === 0 ? 0 : snr[p - 1]
		const right = p === periods.length - 1 ? 0 : snr[p + 1]
		if (snr[p] > left && snr[p] >= right) peaks.push(p)
	}

	peaks.sort((a, b) => snr[b] - snr[a] || a - b)

	const snrMean = valid > 0 ? sum / valid : 0
	const snrDeviation = valid > 1 ? Math.sqrt(Math.max(0, (sumSquares - valid * snrMean * snrMean) / (valid - 1))) : 0
	// Periods inside the width of an examined peak; each period is claimed once, so merging is linear.
	const claimed = new Uint8Array(periods.length)
	const accepted: { candidate: MeasuredCandidate; sde?: number }[] = []
	let measured = 0

	// The measurement repeats the scored box, so it fails only when rounding leaves no positive depth; the
	// bound on measurements keeps even that case within the work estimate.
	for (let i = 0; i < peaks.length && accepted.length < maxCandidates && measured < 2 * maxCandidates; i++) {
		const p = peaks[i]
		if (claimed[p]) continue

		const period = periods[p]
		const boxDuration = duration[p]
		claimed[p] = 1
		for (let q = p - 1; q >= 0 && !claimed[q] && samePeak(period, periods[q], boxDuration, samples.baseline); q--) claimed[q] = 1
		for (let q = p + 1; q < periods.length && !claimed[q] && samePeak(period, periods[q], boxDuration, samples.baseline); q++) claimed[q] = 1

		measured++
		const candidate = measureCandidate(samples, period, boxes[p]!, diagnosticSigma)
		if (candidate !== undefined) accepted.push({ candidate, sde: snrDeviation > 0 ? (snr[p] - snrMean) / snrDeviation : undefined })
	}

	accepted.sort((a, b) => b.candidate.snr - a.candidate.snr || a.candidate.period - b.candidate.period)

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

	return candidates
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
// in normalized weights and fluxes; undefined when either side has no weight.
function boxSnr(wIn: number, yIn: number, wOut: number, yOut: number) {
	if (!(wIn > 0) || !(wOut > 0)) return undefined
	return (yOut / wOut - yIn / wIn) / Math.sqrt(1 / wIn + 1 / wOut)
}

// Weighted sums of a group of samples, in normalized weights and fluxes.
interface GroupSums {
	w: number
	y: number
	n: number
}

// Adds sample i to a group.
function addToGroup(group: GroupSums, samples: BoxLeastSquaresSamples, i: number) {
	group.w += samples.w[i]
	group.y += samples.wz[i]
	group.n++
}

// Measures the box of the search, in the same phase bins, from the samples with its diagnostics. Every
// group (in transit, by parity and by event, half a period away and the rest) is accumulated directly, so
// no level is a difference of nearly equal sums. Returns undefined when the box has no in-transit or no
// out-of-transit sample, or a non-positive depth.
function measureCandidate(samples: BoxLeastSquaresSamples, period: number, box: PeriodBox, diagnosticSigma: number): MeasuredCandidate | undefined {
	const { t, count, mean, scale, firstTime, baseline } = samples
	const { bins, start, length } = box
	const width = period / bins
	const half = Math.floor(bins / 2)
	let mid = (start + 0.5 * length) * width
	// Events are numbered from the cycle of the box start; a mid-transit past the period belongs to the next.
	const shift = mid >= period ? 1 : 0
	mid -= shift * period

	const covered = new Uint8Array(length)
	const events = new Map<number, GroupSums>()
	const inside: GroupSums = { w: 0, y: 0, n: 0 }
	const secondary: GroupSums = { w: 0, y: 0, n: 0 }
	const rest: GroupSums = { w: 0, y: 0, n: 0 }
	const parity: GroupSums[] = [
		{ w: 0, y: 0, n: 0 },
		{ w: 0, y: 0, n: 0 },
	]

	for (let i = 0; i < count; i++) {
		let event = Math.floor(t[i] / period)
		let phase = t[i] - event * period

		if (phase >= period) {
			phase -= period
			event++
		} else if (phase < 0) {
			phase += period
			event--
		}

		let offset = Math.min(Math.floor(phase / width), bins - 1) - start

		// A bin before the start is inside the box only as the wrapped end of the previous cycle's box.
		if (offset < 0) {
			offset += bins
			event--
		}

		if (offset < length) {
			const index = event + shift
			addToGroup(inside, samples, i)
			addToGroup(parity[((index % 2) + 2) % 2], samples, i)
			covered[offset] = 1

			let group = events.get(index)

			if (group === undefined) {
				group = { w: 0, y: 0, n: 0 }
				events.set(index, group)
			}

			addToGroup(group, samples, i)
		} else {
			const opposite = offset >= half ? offset - half : offset - half + bins
			addToGroup(opposite < length ? secondary : rest, samples, i)
		}
	}

	if (inside.n === 0 || inside.n === count) return undefined

	const wOut = secondary.w + rest.w
	const yOut = secondary.y + rest.y
	const outLevel = yOut / wOut
	const inLevel = inside.y / inside.w
	const depth = outLevel - inLevel

	if (!(depth > 0)) return undefined

	const depthSigma = Math.sqrt(1 / inside.w + 1 / wOut)
	const snr = depth / depthSigma
	const flags: BoxLeastSquaresFlag[] = []

	let evenDepth: number | undefined
	let evenDepthError: number | undefined
	let oddDepth: number | undefined
	let oddDepthError: number | undefined
	let oddEvenSigma: number | undefined

	if (parity[0].n > 0) {
		evenDepth = (outLevel - parity[0].y / parity[0].w) * scale
		evenDepthError = Math.sqrt(1 / parity[0].w + 1 / wOut) * scale
	}

	if (parity[1].n > 0) {
		oddDepth = (outLevel - parity[1].y / parity[1].w) * scale
		oddDepthError = Math.sqrt(1 / parity[1].w + 1 / wOut) * scale
	}

	if (parity[0].n > 0 && parity[1].n > 0) {
		// The common out-of-transit level cancels in the difference.
		oddEvenSigma = Math.abs(parity[1].y / parity[1].w - parity[0].y / parity[0].w) / Math.sqrt(1 / parity[0].w + 1 / parity[1].w)
		if (oddEvenSigma > diagnosticSigma) flags.push('oddEvenMismatch')
	}

	let secondaryDepth: number | undefined
	let secondaryDepthError: number | undefined

	if (secondary.n > 0 && rest.n > 0) {
		secondaryDepth = (rest.y / rest.w - secondary.y / secondary.w) * scale
		secondaryDepthError = Math.sqrt(1 / secondary.w + 1 / rest.w) * scale
		if (boxSnr(secondary.w, secondary.y, rest.w, rest.y)! > diagnosticSigma) flags.push('secondaryEclipse')
	}

	const halfPeriodSnr = rest.n > 0 ? boxSnr(inside.w + secondary.w, inside.y + secondary.y, rest.w, rest.y) : undefined
	if (halfPeriodSnr !== undefined && halfPeriodSnr >= snr) flags.push('halfPeriodAlias')

	let doublePeriodSnr: number | undefined

	for (let p = 0; p < 2; p++) {
		const other = parity[1 - p]
		const value = parity[p].n > 0 ? boxSnr(parity[p].w, parity[p].y, wOut + other.w, yOut + other.y) : undefined
		if (value !== undefined && (doublePeriodSnr === undefined || value > doublePeriodSnr)) doublePeriodSnr = value
	}

	if (doublePeriodSnr !== undefined && doublePeriodSnr > snr) flags.push('doublePeriodAlias')

	const indices = Array.from(events.keys()).sort((a, b) => a - b)
	const eventList: BoxLeastSquaresEvent[] = new Array(indices.length)
	let strongest = 0
	let strongestSnr = -Infinity

	for (let e = 0; e < indices.length; e++) {
		const index = indices[e]
		const group = events.get(index)!
		const eventDepth = outLevel - group.y / group.w
		const eventSigma = Math.sqrt(1 / group.w + 1 / wOut)
		const eventSnr = eventDepth / eventSigma
		eventList[e] = { index, time: firstTime + mid + index * period, sampleCount: group.n, depth: eventDepth * scale, depthError: eventSigma * scale, snr: eventSnr }

		if (eventSnr > strongestSnr) {
			strongestSnr = eventSnr
			strongest = e
		}
	}

	let snrWithoutStrongestEvent: number | undefined

	if (indices.length > 1) {
		// The other events are summed again rather than subtracting the strongest from the total.
		let wOthers = 0
		let yOthers = 0

		for (let e = 0; e < indices.length; e++) {
			if (e === strongest) continue
			const group = events.get(indices[e])!
			wOthers += group.w
			yOthers += group.y
		}

		snrWithoutStrongestEvent = boxSnr(wOthers, yOthers, wOut, yOut)
	}

	if (snrWithoutStrongestEvent === undefined || snrWithoutStrongestEvent < diagnosticSigma) flags.push('singleEventDominated')

	let coveredBins = 0
	for (let j = 0; j < length; j++) coveredBins += covered[j]

	// Cycles c whose box [c * period + start * width, c * period + (start + length) * width) overlaps
	// [0, baseline] in time relative to the first sample.
	const firstExpected = Math.floor((-(start + length) * width) / period) + 1
	const lastExpected = Math.floor((baseline - start * width) / period)

	return {
		period,
		epoch: firstTime + mid,
		duration: length * width,
		depth: depth * scale,
		depthError: depthSigma * scale,
		snr,
		power: 0.5 * snr * snr,
		inTransitLevel: mean + inLevel * scale,
		outOfTransitLevel: mean + outLevel * scale,
		inTransitCount: inside.n,
		transitCount: indices.length,
		expectedTransitCount: Math.max(0, lastExpected - firstExpected + 1),
		coverage: coveredBins / length,
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
