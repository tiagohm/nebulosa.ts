import { linearLeastSquares, robustLinearLeastSquares } from '../../math/numerical/least.squares'
import type { NumberArray } from '../../math/numerical/math'
import { hyperbolicRegression, type HyperbolicRegression } from '../../math/numerical/regression'
import type { AberrationWarning } from './aberration.types'

// Robust one-dimensional focus-curve fitting for completed focus scans.

// Focus metrics supported by regional focus curves.
export type AberrationFocusMetric = 'hfd' | 'fwhm'

// Implemented focus-curve models and automatic penalized-error selection.
export type AberrationFocusModel = 'quadratic' | 'hyperbolic' | 'trendLines' | 'auto'

// Stable reason why a best-focus estimate was not published.
export type AberrationFocusCurveFailureReason = 'insufficientPoints' | 'insufficientSides' | 'invalidInput' | 'nonConvex' | 'minimumOutsideRange' | 'illConditioned' | 'nonConvergent' | 'excessiveRejection'

// One aggregated regional measurement at a focus position.
export interface AberrationFocusPoint {
	// Focuser position in the caller's unit.
	readonly position: number
	// Positive HFD or FWHM measurement in pixels.
	readonly value: number
	// Optional positive statistical weight.
	readonly weight?: number
	// Optional number of stars supporting this point.
	readonly starCount?: number
}

// Configures robust focus-curve fitting.
export interface AberrationFocusCurveOptions {
	// Explicit model or penalized-error automatic selection.
	readonly model?: AberrationFocusModel
	// Positive Tukey residual-scale tuning threshold.
	readonly sigmaClip?: number
	// Maximum robust fitting iterations.
	readonly maxIterations?: number
	// Minimum accepted points, never lower than five.
	readonly minimumPoints?: number
	// Minimum accepted points on each side of the fitted minimum.
	readonly minimumPointsPerSide?: number
	// Whether a fitted minimum outside the sampled position range fails the curve.
	readonly requireMinimumInsideRange?: boolean
	// Largest accepted weighted-design condition number.
	readonly maxConditionNumber?: number
}

// Published result for a supported focus curve.
export interface AberrationFocusCurveSuccess {
	// Discriminates successful curve fits.
	readonly success: true
	// Implemented model used to estimate best focus.
	readonly model: Exclude<AberrationFocusModel, 'auto'>
	// Input points in original order.
	readonly points: readonly AberrationFocusPoint[]
	// Whether each point retained sufficient final robust weight.
	readonly used: readonly boolean[]
	// Best-focus position and metric value in caller/pixel units.
	readonly minimum: Readonly<{ x: number; y: number }>
	// Best-focus position uncertainty when residual degrees of freedom are positive.
	readonly uncertainty?: number
	// RMS residual in metric pixels over used points.
	readonly rms: number
	// Coefficient of determination over used points.
	readonly r2: number
	// Weighted normalized-design condition number.
	readonly conditionNumber: number
	// Bounded support, conditioning, and outlier confidence.
	readonly confidence: number
	// Non-fatal fit diagnostics.
	readonly warnings: readonly AberrationWarning[]
}

// Published result when a focus curve cannot support a best-focus estimate.
export interface AberrationFocusCurveFailure {
	// Discriminates failed curve fits.
	readonly success: false
	// Input points in original order.
	readonly points: readonly AberrationFocusPoint[]
	// Per-input retained flags when available.
	readonly used: readonly boolean[]
	// Stable terminal failure reason.
	readonly reason: AberrationFocusCurveFailureReason
	// Non-fatal diagnostics collected before failure.
	readonly warnings: readonly AberrationWarning[]
}

// Discriminated result of focus-curve fitting.
export type AberrationFocusCurveResult = AberrationFocusCurveSuccess | AberrationFocusCurveFailure

