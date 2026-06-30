import type { Vec3 } from '../../math/linear-algebra/vec3'
import { type Angle, deg } from '../../math/units/angle'
import { equatorial } from '../coordinates/astrometry'
import { equatorialFromJ2000, equatorialToHorizontal } from '../coordinates/coordinate'
import { type GeographicPosition, localSiderealTime } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { searchExtrema, searchRoots, type TimeSearchOptions } from './search'

// Rise, transit and set computation for an arbitrary celestial direction, layered on the time-domain
// event scanner. The target is supplied as a direction-of-time callback (the geocentric apparent
// position vector toward the body), so the same finder serves stars, the Sun, the Moon and planets.
// Rise and set are the crossings of the geometric altitude through a configurable standard horizon;
// the transit is the upper culmination (altitude maximum). All angles are radians.
//
// The supplied direction is taken to be a J2000/ICRS geocentric vector (the natural output of the
// VSOP/ELP ephemerides and of icrs()); it is reduced to the true equator and equinox of date with
// precession and nutation before being paired with Greenwich apparent sidereal time, so the hour angle
// is consistent. Annual aberration (~20″) and light deflection are not applied.
//
// The altitude is geocentric and geometric: refraction, the body's semidiameter and (for nearby
// bodies) topocentric parallax are folded into the chosen horizon altitude, following the classical
// almanac convention. Use STANDARD_HORIZON for point sources, SUN_HORIZON for the solar limb, the
// twilight constants for the Sun's depression angles, and for sub-arcminute lunar accuracy pass a
// horizon raised by the Moon's horizontal parallax (≈ +0.7275·π − 34′).

// Standard horizon altitude for a point source: -34′ of mean atmospheric refraction at the sea horizon.
export const STANDARD_HORIZON: Angle = deg(-34 / 60)
// Horizon altitude for the Sun's upper limb: -34′ refraction minus the ~16′ solar semidiameter.
export const SUN_HORIZON: Angle = deg(-50 / 60)
// Sun centre depression marking the limit of civil twilight.
export const CIVIL_TWILIGHT: Angle = deg(-6)
// Sun centre depression marking the limit of nautical twilight.
export const NAUTICAL_TWILIGHT: Angle = deg(-12)
// Sun centre depression marking the limit of astronomical twilight.
export const ASTRONOMICAL_TWILIGHT: Angle = deg(-18)

// Rise, transit and set circumstances over a one-day window.
export interface RiseTransitSet {
	// Instant the body rises through the horizon, or null when it does not rise in the window.
	readonly rise: Time | null
	// Instant of upper transit (altitude maximum), or null when no culmination falls in the window.
	readonly transit: Time | null
	// Instant the body sets through the horizon, or null when it does not set in the window.
	readonly set: Time | null
	// Geometric altitude at upper transit (radians); the day's maximum altitude.
	readonly transitAltitude: Angle
	// True when the body stays above the horizon for the whole window (circumpolar).
	readonly alwaysUp: boolean
	// True when the body stays below the horizon for the whole window (never rises).
	readonly alwaysDown: boolean
}

// Options for riseTransitSet.
export interface RiseTransitSetOptions extends TimeSearchOptions {
	// Standard horizon altitude in radians the rise/set crossings are measured against. Defaults to
	// STANDARD_HORIZON (point-source refraction at the sea horizon).
	readonly horizon?: Angle
	// Length of the search window in days, starting at the supplied time. Defaults to one day.
	readonly window?: number
}

// One second expressed in days, used to probe the altitude slope at a crossing.
const ONE_SECOND = 1 / 86400

// Computes the geometric geocentric altitude of a direction at a time and observer location.
//
// `direction` is the J2000/ICRS geocentric position vector toward the body (its length is irrelevant).
// It is precessed and nutated to the equator of date before the hour angle is formed against Greenwich
// apparent sidereal time. The returned altitude is in radians and ignores refraction and parallax.
function altitudeOf(direction: Vec3, time: Time, location: GeographicPosition): Angle {
	const [ra2000, dec2000] = equatorial(direction)
	const [rightAscension, declination] = equatorialFromJ2000(ra2000, dec2000, time)
	const lst = localSiderealTime(time, location, false)
	return equatorialToHorizontal(rightAscension, declination, location.latitude, lst)[1]
}

// Computes rise, transit and set for a celestial direction over a day-long window.
//
// `directionAt` returns the geocentric apparent direction toward the body at a given time (e.g.
// `moonGeocentric(t)[0]` or the geocentric Sun vector); only its direction is used. `location` is the
// observer, `time` is the window start (typically local or UT midnight). The transit is the upper
// culmination found as the altitude maximum; rise and set are the standard-horizon crossings bounding
// that culmination. When the body never crosses the horizon, rise and set are null and exactly one of
// alwaysUp/alwaysDown is set. transit is still reported (as the culmination instant) even below the
// horizon, so callers can distinguish the geometry from the visibility.
export function riseTransitSet(directionAt: (time: Time) => Vec3, location: GeographicPosition, time: Time, { horizon = STANDARD_HORIZON, window = 1, step, tolerance }: RiseTransitSetOptions = {}): RiseTransitSet {
	const stop = timeShift(time, window)
	const altAt = (t: Time) => altitudeOf(directionAt(t), t, location)

	// Upper transit: the highest-altitude maximum in the window.
	const extrema = searchExtrema(altAt, time, stop, { step, tolerance })
	let transit: Time | null = null
	let transitAltitude = Number.NEGATIVE_INFINITY
	for (const e of extrema) {
		if (e.kind === 'maximum' && e.value > transitAltitude) {
			transit = e.time
			transitAltitude = e.value
		}
	}

	// Horizon crossings, classified into rising and setting by the local altitude slope.
	const crossings = searchRoots((t) => altAt(t) - horizon, time, stop, { step, tolerance })

	if (crossings.length === 0) {
		// No crossing: the body is wholly above or wholly below the horizon for the window. Decide from
		// the transit altitude when available, otherwise from the window-start altitude.
		const reference = transit !== null ? transitAltitude : altAt(time)
		const up = reference > horizon
		return { rise: null, transit, set: null, transitAltitude: transit !== null ? transitAltitude : reference, alwaysUp: up, alwaysDown: !up }
	}

	const transitOffset = transit !== null ? timeSubtract(transit, time) : 0.5 * window

	let rise: Time | null = null
	let set: Time | null = null
	let riseGap = Number.POSITIVE_INFINITY
	let setGap = Number.POSITIVE_INFINITY

	for (const crossing of crossings) {
		const offset = timeSubtract(crossing, time)
		// Slope of the altitude one second later tells a rising crossing from a setting one.
		const rising = altAt(timeShift(crossing, ONE_SECOND)) > altAt(crossing)

		if (rising) {
			// Prefer the rising crossing closest before the transit; fall back to the nearest otherwise.
			const gap = offset <= transitOffset ? transitOffset - offset : window + (transitOffset - offset)
			if (gap < riseGap) {
				riseGap = gap
				rise = crossing
			}
		} else {
			const gap = offset >= transitOffset ? offset - transitOffset : window + (offset - transitOffset)
			if (gap < setGap) {
				setGap = gap
				set = crossing
			}
		}
	}

	return { rise, transit, set, transitAltitude, alwaysUp: false, alwaysDown: false }
}
