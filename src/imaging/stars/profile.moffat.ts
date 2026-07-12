import { gaussianElimination, Matrix } from '../../math/linear-algebra/matrix'
import type { Angle } from '../../math/units/angle'
import type { Image } from '../model/types'

// Elliptical single-component Moffat fitting for grayscale star-profile apertures. The solver samples
// pixel centers, uses an analytic Jacobian, reuses fixed-size work buffers, and never mutates images.

// Number of transformed parameters in the single-component elliptical Moffat model.
const PARAMETER_COUNT = 8
// Default Moffat wing exponent used to initialize the nonlinear fit.
const INITIAL_BETA = 2.5
// Smallest accepted Moffat wing exponent; beta must exceed one for finite continuous flux.
const MIN_BETA = 1.05
// Largest accepted exponent before the model becomes numerically indistinguishable from a Gaussian.
const MAX_BETA = 20
// Smallest accepted Moffat alpha axis, in pixels.
const MIN_ALPHA = 0.25
// Maximum number of damped nonlinear least-squares steps.
const MAX_ITERATIONS = 60
// Relative weighted-error improvement considered converged.
const CONVERGENCE_TOLERANCE = 1e-8
// Largest damping value attempted before reporting a singular fit.
const MAX_DAMPING = 1e12
// Maximum RMS relative to the fitted peak accepted as a useful one-component fit.
const MAX_RELATIVE_RMS = 0.35
// Minimum fitted eccentricity that gives the major-axis direction physical meaning.
const MIN_ORIENTATION_ECCENTRICITY = 0.05

// Explains why an explicitly requested Moffat fit fell back to moment measurements.
export type MoffatFitFailureReason = 'invalidInput' | 'singular' | 'notConverged' | 'nonFinite' | 'poorResidual'

// Reports a successful elliptical Moffat fit in image sample and pixel units.
export interface SuccessfulMoffatProfileFit {
	// Discriminates a converged and accepted fit.
	readonly success: true
	// Fitted constant background in image sample units.
	readonly background: number
	// Fitted central signal amplitude above background in image sample units.
	readonly amplitude: number
	// Fitted subpixel center X coordinate.
	readonly centerX: number
	// Fitted subpixel center Y coordinate.
	readonly centerY: number
	// Moffat alpha along the major axis, in pixels.
	readonly alphaMajor: number
	// Moffat alpha along the minor axis, in pixels.
	readonly alphaMinor: number
	// Major-axis orientation in [0, PI), clockwise in image coordinates; absent for a round fit.
	readonly theta?: Angle
	// Moffat wing exponent, greater than one.
	readonly beta: number
	// Unweighted residual RMS over finite, unsaturated aperture samples, in image sample units.
	readonly rms: number
	// Number of damped least-squares steps attempted.
	readonly iterations: number
}

// Reports a rejected Moffat fit while retaining enough diagnostics for callers to explain fallback.
export interface FailedMoffatProfileFit {
	// Discriminates a failed or rejected fit.
	readonly success: false
	// Stable failure category.
	readonly reason: MoffatFitFailureReason
	// Last finite residual RMS, in image sample units, when available.
	readonly rms?: number
	// Number of damped least-squares steps attempted.
	readonly iterations: number
}

// Discriminated result of an explicitly requested single-component elliptical Moffat fit.
export type MoffatProfileFit = SuccessfulMoffatProfileFit | FailedMoffatProfileFit

// Supplies moment-derived initialization and aperture constraints to the Moffat solver.
export interface MoffatFitInput {
	// Initial subpixel center X coordinate.
	readonly x: number
	// Initial subpixel center Y coordinate.
	readonly y: number
	// Circular fitting aperture radius, in pixels.
	readonly radius: number
	// Robust initial background in image sample units.
	readonly background: number
	// Robust background deviation in image sample units.
	readonly deviation: number
	// Brightest measured signal above background in image sample units.
	readonly peak: number
	// Moment-derived major-axis FWHM, in pixels.
	readonly major: number
	// Moment-derived minor-axis FWHM, in pixels.
	readonly minor: number
	// Moment-derived major-axis orientation in [0, PI), or zero for a round profile.
	readonly theta: number
	// Samples at or above this value are excluded from the fit.
	readonly saturationLevel: number
}

