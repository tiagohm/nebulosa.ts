import { DEG2RAD, ONE_SECOND } from '../../core/constants'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { altitudeOf, riseTransitSet, STANDARD_HORIZON } from './horizon'
import type { TimeSearchOptions } from './search'

// Classical heliacal phenomena: the four annual first/last-visibility events of a star or planet, using an
// arcus-visionis (arc of vision) model rather than a full sky-brightness photometric model.
//
// As the Sun moves along the ecliptic, a fixed object cycles once a year through four visibility
// transitions, each defined by which horizon the object is on (rising in the east / setting in the west)
// and which twilight the event happens in (morning, just before sunrise / evening, just after sunset):
//
//   - heliacal rising   — first morning the object is seen rising in the east before dawn (emerges from the
//                          solar glare on the morning side; the famous Sothic rising of Sirius);
//   - acronychal rising — last evening the object is seen rising in the east at dusk (the opposition-side
//                          boundary, after which it rises before the sky is dark enough);
//   - heliacal setting  — last evening the object is seen setting in the west after dusk (before it is lost
//                          in the solar glare going into conjunction);
//   - cosmical setting   — first morning the object is seen setting in the west before dawn (the
//                          opposition-side boundary, symmetric to the acronychal rising).
//
// The visibility test is the arcus visionis: at the instant the object crosses the horizon (its rise or set,
// including refraction through the chosen horizon), the object is visible only if the Sun is at least
// `arcusVisionis` below the (geometric) horizon. A bright object needs a smaller depression than a faint
// one, so the arc of vision stands in for the object's brightness and the sky-brightness threshold; the
// classical value for a first-magnitude star such as Sirius is about 11 deg. This is a geometric,
// per-observer criterion (no sky-brightness integration, no extinction-vs-magnitude model), adequate for
// the calendar-scale dating these events are used for.
//
// Each event is the day the corresponding combination's visibility switches: heliacal rising and cosmical
// setting are the first visible day of the morning rise / morning set season; acronychal rising and heliacal
// setting are the last visible day of the evening rise / evening set season. Angles are radians. The window
// should span a full year and start near the object's conjunction (all four combinations invisible) so each
// season's boundary falls inside it. Circumpolar or never-rising objects have no phases.

// One of the four classical heliacal phenomena.
export type HeliacalPhaseKind = 'heliacalRising' | 'acronychalRising' | 'heliacalSetting' | 'cosmicalSetting'

// A located heliacal phenomenon: the transition day, the object's horizon-crossing instant, and the arc of
// vision realized there.
export interface HeliacalPhase {
	// Which of the four phenomena this is.
	readonly kind: HeliacalPhaseKind
	// Instant of the object's rise (rising phenomena) or set (setting phenomena) on the transition day.
	readonly time: Time
	// Sun depression below the geometric horizon at that crossing, radians; at least `arcusVisionis`.
	readonly arcusVisionis: Angle
}

// Options for the heliacal-phase scan.
export interface HeliacalPhaseOptions extends TimeSearchOptions {
	// Required Sun depression below the horizon for the object to be visible at its crossing, radians.
	// Defaults to 11 deg, the classical arc of vision of a first-magnitude star. Larger values (fainter
	// object, worse sky) push first visibility later and last visibility earlier.
	readonly arcusVisionis?: Angle
	// Horizon altitude the object's rise/set is measured against, radians. Defaults to STANDARD_HORIZON
	// (point-source refraction at the sea horizon).
	readonly horizon?: Angle
}

// Default arc of vision: 11 deg, the classical value for a first-magnitude star (e.g. Sirius).
const DEFAULT_ARCUS_VISIONIS: Angle = 11 * DEG2RAD

// Per-day visibility of one horizon crossing (a rise or a set) in one twilight (morning or evening).
interface CrossingSample {
	// Whether the object is above the arc-of-vision threshold at the crossing this day.
	readonly visible: boolean
	// Instant of the crossing this day, when it exists and belongs to this combination.
	readonly time?: Time
	// Sun depression below the horizon at the crossing, radians.
	readonly depression: number
}

// A not-visible placeholder for a day whose crossing is absent or belongs to the other twilight.
const ABSENT: CrossingSample = { visible: false, depression: 0 }

