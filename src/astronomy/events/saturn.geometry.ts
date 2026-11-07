import { SATURN_EQUATORIAL_RADIUS_AU, SATURN_EQUATORIAL_RADIUS_KM } from '../../core/constants'
import { type Vec3, vecAngle, vecDot, vecMinus } from '../../math/linear-algebra/vec3'
import { signedDistanceToEllipse } from '../../math/numerical/geometry'
import type { Angle } from '../../math/units/angle'
import { SATURNIAN_MOONS, type SaturnianEphemeris, type SaturnianMoon } from '../ephemeris/saturnian'
import { type Time, tdb, timeShift, timeSubtract } from '../time/time'
import { planetMoonMargins, planetShadowPoint, type PlanetSystemState, planetSystemState, retard, type SatelliteDiskState, satelliteDiskState, type SatelliteEclipseState, satelliteEclipseState, type SkyBasis, skyBasis, skyOffset } from './satellites.geometry'
import { SATURN_MODEL, SATURN_RING_MODEL, type SaturnRingGeometry, saturnRingGeometryOf, saturnRingOpenings } from './saturn.rings'
import { searchExtrema } from './search'

// Apparent geometry of Saturn's seven major satellites for a geocentric observer: each moon's sky offset
// from Saturn's apparent centre, its depth along the line of sight, its angular separation and position
// angle, its clearance from the oblate disk and from the outer edge of the rings, whether it overlaps the
// projected ring annulus in front of or behind the rings, its disk and eclipse states and its shadow on
// the globe, together with the ring geometry of saturn.rings.ts from the same state. It also finds the
// greatest apparent separations of each moon from Saturn.
//
// Conventions are those of satellites.geometry.ts: observed geocentric instants, each moon and Saturn
// light-time retarded independently, the true equator of date for the sky basis (east toward increasing
// right ascension, north toward the true celestial pole), aberration neglected. Offsets and depths are in
// apparent equatorial radii of Saturn (IAU 1-bar, 60,268 km); separations, position angles and clearances
// are angles in radians. A ring overlap is geometric only: the rings are an infinitely thin annulus of the
// SATURN_RING_MODEL radii with no optical depth, so an overlap means the moon's visibility is uncertain,
// not that it is hidden. Ring shadows and the satellites' shadows on the rings are not modeled.

// Below this ratio of the projected outer-ring semi-minor to semi-major axis the ring outline is treated as
// a segment, so the distance to a nearly edge-on ellipse stays finite.
const EDGE_ON_RATIO = 1e-9

// Inner radius of the C ring, the innermost modeled annulus, in Saturn equatorial radii.
const RING_INNER = SATURN_RING_MODEL.annuli[0].inner / SATURN_EQUATORIAL_RADIUS_KM

// Outer radius of the A ring, the outer edge of the modeled rings, in Saturn equatorial radii.
const RING_OUTER = SATURN_RING_MODEL.outerRadius / SATURN_EQUATORIAL_RADIUS_KM

// Sidereal orbital period of each major moon in days (JPL mean elements), which sets the separation
// search step: two maxima and two minima per orbit.
const ORBITAL_PERIOD: Readonly<Record<SaturnianMoon, number>> = {
	mimas: 0.942,
	enceladus: 1.37,
	tethys: 1.888,
	dione: 2.737,
	rhea: 4.518,
	titan: 15.945,
	iapetus: 79.331,
}

// Separation search samples per orbit: twelve, three per quarter between a maximum and a minimum.
const SEPARATION_SAMPLES_PER_ORBIT = 12

// Whether a moon's apparent disk overlaps the projected ring annulus, and on which side of the rings it is.
export type SaturnRingOverlap =
	// No part of the moon's disk is over the projected annulus.
	| 'none'
	// The moon is over the annulus and nearer the Earth than the ring plane at that point: it is in front.
	| 'front'
	// The moon is over the annulus and farther than the ring plane at that point: the rings may hide it.
	| 'behind'

// The apparent view of a moon's shadow centre on Saturn's globe.
export interface SaturnianShadowView {
	// Sky offset of the shadow centre toward the east, in apparent equatorial radii of Saturn.
	readonly east: number
	// Sky offset of the shadow centre toward the north, in apparent equatorial radii of Saturn.
	readonly north: number
	// Whether the shadow centre lies on the hemisphere facing the Earth.
	readonly visible: boolean
}

