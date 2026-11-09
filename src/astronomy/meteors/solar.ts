import { DAYSPERTY, ECLIPTIC_J2000_MATRIX, TAU } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { normalizeAngle, normalizePI, type Angle } from '../../math/units/angle'
import { relativePositionAndVelocity, type PositionAndVelocityMut } from '../coordinates/astrometry'
import { earth, sun } from '../ephemeris/models/analytical/vsop87e'
import { searchRoots } from '../events/search'
import { Timescale, type Time, timeConvert, timeShift, timeSubtract, timeYMD } from '../time/time'
import { meteorActivityMaximumSolarLongitude, meteorShowerActivityYearApplies } from './activity'
import type { MeteorShowerDates, MeteorShowerDateOptions, MeteorShowerSolution, MeteorSolarLongitudeSearchOptions, MeteorSolarState } from './types'

// Solar-longitude calculations for meteor showers. The longitude is geometric and geocentric in
// the dynamical J2000 ecliptic: VSOP87E supplies barycentric Sun/Earth states and the position
// difference is formed explicitly before atan2. No refraction, light-time, aberration or date-frame
// rotation is mixed into this catalog convention.

// Computes the geometric geocentric solar longitude in the J2000 ecliptic, normalized to [0, 2π).
export function meteorSolarLongitude(time: Time): Angle {
	const [position] = meteorSolarRelativeState(time)
	return normalizeAngle(Math.atan2(position[1], position[0]))
}

// Computes solar longitude and the equatorial Sun vector from one shared geocentric VSOP state.
export function meteorSolarState(time: Time): MeteorSolarState {
	const [position] = meteorSolarRelativeState(time)
	return { solarLongitude: normalizeAngle(Math.atan2(position[1], position[0])), sun: matTransposeMulVec(ECLIPTIC_J2000_MATRIX, position) }
}

// Returns the signed shortest angular displacement longitude - reference in (-π, π].
export function meteorSolarLongitudeDelta(longitude: Angle, reference: Angle): Angle {
	return normalizePI(longitude - reference)
}

// Returns the forward circular displacement from start to end in [0, 2π).
export function meteorSolarLongitudeForwardDelta(start: Angle, end: Angle): Angle {
	return normalizeAngle(end - start)
}

// Converts one requested solar longitude into the first occurrence in the civil UTC year. The
// unwrapped objective remains continuous through the 0/2π seam; the returned instant uses options.scale.
export function timeAtMeteorSolarLongitude(year: number, longitude: Angle, options?: MeteorSolarLongitudeSearchOptions<Timescale>): Time {
	return meteorSolarLongitudeSolver(year, options)(longitude)
}

// Converts several solar longitudes within one civil UTC year while sharing the annual epoch,
// unwrapping convention and coarse mean-motion bracket. Results preserve input order and scale.
export function meteorSolarLongitudeTimes(year: number, longitudes: readonly Angle[], options?: MeteorSolarLongitudeSearchOptions<Timescale>): readonly Time[] {
	if (longitudes.length === 0) return []
	const solve = meteorSolarLongitudeSolver(year, options)
	return longitudes.map(solve)
}

// Converts several solar longitudes within one civil UTC year like meteorSolarLongitudeTimes, but
// answers undefined, in place of throwing, for a longitude the year never reaches (the few hours of
// longitude a 365-day year leaves out at its turn), which then occurs only in a neighboring year.
export function meteorSolarLongitudeCrossingTimes(year: number, longitudes: readonly Angle[], options?: MeteorSolarLongitudeSearchOptions<Timescale>): readonly (Time | undefined)[] {
	if (longitudes.length === 0) return []
	const crossing = meteorSolarLongitudeCrossings(year, options)
	return longitudes.map(crossing)
}

// Prepares one annual inversion context. The seven-day mean-motion bracket is wider than the
// VSOP87E seasonal equation-of-center displacement; a full-year fallback retains correctness at a
// civil-year endpoint or when a caller supplies an unusually coarse search step.
function meteorSolarLongitudeSolver(year: number, options?: MeteorSolarLongitudeSearchOptions<Timescale>): (longitude: Angle) => Time {
	const crossing = meteorSolarLongitudeCrossings(year, options)
	return (longitude: Angle) => {
		const root = crossing(longitude)
		if (root === undefined) throw new Error(`solar longitude ${longitude} does not occur in calendar year ${year}`)
		return root
	}
}