// Default minimum samples for a stable quadratic with support on both sides.
const DEFAULT_MINIMUM_POINTS = 5
// Default per-side support around the fitted minimum.
const DEFAULT_MINIMUM_POINTS_PER_SIDE = 2
// Default robust Tukey tuning constant.
const DEFAULT_SIGMA_CLIP = 4.685
// Default robust iteration cap.
const DEFAULT_MAX_ITERATIONS = 20
// Default largest accepted condition number.
const DEFAULT_MAXIMUM_CONDITION_NUMBER = 1e10
// Relative final robust weight retained as a curve point.
const MINIMUM_RETAINED_WEIGHT = 1e-3
// Median absolute normal residual used to scale nonlinear Tukey weights.
const NORMAL_MAD = 0.6744897501960817
// Maximum branch repartitioning passes for a trend-lines curve.
const TREND_LINE_PARTITION_ITERATIONS = 12
// Internal residuals retained only while automatic model candidates remain reachable.
const FOCUS_CURVE_RESIDUALS = new WeakMap<AberrationFocusCurveSuccess, Readonly<NumberArray>>()

// Fits the requested curve, or evaluates every supported curve for `auto`.
export function fitAberrationFocusCurve(points: readonly AberrationFocusPoint[], options: AberrationFocusCurveOptions = {}): AberrationFocusCurveResult {
	const model = options.model ?? 'quadratic'
	if (model === 'quadratic') return fitQuadraticFocusCurve(points, options)
	if (model === 'hyperbolic') return fitHyperbolicFocusCurve(points, options)
	if (model === 'trendLines') return fitTrendLinesFocusCurve(points, options)

	const candidates = [fitHyperbolicFocusCurve(points, options), fitQuadraticFocusCurve(points, options), fitTrendLinesFocusCurve(points, options)]
	const commonUsed = new Array<boolean>(points.length).fill(true)
	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]
		if (!candidate.success) continue
		for (let j = 0; j < commonUsed.length; j++) commonUsed[j] &&= candidate.used[j]
	}
	let best: AberrationFocusCurveSuccess | undefined
	let bestScore = Number.POSITIVE_INFINITY
	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]
		if (!candidate.success) continue
		const score = focusCurveAicc(candidate, commonUsed)
		if (best === undefined || score < bestScore) {
			best = candidate
			bestScore = score
		}
	}
	return best ?? fitQuadraticFocusCurve(points, options)
}

