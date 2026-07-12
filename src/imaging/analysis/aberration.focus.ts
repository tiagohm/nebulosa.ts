import { robustLinearLeastSquares } from '../../math/numerical/least.squares'
import type { AberrationWarning } from './aberration.types'

// Robust one-dimensional quadratic focus-curve fitting for completed focus scans.

// Focus metrics supported by regional focus curves.
export type AberrationFocusMetric = 'hfd' | 'fwhm'

// Implemented focus-curve models; `auto` currently selects the robust quadratic model.
export type AberrationFocusModel = 'quadratic' | 'auto'

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

// Configures robust quadratic focus-curve fitting.
export interface AberrationFocusCurveOptions {
	// Quadratic model, or `auto` which currently chooses it.
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
	readonly model: 'quadratic'
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

// Fits a normalized robust quadratic and converts its minimum back to the caller's focuser unit.
export function fitAberrationFocusCurve(points: readonly AberrationFocusPoint[], options: AberrationFocusCurveOptions = {}): AberrationFocusCurveResult {
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
	const uncertainty = degreesOfFreedom > 0 ? Math.sqrt(sumSquares / degreesOfFreedom / (4 * a * a)) * halfSpan : undefined
	const condition = Math.min(1, Math.max(0, Math.log10(positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER) / Math.max(1, fit.conditionNumber)) / Math.log10(positiveNumber(options.maxConditionNumber, DEFAULT_MAXIMUM_CONDITION_NUMBER))))
	const confidence = Math.sqrt(usedCount / points.length) * condition

	return { success: true, model: 'quadratic', points, used, minimum: { x: position, y: c + b * tMinimum + a * tMinimum * tMinimum }, uncertainty, rms, r2, conditionNumber: fit.conditionNumber, confidence, warnings }
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
function positiveNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

// Returns a finite positive integer option or fallback.
function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}