// Holds fixed-size matrices and vectors reused by consecutive fits in one profile batch.
export interface MoffatFitWorkspace {
	// Undamped normal matrix.
	readonly normal: Matrix
	// Damped working matrix consumed by Gaussian elimination.
	readonly damped: Matrix
	// Normal-equation gradient.
	readonly gradient: Float64Array
	// Working gradient consumed by Gaussian elimination.
	readonly rightHandSide: Float64Array
	// Solved parameter step.
	readonly step: Float64Array
	// Current transformed parameters.
	readonly parameters: Float64Array
	// Candidate transformed parameters.
	readonly candidate: Float64Array
	// Analytic model derivatives for one pixel.
	readonly jacobian: Float64Array
}

// Summarizes one model evaluation, optionally including its normal equations.
interface MoffatEvaluation {
	// Weighted squared error normalized by the robust local variance.
	readonly error: number
	// Unweighted squared error in image sample units squared.
	readonly squaredError: number
	// Number of finite, unsaturated samples used.
	readonly samples: number
}

// Stores parameters expanded once per model evaluation so pixel loops avoid repeated trig and exp.
interface PreparedMoffatModel {
	// Constant background in image sample units.
	readonly background: number
	// Positive central signal amplitude in image sample units.
	readonly amplitude: number
	// Subpixel center X coordinate.
	readonly centerX: number
	// Subpixel center Y coordinate.
	readonly centerY: number
	// Inverse squared alpha along the first fitted axis.
	readonly inverseAlphaX2: number
	// Inverse squared alpha along the second fitted axis.
	readonly inverseAlphaY2: number
	// Cosine of the fitted axial orientation.
	readonly cosTheta: number
	// Sine of the fitted axial orientation.
	readonly sinTheta: number
	// Positive amount by which beta exceeds one.
	readonly betaMinusOne: number
	// Moffat wing exponent.
	readonly beta: number
}

// Allocates one fixed-size workspace suitable for reuse across a batch of Moffat fits.
export function createMoffatFitWorkspace(): MoffatFitWorkspace {
	return {
		normal: Matrix.square(PARAMETER_COUNT),
		damped: Matrix.square(PARAMETER_COUNT),
		gradient: new Float64Array(PARAMETER_COUNT),
		rightHandSide: new Float64Array(PARAMETER_COUNT),
		step: new Float64Array(PARAMETER_COUNT),
		parameters: new Float64Array(PARAMETER_COUNT),
		candidate: new Float64Array(PARAMETER_COUNT),
		jacobian: new Float64Array(PARAMETER_COUNT),
	}
}

