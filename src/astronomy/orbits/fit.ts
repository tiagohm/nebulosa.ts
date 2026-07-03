import { ASEC2RAD, GM_SUN_PITJEVA_2005 } from '../../core/constants'
import { validateFinite, validateNonNegativeFinite, validatePositiveFinite, validateTime, validateVector } from '../../core/validation'
import { matIdentity } from '../../math/linear-algebra/mat3'
import { Matrix } from '../../math/linear-algebra/matrix'
import { type MutVec3, type Vec3, vecLength } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { CartesianCoordinate, EquatorialCoordinate } from '../coordinates/coordinate'
import type { Time } from '../time/time'
import { KeplerOrbit } from './asteroid'

// Differential-correction orbit fitting: refines a six-element Cartesian two-body state to weighted
// astrometric RA/Dec observations using a Levenberg-Marquardt least-squares loop with a finite-
// difference Jacobian, Cholesky-solved normal equations, and an optional parameter covariance.
// State units follow `mu` (positions/velocities share its length/time units); angles are radians.

// Number of fitted state parameters (3 position + 3 velocity).
const PARAMETER_COUNT = 6
// Default cap on Levenberg-Marquardt iterations.
const DEFAULT_MAX_ITERATIONS = 50
// Default relative chi-squared improvement tolerance for convergence.
const DEFAULT_TOLERANCE = 1e-12
// Default relative parameter-step tolerance for convergence.
const DEFAULT_PARAMETER_TOLERANCE = 1e-12
// Default tolerance on the max gradient component for convergence.
const DEFAULT_GRADIENT_TOLERANCE = 1e-10
// Default initial Levenberg-Marquardt damping factor.
const DEFAULT_INITIAL_DAMPING = 1e-3
// Default smallest acceptable topocentric distance before the model is rejected.
const DEFAULT_MIN_TOPOCENTRIC_DISTANCE = 1e-12
// Default absolute finite-difference step for position parameters.
const DEFAULT_POSITION_STEP = 1e-7
// Default absolute finite-difference step for velocity parameters.
const DEFAULT_VELOCITY_STEP = 1e-8
// Default relative finite-difference step (scaled by the parameter magnitude).
const DEFAULT_RELATIVE_STEP = 1e-6
// Default upper bound on any finite-difference step.
const DEFAULT_MAX_STEP = 1e-2
// Maximum damping increases attempted within one iteration before giving up.
const MAX_DAMPING_ATTEMPTS = 16
// Lower clamp on the damping factor.
const MIN_DAMPING = 1e-30
// Upper clamp on the damping factor.
const MAX_DAMPING = 1e30
// Maximum squared Cholesky condition number before the covariance is deemed unreliable.
const COVARIANCE_CONDITION_LIMIT = 1e24
// Identity rotation passed to KeplerOrbit so the fit works directly in the input frame.
const IDENTITY_ROTATION = matIdentity()

// Astrometric observation in the same inertial frame and distance units as the fitted state.
export interface OrbitFitObservation extends Readonly<EquatorialCoordinate> {
	// Epoch of the observation.
	readonly time: Time
	// 1-sigma right-ascension uncertainty, radians; falls back to the default when omitted.
	readonly raErr?: Angle
	// 1-sigma declination uncertainty, radians; falls back to the default when omitted.
	readonly decErr?: Angle
	// Observer position vector at the observation epoch, same frame/units as the state.
	readonly observerPosition: Vec3
}

// Optional controls for fitOrbit(); omitted fields use the module defaults.
export interface OrbitFitOptions {
	// Gravitational parameter, in units consistent with the state vectors.
	readonly mu?: number
	// Default RA uncertainty (radians) for observations without raErr.
	readonly defaultRaErr?: Angle
	// Default Dec uncertainty (radians) for observations without decErr.
	readonly defaultDecErr?: Angle
	// Iteration cap.
	readonly maxIterations?: number
	// Relative chi-squared improvement tolerance.
	readonly tolerance?: number
	// Relative parameter-step tolerance.
	readonly parameterTolerance?: number
	// Gradient-norm tolerance.
	readonly gradientTolerance?: number
	// Initial damping factor.
	readonly initialDamping?: number
	// Smallest acceptable topocentric distance.
	readonly minTopocentricDistance?: number
	// Absolute finite-difference step for position parameters.
	readonly finiteDifferencePositionStep?: number
	// Absolute finite-difference step for velocity parameters.
	readonly finiteDifferenceVelocityStep?: number
	// Relative finite-difference step.
	readonly relativeFiniteDifferenceStep?: number
	// Upper bound on any finite-difference step.
	readonly maxFiniteDifferenceStep?: number
	// When not false, compute the parameter covariance.
	readonly computeCovariance?: boolean
	// When true, reject steps whose trial state cannot be evaluated.
	readonly rejectInvalidSteps?: boolean
}

