import type { NumberArray } from './math'
import { gaussianElimination, Matrix, QrDecomposition } from './matrix'
import { medianOf } from './util'

export type RobustRegressionMethod = 'none' | 'huber' | 'tukey'

export interface LinearLeastSquaresOptions {
	// Optional per-row weights; values must be finite and non-negative.
	readonly weights?: Readonly<NumberArray>
	// Non-negative ridge regularization added to the normal matrix diagonal.
	readonly ridge?: number
}

export interface LinearLeastSquaresResult {
	// Solved model coefficients in design-column order.
	readonly coefficients: Readonly<NumberArray>
	// Predicted target values for each design row.
	readonly fitted: Readonly<NumberArray>
	// Target-minus-fitted residuals for each design row.
	readonly residuals: Readonly<NumberArray>
	// Estimated condition number of the weighted design matrix.
	readonly conditionNumber: number
	// Whether the weighted design matrix is numerically rank deficient.
	readonly rankDeficient: boolean
}

export interface RobustLinearLeastSquaresOptions extends LinearLeastSquaresOptions {
	// Robust reweighting method.
	readonly method?: RobustRegressionMethod
	// Maximum IRLS iterations.
	readonly maxIterations?: number
	// Stop threshold for coefficient and weight changes.
	readonly tolerance?: number
	// Robust loss tuning constant.
	readonly tuning?: number
}

export interface RobustLinearLeastSquaresResult extends LinearLeastSquaresResult {
	// Final per-row weights after robust reweighting.
	readonly weights: Readonly<NumberArray>
	// Number of IRLS iterations performed.
	readonly iterations: number
	// Estimated residual scale.
	readonly scale: number
}

const ROBUST_MAD_SCALE = 0.6744897501960817
const DEFAULT_RIDGE = 1e-12
const DEFAULT_ROBUST_TUNING = 1.345
const DEFAULT_ROBUST_ITERATIONS = 25
const DEFAULT_ROBUST_TOLERANCE = 1e-9

// Evaluates a linear least-squares model for a feature vector.
export function predictLinearLeastSquares(coefficients: Readonly<NumberArray>, features: Readonly<NumberArray>) {
	let value = 0

	for (let i = 0; i < coefficients.length; i++) {
		value += coefficients[i] * features[i]
	}

	return value
}

// Solves a weighted linear least-squares problem using QR with a regularized fallback.
export function linearLeastSquares(design: readonly Readonly<NumberArray>[], target: Readonly<NumberArray>, { weights, ridge = 0 }: LinearLeastSquaresOptions = {}): LinearLeastSquaresResult {
	if (design.length !== target.length) throw new Error('design matrix row count must match target length')
	const { rows, cols } = validateLeastSquaresInput(design, weights)
	const conditionNumber = estimateLeastSquaresConditionNumber(design, weights)

	if (cols === 0) {
		return {
			coefficients: [],
			fitted: new Float64Array(rows),
			residuals: new Float64Array(target),
			conditionNumber,
			rankDeficient: true,
		}
	}

	const rankDeficient = !Number.isFinite(conditionNumber) || conditionNumber > 1e12
	const coefficients = solveLinearLeastSquares(design, target, weights, ridge)
	const fitted = new Float64Array(rows)
	const residuals = new Float64Array(rows)

	for (let i = 0; i < rows; i++) {
		const value = predictLinearLeastSquares(coefficients, design[i])
		fitted[i] = value
		residuals[i] = target[i] - value
	}

	return { coefficients, fitted, residuals, conditionNumber, rankDeficient }
}

