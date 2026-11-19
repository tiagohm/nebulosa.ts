import { PI, PIOVERTWO } from '../../core/constants'
import { vecLength, vecLongitude, vecZero } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { type LunarApsis, type LunarPhase, moonSemidiameter, nearestLunarApsis, nearestLunarPhase } from '../bodies/moon'
import { type Season, season } from '../bodies/sun'
import { ecliptic } from '../coordinates/frame'
import { apparentGeocentricPosition, type EphemerisSource, relativeEphemerisState } from '../ephemeris/source'
import { type Time, timeShift, timeSubtract, tt } from '../time/time'
import { planetaryLongitudeCrossings } from './planetary'
import { searchExtrema, searchRoots } from './search'

// Almanac events of the Moon and the Sun over an ephemeris source: the principal lunar phases, the lunar perigees and
// apogees, and the equinoxes and solstices. Each event starts from the instant of Meeus' series (Astronomical
// Algorithms, chapters 49, 50, and 27), a seed that names the event, and is refined on the states of the source alone,
// so its instant is that of the source: against a search over DE440s, the series err by up to 17 s for the phases,
// 32 min for the perigees, 3 min for the apogees, and 41 s for the seasons (2000–2030), and the refinement on the
// analytical source by under a second. Phases and seasons are conditions on the true ecliptic longitudes of date of
// the apparent geocentric Moon and Sun (apparentGeocentricPosition); apsides are extrema of the geometric geocentric
// distance of the Moon. Instants are TT; a source that cannot give a state throws EphemerisMiss.

// Half-width, in days, of the window a phase or a season is refined in around its seed: 0.05 day (72 min), far beyond
// the error of the series over their range of validity.
const PHASE_WINDOW = 0.05

// Half-width, in days, of the window an apsis is refined in around its seed: 0.25 day (6 h), beyond the 32 min the
// perigee series errs by, whose periodic terms are truncated.
const APSIS_WINDOW = 0.25

// Coarse step, in days, of the extremum search of an apsis: the distance has one extremum in its window.
const APSIS_STEP = 0.05

// Time tolerance of the refinements, in days: about 9 ms.
const REFINEMENT_TOLERANCE = 1e-7

// Moon minus Sun apparent ecliptic longitude of each principal phase, in radians.
const PHASE_ELONGATION: Readonly<Record<LunarPhase, Angle>> = { NEW: 0, FIRST_QUARTER: PIOVERTWO, FULL: PI, LAST_QUARTER: PI + PIOVERTWO }

// Apparent ecliptic longitude of the Sun at the start of each astronomical season, in radians.
const SEASON_LONGITUDE: Readonly<Record<Season, Angle>> = { spring: 0, summer: PIOVERTWO, autumn: PI, winter: PI + PIOVERTWO }

// Finds the refined event nearest an instant in a direction: next selects the first one strictly after time, else the
// last one at or before it. seedOf returns the series event nearest an instant the same way, refine moves a seed to
// the event of the source, which stays within window days of it, and instantOf gives the instant of an event. The first
// seed is taken window days beyond time, so an event whose seed falls on the other side of time is not missed; when its
// refinement lands on the wrong side, the event that follows (or precedes) it is the answer.
function nearestRefinedEvent<T>(time: Time, next: boolean, window: number, seedOf: (time: Time, next: boolean) => Time, refine: (seed: Time) => T, instantOf: (event: T) => Time): T {
	time = tt(time)
	const seed = seedOf(timeShift(time, next ? -window : window), next)
	const event = refine(seed)
	const delta = timeSubtract(instantOf(event), time)
	if (next ? delta > 0 : delta <= 0) return event
	return refine(next ? seedOf(seed, true) : seedOf(timeShift(seed, -1), false))
}

// Instant, in days, of the first root of residual in [seed − window, seed + window] where accept also holds; throws
// when there is none, which the windows rule out for the series' events.
function refinedRoot(residual: (time: Time) => number, seed: Time, window: number, accept: (time: Time) => boolean): Time {
	const root = searchRoots(residual, timeShift(seed, -window), timeShift(seed, window), { step: window, tolerance: REFINEMENT_TOLERANCE }).find(accept)
	if (root === undefined) throw new Error('the almanac event was not found near its series instant')
	return root
}