// Fits one elliptical Moffat component over a circular grayscale aperture using pixel-center samples.
export function fitEllipticalMoffat(image: Image, input: MoffatFitInput, workspace: MoffatFitWorkspace): MoffatProfileFit {
	if (!validInput(image, input)) return { success: false, reason: 'invalidInput', iterations: 0 }

	const parameters = workspace.parameters
	const fwhmScale = 2 * Math.sqrt(2 ** (1 / INITIAL_BETA) - 1)
	parameters[0] = input.background
	parameters[1] = Math.log(Math.max(input.peak, input.deviation, Number.EPSILON))
	parameters[2] = input.x
	parameters[3] = input.y
	parameters[4] = Math.log(Math.max(MIN_ALPHA, input.major / fwhmScale))
	parameters[5] = Math.log(Math.max(MIN_ALPHA, input.minor / fwhmScale))
	parameters[6] = input.theta
	parameters[7] = Math.log(INITIAL_BETA - 1)

	let evaluation = evaluateMoffat(image, input, parameters, workspace, true)
	if (!finiteEvaluation(evaluation) || evaluation.samples <= PARAMETER_COUNT) return { success: false, reason: 'invalidInput', iterations: 0 }

	let damping = 0.01
	let converged = false
	let accepted = false
	let iterations = 0

	for (; iterations < MAX_ITERATIONS; iterations++) {
		const normal = workspace.normal.data
		const damped = workspace.damped.data
		for (let i = 0; i < normal.length; i++) damped[i] = normal[i]
		for (let i = 0; i < PARAMETER_COUNT; i++) {
			const diagonal = i * PARAMETER_COUNT + i
			damped[diagonal] += damping * Math.max(Math.abs(normal[diagonal]), Number.EPSILON)
		}

		workspace.rightHandSide.set(workspace.gradient)
		gaussianElimination(workspace.damped, workspace.rightHandSide, workspace.step)
		if (!finiteVector(workspace.step)) return failureFromEvaluation('singular', evaluation, iterations + 1)

		let maximumRelativeStep = 0
		for (let i = 0; i < PARAMETER_COUNT; i++) {
			workspace.candidate[i] = parameters[i] + workspace.step[i]
			maximumRelativeStep = Math.max(maximumRelativeStep, Math.abs(workspace.step[i]) / (1 + Math.abs(parameters[i])))
		}
		workspace.candidate[6] = ((workspace.candidate[6] % Math.PI) + Math.PI) % Math.PI
		if (!validCandidate(workspace.candidate, input)) {
			damping *= 10
			if (damping > MAX_DAMPING) return failureFromEvaluation('singular', evaluation, iterations + 1)
			continue
		}

		const candidateEvaluation = evaluateMoffat(image, input, workspace.candidate, workspace, false)
		if (!finiteEvaluation(candidateEvaluation)) {
			damping *= 10
			if (damping > MAX_DAMPING) return failureFromEvaluation('nonFinite', evaluation, iterations + 1)
			continue
		}

		if (candidateEvaluation.error <= evaluation.error) {
			const relativeImprovement = (evaluation.error - candidateEvaluation.error) / Math.max(1, evaluation.error)
			parameters.set(workspace.candidate)
			evaluation = evaluateMoffat(image, input, parameters, workspace, true)
			accepted = true
			damping = Math.max(1e-12, damping * 0.2)
			if (relativeImprovement <= CONVERGENCE_TOLERANCE && maximumRelativeStep <= Math.sqrt(CONVERGENCE_TOLERANCE)) {
				converged = true
				iterations++
				break
			}
		} else {
			damping *= 10
			if (damping > MAX_DAMPING) break
		}
	}

	const rms = Math.sqrt(evaluation.squaredError / evaluation.samples)
	if (!converged || !accepted) return { success: false, reason: damping > MAX_DAMPING ? 'singular' : 'notConverged', rms: Number.isFinite(rms) ? rms : undefined, iterations }

	return publicFit(parameters, rms, iterations, input)
}

// Validates finite image geometry and moment-derived initialization before nonlinear fitting.
function validInput(image: Image, input: MoffatFitInput): boolean {
	const { width, height, stride, channels } = image.metadata
	return (
		channels === 1 &&
		width > 0 &&
		height > 0 &&
		stride >= width &&
		image.raw.length >= stride * height &&
		Number.isFinite(input.x) &&
		Number.isFinite(input.y) &&
		Number.isFinite(input.radius) &&
		input.radius > 0 &&
		Number.isFinite(input.background) &&
		Number.isFinite(input.deviation) &&
		input.deviation >= 0 &&
		Number.isFinite(input.peak) &&
		input.peak > 0 &&
		Number.isFinite(input.major) &&
		Number.isFinite(input.minor) &&
		input.major >= input.minor &&
		input.minor > 0 &&
		Number.isFinite(input.theta) &&
		Number.isFinite(input.saturationLevel)
	)
}

// Checks transformed parameter bounds without clamping a solver step into a false optimum.
function validCandidate(parameters: Readonly<Float64Array>, input: MoffatFitInput): boolean {
	if (!finiteVector(parameters)) return false
	const amplitude = Math.exp(parameters[1])
	const alphaX = Math.exp(parameters[4])
	const alphaY = Math.exp(parameters[5])
	const beta = 1 + Math.exp(parameters[7])
	const maximumAlpha = Math.max(2, input.radius * 2)
	const backgroundAllowance = Math.max(5 * input.deviation, 0.5 * input.peak, 1e-6)
	return (
		amplitude > 0 &&
		amplitude <= input.peak * 10 &&
		alphaX >= MIN_ALPHA &&
		alphaX <= maximumAlpha &&
		alphaY >= MIN_ALPHA &&
		alphaY <= maximumAlpha &&
		beta >= MIN_BETA &&
		beta <= MAX_BETA &&
		Math.abs(parameters[2] - input.x) <= input.radius * 0.5 &&
		Math.abs(parameters[3] - input.y) <= input.radius * 0.5 &&
		Math.abs(parameters[0] - input.background) <= backgroundAllowance
	)
}