// Fits a normalized robust quadratic and converts its minimum back to the caller's focuser unit.
function fitQuadraticFocusCurve(points: readonly AberrationFocusPoint[], options: AberrationFocusCurveOptions): AberrationFocusCurveResult {
	const emptyUsed = new Array<boolean>(points.length).fill(false)
	const minimumPoints = Math.max(DEFAULT_MINIMUM_POINTS, positiveInteger(options.minimumPoints, DEFAULT_MINIMUM_POINTS))
	if (!validPoints(points)) return failure(points, emptyUsed, 'invalidInput')
	if (points.length < minimumPoints) return failure(points, emptyUsed, 'insufficientPoints')

	let minimumPosition = Number.POSITIVE_INFINITY
	let maximumPosition = Number.NEGATIVE_INFINITY
	for (let i = 0; i < points.length; i++) {
		minimumPosition = Math.min(minimumPosition, points[i].position)
		maximumPosition = Math.max(maximumPosition, points[i].position)
	}
	if (!(maximumPosition > minimumPosition)) return failure(points, emptyUsed, 'invalidInput')

	const center = 0.5 * (minimumPosition + maximumPosition)
	const halfSpan = 0.5 * (maximumPosition - minimumPosition)
	const design = new Array<Float64Array>(points.length)
	const target = new Float64Array(points.length)
	const baseWeights = new Float64Array(points.length)
	for (let i = 0; i < points.length; i++) {
		const t = (points[i].position - center) / halfSpan
		design[i] = new Float64Array([1, t, t * t])
		target[i] = points[i].value
		baseWeights[i] = points[i].weight ?? 1
	}

	const fit = robustLinearLeastSquares(design, target, { weights: baseWeights, method: 'tukey', tuning: positiveNumber(options.sigmaClip, DEFAULT_SIGMA_CLIP), maxIterations: positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS) })
	if (fit.rankDeficient) return failure(points, emptyUsed, 'illConditioned')
	if (!Number.isFinite(fit.conditionNumber) || fit.conditionNumber > positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER)) return failure(points, emptyUsed, 'illConditioned')
	if (!Number.isFinite(fit.coefficients[0]) || !Number.isFinite(fit.coefficients[1]) || !Number.isFinite(fit.coefficients[2])) return failure(points, emptyUsed, 'nonConvergent')

	const used = new Array<boolean>(points.length)
	let usedCount = 0
	for (let i = 0; i < points.length; i++) {
		used[i] = fit.weights[i] > baseWeights[i] * MINIMUM_RETAINED_WEIGHT
		if (used[i]) usedCount++
	}
	if (usedCount < minimumPoints) return failure(points, used, 'excessiveRejection')

	const [c, b, a] = fit.coefficients
	if (!(a > 0)) return failure(points, used, 'nonConvex')
	const tMinimum = -b / (2 * a)
	const position = center + halfSpan * tMinimum
	const minimumValue = c + b * tMinimum + a * tMinimum * tMinimum
	if (!Number.isFinite(minimumValue) || !(minimumValue > 0)) return failure(points, used, 'nonConvergent')
	if ((options.requireMinimumInsideRange ?? true) && (position < minimumPosition || position > maximumPosition)) return failure(points, used, 'minimumOutsideRange')

	let left = 0
	let right = 0
	let sum = 0
	let sumSquares = 0
	let sumValues = 0
	for (let i = 0; i < points.length; i++) {
		if (!used[i]) continue
		const residual = target[i] - (c + b * design[i][1] + a * design[i][2])
		sumSquares += residual * residual
		sumValues += target[i]
		sum += 1
		if (points[i].position < position) left++
		if (points[i].position > position) right++
	}
	if (left < positiveInteger(options.minimumPointsPerSide, DEFAULT_MINIMUM_POINTS_PER_SIDE) || right < positiveInteger(options.minimumPointsPerSide, DEFAULT_MINIMUM_POINTS_PER_SIDE)) return failure(points, used, 'insufficientSides')

	const mean = sumValues / sum
	let totalSquares = 0
	for (let i = 0; i < points.length; i++) if (used[i]) totalSquares += (target[i] - mean) * (target[i] - mean)
	const rms = Math.sqrt(sumSquares / sum)
	const r2 = totalSquares > 0 ? 1 - sumSquares / totalSquares : sumSquares === 0 ? 1 : 0
	const warnings: AberrationWarning[] = []
	if (usedCount < points.length) warnings.push({ code: 'robustOutliers', values: { rejectedCount: points.length - usedCount } })
	if (Math.abs(tMinimum) > 0.9) warnings.push({ code: 'minimumNearRangeEdge', values: { normalizedPosition: tMinimum } })
	const degreesOfFreedom = usedCount - 3
	const uncertainty = degreesOfFreedom > 0 ? focusMinimumUncertainty(design, target, fit.weights, used, c, b, a, halfSpan, degreesOfFreedom) : undefined
	const condition = Math.min(1, Math.max(0, Math.log10(positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER) / Math.max(1, fit.conditionNumber)) / Math.log10(positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER))))
	const confidence = Math.sqrt(usedCount / points.length) * condition

	const result: AberrationFocusCurveSuccess = { success: true, model: 'quadratic', points, used, minimum: { x: position, y: minimumValue }, uncertainty, rms, r2, conditionNumber: fit.conditionNumber, confidence, warnings }
	FOCUS_CURVE_RESIDUALS.set(result, fit.residuals)
	return result
}

