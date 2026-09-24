import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { ASTRONOMICAL_TWILIGHT, altitudeOf, CIVIL_TWILIGHT, NAUTICAL_TWILIGHT } from './horizon'
import { searchRoots, type TimeSearchOptions } from './search'

// Civil, nautical, and astronomical darkness, plus the part of astronomical night that also satisfies
// an optional lunar limit. Each interval is a stretch where the Sun's geometric altitude stays below
// the matching twilight depression (−6°, −12°, or −18°). The Sun and the optional Moon are J2000
// direction callbacks, the same contract as riseTransitSet. Angles are radians.

// One darkness stretch. The endpoints are the twilight or lunar crossings, clipped to the search window.
export interface DarknessInterval {
	// First instant of the stretch.
	readonly start: Time
	// Last instant of the stretch.
	readonly end: Time
}

// Darkness of one search window, split by how far the Sun is below the horizon.
export interface DarknessWindows {
	// Sun below −6°.
	readonly civil: readonly DarknessInterval[]
	// Sun below −12°.
	readonly nautical: readonly DarknessInterval[]
	// Sun below −18°.
	readonly astronomical: readonly DarknessInterval[]
	// Astronomical night, further cut by the lunar limits when a Moon is supplied. Without a Moon this
	// is the same set as astronomical.
	readonly dark: readonly DarknessInterval[]
}

// Lunar limits applied to the dark intervals. Supplying moonAt makes the Moon's geometric altitude
// part of the dark definition, with a default ceiling of the horizon. Illumination is a fraction in
// [0, 1] and is applied only when both the callback and the ceiling are set.
export interface DarknessOptions extends TimeSearchOptions {
	// J2000 direction of the Moon. When set, dark intervals also require the Moon to sit at or below
	// maximumMoonAltitude.
	readonly moonAt?: (time: Time) => Vec3
	// Maximum geometric lunar altitude, in radians. Defaults to the horizon (0) when moonAt is set.
	readonly maximumMoonAltitude?: Angle
	// Illuminated fraction of the Moon, from 0 to 1, at a time.
	readonly moonIlluminationAt?: (time: Time) => number
	// Maximum illuminated fraction allowed inside a dark interval.
	readonly maximumMoonIllumination?: number
}

// Finds the stretches of [start, end] on which value(time) is strictly below limit.
function intervalsBelow(value: (time: Time) => number, limit: number, start: Time, end: Time, options: TimeSearchOptions): DarknessInterval[] {
	const margin = (time: Time) => limit - value(time)
	return positiveIntervals(margin, start, end, options)
}

// Finds the stretches on which margin is non-negative. A zero margin is the boundary and is kept as
// an endpoint; the interior test uses the midpoint, so an exactly grazing touch does not become a stretch.
function positiveIntervals(margin: (time: Time) => number, start: Time, end: Time, options: TimeSearchOptions): DarknessInterval[] {
	if (!(timeSubtract(end, start) > 0)) return []
	const roots = searchRoots(margin, start, end, options)
	const bounds = [start, ...roots, end]
	const intervals: DarknessInterval[] = []

	for (let i = 0; i < bounds.length - 1; i++) {
		const left = bounds[i]
		const right = bounds[i + 1]
		if (left === undefined || right === undefined || !(timeSubtract(right, left) > 0)) continue
		const middle = timeShift(left, timeSubtract(right, left) * 0.5)
		if (margin(middle) >= 0) intervals.push({ start: left, end: right })
	}

	return intervals
}

// Intersects every base interval with the times at which margin is non-negative.
function intersect(base: readonly DarknessInterval[], margin: (time: Time) => number, options: TimeSearchOptions) {
	const out: DarknessInterval[] = []

	for (let i = 0; i < base.length; i++) {
		const interval = base[i]
		if (interval === undefined) continue

		const pieces = positiveIntervals(margin, interval.start, interval.end, options)

		for (let j = 0; j < pieces.length; j++) {
			const piece = pieces[j]
			if (piece !== undefined) out.push(piece)
		}
	}

	return out
}

// Civil, nautical, astronomical, and optionally moonlit-free darkness over a window.
// Parameters: sunAt returns the J2000 geocentric direction of the Sun. location is the observer.
// start and end bound the search; end must be after start. options carries the root-finder step and
// the optional Moon. Returns the four families of intervals. A missing Moon leaves dark equal to
// astronomical. A lunar altitude ceiling without moonAt, or an illumination ceiling without
// moonIlluminationAt, cannot be evaluated and is rejected rather than ignored. Illumination alone,
// without a ceiling, is not a constraint.
export function darknessWindows(sunAt: (time: Time) => Vec3, location: GeographicPosition, start: Time, end: Time, options: DarknessOptions = {}): DarknessWindows {
	if (options.maximumMoonAltitude !== undefined && options.moonAt === undefined) throw new RangeError('moon direction is required when a lunar altitude limit is set')
	if (options.maximumMoonIllumination !== undefined && options.moonIlluminationAt === undefined) throw new RangeError('moon illumination is required when an illumination limit is set')

	const sunAltitude = (time: Time) => altitudeOf(sunAt(time), time, location)
	const civil = intervalsBelow(sunAltitude, CIVIL_TWILIGHT, start, end, options)
	const nautical = intervalsBelow(sunAltitude, NAUTICAL_TWILIGHT, start, end, options)
	const astronomical = intervalsBelow(sunAltitude, ASTRONOMICAL_TWILIGHT, start, end, options)
	let dark: readonly DarknessInterval[] = astronomical

	if (options.moonAt !== undefined) {
		const ceiling = options.maximumMoonAltitude ?? 0
		const moonAt = options.moonAt
		dark = intersect(dark, (time) => ceiling - altitudeOf(moonAt(time), time, location), options)
	}

	if (options.moonIlluminationAt !== undefined && options.maximumMoonIllumination !== undefined) {
		const illuminationAt = options.moonIlluminationAt
		const ceiling = options.maximumMoonIllumination
		dark = intersect(dark, (time) => ceiling - illuminationAt(time), options)
	}

	return { civil, nautical, astronomical, dark }
}
