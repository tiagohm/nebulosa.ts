import { SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU } from '../../core/constants'
import { type Mat3, matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecCross, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import { intersectSegmentEllipsoid, signedDistanceToEllipse } from '../../math/numerical/geometry'
import { bodyFixedMatrix, orientation, type RotationElements } from '../bodies/orientation'
import type { SatelliteEphemeris } from '../ephemeris/satellites'
import { precessionNutationMatrix, type Time, tdb, timeShift } from '../time/time'

// Apparent geometry of an oblate giant planet and its satellites for a geocentric observer: the planetary
// disk, the satellites' disks, the satellites' shadows on the planet, and the planet's shadow on the
// satellites. The planet is described by a PlanetModel (radii, IAU rotation elements, moon radii) and all
// states come from one satellite-system ephemeris; positions are barycentric ICRF in AU. The Jovian and
// Saturnian geometry modules instantiate these functions.
//
// Time convention: every function takes the observed instant at the geocentre. The planet and each moon
// are light-time retarded independently, so a moon is never compared with a differently retarded planet.
// A moon's shadow on the planet is evaluated when the planet emits the light seen at the observed instant,
// from the moon one moon-to-planet light time earlier and the Sun one Sun-to-planet light time earlier.
// The planet's shadow on a moon is evaluated when the moon emits the light seen at the observed instant,
// from the planet and the Sun one light time earlier still. Every contact derived from these margins is
// therefore an observed geocentric instant, not a topocentric one.
//
// The planet is an oblate spheroid whose outline, seen along any direction, is an ellipse: semi-major axis
// a perpendicular to the projected pole and semi-minor axis a·√(1 − e²cos²δ), where δ is the
// planetocentric latitude of the viewer. A projected point is compared with that outline by its exact
// signed distance. The satellites are spheres of their mean radii. Shadows are finite-Sun cones: a moon's
// penumbra widens, and its umbra narrows, linearly with distance behind it; the planet's shadow
// cross-section at a distance s behind its centre is the Sun-view outline scaled uniformly by the cone
// ratio at s, exact for a sphere and an approximation, documented here, for the oblate planet. Rings are
// not part of this model.
//
// Margins are in planet equatorial radii: angular radii for the Earth view (apparent disk), linear radii
// for the Sun view (shadow geometry). Apparent sky offsets use the true equator of date, east toward
// increasing right ascension and north toward the true celestial pole; aberration is neglected.

// Fixed-point light-time iterations; three converge to well under a millisecond at the giant planets.
const LIGHT_TIME_ITERATIONS = 3

// Smallest projected-pole length (unit vectors) below which the pole is taken as pointing at the viewer
// and the outline is a circle in any orientation.
const POLE_ON_EPSILON = 1e-12

// The physical description of an oblate planet and its spherical moons.
export interface PlanetModel<B extends string, M extends B> {
	// The ephemeris key of the planet's centre.
	readonly planet: B
	// Equatorial radius (AU).
	readonly equatorialRadius: number
	// Polar radius (AU); not larger than the equatorial radius.
	readonly polarRadius: number
	// IAU rotation elements giving the north pole and the body-fixed frame.
	readonly rotation: RotationElements
	// Mean radius of each moon (AU).
	readonly moonRadius: Readonly<Record<M, number>>
}

// One body retarded for the light travelling from it to a fixed receiver.
export interface Retarded {
	// Barycentric position (AU, ICRF) at the emission time.
	readonly position: Vec3
	// Emission instant: the reception instant minus the one-way light time.
	readonly emissionTime: Time
}

// Retards `body` for the light reaching `receiver` (barycentric AU, fixed at the reception instant
// `time`), by fixed-point iteration of the light time.
export function retard<B extends string>(ephemeris: SatelliteEphemeris<B, never, unknown>, body: B, receiver: Vec3, time: Time): Retarded {
	let delay = 0
	let emissionTime = time
	let position = ephemeris.position(body, time)

	for (let i = 0; i < LIGHT_TIME_ITERATIONS; i++) {
		delay = vecLength(vecMinus(position, receiver)) / SPEED_OF_LIGHT_AU_DAY
		emissionTime = timeShift(time, -delay)
		position = ephemeris.position(body, emissionTime)
	}

	return { position, emissionTime }
}

// The planet's outline seen along a direction, in the plane perpendicular to it.
export interface PlanetOutline {
	// Unit vector (ICRF) along the outline's semi-major axis, perpendicular to the projected pole.
	readonly major: Vec3
	// Unit vector (ICRF) along the outline's semi-minor axis, toward the projected north pole.
	readonly minor: Vec3
	// Semi-minor to semi-major axis ratio of the outline, in [b/a, 1].
	readonly ratio: number
}

// Square eccentricity of a planet's meridian section, 1 − (b/a)².
function eccentricitySquared(model: PlanetModel<string, string>): number {
	return 1 - (model.polarRadius / model.equatorialRadius) ** 2
}

// Outline of the planet seen along `view` (unit, from the viewer toward the planet) with north pole `pole`
// (unit, ICRF). A pole pointing at the viewer gives a circle with arbitrary axes.
export function planetOutline(model: PlanetModel<string, string>, view: Vec3, pole: Vec3): PlanetOutline {
	const along = vecDot(pole, view)
	const projected = vecMinus(pole, vecMulScalar(view, along))
	const length = vecLength(projected)
	const minor = length > POLE_ON_EPSILON ? vecMulScalar(projected, 1 / length) : vecNormalize(vecCross(view, Math.abs(view[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
	const major = vecCross(minor, view)
	const ratio = Math.sqrt(1 - eccentricitySquared(model) * (1 - along * along))
	return { major, minor, ratio }
}

// The planet's north pole (unit, ICRF) from its IAU rotation elements at a time.
export function planetPole(rotation: RotationElements, time: Time): Vec3 {
	const { poleRa, poleDec } = orientation(rotation, time)
	const cosDec = Math.cos(poleDec)
	return [cosDec * Math.cos(poleRa), cosDec * Math.sin(poleRa), Math.sin(poleDec)]
}

// The state shared by every moon at one observed instant.
export interface PlanetSystemState {
	// Observed instant at the geocentre, in TDB; the derived epochs keep that scale.
	readonly time: Time
	// Barycentric position of the Earth at the observed instant (AU, ICRF).
	readonly earth: Vec3
	// Barycentric position of the planet's centre at its emission instant (AU, ICRF).
	readonly planet: Vec3
	// Instant the planet emitted the light seen at `time`.
	readonly emissionTime: Time
	// Geocentric distance of the planet's centre (AU).
	readonly distance: number
	// Unit vector from the Earth toward the planet's apparent centre (ICRF).
	readonly lineOfSight: Vec3
	// The planet's north pole at the emission instant (unit, ICRF).
	readonly pole: Vec3
	// Barycentric position of the Sun one Sun-to-planet light time before the emission instant (AU, ICRF).
	readonly sun: Vec3
	// The planet's outline seen from the Earth.
	readonly outline: PlanetOutline
}

// Computes the state shared by every moon at an observed instant: the Earth, the retarded planet, its
// pole and outline, and the Sun that lights it. Evaluates only the Earth, the Sun and the planet.
export function planetSystemState<B extends string, M extends B>(model: PlanetModel<B, M>, ephemeris: SatelliteEphemeris<NoInfer<B> | 'sun' | 'earth', NoInfer<M>, unknown>, time: Time): PlanetSystemState {
	// Every derived epoch is a shift of this one, so converting once keeps the later conversions free.
	time = tdb(time)
	const earth = ephemeris.position('earth', time)
	const { position: planet, emissionTime } = retard(ephemeris, model.planet, earth, time)
	const toPlanet = vecMinus(planet, earth)
	const distance = vecLength(toPlanet)
	const lineOfSight = vecMulScalar(toPlanet, 1 / distance)
	const pole = planetPole(model.rotation, emissionTime)
	const sun = retard(ephemeris, 'sun', planet, emissionTime).position
	return { time, earth, planet, emissionTime, distance, lineOfSight, pole, sun, outline: planetOutline(model, lineOfSight, pole) }
}

// A moon against the planet's apparent disk, seen from the Earth.
export interface PlanetDiskMargins {
	// Elliptic radius of the moon's centre in the apparent outline: √(x² + (y/ratio)²) with x and y the
	// offsets along the outline's major and minor axes in apparent equatorial radii. Below one inside the
	// outline; smooth, with one minimum per conjunction.
	readonly ellipticRadius: number
	// Signed angular distance of the moon's centre from the planet's limb, in apparent equatorial radii:
	// negative inside the outline.
	readonly distance: number
	// Apparent radius of the moon, in apparent equatorial radii of the planet.
	readonly radius: number
	// Whether the moon is nearer the Earth than the planet's centre: a transit when the disks overlap,
	// otherwise an occultation.
	readonly front: boolean
	// Barycentric position of the moon at its emission instant (AU, ICRF).
	readonly position: Vec3
	// Instant the moon emitted the light seen at the observed instant.
	readonly emissionTime: Time
}

// A moon's shadow against the planet, seen from the Sun.
export interface PlanetShadowMargins {
	// Elliptic radius of the shadow axis in the planet's outline seen along the axis, in equatorial radii.
	readonly ellipticRadius: number
	// Signed distance of the shadow axis from that outline, in equatorial radii: negative on the disk.
	readonly distance: number
	// Penumbral radius of the moon's shadow at the planet's centre plane, in equatorial radii.
	readonly penumbra: number
	// Umbral radius of the moon's shadow at the planet's centre plane, in equatorial radii; may be negative
	// beyond the umbra's apex.
	readonly umbra: number
	// Whether the moon lies between the Sun and the planet's centre plane, so its shadow can fall on the planet.
	readonly valid: boolean
	// Barycentric position of the moon casting the shadow (AU, ICRF).
	readonly moon: Vec3
	// Unit direction of the shadow axis, from the Sun through the moon (ICRF).
	readonly axis: Vec3
}

// A moon against the planet's shadow.
export interface PlanetEclipseMargins {
	// Elliptic radius of the moon's centre in the planet's unscaled Sun-view outline, in equatorial radii.
	readonly ellipticRadius: number
	// Signed distance of the moon's centre from the umbra's boundary at the moon, in equatorial radii.
	readonly umbraDistance: number
	// Signed distance of the moon's centre from the penumbra's outer boundary at the moon, in equatorial radii.
	readonly penumbraDistance: number
	// Radius of the moon, in equatorial radii of the planet.
	readonly radius: number
	// Whether the moon lies behind the planet's centre plane as seen from the Sun, so it can enter the shadow.
	readonly valid: boolean
}

// Margins of one moon at one observed instant.
export interface PlanetMoonMargins<M extends string> {
	readonly moon: M
	readonly disk: PlanetDiskMargins
	readonly shadow: PlanetShadowMargins
	readonly eclipse: PlanetEclipseMargins
}

// Elliptic radius of (x, y) in an outline of unit semi-major axis and the given ratio.
function ellipticRadius(x: number, y: number, ratio: number): number {
	const yy = y / ratio
	return Math.sqrt(x * x + yy * yy)
}

// Computes the disk, shadow and eclipse margins of a moon at the observed instant of `state`.
//
// Disk: the moon is retarded for its own light time to the Earth and projected gnomonically on the sky
// around the planet's apparent centre. Shadow: at the planet's emission instant, the axis from the
// retarded Sun through the moon (one moon-to-planet light time earlier) is projected on the plane through
// the planet's centre perpendicular to it; the moon's cone radii are evaluated at that plane. Eclipse: at
// the moon's emission instant, the moon is projected on the plane through the planet's centre
// perpendicular to the Sun-to-planet axis, with the planet and the Sun retarded for the light that
// reaches the moon.
export function planetMoonMargins<B extends string, M extends B>(model: PlanetModel<B, M>, ephemeris: SatelliteEphemeris<NoInfer<B> | 'sun' | 'earth', NoInfer<M>, unknown>, state: PlanetSystemState, moon: M): PlanetMoonMargins<M> {
	const radius = model.moonRadius[moon]
	const a = model.equatorialRadius

	// Disk, seen from the Earth at the observed instant.
	const seen = retard(ephemeris, moon, state.earth, state.time)
	const toMoon = vecMinus(seen.position, state.earth)
	const depth = vecDot(toMoon, state.lineOfSight)
	const apparentRadius = a / state.distance
	const diskX = vecDot(toMoon, state.outline.major) / depth / apparentRadius
	const diskY = vecDot(toMoon, state.outline.minor) / depth / apparentRadius
	const disk: PlanetDiskMargins = {
		ellipticRadius: ellipticRadius(diskX, diskY, state.outline.ratio),
		distance: signedDistanceToEllipse(diskX, diskY, 1, state.outline.ratio),
		radius: radius / vecLength(toMoon) / apparentRadius,
		front: depth < state.distance,
		position: seen.position,
		emissionTime: seen.emissionTime,
	}

	// Shadow on the planet at the planet's emission instant.
	const caster = retard(ephemeris, moon, state.planet, state.emissionTime).position
	const sunToMoon = vecMinus(caster, state.sun)
	const sunMoonDistance = vecLength(sunToMoon)
	const axis = vecMulScalar(sunToMoon, 1 / sunMoonDistance)
	const shadowOutline = planetOutline(model, axis, state.pole)
	const moonToPlanet = vecMinus(state.planet, caster)
	const along = vecDot(moonToPlanet, axis)
	const shadowX = -vecDot(moonToPlanet, shadowOutline.major) / a
	const shadowY = -vecDot(moonToPlanet, shadowOutline.minor) / a
	const shadow: PlanetShadowMargins = {
		ellipticRadius: ellipticRadius(shadowX, shadowY, shadowOutline.ratio),
		distance: signedDistanceToEllipse(shadowX, shadowY, 1, shadowOutline.ratio),
		penumbra: (radius + (along * (SUN_RADIUS_AU + radius)) / sunMoonDistance) / a,
		umbra: (radius - (along * (SUN_RADIUS_AU - radius)) / sunMoonDistance) / a,
		valid: along > 0,
		moon: caster,
		axis,
	}

	// Eclipse by the planet at the moon's emission instant.
	const shadowing = retard(ephemeris, model.planet, seen.position, seen.emissionTime).position
	const star = retard(ephemeris, 'sun', seen.position, seen.emissionTime).position
	const sunToPlanet = vecMinus(shadowing, star)
	const sunPlanetDistance = vecLength(sunToPlanet)
	const sunAxis = vecMulScalar(sunToPlanet, 1 / sunPlanetDistance)
	const sunOutline = planetOutline(model, sunAxis, state.pole)
	const planetToMoon = vecMinus(seen.position, shadowing)
	const behind = vecDot(planetToMoon, sunAxis)
	const eclipseX = vecDot(planetToMoon, sunOutline.major) / a
	const eclipseY = vecDot(planetToMoon, sunOutline.minor) / a
	const umbraScale = 1 - (behind * (SUN_RADIUS_AU - a)) / (sunPlanetDistance * a)
	const penumbraScale = 1 + (behind * (SUN_RADIUS_AU + a)) / (sunPlanetDistance * a)
	const eclipse: PlanetEclipseMargins = {
		ellipticRadius: ellipticRadius(eclipseX, eclipseY, sunOutline.ratio),
		umbraDistance: signedDistanceToEllipse(eclipseX, eclipseY, umbraScale, umbraScale * sunOutline.ratio),
		penumbraDistance: signedDistanceToEllipse(eclipseX, eclipseY, penumbraScale, penumbraScale * sunOutline.ratio),
		radius: radius / a,
		valid: behind > 0,
	}

	return { moon, disk, shadow, eclipse }
}

// The centre of a moon's shadow on the planet's surface.
export interface PlanetShadowPoint {
	// Position of the shadow centre relative to the planet's centre at its emission instant (AU, ICRF).
	readonly offset: Vec3
	// Cosine of the angle between the surface normal at the shadow centre and the direction to the Earth:
	// positive when the shadow centre is on the hemisphere facing the Earth.
	readonly earthCosine: number
}

// Intersects a moon's shadow axis with the planet's spheroid and returns the shadow centre, or undefined
// when the axis misses the planet or the moon is not between the Sun and the planet. The body-fixed frame
// at the planet's emission instant is used, so the point is where the observer sees it.
export function planetShadowPoint(model: PlanetModel<string, string>, state: PlanetSystemState, shadow: PlanetShadowMargins): PlanetShadowPoint | undefined {
	if (!shadow.valid) return undefined

	const rotation = bodyFixedMatrix(model.rotation, state.emissionTime)
	const fromPlanet = vecMinus(shadow.moon, state.planet)
	const reach = 2 * vecLength(fromPlanet)
	const start = matMulVec(rotation, fromPlanet)
	const end = matMulVec(rotation, vecPlus(fromPlanet, vecMulScalar(shadow.axis, reach)))
	const hit = intersectSegmentEllipsoid(start, end, model.equatorialRadius, model.polarRadius)
	if (!hit.intersects || hit.intersection === undefined) return undefined

	const t = hit.intersection
	const point: Vec3 = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, start[2] + (end[2] - start[2]) * t]
	return { offset: matTransposeMulVec(rotation, point), earthCosine: planetSurfaceCosine(model, rotation, point, vecMinus(state.earth, state.planet)) }
}

// Cosine of the angle between the outward normal of the planet's spheroid at the body-fixed `point` (AU)
// and the direction from that point toward the planetocentric ICRF position `toward` (AU); `rotation`
// maps ICRF to the body-fixed frame.
export function planetSurfaceCosine(model: PlanetModel<string, string>, rotation: Mat3, point: Vec3, toward: Vec3): number {
	const a2 = model.equatorialRadius * model.equatorialRadius
	const b2 = model.polarRadius * model.polarRadius
	const normal: Vec3 = [point[0] / a2, point[1] / a2, point[2] / b2]
	const direction = vecMinus(matMulVec(rotation, toward), point)
	return vecDot(normal, direction) / (vecLength(normal) * vecLength(direction))
}

// How a moon appears against the planet's disk.
export type SatelliteDiskState = 'clear' | 'transit' | 'occulted'

// How much of the planet's shadow covers a moon.
export type SatelliteEclipseState = 'none' | 'penumbra' | 'umbra'

// Classifies a moon against the planet's disk: clear when no part of it overlaps the apparent outline,
// otherwise in transit (in front) or occulted (behind).
export function satelliteDiskState(margins: PlanetDiskMargins): SatelliteDiskState {
	return margins.distance >= margins.radius ? 'clear' : margins.front ? 'transit' : 'occulted'
}

// Classifies a moon against the planet's shadow: umbra when any part is in the umbra, penumbra when any
// part is only in the penumbra, otherwise none.
export function satelliteEclipseState(margins: PlanetEclipseMargins): SatelliteEclipseState {
	return !margins.valid ? 'none' : margins.umbraDistance < margins.radius ? 'umbra' : margins.penumbraDistance < margins.radius ? 'penumbra' : 'none'
}

// The sky basis of a geocentric view: unit vectors toward the east and the true north on the sky, and the
// line of sight, all in ICRF axes.
export interface SkyBasis {
	readonly east: Vec3
	readonly north: Vec3
	readonly lineOfSight: Vec3
}

// Builds the sky basis around `lineOfSight` (unit, ICRF) on the true equator of date at `time`: north
// toward the true celestial pole, east toward increasing right ascension. Evaluates the
// precession-nutation matrix, so it is meant for display rather than for scanning.
export function skyBasis(time: Time, lineOfSight: Vec3): SkyBasis {
	const pnm = precessionNutationMatrix(time)
	const truePole: Vec3 = [pnm[6], pnm[7], pnm[8]]
	const east = vecNormalize(vecCross(truePole, lineOfSight))
	const north = vecCross(lineOfSight, east)
	return { east, north, lineOfSight }
}

// Position angle of a unit vector `direction` on the sky of `basis`, from the true celestial north toward
// the east (radians, (−π, π]).
export function skyPositionAngle(basis: SkyBasis, direction: Vec3): number {
	return Math.atan2(vecDot(direction, basis.east), vecDot(direction, basis.north))
}

// Projects a planetocentric ICRF offset (AU), as seen from the Earth, to east/north sky offsets in apparent
// equatorial radii of a planet whose centre is at `planet` (barycentric AU) at geocentric `distance` (AU).
export function skyOffset(basis: SkyBasis, earth: Vec3, planet: Vec3, distance: number, equatorialRadius: number, offset: Vec3): readonly [number, number] {
	const direction = vecMinus(vecPlus(planet, offset), earth)
	const depth = vecDot(direction, basis.lineOfSight)
	const scale = distance / (depth * equatorialRadius)
	return [vecDot(direction, basis.east) * scale, vecDot(direction, basis.north) * scale]
}
