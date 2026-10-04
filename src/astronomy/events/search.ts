import { NumberComparator } from '../../core/util'
import { validateFinite } from '../../core/validation'
import { brentMinimize, brentRoot } from '../../math/numerical/optimization'
import { type Time, timeShift, timeSubtract } from '../time/time'

// Generic time-domain event scanner. It samples a scalar function of time over a window at a coarse
// step, isolates sign changes (roots) and local extrema between consecutive samples, and refines each
// with Brent's method. It is the shared foundation for the higher-level almanac event finders
// (rise/transit/set, twilight, planetary stationary points, greatest elongation, opposition and
// conjunction, perihelion/aphelion passages and lunar nodal crossings): each event reduces to a root
// or an extremum of a one-line scalar objective of time.
//
// The function must be continuous over the window. Functions that wrap (right ascension, longitude,
// hour angle) must be unwrapped by the caller, typically with normalizePI around the target value, so
// the objective changes sign smoothly across the event instead of jumping at the 0/TAU seam.

// A local extremum located by the scanner.
export interface TimeExtremum {
	// Instant of the extremum.
	readonly time: Time
	// Objective value at the extremum.
	readonly value: number
	// Whether the extremum is a local minimum or maximum of the objective.
	readonly kind: 'minimum' | 'maximum'
}

// Tuning parameters shared by the time-domain scanners.
export interface TimeSearchOptions {
	// Coarse sampling step in days. Must be small enough that no two events of interest fall inside one
	// step. Defaults to one hour (1/24 day), adequate for diurnal rise/set and twilight crossings.
	readonly step?: number
	// Refinement tolerance in days for the Brent stage. Defaults to ~1e-6 day (~0.09 s).
	readonly tolerance?: number
}

// Default coarse sampling step: one hour, in days.
const DEFAULT_STEP = 1 / 24
// Default Brent refinement tolerance: ~0.09 s, in days.
const DEFAULT_TOLERANCE = 1e-6

// Checks finite span/step before scanning to prevent endless loops on infinite windows or a step
// too small to advance floating-point offsets. Non-positive spans/steps retain the empty-result contract.
function scanSpan(start: Time, stop: Time, step: number) {
	const span = validateFinite(timeSubtract(stop, start))
	validateFinite(step)
	if (span > 0 && step > 0 && !(span + step > span)) throw new RangeError('search step is too small to advance the window')
	return span
}

// Refines one coarse sign crossing of f, whose argument is a day offset. An exact right-end
// zero is retained; a non-crossing returns undefined. Shared by roots and interval scanning.
function crossingOffset(f: (offset: number) => number, left: number, right: number, before: number, after: number, tolerance: number) {
	if (after === 0) return right
	if ((before < 0 && after > 0) || (before > 0 && after < 0)) return brentRoot(f, left, right, { tolerance }).root
	return undefined
}

// Finds every instant where f changes sign over [start, stop].
//
// f is sampled at the coarse step from start to stop; each sign change between consecutive samples is
// refined with Brent's method, and a sample that lands exactly on a root is reported directly. Roots
// are returned in chronological order. A sign change is detected only when it straddles a coarse step,
// so step must be finer than the spacing between roots. Endpoints that evaluate to exactly zero are
// reported; a root at an interior sample is not double-counted.
export function searchRoots(f: (time: Time) => number, start: Time, stop: Time, { step = DEFAULT_STEP, tolerance = DEFAULT_TOLERANCE }: TimeSearchOptions = {}): Time[] {
	const span = scanSpan(start, stop, step)
	if (span <= 0 || step <= 0) return []

	const g = (x: number) => f(timeShift(start, x))
	const roots: Time[] = []

	let x0 = 0
	let f0 = g(x0)
	if (f0 === 0) roots.push(timeShift(start, x0))

	while (x0 < span) {
		const x1 = Math.min(x0 + step, span)
		const f1 = g(x1)

		const crossing = crossingOffset(g, x0, x1, f0, f1, tolerance)
		if (crossing !== undefined) roots.push(timeShift(start, crossing))

		x0 = x1
		f0 = f1
	}

	return roots
}

