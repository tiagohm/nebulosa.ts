import { DAYSPERJC, J2000, PIOVERTWO, SPEED_OF_LIGHT_AU_DAY } from '../../core/constants'
import { type Mat3, matMulVec, matRotX, matRotZ } from '../../math/linear-algebra/mat3'
import { type Vec3, vecLength } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import { precessionNutationMatrix, type Time, timeShift, toJulianDay, tdb } from '../time/time'

// Body orientation from the IAU WGCCRE rotation elements (phase C1: Sun and planets). The rotation
// elements give the north-pole direction and the prime-meridian angle as functions of time; from them
// this module builds the ICRF -> body-fixed rotation and the sub-observer and sub-solar surface points.
// These are the geometric primitives behind central-meridian longitude, ring-opening angle and solar
// disk orientation. All angles are radians; the numeric tables live in orientation.data.ts.

// A single periodic correction added to a pole component or to the prime meridian. The argument is
// linear in T (Julian centuries TDB from J2000): argument = argConstant + argRate * T.
export interface PeriodicTerm {
	// Amplitude of the term (radians).
	readonly amplitude: Angle
	// Constant part of the argument (radians).
	readonly argConstant: Angle
	// Rate of the argument (radians per Julian century).
	readonly argRate: number
	// Whether the term multiplies cos(argument) instead of sin(argument).
	readonly cosine: boolean
}

// IAU rotation elements for a body: the north-pole direction polynomials in T, the prime-meridian
// angle W0 with its daily rate, and optional periodic corrections.
export interface RotationElements {
	// North-pole right ascension polynomial coefficients in T (radians): poleRa[0] + poleRa[1]*T + ...
	readonly poleRa: readonly Angle[]
	// North-pole declination polynomial coefficients in T (radians).
	readonly poleDec: readonly Angle[]
	// Prime-meridian angle W0 at J2000 (radians).
	readonly primeMeridian: Angle
	// Prime-meridian rate (radians per day); negative for retrograde rotators.
	readonly rotationRate: number
	// Optional periodic corrections to the pole right ascension.
	readonly poleRaTerms?: readonly PeriodicTerm[]
	// Optional periodic corrections to the pole declination.
	readonly poleDecTerms?: readonly PeriodicTerm[]
	// Optional periodic corrections to the prime-meridian angle.
	readonly primeMeridianTerms?: readonly PeriodicTerm[]
}

// The orientation of a body at an instant: the ICRF direction of its north pole and the angle of its
// prime meridian.
export interface BodyOrientation {
	// Right ascension of the north pole (radians, ICRF), normalized to [0, TAU).
	readonly poleRa: Angle
	// Declination of the north pole (radians, ICRF), in [-PI/2, PI/2].
	readonly poleDec: Angle
	// Prime-meridian angle W (radians), normalized to [0, TAU).
	readonly primeMeridian: Angle
}

// A point on a body's surface in body-fixed planetocentric coordinates.
export interface SurfacePoint {
	// Planetocentric east longitude measured from the IAU prime meridian (radians, [0, TAU)). For a
	// prograde body the planetographic (west-positive) longitude is TAU - longitude.
	readonly longitude: Angle
	// Planetocentric latitude (radians, [-PI/2, PI/2]).
	readonly latitude: Angle
}

// Evaluates a polynomial in T by Horner's method.
function polynomial(coefficients: readonly number[], t: number): number {
	let value = 0
	for (let i = coefficients.length - 1; i >= 0; i--) value = value * t + coefficients[i]
	return value
}

// Sums the periodic corrections at T (Julian centuries).
function periodic(terms: readonly PeriodicTerm[] | undefined, t: number): number {
	if (terms === undefined) return 0
	let sum = 0
	for (const term of terms) {
		const argument = term.argConstant + term.argRate * t
		sum += term.amplitude * (term.cosine ? Math.cos(argument) : Math.sin(argument))
	}
	return sum
}

// Computes the north-pole direction and prime-meridian angle of a body at a time.
//
// The rotation elements are evaluated at TDB: T is Julian centuries and d is days, both from J2000.
// The pole right ascension and the prime meridian are wrapped to [0, TAU); the declination is left in
// [-PI/2, PI/2].
export function orientation(elements: RotationElements, time: Time): BodyOrientation {
	const jd = toJulianDay(tdb(time))
	const d = jd - J2000
	const t = d / DAYSPERJC

	const poleRa = polynomial(elements.poleRa, t) + periodic(elements.poleRaTerms, t)
	const poleDec = polynomial(elements.poleDec, t) + periodic(elements.poleDecTerms, t)
	const primeMeridian = elements.primeMeridian + elements.rotationRate * d + periodic(elements.primeMeridianTerms, t)

	return { poleRa: normalizeAngle(poleRa), poleDec, primeMeridian: normalizeAngle(primeMeridian) }
}

