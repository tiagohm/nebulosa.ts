import type { Angle } from './angle'
import type { PositionAndVelocity } from './astrometry'
import { GM_SUN_PITJEVA_2005, PI, TAU } from './constants'
import type { CartesianCoordinate } from './coordinate'
import type { Distance } from './distance'
import { ECLIPTIC_J2000_MATRIX } from './frame'
import { type Mat3, mulMatVec, transpose } from './matrix'
import { type MPCOrbit, unpackDate } from './mpcorb'
import { type Time, Timescale, subtractTime, timeYMD, tt } from './time'
import { cross, divVecScalar, dot, length, minusVec, mulVecScalar, plusVec, zeroVec } from './vector'

const REFERENCE_FRAME: Mat3 = transpose(ECLIPTIC_J2000_MATRIX)

// Glossary

// a: semi-major axis (au)
// p: semilatus rectum (au)
// e: eccentricity
// i: inclination (radians)
// om: longitude of ascending node (radians)
// w: argument of perihelion (radians)
// ma: mean anomaly (radians)

export type StumpffOutput = [number, number, number, number]

// Creates a `KeplerOrbit` for asteroid from semi-major axis, eccentricity, inclination, longitude of ascending node, argument of perihelion and mean anomaly at epoch.
export function asteroid(a: Distance, e: number, i: Angle, om: Angle, w: Angle, ma: Angle, epoch: Time) {
	return meanAnomaly(a * (1 - e * e), e, i, om, w, ma, epoch)
}

// Creates a `KeplerOrbit` for asteroid from MPC orbit.
export function mpcAsteroid(mpcorb: MPCOrbit) {
	const { semiMajorAxis, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, meanAnomaly, epochPacked } = mpcorb
	const epoch = timeYMD(...unpackDate(epochPacked), Timescale.TT)
	return asteroid(semiMajorAxis, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, meanAnomaly, epoch)
}

export class KeplerOrbit {
	constructor(
		readonly position: CartesianCoordinate,
		readonly velocity: CartesianCoordinate,
		readonly epoch: Time,
		readonly mu: number = GM_SUN_PITJEVA_2005,
		readonly rotation: Mat3 = REFERENCE_FRAME,
	) {}

	at(time: Time) {
		const pv = propagate(this.position, this.velocity, tt(this.epoch), tt(time), this.mu)

		if (this.rotation) {
			mulMatVec(this.rotation, pv[0], pv[0] as never)
			mulMatVec(this.rotation, pv[1], pv[1] as never)
		}

		return pv
	}
}

// Creates a `KeplerOrbit` from orbital elements using mean anomaly.
export function meanAnomaly(p: Distance, e: number, i: Angle, om: Angle, w: Angle, ma: Angle, epoch: Time, mu: number = GM_SUN_PITJEVA_2005, rotation: Mat3 = REFERENCE_FRAME) {
	let v: number

	if (e < 1) v = trueAnomalyClosed(e, eccentricAnomaly(e, ma))
	else if (e > 1) v = trueAnomalyHyperbolic(e, eccentricAnomaly(e, ma))
	else v = trueAnomalyParabolic(p, mu, ma)

	return trueAnomaly(p, e, i, om, w, v, epoch, mu, rotation)
}

// Creates a `KeplerOrbit` from orbital elements using true anomaly.
export function trueAnomaly(p: Distance, e: number, i: Angle, om: Angle, w: Angle, ma: Angle, epoch: Time, mu: number = GM_SUN_PITJEVA_2005, rotation: Mat3 = REFERENCE_FRAME) {
	const [position, velocity] = computePositionAndVelocityFromOrbitalElements(p, e, i, om, w, ma, mu)
	return new KeplerOrbit(position, velocity, epoch, mu, rotation)
}

// Iterates to solve Kepler's equation to find eccentric anomaly.
// Based on the algorithm in section 8.10.2 of the Explanatory Supplement
// to the Astronomical Almanac, 3rd ed.
function eccentricAnomaly(e: number, M: Angle): Angle {
	const m = ((M + PI) % TAU) - PI
	let E = m + e * Math.sin(m)

	for (let i = 0; i <= 99; i++) {
		const dM = m - (E - e * Math.sin(E))
		const dE = dM / (1 - e * Math.cos(E))

		E += dE

		if (Math.abs(dE) < 1e-14) break
	}

	return E
}