// Per-observation angular residual between observed and modeled positions.
export interface OrbitFitAngularResidual {
	// Observation epoch.
	readonly time: Time
	// Residual in right ascension, cos(dec)-weighted, radians.
	readonly dRA: Angle
	// Residual in declination, radians.
	readonly dDEC: Angle
	// Total angular residual (hypot of dRA and dDEC), radians.
	readonly total: Angle
}

// Fitted Cartesian state at the solution epoch.
export interface OrbitFitCartesianState {
	readonly epoch: Time
	readonly position: CartesianCoordinate
	readonly velocity: CartesianCoordinate
}

// Full output of an orbit fit: state, derived orbit, residuals, fit statistics, and convergence flags.
export interface OrbitFitResult {
	// Fitted Cartesian state.
	readonly state: OrbitFitCartesianState
	// KeplerOrbit derived from the fitted state.
	readonly orbit: KeplerOrbit
	// Parameter covariance (6x6), present when requested and well-conditioned.
	readonly covariance?: Matrix
	// Residuals: normalized (sigma units) and angular (radians).
	readonly residuals: {
		readonly normalized: readonly number[]
		readonly angular: readonly OrbitFitAngularResidual[]
	}
	// Chi-squared of the final fit.
	readonly chi2: number
	// Reduced chi-squared (chi2 / degrees of freedom); NaN when dof <= 0.
	readonly reducedChi2: number
	// RMS total angular residual, radians.
	readonly rms: Angle
	// Number of accepted iterations performed.
	readonly iterations: number
	// True if the loop reached a convergence criterion.
	readonly converged: boolean
}

// OrbitFitOptions with all fields resolved to concrete values.
interface ResolvedOrbitFitOptions {
	readonly mu: number
	readonly defaultRaErr: Angle
	readonly defaultDecErr: Angle
	readonly maxIterations: number
	readonly tolerance: number
	readonly parameterTolerance: number
	readonly gradientTolerance: number
	readonly initialDamping: number
	readonly minTopocentricDistance: number
	readonly finiteDifferencePositionStep: number
	readonly finiteDifferenceVelocityStep: number
	readonly relativeFiniteDifferenceStep: number
	readonly maxFiniteDifferenceStep: number
	readonly computeCovariance: boolean
	readonly rejectInvalidSteps: boolean
}

// Internal bundle returned by evaluateResiduals: the candidate orbit plus its residuals and chi2.
interface ResidualEvaluation {
	readonly orbit: KeplerOrbit
	readonly state: OrbitFitCartesianState
	// Residuals in sigma units, ordered [RA0, Dec0, RA1, Dec1, ...].
	readonly normalized: Float64Array
	readonly angular: readonly OrbitFitAngularResidual[]
	readonly chi2: number
}

