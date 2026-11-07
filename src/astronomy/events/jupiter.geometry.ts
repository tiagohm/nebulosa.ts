import { JUPITER_EQUATORIAL_RADIUS_AU, JUPITER_POLAR_RADIUS_AU } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngle, vecDot, vecMinus, vecNormalize } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import { bodyFixedMatrix, JUPITER_ROTATION, JUPITER_SYSTEM_II } from '../bodies/orientation'
import { GALILEAN_MOONS, GALILEAN_RADIUS_AU, type GalileanMoon, type JovianBody, type JovianEphemeris } from '../ephemeris/jovian'
import type { Time } from '../time/time'
import { jupiterCentralMeridian } from './jupiter'
// oxfmt-ignore
import { type PlanetDiskMargins, type PlanetEclipseMargins, type PlanetModel, type PlanetMoonMargins, planetMoonMargins, type PlanetShadowMargins, type PlanetShadowPoint, planetShadowPoint, planetSurfaceCosine, type PlanetSystemState, planetSystemState, type SatelliteDiskState, satelliteDiskState, type SatelliteEclipseState, satelliteEclipseState, type SkyBasis, skyBasis, skyOffset, skyPositionAngle } from './satellites.geometry'

// Apparent geometry of Jupiter and its Galilean satellites for a geocentric observer: the oblate
// planetary disk, the satellites' disks, the satellites' shadows on Jupiter, and Jupiter's shadow on the
// satellites. All states come from one JovianEphemeris; positions are barycentric ICRF in AU. The margins
// are the generic planet-satellite geometry of satellites.geometry.ts with JUPITER_MODEL (IAU 1-bar
// radii, System III pole, Galilean mean radii); see that module for the light-time, outline, shadow-cone
// and sky-basis conventions. This module adds Jupiter's view: the central meridians of Systems I, II and
// III and the projection of cloud-top features such as the Great Red Spot.
//
// Margins are in Jupiter equatorial radii: angular radii for the Earth view (apparent disk), linear
// radii for the Sun view (shadow geometry). Apparent sky offsets use the true equator of date, east
// toward increasing right ascension and north toward the true celestial pole; aberration is neglected.

// Jupiter as an oblate planet with spherical Galilean moons.
export const JUPITER_MODEL: PlanetModel<JovianBody, GalileanMoon> = {
	planet: 'jupiter',
	equatorialRadius: JUPITER_EQUATORIAL_RADIUS_AU,
	polarRadius: JUPITER_POLAR_RADIUS_AU,
	rotation: JUPITER_ROTATION,
	moonRadius: GALILEAN_RADIUS_AU,
}

// The state shared by every moon at one observed instant.
export interface JovianSystemState extends PlanetSystemState {
	// Barycentric position of Jupiter's centre at its emission instant (AU, ICRF); the same as `planet`.
	readonly jupiter: Vec3
}

// Computes the state shared by every moon at an observed instant: the Earth, the retarded Jupiter, its
// pole and outline, and the Sun that lights it.
export function jovianSystemState(ephemeris: JovianEphemeris, time: Time): JovianSystemState {
	const state = planetSystemState(JUPITER_MODEL, ephemeris, time)
	return { ...state, jupiter: state.planet }
}

// A moon against Jupiter's apparent disk, seen from the Earth, in apparent equatorial radii of Jupiter.
export type JovianDiskMargins = PlanetDiskMargins

// A moon's shadow against Jupiter, seen from the Sun, in equatorial radii of Jupiter.
export type JovianShadowMargins = PlanetShadowMargins

// A moon against Jupiter's shadow, in equatorial radii of Jupiter.
export type JovianEclipseMargins = PlanetEclipseMargins

// Margins of one Galilean moon at one observed instant.
export type JovianMoonMargins = PlanetMoonMargins<GalileanMoon>

// Computes the disk, shadow and eclipse margins of a Galilean moon at the observed instant of `state`;
// see planetMoonMargins.
export function jovianMoonMargins(ephemeris: JovianEphemeris, state: JovianSystemState, moon: GalileanMoon): JovianMoonMargins {
	return planetMoonMargins(JUPITER_MODEL, ephemeris, state, moon)
}

// The centre of a moon's shadow on Jupiter's surface.
export type JovianShadowPoint = PlanetShadowPoint

