import { PI } from '../../core/constants'
import { normalizeAngle, type Angle } from '../units/angle'
import type { Point } from './geometry'
import { robustLinearLeastSquares } from './least.squares'
import type { NumberArray } from './math'

// Robust fitting of normalized two-dimensional focus surfaces for imaging analyses.

// Supported focus-surface parameterizations in normalized sensor coordinates.
export type FocusSurfaceModel = 'plane' | 'radialQuadratic' | 'quadratic'

// Stable reason why a focus-surface fit was not published.
export type FocusSurfaceFitFailureReason = 'insufficientSamples' | 'invalidInput' | 'rankDeficient' | 'illConditioned' | 'nonConvergent' | 'excessiveRejection'

// Non-fatal condition that limits interpretation of an otherwise valid surface fit.
export type FocusSurfaceFitWarningCode = 'robustOutliers' | 'uncertaintyUnavailable'

// Carries a non-fatal fit condition and its optional numeric context.
export interface FocusSurfaceFitWarning {
	// Stable machine-readable warning identifier.
	readonly code: FocusSurfaceFitWarningCode
	// Optional finite quantities describing the warning.
	readonly values?: Readonly<Record<string, number>>
}

// One measured best-focus sample at normalized sensor coordinates.
export interface FocusSurfaceSample {
	// Normalized sensor X coordinate in -0.5..0.5.
	readonly u: number
	// Normalized sensor Y coordinate in -0.5..0.5, increasing downward.
	readonly v: number
	// Best-focus position in the caller's focus-position unit.
	readonly focus: number
	// Optional positive relative statistical weight.
	readonly weight?: number
	// Optional positive focus uncertainty in the same unit as `focus`.
	readonly uncertainty?: number
	// Optional source identity preserved by callers across fitting stages.
	readonly sourceIndex?: number
}

// Configures robust focus-surface fitting and acceptance criteria.
export interface FocusSurfaceFitOptions {
	// Surface model; the general quadratic is the default.
	readonly model?: FocusSurfaceModel
	// Positive Tukey residual-scale tuning threshold; defaults to 4.685.
	readonly sigmaClip?: number
	// Maximum IRLS iterations.
	readonly maxIterations?: number
	// Minimum supported samples, never lower than the selected model parameter count.
	readonly minimumSamples?: number
	// Largest accepted weighted design condition number.
	readonly maxConditionNumber?: number
}

// Coefficients of z(u, v) = c + ax*u + ay*v + qxx*u*u + qxy*u*v + qyy*v*v.
export interface FocusSurfaceCoefficients {
	// Focus offset at the normalized sensor center.
	readonly c: number
	// Focus gradient along normalized sensor X.
	readonly ax: number
	// Focus gradient along normalized sensor Y.
	readonly ay: number
	// Quadratic X coefficient.
	readonly qxx: number
	// Mixed normalized-coordinate coefficient.
	readonly qxy: number
	// Quadratic Y coefficient.
	readonly qyy: number
}

// Describes the planar component of a focus surface over the normalized sensor.
export interface FocusPlaneAnalysis {
	// Focus gradient along normalized sensor X.
	readonly gradientX: number
	// Focus gradient along normalized sensor Y, increasing downward in image coordinates.
	readonly gradientY: number
	// Direction of increasing best-focus position in [0, TAU), when non-zero.
	readonly direction?: Angle
	// Peak-to-peak planar focus change across the four normalized sensor corners.
	readonly effect: number
}

// Describes the quadratic curvature component of a focus surface over the normalized sensor.
export interface FocusCurvatureAnalysis {
	// Stationary point of the full surface when the quadratic Hessian is numerically invertible.
	readonly stationaryPoint?: Readonly<Point>
	// Larger principal Hessian eigenvalue in focus-position units per normalized-coordinate squared.
	readonly principalX: number
	// Smaller principal Hessian eigenvalue in focus-position units per normalized-coordinate squared.
	readonly principalY: number
	// Axial direction of `principalX` in [0, PI), when the principal curvatures differ.
	readonly orientation?: Angle
	// Relative separation of the principal curvatures, bounded to 0..1 when finite.
	readonly anisotropy?: number
	// Mean corner focus minus center focus due to curvature alone.
	readonly centerToEdge: number
	// Peak-to-peak curvature-only focus change over center and normalized sensor corners.
	readonly effect: number
}