// Fits a Cartesian two-body state to weighted astrometric RA/Dec observations by Levenberg-Marquardt
// differential correction, starting from the given `epoch` state guess. Requires at least 3
// observations (6 parameters). Returns the refined state, derived orbit, residuals, fit statistics,
// and optional covariance. Throws if the initial or final state cannot be evaluated.
export function fitOrbit(observations: readonly OrbitFitObservation[], epoch: Time, position: Vec3, velocity: Vec3, options?: OrbitFitOptions): OrbitFitResult {
	const config = resolveFitOptions(options)
	validateInput(observations, epoch, position, velocity, config)

	let params = stateToParams(position, velocity)
	let current = evaluateResiduals(params, observations, epoch, config)

	if (!current) {
		throw new Error('initial orbit state cannot be evaluated')
	}

	let damping = config.initialDamping
	let iterations = 0
	let converged = false
	let jacobian: Matrix | undefined

	for (let i = 0; i < config.maxIterations; i++) {
		jacobian = numericalJacobian((candidate) => evaluateNormalizedResiduals(candidate, observations, epoch, config), params, current.normalized, config)

		if (jacobian === undefined) {
			break
		}

		const normal = normalEquations(jacobian, current.normalized)
		const gradientNorm = maxAbs(normal.gradient)

		if (gradientNorm <= config.gradientTolerance) {
			converged = true
			break
		}

		let accepted = false

		for (let attempt = 0; attempt < MAX_DAMPING_ATTEMPTS; attempt++) {
			const step = solveLevenbergMarquardtStep(normal.jtj, normal.gradient, damping)

			if (!step) {
				damping = nextDamping(damping)
				continue
			}

			const stepNorm = vecLength(step as unknown as Vec3)
			const parameterScale = vecLength(params as unknown as Vec3) + config.parameterTolerance

			if (stepNorm <= config.parameterTolerance * parameterScale) {
				converged = true
				accepted = true
				break
			}

			const candidate = addStep(params, step)
			const trial = evaluateResiduals(candidate, observations, epoch, config)

			if (trial && trial.chi2 < current.chi2) {
				const improvement = current.chi2 - trial.chi2
				params = candidate
				current = trial
				damping = Math.max(MIN_DAMPING, damping / 3)
				iterations = i + 1
				accepted = true

				if (improvement <= config.tolerance * (current.chi2 + config.tolerance)) {
					converged = true
				}

				break
			}

			if (!trial && !config.rejectInvalidSteps) break

			damping = nextDamping(damping)
		}

		if (converged) {
			if (iterations === 0) iterations = i + 1
			break
		}

		if (!accepted) {
			iterations = i + 1
			break
		}
	}

	const finalEvaluation = evaluateResiduals(params, observations, epoch, config)

	if (!finalEvaluation) {
		throw new Error('final orbit state cannot be evaluated')
	}

	const chi2 = finalEvaluation.chi2
	const dof = observations.length * 2 - PARAMETER_COUNT
	const reducedChi2 = dof > 0 ? chi2 / dof : Number.NaN
	const rms = angularRms(finalEvaluation.angular)
	const finalJacobian = config.computeCovariance ? numericalJacobian((candidate) => evaluateNormalizedResiduals(candidate, observations, epoch, config), params, finalEvaluation.normalized, config) : undefined
	const covariance = finalJacobian ? covarianceFromJacobian(finalJacobian, reducedChi2) : undefined

	assertFiniteMetric(chi2, 'chi2')
	assertFiniteMetric(rms, 'rms')

	return {
		state: finalEvaluation.state,
		orbit: finalEvaluation.orbit,
		covariance,
		residuals: {
			normalized: Array.from(finalEvaluation.normalized),
			angular: finalEvaluation.angular,
		},
		chi2,
		reducedChi2,
		rms,
		iterations,
		converged,
	}
}

function resolveFitOptions(options: OrbitFitOptions | undefined): ResolvedOrbitFitOptions {
	// One arcsecond is a conservative default when callers do not provide astrometric uncertainties.
	const defaultRaErr = options?.defaultRaErr ?? ASEC2RAD
	const defaultDecErr = options?.defaultDecErr ?? ASEC2RAD

	return {
		mu: options?.mu ?? GM_SUN_PITJEVA_2005,
		defaultRaErr,
		defaultDecErr,
		maxIterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
		tolerance: options?.tolerance ?? DEFAULT_TOLERANCE,
		parameterTolerance: options?.parameterTolerance ?? DEFAULT_PARAMETER_TOLERANCE,
		gradientTolerance: options?.gradientTolerance ?? DEFAULT_GRADIENT_TOLERANCE,
		initialDamping: options?.initialDamping ?? DEFAULT_INITIAL_DAMPING,
		minTopocentricDistance: options?.minTopocentricDistance ?? DEFAULT_MIN_TOPOCENTRIC_DISTANCE,
		finiteDifferencePositionStep: options?.finiteDifferencePositionStep ?? DEFAULT_POSITION_STEP,
		finiteDifferenceVelocityStep: options?.finiteDifferenceVelocityStep ?? DEFAULT_VELOCITY_STEP,
		relativeFiniteDifferenceStep: options?.relativeFiniteDifferenceStep ?? DEFAULT_RELATIVE_STEP,
		maxFiniteDifferenceStep: options?.maxFiniteDifferenceStep ?? DEFAULT_MAX_STEP,
		computeCovariance: options?.computeCovariance !== false,
		rejectInvalidSteps: options?.rejectInvalidSteps ?? true,
	}
}