// Classifies a horizon crossing as morning (Sun ascending toward sunrise) or evening (Sun descending after
// sunset) and measures the Sun's depression there. Returns undefined when the crossing does not exist.
//
// `sun` is the geocentric J2000/ICRS Sun direction sampler; `crossing` is the object's rise or set instant.
function classifyCrossing(sun: (time: Time) => Vec3, location: GeographicPosition, crossing: Time | undefined, arcusVisionis: Angle): { morning: boolean; sample: CrossingSample } | undefined {
	if (crossing === undefined) return undefined

	const altitude = altitudeOf(sun(crossing), crossing, location)
	// Sun ascending one second later means dawn (morning); descending means dusk (evening).
	const later = timeShift(crossing, ONE_SECOND)
	const morning = altitudeOf(sun(later), later, location) > altitude
	const depression = -altitude
	return { morning, sample: { visible: depression >= arcusVisionis, time: crossing, depression } }
}

// First day a season becomes visible: the first interior day that is visible with its previous day not
// visible. Day 0 is skipped because its predecessor is outside the window, so a season already underway at
// the window start is not mistaken for a transition.
function firstOnset(samples: readonly CrossingSample[]): CrossingSample | undefined {
	for (let d = 1; d < samples.length; d++) {
		if (samples[d].visible && !samples[d - 1].visible) return samples[d]
	}
	return undefined
}

// Last day a season stays visible: the last interior day that is visible with its next day not visible. The
// final day is skipped because its successor is outside the window, so a season still open at the window end
// is not mistaken for a transition.
function lastOffset(samples: readonly CrossingSample[]): CrossingSample | undefined {
	for (let d = samples.length - 2; d >= 0; d--) {
		if (samples[d].visible && !samples[d + 1].visible) return samples[d]
	}
	return undefined
}

// Computes the four classical heliacal phenomena of an object over a time window, from one observer.
//
// `body` and `sun` return the geocentric J2000/ICRS direction toward the object and the Sun at a time (the
// natural output of the VSOP/ELP ephemerides and of icrs()); only the directions are used. `location` is
// the observer. The window [`start`, `stop`] should span a full year starting near the object's conjunction.
//
// Each day, the object's rise and set (through `horizon`) are found with the shared rise/transit/set finder;
// each crossing is classified into morning or evening from the Sun's motion and tested against the arc of
// vision. The morning-rise and morning-set seasons yield the heliacal rising and cosmical setting at their
// first visible day; the evening-rise and evening-set seasons yield the acronychal rising and heliacal
// setting at their last visible day. Only the phenomena whose transition falls inside the window are
// returned; results are chronological. A circumpolar or never-rising object returns none.
export function heliacalPhases(body: (time: Time) => Vec3, sun: (time: Time) => Vec3, location: GeographicPosition, start: Time, stop: Time, { arcusVisionis = DEFAULT_ARCUS_VISIONIS, horizon = STANDARD_HORIZON, step, tolerance }: HeliacalPhaseOptions = {}): HeliacalPhase[] {
	const span = timeSubtract(stop, start)
	if (span <= 0) return []

	// Per-day visibility of the four (crossing, twilight) combinations across the window.
	const morningRise: CrossingSample[] = []
	const eveningRise: CrossingSample[] = []
	const morningSet: CrossingSample[] = []
	const eveningSet: CrossingSample[] = []

	const days = Math.ceil(span)
	for (let d = 0; d < days; d++) {
		const dayStart = timeShift(start, d)
		const rts = riseTransitSet(body, location, dayStart, { horizon, step, tolerance })

		const rise = classifyCrossing(sun, location, rts.rise, arcusVisionis)
		const set = classifyCrossing(sun, location, rts.set, arcusVisionis)

		// A crossing feeds only its own twilight bucket; the others get the not-visible placeholder.
		morningRise.push(rise && rise.morning ? rise.sample : ABSENT)
		eveningRise.push(rise && !rise.morning ? rise.sample : ABSENT)
		morningSet.push(set && set.morning ? set.sample : ABSENT)
		eveningSet.push(set && !set.morning ? set.sample : ABSENT)
	}

	const phases: HeliacalPhase[] = []
	const add = (kind: HeliacalPhaseKind, sample: CrossingSample | undefined) => {
		if (sample?.time !== undefined) phases.push({ kind, time: sample.time, arcusVisionis: sample.depression })
	}

	add('heliacalRising', firstOnset(morningRise))
	add('cosmicalSetting', firstOnset(morningSet))
	add('acronychalRising', lastOffset(eveningRise))
	add('heliacalSetting', lastOffset(eveningSet))

	phases.sort((a, b) => timeSubtract(a.time, b.time))
	return phases
}
