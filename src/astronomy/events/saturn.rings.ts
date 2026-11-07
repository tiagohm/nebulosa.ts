import { AU_KM, SATURN_EQUATORIAL_RADIUS_AU, SATURN_POLAR_RADIUS_AU } from '../../core/constants'
import { vecDot, vecMinus, vecNormalize } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { SATURN_ROTATION } from '../bodies/orientation'
import { SATURNIAN_RADIUS_AU, type SaturnianBody, type SaturnianEphemeris, type SaturnianMoon } from '../ephemeris/saturnian'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { type PlanetModel, type PlanetSystemState, planetSystemState, type SkyBasis, skyBasis, skyPositionAngle } from './satellites.geometry'
import { searchExtrema, searchRoots, type TimeSearchOptions } from './search'

// Geocentric geometry of Saturn's rings: the signed opening angles of the ring plane toward the Earth and
// the Sun, the position angle of the projected pole, the apparent size of the disk and of the ring
// system, and the ring-plane seasons (the Earth's and the Sun's crossings of the ring plane and the
// extrema of the opening). The rings lie in Saturn's equatorial plane, whose north pole is the IAU
// SATURN_ROTATION pole; every quantity is physical geometry, not an image or a photometric model.
//
// Conventions. The observed instant is geocentric; Saturn is retarded for its light time and its pole and
// the ring plane are evaluated at that emission instant, with the Sun retarded for the Sun-to-Saturn light
// time (planetSystemState). The Earth opening B is the Saturnicentric (planetocentric) latitude of the
// Earth above the ring plane, asin(n · u), with n the pole and u the unit vector from Saturn toward the
// Earth; the solar opening B′ is the same for the Sun. Both are signed, positive when the body is north of
// the ring plane and so faces the rings' north side, in radians in [−π/2, π/2]. Horizons and other tables
// often give the planetodetic sub-observer latitude instead, which differs away from zero but crosses zero
// together with B. The pole position angle P is measured on the true equator of date from the celestial
// north toward the east, in (−π, π]. Apparent sizes are angular radii in radians. Times are observed
// geocentric instants. Ring-plane events come from root and extremum searches of B and B′, never from
// interpolated samples.
//
// Model. Ring radii are the named annuli of SATURN_RING_MODEL (km, NASA NSSDC Saturnian Rings Fact
// Sheet); Saturn's disk is the IAU 1-bar spheroid. The rings are treated as an infinitely thin annulus in
// the equatorial plane: the apparent ring outline is an ellipse whose semi-minor axis is the semi-major
// axis times |sin B|, and the ring edge-on condition is a display tolerance, not a physical thickness.

// Saturn as an oblate planet (IAU 1-bar radii, System III pole) with its seven major spherical moons.
export const SATURN_MODEL: PlanetModel<SaturnianBody, SaturnianMoon> = {
	planet: 'saturn',
	equatorialRadius: SATURN_EQUATORIAL_RADIUS_AU,
	polarRadius: SATURN_POLAR_RADIUS_AU,
	rotation: SATURN_ROTATION,
	moonRadius: SATURNIAN_RADIUS_AU,
}

// A named ring annulus, by its Saturnicentric radii.
export interface SaturnRingAnnulus {
	// The ring or division: the C, B and A rings and the Cassini Division between B and A.
	readonly name: 'C' | 'B' | 'cassini' | 'A'
	// Inner radius (km).
	readonly inner: number
	// Outer radius (km); larger than inner.
	readonly outer: number
	// Whether the annulus is a division, mostly empty, rather than a dense ring.
	readonly division: boolean
}

// A versioned table of ring radii.
export interface SaturnRingModel {
	// Version of the adopted radii; changes whenever a radius or the annulus list changes.
	readonly version: number
	// Where the radii come from.
	readonly source: string
	// The annuli from the inside out, contiguous.
	readonly annuli: readonly SaturnRingAnnulus[]
	// Outer radius of the outermost bright ring, the A ring (km).
	readonly outerRadius: number
}

// The main rings, from the NASA NSSDC Saturnian Rings Fact Sheet: C ring 74,490-91,980 km, B ring
// 91,980-117,500 km, Cassini Division 117,500-122,050 km and A ring 122,050-136,770 km. The faint D, E,
// F and G rings and the Encke and Keeler gaps are not modeled.
export const SATURN_RING_MODEL: SaturnRingModel = {
	version: 1,
	source: 'NASA NSSDC Saturnian Rings Fact Sheet',
	annuli: [
		{ name: 'C', inner: 74490, outer: 91980, division: false },
		{ name: 'B', inner: 91980, outer: 117500, division: false },
		{ name: 'cassini', inner: 117500, outer: 122050, division: true },
		{ name: 'A', inner: 122050, outer: 136770, division: false },
	],
	outerRadius: 136770,
}