// Fits the existing nonlinear hyperbola in normalized focus coordinates with true sample weights.
function fitHyperbolicFocusCurve(points: readonly AberrationFocusPoint[], options: AberrationFocusCurveOptions): AberrationFocusCurveResult {
	const emptyUsed = new Array<boolean>(points.length).fill(false)
	const minimumPoints = Math.max(DEFAULT_MINIMUM_POINTS, positiveInteger(options.minimumPoints, DEFAULT_MINIMUM_POINTS))
	if (!validPoints(points)) return failure(points, emptyUsed, 'invalidInput')
	if (points.length < minimumPoints) return failure(points, emptyUsed, 'insufficientPoints')
	const domain = normalizedFocusData(points)
	if (domain === undefined) return failure(points, emptyUsed, 'invalidInput')

	let maximumWeight = 0
	for (let i = 0; i < points.length; i++) maximumWeight = Math.max(maximumWeight, domain.weights[i])
	let minimumIndex = -1
	for (let i = 0; i < points.length; i++) {
		if (domain.weights[i] < maximumWeight * MINIMUM_RETAINED_WEIGHT) continue
		if (minimumIndex < 0 || domain.target[i] < domain.target[minimumIndex]) minimumIndex = i
	}
	if (minimumIndex < 0) return failure(points, emptyUsed, 'nonConvergent')
	const robustFit = fitRobustHyperbola(domain, [0.5, domain.target[minimumIndex], domain.positions[minimumIndex]], options)
	const regression = robustFit.regression
	const { a, b, c } = regression
	if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || Math.abs(a) <= Number.EPSILON || !(b > 0)) return failure(points, emptyUsed, 'nonConvergent')
	const position = domain.center + domain.halfSpan * c
	if ((options.requireMinimumInsideRange ?? true) && (position < domain.minimum || position > domain.maximum)) return failure(points, emptyUsed, 'minimumOutsideRange')

	const used = new Array<boolean>(points.length)
	for (let i = 0; i < points.length; i++) used[i] = robustFit.weights[i] > domain.weights[i] * MINIMUM_RETAINED_WEIGHT
	if (!hasSideSupport(points, used, position, positiveInteger(options.minimumPointsPerSide, DEFAULT_MINIMUM_POINTS_PER_SIDE))) return failure(points, used, 'insufficientSides')
	const jacobian = new Array<Float64Array>(points.length)
	const zero = new Float64Array(points.length)
	for (let i = 0; i < points.length; i++) {
		const u = (domain.positions[i] - c) / a
		const root = Math.sqrt(1 + u * u)
		jacobian[i] = new Float64Array([(-b * u * u) / (a * root), root, (-b * u) / (a * root)])
	}
	const conditionFit = linearLeastSquares(jacobian, zero, { weights: robustFit.weights })
	const maximumCondition = positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER)
	if (conditionFit.rankDeficient || !Number.isFinite(conditionFit.conditionNumber) || conditionFit.conditionNumber > maximumCondition) return failure(points, used, 'illConditioned')
	return focusCurveSuccess('hyperbolic', points, used, position, b, regression.predict, conditionFit.conditionNumber, maximumCondition, minimumPoints)
}

// Result of nonlinear Tukey reweighting for a normalized hyperbolic focus curve.
interface RobustHyperbolicFit {
	// Final nonlinear regression refitted with the retained robust weights.
	readonly regression: HyperbolicRegression
	// Base sample weights multiplied by their final Tukey weights.
	readonly weights: Float64Array
}