// Published result for a full-rank, conditioned, finite focus-surface fit.
export interface FocusSurfaceFitSuccess {
	// Discriminates successful fits.
	readonly success: true
	// Surface model used for this fit.
	readonly model: FocusSurfaceModel
	// Coefficients converted to the common six-coefficient representation.
	readonly coefficients: FocusSurfaceCoefficients
	// Input samples in their original order.
	readonly samples: readonly FocusSurfaceSample[]
	// Whether each input sample retained sufficient final robust weight.
	readonly used: readonly boolean[]
	// Focus-minus-prediction residuals in the input order and focus unit.
	readonly residuals: Float64Array
	// Coefficient covariance in the selected model's design-column order, when estimable.
	readonly covariance?: Float64Array
	// Number of robustly used samples minus model parameter count.
	readonly degreesOfFreedom: number
	// Original input indexes rejected by robust weighting.
	readonly rejectedIndices: readonly number[]
	// Unweighted RMS residual over robustly used samples in focus units.
	readonly rms: number
	// Condition number of the final weighted design matrix.
	readonly conditionNumber: number
	// Bounded support and conditioning confidence.
	readonly confidence: number
	// Non-fatal limitations of the published result.
	readonly warnings: readonly FocusSurfaceFitWarning[]
}

// Published result when no reliable surface can be fit to the supplied samples.
export interface FocusSurfaceFitFailure {
	// Discriminates failed fits.
	readonly success: false
	// Requested surface model.
	readonly model: FocusSurfaceModel
	// Input samples in their original order.
	readonly samples: readonly FocusSurfaceSample[]
	// Per-input support flags; invalid or rejected fits expose no usable surface samples.
	readonly used: readonly boolean[]
	// Stable cause of the failed fit.
	readonly reason: FocusSurfaceFitFailureReason
	// Final weighted design condition number when the solver produced one.
	readonly conditionNumber?: number
	// Non-fatal context collected before the terminal failure.
	readonly warnings: readonly FocusSurfaceFitWarning[]
}

// Discriminated result of robust focus-surface fitting.
export type FocusSurfaceFitResult = FocusSurfaceFitSuccess | FocusSurfaceFitFailure

// Default Tukey tuning constant in robust residual-scale units.
const DEFAULT_SIGMA_CLIP = 4.685
// Default cap on IRLS refinement passes.
const DEFAULT_MAX_ITERATIONS = 20
// Default maximum weighted-design condition number accepted for publication.
const DEFAULT_MAXIMUM_CONDITION_NUMBER = 1e10
// Final relative weight below which a robustly downweighted sample is rejected.
const MINIMUM_RETAINED_WEIGHT = 1e-3

// Fits a robust plane or quadratic focus surface over normalized sensor coordinates.
export function fitFocusSurface(samples: readonly FocusSurfaceSample[], options: FocusSurfaceFitOptions = {}): FocusSurfaceFitResult {
	const model = options.model ?? 'quadratic'
	const parameterCount = modelParameterCount(model)
	const minimumSamples = Math.max(parameterCount, positiveInteger(options.minimumSamples, parameterCount))
	const emptyUsed = new Array<boolean>(samples.length).fill(false)

	if (!validSamples(samples)) return failure(model, samples, emptyUsed, 'invalidInput')
	if (samples.length < minimumSamples) return failure(model, samples, emptyUsed, 'insufficientSamples')

	const design = new Array<Float64Array>(samples.length)
	const target = new Float64Array(samples.length)
	const baseWeights = new Float64Array(samples.length)
	for (let i = 0; i < samples.length; i++) {
		design[i] = designRow(samples[i], model)
		target[i] = samples[i].focus
		baseWeights[i] = sampleWeight(samples[i])
	}

	const sigmaClip = positiveNumber(options.sigmaClip, DEFAULT_SIGMA_CLIP)
	const fit = robustLinearLeastSquares(design, target, {
		weights: baseWeights,
		method: 'tukey',
		tuning: sigmaClip,
		maxIterations: positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS),
	})
	const maximumConditionNumber = positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER)

	if (fit.rankDeficient) return failure(model, samples, emptyUsed, 'rankDeficient', fit.conditionNumber)
	if (!Number.isFinite(fit.conditionNumber) || fit.conditionNumber > maximumConditionNumber) return failure(model, samples, emptyUsed, 'illConditioned', fit.conditionNumber)
	if (!finiteCoefficients(fit.coefficients)) return failure(model, samples, emptyUsed, 'nonConvergent', fit.conditionNumber)

	const used = new Array<boolean>(samples.length)
	const rejectedIndices: number[] = []
	let usedCount = 0
	for (let i = 0; i < samples.length; i++) {
		const retained = fit.weights[i] > baseWeights[i] * MINIMUM_RETAINED_WEIGHT
		used[i] = retained
		if (retained) usedCount++
		else rejectedIndices.push(i)
	}

	if (usedCount < minimumSamples) return failure(model, samples, used, 'excessiveRejection', fit.conditionNumber)

	const coefficients = coefficientsFor(model, fit.coefficients)
	const residuals = residualsFor(samples, coefficients)
	const rms = rmsFor(residuals, used)
	const degreesOfFreedom = usedCount - parameterCount
	const warnings: FocusSurfaceFitWarning[] = []
	if (rejectedIndices.length > 0) warnings.push({ code: 'robustOutliers', values: { rejectedCount: rejectedIndices.length } })

	const covariance = degreesOfFreedom > 0 ? covarianceFor(design, residuals, fit.weights, used, parameterCount, degreesOfFreedom) : undefined
	if (degreesOfFreedom > 0 && covariance === undefined) warnings.push({ code: 'uncertaintyUnavailable' })

	const support = Math.min(1, usedCount / minimumSamples)
	const conditioning = Math.min(1, Math.max(0, Math.log10(maximumConditionNumber / Math.max(1, fit.conditionNumber)) / Math.log10(maximumConditionNumber)))
	const confidence = Math.sqrt(support * (usedCount / samples.length)) * conditioning

	return { success: true, model, coefficients, samples, used, residuals, covariance, degreesOfFreedom, rejectedIndices, rms, conditionNumber: fit.conditionNumber, confidence, warnings }
}