// Prepares one annual inversion context answering undefined for a longitude the civil year never
// reaches: a 365-day year is shorter than the orbit, so the few hours of longitude between the end of
// the year and its start occur only in a neighboring year.
function meteorSolarLongitudeCrossings(year: number, options?: MeteorSolarLongitudeSearchOptions<Timescale>): (longitude: Angle) => Time | undefined {
	const start = timeYMD(year, 1, 1, 0, Timescale.UTC)
	const stop = timeYMD(year + 1, 1, 1, 0, Timescale.UTC)
	const duration = timeSubtract(stop, start, Timescale.UTC)
	const initial = meteorSolarLongitude(start)
	const initialUnwrapped = initial

	const unwrapped = (time: Time) => {
		const elapsed = timeSubtract(time, start, Timescale.UTC)
		const raw = meteorSolarLongitude(time)
		// The expected mean motion selects the turn independently of the evaluation order used by Brent.
		// The solar longitude rate never differs enough from the mean rate to make this branch ambiguous.
		const turns = Math.round(((elapsed * TAU) / DAYSPERTY - (raw - initial)) / TAU)
		return raw + turns * TAU
	}

	return (longitude: Angle) => {
		let target = normalizeAngle(longitude)
		if (target < initialUnwrapped) target += TAU
		const estimate = ((target - initialUnwrapped) / TAU) * DAYSPERTY
		const bracketStart = timeShift(start, Math.max(0, estimate - 7))
		const bracketEnd = timeShift(start, Math.min(duration, estimate + 7))
		let roots = searchRoots((time) => unwrapped(time) - target, bracketStart, bracketEnd, options)
		if (roots.length === 0) roots = searchRoots((time) => unwrapped(time) - target, start, stop, options)
		const root = roots[0]
		return root === undefined ? undefined : convertScale(root, options?.scale)
	}
}

// Derives activity dates from the two catalog bounds and mean reference longitude. LoS is exposed as
// `reference`; `maximum` is populated only when an external profile supplies a maximum longitude.
// The dates describe one occurrence: the one whose start falls in the civil UTC year, or, without an
// activity interval, the one whose reference or maximum falls in it. The end is the first crossing
// after the start, and the reference and maximum are the crossings nearest to the start, so for an
// occurrence that crosses into the next year (the Quadrantids starting in late December) they may fall
// in year + 1. A start the civil year never reaches (a longitude of the few hours a 365-day year leaves
// out at its turn, such as 280.04° in 2026) starts no occurrence in that year and returns {}; the
// occurrence is the previous or next year's. Without an interval, a reference or maximum the year never
// reaches is left out.
export function meteorShowerDates(solution: MeteorShowerSolution, year: number, options?: MeteorShowerDateOptions<Timescale>): MeteorShowerDates {
	if (!meteorShowerActivityYearApplies(solution.activity, year) && !options?.extrapolateYearLimitedActivity) return {}

	const solvers = new Map<number, (longitude: Angle) => Time | undefined>()
	const crossingIn = (civilYear: number, longitude: Angle) => {
		let solver = solvers.get(civilYear)
		if (solver === undefined) {
			solver = meteorSolarLongitudeCrossings(civilYear, options)
			solvers.set(civilYear, solver)
		}
		return solver(longitude)
	}

	const interval = solution.activityInterval
	const profile = options?.profile
	const maximumLongitude = profile === undefined ? undefined : meteorActivityMaximumSolarLongitude(profile)

	if (interval === undefined) {
		const reference = solution.referenceSolarLongitude === undefined ? undefined : crossingIn(year, solution.referenceSolarLongitude)
		const maximum = maximumLongitude === undefined ? undefined : crossingIn(year, maximumLongitude)
		return { reference, maximum }
	}

	const start = crossingIn(year, interval.start)
	if (start === undefined) return {}

	// The first crossing strictly after the start; a full circle ends at the next crossing of its start.
	const firstAfter = (longitude: Angle) => {
		for (let civilYear = year; civilYear <= year + 2; civilYear++) {
			const time = crossingIn(civilYear, longitude)
			if (time !== undefined && timeSubtract(time, start, Timescale.UTC) > 0) return time
		}
		return undefined
	}

	// The crossing of the previous, same or next year nearest to the start.
	const nearest = (longitude: Angle) => {
		let best: Time | undefined
		let distance = Number.POSITIVE_INFINITY
		for (let civilYear = year - 1; civilYear <= year + 1; civilYear++) {
			const time = crossingIn(civilYear, longitude)
			if (time === undefined) continue
			const offset = Math.abs(timeSubtract(time, start, Timescale.UTC))
			if (offset < distance) {
				best = time
				distance = offset
			}
		}
		return best
	}

	const end = interval.fullCircle ? firstAfter(interval.start) : firstAfter(interval.end)
	const reference = solution.referenceSolarLongitude === undefined ? undefined : nearest(solution.referenceSolarLongitude)
	const maximum = maximumLongitude === undefined ? undefined : nearest(maximumLongitude)
	return { start, reference, end, maximum }
}

// Creates the shared context values that avoid repeating solar ephemeris work in batch callers.
export function meteorComputationContext(time: Time, localSiderealTime?: Angle): import('./types').MeteorComputationContext {
	return { time, solarLongitude: meteorSolarLongitude(time), localSiderealTime }
}

function convertScale(time: Time, scale: Timescale | undefined): Time {
	return scale === undefined || scale === Timescale.UTC ? time : timeConvert(time, scale)
}

// Keep the imported relative-state primitive part of the module's documented calculation seam.
export function meteorSolarRelativeState(time: Time): PositionAndVelocityMut {
	return relativePositionAndVelocity(solarSun, solarEarth, time)
}

function solarSun(time: Time) {
	return sun(time, 'eclipticJ2000')
}

function solarEarth(time: Time) {
	return earth(time, 'eclipticJ2000')
}