function validateInput(observations: readonly OrbitFitObservation[], epoch: Time, p: Vec3, v: Vec3, options: ResolvedOrbitFitOptions) {
	if (observations.length < 3) throw new Error('at least 3 observations are required to fit 6 Cartesian parameters')

	validateTime(epoch)
	validateVector(p)
	validateVector(v)
	validatePositiveFinite(options.mu)
	validatePositiveFinite(options.defaultRaErr)
	validatePositiveFinite(options.defaultDecErr)
	validateNonNegativeFinite(options.maxIterations)
	validatePositiveFinite(options.tolerance)
	validatePositiveFinite(options.parameterTolerance)
	validatePositiveFinite(options.gradientTolerance)
	validatePositiveFinite(options.initialDamping)
	validatePositiveFinite(options.minTopocentricDistance)
	validatePositiveFinite(options.finiteDifferencePositionStep)
	validatePositiveFinite(options.finiteDifferenceVelocityStep)
	validatePositiveFinite(options.relativeFiniteDifferenceStep)
	validatePositiveFinite(options.maxFiniteDifferenceStep)

	for (let i = 0; i < observations.length; i++) {
		const observation = observations[i]
		validateTime(observation.time)
		validateFinite(observation.rightAscension)
		validateFinite(observation.declination)
		validateVector(observation.observerPosition)

		if (observation.raErr !== undefined) validatePositiveFinite(observation.raErr)
		if (observation.decErr !== undefined) validatePositiveFinite(observation.decErr)
	}
}

// Packs a position/velocity pair into the 6-element parameter vector.
function stateToParams(position: CartesianCoordinate, velocity: CartesianCoordinate): Float64Array {
	return Float64Array.of(position[0], position[1], position[2], velocity[0], velocity[1], velocity[2])
}

// Unpacks the parameter vector back into a Cartesian state; undefined if not finite/sized.
function paramsToState(params: Readonly<Float64Array>, epoch: Time): OrbitFitCartesianState | undefined {
	if (params.length !== PARAMETER_COUNT || !allFinite(params)) return undefined

	const position: MutVec3 = [params[0], params[1], params[2]]
	const velocity: MutVec3 = [params[3], params[4], params[5]]

	return { epoch, position, velocity }
}

// Propagates the candidate state to each observation, forms the cos(dec)-weighted RA/Dec residuals,
// and accumulates chi-squared. Returns undefined if the orbit or any model position is non-finite.
function evaluateResiduals(params: Readonly<Float64Array>, observations: readonly OrbitFitObservation[], epoch: Time, options: ResolvedOrbitFitOptions): ResidualEvaluation | undefined {
	const state = paramsToState(params, epoch)

	if (!state) return undefined

	let orbit: KeplerOrbit

	try {
		orbit = new KeplerOrbit(state.position, state.velocity, epoch, options.mu, IDENTITY_ROTATION)
	} catch {
		return undefined
	}

	const angular = new Array<OrbitFitAngularResidual>(observations.length)
	const normalized = new Float64Array(observations.length * 2)
	let chi2 = 0

	for (let i = 0; i < observations.length; i++) {
		const observation = observations[i]
		const model = computeModelRaDec(orbit, observation, options.minTopocentricDistance)

		if (!model) return undefined

		const dRA = normalizePI(observation.rightAscension - model.rightAscension) * Math.cos(observation.declination)
		const dDEC = observation.declination - model.declination
		const total = Math.hypot(dRA, dDEC)

		if (!Number.isFinite(total)) return undefined

		const raErr = observation.raErr ?? options.defaultRaErr
		const decErr = observation.decErr ?? options.defaultDecErr
		const rRa = dRA / raErr
		const rDec = dDEC / decErr
		const offset = i * 2

		if (!Number.isFinite(rRa) || !Number.isFinite(rDec)) return undefined

		normalized[offset] = rRa
		normalized[offset + 1] = rDec
		angular[i] = { time: observation.time, dRA, dDEC, total }
		chi2 += rRa * rRa + rDec * rDec
	}

	if (!Number.isFinite(chi2)) return undefined

	return { orbit, state, normalized, angular, chi2 }
}