// Refines a phase seed on a source: the instant the apparent ecliptic longitude of the Moon minus that of the Sun
// equals the elongation of the phase.
function refinedLunarPhase(source: EphemerisSource, seed: Time, elongation: Angle): Time {
	const moon = (time: Time) => apparentGeocentricPosition(source, 301, time)
	const sun = (time: Time) => apparentGeocentricPosition(source, 10, time)
	const [crossing] = planetaryLongitudeCrossings(moon, sun, timeShift(seed, -PHASE_WINDOW), timeShift(seed, PHASE_WINDOW), elongation, { step: PHASE_WINDOW, tolerance: REFINEMENT_TOLERANCE })
	if (crossing === undefined) throw new Error('the lunar phase was not found near its series instant')
	return crossing.time
}

// Refines an apsis seed on a source: the extremum of the geometric geocentric distance of the Moon (a minimum for the
// perigee), with that distance (AU) and the angular diameter of the Moon there (radians).
function refinedLunarApsis(source: EphemerisSource, seed: Time, apsis: LunarApsis): readonly [Time, Distance, Angle] {
	const distanceAt = (time: Time) => vecLength(relativeEphemerisState(source, 301, 399, time)[0])
	const kind = apsis === 'PERIGEE' ? 'minimum' : 'maximum'
	const extremum = searchExtrema(distanceAt, timeShift(seed, -APSIS_WINDOW), timeShift(seed, APSIS_WINDOW), { step: APSIS_STEP, tolerance: REFINEMENT_TOLERANCE }).find((e) => e.kind === kind)
	if (extremum === undefined) throw new Error('the lunar apsis was not found near its series instant')
	return [extremum.time, extremum.value, 2 * moonSemidiameter(extremum.value)]
}

// Computes the principal lunar phase nearest an instant on a source: next selects the first one strictly after time,
// false the last one at or before it. Returns a fresh TT instant.
export function nearestLunarPhaseOf(source: EphemerisSource, time: Time, phase: LunarPhase, next: boolean): Time {
	const elongation = PHASE_ELONGATION[phase]
	return nearestRefinedEvent(
		time,
		next,
		PHASE_WINDOW,
		(t, n) => nearestLunarPhase(t, phase, n),
		(seed) => refinedLunarPhase(source, seed, elongation),
		(event) => event,
	)
}

// Computes the lunar perigee or apogee nearest an instant on a source: next selects the first one strictly after time,
// false the last one at or before it. Returns the TT instant, the geometric geocentric distance of the Moon (AU), and its
// angular diameter (radians).
export function nearestLunarApsisOf(source: EphemerisSource, time: Time, apsis: LunarApsis, next: boolean): readonly [Time, Distance, Angle] {
	return nearestRefinedEvent(
		time,
		next,
		APSIS_WINDOW,
		(t, n) => nearestLunarApsis(t, apsis, n)[0],
		(seed) => refinedLunarApsis(source, seed, apsis),
		(event) => event[0],
	)
}

// Computes the start of an astronomical season of a year on a source: the instant the apparent ecliptic longitude of
// date of the Sun reaches 0 (spring, the March equinox), π/2 (summer, the June solstice), π (autumn), or 3π/2 (winter),
// the seasons named for the northern hemisphere. year is a Gregorian year within the range of Meeus' series (1000 to
// 3000). Returns a fresh TT instant.
export function seasonOf(source: EphemerisSource, year: number, name: Season): Time {
	const longitude = SEASON_LONGITUDE[name]
	const out = vecZero()
	const difference = (time: Time) => vecLongitude(ecliptic(apparentGeocentricPosition(source, 10, time), time, out)) - longitude
	return refinedRoot(
		(time) => Math.sin(difference(time)),
		season(year, name),
		PHASE_WINDOW,
		(time) => Math.cos(difference(time)) > 0,
	)
}