// Display tolerance of the ring edge-on condition: 0.1° (radians). At this opening the outer ring's
// apparent semi-minor axis is under 0.02″ at opposition, far below any telescopic resolution. It only
// classifies the illumination for display; crossings are found by root search, not by this threshold.
export const SATURN_RING_EDGE_ON_TOLERANCE: Angle = (0.1 * Math.PI) / 180

// How the Earth and the Sun face the ring plane.
export type SaturnRingIllumination =
	// Both on the same side: the visible face of the rings is lit.
	| 'sameFace'
	// On opposite sides: the visible face of the rings is the unlit one, seen by light through the rings.
	| 'oppositeFaces'
	// The Earth or the Sun is within SATURN_RING_EDGE_ON_TOLERANCE of the ring plane.
	| 'edgeOn'

// The signed openings of the ring plane at one observed instant, with the system state they come from.
export interface SaturnRingOpenings {
	// The shared Saturn state (TDB observed instant, retarded Saturn, pole, Sun, outline).
	readonly state: PlanetSystemState
	// Earth opening B: Saturnicentric latitude of the Earth above the ring plane (radians, north positive).
	readonly earthOpening: Angle
	// Solar opening B′: Saturnicentric latitude of the Sun above the ring plane (radians, north positive).
	readonly solarOpening: Angle
}

// Computes the signed Earth and solar openings of the ring plane at an observed instant. Evaluates only the
// Sun, the Earth and Saturn, so a ring-only ephemeris is enough; cheap enough for scanning.
export function saturnRingOpenings(ephemeris: SaturnianEphemeris, time: Time): SaturnRingOpenings {
	const state = planetSystemState(SATURN_MODEL, ephemeris, time)
	const earthOpening = Math.asin(Math.max(-1, Math.min(1, -vecDot(state.pole, state.lineOfSight))))
	const toSun = vecNormalize(vecMinus(state.sun, state.planet))
	const solarOpening = Math.asin(Math.max(-1, Math.min(1, vecDot(state.pole, toSun))))
	return { state, earthOpening, solarOpening }
}

// Classifies how the Earth and the Sun face the ring plane from the two signed openings (radians).
export function saturnRingIllumination(earthOpening: Angle, solarOpening: Angle): SaturnRingIllumination {
	if (Math.abs(earthOpening) < SATURN_RING_EDGE_ON_TOLERANCE || Math.abs(solarOpening) < SATURN_RING_EDGE_ON_TOLERANCE) return 'edgeOn'
	return earthOpening > 0 === solarOpening > 0 ? 'sameFace' : 'oppositeFaces'
}

// The apparent geometry of Saturn's disk and rings at an observed instant.
export interface SaturnRingGeometry {
	// Observed instant at the geocentre, in TDB.
	readonly time: Time
	// Instant Saturn emitted the light seen at `time`.
	readonly emissionTime: Time
	// Geocentric distance of Saturn's centre (AU).
	readonly distance: number
	// Earth opening B (radians, north positive); see SaturnRingOpenings.
	readonly earthOpening: Angle
	// Solar opening B′ (radians, north positive); see SaturnRingOpenings.
	readonly solarOpening: Angle
	// Position angle of the projected north pole, from the true celestial north toward the east (radians, (−π, π]).
	readonly polePositionAngle: Angle
	// Apparent equatorial angular radius of the disk (radians).
	readonly equatorialRadius: Angle
	// Apparent polar angular semi-axis of the disk outline (radians); larger than the true polar radius by
	// the foreshortening of the sub-Earth latitude.
	readonly polarRadius: Angle
	// Apparent angular semi-major axis of the outer edge of the A ring (radians).
	readonly ringSemiMajor: Angle
	// Apparent angular semi-minor axis of the outer edge of the A ring (radians, non-negative); the side of
	// the rings toward the Earth is given by the sign of earthOpening.
	readonly ringSemiMinor: Angle
	// How the Earth and the Sun face the ring plane.
	readonly illumination: SaturnRingIllumination
	// Sky basis of the view on the true equator of date (ICRF axes).
	readonly basis: SkyBasis
}

// Computes the apparent geometry of Saturn's disk and rings at an observed instant. Evaluates the
// precession-nutation matrix for the sky basis, so it is meant for display rather than for scanning.
export function saturnRingGeometry(ephemeris: SaturnianEphemeris, time: Time): SaturnRingGeometry {
	const { state, earthOpening, solarOpening } = saturnRingOpenings(ephemeris, time)
	const basis = skyBasis(time, state.lineOfSight)
	const equatorialRadius = Math.atan(SATURN_EQUATORIAL_RADIUS_AU / state.distance)
	const ringSemiMajor = Math.atan(SATURN_RING_MODEL.outerRadius / AU_KM / state.distance)

	return {
		time: state.time,
		emissionTime: state.emissionTime,
		distance: state.distance,
		earthOpening,
		solarOpening,
		polePositionAngle: skyPositionAngle(basis, state.pole),
		equatorialRadius,
		polarRadius: equatorialRadius * state.outline.ratio,
		ringSemiMajor,
		ringSemiMinor: ringSemiMajor * Math.abs(Math.sin(earthOpening)),
		illumination: saturnRingIllumination(earthOpening, solarOpening),
		basis,
	}
}

