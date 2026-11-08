// oxfmt-ignore
import { AU_KM, ECLIPTIC_J2000_MATRIX, GM_EARTH_DE440_KM3_S2, GM_JUPITER_SYSTEM_KM3_S2, GM_MARS_SYSTEM_KM3_S2, GM_MERCURY_KM3_S2, GM_MOON_KM3_S2, GM_NEPTUNE_SYSTEM_KM3_S2, GM_PLUTO_SYSTEM_KM3_S2, GM_SATURN_SYSTEM_KM3_S2, GM_SUN_DE440_KM3_S2, GM_URANUS_SYSTEM_KM3_S2, GM_VENUS_KM3_S2, MU_KM3_S2_TO_AU3_D2, TAU } from '../../core/constants'
import { type Mat3, matIdentity, matMulVec, matTranspose } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecCross, vecDot, vecLength, vecMinus, vecMulScalar } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { type Time, tdb, timeShift } from '../time/time'
import { KeplerOrbit } from './asteroid'
import { rtnRotation } from './collision'

// Canonical two-body mechanics over KeplerOrbit: the definition of an orbit by classical elements or by a
// Cartesian state, its normalization into one Kepler model in J2000 equatorial (ICRF-aligned) axes, exact
// state evaluation as a result union, classical elements relative to a chosen reference plane with explicit
// undefined angles, derived diagnostics, the difference between two states with its RTN components, and a
// curated table of gravitational centers with their DE440 GMs.
// Distances are AU, velocities AU/day, angles radians, gravitational parameters AU³/day², times TDB.
// Every state is geometric and relative to the orbit's center; nothing here corrects for light time.
// Functions allocate fresh results and never mutate their inputs.

// Plane the classical elements are referred to: the J2000 mean equator, whose axes are the canonical ones, or
// the J2000 ecliptic (rotated about +X by the J2000 mean obliquity).
export type ReferencePlane = 'equator' | 'ecliptic'

// Why an orbit cannot be built or evaluated.
// - degenerate: the angular momentum vanishes (rectilinear motion), so the state is not a conic.
// - outOfRange: the time offset exceeds what the universal-variable solver represents in double precision.
// - solverFailed: Kepler's equation did not converge or the solver produced a non-finite state.
export type OrbitFailureReason = 'degenerate' | 'outOfRange' | 'solverFailed'

// Failure of an orbit construction or evaluation.
export interface OrbitFailure {
	readonly ok: false
	// Why it failed.
	readonly reason: OrbitFailureReason
}

// Classical elements shared by the conic definitions.
interface ConicDefinitionBase {
	// Gravitational parameter of the center, AU³/day², positive.
	readonly mu: number
	// Plane the angles are referred to.
	readonly plane: ReferencePlane
	// Inclination to the plane, radians, 0..PI (above PI/2 is retrograde).
	readonly inclination: Angle
	// Longitude of the ascending node on the plane, radians, measured from +X.
	readonly node: Angle
	// Argument of periapsis from the ascending node, radians, in the direction of motion.
	readonly argumentOfPeriapsis: Angle
}

// Bound orbit (0 <= e < 1) from its semi-major axis and mean anomaly at an epoch.
export interface EllipticDefinition extends ConicDefinitionBase {
	readonly kind: 'elliptic'
	// Semi-major axis, AU, positive.
	readonly semiMajorAxis: Distance
	// Eccentricity, 0 <= e < 1.
	readonly eccentricity: number
	// Mean anomaly at the epoch, radians.
	readonly meanAnomaly: Angle
	// Epoch of the mean anomaly, any time scale (evaluated as TDB).
	readonly epoch: Time
}

// Parabolic orbit (e = 1 exactly) from its periapsis distance and time of periapsis passage. A parabola has no
// semi-major axis, period, or periodic mean anomaly.
export interface ParabolicDefinition extends ConicDefinitionBase {
	readonly kind: 'parabolic'
	// Periapsis distance, AU, positive.
	readonly periapsisDistance: Distance
	// Time of periapsis passage, the anchor of the model.
	readonly periapsisTime: Time
}

// Hyperbolic orbit (e > 1) from its periapsis distance, eccentricity, and time of periapsis passage.
export interface HyperbolicDefinition extends ConicDefinitionBase {
	readonly kind: 'hyperbolic'
	// Periapsis distance, AU, positive.
	readonly periapsisDistance: Distance
	// Eccentricity, above 1.
	readonly eccentricity: number
	// Time of periapsis passage, the anchor of the model.
	readonly periapsisTime: Time
}

