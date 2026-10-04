import { PIOVERTWO } from '../../core/constants'
import { vecZero } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { separationFrom, type PositionOverTime } from '../coordinates/astrometry'
import { airmassKastenYoung } from '../formulas'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeSubtract } from '../time/time'
import { altitudeOf } from './horizon'
import { searchIntervals, type TimeSearchOptions } from './search'

// Intervals in which a target clears a set of observing constraints at once: a minimum altitude, a
// maximum Kasten–Young airmass, a maximum solar altitude, and minimum angular separations from the
// Sun and Moon. The target, Sun, and Moon are J2000 direction callbacks. Constraints that are omitted are not
// applied. A constraint that names the Sun or the Moon without the matching callback is rejected,
// because dropping it would report the target as visible when that body was never checked.

// One stretch during which every requested constraint holds.
export interface VisibilityInterval {
	// First instant of the stretch.
	readonly start: Time
	// Last instant of the stretch.
	readonly end: Time
}

// Optional bodies and the root finder used to locate the crossings.
export interface VisibilitySources extends TimeSearchOptions {
	// J2000 direction of the Sun, required for solar altitude or separation limits.
	readonly sunAt?: PositionOverTime
	// J2000 direction of the Moon, required when minimumMoonSeparation is set.
	readonly moonAt?: PositionOverTime
}

// Limits the target must satisfy together. Angles are radians. Airmass is dimensionless.
export interface VisibilityConstraints {
	// Minimum geometric altitude of the target.
	readonly minimumAltitude?: Angle
	// Maximum Kasten–Young airmass of the target. Combined with minimumAltitude by keeping the stricter
	// altitude. An airmass below 1 cannot occur above the horizon and yields no windows.
	readonly maximumAirmass?: number
	// Maximum geometric altitude of the Sun.
	readonly maximumSunAltitude?: Angle
	// Minimum great-circle target-Sun separation in radians, at the supplied correction stage.
	readonly minimumSunSeparation?: Angle
	// Minimum great-circle separation between the target and the Moon, in radians. Both directions are
	// the supplied geometric vectors, so lunar topocentric parallax is not applied.
	readonly minimumMoonSeparation?: Angle
}

// Lowest altitude whose Kasten–Young airmass is at most maximumAirmass. Undefined when no altitude
// above the horizon is dark enough, including every request below airmass 1.
function altitudeForAirmass(maximumAirmass: number): Angle | undefined {
	if (!(maximumAirmass >= 1)) return undefined

	let low = 0
	let high = PIOVERTWO

	for (let i = 0; i < 64; i++) {
		const mid = (low + high) * 0.5
		if (airmassKastenYoung(mid) > maximumAirmass) low = mid
		else high = mid
	}

	return high
}

// Intervals in which a target satisfies requested altitude, airmass, solar altitude/avoidance and lunar limits.
// Parameters: targetAt is the J2000 direction of the target. location is the observer. start and end
// bound the search. constraints selects the limits; an empty constraint set makes the whole window
// one interval. sources supplies the Sun and the Moon and the root-finder step. Returns the
// chronological stretches inside the window.
export function visibilityWindows(targetAt: PositionOverTime, location: GeographicPosition, start: Time, end: Time, constraints: VisibilityConstraints = {}, sources: VisibilitySources = {}): readonly VisibilityInterval[] {
	if (!(timeSubtract(end, start) > 0)) return []
	if ((constraints.maximumSunAltitude !== undefined || constraints.minimumSunSeparation !== undefined) && sources.sunAt === undefined) throw new RangeError('sun direction is required when a solar limit is set')
	if (constraints.minimumMoonSeparation !== undefined && sources.moonAt === undefined) throw new RangeError('moon direction is required when a lunar separation limit is set')

	let minimumAltitude = constraints.minimumAltitude
	if (constraints.maximumAirmass !== undefined) {
		const fromAirmass = altitudeForAirmass(constraints.maximumAirmass)
		if (fromAirmass === undefined) return []
		minimumAltitude = minimumAltitude === undefined ? fromAirmass : Math.max(minimumAltitude, fromAirmass)
	}

	const sunAt = sources.sunAt
	const moonAt = sources.moonAt
	const maximumSunAltitude = constraints.maximumSunAltitude
	const minimumMoonSeparation = constraints.minimumMoonSeparation
	const minimumSunSeparation = constraints.minimumSunSeparation
	const needsTarget = minimumAltitude !== undefined || minimumSunSeparation !== undefined || minimumMoonSeparation !== undefined
	let target = vecZero()

	const margin = (time: Time) => {
		let room = Number.POSITIVE_INFINITY
		// Providers may share mutable buffers; keep the target before sampling Sun or Moon.
		if (needsTarget) target = targetAt(time)
		if (minimumAltitude !== undefined) room = Math.min(room, altitudeOf(target, time, location) - minimumAltitude)
		if (maximumSunAltitude !== undefined && sunAt !== undefined) room = Math.min(room, maximumSunAltitude - altitudeOf(sunAt(time), time, location))
		if (minimumSunSeparation !== undefined && sunAt !== undefined) room = Math.min(room, separationFrom(target, sunAt(time)) - minimumSunSeparation)
		if (minimumMoonSeparation !== undefined && moonAt !== undefined) room = Math.min(room, separationFrom(target, moonAt(time)) - minimumMoonSeparation)
		return room
	}

	return searchIntervals([margin], start, end, sources)
}
