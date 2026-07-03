import { matIdentity } from '../../math/linear-algebra/mat3'
import { Matrix } from '../../math/linear-algebra/matrix'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Time } from '../time/time'
import { KeplerOrbit } from './asteroid'

// Orbit-uncertainty propagation and the sky-plane ephemeris error ellipse. A least-squares orbit fit
// (fitOrbit) yields a six-element Cartesian state and its 6x6 covariance at the fit epoch; these turn
// that epoch covariance into a predicted uncertainty at any later time and project it onto the plane of
// sky. The state ordering is [x, y, z, vx, vy, vz]; positions are AU, velocities AU/day, and everything
// stays in the state frame (the fit's input frame, ICRF equatorial for fitOrbit). Angles are radians.
//
// The state evolves nonlinearly under two-body motion, but a covariance propagates linearly to first
// order through the state-transition matrix (STM) Phi = d state(t) / d state(epoch): C(t) = Phi C0 Phi^T.
// The STM is formed by central finite differences of the two-body propagation, which reuses KeplerOrbit
// and avoids the closed-form f/g partials. The linear-Gaussian model is valid while the uncertainty
// stays small (short-to-medium arcs); very poorly constrained orbits need nonlinear methods instead.

// Options for the state-transition matrix and covariance propagation.
export interface StateTransitionOptions {
	// Relative finite-difference step, scaled by each state component's magnitude. Defaults to 1e-6, near
	// the optimum for a central difference in double precision.
	readonly relativeStep?: number
	// Absolute floor added to the position-component step (AU), so a near-zero component still perturbs.
	readonly positionFloor?: number
	// Absolute floor added to the velocity-component step (AU/day).
	readonly velocityFloor?: number
}

// A sky-plane 1-sigma (or n-sigma) error ellipse.
export interface UncertaintyEllipse {
	// Semi-major axis of the ellipse (radians on the sky).
	readonly semiMajor: Angle
	// Semi-minor axis of the ellipse (radians on the sky).
	readonly semiMinor: Angle
	// Position angle of the major axis, measured from North through East, normalized to [0, PI).
	readonly positionAngle: Angle
}

// Options for the ephemeris uncertainty ellipse.
export interface UncertaintyEllipseOptions {
	// Confidence scale applied to the axes: 1 for the 1-sigma ellipse (default), 3 for the 3-sigma one.
	readonly sigma?: number
}

// Default relative finite-difference step for the state-transition matrix.
const DEFAULT_RELATIVE_STEP = 1e-6
// Default absolute step floors (AU and AU/day) so a zero component is still perturbed.
const DEFAULT_POSITION_FLOOR = 1e-9
const DEFAULT_VELOCITY_FLOOR = 1e-11

// Identity output rotation: the propagation must stay in the state frame so the STM matches the state
// covariance, regardless of the orbit's own output rotation.
const STATE_FRAME = matIdentity()

// Fractional distance below which the object is treated as being at a celestial pole, where right
// ascension is undefined and the East/North basis is replaced by a fixed tangent basis.
const POLE_TOLERANCE = 1e-8

// Propagates a raw six-element state to `time` in the state frame (no output rotation), returning the
// propagated [x, y, z, vx, vy, vz].
function propagateState(state: readonly number[], epoch: Time, mu: number, time: Time): number[] {
	const orbit = new KeplerOrbit([state[0], state[1], state[2]], [state[3], state[4], state[5]], epoch, mu, STATE_FRAME)
	const [position, velocity] = orbit.at(time)
	return [position[0], position[1], position[2], velocity[0], velocity[1], velocity[2]]
}

// Computes the 6x6 two-body state-transition matrix Phi = d state(time) / d state(epoch) of an orbit.
//
// Each column is a central finite difference of the propagated state with respect to one epoch-state
// component. At `time` equal to the epoch this is the identity. The matrix is expressed in the orbit's
// state frame (the frame of `orbit.position`/`orbit.velocity`), not its output rotation.
export function stateTransitionMatrix(orbit: KeplerOrbit, time: Time, options?: StateTransitionOptions): Matrix {
	const relativeStep = options?.relativeStep ?? DEFAULT_RELATIVE_STEP
	const positionFloor = options?.positionFloor ?? DEFAULT_POSITION_FLOOR
	const velocityFloor = options?.velocityFloor ?? DEFAULT_VELOCITY_FLOOR

	const base = [orbit.position[0], orbit.position[1], orbit.position[2], orbit.velocity[0], orbit.velocity[1], orbit.velocity[2]]
	const phi = new Matrix(6, 6)

	for (let j = 0; j < 6; j++) {
		const step = relativeStep * Math.abs(base[j]) + (j < 3 ? positionFloor : velocityFloor)

		const plus = base.slice()
		plus[j] += step
		const minus = base.slice()
		minus[j] -= step

		const forward = propagateState(plus, orbit.epoch, orbit.mu, time)
		const backward = propagateState(minus, orbit.epoch, orbit.mu, time)

		const scale = 1 / (2 * step)
		for (let i = 0; i < 6; i++) phi.set(i, j, (forward[i] - backward[i]) * scale)
	}

	return phi
}

