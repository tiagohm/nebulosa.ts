import { DAYSPERTY, ECLIPTIC_J2000_MATRIX, TAU } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { normalizeAngle, normalizePI, type Angle } from '../../math/units/angle'
import { relativePositionAndVelocity, type PositionAndVelocity } from '../coordinates/astrometry'
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

// Returns the signed shortest angular displacement longitude - reference in [-π, π).
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

// Prepares one annual inversion context. The seven-day mean-motion bracket is wider than the
// VSOP87E seasonal equation-of-center displacement; a full-year fallback retains correctness at a
// civil-year endpoint or when a caller supplies an unusually coarse search step.
function meteorSolarLongitudeSolver(year: number, options?: MeteorSolarLongitudeSearchOptions<Timescale>): (longitude: Angle) => Time {
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
		if (root === undefined) throw new Error(`solar longitude ${longitude} does not occur in calendar year ${year}`)
		return convertScale(root, options?.scale)
	}
}

// Derives activity dates from the two catalog bounds and mean reference longitude. LoS is exposed as
// `reference`; `maximum` is populated only when an external profile supplies a maximum longitude.
export function meteorShowerDates(solution: MeteorShowerSolution, year: number, options?: MeteorShowerDateOptions<Timescale>): MeteorShowerDates {
	if (!meteorShowerActivityYearApplies(solution.activity, year) && !options?.extrapolateYearLimitedActivity) return {}

	const interval = solution.activityInterval
	const profile = options?.profile
	const maximumLongitude = profile === undefined ? undefined : meteorActivityMaximumSolarLongitude(profile)
	const longitudes: Angle[] = []
	const startIndex = interval === undefined ? undefined : longitudes.push(interval.start) - 1
	const endIndex = interval === undefined || interval.fullCircle ? undefined : longitudes.push(interval.end) - 1
	const referenceIndex = solution.referenceSolarLongitude === undefined ? undefined : longitudes.push(solution.referenceSolarLongitude) - 1
	const maximumIndex = maximumLongitude === undefined ? undefined : longitudes.push(maximumLongitude) - 1
	const times = meteorSolarLongitudeTimes(year, longitudes, options)
	const start = startIndex === undefined ? undefined : times[startIndex]
	let end = endIndex === undefined ? undefined : times[endIndex]
	if (interval?.fullCircle) end = meteorSolarLongitudeTimes(year + 1, [interval.start], options)[0]
	else if (interval !== undefined && start !== undefined && end !== undefined && timeSubtract(end, start, Timescale.UTC) < 0) end = meteorSolarLongitudeTimes(year + 1, [interval.end], options)[0]
	const reference = referenceIndex === undefined ? undefined : times[referenceIndex]
	const maximum = maximumIndex === undefined ? undefined : times[maximumIndex]
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
export function meteorSolarRelativeState(time: Time): PositionAndVelocity {
	return relativePositionAndVelocity(solarSun, solarEarth, time)
}

function solarSun(time: Time): PositionAndVelocity {
	return sun(time, 'eclipticJ2000')
}

function solarEarth(time: Time): PositionAndVelocity {
	return earth(time, 'eclipticJ2000')
}
