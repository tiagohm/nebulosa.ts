import { AU_KM, SPEED_OF_LIGHT_AU_DAY } from '../../core/constants'
import { type Vec3, vecAngle, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import { brentRoot } from '../../math/numerical/optimization'
import type { Angle } from '../../math/units/angle'
import { callisto, europa, ganymede, io } from '../ephemeris/models/analytical/l12'
import { earth, jupiter, sun } from '../ephemeris/models/analytical/vsop87e'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { searchExtrema, type TimeSearchOptions } from './search'

// Mutual events between the Galilean satellites of Jupiter: the instants when one moon occults another
// (passes in front of it as seen from Earth) or eclipses it (casts its shadow on it). This is the
// detection layer only — the times, the pair, which body is in front or casting the shadow, and how
// central the event is — not the photometry: no light curve, obscured-area fraction or magnitude drop.
//
// Positions come from the L1.2 Galilean theory (Jovicentric, J2000 equatorial, AU) added to the VSOP87E
// Jupiter position, so every body shares one barycentric ICRF frame. Occultations are evaluated from the
// apparent geocentric directions of the two moons, each corrected for its own light time; eclipses are
// evaluated from the heliocentric shadow geometry at the physical instant, then reported at the
// light-time-delayed instant they are seen from Earth. The finder reuses the shared time-domain scanner
// to locate the separation minima and Brent's method to bracket the contacts. All angles are radians.

// A Galilean satellite of Jupiter.
export type GalileanMoon = 'io' | 'europa' | 'ganymede' | 'callisto'

// Kind of mutual event: an occultation (one moon in front of the other) or an eclipse (one moon's shadow
// on the other).
export type MutualEventKind = 'occultation' | 'eclipse'

// One Galilean satellite's ephemeris and physical radius.
interface MoonData {
	// L1.2 Jovicentric position+velocity (AU, J2000 equatorial).
	readonly ephemeris: (time: Time) => readonly [Vec3, Vec3]
	// Mean physical radius in AU.
	readonly radius: number
}

// Physical radii from the IAU/JPL mean values (km): Io 1821.6, Europa 1560.8, Ganymede 2631.2, Callisto
// 2410.3, converted to AU.
const GALILEAN: Record<GalileanMoon, MoonData> = {
	io: { ephemeris: io, radius: 1821.6 / AU_KM },
	europa: { ephemeris: europa, radius: 1560.8 / AU_KM },
	ganymede: { ephemeris: ganymede, radius: 2631.2 / AU_KM },
	callisto: { ephemeris: callisto, radius: 2410.3 / AU_KM },
}

// The four moons in orbital order, used to enumerate the six unordered pairs.
const GALILEAN_MOONS: readonly GalileanMoon[] = ['io', 'europa', 'ganymede', 'callisto']

// Solar photospheric radius in AU (IAU 2015 nominal radius 695700 km), for the penumbral shadow cone.
const SUN_RADIUS_AU = 695700 / AU_KM

// Default coarse sampling step for the separation-minimum search: 20 minutes, in days. A Galilean
// conjunction valley is hours wide, so this brackets every separation minimum while staying cheap.
const DEFAULT_STEP = 1200 / 86400

// Half-width in days of the window searched on each side of a separation minimum for the first and last
// contact: 6 hours, comfortably longer than any Galilean mutual event.
const CONTACT_WINDOW = 0.25

// Separation geometry of a moon pair for one event kind at one instant.
interface PairGeometry {
	// Separation to compare against the contact limit: angular (radians) for occultation, linear
	// perpendicular distance (AU) for eclipse.
	readonly separation: number
	// Contact-limit separation: an event exists while separation < limit.
	readonly limit: number
	// The moon in front (occultation) or casting the shadow (eclipse).
	readonly front: GalileanMoon
	// The moon behind (occultation) or being shadowed (eclipse).
	readonly back: GalileanMoon
	// Whether the geometry admits an event at all (always true for occultation; requires the shadowed moon
	// to be behind the caster for eclipse).
	readonly valid: boolean
}

// A detected mutual event between two Galilean moons.
export interface MutualEvent {
	// Whether one moon passes in front of the other (occultation) or shadows it (eclipse).
	readonly kind: MutualEventKind
	// The moon in front (occultation) or casting the shadow (eclipse).
	readonly front: GalileanMoon
	// The moon behind (occultation) or being shadowed (eclipse).
	readonly back: GalileanMoon
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

// Barycentric position of a Galilean moon (AU, ICRF): the VSOP87E Jupiter position plus the L1.2
// Jovicentric offset.
function moonPosition(moon: GalileanMoon, time: Time): Vec3 {
	return vecPlus(jupiter(time)[0], GALILEAN[moon].ephemeris(time)[0])
}

// Apparent direction from a fixed barycentric observer to a moon, corrected for the moon's light time.
// The observer stays at `observer` (its position at the observation instant); the moon is retarded so the
// pair is seen as it appears at that instant.
function apparentDirection(moon: GalileanMoon, observer: Vec3, time: Time): Vec3 {
	let delay = 0
	let direction: Vec3 = [0, 0, 0]
	for (let i = 0; i < 3; i++) {
		direction = vecMinus(moonPosition(moon, timeShift(time, -delay)), observer)
		delay = vecLength(direction) / SPEED_OF_LIGHT_AU_DAY
	}
	return direction
}

// Occultation geometry of a moon pair at an observation instant: the apparent angular separation of the
// two moons seen from Earth, the contact-limit separation (sum of their apparent angular radii) and which
// moon is in front (nearer Earth). Only the direction of light matters here, so both moons are taken at
// their own light-retarded positions.
function occultation(a: GalileanMoon, b: GalileanMoon, time: Time): PairGeometry {
	const observer = earth(time)[0]
	const da = apparentDirection(a, observer, time)
	const db = apparentDirection(b, observer, time)
	const ra = vecLength(da)
	const rb = vecLength(db)
	const separation = vecAngle(da, db)
	const limit = GALILEAN[a].radius / ra + GALILEAN[b].radius / rb
	const aInFront = ra < rb
	return { separation, limit, front: aInFront ? a : b, back: aInFront ? b : a, valid: true }
}

// Eclipse geometry of a moon pair at a physical instant: the perpendicular distance of the shadowed moon
// from the shadow axis, the contact-limit distance (the penumbral shadow radius plus the shadowed moon's
// radius) and which moon casts the shadow (nearer the Sun). `valid` is false when the shadowed moon is
// not behind the caster (no eclipse is geometrically possible); the separation stays finite so the
// scanner never sees a discontinuity.
function eclipse(a: GalileanMoon, b: GalileanMoon, time: Time): PairGeometry {
	const star = sun(time)[0]
	const sa = vecMinus(moonPosition(a, time), star)
	const sb = vecMinus(moonPosition(b, time), star)

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
	const limit = GALILEAN[caster].radius + GALILEAN[shadowed].radius + Math.max(0, along) * Math.tan(sunAngularRadius)
	return { separation: perpendicular, limit, front: caster, back: shadowed, valid: along > 0 }
}

// One-way light time in days from a physical instant at a moon to the geocentric observer, used to report
// eclipses at the moment they are seen from Earth.
function earthLightTime(moon: GalileanMoon, time: Time): number {
	return vecLength(vecMinus(moonPosition(moon, time), earth(time)[0])) / SPEED_OF_LIGHT_AU_DAY
}

// Extracts the events of one kind for one moon pair over the window.
//
// The separation is sampled at the coarse step and its minima are located by the shared scanner; a
// minimum below the contact limit is an event. First and last contact are the sign changes of
// (separation - limit) bracketing the minimum, found with Brent's method; a contact that does not fall in
// the search window (or the window edge) is left undefined. Eclipse times are shifted by the Earth light
// time so they are reported as seen from Earth.
function findPairEvents(kind: MutualEventKind, a: GalileanMoon, b: GalileanMoon, start: Time, stop: Time, options: TimeSearchOptions): MutualEvent[] {
	const geometry = kind === 'occultation' ? occultation : eclipse
	const separationAt = (time: Time) => geometry(a, b, time).separation
	const gapAt = (time: Time) => {
		const g = geometry(a, b, time)
		return g.separation - g.limit
	}

	const events: MutualEvent[] = []

	for (const minimum of searchExtrema(separationAt, start, stop, options)) {
		if (minimum.kind !== 'minimum') continue
		const state = geometry(a, b, minimum.time)
		if (!state.valid || state.separation >= state.limit) continue

		const middle = minimum.time
		const observedShift = kind === 'eclipse' ? earthLightTime(state.back, middle) : 0

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

// Finds every mutual occultation and eclipse among the four Galilean satellites over a time window.
//
// Both event kinds are screened for all six moon pairs and returned chronologically. Occultation times
// are the instants the events are seen from Earth (each moon light-time corrected); eclipse times are
// likewise shifted to when the shadowed moon is seen from Earth, but the geometry is sampled in physical
// time, so eclipses near the window edges may fall a light time (~35-50 min) outside [start, stop].
// `step` must stay well under the width of a conjunction so consecutive minima bracket cleanly; it
// defaults to 20 minutes. Mutual events only occur in the seasons around Jupiter's equinox (every ~6
// years), so most windows return nothing.
export function galileanMutualEvents(start: Time, stop: Time, options: TimeSearchOptions = {}): MutualEvent[] {
	const step = options.step ?? DEFAULT_STEP
	const scan: TimeSearchOptions = { step, tolerance: options.tolerance }
	const events: MutualEvent[] = []

	for (let i = 0; i < GALILEAN_MOONS.length; i++) {
		for (let j = i + 1; j < GALILEAN_MOONS.length; j++) {
			const a = GALILEAN_MOONS[i]
			const b = GALILEAN_MOONS[j]
			events.push(...findPairEvents('occultation', a, b, start, stop, scan))
			events.push(...findPairEvents('eclipse', a, b, start, stop, scan))
		}
	}

	events.sort((x, y) => timeSubtract(x.middle, y.middle))
	return events
}