// Evaluates residuals and, when requested, accumulates J-transpose-J and J-transpose-r in one pixel pass.
function evaluateMoffat(image: Image, input: MoffatFitInput, parameters: Readonly<Float64Array>, workspace: MoffatFitWorkspace, buildNormal: boolean): MoffatEvaluation {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const radiusSquared = input.radius * input.radius
	const x0 = Math.max(0, Math.ceil(input.x - input.radius))
	const x1 = Math.min(width - 1, Math.floor(input.x + input.radius))
	const y0 = Math.max(0, Math.ceil(input.y - input.radius))
	const y1 = Math.min(height - 1, Math.floor(input.y + input.radius))
	const inverseVariance = 1 / Math.max(input.deviation * input.deviation, 1e-12)
	const model = prepareMoffatModel(parameters)
	const normal = workspace.normal.data
	const gradient = workspace.gradient
	if (buildNormal) {
		normal.fill(0)
		gradient.fill(0)
	}

	let error = 0
	let squaredError = 0
	let samples = 0
	for (let py = y0; py <= y1; py++) {
		const roiDy = py - input.y
		const row = py * stride
		for (let px = x0; px <= x1; px++) {
			const roiDx = px - input.x
			if (roiDx * roiDx + roiDy * roiDy > radiusSquared) continue
			const observed = raw[row + px]
			if (!Number.isFinite(observed) || observed >= input.saturationLevel) continue
			const predicted = moffatValueAndJacobian(px, py, model, buildNormal ? workspace.jacobian : undefined)
			if (!Number.isFinite(predicted)) return { error: Number.NaN, squaredError: Number.NaN, samples }
			const residual = observed - predicted
			const weightedResidual = inverseVariance * residual
			error += weightedResidual * residual
			squaredError += residual * residual
			samples++
			if (!buildNormal) continue

			const jacobian = workspace.jacobian
			for (let i = 0; i < PARAMETER_COUNT; i++) {
				const ji = jacobian[i]
				gradient[i] += ji * weightedResidual
				const rowOffset = i * PARAMETER_COUNT
				for (let j = i; j < PARAMETER_COUNT; j++) normal[rowOffset + j] += inverseVariance * ji * jacobian[j]
			}
		}
	}

	if (buildNormal) {
		for (let i = 0; i < PARAMETER_COUNT; i++) {
			for (let j = i + 1; j < PARAMETER_COUNT; j++) normal[j * PARAMETER_COUNT + i] = normal[i * PARAMETER_COUNT + j]
		}
	}
	return { error, squaredError, samples }
}

// Expands transformed fit parameters once before evaluating an aperture.
function prepareMoffatModel(parameters: Readonly<Float64Array>): PreparedMoffatModel {
	const theta = parameters[6]
	const betaMinusOne = Math.exp(parameters[7])
	return {
		background: parameters[0],
		amplitude: Math.exp(parameters[1]),
		centerX: parameters[2],
		centerY: parameters[3],
		inverseAlphaX2: Math.exp(-2 * parameters[4]),
		inverseAlphaY2: Math.exp(-2 * parameters[5]),
		cosTheta: Math.cos(theta),
		sinTheta: Math.sin(theta),
		betaMinusOne,
		beta: 1 + betaMinusOne,
	}
}