// Finds every local extremum of f over [start, stop].
//
// f is sampled at the coarse step; a coarse triple whose middle sample is strictly lower (minimum) or
// strictly higher (maximum) than both neighbours brackets an extremum, refined with Brent's minimizer
// (the maximum case minimizes the negated objective). Extrema are returned in chronological order with
// the refined objective value. Extrema flatter than one coarse step, or sitting on the window
// endpoints, are not detected.
export function searchExtrema(f: (time: Time) => number, start: Time, stop: Time, { step = DEFAULT_STEP, tolerance = DEFAULT_TOLERANCE }: TimeSearchOptions = {}): TimeExtremum[] {
	const span = scanSpan(start, stop, step)
	if (span <= 0 || step <= 0) return []

	const g = (x: number) => f(timeShift(start, x))
	const extrema: TimeExtremum[] = []

	let xa = 0
	let fa = g(xa)
	let xb = Math.min(step, span)
	let fb = g(xb)

	while (xb < span) {
		const xc = Math.min(xb + step, span)
		const fc = g(xc)

		if (fb < fa && fb < fc) {
			const result = brentMinimize(g, xa, xc, { tolerance })
			extrema.push({ time: timeShift(start, result.minimum), value: result.value, kind: 'minimum' })
		} else if (fb > fa && fb > fc) {
			const result = brentMinimize((x) => -g(x), xa, xc, { tolerance })
			extrema.push({ time: timeShift(start, result.minimum), value: -result.value, kind: 'maximum' })
		}

		xa = xb
		fa = fb
		xb = xc
		fb = fc
	}

	return extrema
}

// A continuous interval clipped to the caller's search window.
export interface TimeInterval {
	// First epoch, inclusive at zero margins.
	readonly start: Time
	// Last epoch, inclusive at zero margins.
	readonly end: Time
}

// Finds intervals where all supplied continuous scalar margins are non-negative over start/stop.
// Each margin's sign changes are refined independently, so one cannot hide another's roots.
// All margins share each coarse epoch, allowing callers to share one geometry evaluation. Only
// two scalar samples per margin are retained; refined roots reuse the same primitive as searchRoots.
// Roots partition the window; midpoint classification selects the interiors and joins adjacent
// accepted pieces. Coarse step must resolve every sign crossing; tangencies and intervals shorter
// than a step can be missed. An empty set of margins accepts the whole positive-length window.
// Returns chronological intervals, without retaining a dense sampled track.
export function searchIntervals(margins: readonly ((time: Time) => number)[], start: Time, stop: Time, options: TimeSearchOptions = {}): TimeInterval[] {
	const { step = DEFAULT_STEP, tolerance = DEFAULT_TOLERANCE } = options
	const span = scanSpan(start, stop, step)
	if (!(span > 0) || !(step > 0)) return []
	if (margins.length === 0) return [{ start: timeShift(start, 0), end: timeShift(start, span) }]

	const offsets = [0, span]
	const objectives = margins.map((margin) => (offset: number) => margin(timeShift(start, offset)))
	const first = timeShift(start, 0)

	let before = new Float64Array(margins.length)
	let after = new Float64Array(margins.length)
	for (let i = 0; i < margins.length; i++) before[i] = margins[i](first)
	let left = 0

	while (left < span) {
		const right = Math.min(left + step, span)
		const epoch = timeShift(start, right)

		for (let i = 0; i < margins.length; i++) after[i] = margins[i](epoch)
		for (let i = 0; i < margins.length; i++) {
			const crossing = crossingOffset(objectives[i], left, right, before[i], after[i], tolerance)
			if (crossing !== undefined) offsets.push(crossing)
		}

		const swap = before
		before = after
		after = swap
		left = right
	}

	offsets.sort(NumberComparator)
	const intervals: TimeInterval[] = []
	let previousEnd = -1

	for (let i = 1; i < offsets.length; i++) {
		const left = offsets[i - 1]
		const right = offsets[i]
		if (!(right > left)) continue

		const middle = timeShift(start, (left + right) / 2)
		let accepted = true

		for (const margin of margins) {
			if (!(margin(middle) >= 0)) {
				accepted = false
				break
			}
		}

		if (!accepted) continue

		const end = timeShift(start, right)
		if (previousEnd === left) intervals[intervals.length - 1] = { start: intervals.at(-1)!.start, end }
		else intervals.push({ start: timeShift(start, left), end })
		previousEnd = right
	}

	return intervals
}