function evaluateNormalizedResiduals(params: Readonly<Float64Array>, observations: readonly OrbitFitObservation[], epoch: Time, options: ResolvedOrbitFitOptions) {
	return evaluateResiduals(params, observations, epoch, options)?.normalized
}

// Computes the modeled topocentric RA/Dec (radians) and range for one observation by propagating the
// orbit and subtracting the observer position. Returns undefined if the geometry is degenerate.
function computeModelRaDec(orbit: KeplerOrbit, observation: OrbitFitObservation, minTopocentricDistance: number) {
	let position: Vec3

	try {
		position = orbit.at(observation.time)[0]
	} catch {
		return undefined
	}

	if (!isFiniteVector(position)) return undefined

	const x = position[0] - observation.observerPosition[0]
	const y = position[1] - observation.observerPosition[1]
	const z = position[2] - observation.observerPosition[2]
	const range = Math.hypot(x, y, z)

	if (!Number.isFinite(range) || range < minTopocentricDistance) return undefined

	return { rightAscension: normalizeAngle(Math.atan2(y, x)), declination: Math.asin(clamp(z / range, -1, 1)), range } as const
}

// Builds the residual Jacobian by central finite differences, falling back to one-sided differences
// when a perturbed state fails to evaluate. Returns undefined if any column cannot be formed.
function numericalJacobian(f: (params: Readonly<Float64Array>) => Float64Array | undefined, params: Readonly<Float64Array>, baseResiduals: Readonly<Float64Array>, options: ResolvedOrbitFitOptions) {
	const rows = baseResiduals.length
	const jacobian = new Matrix(rows, PARAMETER_COUNT)
	const data = jacobian.data

	for (let col = 0; col < PARAMETER_COUNT; col++) {
		const step = finiteDifferenceStep(params[col], col, options)

		if (!Number.isFinite(step) || params[col] + step === params[col]) {
			return undefined
		}

		const plusParams = new Float64Array(params)
		const minusParams = new Float64Array(params)

		plusParams[col] += step
		minusParams[col] -= step

		const plus = f(plusParams)
		const minus = f(minusParams)

		if (plus !== undefined && minus !== undefined) {
			for (let row = 0; row < rows; row++) {
				const value = (plus[row] - minus[row]) / (2 * step)
				if (!Number.isFinite(value)) return undefined
				data[row * PARAMETER_COUNT + col] = value
			}
		} else if (plus !== undefined) {
			for (let row = 0; row < rows; row++) {
				const value = (plus[row] - baseResiduals[row]) / step
				if (!Number.isFinite(value)) return undefined
				data[row * PARAMETER_COUNT + col] = value
			}
		} else if (minus !== undefined) {
			for (let row = 0; row < rows; row++) {
				const value = (baseResiduals[row] - minus[row]) / step
				if (!Number.isFinite(value)) return undefined
				data[row * PARAMETER_COUNT + col] = value
			}
		} else {
			return undefined
		}
	}

	return jacobian
}

// Chooses the finite-difference step for parameter `index`: the larger of the absolute (position vs
// velocity) and relative steps, clamped to the configured maximum.
function finiteDifferenceStep(value: number, index: number, options: ResolvedOrbitFitOptions) {
	const absolute = index < 3 ? options.finiteDifferencePositionStep : options.finiteDifferenceVelocityStep
	const relative = Math.abs(value) * options.relativeFiniteDifferenceStep
	return Math.min(Math.max(relative, absolute), options.maxFiniteDifferenceStep)
}

// Forms the normal-equation matrix J^T J and gradient J^T r from the Jacobian and residuals.
function normalEquations(jacobian: Matrix, residuals: Readonly<Float64Array>): { jtj: Float64Array; gradient: Float64Array } {
	const rows = jacobian.rows
	const data = jacobian.data
	const jtj = new Float64Array(PARAMETER_COUNT * PARAMETER_COUNT)
	const gradient = new Float64Array(PARAMETER_COUNT)

	for (let row = 0; row < rows; row++) {
		const rowOffset = row * PARAMETER_COUNT
		const residual = residuals[row]

		for (let col = 0; col < PARAMETER_COUNT; col++) {
			const jCol = data[rowOffset + col]
			gradient[col] += jCol * residual

			for (let k = 0; k <= col; k++) {
				jtj[col * PARAMETER_COUNT + k] += jCol * data[rowOffset + k]
			}
		}
	}

	for (let row = 0; row < PARAMETER_COUNT; row++) {
		for (let col = row + 1; col < PARAMETER_COUNT; col++) {
			jtj[row * PARAMETER_COUNT + col] = jtj[col * PARAMETER_COUNT + row]
		}
	}

	return { jtj, gradient }
}