// Evaluates the pixel-center Moffat model and its analytic derivatives in transformed parameters.
function moffatValueAndJacobian(x: number, y: number, model: PreparedMoffatModel, jacobian?: Float64Array): number {
	const dx = x - model.centerX
	const dy = y - model.centerY
	const majorCoordinate = model.cosTheta * dx + model.sinTheta * dy
	const minorCoordinate = -model.sinTheta * dx + model.cosTheta * dy
	const majorTerm = majorCoordinate * majorCoordinate * model.inverseAlphaX2
	const minorTerm = minorCoordinate * minorCoordinate * model.inverseAlphaY2
	const denominator = 1 + majorTerm + minorTerm
	const signal = model.amplitude * Math.exp(-model.beta * Math.log(denominator))

	if (jacobian !== undefined) {
		const common = (signal * model.beta) / denominator
		const derivativeX = 2 * (model.cosTheta * majorCoordinate * model.inverseAlphaX2 - model.sinTheta * minorCoordinate * model.inverseAlphaY2)
		const derivativeY = 2 * (model.sinTheta * majorCoordinate * model.inverseAlphaX2 + model.cosTheta * minorCoordinate * model.inverseAlphaY2)
		jacobian[0] = 1
		jacobian[1] = signal
		jacobian[2] = common * derivativeX
		jacobian[3] = common * derivativeY
		jacobian[4] = 2 * common * majorTerm
		jacobian[5] = 2 * common * minorTerm
		jacobian[6] = -common * 2 * majorCoordinate * minorCoordinate * (model.inverseAlphaX2 - model.inverseAlphaY2)
		jacobian[7] = -signal * Math.log(denominator) * model.betaMinusOne
	}

	return model.background + signal
}

// Converts transformed solver parameters into a normalized, physically meaningful public result.
function publicFit(parameters: Readonly<Float64Array>, rms: number, iterations: number, input: MoffatFitInput): MoffatProfileFit {
	const background = parameters[0]
	const amplitude = Math.exp(parameters[1])
	let alphaMajor = Math.exp(parameters[4])
	let alphaMinor = Math.exp(parameters[5])
	let theta = parameters[6]
	const beta = 1 + Math.exp(parameters[7])
	if (alphaMajor < alphaMinor) {
		const temporary = alphaMajor
		alphaMajor = alphaMinor
		alphaMinor = temporary
		theta += Math.PI / 2
	}
	theta = ((theta % Math.PI) + Math.PI) % Math.PI
	const axisRatio = alphaMinor / alphaMajor
	const eccentricity = Math.sqrt(Math.max(0, 1 - axisRatio * axisRatio))
	const relativeRms = rms / Math.max(amplitude, input.deviation, Number.EPSILON)
	if (!Number.isFinite(background) || !Number.isFinite(amplitude) || !Number.isFinite(alphaMajor) || !Number.isFinite(alphaMinor) || !Number.isFinite(beta) || !Number.isFinite(rms)) return { success: false, reason: 'nonFinite', iterations }
	if (relativeRms > MAX_RELATIVE_RMS || alphaMajor >= input.radius * 1.8 || beta >= MAX_BETA * 0.95) return { success: false, reason: 'poorResidual', rms, iterations }

	return {
		success: true,
		background,
		amplitude,
		centerX: parameters[2],
		centerY: parameters[3],
		alphaMajor,
		alphaMinor,
		theta: eccentricity >= MIN_ORIENTATION_ECCENTRICITY ? theta : undefined,
		beta,
		rms,
		iterations,
	}
}

// Checks that every vector element is finite before it reaches model evaluation or public output.
function finiteVector(values: Readonly<Float64Array>): boolean {
	for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false
	return true
}

// Checks that an evaluation has finite errors and at least one usable sample.
function finiteEvaluation(evaluation: MoffatEvaluation): boolean {
	return evaluation.samples > 0 && Number.isFinite(evaluation.error) && Number.isFinite(evaluation.squaredError)
}

// Builds a failed result while preserving the last finite RMS when possible.
function failureFromEvaluation(reason: MoffatFitFailureReason, evaluation: MoffatEvaluation, iterations: number): FailedMoffatProfileFit {
	const rms = evaluation.samples > 0 ? Math.sqrt(evaluation.squaredError / evaluation.samples) : undefined
	return { success: false, reason, rms: rms !== undefined && Number.isFinite(rms) ? rms : undefined, iterations }
}
