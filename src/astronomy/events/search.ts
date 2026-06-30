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

// Finds every instant where f changes sign over [start, stop].
//
// f is sampled at the coarse step from start to stop; each sign change between consecutive samples is
// refined with Brent's method, and a sample that lands exactly on a root is reported directly. Roots
// are returned in chronological order. A sign change is detected only when it straddles a coarse step,
// so step must be finer than the spacing between roots. Endpoints that evaluate to exactly zero are
// reported; a root at an interior sample is not double-counted.
export function searchRoots(f: (time: Time) => number, start: Time, stop: Time, { step = DEFAULT_STEP, tolerance = DEFAULT_TOLERANCE }: TimeSearchOptions = {}): Time[] {
	const span = timeSubtract(stop, start)
	if (span <= 0 || step <= 0) return []

	const g = (x: number) => f(timeShift(start, x))
	const roots: Time[] = []

	let x0 = 0
	let f0 = g(x0)
	if (f0 === 0) roots.push(timeShift(start, x0))

	while (x0 < span) {
		const x1 = Math.min(x0 + step, span)
		const f1 = g(x1)

		if (f1 === 0) {
			// Report a sample that lands exactly on a root, but defer to the next interval so the boundary
			// is not counted twice; skip if it is the closing endpoint already handled by the loop guard.
			if (x1 < span) roots.push(timeShift(start, x1))
		} else if ((f0 < 0 && f1 > 0) || (f0 > 0 && f1 < 0)) {
			const root = brentRoot(g, x0, x1, { tolerance })
			roots.push(timeShift(start, root.root))
		}

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
	const span = timeSubtract(stop, start)
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
