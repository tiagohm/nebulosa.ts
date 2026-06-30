import { ECLIPTIC_J2000_MATRIX, GM_SUN_PITJEVA_2005, TAU } from '../../core/constants'
import type { Writable } from '../../core/types'
import { type Mat3, matMulVec, matTranspose } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecCrossLength, vecDivScalar, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { PositionAndVelocity } from '../coordinates/astrometry'
import type { CartesianCoordinate } from '../coordinates/coordinate'
import { type Time, Timescale, tdb, time, timeSubtract, timeYMD } from '../time/time'
import { type MPCOrbit, type MPCOrbitComet, unpackDate } from './mpcorb'

// Keplerian two-body orbit modeling for asteroids and comets: builds a KeplerOrbit from classical
// elements (or MPCORB records), lazily derives the full osculating element set, and propagates the
// state vector with a universal-variable (Stumpff-function) Kepler solver valid for elliptic,
// parabolic, and hyperbolic orbits. Distances are AU, velocities AU/day, angles radians; the default
// frame rotates the heliocentric ecliptic J2000 elements into equatorial J2000.

// Default rotation applied to propagated state: ecliptic-J2000 to equatorial-J2000.
const REFERENCE_FRAME = matTranspose(ECLIPTIC_J2000_MATRIX)
// Geometric tolerance for treating vectors/eccentricity as zero (degenerate orbits).
const ORBIT_EPSILON = 1e-15
// Squared geometric tolerance, compared against squared magnitudes.
const ORBIT_EPSILON_SQUARED = ORBIT_EPSILON * ORBIT_EPSILON
// Convergence tolerance for the Newton iteration solving Kepler's equation, in radians.
const KEPLER_EPSILON = 1e-14
// Safety cap on Kepler-equation iterations; valid inputs converge far sooner.
const KEPLER_MAX_ITERATIONS = 100

// Glossary

// a = semi-major axis (au)
// b = semi-minor axis (au)
// e = eccentricity
// E = eccentric anomaly
// h = specific angular momentum
// i = inclination (rad)
// l = true longitude (rad)
// L = mean longitude (rad)
// M = mean anomaly (rad)
// n = mean motion (rad)
// om = longitude of ascending node (rad)
// p = semi-latus rectum (au)
// P = period (d)
// q = periapsis distance (au)
// Q = apoapsis distance (au)
// t = time
// u = argument of latitude (rad)
// v = true anomaly (rad)
// w = argument of periapsis (rad)
// lp = longitude of periapsis (rad)

// The four Stumpff functions c0..c3 evaluated at a single argument.
export type StumpffOutput = [number, number, number, number]

// Precomputed quantities for the universal-variable Kepler propagation of one orbit.
interface PropagationParameters {
	readonly f: number // 1 - eccentricity; sign selects the elliptic/parabolic vs hyperbolic branch
	readonly hv: Vec3 // cross product between position & velocity
	readonly hvl: number // length of hv
	readonly r0: number // length of position vector
	readonly v0: number // length of velocity vector
	readonly rv: number // dot product between position & velocity
	readonly br0: number // b * r0, where b = sqrt(periapsis distance / mu)
	readonly b2rv: number // b^2 * rv
	readonly bq: number // b * periapsis distance
	readonly qovr0: number // periapsis distance / r0
	readonly maxc: number // largest magnitude among br0, b2rv, bq, qovr0; bounds the universal anomaly
}