// Orbit from a Cartesian state at an epoch, already in J2000 equatorial (ICRF-aligned) axes and relative to the
// center: no plane rotation is ever applied to it.
export interface CartesianDefinition {
	readonly kind: 'cartesian'
	// Gravitational parameter of the center, AU³/day², positive.
	readonly mu: number
	// Position relative to the center, AU.
	readonly position: Vec3
	// Velocity relative to the center, AU/day.
	readonly velocity: Vec3
	// Epoch of the state, any time scale (evaluated as TDB).
	readonly epoch: Time
}

// Every way an orbit can be defined.
export type OrbitDefinition = EllipticDefinition | ParabolicDefinition | HyperbolicDefinition | CartesianDefinition

// A built Kepler model whose state is in J2000 equatorial axes, with no output rotation.
export interface OrbitModel {
	readonly ok: true
	// Model whose `position` and `velocity` are the state at its `epoch` and whose rotation is the identity.
	readonly orbit: KeplerOrbit
}

// Result of building an orbit.
export type OrbitResult = OrbitModel | OrbitFailure

// Exact state of an orbit at an instant.
export interface OrbitState {
	readonly ok: true
	// Instant of the state (the time requested).
	readonly time: Time
	// Position relative to the center, AU, J2000 equatorial axes.
	readonly position: MutVec3
	// Velocity relative to the center, AU/day, J2000 equatorial axes.
	readonly velocity: MutVec3
}

// Result of evaluating an orbit at an instant.
export type OrbitStateResult = OrbitState | OrbitFailure

// Numerical class of a conic. The eccentricity stays the computed one; the class only decides which
// elements apply: circular below CIRCULAR_TOLERANCE, parabolic within PARABOLIC_TOLERANCE of 1.
export type ConicClass = 'circular' | 'elliptic' | 'parabolic' | 'hyperbolic'

// Why an angular element is undefined: the eccentricity vector vanishes (circular), or the orbital plane
// coincides with the reference plane so the line of nodes vanishes (equatorial).
export type UndefinedAngleReason = 'circular' | 'equatorial'

// An angular element that exists only for some geometries.
export type OrbitAngle = { readonly defined: true; readonly value: Angle } | { readonly defined: false; readonly reason: UndefinedAngleReason }

// Classical osculating elements at an instant relative to a reference plane. Angles are radians; a
// property absent from the object does not apply to the conic class.
export interface ClassicalElements {
	// Plane the angles are referred to.
	readonly plane: ReferencePlane
	// Numerical class of the conic.
	readonly conic: ConicClass
	// Eccentricity as computed, never rounded to 0 or 1.
	readonly eccentricity: number
	// Semi-latus rectum h²/mu, AU.
	readonly semiLatusRectum: Distance
	// Periapsis distance, AU.
	readonly periapsisDistance: Distance
	// Semi-major axis, AU: positive for a bound orbit, negative for a hyperbola, absent for a parabola.
	readonly semiMajorAxis?: Distance
	// Semi-minor axis, AU, of a bound orbit.
	readonly semiMinorAxis?: Distance
	// Apoapsis distance, AU, of a bound orbit.
	readonly apoapsisDistance?: Distance
	// Orbital period, days, of a bound orbit.
	readonly period?: number
	// Mean motion, radians/day, of a bound orbit or a hyperbola (sqrt(mu/|a|³)).
	readonly meanMotion?: number
	// Inclination to the plane, 0..PI.
	readonly inclination: Angle
	// Longitude of the ascending node, 0..TAU.
	readonly node: OrbitAngle
	// Argument of periapsis, 0..TAU.
	readonly argumentOfPeriapsis: OrbitAngle
	// Longitude of periapsis (node + argument of periapsis, or measured from +X on an equatorial orbit), 0..TAU.
	readonly longitudeOfPeriapsis: OrbitAngle
	// True anomaly: 0..TAU for a bound orbit, -PI..PI (inside the asymptotes) for an open one.
	readonly trueAnomaly: OrbitAngle
	// Argument of latitude (from the ascending node to the body), 0..TAU.
	readonly argumentOfLatitude: OrbitAngle
	// True longitude (node + argument of latitude, or measured from +X on an equatorial orbit), 0..TAU; always defined.
	readonly trueLongitude: Angle
	// Eccentric anomaly E of a bound orbit (0..TAU) or hyperbolic anomaly H of a hyperbola (unwrapped).
	readonly eccentricAnomaly?: Angle
	// Mean anomaly of a bound orbit (0..TAU) or of a hyperbola (e·sinh H − H, unwrapped).
	readonly meanAnomaly?: Angle
	// Time of the most recent periapsis passage of a bound orbit, or of the periapsis passage of an open one, TDB.
	readonly periapsisTime?: Time
}