// Evaluates a finite common focus-surface coefficient set at normalized sensor coordinates.
export function evaluateFocusSurface(surface: FocusSurfaceCoefficients, u: number, v: number): number {
	if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(surface.c) || !Number.isFinite(surface.ax) || !Number.isFinite(surface.ay) || !Number.isFinite(surface.qxx) || !Number.isFinite(surface.qxy) || !Number.isFinite(surface.qyy)) {
		throw new RangeError('focus surface coefficients and coordinates must be finite')
	}

	return surface.c + surface.ax * u + surface.ay * v + surface.qxx * u * u + surface.qxy * u * v + surface.qyy * v * v
}

// Derives the normalized-sensor planar gradient, direction, and corner-to-corner effect.
export function analyzeFocusPlane(surface: FocusSurfaceCoefficients): FocusPlaneAnalysis {
	assertFiniteCoefficients(surface)
	const effect = Math.abs(surface.ax) + Math.abs(surface.ay)
	const direction = effect > 0 ? normalizeAngle(Math.atan2(surface.ay, surface.ax)) : undefined
	return { gradientX: surface.ax, gradientY: surface.ay, direction, effect }
}

// Computes the full focus range over the normalized sensor, including stationary extrema on edges and in the interior.
export function focusSurfaceEffect(surface: FocusSurfaceCoefficients): number {
	assertFiniteCoefficients(surface)
	const candidates: Point[] = [
		{ x: -0.5, y: -0.5 },
		{ x: 0.5, y: -0.5 },
		{ x: -0.5, y: 0.5 },
		{ x: 0.5, y: 0.5 },
	]
	for (const u of [-0.5, 0.5]) appendSurfaceCandidate(candidates, u, -(surface.ay + surface.qxy * u) / (2 * surface.qyy))
	for (const v of [-0.5, 0.5]) appendSurfaceCandidate(candidates, -(surface.ax + surface.qxy * v) / (2 * surface.qxx), v)
	const determinant = 4 * surface.qxx * surface.qyy - surface.qxy * surface.qxy
	const scale = Math.max(1, 4 * surface.qxx * surface.qxx + 2 * surface.qxy * surface.qxy + 4 * surface.qyy * surface.qyy)
	if (Math.abs(determinant) > Number.EPSILON * scale) {
		const u = (-2 * surface.qyy * surface.ax + surface.qxy * surface.ay) / determinant
		const v = (surface.qxy * surface.ax - 2 * surface.qxx * surface.ay) / determinant
		appendSurfaceCandidate(candidates, u, v)
	}
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	for (let i = 0; i < candidates.length; i++) {
		const value = evaluateFocusSurface(surface, candidates[i].x, candidates[i].y)
		minimum = Math.min(minimum, value)
		maximum = Math.max(maximum, value)
	}
	return maximum - minimum
}

