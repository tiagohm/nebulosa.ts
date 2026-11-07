import { JUPITER_EQUATORIAL_RADIUS_AU, JUPITER_POLAR_RADIUS_AU, SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU } from '../../core/constants'
import { type Mat3, matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import { intersectSegmentEllipsoid, signedDistanceToEllipse } from '../../math/numerical/geometry'
import type { Angle } from '../../math/units/angle'
import { bodyFixedMatrix, JUPITER_ROTATION, JUPITER_SYSTEM_II, orientation } from '../bodies/orientation'
import { GALILEAN_MOONS, GALILEAN_RADIUS_AU, type GalileanMoon, type JovianBody, type JovianEphemeris } from '../ephemeris/jovian'
import { precessionNutationMatrix, type Time, timeShift } from '../time/time'
import { jupiterCentralMeridian } from './jupiter'

// Apparent geometry of Jupiter and its Galilean satellites for a geocentric observer: the oblate
// planetary disk, the satellites' disks, the satellites' shadows on Jupiter, and Jupiter's shadow on the
// satellites. All states come from one JovianEphemeris; positions are barycentric ICRF in AU.
//
// Time convention: every function takes the observed instant at the geocentre. Jupiter and each moon
// are light-time retarded independently, so a moon is never compared with a differently retarded
// Jupiter. A moon's shadow on Jupiter is evaluated when Jupiter emits the light seen at the observed
// instant, from the moon one moon-to-Jupiter light time earlier and the Sun one Sun-to-Jupiter light
// time earlier. Jupiter's shadow on a moon is evaluated when the moon emits the light seen at the
// observed instant, from Jupiter and the Sun one light time earlier still. Every contact derived from
// these margins is therefore an observed geocentric instant, not a topocentric one.
//
// Jupiter is an oblate spheroid (IAU 1-bar radii) whose outline, seen along any direction, is an ellipse:
// semi-major axis a perpendicular to the projected pole and semi-minor axis a·√(1 − e²cos²δ), where δ is
// the planetocentric latitude of the viewer. A projected point is compared with that outline by its exact
// signed distance. The satellites are spheres of their mean radii. Shadows are finite-Sun cones: a moon's
// penumbra widens, and its umbra narrows, linearly with distance behind it; Jupiter's shadow cross-section
// at a distance s behind its centre is the Sun-view outline scaled uniformly by the cone ratio at s, exact
// for a sphere and an approximation, documented here, for the oblate planet.
//
// Margins are in Jupiter equatorial radii: angular radii for the Earth view (apparent disk), linear
// radii for the Sun view (shadow geometry). Apparent sky offsets use the true equator of date, east
// toward increasing right ascension and north toward the true celestial pole; aberration is neglected.

// Fixed-point light-time iterations; three converge to well under a millisecond at Jupiter's distance.
const LIGHT_TIME_ITERATIONS = 3

// Square eccentricity of Jupiter's meridian section, 1 − (b/a)², from the IAU 1-bar radii.
const JUPITER_ECCENTRICITY_SQUARED = 1 - (JUPITER_POLAR_RADIUS_AU / JUPITER_EQUATORIAL_RADIUS_AU) ** 2

// Smallest projected-pole length (unit vectors) below which the pole is taken as pointing at the viewer
// and the outline is a circle in any orientation.
const POLE_ON_EPSILON = 1e-12

// One body retarded for the light travelling from it to a fixed receiver.
interface Retarded {
	// Barycentric position (AU, ICRF) at the emission time.
	readonly position: Vec3
	// Emission instant: the reception instant minus the one-way light time.
	readonly emissionTime: Time
}

// Retards `body` for the light reaching `receiver` (barycentric AU, fixed at the reception instant).
function retard(ephemeris: JovianEphemeris, body: JovianBody, receiver: Vec3, time: Time): Retarded {
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

// Jupiter's outline seen along a direction, in the plane perpendicular to it.
interface Outline {
	// Unit vector (ICRF) along the outline's semi-major axis, perpendicular to the projected pole.
	readonly major: Vec3
	// Unit vector (ICRF) along the outline's semi-minor axis, toward the projected north pole.
	readonly minor: Vec3
	// Semi-minor to semi-major axis ratio of the outline, in [b/a, 1].
	readonly ratio: number
}

// Outline of Jupiter seen along `view` (unit, from the viewer toward Jupiter) with north pole `pole`
// (unit, ICRF). A pole pointing at the viewer gives a circle with arbitrary axes.
function outline(view: Vec3, pole: Vec3): Outline {
	const along = vecDot(pole, view)
	const projected = vecMinus(pole, vecMulScalar(view, along))
	const length = vecLength(projected)
	const minor = length > POLE_ON_EPSILON ? vecMulScalar(projected, 1 / length) : vecNormalize(vecCross(view, Math.abs(view[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
	const major = vecCross(minor, view)
	const ratio = Math.sqrt(1 - JUPITER_ECCENTRICITY_SQUARED * (1 - along * along))
	return { major, minor, ratio }
}

// Jupiter's north pole (unit, ICRF) from the IAU System III elements at a time.
function jupiterPole(time: Time): Vec3 {
	const { poleRa, poleDec } = orientation(JUPITER_ROTATION, time)
	const cosDec = Math.cos(poleDec)
	return [cosDec * Math.cos(poleRa), cosDec * Math.sin(poleRa), Math.sin(poleDec)]
}

// The state shared by every moon at one observed instant.
export interface JovianSystemState {
	// Observed instant at the geocentre.
	readonly time: Time
	// Barycentric position of the Earth at the observed instant (AU, ICRF).
	readonly earth: Vec3
	// Barycentric position of Jupiter's centre at its emission instant (AU, ICRF).
	readonly jupiter: Vec3
	// Instant Jupiter emitted the light seen at `time`.
	readonly emissionTime: Time
	// Geocentric distance of Jupiter's centre (AU).
	readonly distance: number
	// Unit vector from the Earth toward Jupiter's apparent centre (ICRF).
	readonly lineOfSight: Vec3
	// Jupiter's north pole at the emission instant (unit, ICRF).
	readonly pole: Vec3
	// Barycentric position of the Sun one Sun-to-Jupiter light time before the emission instant (AU, ICRF).
	readonly sun: Vec3
	// Jupiter's outline seen from the Earth.
	readonly outline: Outline
}

// Computes the state shared by every moon at an observed instant: the Earth, the retarded Jupiter, its
// pole and outline, and the Sun that lights it.
export function jovianSystemState(ephemeris: JovianEphemeris, time: Time): JovianSystemState {
	const earth = ephemeris.position('earth', time)
	const { position: jupiter, emissionTime } = retard(ephemeris, 'jupiter', earth, time)
	const toJupiter = vecMinus(jupiter, earth)
	const distance = vecLength(toJupiter)
	const lineOfSight = vecMulScalar(toJupiter, 1 / distance)
	const pole = jupiterPole(emissionTime)
	const sun = retard(ephemeris, 'sun', jupiter, emissionTime).position
	return { time, earth, jupiter, emissionTime, distance, lineOfSight, pole, sun, outline: outline(lineOfSight, pole) }
}

// A moon against Jupiter's apparent disk, seen from the Earth.
export interface JovianDiskMargins {
	// Elliptic radius of the moon's centre in the apparent outline: √(x² + (y/ratio)²) with x and y the
	// offsets along the outline's major and minor axes in apparent equatorial radii. Below one inside the
	// outline; smooth, with one minimum per conjunction.
	readonly ellipticRadius: number
	// Signed angular distance of the moon's centre from Jupiter's limb, in apparent equatorial radii:
	// negative inside the outline.
	readonly distance: number
	// Apparent radius of the moon, in apparent equatorial radii of Jupiter.
	readonly radius: number
	// Whether the moon is nearer the Earth than Jupiter's centre: a transit when the disks overlap,
	// otherwise an occultation.
	readonly front: boolean
	// Barycentric position of the moon at its emission instant (AU, ICRF).
	readonly position: Vec3
	// Instant the moon emitted the light seen at the observed instant.
	readonly emissionTime: Time
}

// A moon's shadow against Jupiter, seen from the Sun.
export interface JovianShadowMargins {
	// Elliptic radius of the shadow axis in Jupiter's outline seen along the axis, in equatorial radii.
	readonly ellipticRadius: number
	// Signed distance of the shadow axis from that outline, in equatorial radii: negative on the disk.
	readonly distance: number
	// Penumbral radius of the moon's shadow at Jupiter's centre plane, in equatorial radii.
	readonly penumbra: number
	// Umbral radius of the moon's shadow at Jupiter's centre plane, in equatorial radii; may be negative
	// beyond the umbra's apex.
	readonly umbra: number
	// Whether the moon lies between the Sun and Jupiter's centre plane, so its shadow can fall on Jupiter.
	readonly valid: boolean
	// Barycentric position of the moon casting the shadow (AU, ICRF).
	readonly moon: Vec3
	// Unit direction of the shadow axis, from the Sun through the moon (ICRF).
	readonly axis: Vec3
}

// A moon against Jupiter's shadow.
export interface JovianEclipseMargins {
	// Elliptic radius of the moon's centre in Jupiter's unscaled Sun-view outline, in equatorial radii.
	readonly ellipticRadius: number
	// Signed distance of the moon's centre from the umbra's boundary at the moon, in equatorial radii.
	readonly umbraDistance: number
	// Signed distance of the moon's centre from the penumbra's outer boundary at the moon, in equatorial radii.
	readonly penumbraDistance: number
	// Radius of the moon, in equatorial radii of Jupiter.
	readonly radius: number
	// Whether the moon lies behind Jupiter's centre plane as seen from the Sun, so it can enter the shadow.
	readonly valid: boolean
}

// Margins of one moon at one observed instant.
export interface JovianMoonMargins {
	readonly moon: GalileanMoon
	readonly disk: JovianDiskMargins
	readonly shadow: JovianShadowMargins
	readonly eclipse: JovianEclipseMargins
}

// Elliptic radius of (x, y) in an outline of unit semi-major axis and the given ratio.
function ellipticRadius(x: number, y: number, ratio: number): number {
	const yy = y / ratio
	return Math.sqrt(x * x + yy * yy)
}

// Computes the disk, shadow and eclipse margins of a moon at the observed instant of `state`.
//
// Disk: the moon is retarded for its own light time to the Earth and projected gnomonically on the sky
// around Jupiter's apparent centre. Shadow: at Jupiter's emission instant, the axis from the retarded Sun
// through the moon (one moon-to-Jupiter light time earlier) is projected on the plane through Jupiter's
// centre perpendicular to it; the moon's cone radii are evaluated at that plane. Eclipse: at the moon's
// emission instant, the moon is projected on the plane through Jupiter's centre perpendicular to the
// Sun-to-Jupiter axis, with Jupiter and the Sun retarded for the light that reaches the moon.
export function jovianMoonMargins(ephemeris: JovianEphemeris, state: JovianSystemState, moon: GalileanMoon): JovianMoonMargins {
	const radius = GALILEAN_RADIUS_AU[moon]
	const a = JUPITER_EQUATORIAL_RADIUS_AU

	// Disk, seen from the Earth at the observed instant.
	const seen = retard(ephemeris, moon, state.earth, state.time)
	const toMoon = vecMinus(seen.position, state.earth)
	const depth = vecDot(toMoon, state.lineOfSight)
	const apparentRadius = a / state.distance
	const diskX = vecDot(toMoon, state.outline.major) / depth / apparentRadius
	const diskY = vecDot(toMoon, state.outline.minor) / depth / apparentRadius
	const disk: JovianDiskMargins = {
		ellipticRadius: ellipticRadius(diskX, diskY, state.outline.ratio),
		distance: signedDistanceToEllipse(diskX, diskY, 1, state.outline.ratio),
		radius: radius / vecLength(toMoon) / apparentRadius,
		front: depth < state.distance,
		position: seen.position,
		emissionTime: seen.emissionTime,
	}

	// Shadow on Jupiter at Jupiter's emission instant.
	const caster = retard(ephemeris, moon, state.jupiter, state.emissionTime).position
	const sunToMoon = vecMinus(caster, state.sun)
	const sunMoonDistance = vecLength(sunToMoon)
	const axis = vecMulScalar(sunToMoon, 1 / sunMoonDistance)
	const shadowOutline = outline(axis, state.pole)
	const moonToJupiter = vecMinus(state.jupiter, caster)
	const along = vecDot(moonToJupiter, axis)
	const shadowX = -vecDot(moonToJupiter, shadowOutline.major) / a
	const shadowY = -vecDot(moonToJupiter, shadowOutline.minor) / a
	const shadow: JovianShadowMargins = {
		ellipticRadius: ellipticRadius(shadowX, shadowY, shadowOutline.ratio),
		distance: signedDistanceToEllipse(shadowX, shadowY, 1, shadowOutline.ratio),
		penumbra: (radius + (along * (SUN_RADIUS_AU + radius)) / sunMoonDistance) / a,
		umbra: (radius - (along * (SUN_RADIUS_AU - radius)) / sunMoonDistance) / a,
		valid: along > 0,
		moon: caster,
		axis,
	}

	// Eclipse by Jupiter at the moon's emission instant.
	const shadowing = retard(ephemeris, 'jupiter', seen.position, seen.emissionTime).position
	const star = retard(ephemeris, 'sun', seen.position, seen.emissionTime).position
	const sunToJupiter = vecMinus(shadowing, star)
	const sunJupiterDistance = vecLength(sunToJupiter)
	const sunAxis = vecMulScalar(sunToJupiter, 1 / sunJupiterDistance)
	const sunOutline = outline(sunAxis, state.pole)
	const jupiterToMoon = vecMinus(seen.position, shadowing)
	const behind = vecDot(jupiterToMoon, sunAxis)
	const eclipseX = vecDot(jupiterToMoon, sunOutline.major) / a
	const eclipseY = vecDot(jupiterToMoon, sunOutline.minor) / a
	const umbraScale = 1 - (behind * (SUN_RADIUS_AU - a)) / (sunJupiterDistance * a)
	const penumbraScale = 1 + (behind * (SUN_RADIUS_AU + a)) / (sunJupiterDistance * a)
	const eclipse: JovianEclipseMargins = {
		ellipticRadius: ellipticRadius(eclipseX, eclipseY, sunOutline.ratio),
		umbraDistance: signedDistanceToEllipse(eclipseX, eclipseY, umbraScale, umbraScale * sunOutline.ratio),
		penumbraDistance: signedDistanceToEllipse(eclipseX, eclipseY, penumbraScale, penumbraScale * sunOutline.ratio),
		radius: radius / a,
		valid: behind > 0,
	}

	return { moon, disk, shadow, eclipse }
}

// The centre of a moon's shadow on Jupiter's surface.
export interface JovianShadowPoint {
	// Position of the shadow centre relative to Jupiter's centre at its emission instant (AU, ICRF).
	readonly offset: Vec3
	// Cosine of the angle between the surface normal at the shadow centre and the direction to the Earth:
	// positive when the shadow centre is on the hemisphere facing the Earth.
	readonly earthCosine: number
}

// Intersects a moon's shadow axis with Jupiter's spheroid and returns the shadow centre, or undefined
// when the axis misses the planet or the moon is not between the Sun and Jupiter. The body-fixed frame
// at Jupiter's emission instant is used, so the point is where the observer sees it.
export function jovianShadowPoint(state: JovianSystemState, shadow: JovianShadowMargins): JovianShadowPoint | undefined {
	if (!shadow.valid) return undefined

	const rotation = bodyFixedMatrix(JUPITER_ROTATION, state.emissionTime)
	const fromJupiter = vecMinus(shadow.moon, state.jupiter)
	const reach = 2 * vecLength(fromJupiter)
	const start = matMulVec(rotation, fromJupiter)
	const end = matMulVec(rotation, vecPlus(fromJupiter, vecMulScalar(shadow.axis, reach)))
	const hit = intersectSegmentEllipsoid(start, end, JUPITER_EQUATORIAL_RADIUS_AU, JUPITER_POLAR_RADIUS_AU)
	if (!hit.intersects || hit.intersection === undefined) return undefined

	const t = hit.intersection
	const point: Vec3 = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, start[2] + (end[2] - start[2]) * t]
	return { offset: matTransposeMulVec(rotation, point), earthCosine: surfaceCosine(rotation, point, vecMinus(state.earth, state.jupiter)) }
}

// Cosine of the angle between the outward normal of Jupiter's spheroid at the body-fixed `point` and the
// direction from that point toward the jovicentric ICRF position `toward`.
function surfaceCosine(rotation: Mat3, point: Vec3, toward: Vec3): number {
	const a2 = JUPITER_EQUATORIAL_RADIUS_AU * JUPITER_EQUATORIAL_RADIUS_AU
	const b2 = JUPITER_POLAR_RADIUS_AU * JUPITER_POLAR_RADIUS_AU
	const normal: Vec3 = [point[0] / a2, point[1] / a2, point[2] / b2]
	const direction = vecMinus(matMulVec(rotation, toward), point)
	return vecDot(normal, direction) / (vecLength(normal) * vecLength(direction))
}

// How a moon appears against Jupiter's disk.
export type JovianDiskState = 'clear' | 'transit' | 'occulted'

// How much of Jupiter's shadow covers a moon.
export type JovianEclipseState = 'none' | 'penumbra' | 'umbra'

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
	readonly basis: Readonly<{ east: Vec3; north: Vec3; lineOfSight: Vec3 }>
	// Barycentric position of the Earth at the observed instant (AU, ICRF).
	readonly earth: Vec3
	// Barycentric position of Jupiter's centre at its emission instant (AU, ICRF).
	readonly jupiter: Vec3
}

// Projects a jovicentric ICRF offset (AU), as seen from the Earth, to east/north sky offsets in apparent
// equatorial radii of Jupiter.
function skyOffset(view: Pick<JovianView, 'earth' | 'jupiter' | 'basis' | 'distance'>, offset: Vec3): readonly [number, number] {
	const direction = vecMinus(vecPlus(view.jupiter, offset), view.earth)
	const depth = vecDot(direction, view.basis.lineOfSight)
	const scale = view.distance / (depth * JUPITER_EQUATORIAL_RADIUS_AU)
	return [vecDot(direction, view.basis.east) * scale, vecDot(direction, view.basis.north) * scale]
}

// Computes the apparent view of Jupiter and its four Galilean satellites at an observed instant: the
// disk size and orientation, the central meridians, and each moon's sky offset, depth, disk and eclipse
// states and shadow. Unlike the margins, it evaluates the precession-nutation matrix for the sky basis,
// so it is meant for display rather than for scanning.
export function jovianView(ephemeris: JovianEphemeris, time: Time): JovianView {
	const state = jovianSystemState(ephemeris, time)
	const pnm = precessionNutationMatrix(time)
	const truePole: Vec3 = [pnm[6], pnm[7], pnm[8]]
	const lineOfSight = state.lineOfSight
	const east = vecNormalize(vecCross(truePole, lineOfSight))
	const north = vecCross(lineOfSight, east)
	const basis = { east, north, lineOfSight }
	const jupiterToEarth = vecMinus(state.earth, state.jupiter)
	const jupiterToSun = vecMinus(state.sun, state.jupiter)
	const equatorialRadius = Math.atan(JUPITER_EQUATORIAL_RADIUS_AU / state.distance)
	const partial = { earth: state.earth, jupiter: state.jupiter, basis, distance: state.distance }

	const moons = GALILEAN_MOONS.map((moon): JovianMoonView => {
		const margins = jovianMoonMargins(ephemeris, state, moon)
		const [moonEast, moonNorth] = skyOffset(partial, vecMinus(margins.disk.position, state.jupiter))
		const depth = (state.distance - vecDot(vecMinus(margins.disk.position, state.earth), lineOfSight)) / JUPITER_EQUATORIAL_RADIUS_AU
		const overlapping = margins.disk.distance < margins.disk.radius
		const disk: JovianDiskState = !overlapping ? 'clear' : margins.disk.front ? 'transit' : 'occulted'
		const { eclipse: e } = margins
		const eclipse: JovianEclipseState = !e.valid ? 'none' : e.umbraDistance < e.radius ? 'umbra' : e.penumbraDistance < e.radius ? 'penumbra' : 'none'
		const point = jovianShadowPoint(state, margins.shadow)
		let shadow: JovianShadowView | undefined

		if (point !== undefined) {
			const [shadowEast, shadowNorth] = skyOffset(partial, point.offset)
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
		poleAngle: Math.atan2(vecDot(state.pole, east), vecDot(state.pole, north)),
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
	const [skyEast, skyNorth] = skyOffset(view, offset)
	return { east: skyEast, north: skyNorth, visible: surfaceCosine(rotation, point, vecMinus(view.earth, view.jupiter)) > 0 }
}