// Derived dynamical quantities of a state.
export interface OrbitDiagnostics {
	// Distance from the center, AU.
	readonly radius: Distance
	// Speed relative to the center, AU/day.
	readonly speed: number
	// Radial speed (r·v)/|r|, AU/day, positive when receding.
	readonly radialSpeed: number
	// Transverse speed |h|/|r|, AU/day.
	readonly transverseSpeed: number
	// Escape speed sqrt(2 mu/|r|), AU/day.
	readonly escapeSpeed: number
	// Specific orbital energy v²/2 − mu/r, AU²/day²: negative bound, zero parabolic, positive hyperbolic.
	readonly specificEnergy: number
	// Specific angular momentum r×v, AU²/day, J2000 equatorial axes.
	readonly angularMomentum: Vec3
	// Magnitude of the specific angular momentum, AU²/day.
	readonly angularMomentumMagnitude: number
	// Eccentricity vector, dimensionless, toward periapsis, J2000 equatorial axes.
	readonly eccentricityVector: Vec3
	// Unit normal of the orbital plane (along h), J2000 equatorial axes.
	readonly normal: Vec3
}

// Difference between a model state and a reference state at the same instant, center, and axes.
export interface StateResidual {
	// Position difference model − reference, AU.
	readonly position: Vec3
	// Velocity difference model − reference, AU/day.
	readonly velocity: Vec3
	// Norm of the position difference, AU.
	readonly distance: Distance
	// Norm of the velocity difference, AU/day.
	readonly speed: number
	// Position difference in the RTN frame of the reference (R radial, T transverse, N normal), AU; absent when
	// the reference has no RTN frame (zero radius or radial velocity).
	readonly rtnPosition?: Vec3
	// Velocity difference projected on the same instantaneous RTN axes, AU/day, without a rotating-frame term.
	readonly rtnVelocity?: Vec3
}

// A body an orbit may be centered on, with a gravitational parameter trustworthy enough to propagate around it.
export interface OrbitCenter {
	// NAIF ID of the body or barycenter, the SPK identity of the center.
	readonly code: number
	// English name.
	readonly name: string
	// Gravitational parameter, AU³/day² (JPL DE440).
	readonly mu: number
	// Equatorial radius of the body (of the planet for a system barycenter), AU, from NAIF pck00008.tpc; a
	// geometric reference for warnings, not a collision surface.
	readonly radius: Distance
	// Whether the center is a system barycenter whose GM includes the planet's satellites.
	readonly system: boolean
}

// Eccentricity below which an orbit is classified circular and its periapsis direction undefined.
export const CIRCULAR_TOLERANCE = 1e-10

// Distance |e − 1| within which an orbit is classified parabolic: semi-major axis, period, and mean anomaly
// do not apply. The relative error of double-precision eccentricity is ~1e-15, so 1e-10 only absorbs rounding.
export const PARABOLIC_TOLERANCE = 1e-10

// Sine of the inclination (to 0 or PI) below which an orbit is classified equatorial and its node undefined.
export const EQUATORIAL_TOLERANCE = 1e-10

// Sine of the angle between position and velocity below which a state is rectilinear (degenerate): its
// angular momentum is lost in the rounding of |r|·|v|.
export const DEGENERATE_TOLERANCE = 1e-12

// Rotation from the J2000 ecliptic to the J2000 equator.
const ECLIPTIC_TO_EQUATOR = matTranspose(ECLIPTIC_J2000_MATRIX)

// Output rotation of every canonical model: none, its state is already equatorial.
const IDENTITY: Mat3 = matIdentity()