// Derives Hessian eigenstructure, stationary point, and sensor-scale curvature effects.
export function analyzeFocusCurvature(surface: FocusSurfaceCoefficients): FocusCurvatureAnalysis {
	assertFiniteCoefficients(surface)
	const hxx = 2 * surface.qxx
	const hxy = surface.qxy
	const hyy = 2 * surface.qyy
	const difference = surface.qxx - surface.qyy
	const spread = Math.hypot(difference, surface.qxy)
	const principalX = surface.qxx + surface.qyy + spread
	const principalY = surface.qxx + surface.qyy - spread
	let orientation = 0.5 * Math.atan2(surface.qxy, difference)
	if (orientation < 0) orientation += PI
	const anisotropy = spread > 0 ? Math.min(1, (principalX - principalY) / Math.max(Math.abs(principalX), Math.abs(principalY), Number.EPSILON)) : 0
	const determinant = hxx * hyy - hxy * hxy
	const scale = Math.max(1, hxx * hxx + 2 * hxy * hxy + hyy * hyy)
	const stationaryPoint = Math.abs(determinant) > Number.EPSILON * scale ? stationaryPointFor(surface, hxx, hxy, hyy, determinant) : undefined
	const effect = focusSurfaceEffect({ c: 0, ax: 0, ay: 0, qxx: surface.qxx, qxy: surface.qxy, qyy: surface.qyy })

	return {
		stationaryPoint,
		principalX,
		principalY,
		orientation: spread > Number.EPSILON ? orientation : undefined,
		anisotropy: spread > Number.EPSILON ? anisotropy : undefined,
		centerToEdge: 0.25 * (surface.qxx + surface.qyy),
		effect,
	}
}

// Appends a finite stationary candidate when it lies on or inside the normalized sensor rectangle.
function appendSurfaceCandidate(candidates: Point[], u: number, v: number): void {
	if (Number.isFinite(u) && Number.isFinite(v) && u >= -0.5 && u <= 0.5 && v >= -0.5 && v <= 0.5) candidates.push({ x: u, y: v })
}

// Builds a discriminated failure while preserving the original sample order.
function failure(model: FocusSurfaceModel, samples: readonly FocusSurfaceSample[], used: readonly boolean[], reason: FocusSurfaceFitFailureReason, conditionNumber?: number): FocusSurfaceFitFailure {
	return { success: false, model, samples, used, reason, conditionNumber, warnings: [] }
}

// Returns the design-column count for one supported surface model.
function modelParameterCount(model: FocusSurfaceModel): number {
	return model === 'plane' ? 3 : model === 'radialQuadratic' ? 4 : 6
}

// Builds one normalized-coordinate design row in model-specific coefficient order.
function designRow(sample: FocusSurfaceSample, model: FocusSurfaceModel): Float64Array {
	const { u, v } = sample
	return model === 'plane' ? new Float64Array([1, u, v]) : model === 'radialQuadratic' ? new Float64Array([1, u, v, u * u + v * v]) : new Float64Array([1, u, v, u * u, u * v, v * v])
}

// Validates all finite inputs before they reach the generic numerical solver.
function validSamples(samples: readonly FocusSurfaceSample[]): boolean {
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		if (!Number.isFinite(sample.u) || !Number.isFinite(sample.v) || !Number.isFinite(sample.focus) || sample.u < -0.5 || sample.u > 0.5 || sample.v < -0.5 || sample.v > 0.5) return false
		if (sample.weight !== undefined && (!(sample.weight > 0) || !Number.isFinite(sample.weight))) return false
		if (sample.uncertainty !== undefined && (!(sample.uncertainty > 0) || !Number.isFinite(sample.uncertainty))) return false
	}

	return true
}

// Returns the caller weight or inverse variance from uncertainty, preferring explicit weighting.
function sampleWeight(sample: FocusSurfaceSample): number {
	return sample.weight ?? (sample.uncertainty === undefined ? 1 : 1 / (sample.uncertainty * sample.uncertainty))
}

// Maps a model-specific solution into the stable common coefficient shape.
function coefficientsFor(model: FocusSurfaceModel, coefficients: Readonly<NumberArray>): FocusSurfaceCoefficients {
	if (model === 'plane') return { c: coefficients[0], ax: coefficients[1], ay: coefficients[2], qxx: 0, qxy: 0, qyy: 0 }
	if (model === 'radialQuadratic') return { c: coefficients[0], ax: coefficients[1], ay: coefficients[2], qxx: coefficients[3], qxy: 0, qyy: coefficients[3] }
	return { c: coefficients[0], ax: coefficients[1], ay: coefficients[2], qxx: coefficients[3], qxy: coefficients[4], qyy: coefficients[5] }
}

// Tests whether every generic-solver coefficient can safely be published.
function finiteCoefficients(coefficients: Readonly<NumberArray>): boolean {
	for (let i = 0; i < coefficients.length; i++) {
		if (!Number.isFinite(coefficients[i])) return false
	}

	return true
}