// Iteratively reweights nonlinear residuals and performs a final fit with the converged weights.
function fitRobustHyperbola(domain: NormalizedFocusData, initial: readonly [a: number, b: number, c: number], options: AberrationFocusCurveOptions): RobustHyperbolicFit {
	const tuning = positiveNumber(options.sigmaClip, DEFAULT_SIGMA_CLIP)
	const maximumIterations = positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS)
	const seedDesign = new Array<Float64Array>(domain.positions.length)
	for (let i = 0; i < seedDesign.length; i++) {
		const position = domain.positions[i]
		seedDesign[i] = new Float64Array([1, position, position * position])
	}
	const seed = robustLinearLeastSquares(seedDesign, domain.target, { weights: domain.weights, method: 'tukey', tuning, maxIterations: maximumIterations })
	let weights = seed.rankDeficient ? domain.weights.slice() : Float64Array.from(seed.weights)
	let parameters = initial
	const [seedIntercept, seedSlope, seedCurvature] = seed.coefficients
	if (!seed.rankDeficient && seedCurvature > 0) {
		const center = -seedSlope / (2 * seedCurvature)
		const minimum = seedIntercept + seedSlope * center + seedCurvature * center * center
		const width = Math.sqrt(minimum / (2 * seedCurvature))
		if (Number.isFinite(center) && minimum > 0 && Number.isFinite(width) && width > Number.EPSILON) parameters = [width, minimum, center]
	}
	const convergenceScale = Math.max(1, maximumWeightOf(domain.weights))
	const residuals = new Float64Array(domain.target.length)
	const residualAbsolute = new Float64Array(residuals.length)
	for (let iteration = 0; iteration < maximumIterations; iteration++) {
		const regression = hyperbolicRegression(domain.positions, domain.target, weights, parameters)
		parameters = [regression.a, regression.b, regression.c]
		for (let i = 0; i < residuals.length; i++) residuals[i] = domain.target[i] - regression.predict(domain.positions[i])
		for (let i = 0; i < residuals.length; i++) residualAbsolute[i] = Math.abs(residuals[i])
		const scale = hyperbolicResidualScale(residuals, residualAbsolute.sort())
		const nextWeights = new Float64Array(weights.length)
		let maximumDelta = 0
		for (let i = 0; i < nextWeights.length; i++) {
			const normalized = Math.abs(residuals[i]) / (Math.max(scale, Number.EPSILON) * tuning)
			const complement = normalized < 1 ? 1 - normalized * normalized : 0
			nextWeights[i] = domain.weights[i] * complement * complement
			maximumDelta = Math.max(maximumDelta, Math.abs(nextWeights[i] - weights[i]))
		}
		weights = nextWeights
		if (maximumDelta <= 1e-6 * convergenceScale) break
	}
	return { regression: hyperbolicRegression(domain.positions, domain.target, weights, parameters), weights }
}

// Estimates nonlinear residual scale from MAD, with RMS as the exact-fit fallback.
function hyperbolicResidualScale(residuals: Float64Array, absolute: Float64Array) {
	const middle = absolute.length >>> 1
	let scale = (absolute.length % 2 === 0 ? 0.5 * (absolute[middle - 1] + absolute[middle]) : absolute[middle]) / NORMAL_MAD
	if (!(scale > 0)) {
		let sumSquares = 0
		for (let i = 0; i < residuals.length; i++) sumSquares += residuals[i] * residuals[i]
		scale = Math.sqrt(sumSquares / residuals.length)
	}
	return scale
}

// Returns the largest finite weight in a non-empty normalized focus domain.
function maximumWeightOf(weights: Float64Array) {
	let maximum = 0
	for (let i = 0; i < weights.length; i++) maximum = Math.max(maximum, weights[i])
	return maximum
}