// A ring-plane season event.
export type SaturnRingEventKind =
	// The Earth crosses the ring plane: B changes sign.
	| 'earthPlaneCrossing'
	// The Sun crosses the ring plane (Saturn's equinox): B′ changes sign.
	| 'solarPlaneCrossing'
	// A local extremum of B toward zero, within the near-plane limit, without a sign change.
	| 'nearPlaneApproach'
	// A local maximum of B (not a near-plane approach).
	| 'openingMaximum'
	// A local minimum of B (not a near-plane approach).
	| 'openingMinimum'

// A ring-plane event at an observed geocentric instant.
export interface SaturnRingEvent {
	readonly kind: SaturnRingEventKind
	// Observed geocentric instant of the event.
	readonly time: Time
	// Earth opening B at the event (radians).
	readonly earthOpening: Angle
	// Solar opening B′ at the event (radians).
	readonly solarOpening: Angle
}

// Options of the ring-plane event search.
export interface SaturnRingEventsOptions extends TimeSearchOptions {
	// Largest |B| (radians) of an extremum toward zero reported as a near-plane approach; defaults to 1°.
	readonly nearPlaneLimit?: Angle
}

// Default coarse step of the ring-plane search: two days. B changes by at most ~0.1° per day and its
// extrema and crossings are at least seven weeks apart, so consecutive samples bracket each one.
const RING_EVENT_STEP = 2

// Days the search is padded on each side, so an extremum at a window edge still has a bracketing triple.
const RING_EVENT_PAD = 6

// Default near-plane limit: 1° (radians).
const NEAR_PLANE_LIMIT = Math.PI / 180

// Finds the ring-plane events whose instant lies in [start, stop): the Earth's and the Sun's crossings of
// the ring plane, every local extremum of the Earth opening B, and the near-plane approaches (an extremum
// of B toward zero with |B| below the near-plane limit, where B nears the plane without crossing it).
// Several Earth crossings in one season are all reported. Events are chronological, with the openings
// evaluated at each event. Every position comes from `ephemeris`; only the Sun, the Earth and Saturn are
// evaluated, and a kernel-backed source propagates its miss. For multi-year windows wrap the source in
// interpolatedSaturnianRingEphemeris: the theories then cost a fraction of a second per decade.
//
// The solar crossing is the instant the rings are seen edge-on to the sunlight reaching them: B′ is
// evaluated at Saturn's emission instant with the Sun retarded for the Sun-to-Saturn light time. JPL
// Horizons' SunSub-LAT instead places the Sun as an observer of Saturn, retarding Saturn by that light
// time, so its zero falls one Saturn-Sun light time (~80 minutes) later.
export function saturnRingEvents(ephemeris: SaturnianEphemeris, start: Time, stop: Time, options: SaturnRingEventsOptions = {}): SaturnRingEvent[] {
	const search: TimeSearchOptions = { step: options.step ?? RING_EVENT_STEP, tolerance: options.tolerance }
	const limit = options.nearPlaneLimit ?? NEAR_PLANE_LIMIT
	const from = timeShift(start, -RING_EVENT_PAD)
	const to = timeShift(stop, RING_EVENT_PAD)
	const inside = (time: Time) => timeSubtract(time, start) >= 0 && timeSubtract(time, stop) < 0
	const events: SaturnRingEvent[] = []

	const push = (kind: SaturnRingEventKind, time: Time) => {
		if (!inside(time)) return
		const { earthOpening, solarOpening } = saturnRingOpenings(ephemeris, time)
		events.push({ kind, time, earthOpening, solarOpening })
	}

	const earth = (time: Time) => saturnRingOpenings(ephemeris, time).earthOpening
	const sun = (time: Time) => saturnRingOpenings(ephemeris, time).solarOpening

	for (const time of searchRoots(earth, from, to, search)) push('earthPlaneCrossing', time)
	for (const time of searchRoots(sun, from, to, search)) push('solarPlaneCrossing', time)

	for (const extremum of searchExtrema(earth, from, to, search)) {
		// An extremum toward zero is a maximum of a negative B or a minimum of a positive one.
		const towardPlane = extremum.kind === 'maximum' ? extremum.value < 0 : extremum.value > 0
		const kind = towardPlane && Math.abs(extremum.value) < limit ? 'nearPlaneApproach' : extremum.kind === 'maximum' ? 'openingMaximum' : 'openingMinimum'
		push(kind, extremum.time)
	}

	events.sort((a, b) => timeSubtract(a.time, b.time))
	return events
}
