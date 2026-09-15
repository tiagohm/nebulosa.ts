import { DAYSPERTY, TAU } from '../../core/constants'
import { normalizeAngle, normalizePI, type Angle } from '../../math/units/angle'
import { relativePositionAndVelocity, type PositionAndVelocity } from '../coordinates/astrometry'
import { earth, sun } from '../ephemeris/models/analytical/vsop87e'
import { searchRoots } from '../events/search'
import { Timescale, type Time, timeConvert, timeSubtract, timeYMD } from '../time/time'
import { meteorActivityMaximumSolarLongitude } from './activity'
import type { MeteorShowerDates, MeteorShowerDateOptions, MeteorShowerSolution, MeteorSolarLongitudeSearchOptions } from './types'

// Solar-longitude calculations for meteor showers. The longitude is geometric and geocentric in
// the dynamical J2000 ecliptic: VSOP87E supplies barycentric Sun/Earth states and the position
// difference is formed explicitly before atan2. No refraction, light-time, aberration or date-frame
// rotation is mixed into this catalog convention.

// Computes the geometric geocentric solar longitude in the J2000 ecliptic, normalized to [0, 2π).
export function meteorSolarLongitude(time: Time): Angle {
	const [position] = meteorSolarRelativeState(time)
	return normalizeAngle(Math.atan2(position[1], position[0]))
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
export function timeAtMeteorSolarLongitude(year: number, longitude: Angle, options: MeteorSolarLongitudeSearchOptions = {}): Time {
	const start = timeYMD(year, 1, 1, 0, Timescale.UTC)
	const stop = timeYMD(year + 1, 1, 1, 0, Timescale.UTC)
	const initial = meteorSolarLongitude(start)
	const initialTarget = normalizeAngle(longitude)
	const initialUnwrapped = initial
	let target = initialTarget
	if (target < initialUnwrapped) target += TAU

	const unwrapped = (time: Time) => {
		const elapsed = timeSubtract(time, start, Timescale.UTC)
		const raw = meteorSolarLongitude(time)
		// The expected mean motion selects the turn independently of the evaluation order used by Brent.
		// The solar longitude rate never differs enough from the mean rate to make this branch ambiguous.
		const turns = Math.round(((elapsed * TAU) / DAYSPERTY - (raw - initial)) / TAU)
		return raw + turns * TAU
	}

	const roots = searchRoots((time) => unwrapped(time) - target, start, stop, options)
	const root = roots[0]
	if (root === undefined) throw new Error(`solar longitude ${longitude} does not occur in calendar year ${year}`)
	return convertScale(root, options.scale)
}

// Derives activity dates from the two catalog bounds and mean reference longitude. LoS is exposed as
// `reference`; `maximum` is populated only when an external profile supplies a maximum longitude.
export function meteorShowerDates(solution: MeteorShowerSolution, year: number, options: MeteorShowerDateOptions = {}): MeteorShowerDates {
	if (solution.activity.kind === 'yearSpecific' && solution.activity.year !== undefined && solution.activity.year !== year && !options.extrapolateYearSpecific) return {}

	const interval = solution.activityInterval
	const start = interval === undefined ? undefined : timeAtMeteorSolarLongitude(year, interval.start, options)

	let end: Time | undefined
	if (interval !== undefined) {
		end = timeAtMeteorSolarLongitude(interval.fullCircle ? year + 1 : year, interval.fullCircle ? interval.start : interval.end, options)
		if (!interval.fullCircle && start !== undefined && timeSubtract(end, start, Timescale.UTC) < 0) end = timeAtMeteorSolarLongitude(year + 1, interval.end, options)
	}

	const reference = solution.referenceSolarLongitude === undefined ? undefined : timeAtMeteorSolarLongitude(year, solution.referenceSolarLongitude, options)
	const profile = options.profile
	const maximumLongitude = profile === undefined ? undefined : meteorActivityMaximumSolarLongitude(profile)
	const maximum = maximumLongitude === undefined ? undefined : timeAtMeteorSolarLongitude(year, maximumLongitude, options)
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