// Propagates a 6x6 state covariance from the orbit's epoch to `time` via C(time) = Phi C Phi^T.
//
// `orbit` provides the reference trajectory and epoch; `covariance` is the state covariance at the epoch
// (e.g. OrbitFitResult.covariance), ordered [x, y, z, vx, vy, vz] in the state frame. The result is the
// covariance at `time` in the same ordering and frame; its top-left 3x3 block is the position covariance
// used by ephemerisUncertaintyEllipse.
export function propagateStateCovariance(orbit: KeplerOrbit, covariance: Matrix, time: Time, options?: StateTransitionOptions): Matrix {
	if (covariance.rows !== 6 || covariance.cols !== 6) throw new Error('state covariance must be 6x6')
	const phi = stateTransitionMatrix(orbit, time, options)
	return phi.mul(covariance).mul(phi.transposed)
}

// Projects a position covariance onto the plane of sky at a geocentric direction, returning the error
// ellipse.
//
// `covariance` supplies the 3x3 position covariance in its top-left block (a full 6x6 state covariance is
// accepted). `geocentric` is the observer-to-object vector in the same frame (AU, ICRF equatorial); its
// direction sets the tangent plane and its length converts the linear position spread to an angular one.
// The tangent-plane axes are East (increasing right ascension) and North (increasing declination), so the
// returned position angle follows the standard North-through-East convention. The Earth's own position is
// treated as errorless, so the direction covariance equals the object's position covariance.
export function ephemerisUncertaintyEllipse(covariance: Matrix, geocentric: Vec3, options?: UncertaintyEllipseOptions): UncertaintyEllipse {
	const sigma = options?.sigma ?? 1

	const [x, y, z] = geocentric
	const distance = Math.sqrt(x * x + y * y + z * z)
	const horizontal = Math.sqrt(x * x + y * y)

	// Sky-plane East/North unit vectors at the object's direction. Right ascension is undefined within a
	// hair of a celestial pole (horizontal ~ 0), so there fall back to a fixed orthonormal tangent basis
	// perpendicular to the line of sight (the ellipse shape is well defined; only its position angle,
	// itself meaningless at the pole, is arbitrary).
	let east: Vec3
	let north: Vec3
	if (horizontal < POLE_TOLERANCE * distance) {
		const sign = z >= 0 ? 1 : -1
		east = [1, 0, 0]
		north = [0, sign, 0]
	} else {
		const sinRa = y / horizontal
		const cosRa = x / horizontal
		const sinDec = z / distance
		const cosDec = horizontal / distance
		east = [-sinRa, cosRa, 0]
		north = [-sinDec * cosRa, -sinDec * sinRa, cosDec]
	}

	// Angular covariance J C J^T with J = (1/distance) [east; north]. Form C·east and C·north once.
	const cEast = covariance3MulVec(covariance, east)
	const cNorth = covariance3MulVec(covariance, north)
	const inverseDistanceSquared = 1 / (distance * distance)
	const varEast = (east[0] * cEast[0] + east[1] * cEast[1] + east[2] * cEast[2]) * inverseDistanceSquared
	const varNorth = (north[0] * cNorth[0] + north[1] * cNorth[1] + north[2] * cNorth[2]) * inverseDistanceSquared
	const covEastNorth = (east[0] * cNorth[0] + east[1] * cNorth[1] + east[2] * cNorth[2]) * inverseDistanceSquared

	// Eigenvalues of the symmetric 2x2 [[varEast, covEastNorth], [covEastNorth, varNorth]].
	const halfTrace = 0.5 * (varEast + varNorth)
	const radius = Math.sqrt(Math.max(0, 0.25 * (varEast - varNorth) * (varEast - varNorth) + covEastNorth * covEastNorth))
	const major = halfTrace + radius
	const minor = halfTrace - radius

	// Major-axis eigenvector (East, North) = (covEastNorth, major - varEast); its position angle from
	// North through East. Fall back to an axis-aligned angle when the off-diagonal term vanishes.
	let positionAngle: number
	if (covEastNorth === 0 && major - varEast === 0) positionAngle = varEast >= varNorth ? Math.PI / 2 : 0
	else positionAngle = Math.atan2(covEastNorth, major - varEast)
	if (positionAngle < 0) positionAngle += Math.PI

	return { semiMajor: sigma * Math.sqrt(Math.max(0, major)), semiMinor: sigma * Math.sqrt(Math.max(0, minor)), positionAngle }
}

// Multiplies the top-left 3x3 block of `covariance` by a 3-vector.
function covariance3MulVec(covariance: Matrix, v: Vec3): Vec3 {
	return [covariance.get(0, 0) * v[0] + covariance.get(0, 1) * v[1] + covariance.get(0, 2) * v[2], covariance.get(1, 0) * v[0] + covariance.get(1, 1) * v[1] + covariance.get(1, 2) * v[2], covariance.get(2, 0) * v[0] + covariance.get(2, 1) * v[1] + covariance.get(2, 2) * v[2]]
}