// Solves a robust linear least-squares problem using iterative reweighted least squares.
export function robustLinearLeastSquares(
	design: readonly Readonly<NumberArray>[],
	target: Readonly<NumberArray>,
	{ weights, ridge = 0, method = 'huber', maxIterations = DEFAULT_ROBUST_ITERATIONS, tolerance = DEFAULT_ROBUST_TOLERANCE, tuning = DEFAULT_ROBUST_TUNING }: RobustLinearLeastSquaresOptions = {},
): RobustLinearLeastSquaresResult {
	if (design.length !== target.length) throw new Error('design matrix row count must match target length')
	const { rows } = validateLeastSquaresInput(design, weights)
	const baseWeights = initialLeastSquaresWeights(rows, weights)

	if (method === 'none' || rows === 0) {
		const result = linearLeastSquares(design, target, { weights: baseWeights, ridge })
		return { ...result, weights: baseWeights, iterations: 1, scale: robustResidualScale(result.residuals) }
	}

	let currentWeights = new Float64Array(baseWeights)
	let previousCoefficients: Readonly<NumberArray> = new Float64Array(0)
	let iterations = 0
	let scale = 0

	for (; iterations < maxIterations; iterations++) {
		const result = linearLeastSquares(design, target, { weights: currentWeights, ridge })
		scale = robustResidualScale(result.residuals)

		if (!Number.isFinite(scale) || scale === 0) {
			return { ...result, weights: currentWeights, iterations: iterations + 1, scale }
		}

		const nextWeights = reweightLeastSquares(baseWeights, result.residuals, scale, method, tuning)
		const coefficientDelta = previousCoefficients.length === result.coefficients.length ? maxCoefficientDelta(previousCoefficients, result.coefficients) : Number.POSITIVE_INFINITY
		const weightDelta = maxWeightDelta(currentWeights, nextWeights)

		previousCoefficients = result.coefficients
		currentWeights = nextWeights

		if (coefficientDelta <= tolerance && weightDelta <= tolerance) {
			iterations++
			break
		}
	}

	const result = linearLeastSquares(design, target, { weights: currentWeights, ridge })
	return { ...result, weights: currentWeights, iterations: Math.max(1, iterations), scale }
}

// Validates the least-squares matrix dimensions and optional weights.
function validateLeastSquaresInput(design: readonly Readonly<NumberArray>[], weights?: Readonly<NumberArray>) {
	if (weights && weights.length !== design.length) {
		throw new Error('weight length must match target length')
	}

	const rows = design.length
	const cols = rows === 0 ? 0 : design[0].length

	for (let i = 1; i < rows; i++) {
		if (design[i].length !== cols) {
			throw new Error('design matrix must be rectangular')
		}
	}

	if (weights) {
		for (let i = 0; i < weights.length; i++) {
			const weight = weights[i]

			if (!Number.isFinite(weight) || weight < 0) {
				throw new Error(`weight at index ${i} must be finite and non-negative`)
			}
		}
	}

	return { rows, cols } as const
}

// Creates the base weights for weighted or robust least-squares fitting.
function initialLeastSquaresWeights(length: number, weights?: Readonly<NumberArray>) {
	const output = new Float64Array(length)

	if (!weights) {
		return output.fill(1)
	}

	for (let i = 0; i < length; i++) {
		const weight = weights[i]
		output[i] = Number.isFinite(weight) && weight > 0 ? weight : 0
	}

	return output
}

// Solves the least-squares system with QR and falls back to regularized normal equations if needed.
function solveLinearLeastSquares(design: readonly Readonly<NumberArray>[], target: Readonly<NumberArray>, weights: Readonly<NumberArray> | undefined, ridge: number) {
	if (design.length !== target.length) throw new Error('design matrix row count must match target length')

	const { rows, cols } = validateLeastSquaresInput(design, weights)

	if (cols === 0) return new Float64Array(0)

	const effectiveRidge = Math.max(ridge, 0)
	const augmentedRows = rows + (effectiveRidge > 0 ? cols : 0)
	const matrix = new Matrix(augmentedRows, cols)
	const matrixData = matrix.data
	const rhs = new Float64Array(augmentedRows)

	for (let i = 0; i < rows; i++) {
		const scale = Math.sqrt(weights?.[i] ?? 1)
		if (scale === 0) continue

		const row = design[i]
		const rowOffset = i * cols

		for (let j = 0; j < cols; j++) {
			matrixData[rowOffset + j] = row[j] * scale
		}

		rhs[i] = target[i] * scale
	}

	if (effectiveRidge > 0) {
		const diagonal = Math.sqrt(effectiveRidge)

		for (let i = 0; i < cols; i++) {
			matrixData[(rows + i) * cols + i] = diagonal
		}
	}

	const qr = new QrDecomposition(matrix)

	if (qr.isFullRank) {
		const solution = qr.solve(rhs)
		return solution.length === cols ? solution : solution.subarray(0, cols)
	}

	return solveRegularizedNormalEquations(design, target, weights, effectiveRidge > 0 ? effectiveRidge : DEFAULT_RIDGE)
}