// Gravitational centers whose GM is published by DE440 (NAIF gm_de440.tpc) and whose state an SPK of the
// planetary ephemeris resolves. Mars, Jupiter, Saturn, Uranus, Neptune, and Pluto are their system
// barycenters, since the DE440 SPK resolves the barycenter and the system GM acts there.
export const ORBIT_CENTERS: readonly OrbitCenter[] = [
	{ code: 10, name: 'Sun', mu: GM_SUN_DE440_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 696000 / AU_KM, system: false },
	{ code: 199, name: 'Mercury', mu: GM_MERCURY_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 2439.7 / AU_KM, system: false },
	{ code: 299, name: 'Venus', mu: GM_VENUS_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 6051.8 / AU_KM, system: false },
	{ code: 399, name: 'Earth', mu: GM_EARTH_DE440_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 6378.14 / AU_KM, system: false },
	{ code: 301, name: 'Moon', mu: GM_MOON_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 1737.4 / AU_KM, system: false },
	{ code: 4, name: 'Mars system', mu: GM_MARS_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 3396.19 / AU_KM, system: true },
	{ code: 5, name: 'Jupiter system', mu: GM_JUPITER_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 71492 / AU_KM, system: true },
	{ code: 6, name: 'Saturn system', mu: GM_SATURN_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 60268 / AU_KM, system: true },
	{ code: 7, name: 'Uranus system', mu: GM_URANUS_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 25559 / AU_KM, system: true },
	{ code: 8, name: 'Neptune system', mu: GM_NEPTUNE_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 24764 / AU_KM, system: true },
	{ code: 9, name: 'Pluto system', mu: GM_PLUTO_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2, radius: 1195 / AU_KM, system: true },
]

// The center of ORBIT_CENTERS with the NAIF ID `code`, or undefined when none has a trustworthy GM.
export function orbitCenter(code: number): OrbitCenter | undefined {
	return ORBIT_CENTERS.find((e) => e.code === code)
}

// Builds the canonical Kepler model of a definition. Elements on the ecliptic are turned into a state in the
// plane frame and rotated into the equator exactly once; a Cartesian definition is used as given. The model's
// rotation is the identity, so its `at()` returns equatorial states. The anchor epoch is the definition's
// epoch, or its periapsis time for a parabola or hyperbola. Returns `degenerate` for a rectilinear state
// (see DEGENERATE_TOLERANCE) and `solverFailed` when Kepler's equation for the mean anomaly does not converge.
export function orbitOf(definition: OrbitDefinition): OrbitResult {
	let position: Vec3
	let velocity: Vec3
	let epoch: Time

	if (definition.kind === 'cartesian') {
		position = definition.position
		velocity = definition.velocity
		epoch = definition.epoch
	} else {
		let local: KeplerOrbit

		try {
			local = conicInPlane(definition)
		} catch {
			return { ok: false, reason: 'solverFailed' }
		}

		position = local.position
		velocity = local.velocity
		epoch = local.epoch

		if (definition.plane === 'ecliptic') {
			position = matMulVec(ECLIPTIC_TO_EQUATOR, position)
			velocity = matMulVec(ECLIPTIC_TO_EQUATOR, velocity)
		}
	}

	// KeplerOrbit throws on an exactly zero h and propagates garbage on one lost in rounding.
	if (!(vecLength(vecCross(position, velocity)) > DEGENERATE_TOLERANCE * vecLength(position) * vecLength(velocity))) {
		return { ok: false, reason: 'degenerate' }
	}

	return { ok: true, orbit: new KeplerOrbit(position, velocity, epoch, definition.mu, IDENTITY) }
}

// Builds the Kepler model of conic elements in the frame of their own plane, with no output rotation.
function conicInPlane(definition: EllipticDefinition | ParabolicDefinition | HyperbolicDefinition) {
	const { mu, inclination, node, argumentOfPeriapsis } = definition

	if (definition.kind === 'elliptic') {
		const { semiMajorAxis: a, eccentricity: e } = definition
		return KeplerOrbit.meanAnomaly(a * (1 - e) * (1 + e), e, inclination, node, argumentOfPeriapsis, definition.meanAnomaly, definition.epoch, mu, IDENTITY)
	}

	const e = definition.kind === 'parabolic' ? 1 : definition.eccentricity
	return KeplerOrbit.periapsis(definition.periapsisDistance * (1 + e), e, inclination, node, argumentOfPeriapsis, definition.periapsisTime, mu, IDENTITY)
}

// Exact state of a canonical model at `time`, by universal-variable propagation from its epoch. Returns
// `outOfRange` when the offset exceeds the solver's double-precision range (very long offsets on an open orbit)
// and `solverFailed` for any other failure or non-finite result, never NaN. KeplerOrbit measures the offset in
// TT, whose TDB − TT series is only meaningful within about 10⁷ days of J2000, so instants must stay there.
export function orbitStateAt(orbit: KeplerOrbit, time: Time): OrbitStateResult {
	let position: MutVec3
	let velocity: MutVec3

	try {
		;[position, velocity] = orbit.at(time)
	} catch (error) {
		return { ok: false, reason: error instanceof Error && error.message.includes('beyond the range') ? 'outOfRange' : 'solverFailed' }
	}

	if (!isFiniteVec(position) || !isFiniteVec(velocity)) return { ok: false, reason: 'solverFailed' }

	return { ok: true, time, position, velocity }
}