// Rejects non-finite public surface coefficients before derived geometry is published.
function assertFiniteCoefficients(surface: FocusSurfaceCoefficients): void {
	if (!Number.isFinite(surface.c) || !Number.isFinite(surface.ax) || !Number.isFinite(surface.ay) || !Number.isFinite(surface.qxx) || !Number.isFinite(surface.qxy) || !Number.isFinite(surface.qyy)) throw new RangeError('focus surface coefficients must be finite')
}

// Solves the full-surface stationary point from its finite, non-singular Hessian.
function stationaryPointFor(surface: FocusSurfaceCoefficients, hxx: number, hxy: number, hyy: number, determinant: number): Readonly<Point> | undefined {
	const x = (-hyy * surface.ax + hxy * surface.ay) / determinant
	const y = (hxy * surface.ax - hxx * surface.ay) / determinant
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

// Computes input-order physical residuals from the common coefficient representation.
function residualsFor(samples: readonly FocusSurfaceSample[], coefficients: FocusSurfaceCoefficients): Float64Array {
	const residuals = new Float64Array(samples.length)
	for (let i = 0; i < samples.length; i++) residuals[i] = samples[i].focus - evaluateFocusSurface(coefficients, samples[i].u, samples[i].v)
	return residuals
}

// Computes RMS only over samples that retained useful robust weight.
function rmsFor(residuals: Readonly<Float64Array>, used: readonly boolean[]): number {
	let sum = 0
	let count = 0
	for (let i = 0; i < residuals.length; i++) {
		if (!used[i]) continue
		sum += residuals[i] * residuals[i]
		count++
	}

	return count > 0 ? Math.sqrt(sum / count) : 0
}

// Estimates model-coefficient covariance from the final weighted normal matrix and residual variance.
function covarianceFor(design: readonly Float64Array[], residuals: Readonly<Float64Array>, weights: Readonly<NumberArray>, used: readonly boolean[], parameters: number, degreesOfFreedom: number): Float64Array | undefined {
	const normal = new Float64Array(parameters * parameters)
	let weightedSse = 0

	for (let row = 0; row < design.length; row++) {
		if (!used[row]) continue
		const weight = weights[row]
		weightedSse += weight * residuals[row] * residuals[row]
		for (let i = 0; i < parameters; i++) {
			const left = design[row][i] * weight
			for (let j = 0; j < parameters; j++) normal[i * parameters + j] += left * design[row][j]
		}
	}

	const inverse = invertSquareMatrix(normal, parameters)
	if (inverse === undefined) return undefined
	const variance = weightedSse / degreesOfFreedom
	for (let i = 0; i < inverse.length; i++) inverse[i] *= variance
	return inverse
}

// Inverts a small dense square matrix by partial-pivot Gauss-Jordan elimination.
function invertSquareMatrix(source: Readonly<Float64Array>, size: number): Float64Array | undefined {
	const width = size * 2
	const augmented = new Float64Array(size * width)
	for (let row = 0; row < size; row++) {
		for (let column = 0; column < size; column++) augmented[row * width + column] = source[row * size + column]
		augmented[row * width + size + row] = 1
	}

	for (let column = 0; column < size; column++) {
		let pivot = column
		let maximum = Math.abs(augmented[pivot * width + column])
		for (let row = column + 1; row < size; row++) {
			const candidate = Math.abs(augmented[row * width + column])
			if (candidate > maximum) {
				maximum = candidate
				pivot = row
			}
		}
		if (!(maximum > Number.EPSILON) || !Number.isFinite(maximum)) return undefined

		if (pivot !== column) {
			for (let index = 0; index < width; index++) {
				const temporary = augmented[column * width + index]
				augmented[column * width + index] = augmented[pivot * width + index]
				augmented[pivot * width + index] = temporary
			}
		}

		const divisor = augmented[column * width + column]
		for (let index = 0; index < width; index++) augmented[column * width + index] /= divisor
		for (let row = 0; row < size; row++) {
			if (row === column) continue
			const factor = augmented[row * width + column]
			if (factor === 0) continue
			for (let index = 0; index < width; index++) augmented[row * width + index] -= factor * augmented[column * width + index]
		}
	}

	const inverse = new Float64Array(size * size)
	for (let row = 0; row < size; row++) {
		for (let column = 0; column < size; column++) inverse[row * size + column] = augmented[row * width + size + column]
	}
	return inverse
}

// Returns a finite positive option or its documented default.
function positiveNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

// Returns a finite positive integer option or its documented default.
function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}