// Solves the least-squares system through regularized normal equations.
function solveRegularizedNormalEquations(design: readonly Readonly<NumberArray>[], target: Readonly<NumberArray>, weights: Readonly<NumberArray> | undefined, ridge: number) {
	if (design.length !== target.length) throw new Error('design matrix row count must match target length')
	const { cols } = validateLeastSquaresInput(design, weights)
	const normalMatrix = buildNormalMatrix(design, weights, ridge)
	const normalVector = buildNormalVector(design, target, weights)
	return gaussianElimination(normalMatrix, normalVector, new Float64Array(cols))
}

// Builds the normal matrix XTWX with optional ridge regularization.
function buildNormalMatrix(design: readonly Readonly<NumberArray>[], weights: Readonly<NumberArray> | undefined, ridge: number) {
	const { rows, cols } = validateLeastSquaresInput(design, weights)
	const matrix = Matrix.square(cols)
	const data = matrix.data

	for (let i = 0; i < rows; i++) {
		const weight = weights?.[i] ?? 1
		if (weight === 0) continue

		const row = design[i]

		for (let j = 0; j < cols; j++) {
			const xj = row[j]
			if (xj === 0) continue

			const rowOffset = j * cols
			const weightedXj = xj * weight

			for (let k = j; k < cols; k++) {
				data[rowOffset + k] += weightedXj * row[k]
			}
		}
	}

	for (let j = 0; j < cols; j++) {
		data[j * cols + j] += ridge

		for (let k = 0; k < j; k++) {
			data[j * cols + k] = data[k * cols + j]
		}
	}

	return matrix
}

// Builds the weighted right-hand side XTWy.
function buildNormalVector(design: readonly Readonly<NumberArray>[], target: Readonly<NumberArray>, weights: Readonly<NumberArray> | undefined) {
	if (design.length !== target.length) throw new Error('design matrix row count must match target length')

	const { rows, cols } = validateLeastSquaresInput(design, weights)
	const vector = new Float64Array(cols)

	for (let i = 0; i < rows; i++) {
		const weight = weights?.[i] ?? 1
		if (weight === 0) continue

		const row = design[i]
		const weightedTarget = target[i] * weight

		for (let j = 0; j < cols; j++) {
			vector[j] += row[j] * weightedTarget
		}
	}

	return vector
}

// Estimates the least-squares condition number from the weighted normal matrix eigenvalues.
function estimateLeastSquaresConditionNumber(design: readonly Readonly<NumberArray>[], weights?: Readonly<NumberArray>) {
	const { cols } = validateLeastSquaresInput(design, weights)

	if (cols === 0) {
		return Number.POSITIVE_INFINITY
	}

	const eigenvalues = symmetricEigenvalues(buildNormalMatrix(design, weights, 0))
	let maxEigenvalue = 0

	for (let i = 0; i < eigenvalues.length; i++) {
		if (eigenvalues[i] > maxEigenvalue) {
			maxEigenvalue = eigenvalues[i]
		}
	}

	if (!(maxEigenvalue > 0)) {
		return Number.POSITIVE_INFINITY
	}

	const threshold = maxEigenvalue * 1e-12
	let minEigenvalue = Number.POSITIVE_INFINITY

	for (let i = 0; i < eigenvalues.length; i++) {
		const eigenvalue = eigenvalues[i]
		if (eigenvalue > threshold && eigenvalue < minEigenvalue) {
			minEigenvalue = eigenvalue
		}
	}

	return Number.isFinite(minEigenvalue) ? Math.sqrt(maxEigenvalue / minEigenvalue) : Number.POSITIVE_INFINITY
}

