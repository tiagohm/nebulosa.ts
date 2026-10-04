import { type Angle, normalizePI } from '../../math/units/angle'
import { MOON_ROTATION, subObserverPoint } from '../bodies/orientation'
import type { PositionOverTime } from '../coordinates/astrometry'
import { type Time, timeSubtract } from '../time/time'
import { searchExtrema, type TimeSearchOptions } from './search'

// Lunar libration extrema from an explicit Moon-center-to-observer base-frame direction.
// Uses the IAU/WGCCRE MOON_ROTATION model at observer epoch minus range/c, without selecting
// Earth or an ephemeris. Providers must retain their AU ranges to set that light delay. Angles are
// radians. Signed libration longitude must remain away from the +/-PI cut over the search window,
// as it does for terrestrial observers; wrapping through 0/TAU is handled before scanning.

// One local extremum of signed libration longitude or latitude.
export interface LunarLibrationExtremum {
	// Longitude (east-positive) or latitude (north-positive) of the sub-observer point.
	readonly axis: 'longitude' | 'latitude'
	// Local minimum or maximum of the signed angle.
	readonly kind: 'minimum' | 'maximum'
	// Refined epoch inside the search window.
	readonly time: Time
	// Signed angle in radians; longitude in (-PI, PI], latitude in [-PI/2, PI/2].
	readonly angle: Angle
}

const LUNAR_LIBRATION_AXES = ['longitude', 'latitude'] as const

// Finds independent longitude/latitude extrema inside start/stop, with caller step and tolerance.
// moonToObserverAt supplies Moon-center-to-observer positions in AU/library-base axes, at the selected
// correction stage. Returns newly allocated records sorted chronologically; endpoint extrema are
// excluded. The providers must describe ordinary libration, without crossing the signed +/-PI cut.
export function lunarLibrationExtrema(moonToObserverAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): LunarLibrationExtremum[] {
	const events: LunarLibrationExtremum[] = []

	for (const axis of LUNAR_LIBRATION_AXES) {
		function angleAt(time: Time) {
			const point = subObserverPoint(MOON_ROTATION, time, moonToObserverAt(time))
			return axis === 'longitude' ? normalizePI(point.longitude) : point.latitude
		}

		for (const event of searchExtrema(angleAt, start, stop, options)) {
			events.push({ axis, kind: event.kind, time: event.time, angle: event.value })
		}
	}

	return events.sort((a, b) => timeSubtract(a.time, b.time))
}