// Whether every component of a vector is finite.
function isFiniteVec(v: Vec3) {
	return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
}

// Signed angle from `from` to `to` about the unit axis `axis`, radians, -PI..PI, positive counterclockwise
// seen from the tip of `axis`. Uses atan2 so it stays accurate near 0 and PI.
function angleAbout(from: Vec3, to: Vec3, axis: Vec3) {
	return Math.atan2(vecDot(axis, vecCross(from, to)), vecDot(from, to))
}

// Numerical class of an eccentricity (see CIRCULAR_TOLERANCE and PARABOLIC_TOLERANCE).
export function conicClass(eccentricity: number): ConicClass {
	if (eccentricity < CIRCULAR_TOLERANCE) return 'circular'
	if (Math.abs(eccentricity - 1) <= PARABOLIC_TOLERANCE) return 'parabolic'
	return eccentricity < 1 ? 'elliptic' : 'hyperbolic'
}

// Classical elements of a non-degenerate equatorial state (`position` AU and `velocity` AU/day relative to the
// center at `time`) about a center of gravitational parameter `mu` (AU³/day²), referred to `plane`.
//
// Directions are measured about the angular momentum, so angles grow in the direction of motion: the argument
// of periapsis from the ascending node to the eccentricity vector, the true anomaly from it to the body, the
// argument of latitude from the node to the body. On an equatorial orbit (see EQUATORIAL_TOLERANCE) the node,
// the argument of periapsis, and the argument of latitude are undefined, and the longitudes of periapsis and
// of the body are measured from +X in the direction of motion; on a circular orbit (see CIRCULAR_TOLERANCE) the
// periapsis is undefined, and so are the argument of periapsis, the longitude of periapsis, the true anomaly,
// and the anomalies derived from it. The periapsis time of a near-parabolic orbit is the Kepler M/n, which
// loses relative precision as |e − 1| approaches PARABOLIC_TOLERANCE; a parabolic class uses Barker's equation.
export function orbitalElements(time: Time, position: Vec3, velocity: Vec3, mu: number, plane: ReferencePlane): ClassicalElements {
	const r = plane === 'ecliptic' ? matMulVec(ECLIPTIC_J2000_MATRIX, position) : position
	const v = plane === 'ecliptic' ? matMulVec(ECLIPTIC_J2000_MATRIX, velocity) : velocity

	const hv = vecCross(r, v)
	const h = vecLength(hv)
	const hHat = vecMulScalar(hv, 1 / h)
	const ev = eccentricityOf(r, v, mu)
	const e = vecLength(ev)
	const conic = conicClass(e)
	const p = (h * h) / mu
	const q = p / (1 + e)

	const hxy = Math.hypot(hv[0], hv[1])
	const inclination = Math.atan2(hxy, hv[2])
	const equatorial = hxy <= EQUATORIAL_TOLERANCE * h
	const circular = conic === 'circular'

	// Reference direction of the angles: the ascending node, or +X when the node is undefined.
	const nodeAngle = equatorial ? 0 : normalizeAngle(Math.atan2(hv[0], -hv[1]))
	const reference: Vec3 = equatorial ? [1, 0, 0] : [Math.cos(nodeAngle), Math.sin(nodeAngle), 0]

	const u = normalizeAngle(angleAbout(reference, r, hHat))
	const w = circular ? 0 : normalizeAngle(angleAbout(reference, ev, hHat))
	const bound = conic === 'circular' || conic === 'elliptic'
	const nu = circular ? 0 : bound ? normalizeAngle(angleAbout(ev, r, hHat)) : normalizePI(angleAbout(ev, r, hHat))

	const node: OrbitAngle = equatorial ? { defined: false, reason: 'equatorial' } : { defined: true, value: nodeAngle }
	const argumentOfPeriapsis: OrbitAngle = circular ? { defined: false, reason: 'circular' } : equatorial ? { defined: false, reason: 'equatorial' } : { defined: true, value: w }
	const longitudeOfPeriapsis: OrbitAngle = circular ? { defined: false, reason: 'circular' } : { defined: true, value: normalizeAngle(nodeAngle + w) }
	const trueAnomaly: OrbitAngle = circular ? { defined: false, reason: 'circular' } : { defined: true, value: nu }
	const argumentOfLatitude: OrbitAngle = equatorial ? { defined: false, reason: 'equatorial' } : { defined: true, value: u }
	const trueLongitude = normalizeAngle(nodeAngle + u)

	const base = { plane, conic, eccentricity: e, semiLatusRectum: p, periapsisDistance: q, inclination, node, argumentOfPeriapsis, longitudeOfPeriapsis, trueAnomaly, argumentOfLatitude, trueLongitude } as const

	if (conic === 'parabolic') {
		// Barker's equation: t − tp = sqrt(2 q³/mu) (D + D³/3), D = tan(ν/2).
		const D = Math.tan(nu / 2)
		const sincePeriapsis = Math.sqrt((2 * q * q * q) / mu) * (D + (D * D * D) / 3)
		return { ...base, periapsisTime: timeShift(tdb(time), -sincePeriapsis) }
	}

	const a = p / ((1 - e) * (1 + e))
	const n = Math.sqrt(mu / Math.abs(a * a * a))

	if (bound) {
		const elements = { ...base, semiMajorAxis: a, semiMinorAxis: a * Math.sqrt((1 - e) * (1 + e)), apoapsisDistance: p / (1 - e), period: TAU / n, meanMotion: n }
		if (circular) return elements
		const E = normalizeAngle(2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2)))
		const M = normalizeAngle(E - e * Math.sin(E))
		return { ...elements, eccentricAnomaly: E, meanAnomaly: M, periapsisTime: timeShift(tdb(time), -M / n) }
	}

	const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2))
	const M = e * Math.sinh(H) - H
	return { ...base, semiMajorAxis: a, meanMotion: n, eccentricAnomaly: H, meanAnomaly: M, periapsisTime: timeShift(tdb(time), -M / n) }
}