// Solves the damped normal equations (J^T J + lambda*diag) dx = -gradient for the LM step; undefined
// if the damped matrix is not positive definite.
function solveLevenbergMarquardtStep(jtj: Readonly<Float64Array>, gradient: Readonly<Float64Array>, damping: number) {
	const lhs = new Float64Array(jtj)
	const rhs = new Float64Array(PARAMETER_COUNT)

	for (let i = 0; i < PARAMETER_COUNT; i++) {
		const diagonalIndex = i * PARAMETER_COUNT + i
		const diagonal = Math.abs(jtj[diagonalIndex])
		lhs[diagonalIndex] += damping * (diagonal > 0 ? diagonal : 1)
		rhs[i] = -gradient[i]
	}

	return choleskySolve(lhs, rhs)
}

// Solves A x = b for a symmetric positive-definite A via Cholesky factorization; undefined if A is not SPD.
function choleskySolve(a: Readonly<Float64Array>, b: Readonly<Float64Array>) {
	const lower = choleskyDecompose(a)

	if (!lower) return undefined

	const y = new Float64Array(PARAMETER_COUNT)

	for (let i = 0; i < PARAMETER_COUNT; i++) {
		let sum = b[i]

		for (let k = 0; k < i; k++) {
			sum -= lower[i * PARAMETER_COUNT + k] * y[k]
		}

		y[i] = sum / lower[i * PARAMETER_COUNT + i]
	}

	const x = new Float64Array(PARAMETER_COUNT)

	for (let i = PARAMETER_COUNT - 1; i >= 0; i--) {
		let sum = y[i]

		for (let k = i + 1; k < PARAMETER_COUNT; k++) {
			sum -= lower[k * PARAMETER_COUNT + i] * x[k]
		}

		x[i] = sum / lower[i * PARAMETER_COUNT + i]

		if (!Number.isFinite(x[i])) return undefined
	}

	return x
}

// Cholesky factorization A = L L^T of the row-major PARAMETER_COUNT^2 matrix; undefined if not SPD
// (pivot at or below a scaled tolerance). Returns the lower factor L stored row-major.
function choleskyDecompose(a: Readonly<Float64Array>) {
	const lower = new Float64Array(PARAMETER_COUNT * PARAMETER_COUNT)
	let maxDiagonal = 0

	for (let i = 0; i < PARAMETER_COUNT; i++) {
		maxDiagonal = Math.max(maxDiagonal, Math.abs(a[i * PARAMETER_COUNT + i]))
	}

	const pivotTolerance = Math.max(Number.EPSILON * maxDiagonal * PARAMETER_COUNT, Number.MIN_VALUE)

	for (let i = 0; i < PARAMETER_COUNT; i++) {
		for (let j = 0; j <= i; j++) {
			let sum = a[i * PARAMETER_COUNT + j]

			for (let k = 0; k < j; k++) {
				sum -= lower[i * PARAMETER_COUNT + k] * lower[j * PARAMETER_COUNT + k]
			}

			if (i === j) {
				if (!Number.isFinite(sum) || sum <= pivotTolerance) return undefined
				lower[i * PARAMETER_COUNT + j] = Math.sqrt(sum)
			} else {
				const value = sum / lower[j * PARAMETER_COUNT + j]
				if (!Number.isFinite(value)) return undefined
				lower[i * PARAMETER_COUNT + j] = value
			}
		}
	}

	return lower
}

