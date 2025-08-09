import type { Mutable } from 'utility-types'
import { type Angle, normalizeAngle, normalizePI } from './angle'
import type { PositionAndVelocity } from './astrometry'
import { ECLIPTIC_J2000_MATRIX, GM_SUN_PITJEVA_2005, TAU } from './constants'
import type { CartesianCoordinate } from './coordinate'
import type { Distance } from './distance'
import { type Mat3, matMulVec, matTranspose } from './mat3'
import { type MPCOrbit, type MPCOrbitComet, unpackDate } from './mpcorb'
import { type Time, Timescale, tdb, time, timeSubtract, timeYMD, tt } from './time'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDivScalar, vecDot, vecLength, vecMinus, vecMulScalar, vecPlus } from './vec3'

const REFERENCE_FRAME = matTranspose(ECLIPTIC_J2000_MATRIX)

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

export type StumpffOutput = [number, number, number, number]

interface PropagationParameters {
	readonly f: number
	readonly hv: Vec3 // cross product between position & velocity
	readonly hvl: number // length of hv
	readonly r0: number // length of position vector
	readonly v0: number // length of velocity vector
	readonly rv: number // dot product between position & velocity
	readonly br0: number
	readonly b2rv: number
	readonly bq: number
	readonly qovr0: number
	readonly maxc: number
}

export interface OsculatingElements {
	readonly apoapsisDistance: Distance
	readonly argumentOfLatitude: Angle
	readonly argumentOfPeriapsis: Angle
	readonly eccentricAnomaly: Angle
	readonly eccentricityVector: Vec3
	readonly eccentricity: number
	readonly inclination: Angle
	readonly longitudeOfAscendingNode: Angle
	readonly longitudeOfPeriapsis: Angle
	readonly meanAnomaly: Angle
	readonly meanLongitude: Angle
	readonly meanMotionPerDay: Angle
	readonly nodeVector: Vec3
	readonly periapsisDistance: Distance
	readonly periapsisTime: Time
	readonly periodInDays: number
	readonly semiLatusRectum: Distance
	readonly semiMajorAxis: Distance
	readonly semiMinorAxis: Distance
	readonly trueAnomaly: Angle
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
	private readonly oe: Partial<Mutable<OsculatingElements>> = {}
	private readonly propagation: PropagationParameters

	constructor(
		readonly position: CartesianCoordinate,
		readonly velocity: CartesianCoordinate,
		readonly epoch: Time,
		readonly mu: number = GM_SUN_PITJEVA_2005,
		readonly rotation: Mat3 = REFERENCE_FRAME,
	) {
		this.propagation = propagationParameters(position, velocity, mu)
	}

	get apoapsisDistance() {
		if (this.oe.apoapsisDistance) return this.oe.apoapsisDistance
		this.oe.apoapsisDistance = apoapsisDistance(this.semiLatusRectum, this.eccentricity)
		return this.oe.apoapsisDistance
	}

	get argumentOfLatitude() {
		if (this.oe.argumentOfLatitude) return this.oe.argumentOfLatitude
		this.oe.argumentOfLatitude = argumentOfLatitude(this.argumentOfPeriapsis, this.trueAnomaly)
		return this.oe.argumentOfLatitude
	}

	get argumentOfPeriapsis() {
		if (this.oe.argumentOfPeriapsis) return this.oe.argumentOfPeriapsis
		this.oe.argumentOfPeriapsis = argumentOfPeriapsis(this.eccentricityVector, this.nodeVector, this.propagation.hv)
		return this.oe.argumentOfPeriapsis
	}

	get eccentricAnomaly() {
		if (this.oe.eccentricAnomaly) return this.oe.eccentricAnomaly
		this.oe.eccentricAnomaly = eccentricAnomaly(this.trueAnomaly, this.eccentricity)
		return this.oe.eccentricAnomaly
	}

	get eccentricityVector() {
		if (this.oe.eccentricityVector) return this.oe.eccentricityVector
		const rv0 = vecMulScalar(this.position, this.propagation.v0 ** 2 - this.mu / this.propagation.r0)
		const vrv = vecMulScalar(this.velocity, this.propagation.rv)
		this.oe.eccentricityVector = vecDivScalar(vecMinus(rv0, vrv, rv0), this.mu, rv0)
		return this.oe.eccentricityVector
	}

	get eccentricity() {
		if (this.oe.eccentricity) return this.oe.eccentricity
		this.oe.eccentricity = vecLength(this.eccentricityVector)
		return this.oe.eccentricity
	}

	get inclination() {
		if (this.oe.inclination) return this.oe.inclination
		this.oe.inclination = Math.acos(this.propagation.hv[2] / this.propagation.hvl)
		return this.oe.inclination
	}

	get longitudeOfAscendingNode() {
		if (this.oe.longitudeOfAscendingNode) return this.oe.longitudeOfAscendingNode
		this.oe.longitudeOfAscendingNode = longitudeOfAscendingNode(this.propagation.hv, this.inclination)
		return this.oe.longitudeOfAscendingNode
	}