// Fits two robust weighted line branches and iterates their partition around the intersection.
function fitTrendLinesFocusCurve(points: readonly AberrationFocusPoint[], options: AberrationFocusCurveOptions): AberrationFocusCurveResult {
	const emptyUsed = new Array<boolean>(points.length).fill(false)
	const minimumPoints = Math.max(DEFAULT_MINIMUM_POINTS, positiveInteger(options.minimumPoints, DEFAULT_MINIMUM_POINTS))
	if (!validPoints(points)) return failure(points, emptyUsed, 'invalidInput')
	if (points.length < minimumPoints) return failure(points, emptyUsed, 'insufficientPoints')
	const domain = normalizedFocusData(points)
	if (domain === undefined) return failure(points, emptyUsed, 'invalidInput')
	let minimumIndex = 0
	for (let i = 1; i < points.length; i++) if (points[i].value < points[minimumIndex].value) minimumIndex = i
	let split = domain.positions[minimumIndex]
	let branch: ReturnType<typeof fitTrendBranches> | undefined
	let converged = false
	for (let iteration = 0; iteration < TREND_LINE_PARTITION_ITERATIONS; iteration++) {
		branch = fitTrendBranches(domain, split, options)
		if (branch === undefined) return failure(points, emptyUsed, 'insufficientSides')
		if (!(branch.leftSlope < 0) || !(branch.rightSlope > 0)) return failure(points, branch.used, 'nonConvex')
		if (!Number.isFinite(branch.intersection)) return failure(points, branch.used, 'nonConvergent')
		if (Math.abs(branch.intersection - split) <= 1e-9) {
			converged = true
			break
		}
		split = branch.intersection
	}
	if (branch === undefined || !converged) return failure(points, branch?.used ?? emptyUsed, 'nonConvergent')
	const position = domain.center + domain.halfSpan * branch.intersection
	if ((options.requireMinimumInsideRange ?? true) && (position < domain.minimum || position > domain.maximum)) return failure(points, branch.used, 'minimumOutsideRange')
	if (!hasSideSupport(points, branch.used, position, positiveInteger(options.minimumPointsPerSide, DEFAULT_MINIMUM_POINTS_PER_SIDE))) return failure(points, branch.used, 'insufficientSides')
	const maximumCondition = positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER)
	if (!Number.isFinite(branch.conditionNumber) || branch.conditionNumber > maximumCondition) return failure(points, branch.used, 'illConditioned')
	const minimumValue = branch.leftIntercept + branch.leftSlope * branch.intersection
	const predict = (t: number) => (t <= branch.intersection ? branch.leftIntercept + branch.leftSlope * t : branch.rightIntercept + branch.rightSlope * t)
	return focusCurveSuccess('trendLines', points, branch.used, position, minimumValue, predict, branch.conditionNumber, maximumCondition, minimumPoints, domain)
}

// Normalized arrays shared by nonlinear and piecewise focus models.
interface NormalizedFocusData {
	readonly minimum: number
	readonly maximum: number
	readonly center: number
	readonly halfSpan: number
	readonly positions: Float64Array
	readonly target: Float64Array
	readonly weights: Float64Array
}

// Normalizes focuser positions to approximately -1..1 while preserving point order.
function normalizedFocusData(points: readonly AberrationFocusPoint[]): NormalizedFocusData | undefined {
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	for (let i = 0; i < points.length; i++) {
		minimum = Math.min(minimum, points[i].position)
		maximum = Math.max(maximum, points[i].position)
	}
	if (!(maximum > minimum)) return undefined
	const center = 0.5 * (minimum + maximum)
	const halfSpan = 0.5 * (maximum - minimum)
	const positions = new Float64Array(points.length)
	const target = new Float64Array(points.length)
	const weights = new Float64Array(points.length)
	for (let i = 0; i < points.length; i++) {
		positions[i] = (points[i].position - center) / halfSpan
		target[i] = points[i].value
		weights[i] = points[i].weight ?? 1
	}
	return { minimum, maximum, center, halfSpan, positions, target, weights }
}

// Result of one robust left/right branch partition in normalized coordinates.
interface TrendBranchFit {
	readonly leftIntercept: number
	readonly leftSlope: number
	readonly rightIntercept: number
	readonly rightSlope: number
	readonly intersection: number
	readonly conditionNumber: number
	readonly used: readonly boolean[]
}

// Fits both weighted branches for the current split and maps robust weights to input points.
function fitTrendBranches(domain: NormalizedFocusData, split: number, options: AberrationFocusCurveOptions): TrendBranchFit | undefined {
	const leftIndices: number[] = []
	const rightIndices: number[] = []
	for (let i = 0; i < domain.positions.length; i++) (domain.positions[i] <= split ? leftIndices : rightIndices).push(i)
	if (leftIndices.length < 2 || rightIndices.length < 2) return undefined
	const left = fitLineBranch(domain, leftIndices, options)
	const right = fitLineBranch(domain, rightIndices, options)
	if (left === undefined || right === undefined) return undefined
	const denominator = left.coefficients[1] - right.coefficients[1]
	if (Math.abs(denominator) <= Number.EPSILON) return undefined
	const intersection = (right.coefficients[0] - left.coefficients[0]) / denominator
	const used = new Array<boolean>(domain.positions.length).fill(false)
	for (let i = 0; i < leftIndices.length; i++) used[leftIndices[i]] = left.weights[i] > domain.weights[leftIndices[i]] * MINIMUM_RETAINED_WEIGHT
	for (let i = 0; i < rightIndices.length; i++) used[rightIndices[i]] = right.weights[i] > domain.weights[rightIndices[i]] * MINIMUM_RETAINED_WEIGHT
	return { leftIntercept: left.coefficients[0], leftSlope: left.coefficients[1], rightIntercept: right.coefficients[0], rightSlope: right.coefficients[1], intersection, conditionNumber: Math.max(left.conditionNumber, right.conditionNumber), used }
}