// Intersects a moon's shadow axis with Jupiter's spheroid and returns the shadow centre, or undefined
// when the axis misses the planet or the moon is not between the Sun and Jupiter; see planetShadowPoint.
export function jovianShadowPoint(state: JovianSystemState, shadow: JovianShadowMargins): JovianShadowPoint | undefined {
	return planetShadowPoint(JUPITER_MODEL, state, shadow)
}

// How a moon appears against Jupiter's disk.
export type JovianDiskState = SatelliteDiskState

// How much of Jupiter's shadow covers a moon.
export type JovianEclipseState = SatelliteEclipseState

// The apparent view of one moon.
export interface JovianMoonView {
	readonly moon: GalileanMoon
	// Sky offset of the moon's centre from Jupiter's apparent centre toward the east, in apparent
	// equatorial radii of Jupiter.
	readonly east: number
	// Sky offset of the moon's centre toward the north, in apparent equatorial radii of Jupiter.
	readonly north: number
	// Line-of-sight distance of the moon in front of Jupiter's centre, in equatorial radii: positive
	// toward the Earth, negative behind the planet.
	readonly depth: number
	// Apparent radius of the moon, in apparent equatorial radii of Jupiter.
	readonly radius: number
	// Whether any part of the moon overlaps Jupiter's disk, in front (transit) or behind (occulted).
	readonly disk: JovianDiskState
	// Whether any part of the moon is in Jupiter's penumbra or umbra.
	readonly eclipse: JovianEclipseState
	// The centre of the moon's shadow on Jupiter, when the shadow axis meets the planet.
	readonly shadow?: JovianShadowView
}

// The apparent view of a moon's shadow centre on Jupiter.
export interface JovianShadowView {
	// Sky offset of the shadow centre toward the east, in apparent equatorial radii of Jupiter.
	readonly east: number
	// Sky offset of the shadow centre toward the north, in apparent equatorial radii of Jupiter.
	readonly north: number
	// Whether the shadow centre lies on the hemisphere facing the Earth.
	readonly visible: boolean
}

// The apparent view of Jupiter and its Galilean satellites at an observed instant.
export interface JovianView {
	// Observed instant at the geocentre.
	readonly time: Time
	// Instant Jupiter emitted the light seen at `time`.
	readonly emissionTime: Time
	// Geocentric distance of Jupiter's centre (AU).
	readonly distance: number
	// Apparent equatorial angular radius of Jupiter (radians).
	readonly equatorialRadius: Angle
	// Apparent polar angular semi-axis of Jupiter's outline (radians); larger than the true polar
	// radius by the foreshortening of the sub-Earth latitude.
	readonly polarRadius: Angle
	// Position angle of the projected north pole, from the true celestial north toward the east (radians, (−π, π]).
	readonly poleAngle: Angle
	// Planetocentric latitude of the sub-Earth point (radians).
	readonly subEarthLatitude: Angle
	// Planetocentric latitude of the sub-solar point (radians).
	readonly subSolarLatitude: Angle
	// Sun-Jupiter-Earth phase angle (radians).
	readonly phaseAngle: Angle
	// Central-meridian longitudes, west-positive, in [0, 2π) (radians).
	readonly centralMeridian: Readonly<Record<'I' | 'II' | 'III', Angle>>
	// The four moons, in orbital order.
	readonly moons: readonly JovianMoonView[]
	// Sky basis of the view: unit vectors toward the east and the true north on the sky, and the line of
	// sight, all in ICRF axes.
	readonly basis: SkyBasis
	// Barycentric position of the Earth at the observed instant (AU, ICRF).
	readonly earth: Vec3
	// Barycentric position of Jupiter's centre at its emission instant (AU, ICRF).
	readonly jupiter: Vec3
}

// Projects a jovicentric ICRF offset (AU), as seen from the Earth, to east/north sky offsets in apparent
// equatorial radii of Jupiter.
function jovianSkyOffset(view: Pick<JovianView, 'earth' | 'jupiter' | 'basis' | 'distance'>, offset: Vec3): readonly [number, number] {
	return skyOffset(view.basis, view.earth, view.jupiter, view.distance, JUPITER_EQUATORIAL_RADIUS_AU, offset)
}