// Full set of osculating Keplerian elements derived from a state vector. Distances are AU,
// angles radians, mean motion radians/day, period days.
export interface OsculatingElements {
	// Apoapsis distance; Infinity for parabolic/hyperbolic orbits.
	readonly apoapsisDistance: Distance
	// Argument of latitude (argument of periapsis + true anomaly).
	readonly argumentOfLatitude: Angle
	// Argument of periapsis.
	readonly argumentOfPeriapsis: Angle
	// Eccentric anomaly.
	readonly eccentricAnomaly: Angle
	// Eccentricity vector (points to periapsis, magnitude = eccentricity).
	readonly eccentricityVector: Vec3
	// Orbital eccentricity.
	readonly eccentricity: number
	// Inclination.
	readonly inclination: Angle
	// Longitude of the ascending node.
	readonly longitudeOfAscendingNode: Angle
	// Longitude of periapsis (node longitude + argument of periapsis).
	readonly longitudeOfPeriapsis: Angle
	// Mean anomaly at epoch.
	readonly meanAnomaly: Angle
	// Mean longitude (node + argument of periapsis + mean anomaly).
	readonly meanLongitude: Angle
	// Mean motion, radians per day.
	readonly meanMotionPerDay: Angle
	// Node vector (unit vector toward the ascending node, or zero if undefined).
	readonly nodeVector: Vec3
	// Periapsis distance.
	readonly periapsisDistance: Distance
	// Time of periapsis passage.
	readonly periapsisTime: Time
	// Orbital period in days; Infinity for open orbits.
	readonly periodInDays: number
	// Semi-latus rectum.
	readonly semiLatusRectum: Distance
	// Semi-major axis; Infinity for parabolic orbits.
	readonly semiMajorAxis: Distance
	// Semi-minor axis (0 for parabolic orbits).
	readonly semiMinorAxis: Distance
	// True anomaly.
	readonly trueAnomaly: Angle
	// True longitude (node + argument of periapsis + true anomaly).
	readonly trueLongitude: Angle
}

// Creates a `KeplerOrbit` for asteroid given is semi-major axis, eccentricity, inclination, longitude of ascending node, argument of perihelion, mean anomaly and epoch parameters.
export function asteroid(a: Distance, e: number, i: Angle, om: Angle, w: Angle, M: Angle, epoch: Time) {
	return KeplerOrbit.meanAnomaly(a * (1 - e * e), e, i, om, w, M, epoch)
}

// Creates a `KeplerOrbit` for asteroid using MPCORB parameters.
export function mpcAsteroid(mpc: MPCOrbit) {
	const { semiMajorAxis, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, meanAnomaly, epochPacked } = mpc
	const epoch = timeYMD(...unpackDate(epochPacked), 0, Timescale.TT)
	return asteroid(semiMajorAxis, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, meanAnomaly, epoch)
}

// Creates a `KeplerOrbit` for comet given its semi-latus rectum, eccentricity, inclination, longitude of ascending node, argument of perihelion and epoch parameters.
export function comet(p: Distance, e: number, i: Angle, om: Angle, w: Angle, epoch: Time) {
	return KeplerOrbit.periapsis(p, e, i, om, w, epoch)
}

// Creates a `KeplerOrbit` for comet using MPCORB parameters.
export function mpcComet(mpc: MPCOrbitComet) {
	const { eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion } = mpc
	const p = mpc.perihelionDistance * (1 + eccentricity)
	const epoch = timeYMD(mpc.perihelionYear, mpc.perihelionMonth, mpc.perihelionDay, mpc.perihelionDayFraction, Timescale.TT)
	return comet(p, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, epoch)
}

export class KeplerOrbit implements OsculatingElements {
	readonly #oe: Partial<Writable<OsculatingElements>> = {}
	readonly #propagation: PropagationParameters

	constructor(
		readonly position: CartesianCoordinate,
		readonly velocity: CartesianCoordinate,
		readonly epoch: Time,
		readonly mu: number = GM_SUN_PITJEVA_2005,
		readonly rotation: Mat3 = REFERENCE_FRAME,
	) {
		this.#propagation = propagationParameters(position, velocity, mu)
	}