	get longitudeOfPeriapsis() {
		if (this.oe.longitudeOfPeriapsis) return this.oe.longitudeOfPeriapsis
		this.oe.longitudeOfPeriapsis = longitudeOfPeriapsis(this.longitudeOfAscendingNode, this.argumentOfPeriapsis)
		return this.oe.longitudeOfPeriapsis
	}

	get meanAnomaly() {
		if (this.oe.meanAnomaly) return this.oe.meanAnomaly
		this.oe.meanAnomaly = meanAnomaly(this.eccentricAnomaly, this.eccentricity)
		return this.oe.meanAnomaly
	}

	get meanLongitude() {
		if (this.oe.meanLongitude) return this.oe.meanLongitude
		this.oe.meanLongitude = meanLongitude(this.longitudeOfAscendingNode, this.argumentOfPeriapsis, this.meanAnomaly)
		return this.oe.meanLongitude
	}

	get meanMotionPerDay() {
		if (this.oe.meanMotionPerDay) return this.oe.meanMotionPerDay
		this.oe.meanMotionPerDay = meanMotion(this.semiMajorAxis, this.mu)
		return this.oe.meanMotionPerDay
	}

	get nodeVector() {
		if (this.oe.nodeVector) return this.oe.nodeVector
		this.oe.nodeVector = nodeVector(this.propagation.hv)
		return this.oe.nodeVector
	}

	get periapsisDistance() {
		if (this.oe.periapsisDistance) return this.oe.periapsisDistance
		this.oe.periapsisDistance = periapsisDistance(this.semiLatusRectum, this.eccentricity)
		return this.oe.periapsisDistance
	}

	get periapsisTime() {
		const M = meanAnomaly(this.eccentricAnomaly, this.eccentricity, false)
		const tp = timeSincePeriapsis(M, this.meanMotionPerDay, this.trueAnomaly, this.semiLatusRectum, this.mu)
		const t = tdb(this.epoch)
		return time(t.day - tp, t.fraction, Timescale.TDB)
	}

	get periodInDays() {
		if (this.oe.periodInDays) return this.oe.periodInDays
		this.oe.periodInDays = period(this.semiMajorAxis, this.mu)
		return this.oe.periodInDays
	}

	get semiLatusRectum() {
		if (this.oe.semiLatusRectum) return this.oe.semiLatusRectum
		this.oe.semiLatusRectum = this.propagation.hvl ** 2 / this.mu
		return this.oe.semiLatusRectum
	}

	get semiMajorAxis() {
		if (this.oe.semiMajorAxis) return this.oe.semiMajorAxis
		this.oe.semiMajorAxis = semiMajorAxis(this.semiLatusRectum, this.eccentricity)
		return this.oe.semiMajorAxis
	}

	get semiMinorAxis() {
		if (this.oe.semiMinorAxis) return this.oe.semiMinorAxis
		this.oe.semiMinorAxis = semiMinorAxis(this.semiLatusRectum, this.eccentricity)
		return this.oe.semiMinorAxis
	}

	get trueAnomaly() {
		if (this.oe.trueAnomaly) return this.oe.trueAnomaly
		this.oe.trueAnomaly = trueAnomaly(this.eccentricityVector, this.position, this.velocity, this.nodeVector)
		return this.oe.trueAnomaly
	}

	get trueLongitude() {
		if (this.oe.trueLongitude) return this.oe.trueLongitude
		this.oe.trueLongitude = meanLongitude(this.longitudeOfAscendingNode, this.argumentOfPeriapsis, this.trueAnomaly)
		return this.oe.trueLongitude
	}