// Fits one line branch using normalized coordinates and Tukey residual weights.
function fitLineBranch(domain: NormalizedFocusData, indices: readonly number[], options: AberrationFocusCurveOptions) {
	const design = new Array<Float64Array>(indices.length)
	const target = new Float64Array(indices.length)
	const weights = new Float64Array(indices.length)
	for (let i = 0; i < indices.length; i++) {
		const index = indices[i]
		design[i] = new Float64Array([1, domain.positions[index]])
		target[i] = domain.target[index]
		weights[i] = domain.weights[index]
	}
	const fit = robustLinearLeastSquares(design, target, { weights, method: 'tukey', tuning: positiveNumber(options.sigmaClip, DEFAULT_SIGMA_CLIP), maxIterations: positiveInteger(options.maxIterations, DEFAULT_MAX_ITERATIONS) })
	return fit.rankDeficient ? undefined : fit
}

// Checks that retained points support the fitted minimum on both sampled sides.
function hasSideSupport(points: readonly AberrationFocusPoint[], used: readonly boolean[], minimum: number, required: number): boolean {
	let left = 0
	let right = 0
	for (let i = 0; i < points.length; i++) {
		if (!used[i]) continue
		if (points[i].position < minimum) left++
		if (points[i].position > minimum) right++
	}
	return left >= required && right >= required
}

// Builds common residual statistics for nonlinear and piecewise models.
function focusCurveSuccess(
	model: 'hyperbolic' | 'trendLines',
	points: readonly AberrationFocusPoint[],
	used: readonly boolean[],
	position: number,
	minimumValue: number,
	predictNormalized: (position: number) => number,
	conditionNumber: number,
	maximumCondition: number,
	minimumPoints: number,
	domain = normalizedFocusData(points),
): AberrationFocusCurveResult {
	if (domain === undefined || !Number.isFinite(minimumValue) || !(minimumValue > 0)) return failure(points, used, 'nonConvergent')
	let count = 0
	let sum = 0
	let sumSquares = 0
	const residuals = new Float64Array(points.length)
	for (let i = 0; i < points.length; i++) {
		const residual = points[i].value - predictNormalized(domain.positions[i])
		if (!Number.isFinite(residual)) return failure(points, used, 'nonConvergent')
		residuals[i] = residual
		if (!used[i]) continue
		sum += points[i].value
		sumSquares += residual * residual
		count++
	}
	if (count < minimumPoints) return failure(points, used, 'excessiveRejection')
	const mean = sum / count
	let totalSquares = 0
	for (let i = 0; i < points.length; i++) if (used[i]) totalSquares += (points[i].value - mean) * (points[i].value - mean)
	const rms = Math.sqrt(sumSquares / count)
	const r2 = totalSquares > 0 ? 1 - sumSquares / totalSquares : sumSquares === 0 ? 1 : 0
	const warnings: AberrationWarning[] = []
	if (count < points.length) warnings.push({ code: 'robustOutliers', values: { rejectedCount: points.length - count } })
	const normalizedMinimum = (position - domain.center) / domain.halfSpan
	if (Math.abs(normalizedMinimum) > 0.9) warnings.push({ code: 'minimumNearRangeEdge', values: { normalizedPosition: normalizedMinimum } })
	const condition = Math.min(1, Math.max(0, Math.log10(maximumCondition / Math.max(1, conditionNumber)) / Math.log10(maximumCondition)))
	const result: AberrationFocusCurveSuccess = { success: true, model, points, used, minimum: { x: position, y: minimumValue }, rms, r2, conditionNumber, confidence: Math.sqrt(count / points.length) * condition, warnings }
	FOCUS_CURVE_RESIDUALS.set(result, residuals)
	return result
}