// Builds the rotation matrix that takes an ICRF vector to the body-fixed frame at a time.
//
// The body-fixed frame has +Z along the north pole and +X toward the prime meridian; the matrix is the
// standard 3-1-3 Euler sequence R3(W) * R1(PI/2 - dec0) * R3(PI/2 + ra0). Multiply an ICRF vector by it
// (matMulVec) to obtain body-fixed coordinates.
export function bodyFixedMatrix(elements: RotationElements, time: Time): Mat3 {
	const { poleRa, poleDec, primeMeridian } = orientation(elements, time)
	return matRotZ(primeMeridian, matRotX(PIOVERTWO - poleDec, matRotZ(PIOVERTWO + poleRa)))
}

// Light-time delay in days for a body-observer distance in AU.
function lightDelay(distanceAu: number): number {
	return distanceAu / SPEED_OF_LIGHT_AU_DAY
}

// Projects an ICRF direction into body-fixed planetocentric longitude and latitude using a body-fixed
// rotation matrix. Only the direction of `direction` matters.
function project(matrix: Mat3, direction: Vec3): SurfacePoint {
	const [x, y, z] = matMulVec(matrix, direction)
	const r = Math.sqrt(x * x + y * y + z * z)
	const latitude = Math.asin(clamp(z / r, -1, 1))
	const longitude = normalizeAngle(Math.atan2(y, x))
	return { longitude, latitude }
}

// Computes the sub-observer point: the body-fixed longitude and latitude beneath the observer.
//
// `bodyToObserver` is the vector from the body centre to the observer in AU (ICRF); its length sets the
// light-time delay and its direction sets the point. The body orientation is evaluated at the retarded
// time (observation time minus the one-way light time), which matters for fast rotators such as
// Jupiter, where the prime meridian advances ~18 deg over the light time. The result is the central
// meridian seen by the observer.
export function subObserverPoint(elements: RotationElements, time: Time, bodyToObserver: Vec3): SurfacePoint {
	const emitted = timeShift(time, -lightDelay(vecLength(bodyToObserver)))
	return project(bodyFixedMatrix(elements, emitted), bodyToObserver)
}

// Computes the sub-solar point: the body-fixed longitude and latitude beneath the Sun.
//
// `bodyToObserver` (AU, ICRF) sets the retarded time so the result matches what the observer sees;
// `bodyToSun` (AU, ICRF) is the direction from the body centre to the Sun, whose tiny change over the
// light time is neglected. The sub-solar latitude is the Sun's elevation above the body's equator,
// and the difference between the sub-solar and sub-observer longitudes is the phase geometry.
export function subSolarPoint(elements: RotationElements, time: Time, bodyToObserver: Vec3, bodyToSun: Vec3): SurfacePoint {
	const emitted = timeShift(time, -lightDelay(vecLength(bodyToObserver)))
	return project(bodyFixedMatrix(elements, emitted), bodyToSun)
}

// Computes the position angle of a body's north pole projected onto the sky plane.
//
// The angle is measured at the body's apparent disk centre from celestial north (the direction of
// increasing declination) toward east (increasing right ascension), normalized to (-PI, PI]. For the
// Sun this is the classical position angle P of the rotation axis (about +/-26 deg over the year);
// for a planet it is the tilt of the apparent disk's polar axis. `bodyToObserver` is the vector from
// the body centre to the observer (ICRF, AU): its direction sets the disk-centre line of sight and its
// length the light-time delay used to evaluate the pole.
//
// Position angle is referred to the true equator and equinox of date, so both the pole and the
// line of sight are precessed and nutated from J2000 before the sky-plane north is taken; annual
// aberration of the disk-centre direction (~20 arcsec) is neglected.
export function positionAngleOfPole(elements: RotationElements, time: Time, bodyToObserver: Vec3): Angle {
	const emitted = timeShift(time, -lightDelay(vecLength(bodyToObserver)))
	const { poleRa, poleDec } = orientation(elements, emitted)

	const cosPoleDec = Math.cos(poleDec)
	const pole: Vec3 = [cosPoleDec * Math.cos(poleRa), cosPoleDec * Math.sin(poleRa), Math.sin(poleDec)]

	// Rotate the pole and the disk-centre direction (observer -> body) to the true equator of date.
	const pnm = precessionNutationMatrix(time)
	const [px, py, pz] = matMulVec(pnm, pole)
	const [ox, oy, oz] = matMulVec(pnm, [-bodyToObserver[0], -bodyToObserver[1], -bodyToObserver[2]])

	const ra = Math.atan2(oy, ox)
	const dec = Math.atan2(oz, Math.sqrt(ox * ox + oy * oy))
	const sinRa = Math.sin(ra)
	const cosRa = Math.cos(ra)
	const sinDec = Math.sin(dec)
	const cosDec = Math.cos(dec)

	// Sky-plane basis at the disk centre: north = increasing Dec, east = increasing RA.
	const northDot = -px * sinDec * cosRa - py * sinDec * sinRa + pz * cosDec
	const eastDot = -px * sinRa + py * cosRa

	return normalizePI(Math.atan2(eastDot, northDot))
}

export { EARTH_ROTATION, JUPITER_ROTATION, MARS_ROTATION, MERCURY_ROTATION, MOON_ROTATION, NEPTUNE_ROTATION, SATURN_ROTATION, SUN_ROTATION, URANUS_ROTATION, VENUS_ROTATION } from './orientation.data'