	at(time: Time) {
		const pv = propagate(this.position, this.velocity, tt(this.epoch), tt(time), this.propagation)

		if (this.rotation) {
			matMulVec(this.rotation, pv[0], pv[0] as never)
			matMulVec(this.rotation, pv[1], pv[1] as never)
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
	const m = normalizePI(M)
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

	const position: MutVec3 = [x, y, z]
	const velocity: MutVec3 = [xDot, yDot, zDot]

	return [position, velocity]
}

const LN_1_5 = 0.4054651081081644
const LN_HALF_DOUBLE_MAX = 709.0895657128241
const LN_DOUBLE_MAX = 709.782712893384

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

/**
 * Propagates a `position` and `velocity` vector over time.
 *
 * @param position Position in km.
 * @param velocity Velocity in km/s.
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

	function kepler(x: number) {
		const c = stumpff(f * x * x, s)
		return x * (br0 * c[1] + x * (b2rv * c[2] + x * bq * c[3]))
	}

	const dt = timeSubtract(t1, t0) // T1 - T0
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

	const p: MutVec3 = [0, 0, 0]
	const v: MutVec3 = [0, 0, 0]

	vecPlus(vecMulScalar(position, pc, s as never), vecMulScalar(velocity, vc, p), p)
	vecPlus(vecMulScalar(position, pcdot, s as never), vecMulScalar(velocity, vcdot, v), v)

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

export function apoapsisDistance(p: Distance, e: number): Distance {
	return e >= 1 ? Infinity : (p * (1 + e)) / (1 - e * e)
}

export function argumentOfLatitude(w: Angle, v: Angle) {
	return normalizeAngle(w + v)
}

export function argumentOfPeriapsis(ev: Vec3, nv: Vec3, hv: Vec3): Angle {
	// Circular
	if (vecLength(ev) < 1e-15) return 0

	// Equatorial and not circular
	if (vecLength(nv) < 1e-15) {
		const a = normalizeAngle(Math.atan2(ev[1], ev[0]))
		return hv[2] >= 0 ? a : normalizeAngle(-a)
	}

	// Not circular and not equatorial
	const a = vecAngle(nv, ev)
	return ev[2] > 0 ? a : normalizeAngle(-a)
}

export function eccentricAnomaly(v: number, e: number) {
	if (e < 1) return 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(v / 2))
	else if (e > 1) return normalizePI(2 * Math.atanh(Math.tan(v / 2) / Math.sqrt((e + 1) / (e - 1))))
	else return 0
}

export function eccentricityVector(position: CartesianCoordinate, velocity: CartesianCoordinate, mu: number, o?: MutVec3): Vec3 {
	const r = vecLength(position)
	const v = vecLength(velocity)
	const a = vecMulScalar(position, v ** 2 - mu / r, o)
	const b = vecMulScalar(velocity, vecDot(position, velocity))
	return vecDivScalar(vecMinus(a, b, a), mu, a)
}

export function inclination(hv: Vec3) {
	// return vecAngle(hv, [0, 0, 1])
	return Math.acos(hv[2] / vecLength(hv))
}

export function longitudeOfAscendingNode(hv: Vec3, i: Angle): Angle {
	return i !== 0 ? normalizeAngle(Math.atan2(hv[0], -hv[1])) : 0
}

export function longitudeOfPeriapsis(om: Angle, w: Angle) {
	return normalizeAngle(om + w)
}

export function meanAnomaly(E: Angle, e: number, norm: boolean = true) {
	if (e < 1) return normalizeAngle(E - e * Math.sin(E))
	else if (e > 1) {
		const M = e * Math.sinh(E) - E
		return norm ? normalizePI(M) : M
	} else return 0
}

export function meanLongitude(om: Angle, w: Angle, M: Angle) {
	return normalizeAngle(om + w + M)
}

export function meanMotion(a: Distance, mu: number): Angle {
	return Math.sqrt(mu / Math.abs(a) ** 3)
}

export function nodeVector(hv: Vec3) {
	const nv = [-hv[1], hv[0], 0] as const
	const n = vecLength(nv)
	return n !== 0 ? vecDivScalar(nv, n, nv as never) : nv
}

export function periapsisDistance(p: Distance, e: number): Distance {
	return e === 1 ? p / 2 : (p * (1 - e)) / (1 - e ** 2)
}

export function period(a: Distance, mu: number) {
	return a > 0 ? TAU * Math.sqrt(a ** 3 / mu) : Infinity
}

export function semiLatusRectum(position: CartesianCoordinate, velocity: CartesianCoordinate, mu: number) {
	return vecLength(vecCross(position, velocity)) ** 2 / mu
}

export function semiMajorAxis(p: Distance, e: number) {
	return e !== 1 ? p / (1 - e ** 2) : Infinity
}

export function semiMinorAxis(p: Distance, e: number) {
	return e < 1 ? p / Math.sqrt(1 - e ** 2) : e > 1 ? (p * Math.sqrt(e ** 2 - 1)) / (1 - e ** 2) : 0
}

export function timeSincePeriapsis(M: Angle, n: Angle, v: Angle, p: Distance, mu: number) {
	if (n >= 8.64e-15) {
		return M / n
	} else {
		const D = Math.tan(v / 2)
		return Math.sqrt((2 * (p / 2) ** 3) / mu) * (D + D ** 3 / 3)
	}
}

export function trueAnomaly(ev: Vec3, position: CartesianCoordinate, velocity: CartesianCoordinate, nv: Vec3) {
	let v = 0
	const evl = vecLength(ev)

	// Not circular
	if (evl > 1e-15) {
		const a = vecAngle(ev, position)
		v = vecDot(position, velocity) > 0 ? a : normalizeAngle(-a)
	}
	// Circular and equatorial
	else if (vecLength(nv) < 1e-15) {
		const a = Math.acos(position[0] / vecLength(position))
		v = velocity[0] < 0 ? a : normalizeAngle(-a)
	}
	// Circular and not equatorial
	else {
		const a = vecAngle(nv, position)
		v = position[2] >= 0 ? a : normalizeAngle(-a)
	}

	return evl < 1 - 1e-15 ? v : normalizePI(v)
}