// The apparent view of one moon.
export interface SaturnianMoonView {
	readonly moon: SaturnianMoon
	// Sky offset of the moon's centre from Saturn's apparent centre toward the east, in apparent equatorial radii.
	readonly east: number
	// Sky offset of the moon's centre toward the north, in apparent equatorial radii.
	readonly north: number
	// Line-of-sight distance of the moon in front of Saturn's centre, in equatorial radii: positive toward
	// the Earth, negative behind the planet.
	readonly depth: number
	// Apparent radius of the moon, in apparent equatorial radii of Saturn.
	readonly radius: number
	// Angular separation of the moon's centre from Saturn's apparent centre (radians).
	readonly separation: Angle
	// Position angle of the moon from Saturn's centre, from the true celestial north toward the east (radians, (−π, π]).
	readonly positionAngle: Angle
	// Signed angular clearance of the moon's limb from Saturn's apparent limb (radians): negative when the
	// disks overlap.
	readonly diskClearance: Angle
	// Signed angular clearance of the moon's limb from the projected outer edge of the A ring (radians):
	// negative when the moon's disk reaches inside the ring outline. Geometric only.
	readonly ringClearance: Angle
	// Whether the moon overlaps the projected ring annulus, in front or behind.
	readonly ringOverlap: SaturnRingOverlap
	// Whether any part of the moon overlaps Saturn's disk, in front (transit) or behind (occulted).
	readonly disk: SatelliteDiskState
	// Whether any part of the moon is in Saturn's penumbra or umbra.
	readonly eclipse: SatelliteEclipseState
	// The centre of the moon's shadow on Saturn's globe, when the shadow axis meets the planet.
	readonly shadow?: SaturnianShadowView
}

// The apparent view of Saturn, its rings and its major satellites at an observed instant.
export interface SaturnianView extends SaturnRingGeometry {
	// The requested moons, in orbital order.
	readonly moons: readonly SaturnianMoonView[]
	// Barycentric position of the Earth at the observed instant (AU, ICRF).
	readonly earth: Vec3
	// Barycentric position of Saturn's centre at its emission instant (AU, ICRF).
	readonly saturn: Vec3
}

// Distance from (x, y) to an ellipse of semi-axes a ≥ b ≥ 0, signed negative inside; a nearly flat
// ellipse (b/a below EDGE_ON_RATIO) is the segment |x| ≤ a, whose distance is never negative.
function ellipseDistance(x: number, y: number, a: number, b: number): number {
	if (b > a * EDGE_ON_RATIO) return signedDistanceToEllipse(x, y, a, b)
	const along = Math.abs(x) - a
	return along <= 0 ? Math.abs(y) : Math.hypot(along, y)
}

// Computes the apparent view of one moon from the shared system state and a sky basis around its line of
// sight. Evaluates the moon's margins (disk, shadow, eclipse) and its ring relation; cheap enough to sample
// a track when the basis is reused.
export function saturnianMoonView(ephemeris: SaturnianEphemeris, state: PlanetSystemState, basis: SkyBasis, moon: SaturnianMoon): SaturnianMoonView {
	const a = SATURN_EQUATORIAL_RADIUS_AU
	const margins = planetMoonMargins(SATURN_MODEL, ephemeris, state, moon)
	const direction = vecMinus(margins.disk.position, state.earth)
	const along = vecDot(direction, state.lineOfSight)
	const scale = state.distance / (along * a)
	const east = vecDot(direction, basis.east) * scale
	const north = vecDot(direction, basis.north) * scale
	const radius = margins.disk.radius
	// Angle subtended by one apparent equatorial radius at Saturn's distance.
	const unit = Math.atan(a / state.distance)

	// The ring outline in the coordinates of Saturn's apparent outline: semi-major axis perpendicular to the
	// projected pole, semi-minor axis toward it, foreshortened by |sin B|.
	const x = vecDot(direction, state.outline.major) * scale
	const y = vecDot(direction, state.outline.minor) * scale
	const sinB = Math.abs(vecDot(state.pole, state.lineOfSight))
	const outer = ellipseDistance(x, y, RING_OUTER, RING_OUTER * sinB)
	const inner = ellipseDistance(x, y, RING_INNER, RING_INNER * sinB)
	let ringOverlap: SaturnRingOverlap = 'none'

	if (outer < radius && inner > -radius) {
		// Where the line of sight through the moon meets the ring plane, relative to the moon: beyond it
		// (positive) when the moon is in front of the rings. A moon that reaches the ring plane, or a plane
		// seen edge-on, is taken as possibly hidden.
		const offset = vecMinus(margins.disk.position, state.planet)
		const height = vecDot(state.pole, offset)
		const normal = vecDot(state.pole, state.lineOfSight)
		const front = Math.abs(height) > SATURN_MODEL.moonRadius[moon] && Math.abs(normal) > 1e-12 && -height / normal > 0
		ringOverlap = front ? 'front' : 'behind'
	}

	const point = planetShadowPoint(SATURN_MODEL, state, margins.shadow)
	let shadow: SaturnianShadowView | undefined

	if (point !== undefined) {
		const [shadowEast, shadowNorth] = skyOffset(basis, state.earth, state.planet, state.distance, a, point.offset)
		shadow = { east: shadowEast, north: shadowNorth, visible: point.earthCosine > 0 }
	}

	return {
		moon,
		east,
		north,
		depth: (state.distance - along) / a,
		radius,
		separation: vecAngle(direction, state.lineOfSight),
		positionAngle: Math.atan2(east, north),
		diskClearance: (margins.disk.distance - radius) * unit,
		ringClearance: (outer - radius) * unit,
		ringOverlap,
		disk: satelliteDiskState(margins.disk),
		eclipse: satelliteEclipseState(margins.eclipse),
		shadow,
	}
}