// Computes the eigenvalues of a symmetric matrix using Jacobi rotations.
function symmetricEigenvalues(matrix: Matrix) {
	const n = matrix.rows
	const a = matrix.clone()
	const data = a.data
	const maxSweep = Math.max(8, n * n * 8)

	for (let sweep = 0; sweep < maxSweep; sweep++) {
		let p = 0
		let q = 1
		let maxOffDiagonal = 0

		for (let i = 0; i < n; i++) {
			const rowOffset = i * n

			for (let j = i + 1; j < n; j++) {
				const value = Math.abs(data[rowOffset + j])

				if (value > maxOffDiagonal) {
					maxOffDiagonal = value
					p = i
					q = j
				}
			}
		}

		if (maxOffDiagonal <= 1e-14) {
			break
		}

		const pp = p * n + p
		const qq = q * n + q
		const pq = p * n + q
		const app = data[pp]
		const aqq = data[qq]
		const apq = data[pq]
		const angle = 0.5 * Math.atan2(2 * apq, aqq - app)
		const cosine = Math.cos(angle)
		const sine = Math.sin(angle)

		for (let k = 0; k < n; k++) {
			if (k === p || k === q) continue

			const kp = k * n + p
			const kq = k * n + q
			const akp = data[kp]
			const akq = data[kq]
			const rotatedP = cosine * akp - sine * akq
			const rotatedQ = sine * akp + cosine * akq
			data[kp] = rotatedP
			data[p * n + k] = rotatedP
			data[kq] = rotatedQ
			data[q * n + k] = rotatedQ
		}

		data[pp] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq
		data[qq] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq
		data[pq] = 0
		data[q * n + p] = 0
	}

	const eigenvalues = new Float64Array(n)

	for (let i = 0; i < n; i++) {
		eigenvalues[i] = data[i * n + i]
	}

	return eigenvalues
}

// Estimates the residual scale with MAD and falls back to RMS when needed.
function robustResidualScale(residuals: Readonly<NumberArray>) {
	const length = residuals.length

	if (length === 0) return 0

	const absoluteResiduals = new Float64Array(length)

	for (let i = 0; i < length; i++) {
		absoluteResiduals[i] = Math.abs(residuals[i])
	}

	let scale = medianOf(absoluteResiduals.sort()) / ROBUST_MAD_SCALE

	if (scale <= 0) {
		let sumSquares = 0

		for (let i = 0; i < length; i++) {
			sumSquares += residuals[i] * residuals[i]
		}

		scale = Math.sqrt(sumSquares / length)
	}

	return scale
}

// Reweights residuals according to the selected robust loss.
function reweightLeastSquares(baseWeights: Readonly<NumberArray>, residuals: Readonly<NumberArray>, scale: number, method: RobustRegressionMethod, tuning: number) {
	const output = new Float64Array(baseWeights.length)

	for (let i = 0; i < baseWeights.length; i++) {
		const baseWeight = baseWeights[i]

		if (baseWeight === 0) {
			output[i] = 0
			continue
		}

		const normalizedResidual = Math.abs(residuals[i]) / (Math.max(scale, Number.EPSILON) * tuning)
		const robustWeight = method === 'tukey' ? tukeyWeight(normalizedResidual) : huberWeight(normalizedResidual)
		output[i] = baseWeight * robustWeight
	}

	return output
}

// Computes the Huber IRLS weight.
function huberWeight(value: number) {
	return value <= 1 ? 1 : 1 / value
}

// Computes the Tukey biweight IRLS weight.
function tukeyWeight(value: number) {
	if (value >= 1) return 0
	const t = 1 - value * value
	return t * t
}

// Computes the maximum absolute coefficient delta between iterations.
function maxCoefficientDelta(previous: Readonly<NumberArray>, next: Readonly<NumberArray>) {
	let delta = 0

	for (let i = 0; i < previous.length; i++) {
		const difference = Math.abs(previous[i] - next[i])

		if (difference > delta) {
			delta = difference
		}
	}

	return delta
}

// Computes the maximum absolute weight delta between iterations.
function maxWeightDelta(previous: Readonly<NumberArray>, next: Readonly<NumberArray>) {
	let delta = 0

	for (let i = 0; i < previous.length; i++) {
		const difference = Math.abs(previous[i] - next[i])

		if (difference > delta) {
			delta = difference
		}
	}

	return delta
}