// Computes AICc over the same commonly retained samples for every automatic candidate.
function focusCurveAicc(curve: AberrationFocusCurveSuccess, commonUsed: readonly boolean[]) {
	const residuals = FOCUS_CURVE_RESIDUALS.get(curve)
	if (residuals === undefined) return Number.POSITIVE_INFINITY
	let count = 0
	let weightSum = 0
	let weightedSquares = 0
	for (let i = 0; i < commonUsed.length; i++) {
		if (!commonUsed[i]) continue
		const weight = curve.points[i].weight ?? 1
		weightSum += weight
		weightedSquares += weight * residuals[i] * residuals[i]
		count++
	}
	const parameters = curve.model === 'trendLines' ? 4 : 3
	if (count <= parameters + 1 || !(weightSum > 0)) return Number.POSITIVE_INFINITY
	const variance = Math.max(Number.EPSILON, weightedSquares / weightSum)
	return count * Math.log(variance) + 2 * parameters + (2 * parameters * (parameters + 1)) / (count - parameters - 1)
}

// Propagates the final weighted quadratic-coefficient covariance to the fitted minimum position.
function focusMinimumUncertainty(design: readonly Float64Array[], target: Float64Array, weights: Readonly<NumberArray>, used: readonly boolean[], c: number, b: number, a: number, halfSpan: number, degreesOfFreedom: number): number | undefined {
	let m00 = 0
	let m01 = 0
	let m02 = 0
	let m11 = 0
	let m12 = 0
	let m22 = 0
	let weightedSquares = 0
	for (let i = 0; i < design.length; i++) {
		if (!used[i]) continue
		const weight = weights[i]
		const t = design[i][1]
		const t2 = design[i][2]
		m00 += weight
		m01 += weight * t
		m02 += weight * t2
		m11 += weight * t * t
		m12 += weight * t * t2
		m22 += weight * t2 * t2
		const residual = target[i] - (c + b * t + a * t2)
		weightedSquares += weight * residual * residual
	}
	const determinant = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02)
	const scale = Math.max(1, Math.abs(m00), Math.abs(m01), Math.abs(m02), Math.abs(m11), Math.abs(m12), Math.abs(m22))
	if (!(Math.abs(determinant) > Number.EPSILON * scale * scale * scale)) return undefined
	const residualVariance = weightedSquares / degreesOfFreedom
	const covarianceBB = (residualVariance * (m00 * m22 - m02 * m02)) / determinant
	const covarianceAA = (residualVariance * (m00 * m11 - m01 * m01)) / determinant
	const covarianceBA = (residualVariance * (m01 * m02 - m00 * m12)) / determinant
	const derivativeB = -1 / (2 * a)
	const derivativeA = b / (2 * a * a)
	const variance = derivativeB * derivativeB * covarianceBB + derivativeA * derivativeA * covarianceAA + 2 * derivativeB * derivativeA * covarianceBA
	return variance >= 0 && Number.isFinite(variance) ? Math.sqrt(variance) * halfSpan : undefined
}

// Validates finite positive focus measurements, weights, and unique focuser positions.
function validPoints(points: readonly AberrationFocusPoint[]): boolean {
	const positions = new Set<number>()
	for (let i = 0; i < points.length; i++) {
		const point = points[i]
		if (!Number.isFinite(point.position) || !(point.value > 0) || !Number.isFinite(point.value) || (point.weight !== undefined && (!(point.weight > 0) || !Number.isFinite(point.weight))) || positions.has(point.position)) return false
		positions.add(point.position)
	}
	return true
}

// Builds a discriminated curve failure without changing input order or identity.
function failure(points: readonly AberrationFocusPoint[], used: readonly boolean[], reason: AberrationFocusCurveFailureReason): AberrationFocusCurveFailure {
	return { success: false, points, used, reason, warnings: [] }
}

// Returns a finite positive number option or fallback.
function positiveNumber(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

// Returns a finite positive integer option or fallback.
function positiveInteger(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}
