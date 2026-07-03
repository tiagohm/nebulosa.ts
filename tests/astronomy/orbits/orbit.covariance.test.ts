import { expect, test } from 'bun:test'
import { earth } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { KeplerOrbit } from '../../../src/astronomy/orbits/asteroid'
import { ephemerisUncertaintyEllipse, propagateStateCovariance, stateTransitionMatrix } from '../../../src/astronomy/orbits/orbit.covariance'
import { Timescale, type Time, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from '../../../src/core/constants'
import { matIdentity } from '../../../src/math/linear-algebra/mat3'
import { Matrix } from '../../../src/math/linear-algebra/matrix'
import type { Vec3 } from '../../../src/math/linear-algebra/vec3'
import { deg, toArcsec } from '../../../src/math/units/angle'

// A sample main-belt asteroid state in the identity (ICRF equatorial) frame, so the state frame and the
// output frame coincide. The covariance machinery has no external reference: the state-transition matrix
// is verified through the symplectic identity of two-body motion, and the covariance/ellipse against a
// deterministic sigma-point (unscented) propagation of the same orbit.
const IDENTITY = matIdentity()
const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TDB)
const ORBIT = KeplerOrbit.meanAnomaly(2.5 * (1 - 0.15 * 0.15), 0.15, deg(8), deg(100), deg(60), deg(30), EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)

// Diagonal epoch state covariance: 1e-6 AU (~150 km) per position axis, 1e-8 AU/day per velocity axis.
const POSITION_SIGMA = 1e-6
const VELOCITY_SIGMA = 1e-8

// Builds the diagonal epoch covariance as a 6x6 matrix.
function epochCovariance(): Matrix {
	const covariance = new Matrix(6, 6)
	for (let k = 0; k < 3; k++) {
		covariance.set(k, k, POSITION_SIGMA * POSITION_SIGMA)
		covariance.set(k + 3, k + 3, VELOCITY_SIGMA * VELOCITY_SIGMA)
	}
	return covariance
}