// Computes true anomaly from eccentricity `e` and eccentric anomaly `E` for hyperbolic orbits.
export function trueAnomalyHyperbolic(e: number, E: Angle): Angle {
	return 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(E / 2))
}

// Computes true anomaly from eccentricity `e` and eccentric anomaly `E` for closed orbits.
export function trueAnomalyClosed(e: number, E: Angle): Angle {
	return 2 * Math.atan(Math.sqrt((1 + e) / (1 - e)) * Math.tan(E / 2))
}

// Computes the true anomaly from semi-latus rectum `p`, `mu`, and mean anomaly `M` for parabolic orbits.
export function trueAnomalyParabolic(p: Distance, mu: number, M: Angle): Angle {
	// From http://www.bogan.ca/orbits/kepler/orbteqtn.html
	const dt = Math.sqrt((2 * (p * p * p)) / mu) * M
	const periapsis = p / 2
	const a = 1.5 * Math.sqrt(mu / (2 * (periapsis * periapsis * periapsis))) * dt
	const b = Math.cbrt(a + (a * a + 1))
	return 2 * Math.atan(b - 1 / b)
}

// Computes the state vectors from orbital elements.
// Based on equations from this document:
// https://web.archive.org/web/*/http://ccar.colorado.edu/asen5070/handouts/kep2cart_2002.doc
function computePositionAndVelocityFromOrbitalElements(p: Distance, e: number, i: Angle, om: Angle, w: Angle, v: Angle, mu: number): PositionAndVelocity {
	// Checks that true anomaly is less than arccos(-1/e) for hyperbolic orbits.
	if (e > 1 && v > Math.acos(-1 / e)) {
		throw new Error('if eccentricity is > 1, abs(true anomaly) cannot be more than acos(-1/e)')
	}

	const r = p / (1 + e * Math.cos(v))
	const h = Math.sqrt(p * mu)
	const u = v + w

	const cosOm = Math.cos(om)
	const sinOm = Math.sin(om)
	const cosu = Math.cos(u)
	const sinu = Math.sin(u)
	const cosi = Math.cos(i)
	const sini = Math.sin(i)
	const sinv = Math.sin(v)

	const x = r * (cosOm * cosu - sinOm * sinu * cosi)
	const y = r * (sinOm * cosu + cosOm * sinu * cosi)
	const z = r * (sini * sinu)

	const xDot = ((x * h * e) / (r * p)) * sinv - (h / r) * (cosOm * sinu + sinOm * cosu * cosi)
	const yDot = ((y * h * e) / (r * p)) * sinv - (h / r) * (sinOm * sinu - cosOm * cosu * cosi)
	const zDot = ((z * h * e) / (r * p)) * sinv + (h / r) * sini * cosu

	const position: CartesianCoordinate = [x, y, z]
	const velocity: CartesianCoordinate = [xDot, yDot, zDot]

	return [position, velocity]
}

const LN_1_5 = 0.4054651081081644
const LN_HALF_DOUBLE_MAX = 709.0895657128241
const LN_DOUBLE_MAX = 709.782712893384

/**
 * Propagates a `position` and `velocity` vector over time.
 *
 * @param position Position in km.
 * @param velocity Velocity in km/s.
 * @param t0 `Time` corresponding to `position` and `velocity`.
 * @param t1 `Time` to propagate to.
 * @param mu Gravitational parameter in units that match the other arguments.
 */
