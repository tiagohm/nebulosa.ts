import { AU_KM, SPEED_OF_LIGHT_AU_DAY } from '../../core/constants'
import { type Vec3, vecAngle, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import { brentRoot } from '../../math/numerical/optimization'
import { callisto, europa, ganymede, io } from '../ephemeris/models/analytical/l12'
import { dione, enceladus, iapetus, mimas, rhea, tethys, titan } from '../ephemeris/models/analytical/tass17'
import { earth, jupiter, saturn, sun } from '../ephemeris/models/analytical/vsop87e'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { searchExtrema, type TimeSearchOptions } from './search'

// Mutual events between the major satellites of a giant planet: the instants when one moon occults
// another (passes in front of it as seen from Earth) or eclipses it (casts its shadow on it). This is the
// detection layer only — the times, the pair, which body is in front or casting the shadow, the contacts,
// and how central the event is — not the photometry: no light curve, obscured-area fraction or magnitude
// drop. Jupiter's Galilean moons (L1.2 theory) and Saturn's main moons (TASS 1.7) are supported.
//
// Positions come from the satellite theory (planetocentric, J2000 equatorial, AU) added to the VSOP87E
// planet position, so every body shares one barycentric ICRF frame. Occultations are evaluated from the
// apparent geocentric directions of the two moons, each corrected for its own light time; eclipses are
// evaluated from the heliocentric shadow geometry at the physical instant, then reported at the
// light-time-delayed instant they are seen from Earth. The finder reuses the shared time-domain scanner
// to locate the separation minima and Brent's method to bracket the contacts. All angles are radians.

// A Galilean satellite of Jupiter.
export type GalileanMoon = 'io' | 'europa' | 'ganymede' | 'callisto'

// A major Saturnian satellite covered by TASS 1.7 (Hyperion is omitted: its chaotic rotation makes it a
// poor mutual-event target and its disk is tiny).
export type SaturnianMoon = 'mimas' | 'enceladus' | 'tethys' | 'dione' | 'rhea' | 'titan' | 'iapetus'

// Kind of mutual event: an occultation (one moon in front of the other) or an eclipse (one moon's shadow
// on the other).
export type MutualEventKind = 'occultation' | 'eclipse'

// One satellite's ephemeris and physical radius.
interface MoonData {
	// Planetocentric position+velocity (AU, J2000 equatorial) from the satellite theory.
	readonly ephemeris: (time: Time) => readonly [Vec3, Vec3]
	// Mean physical radius in AU.
	readonly radius: number
}

// A planet and its moon set for the mutual-event finder.
interface MutualSystem<M extends string> {
	// Barycentric position of the planet (AU, ICRF) from VSOP87E.
	readonly planet: (time: Time) => readonly [Vec3, Vec3]
	// Ephemeris and radius of each moon.
	readonly moons: Record<M, MoonData>
	// The moons in orbital order, enumerated pairwise.
	readonly order: readonly M[]
}

// Solar photospheric radius in AU (IAU 2015 nominal radius 695700 km), for the penumbral shadow cone.
const SUN_RADIUS_AU = 695700 / AU_KM

// Default coarse sampling step for the separation-minimum search: 10 minutes, in days. A conjunction
// valley is tens of minutes to hours wide, so this brackets every separation minimum, including the fast
// inner Saturnian pairs, while staying cheap.
const DEFAULT_STEP = 600 / 86400

// Half-width in days of the window searched on each side of a separation minimum for the first and last
// contact: 6 hours, comfortably longer than any mutual event.
const CONTACT_WINDOW = 0.25

// Days the eclipse scan reaches back before the window start so that eclipses whose physical instant
// precedes the window but whose Earth-seen instant falls inside it are still found. It exceeds the
// Earth-satellite light time of both planets (Jupiter ~54 min, Saturn ~91 min at their farthest).
const ECLIPSE_LIGHT_TIME_PAD = 0.08

// Days the scan is padded on each side of the requested window, so an event that overlaps the window but
// whose minimum lies just outside it (or too close to an edge for searchExtrema to bracket) is still
// found. It exceeds the half-duration of any mutual event (~72 min).
const EVENT_PAD = 0.05

// Jupiter's four Galilean moons. Radii are the IAU/JPL mean values (km): Io 1821.6, Europa 1560.8,
// Ganymede 2631.2, Callisto 2410.3.
const JUPITER_SYSTEM: MutualSystem<GalileanMoon> = {
	planet: jupiter,
	order: ['io', 'europa', 'ganymede', 'callisto'],
	moons: {
		io: { ephemeris: io, radius: 1821.6 / AU_KM },
		europa: { ephemeris: europa, radius: 1560.8 / AU_KM },
		ganymede: { ephemeris: ganymede, radius: 2631.2 / AU_KM },
		callisto: { ephemeris: callisto, radius: 2410.3 / AU_KM },
	},
}

// Saturn's main moons. Radii are the IAU/JPL mean values (km): Mimas 198.2, Enceladus 252.1, Tethys
// 531.1, Dione 561.4, Rhea 763.8, Titan 2575 (solid surface), Iapetus 734.5.
const SATURN_SYSTEM: MutualSystem<SaturnianMoon> = {
	planet: saturn,
	order: ['mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus'],
	moons: {
		mimas: { ephemeris: mimas, radius: 198.2 / AU_KM },
		enceladus: { ephemeris: enceladus, radius: 252.1 / AU_KM },
		tethys: { ephemeris: tethys, radius: 531.1 / AU_KM },
		dione: { ephemeris: dione, radius: 561.4 / AU_KM },
		rhea: { ephemeris: rhea, radius: 763.8 / AU_KM },
		titan: { ephemeris: titan, radius: 2575 / AU_KM },
		iapetus: { ephemeris: iapetus, radius: 734.5 / AU_KM },
	},
}

// Separation geometry of a moon pair for one event kind at one instant.
interface PairGeometry<M extends string> {
	// Separation to compare against the contact limit: angular (radians) for occultation, linear
	// perpendicular distance (AU) for eclipse.
	readonly separation: number
	// Contact-limit separation: an event exists while separation < limit.
	readonly limit: number
	// The moon in front (occultation) or casting the shadow (eclipse).
	readonly front: M
	// The moon behind (occultation) or being shadowed (eclipse).
	readonly back: M
	// Whether the geometry admits an event at all (always true for occultation; requires the shadowed moon
	// to be behind the caster for eclipse).
	readonly valid: boolean
}

// A detected mutual event between two moons.
export interface MutualEvent<M extends string = string> {
	// Whether one moon passes in front of the other (occultation) or shadows it (eclipse).
	readonly kind: MutualEventKind
	// The moon in front (occultation) or casting the shadow (eclipse).
	readonly front: M
	// The moon behind (occultation) or being shadowed (eclipse).
	readonly back: M
	// First contact, or undefined when the event is already underway at the window start.
	readonly start?: Time
	// Instant of maximum obscuration (minimum separation).
	readonly middle: Time
	// Last contact, or undefined when the event is still underway at the window end.
	readonly end?: Time
	// Closeness of the event: the minimum separation divided by the contact-limit separation, in [0, 1).
	// Zero is a central event; near one is a grazing one.
	readonly impactParameter: number
}

// Barycentric position of a moon (AU, ICRF): the VSOP87E planet position plus the planetocentric offset.
function moonPosition<M extends string>(system: MutualSystem<M>, moon: M, time: Time): Vec3 {
	return vecPlus(system.planet(time)[0], system.moons[moon].ephemeris(time)[0])
}

// Apparent direction from a fixed barycentric observer to a moon, corrected for the moon's light time.
// The observer stays at `observer` (its position at the observation instant); the moon is retarded so the
// pair is seen as it appears at that instant.
function apparentDirection<M extends string>(system: MutualSystem<M>, moon: M, observer: Vec3, time: Time): Vec3 {
	let delay = 0
	let direction: Vec3 = [0, 0, 0]
	for (let i = 0; i < 3; i++) {
		direction = vecMinus(moonPosition(system, moon, timeShift(time, -delay)), observer)
		delay = vecLength(direction) / SPEED_OF_LIGHT_AU_DAY
	}
	return direction
}

// Occultation geometry of a moon pair at an observation instant: the apparent angular separation of the
// two moons seen from Earth, the contact-limit separation (sum of their apparent angular radii) and which
// moon is in front (nearer Earth). Only the direction of light matters here, so both moons are taken at
// their own light-retarded positions.
function occultation<M extends string>(system: MutualSystem<M>, a: M, b: M, time: Time): PairGeometry<M> {
	const observer = earth(time)[0]
	const da = apparentDirection(system, a, observer, time)
	const db = apparentDirection(system, b, observer, time)
	const ra = vecLength(da)
	const rb = vecLength(db)
	const separation = vecAngle(da, db)
	const limit = system.moons[a].radius / ra + system.moons[b].radius / rb
	const aInFront = ra < rb
	return { separation, limit, front: aInFront ? a : b, back: aInFront ? b : a, valid: true }
}

// Eclipse geometry of a moon pair at a physical instant: the perpendicular distance of the shadowed moon
// from the shadow axis, the contact-limit distance (the penumbral shadow radius plus the shadowed moon's
// radius) and which moon casts the shadow (nearer the Sun). `valid` is false when the shadowed moon is
// not behind the caster (no eclipse is geometrically possible); the separation stays finite so the
// scanner never sees a discontinuity.
function eclipse<M extends string>(system: MutualSystem<M>, a: M, b: M, time: Time): PairGeometry<M> {
	const star = sun(time)[0]
	const sa = vecMinus(moonPosition(system, a, time), star)
	const sb = vecMinus(moonPosition(system, b, time), star)

	// The caster is the moon nearer the Sun; the other is the one that can fall in its shadow.
	const aIsCaster = vecLength(sa) < vecLength(sb)
	const caster = aIsCaster ? a : b
	const shadowed = aIsCaster ? b : a
	const casterToSun = aIsCaster ? sa : sb
	const shadowedToSun = aIsCaster ? sb : sa

	const axis = vecNormalize(casterToSun)
	const relative = vecMinus(shadowedToSun, casterToSun)
	const along = vecDot(relative, axis)
	const perpendicular = vecLength(vecMinus(relative, vecMulScalar(axis, along)))
	// Penumbral shadow radius at the shadowed moon: the caster's radius widened by the Sun's angular size
	// over the caster-to-shadowed distance, plus the shadowed moon's own radius.
	const sunAngularRadius = SUN_RADIUS_AU / vecLength(casterToSun)
	const limit = system.moons[caster].radius + system.moons[shadowed].radius + Math.max(0, along) * Math.tan(sunAngularRadius)
	return { separation: perpendicular, limit, front: caster, back: shadowed, valid: along > 0 }
}

// One-way light time in days from a physical instant at a moon to the geocentric observer, used to report
// eclipses at the moment they are seen from Earth.
function earthLightTime<M extends string>(system: MutualSystem<M>, moon: M, time: Time): number {
	return vecLength(vecMinus(moonPosition(system, moon, time), earth(time)[0])) / SPEED_OF_LIGHT_AU_DAY
}

// Extracts the events of one kind for one moon pair over the window.
//
// The separation is sampled at the coarse step and its minima are located by the shared scanner; a
// minimum below the contact limit is an event. First and last contact are the sign changes of
// (separation - limit) bracketing the minimum, found with Brent's method; a contact that does not fall in
// the search window (or the window edge) is left undefined. Eclipse times are shifted by the Earth light
// time so they are reported as seen from Earth.
function findPairEvents<M extends string>(system: MutualSystem<M>, kind: MutualEventKind, a: M, b: M, start: Time, stop: Time, options: TimeSearchOptions): MutualEvent<M>[] {
	const geometry = kind === 'occultation' ? occultation : eclipse
	const separationAt = (time: Time) => geometry(system, a, b, time).separation
	const gapAt = (time: Time) => {
		const g = geometry(system, a, b, time)
		return g.separation - g.limit
	}

	const events: MutualEvent<M>[] = []

	for (const minimum of searchExtrema(separationAt, start, stop, options)) {
		if (minimum.kind !== 'minimum') continue
		const state = geometry(system, a, b, minimum.time)
		if (!state.valid || state.separation >= state.limit) continue

		const middle = minimum.time
		const observedShift = kind === 'eclipse' ? earthLightTime(system, state.back, middle) : 0

		events.push({
			kind,
			front: state.front,
			back: state.back,
			start: bracketContact(gapAt, timeShift(middle, -CONTACT_WINDOW), middle, options.tolerance, observedShift),
			middle: timeShift(middle, observedShift),
			end: bracketContact(gapAt, middle, timeShift(middle, CONTACT_WINDOW), options.tolerance, observedShift),
			impactParameter: state.separation / state.limit,
		})
	}

	return events
}

// Finds the contact instant (a sign change of `gap`) in [from, to], shifted by `observedShift` days, or
// undefined when `gap` keeps the same sign across the interval (the contact is outside the window).
function bracketContact(gap: (time: Time) => number, from: Time, to: Time, tolerance: number | undefined, observedShift: number): Time | undefined {
	const span = timeSubtract(to, from)
	const g = (x: number) => gap(timeShift(from, x))
	if (g(0) * g(span) > 0) return undefined
	const root = brentRoot(g, 0, span, { tolerance })
	return timeShift(from, root.root + observedShift)
}

// Keeps an event only if its span from first to last contact overlaps [windowStart, windowStop], and
// blanks the contacts that fall outside the window (a contact before the start, or after the stop, is
// reported as undefined, matching the "already underway" convention). The middle is left as the true
// instant of maximum obscuration even when it lies just outside the window.
function clipToWindow<M extends string>(event: MutualEvent<M>, windowStart: Time, windowStop: Time): MutualEvent<M> | undefined {
	const first = event.start ?? event.middle
	const last = event.end ?? event.middle
	if (timeSubtract(first, windowStop) > 0 || timeSubtract(last, windowStart) < 0) return undefined

	const start = event.start !== undefined && timeSubtract(event.start, windowStart) >= 0 && timeSubtract(event.start, windowStop) <= 0 ? event.start : undefined
	const end = event.end !== undefined && timeSubtract(event.end, windowStart) >= 0 && timeSubtract(event.end, windowStop) <= 0 ? event.end : undefined
	return { ...event, start, end }
}

// Finds every mutual occultation and eclipse among a planet's moons over a time window.
//
// Each pair and kind is scanned over the requested window padded on both sides, so an event that overlaps
// the window but whose minimum lies just outside it is still found; the results are then clipped back to
// the window. Occultations are scanned in observed time; eclipses are scanned in physical time reaching
// an extra light time before the start, then reported at the light-time-delayed instant seen from Earth.
function mutualEvents<M extends string>(system: MutualSystem<M>, start: Time, stop: Time, options: TimeSearchOptions): MutualEvent<M>[] {
	const scan: TimeSearchOptions = { step: options.step ?? DEFAULT_STEP, tolerance: options.tolerance }
	const paddedStart = timeShift(start, -EVENT_PAD)
	const paddedStop = timeShift(stop, EVENT_PAD)
	const eclipseStart = timeShift(paddedStart, -ECLIPSE_LIGHT_TIME_PAD)
	const events: MutualEvent<M>[] = []

	for (let i = 0; i < system.order.length; i++) {
		for (let j = i + 1; j < system.order.length; j++) {
			const a = system.order[i]
			const b = system.order[j]
			for (const event of findPairEvents(system, 'occultation', a, b, paddedStart, paddedStop, scan)) {
				const clipped = clipToWindow(event, start, stop)
				if (clipped !== undefined) events.push(clipped)
			}
			for (const event of findPairEvents(system, 'eclipse', a, b, eclipseStart, paddedStop, scan)) {
				const clipped = clipToWindow(event, start, stop)
				if (clipped !== undefined) events.push(clipped)
			}
		}
	}

	events.sort((x, y) => timeSubtract(x.middle, y.middle))
	return events
}

// Finds every mutual occultation and eclipse among the four Galilean satellites over a time window.
//
// Both event kinds are screened for all six moon pairs and returned chronologically. All times are the
// instants the events are seen from Earth (each moon light-time corrected). `step` must stay well under
// the width of a conjunction so consecutive minima bracket cleanly; it defaults to 10 minutes. Mutual
// events only occur in the seasons around Jupiter's equinox (every ~6 years), so most windows return
// nothing.
export function galileanMutualEvents(start: Time, stop: Time, options: TimeSearchOptions = {}): MutualEvent<GalileanMoon>[] {
	return mutualEvents(JUPITER_SYSTEM, start, stop, options)
}

// Finds every mutual occultation and eclipse among Saturn's main moons over a time window.
//
// Screens all twenty-one pairs of the seven moons for both event kinds, chronologically, with the same
// light-time conventions as galileanMutualEvents. Saturn's mutual-event seasons fall around its equinox
// (every ~15 years, most recently the 2025 ring-plane crossing), so most windows return nothing.
export function saturnianMutualEvents(start: Time, stop: Time, options: TimeSearchOptions = {}): MutualEvent<SaturnianMoon>[] {
	return mutualEvents(SATURN_SYSTEM, start, stop, options)
}