// Eccentricity vector ((v² − mu/r) r − (r·v) v)/mu, dimensionless, in the axes of `r` and `v`.
function eccentricityOf(r: Vec3, v: Vec3, mu: number): MutVec3 {
	const radius = vecLength(r)
	const a = vecMulScalar(r, vecDot(v, v) - mu / radius)
	const b = vecMulScalar(v, vecDot(r, v))
	return vecMulScalar(vecMinus(a, b, a), 1 / mu, a)
}

// Dynamical diagnostics of a non-degenerate state (`position` AU and `velocity` AU/day relative to the center,
// any axes) about a center of gravitational parameter `mu` (AU³/day²). Vectors are in the axes of the state.
export function orbitDiagnostics(position: Vec3, velocity: Vec3, mu: number): OrbitDiagnostics {
	const radius = vecLength(position)
	const speed = vecLength(velocity)
	const angularMomentum = vecCross(position, velocity)
	const angularMomentumMagnitude = vecLength(angularMomentum)

	return {
		radius,
		speed,
		radialSpeed: vecDot(position, velocity) / radius,
		transverseSpeed: angularMomentumMagnitude / radius,
		escapeSpeed: Math.sqrt((2 * mu) / radius),
		specificEnergy: (speed * speed) / 2 - mu / radius,
		angularMomentum,
		angularMomentumMagnitude,
		eccentricityVector: eccentricityOf(position, velocity, mu),
		normal: vecMulScalar(angularMomentum, 1 / angularMomentumMagnitude),
	}
}

// Difference model − reference of two states at the same instant, relative to the same center, in the same
// axes (position AU, velocity AU/day). The RTN components use the frame of the reference (rtnRotation:
// R = r̂, N = ĥ, T = N × R) and are absent when that frame is undefined. The velocity components are a
// projection on the instantaneous axes, without the transport term of a rotating frame.
export function stateResidual(modelPosition: Vec3, modelVelocity: Vec3, referencePosition: Vec3, referenceVelocity: Vec3): StateResidual {
	const position = vecMinus(modelPosition, referencePosition)
	const velocity = vecMinus(modelVelocity, referenceVelocity)
	const rtn = rtnRotation(referencePosition, referenceVelocity)
	const residual = { position, velocity, distance: vecLength(position), speed: vecLength(velocity) }
	return rtn === undefined ? residual : { ...residual, rtnPosition: matMulVec(rtn, position), rtnVelocity: matMulVec(rtn, velocity) }
}