// Computes the apparent view of Saturn, its rings and the requested major moons (all seven by default) at
// an observed instant, from one system state. Evaluates the precession-nutation matrix for the sky basis,
// so it is meant for display rather than for scanning.
export function saturnianView(ephemeris: SaturnianEphemeris, time: Time, moons: readonly SaturnianMoon[] = SATURNIAN_MOONS): SaturnianView {
	const openings = saturnRingOpenings(ephemeris, time)
	const { state } = openings
	const basis = skyBasis(time, state.lineOfSight)
	const rings = saturnRingGeometryOf(openings, basis)
	return { ...rings, moons: moons.map((moon) => saturnianMoonView(ephemeris, state, basis, moon)), earth: state.earth, saturn: state.planet }
}

// A greatest apparent separation of a moon from Saturn.
export interface SaturnianSeparationMaximum {
	readonly moon: SaturnianMoon
	// Observed geocentric instant of the maximum.
	readonly time: Time
	// Angular separation of the moon's centre from Saturn's apparent centre at the maximum (radians).
	readonly separation: Angle
	// Position angle of the moon from Saturn's centre at the maximum, from the true celestial north toward
	// the east (radians, (−π, π]).
	readonly positionAngle: Angle
}

// Angular separation of a moon's apparent centre from Saturn's apparent centre (radians), each body
// retarded for its own light time.
function apparentSeparation(ephemeris: SaturnianEphemeris, moon: SaturnianMoon, time: Time): Angle {
	time = tdb(time)
	const earth = ephemeris.position('earth', time)
	const saturn = retard(ephemeris, 'saturn', earth, time).position
	const satellite = retard(ephemeris, moon, earth, time).position
	return vecAngle(vecMinus(saturn, earth), vecMinus(satellite, earth))
}

// Finds the local maxima of each moon's apparent angular separation from Saturn whose instant lies in
// [start, stop), chronologically. These are the true maxima of the separation magnitude, not the extrema
// of an east-west coordinate, so an inclined orbit (Iapetus) is handled correctly; there are two per
// orbit. A window shorter than about half an orbit may hold none for a slow moon, and none is reported:
// a window edge is never taken as a maximum. Each moon is scanned at a twelfth of its orbital period and
// refined with Brent's method; a kernel-backed source propagates its miss.
export function saturnianSeparationMaxima(ephemeris: SaturnianEphemeris, start: Time, stop: Time, moons: readonly SaturnianMoon[] = SATURNIAN_MOONS): SaturnianSeparationMaximum[] {
	const maxima: SaturnianSeparationMaximum[] = []

	for (const moon of moons) {
		const step = ORBITAL_PERIOD[moon] / SEPARATION_SAMPLES_PER_ORBIT
		const from = timeShift(start, -2 * step)
		const to = timeShift(stop, 2 * step)

		for (const extremum of searchExtrema((time) => apparentSeparation(ephemeris, moon, time), from, to, { step })) {
			if (extremum.kind !== 'maximum' || timeSubtract(extremum.time, start) < 0 || timeSubtract(extremum.time, stop) >= 0) continue
			const state = planetSystemState(SATURN_MODEL, ephemeris, extremum.time)
			const view = saturnianMoonView(ephemeris, state, skyBasis(extremum.time, state.lineOfSight), moon)
			maxima.push({ moon, time: extremum.time, separation: extremum.value, positionAngle: view.positionAngle })
		}
	}

	maxima.sort((a, b) => timeSubtract(a.time, b.time))
	return maxima
}