	get apoapsisDistance() {
		if (this.#oe.apoapsisDistance !== undefined) return this.#oe.apoapsisDistance
		this.#oe.apoapsisDistance = apoapsisDistance(this.semiLatusRectum, this.eccentricity)
		return this.#oe.apoapsisDistance
	}

	get argumentOfLatitude() {
		if (this.#oe.argumentOfLatitude !== undefined) return this.#oe.argumentOfLatitude
		this.#oe.argumentOfLatitude = argumentOfLatitude(this.argumentOfPeriapsis, this.trueAnomaly)
		return this.#oe.argumentOfLatitude
	}

	get argumentOfPeriapsis() {
		if (this.#oe.argumentOfPeriapsis !== undefined) return this.#oe.argumentOfPeriapsis
		this.#oe.argumentOfPeriapsis = argumentOfPeriapsis(this.eccentricityVector, this.nodeVector, this.#propagation.hv)
		return this.#oe.argumentOfPeriapsis
	}

	get eccentricAnomaly() {
		if (this.#oe.eccentricAnomaly !== undefined) return this.#oe.eccentricAnomaly
		this.#oe.eccentricAnomaly = eccentricAnomaly(this.trueAnomaly, this.eccentricity)
		return this.#oe.eccentricAnomaly
	}

	get eccentricityVector() {
		if (this.#oe.eccentricityVector !== undefined) return this.#oe.eccentricityVector
		const rv0 = vecMulScalar(this.position, this.#propagation.v0 ** 2 - this.mu / this.#propagation.r0)
		const vrv = vecMulScalar(this.velocity, this.#propagation.rv)
		this.#oe.eccentricityVector = vecDivScalar(vecMinus(rv0, vrv, rv0), this.mu, rv0)
		return this.#oe.eccentricityVector
	}

	get eccentricity() {
		if (this.#oe.eccentricity !== undefined) return this.#oe.eccentricity
		this.#oe.eccentricity = vecLength(this.eccentricityVector)
		return this.#oe.eccentricity
	}

	get inclination() {
		if (this.#oe.inclination !== undefined) return this.#oe.inclination
		const hv = this.#propagation.hv
		this.#oe.inclination = Math.atan2(Math.hypot(hv[0], hv[1]), hv[2])
		return this.#oe.inclination
	}

	get longitudeOfAscendingNode() {
		if (this.#oe.longitudeOfAscendingNode !== undefined) return this.#oe.longitudeOfAscendingNode
		this.#oe.longitudeOfAscendingNode = longitudeOfAscendingNode(this.#propagation.hv, this.inclination)
		return this.#oe.longitudeOfAscendingNode
	}

	get longitudeOfPeriapsis() {
		if (this.#oe.longitudeOfPeriapsis !== undefined) return this.#oe.longitudeOfPeriapsis
		this.#oe.longitudeOfPeriapsis = longitudeOfPeriapsis(this.longitudeOfAscendingNode, this.argumentOfPeriapsis)
		return this.#oe.longitudeOfPeriapsis
	}

	get meanAnomaly() {
		if (this.#oe.meanAnomaly !== undefined) return this.#oe.meanAnomaly
		this.#oe.meanAnomaly = meanAnomaly(this.eccentricAnomaly, this.eccentricity, this.eccentricity < 1)
		return this.#oe.meanAnomaly
	}

	get meanLongitude() {
		if (this.#oe.meanLongitude !== undefined) return this.#oe.meanLongitude
		this.#oe.meanLongitude = meanLongitude(this.longitudeOfAscendingNode, this.argumentOfPeriapsis, this.meanAnomaly)
		return this.#oe.meanLongitude
	}

	get meanMotionPerDay() {
		if (this.#oe.meanMotionPerDay !== undefined) return this.#oe.meanMotionPerDay
		this.#oe.meanMotionPerDay = meanMotion(this.semiMajorAxis, this.mu)
		return this.#oe.meanMotionPerDay
	}

	get nodeVector() {
		if (this.#oe.nodeVector !== undefined) return this.#oe.nodeVector
		this.#oe.nodeVector = nodeVector(this.#propagation.hv)
		return this.#oe.nodeVector
	}

	get periapsisDistance() {
		if (this.#oe.periapsisDistance !== undefined) return this.#oe.periapsisDistance
		this.#oe.periapsisDistance = periapsisDistance(this.semiLatusRectum, this.eccentricity)
		return this.#oe.periapsisDistance
	}

	get periapsisTime() {
		if (this.#oe.periapsisTime !== undefined) return this.#oe.periapsisTime
		const M = meanAnomaly(this.eccentricAnomaly, this.eccentricity, false)
		const tp = timeSincePeriapsis(M, this.meanMotionPerDay, this.trueAnomaly, this.semiLatusRectum, this.mu)
		const t = tdb(this.epoch)
		this.#oe.periapsisTime = time(t.day - tp, t.fraction, Timescale.TDB)
		return this.#oe.periapsisTime
	}

	get periodInDays() {
		if (this.#oe.periodInDays !== undefined) return this.#oe.periodInDays
		this.#oe.periodInDays = period(this.semiMajorAxis, this.mu)
		return this.#oe.periodInDays
	}

	get semiLatusRectum() {
		if (this.#oe.semiLatusRectum !== undefined) return this.#oe.semiLatusRectum
		this.#oe.semiLatusRectum = this.#propagation.hvl ** 2 / this.mu
		return this.#oe.semiLatusRectum
	}

	get semiMajorAxis() {
		if (this.#oe.semiMajorAxis !== undefined) return this.#oe.semiMajorAxis
		this.#oe.semiMajorAxis = semiMajorAxis(this.semiLatusRectum, this.eccentricity)
		return this.#oe.semiMajorAxis
	}

	get semiMinorAxis() {
		if (this.#oe.semiMinorAxis !== undefined) return this.#oe.semiMinorAxis
		this.#oe.semiMinorAxis = semiMinorAxis(this.semiLatusRectum, this.eccentricity)
		return this.#oe.semiMinorAxis
	}

	get trueAnomaly() {
		if (this.#oe.trueAnomaly !== undefined) return this.#oe.trueAnomaly
		this.#oe.trueAnomaly = trueAnomaly(this.eccentricityVector, this.position, this.velocity, this.nodeVector)
		return this.#oe.trueAnomaly
	}

	get trueLongitude() {
		if (this.#oe.trueLongitude !== undefined) return this.#oe.trueLongitude
		this.#oe.trueLongitude = meanLongitude(this.longitudeOfAscendingNode, this.argumentOfPeriapsis, this.trueAnomaly)
		return this.#oe.trueLongitude
	}

	// Propagates the orbit to `time`, returning position (AU) and velocity (AU/day) in the
	// configured output frame. Returned vectors are freshly allocated.
	at(time: Time) {
		const pv = propagate(this.position, this.velocity, this.epoch, time, this.#propagation)

		if (this.rotation) {
			matMulVec(this.rotation, pv[0], pv[0])
			matMulVec(this.rotation, pv[1], pv[1])
		}

		return pv
	}

	// Creates a `KeplerOrbit` from orbital elements using mean anomaly.
	static meanAnomaly(p: Distance, e: number, i: Angle, om: Angle, w: Angle, M: Angle, epoch: Time, mu: number = GM_SUN_PITJEVA_2005, rotation: Mat3 = REFERENCE_FRAME) {
		let v: number

		if (e < 1) v = trueAnomalyClosed(e, solveEccentricAnomaly(e, M))
		else if (e > 1) v = trueAnomalyHyperbolic(e, solveEccentricAnomaly(e, M))
		else v = trueAnomalyParabolic(p, mu, M)

		return KeplerOrbit.trueAnomaly(p, e, i, om, w, v, epoch, mu, rotation)
	}

	// Creates a `KeplerOrbit` from orbital elements using true anomaly.
	static trueAnomaly(p: Distance, e: number, i: Angle, om: Angle, w: Angle, M: Angle, epoch: Time, mu: number = GM_SUN_PITJEVA_2005, rotation: Mat3 = REFERENCE_FRAME) {
		const [position, velocity] = computePositionAndVelocityFromOrbitalElements(p, e, i, om, w, M, mu)
		return new KeplerOrbit(position, velocity, epoch, mu, rotation)
	}

	// Creates a `KeplerOrbit` given its parameters and date of periapsis.
	static periapsis(p: Distance, e: number, i: Angle, om: Angle, w: Angle, epoch: Time, mu: number = GM_SUN_PITJEVA_2005, rotation: Mat3 = REFERENCE_FRAME) {
		const [position, velocity] = computePositionAndVelocityFromOrbitalElements(p, e, i, om, w, 0, mu)
		return new KeplerOrbit(position, velocity, epoch, mu, rotation)
	}
}

// Iterates to solve Kepler's equation to find eccentric anomaly.
// Based on the algorithm in section 8.10.2 of the Explanatory Supplement
// to the Astronomical Almanac, 3rd ed.
function solveEccentricAnomaly(e: number, M: Angle): Angle {
	if (e < 1) {
		const m = normalizePI(M)
		let E = m + e * Math.sin(m)

		for (let i = 0; i < KEPLER_MAX_ITERATIONS; i++) {
			const s = Math.sin(E)
			const c = Math.cos(E)
			const dE = (m - (E - e * s)) / (1 - e * c)
			E += dE

			if (Math.abs(dE) < KEPLER_EPSILON) break
		}

		return E
	}

	let E = Math.asinh(M / e)

	for (let i = 0; i < KEPLER_MAX_ITERATIONS; i++) {
		const s = Math.sinh(E)
		const c = Math.cosh(E)
		const dE = (M - (e * s - E)) / (e * c - 1)
		E += dE

		if (Math.abs(dE) < KEPLER_EPSILON) break
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
	const root = Math.hypot(a, 1)
	const b = a >= 0 ? Math.cbrt(a + root) : 1 / Math.cbrt(root - a)
	return 2 * Math.atan(b - 1 / b)
}

// Computes the state vectors from orbital elements.
// Based on equations from this document:
// https://web.archive.org/web/*/http://ccar.colorado.edu/asen5070/handouts/kep2cart_2002.doc
function computePositionAndVelocityFromOrbitalElements(p: Distance, e: number, i: Angle, om: Angle, w: Angle, v: Angle, mu: number): PositionAndVelocity {
	// Checks that true anomaly is less than arccos(-1/e) for hyperbolic orbits.
	if (e > 1 && Math.abs(normalizePI(v)) > Math.acos(-1 / e) + ORBIT_EPSILON) {
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

	const position: MutVec3 = [x, y, z]
	const velocity: MutVec3 = [xDot, yDot, zDot]

	return [position, velocity]
}

// ln(1.5), used when bounding the universal anomaly for elliptic/parabolic orbits.
const LN_1_5 = 0.4054651081081644
// ln of half the largest finite double; caps the hyperbolic-branch argument against overflow.
const LN_HALF_DOUBLE_MAX = 709.0895657128241
// ln of the largest finite double; caps the elliptic-branch argument against overflow.
const LN_DOUBLE_MAX = 709.782712893384

// Precomputes the universal-variable propagation parameters from a state vector and mu.
// Throws when the angular momentum is zero (rectilinear, non-conical motion).
function propagationParameters(position: CartesianCoordinate, velocity: CartesianCoordinate, mu: number = GM_SUN_PITJEVA_2005): PropagationParameters {
	const hv = vecCross(position, velocity)
	const h2 = vecDot(hv, hv)

	if (h2 === 0) {
		throw new Error('motion is not conical')
	}

	const r0 = vecLength(position)
	const rv = vecDot(position, velocity)
	const hvl = Math.sqrt(h2)
	const v0 = vecLength(velocity)

	const hvec = vecCross(velocity, hv)
	vecDivScalar(hvec, mu, hvec)
	vecMinus(hvec, vecDivScalar(position, r0), hvec)
	const e = vecLength(hvec)
	const q = h2 / (mu * (1 + e))

	const f = 1 - e
	const b = Math.sqrt(q / mu)

	const br0 = b * r0
	const b2rv = b * b * rv
	const bq = b * q
	const qovr0 = q / r0

	const maxc = Math.max(Math.abs(br0), Math.max(Math.abs(b2rv), Math.max(Math.abs(bq), Math.abs(qovr0))))

	return { hv, hvl, r0, v0, rv, f, br0, b2rv, bq, qovr0, maxc }
}

// Evaluates the universal Kepler propagation function.
function propagationKepler(x: number, f: number, br0: number, b2rv: number, bq: number, s: StumpffOutput) {
	const c = stumpff(f * x * x, s)
	return x * (br0 * c[1] + x * (b2rv * c[2] + x * bq * c[3]))
}

/**
 * Propagates a `position` and `velocity` vector over time.
 *
 * @param position Position vector in distance units consistent with `mu`.
 * @param velocity Velocity vector in distance/day units consistent with `mu`.
 * @param t0 `Time` corresponding to `position` and `velocity`.
 * @param t1 `Time` to propagate to.
 * @param mu Gravitational parameter in units that match the other arguments.
 */
function propagate(position: CartesianCoordinate, velocity: CartesianCoordinate, t0: Time, t1: Time, mu: number | PropagationParameters): PositionAndVelocity {
	const { f, maxc, br0, b2rv, bq, qovr0 } = typeof mu === 'number' ? propagationParameters(position, velocity, mu) : mu

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

	const dt = timeSubtract(t1, t0, Timescale.TT) // T1 - T0
	let x = Math.max(-bound, Math.min(dt / bq, bound))

	let kfun = propagationKepler(x, f, br0, b2rv, bq, s)

	let lower = dt < 0 ? x : 0
	let upper = dt > 0 ? x : 0

	if (dt < 0) {
		while (kfun > dt) {
			upper = lower

			lower *= 2

			const px = x
			x = Math.max(-bound, Math.min(lower, bound))
			if (x === px) throw new Error(`The delta time ${dt} is beyond the range`)

			kfun = propagationKepler(x, f, br0, b2rv, bq, s)
		}
	} else if (dt > 0) {
		while (kfun < dt) {
			lower = upper

			upper *= 2

			const px = x
			x = Math.max(-bound, Math.min(upper, bound))
			if (x === px) throw new Error(`The delta time ${dt} is beyond the range`)

			kfun = propagationKepler(x, f, br0, b2rv, bq, s)
		}
	}

	x = lower <= upper ? (upper + lower) / 2 : upper

	let count = 64

	while (count-- > 0 && lower < x && x < upper) {
		kfun = propagationKepler(x, f, br0, b2rv, bq, s)

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

	const p: MutVec3 = [0, 0, 0]
	const v: MutVec3 = [0, 0, 0]

	vecPlus(vecMulScalar(position, pc, s as never), vecMulScalar(velocity, vc, p), p)
	vecPlus(vecMulScalar(position, pcdot, s as never), vecMulScalar(velocity, vcdot, v), v)

	return [p, v]
}

// Reciprocal factorial-pair coefficients (2k)(2k-1) for the c2 Stumpff series expansion.
const C2_DIV = [1 * 2, 3 * 4, 5 * 6, 7 * 8, 9 * 10, 11 * 12, 13 * 14, 15 * 16, 17 * 18].map((e) => 1 / e)
// Reciprocal factorial-pair coefficients (2k+1)(2k) for the c3 Stumpff series expansion.
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

// Apoapsis distance (AU) from semi-latus rectum `p` and eccentricity `e`; Infinity for e >= 1.
export function apoapsisDistance(p: Distance, e: number): Distance {
	return e >= 1 ? Infinity : p / (1 - e)
}

// Argument of latitude (radians, 0..TAU) from argument of periapsis `w` and true anomaly `v`.
export function argumentOfLatitude(w: Angle, v: Angle) {
	return normalizeAngle(w + v)
}

// Argument of periapsis (radians) from the eccentricity vector `ev`, node vector `nv`, and angular
// momentum `hv`. Returns 0 for circular orbits; handles the equatorial (undefined node) case.
export function argumentOfPeriapsis(ev: Vec3, nv: Vec3, hv: Vec3): Angle {
	// Circular
	if (vecLength(ev) < ORBIT_EPSILON) return 0

	// Equatorial and not circular
	if (vecLength(nv) < ORBIT_EPSILON) {
		const a = normalizeAngle(Math.atan2(ev[1], ev[0]))
		return hv[2] >= 0 ? a : normalizeAngle(-a)
	}

	// Not circular and not equatorial
	const a = vecAngle(nv, ev)
	return ev[2] > 0 ? a : normalizeAngle(-a)
}

// Eccentric anomaly (radians) from true anomaly `v` and eccentricity `e`. Elliptic and hyperbolic
// (returns the hyperbolic anomaly) branches; returns 0 for the parabolic case (e == 1).
export function eccentricAnomaly(v: number, e: number) {
	if (e < 1) return 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(v / 2))
	else if (e > 1) return 2 * Math.atanh(Math.tan(v / 2) / Math.sqrt((e + 1) / (e - 1)))
	else return 0
}

// Solves Kepler's equation for the eccentric anomaly (radians) from mean anomaly `M` (radians) and
// eccentricity `e`, the inverse of meanAnomaly. Newton-Raphson on the elliptic branch (e < 1) solves
// E - e*sin(E) = M with M wrapped to -PI..PI, and on the hyperbolic branch (e > 1) solves
// e*sinh(H) - H = M, returning the hyperbolic anomaly H. Returns 0 for the parabolic case (e == 1),
// matching eccentricAnomaly. Converges to double precision; the iteration is capped for safety.
export function eccentricAnomalyFromMean(M: Angle, e: number): Angle {
	if (e === 1) return 0

	if (e < 1) {
		// Solve on the wrapped anomaly for robust convergence, then restore the revolution of M.
		const m = normalizePI(M)
		// Near-parabolic ellipses converge faster starting from the apsis side of the wrapped anomaly.
		let E = e < 0.8 ? m : m < 0 ? -Math.PI : Math.PI
		for (let i = 0; i < 30; i++) {
			const delta = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E))
			E -= delta
			if (Math.abs(delta) < 1e-14) break
		}
		// M - m is a whole multiple of TAU, so adding it keeps E - e*sin(E) = M with E near M.
		return E + (M - m)
	}

	let H = Math.asinh(M / e)
	for (let i = 0; i < 50; i++) {
		const delta = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1)
		H -= delta
		if (Math.abs(delta) < 1e-14) break
	}
	return H
}

// Eccentricity vector from `position` (AU) and `velocity` (AU/day) and `mu`. Points toward periapsis
// with magnitude equal to the eccentricity. Writes into `o` when given, which is returned.
export function eccentricityVector(position: CartesianCoordinate, velocity: CartesianCoordinate, mu: number, o?: MutVec3): Vec3 {
	const r = vecLength(position)
	const v = vecLength(velocity)
	const a = vecMulScalar(position, v ** 2 - mu / r, o)
	const b = vecMulScalar(velocity, vecDot(position, velocity))
	return vecDivScalar(vecMinus(a, b, a), mu, a)
}

export function inclination(hv: Vec3) {
	// atan2(|h_xy|, h_z) is the angle between the orbital momentum and the +Z axis and stays accurate
	// near i = 0 and i = PI, unlike acos(h_z/|h|) whose slope diverges there.
	return Math.atan2(Math.hypot(hv[0], hv[1]), hv[2])
}

// Longitude of the ascending node (radians, 0..TAU) from angular momentum `hv` and inclination `i`.
// Returns 0 for equatorial orbits where the node is undefined.
export function longitudeOfAscendingNode(hv: Vec3, i: Angle): Angle {
	const hxy2 = hv[0] * hv[0] + hv[1] * hv[1]
	return hxy2 > vecDot(hv, hv) * ORBIT_EPSILON_SQUARED && i !== 0 ? normalizeAngle(Math.atan2(hv[0], -hv[1])) : 0
}

// Longitude of periapsis (radians, 0..TAU) from node longitude `om` and argument of periapsis `w`.
export function longitudeOfPeriapsis(om: Angle, w: Angle) {
	return normalizeAngle(om + w)
}

// Mean anomaly (radians) from eccentric anomaly `E` and eccentricity `e`. Elliptic result is
// normalized to 0..TAU; the hyperbolic result is wrapped to -PI..PI only when `norm` is true.
export function meanAnomaly(E: Angle, e: number, norm: boolean = e < 1) {
	if (e < 1) return normalizeAngle(E - e * Math.sin(E))
	else if (e > 1) {
		const M = e * Math.sinh(E) - E
		return norm ? normalizePI(M) : M
	} else return 0
}

// Mean longitude (radians, 0..TAU) from node longitude `om`, argument of periapsis `w`, and mean
// (or true) anomaly `M`. Reused for true longitude by passing the true anomaly.
export function meanLongitude(om: Angle, w: Angle, M: Angle) {
	return normalizeAngle(om + w + M)
}

// Mean motion (radians/day) from semi-major axis `a` (AU) and `mu`. Uses |a| so it is finite for
// hyperbolic orbits.
export function meanMotion(a: Distance, mu: number): Angle {
	return Math.sqrt(mu / Math.abs(a) ** 3)
}

// Unit node vector toward the ascending node from angular momentum `hv`; zero vector when the orbit
// is equatorial and the node is undefined.
export function nodeVector(hv: Vec3) {
	const nv = [-hv[1], hv[0], 0] as const
	const hxy2 = nv[0] * nv[0] + nv[1] * nv[1]
	return hxy2 > vecDot(hv, hv) * ORBIT_EPSILON_SQUARED ? vecNormalize(nv, nv as never) : ([0, 0, 0] as const)
}

// Periapsis distance (AU) from semi-latus rectum `p` and eccentricity `e`.
export function periapsisDistance(p: Distance, e: number): Distance {
	return p / (1 + e)
}

// Orbital period (days) from semi-major axis `a` (AU) and `mu`; Infinity for open orbits (a <= 0).
export function period(a: Distance, mu: number) {
	return a > 0 ? TAU * Math.sqrt(a ** 3 / mu) : Infinity
}

// Tisserand parameter of a small body relative to a perturbing planet, dimensionless.
// T = a_p/a + 2*cos(i)*sqrt((a/a_p)*(1 - e^2)), from the small body's osculating
// semi-major axis `a` (AU), eccentricity `e` and inclination `i` (radians, referred
// to the perturber's orbital plane, usually the ecliptic), and the perturber's
// semi-major axis `perturberSemiMajorAxis` (AU; Jupiter ~5.204 AU). It is nearly
// conserved across close encounters with that planet, so it classifies orbits:
// T > 3 is typically asteroidal, 2 < T < 3 a Jupiter-family comet, and T < 2 a
// nearly isotropic / Halley-type orbit. Assumes a bound small-body orbit (a > 0)
// and a positive perturber semi-major axis.
export function tisserandParameter(a: Distance, e: number, i: Angle, perturberSemiMajorAxis: Distance): number {
	return perturberSemiMajorAxis / a + 2 * Math.cos(i) * Math.sqrt((a / perturberSemiMajorAxis) * (1 - e * e))
}

// Semi-latus rectum (AU) from `position` (AU), `velocity` (AU/day), and `mu`.
export function semiLatusRectum(position: CartesianCoordinate, velocity: CartesianCoordinate, mu: number) {
	return vecCrossLength(position, velocity) ** 2 / mu
}

// Semi-major axis (AU) from semi-latus rectum `p` and eccentricity `e`; Infinity for parabolic (e == 1).
export function semiMajorAxis(p: Distance, e: number) {
	return e !== 1 ? p / (1 - e ** 2) : Infinity
}

// Semi-minor axis (AU) from semi-latus rectum `p` and eccentricity `e`; 0 for parabolic orbits.
export function semiMinorAxis(p: Distance, e: number) {
	return e < 1 ? p / Math.sqrt((1 - e) * (1 + e)) : e > 1 ? p / Math.sqrt((e - 1) * (e + 1)) : 0
}

// Time since periapsis (days) from mean anomaly `M`, mean motion `n`, true anomaly `v`, semi-latus
// rectum `p`, and `mu`. Falls back to Barker's parabolic equation when the mean motion is ~0.
export function timeSincePeriapsis(M: Angle, n: Angle, v: Angle, p: Distance, mu: number) {
	if (n >= 8.64e-15) {
		return M / n
	} else {
		const D = Math.tan(v / 2)
		return Math.sqrt((2 * (p / 2) ** 3) / mu) * (D + D ** 3 / 3)
	}
}

// True anomaly (radians) from eccentricity vector `ev`, `position`, `velocity`, and node vector `nv`.
// Handles circular and equatorial degeneracies; near-parabolic results are wrapped to -PI..PI.
export function trueAnomaly(ev: Vec3, position: CartesianCoordinate, velocity: CartesianCoordinate, nv: Vec3) {
	const evl = vecLength(ev)
	let v = 0

	// Not circular
	if (evl > ORBIT_EPSILON) {
		const a = vecAngle(ev, position)
		v = vecDot(position, velocity) > 0 ? a : normalizeAngle(-a)
	}
	// Circular and equatorial
	else if (vecLength(nv) < ORBIT_EPSILON) {
		const a = normalizeAngle(Math.atan2(position[1], position[0]))
		const hz = position[0] * velocity[1] - position[1] * velocity[0]
		v = hz >= 0 ? a : normalizeAngle(-a)
	}
	// Circular and not equatorial
	else {
		const a = vecAngle(nv, position)
		v = position[2] >= 0 ? a : normalizeAngle(-a)
	}

	// If the orbit is not nearly parabolic, return v; otherwise, normalize to [-π, π] for parabolic/hyperbolic cases.
	return evl < 1 - 1e-15 ? v : normalizePI(v)
}