// Computes the apparent view of Jupiter and its four Galilean satellites at an observed instant: the
// disk size and orientation, the central meridians, and each moon's sky offset, depth, disk and eclipse
// states and shadow. Unlike the margins, it evaluates the precession-nutation matrix for the sky basis,
// so it is meant for display rather than for scanning.
export function jovianView(ephemeris: JovianEphemeris, time: Time): JovianView {
	const state = jovianSystemState(ephemeris, time)
	const basis = skyBasis(time, state.lineOfSight)
	const lineOfSight = state.lineOfSight
	const jupiterToEarth = vecMinus(state.earth, state.jupiter)
	const jupiterToSun = vecMinus(state.sun, state.jupiter)
	const equatorialRadius = Math.atan(JUPITER_EQUATORIAL_RADIUS_AU / state.distance)
	const partial = { earth: state.earth, jupiter: state.jupiter, basis, distance: state.distance }

	const moons = GALILEAN_MOONS.map((moon): JovianMoonView => {
		const margins = jovianMoonMargins(ephemeris, state, moon)
		const [moonEast, moonNorth] = jovianSkyOffset(partial, vecMinus(margins.disk.position, state.jupiter))
		const depth = (state.distance - vecDot(vecMinus(margins.disk.position, state.earth), lineOfSight)) / JUPITER_EQUATORIAL_RADIUS_AU
		const disk = satelliteDiskState(margins.disk)
		const eclipse = satelliteEclipseState(margins.eclipse)
		const point = jovianShadowPoint(state, margins.shadow)
		let shadow: JovianShadowView | undefined

		if (point !== undefined) {
			const [shadowEast, shadowNorth] = jovianSkyOffset(partial, point.offset)
			shadow = { east: shadowEast, north: shadowNorth, visible: point.earthCosine > 0 }
		}

		return { moon, east: moonEast, north: moonNorth, depth, radius: margins.disk.radius, disk, eclipse, shadow }
	})

	return {
		time,
		emissionTime: state.emissionTime,
		distance: state.distance,
		equatorialRadius,
		polarRadius: equatorialRadius * state.outline.ratio,
		poleAngle: skyPositionAngle(basis, state.pole),
		subEarthLatitude: Math.asin(vecDot(vecNormalize(jupiterToEarth), state.pole)),
		subSolarLatitude: Math.asin(vecDot(vecNormalize(jupiterToSun), state.pole)),
		phaseAngle: vecAngle(jupiterToSun, jupiterToEarth),
		centralMeridian: {
			I: jupiterCentralMeridian('I', time, jupiterToEarth),
			II: jupiterCentralMeridian('II', time, jupiterToEarth),
			III: jupiterCentralMeridian('III', time, jupiterToEarth),
		},
		moons,
		basis,
		earth: state.earth,
		jupiter: state.jupiter,
	}
}

// A point of Jupiter's surface as seen from the Earth.
export interface JovianSurfaceView {
	// Sky offset toward the east, in apparent equatorial radii of Jupiter.
	readonly east: number
	// Sky offset toward the north, in apparent equatorial radii of Jupiter.
	readonly north: number
	// Whether the point lies on the hemisphere facing the Earth.
	readonly visible: boolean
}

// Projects a point of Jupiter's cloud tops given by its System II west longitude and planetographic
// latitude (radians) into the view, with the rotation evaluated at Jupiter's emission instant. Used to
// place a feature such as the Great Red Spot on the apparent disk; the latitude of an atmospheric feature
// is an observed quantity supplied by the caller.
export function projectJovianSurfacePoint(view: JovianView, longitude: Angle, latitude: Angle): JovianSurfaceView {
	const a = JUPITER_EQUATORIAL_RADIUS_AU
	const b = JUPITER_POLAR_RADIUS_AU
	// Planetographic to planetocentric latitude on the spheroid, then the surface radius at that latitude.
	const centric = Math.atan((b / a) ** 2 * Math.tan(latitude))
	const cosLat = Math.cos(centric)
	const sinLat = Math.sin(centric)
	const r = 1 / Math.sqrt((cosLat * cosLat) / (a * a) + (sinLat * sinLat) / (b * b))
	// The body-fixed frame uses east longitudes: a west longitude L is the east longitude −L.
	const point: MutVec3 = [r * cosLat * Math.cos(longitude), -r * cosLat * Math.sin(longitude), r * sinLat]
	const rotation = bodyFixedMatrix(JUPITER_SYSTEM_II, view.emissionTime)
	const offset = matTransposeMulVec(rotation, point)
	const [skyEast, skyNorth] = jovianSkyOffset(view, offset)
	return { east: skyEast, north: skyNorth, visible: planetSurfaceCosine(JUPITER_MODEL, rotation, point, vecMinus(view.earth, view.jupiter)) > 0 }
}