// Propagates the twelve symmetric sigma points x0 +/- sqrt(6)*sigma of the diagonal epoch covariance to
// `time`, returning the propagated states, their mean, and the sigma-point covariance (weight 1/12). This
// unscented propagation reproduces the linearized covariance for a nearly linear system.
function sigmaPointPropagation(time: Time): { states: number[][]; mean: number[]; covariance: Matrix } {
	const base = [ORBIT.position[0], ORBIT.position[1], ORBIT.position[2], ORBIT.velocity[0], ORBIT.velocity[1], ORBIT.velocity[2]]
	const spread = Math.sqrt(6)
	const sigma = [POSITION_SIGMA, POSITION_SIGMA, POSITION_SIGMA, VELOCITY_SIGMA, VELOCITY_SIGMA, VELOCITY_SIGMA]

	const states: number[][] = []
	for (let k = 0; k < 6; k++) {
		for (const sign of [1, -1]) {
			const state = base.slice()
			state[k] += sign * spread * sigma[k]
			const orbit = new KeplerOrbit([state[0], state[1], state[2]], [state[3], state[4], state[5]], EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
			const [position, velocity] = orbit.at(time)
			states.push([position[0], position[1], position[2], velocity[0], velocity[1], velocity[2]])
		}
	}

	const mean = new Array<number>(6).fill(0)
	for (const state of states) for (let i = 0; i < 6; i++) mean[i] += state[i] / states.length

	const covariance = new Matrix(6, 6)
	for (const state of states) {
		for (let i = 0; i < 6; i++) {
			for (let j = 0; j < 6; j++) covariance.set(i, j, covariance.get(i, j) + ((state[i] - mean[i]) * (state[j] - mean[j])) / states.length)
		}
	}
	return { states, mean, covariance }
}

test('the state-transition matrix is the identity at the epoch', () => {
	const phi = stateTransitionMatrix(ORBIT, EPOCH)
	for (let i = 0; i < 6; i++) {
		for (let j = 0; j < 6; j++) expect(phi.get(i, j)).toBeCloseTo(i === j ? 1 : 0, 8)
	}
})

test('the state-transition matrix is symplectic', () => {
	// Two-body motion is Hamiltonian, so Phi^T J Phi = J with J the symplectic form; this holds to the
	// central-difference accuracy (~1e-6) and is independent of how the STM is built.
	const phi = stateTransitionMatrix(ORBIT, timeShift(EPOCH, 40))
	const j = new Matrix(6, 6)
	for (let k = 0; k < 3; k++) {
		j.set(k, k + 3, 1)
		j.set(k + 3, k, -1)
	}
	const test = phi.transposed.mul(j).mul(phi)
	for (let r = 0; r < 6; r++) {
		for (let c = 0; c < 6; c++) expect(test.get(r, c)).toBeCloseTo(j.get(r, c), 5)
	}
})

test('propagated covariance matches a sigma-point propagation', () => {
	const time = timeShift(EPOCH, 40)
	const propagated = propagateStateCovariance(ORBIT, epochCovariance(), time)
	const reference = sigmaPointPropagation(time).covariance

	// The position block agrees to a small fraction of the epoch variance; the linearization and the
	// unscented propagation coincide for this small, nearly linear covariance.
	for (let i = 0; i < 3; i++) {
		for (let j = 0; j < 3; j++) expect(Math.abs(propagated.get(i, j) - reference.get(i, j))).toBeLessThan(1e-6 * POSITION_SIGMA * POSITION_SIGMA)
	}
	// The propagated covariance stays symmetric.
	expect(propagated.get(0, 4)).toBeCloseTo(propagated.get(4, 0), 20)
})

test('the uncertainty ellipse of a diagonal covariance is analytic', () => {
	// Looking down the x-axis (RA = 0, Dec = 0), East is +y and North is +z. A position covariance with
	// 3e-6 along y and 1e-6 along z projects to an ellipse whose major axis (East) is 3e-6/distance and
	// whose position angle is 90 deg (due East of North).
	const distance = 2
	const covariance = new Matrix(6, 6)
	covariance.set(1, 1, 3e-6 * 3e-6)
	covariance.set(2, 2, 1e-6 * 1e-6)
	const geocentric: Vec3 = [distance, 0, 0]

	const ellipse = ephemerisUncertaintyEllipse(covariance, geocentric, { sigma: 3 })
	expect(ellipse.semiMajor).toBeCloseTo((3 * 3e-6) / distance, 12)
	expect(ellipse.semiMinor).toBeCloseTo((3 * 1e-6) / distance, 12)
	expect(ellipse.positionAngle).toBeCloseTo(Math.PI / 2, 10)
})

test('the uncertainty ellipse is finite for a pole direction', () => {
	// Looking straight along +z (the north celestial pole) the horizontal component vanishes and RA is
	// undefined; the ellipse must still be finite, using the x/y position spread projected onto the sky.
	const distance = 2
	const covariance = new Matrix(6, 6)
	covariance.set(0, 0, 4e-6 * 4e-6)
	covariance.set(1, 1, 1e-6 * 1e-6)
	covariance.set(2, 2, 9e-6 * 9e-6)
	const ellipse = ephemerisUncertaintyEllipse(covariance, [0, 0, distance])

	expect(Number.isFinite(ellipse.semiMajor)).toBe(true)
	expect(Number.isFinite(ellipse.positionAngle)).toBe(true)
	// The line-of-sight (z) variance drops out; the axes come from the 4e-6 and 1e-6 in-plane spreads.
	expect(ellipse.semiMajor).toBeCloseTo(4e-6 / distance, 12)
	expect(ellipse.semiMinor).toBeCloseTo(1e-6 / distance, 12)
})

test('the uncertainty ellipse rejects a zero-range direction', () => {
	// An angular ellipse is undefined at zero range; a zero geocentric vector must throw rather than
	// return NaN axes.
	const covariance = new Matrix(6, 6)
	for (let k = 0; k < 3; k++) covariance.set(k, k, 1e-6 * 1e-6)
	expect(() => ephemerisUncertaintyEllipse(covariance, [0, 0, 0])).toThrow()
})

test('the ellipse matches the sky-plane scatter of the propagated covariance', () => {
	const time = timeShift(EPOCH, 40)
	const propagated = propagateStateCovariance(ORBIT, epochCovariance(), time)

	const observer = earth(time)[0]
	const object = ORBIT.at(time)[0]
	const geocentric: Vec3 = [object[0] - observer[0], object[1] - observer[1], object[2] - observer[2]]
	const ellipse = ephemerisUncertaintyEllipse(propagated, geocentric)

	// Project the propagated sigma points onto the sky and take their tangent-plane scatter.
	const { states, mean } = sigmaPointPropagation(time)
	const d = Math.hypot(geocentric[0], geocentric[1], geocentric[2])
	const h = Math.hypot(geocentric[0], geocentric[1])
	const east: Vec3 = [-geocentric[1] / h, geocentric[0] / h, 0]
	const north: Vec3 = [(-geocentric[2] / d) * (geocentric[0] / h), (-geocentric[2] / d) * (geocentric[1] / h), h / d]
	let varEast = 0
	let varNorth = 0
	let covEastNorth = 0
	for (const state of states) {
		const dx = state[0] - mean[0]
		const dy = state[1] - mean[1]
		const dz = state[2] - mean[2]
		const xi = (east[0] * dx + east[1] * dy) / d
		const eta = (north[0] * dx + north[1] * dy + north[2] * dz) / d
		varEast += (xi * xi) / states.length
		varNorth += (eta * eta) / states.length
		covEastNorth += (xi * eta) / states.length
	}
	const halfTrace = 0.5 * (varEast + varNorth)
	const radius = Math.sqrt(0.25 * (varEast - varNorth) ** 2 + covEastNorth * covEastNorth)

	expect(toArcsec(ellipse.semiMajor)).toBeCloseTo(toArcsec(Math.sqrt(halfTrace + radius)), 4)
	expect(toArcsec(ellipse.semiMinor)).toBeCloseTo(toArcsec(Math.sqrt(halfTrace - radius)), 4)
})