function propagate(position: CartesianCoordinate, velocity: CartesianCoordinate, t0: Time, t1: Time, mu: number): PositionAndVelocity {
	const r0 = length(position)
	const rv = dot(position, velocity)
	const hvec = cross(position, velocity)
	const h2 = dot(hvec, hvec)

	if (h2 === 0) {
		throw new Error('motion is not conical')
	}

	divVecScalar(cross(velocity, hvec, hvec), mu, hvec)
	minusVec(hvec, divVecScalar(position, r0), hvec)
	const e = length(hvec)
	const q = h2 / (mu * (1 + e))

	const f = 1 - e
	const b = Math.sqrt(q / mu)

	const br0 = b * r0
	const b2rv = b * b * rv
	const bq = b * q
	const qovr0 = q / r0

	const maxc = Math.max(Math.abs(br0), Math.max(Math.abs(b2rv), Math.max(Math.abs(bq), Math.abs(qovr0))))
	let bound: number

	// Hyperbolic
	if (f < 0) {
		const fixed = LN_HALF_DOUBLE_MAX - Math.log(maxc)
		const root = Math.sqrt(-f)
		bound = Math.min(fixed / root, (fixed + 1.5 * Math.log(-f)) / root)
	} else {
		bound = Math.exp((LN_1_5 + LN_DOUBLE_MAX - Math.log(maxc)) / 3)
	}

	const s: StumpffOutput = [0, 0, 0, 0]

	function kepler(x: number) {
		const c = stumpff(f * x * x, s)
		return x * (br0 * c[1] + x * (b2rv * c[2] + x * bq * c[3]))
	}

	const dt = subtractTime(t1, t0) // T1 - T0
	let x = Math.max(-bound, Math.min(dt / bq, bound))

	let kfun = kepler(x)

	let lower = dt < 0 ? x : 0
	let upper = dt > 0 ? x : 0

	while (dt < 0 && kfun > dt) {
		upper = lower

		lower *= 2

		const px = x
		x = Math.max(-bound, Math.min(lower, bound))
		if (x === px) throw new Error(`The delta time ${dt} is beyond the range`)

		kfun = kepler(x)
	}

	while (dt > 0 && kfun < dt) {
		lower = upper

		upper *= 2

		const px = x
		x = Math.max(-bound, Math.min(upper, bound))
		if (x === px) throw new Error('The delta time $dt is beyond the range')

		kfun = kepler(x)
	}

	x = lower <= upper ? (upper + lower) / 2 : upper

	let count = 64

	while (count-- > 0 && lower < x && x < upper) {
		kfun = kepler(x)

		if (kfun >= dt) upper = x
		if (kfun <= dt) lower = x

		x = (upper + lower) / 2
	}

	const x2 = x * x
	const c = stumpff(f * x2, s)
	const br = br0 * c[0] + x * b2rv * c[1] + x2 * bq * c[2]

	const pc = 1 - qovr0 * x2 * c[2]
	const vc = dt - bq * x2 * x * c[3]
	const pcdot = -(qovr0 / br) * x * c[1]
	const vcdot = 1 - (bq / br) * x2 * c[2]

	const p = zeroVec()
	const v = zeroVec()

	plusVec(mulVecScalar(position, pc, s as never), mulVecScalar(velocity, vc, p), p)
	plusVec(mulVecScalar(position, pcdot, s as never), mulVecScalar(velocity, vcdot, v), v)

	return [p, v]
}

const C2_DIV = [1 * 2, 3 * 4, 5 * 6, 7 * 8, 9 * 10, 11 * 12, 13 * 14, 15 * 16, 17 * 18].map((e) => 1 / e)
const C3_DIV = [2 * 3, 4 * 5, 6 * 7, 8 * 9, 10 * 11, 12 * 13, 14 * 15, 16 * 17, 18 * 19].map((e) => 1 / e)

// Computes Stumpff functions.
// Based on the function toolkit/src/spicelib/stmp03.f from the SPICE toolkit.
export function stumpff(x: number, o?: StumpffOutput) {
	const c = o ?? [0, 0, 0, 0]

	if (x < -1) {
		const z = Math.sqrt(-x)
		c[0] = Math.cosh(z)
		c[1] = Math.sinh(z) / z
		c[2] = (1 - c[0]) / x
		c[3] = (1 - c[1]) / x
	} else if (x > 1) {
		const z = Math.sqrt(x)
		c[0] = Math.cos(z)
		c[1] = Math.sin(z) / z
		c[2] = (1 - c[0]) / x
		c[3] = (1 - c[1]) / x
	} else {
		c[2] = 1
		c[3] = 1

		for (let i = 8; i >= 1; i--) {
			c[2] = 1 - x * C2_DIV[i] * c[2]
			c[3] = 1 - x * C3_DIV[i] * c[3]
		}

		c[2] *= C2_DIV[0]
		c[3] *= C3_DIV[0]

		c[1] = 1 - x * c[3]
		c[0] = 1 - x * c[2]
	}

	return c
}