// Forms the parameter covariance as reducedChi2 * (J^T J)^-1 by inverting via the Cholesky factor,
// one column at a time. Returns undefined when the system is ill-conditioned beyond the limit.
function covarianceFromJacobian(jacobian: Matrix, reducedChi2: number) {
	if (!Number.isFinite(reducedChi2)) return undefined

	const { jtj } = normalEquations(jacobian, new Float64Array(jacobian.rows))
	const lower = choleskyDecompose(jtj)

	if (!lower || choleskyCondition(lower) > COVARIANCE_CONDITION_LIMIT) return undefined

	const covariance = new Matrix(PARAMETER_COUNT, PARAMETER_COUNT)
	const data = covariance.data

	for (let col = 0; col < PARAMETER_COUNT; col++) {
		const rhs = new Float64Array(PARAMETER_COUNT)
		rhs[col] = 1
		const solution = choleskySolveFromFactor(lower, rhs)

		if (!solution) return undefined

		for (let row = 0; row < PARAMETER_COUNT; row++) {
			const value = solution[row] * reducedChi2
			if (!Number.isFinite(value)) return undefined
			data[row * PARAMETER_COUNT + col] = value
		}
	}

	symmetrize(covariance)
	return covariance
}

// Solves L L^T x = b from a precomputed lower Cholesky factor (forward then back substitution).
function choleskySolveFromFactor(lower: Readonly<Float64Array>, b: Readonly<Float64Array>) {
	const y = new Float64Array(PARAMETER_COUNT)

	for (let i = 0; i < PARAMETER_COUNT; i++) {
		let sum = b[i]

		for (let k = 0; k < i; k++) {
			sum -= lower[i * PARAMETER_COUNT + k] * y[k]
		}

		y[i] = sum / lower[i * PARAMETER_COUNT + i]
	}

	const x = new Float64Array(PARAMETER_COUNT)

	for (let i = PARAMETER_COUNT - 1; i >= 0; i--) {
		let sum = y[i]

		for (let k = i + 1; k < PARAMETER_COUNT; k++) {
			sum -= lower[k * PARAMETER_COUNT + i] * x[k]
		}

		x[i] = sum / lower[i * PARAMETER_COUNT + i]

		if (!Number.isFinite(x[i])) return undefined
	}

	return x
}

// Estimates the squared condition number from the ratio of largest to smallest Cholesky diagonal.
function choleskyCondition(lower: Readonly<Float64Array>) {
	let min = Number.POSITIVE_INFINITY
	let max = 0

	for (let i = 0; i < PARAMETER_COUNT; i++) {
		const value = lower[i * PARAMETER_COUNT + i]
		min = Math.min(min, value)
		max = Math.max(max, value)
	}

	return min > 0 ? (max / min) ** 2 : Number.POSITIVE_INFINITY
}

// Averages each off-diagonal pair in place to enforce exact symmetry of the covariance matrix.
function symmetrize(matrix: Matrix) {
	for (let row = 0; row < PARAMETER_COUNT; row++) {
		for (let col = row + 1; col < PARAMETER_COUNT; col++) {
			const value = (matrix.get(row, col) + matrix.get(col, row)) / 2
			matrix.set(row, col, value)
			matrix.set(col, row, value)
		}
	}
}

// Returns params + step as a new parameter vector.
function addStep(params: Readonly<Float64Array>, step: Readonly<Float64Array>) {
	const candidate = new Float64Array(PARAMETER_COUNT)
	for (let i = 0; i < PARAMETER_COUNT; i++) candidate[i] = params[i] + step[i]
	return candidate
}

// Increases the damping factor (x10), clamped to the maximum, after a rejected step.
function nextDamping(damping: number) {
	return Math.min(MAX_DAMPING, damping * 10)
}

// Root-mean-square of the total angular residuals (radians).
function angularRms(residuals: readonly OrbitFitAngularResidual[]) {
	let sum = 0
	for (let i = 0; i < residuals.length; i++) sum += residuals[i].total * residuals[i].total
	return Math.sqrt(sum / residuals.length)
}

function maxAbs(vector: Readonly<Float64Array>) {
	let max = 0
	for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]))
	return max
}

function isFiniteVector(vector: Vec3) {
	return Number.isFinite(vector[0]) && Number.isFinite(vector[1]) && Number.isFinite(vector[2]) && Number.isFinite(vecLength(vector))
}

function allFinite(values: Readonly<Float64Array>) {
	for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false
	return true
}

function assertFiniteMetric(value: number, name: string) {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${name} must be finite`)
	}
}
