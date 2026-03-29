import type { Mutable } from 'utility-types'
import type { Point } from './geometry'
import type { NumberArray } from './math'
import { gaussianElimination, Matrix, QrDecomposition } from './matrix'
import { isNumberArray, meanOf, medianOf, minOf } from './util'

export type TrendLineRegressionMethod = 'simple' | 'theil-sen'

export interface Regression {
	readonly xPoints: Readonly<NumberArray>
	readonly yPoints: Readonly<NumberArray>
	readonly predict: (x: number) => number
}

export interface InverseRegression {
	readonly x: (y: number) => number
}

export interface MinimumPointRegression {
	readonly minimum: Readonly<Point>
}

export interface RegressionScore {
	readonly r: number
	readonly r2: number
	readonly rss: number
	readonly rmsd: number
}

export interface LinearRegression extends Regression, InverseRegression {
	readonly slope: number
	readonly intercept: number
}

export interface PolynomialRegression extends Regression {
	readonly coefficients: number[]
}

export interface QuadraticRegression extends PolynomialRegression, MinimumPointRegression {}

export interface ExponentialRegression extends Regression, InverseRegression {
	readonly a: number
	readonly b: number
}

export interface HyperbolicRegression extends Regression, InverseRegression, MinimumPointRegression {
	readonly a: number
	readonly b: number
	readonly c: number
}

export interface TrendLineRegression extends Regression, MinimumPointRegression {
	readonly left: LinearRegression
	readonly right: LinearRegression
	readonly intersection: Readonly<Point>
}

export interface LevenbergMarquardtOptions {
	maxIterations?: number
	lambda?: number
	tolerance?: number
}

export type RobustRegressionMethod = 'none' | 'huber' | 'tukey'

export interface LinearLeastSquaresOptions {
	readonly weights?: Readonly<NumberArray>
	readonly ridge?: number
}

export interface LinearLeastSquaresResult {
	readonly coefficients: Readonly<NumberArray>
	readonly fitted: Readonly<NumberArray>
	readonly residuals: Readonly<NumberArray>
	readonly conditionNumber: number
	readonly rankDeficient: boolean
}

export interface RobustLinearLeastSquaresOptions extends LinearLeastSquaresOptions {
	readonly method?: RobustRegressionMethod
	readonly maxIterations?: number
	readonly tolerance?: number
	readonly tuning?: number
}

export interface RobustLinearLeastSquaresResult extends LinearLeastSquaresResult {
	readonly weights: Readonly<NumberArray>
	readonly iterations: number
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

// Computes intercept and slope using the ordinary least squares method
// https://en.wikipedia.org/wiki/Ordinary_least_squares
export function simpleLinearRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): LinearRegression {
	const n = Math.min(x.length, y.length)

	let xSum = 0
	let ySum = 0
	let xSquared = 0
	let xy = 0

	for (let i = 0; i < n; i++) {
		xSum += x[i]
		ySum += y[i]
		xSquared += x[i] * x[i]
		xy += x[i] * y[i]
	}

	const numerator = n * xy - xSum * ySum
	const slope = numerator / (n * xSquared - xSum * xSum)
	const intercept = (1 / n) * ySum - slope * (1 / n) * xSum

	return {
		xPoints: x,
		yPoints: y,
		slope,
		intercept,
		predict: (x: number) => slope * x + intercept,
		x: (y: number) => (y - intercept) / slope,
	}
}

// Computes the coefficients of a polynomial regression
export function polynomialRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>, degree: number | NumberArray, interceptAtZero: boolean = false): PolynomialRegression {
	let powers: NumberArray

	if (isNumberArray(degree)) {
		powers = degree
		interceptAtZero = false
	} else {
		powers = new Float64Array(interceptAtZero ? degree : degree + 1)

		if (interceptAtZero) {
			for (let k = 0; k < degree; k++) {
				powers[k] = k + 1
			}
		} else {
			for (let k = 0; k <= degree; k++) {
				powers[k] = k
			}
		}
	}

	// Avoid creating a matrix of powers, but the drawback is that we have to calculate the powers on the fly

	// const F = new Array<Float64Array>(n)

	// for (let i = 0; i < n; i++) {
	// 	F[i] = new Float64Array(powers.length)

	// 	for (let k = 0; k < powers.length; k++) {
	// 		if (powers[k] === 0) {
	// 			F[i][k] = 1
	// 		} else {
	// 			F[i][k] = x[i] ** powers[k]
	// 		}
	// 	}
	// }

	const n = Math.min(x.length, y.length)
	const p = powers.length

	// https://github.com/mljs/regression-polynomial/blob/ce1c94bcb03f0f244ef26bae6ba7529bcdd8894e/src/index.ts#L183C18-L183C37

	// DxN * NxD = DxD
	// const A = mulMTxN(F, F) // Fᵀ*F
	const A = Matrix.square(p)
	const AData = A.data

	// 1xN * NxD = 1xD
	// const B = mulMxN([y], F) // Fᵀ*Yᵀ = (Y*F)ᵀ
	const B = new Float64Array(p)
	const basis = new Float64Array(p)

	for (let k = 0; k < n; k++) {
		const xk = x[k]
		const yk = y[k]

		for (let i = 0; i < p; i++) {
			basis[i] = powers[i] === 0 ? 1 : xk ** powers[i]
		}

		for (let i = 0; i < p; i++) {
			const bi = basis[i]
			B[i] += yk * bi

			const iOffset = i * p

			for (let j = i; j < p; j++) {
				AData[iOffset + j] += bi * basis[j]
			}
		}
	}

	for (let i = 1; i < p; i++) {
		const iOffset = i * p

		for (let j = 0; j < i; j++) {
			AData[iOffset + j] = AData[j * p + i]
		}
	}

	// Solve A*x=B
	// const LU = new LuDecomposition(A)
	// const coefficients = LU.solve(B)
	const coefficients = gaussianElimination(A, B, B)

	return {
		xPoints: x,
		yPoints: y,
		coefficients: Array.isArray(coefficients) ? coefficients : Array.from(coefficients),
		predict: (x) => {
			let y = 0
			for (let k = 0; k < p; k++) y += coefficients[k] * x ** powers[k]
			return y
		},
	}
}

// Computes the coefficients of a quadratic regression
export function quadraticRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>, interceptAtZero?: boolean): QuadraticRegression {
	const regression = polynomialRegression(x, y, 2, interceptAtZero) as Mutable<QuadraticRegression>
	const coefficients = regression.coefficients
	const a = coefficients.length === 2 ? coefficients[1] : coefficients[2]
	const b = coefficients.length === 2 ? coefficients[0] : coefficients[1]
	const c = coefficients.length === 2 ? 0 : coefficients[0]
	const d = 2 * a
	const e = 2 * d // 4a
	const b2 = b * b
	regression.minimum = { x: -b / d, y: c - b2 / e }
	return regression
}

// https://en.wikipedia.org/wiki/Theil%E2%80%93Sen_estimator
// Computes the coefficients of a linear regression using the Theil-Sen method
export function theilSenRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): LinearRegression {
	const n = Math.min(x.length, y.length)
	const pairCount = (n * (n - 1)) / 2
	const data = new Float64Array(Math.max(pairCount, n))

	function median(values: Readonly<NumberArray>, length: number) {
		return length % 2 === 0 ? (values[length / 2 - 1] + values[length / 2]) / 2 : values[Math.floor(length / 2)]
	}

	// slopes

	let slopesLength = 0

	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (x[i] !== x[j]) {
				data[slopesLength++] = (y[j] - y[i]) / (x[j] - x[i])
			}
		}
	}

	let slope = 0

	if (slopesLength > 0) {
		data.subarray(0, slopesLength).sort()
		slope = median(data, slopesLength)
	}

	// cuts

	for (let i = 0; i < n; i++) {
		data[i] = y[i] - slope * x[i]
	}

	data.subarray(0, n).sort()

	// median
	const intercept = n === 0 ? Number.NaN : median(data, n)

	return {
		xPoints: x,
		yPoints: y,
		slope,
		intercept,
		predict: (x: number) => slope * x + intercept,
		x: (y: number) => (y - intercept) / slope,
	}
}

// Computes the coefficients of a trend line regression, which is a piecewise linear regression with a minimum point
export function trendLineRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>, method: TrendLineRegressionMethod = 'simple'): TrendLineRegression {
	const n = Math.min(x.length, y.length)
	const minimum = minOf(y)
	const minY = minimum[0]
	const minX = x[minimum[1]]

	const a = new Float64Array(n)
	const b = new Float64Array(n)
	const c = new Float64Array(n)
	const d = new Float64Array(n)

	let abn = 0
	let cdn = 0

	for (let i = 0; i < n; i++) {
		const xi = x[i]
		const yi = y[i]

		if (xi < minX && yi > minY) {
			a[abn] = xi
			b[abn++] = yi
		}
		if (xi > minX && yi > minY) {
			c[cdn] = xi
			d[cdn++] = yi
		}
	}

	const regression = method === 'theil-sen' ? theilSenRegression : simpleLinearRegression
	const left = regression(a.subarray(0, abn), b.subarray(0, abn))
	const right = regression(c.subarray(0, cdn), d.subarray(0, cdn))

	return {
		xPoints: x,
		yPoints: y,
		left,
		right,
		minimum: { x: minX, y: minY },
		intersection: intersect(left, right),
		predict: (x: number) => (x < minX ? left.predict(x) : x > minX ? right.predict(x) : minY),
	}
}

// Computes the coefficients of an exponential regression of the form y = b * exp(a * x)
export function exponentialRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): ExponentialRegression {
	const n = Math.min(x.length, y.length)
	const logY = new Float64Array(n)

	for (let i = 0; i < n; i++) {
		logY[i] = Math.log(y[i])
	}

	const regression = simpleLinearRegression(x, logY)
	const a = regression.slope
	const b = Math.exp(regression.intercept)

	return {
		xPoints: x,
		yPoints: y,
		a,
		b,
		predict: (x: number) => b * Math.exp(a * x),
		x: (y: number) => Math.log(y / b) / a,
	}
}

// Computes the coefficients of a power regression of the form y = A * x^B
export function powerRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): ExponentialRegression {
	const n = Math.min(x.length, y.length)
	const logX = new Float64Array(n)
	const logY = new Float64Array(n)

	for (let i = 0; i < n; i++) {
		logX[i] = Math.log(x[i])
		logY[i] = Math.log(y[i])
	}

	const regression = simpleLinearRegression(logX, logY)
	const a = Math.exp(regression.intercept)
	const b = regression.slope

	return {
		xPoints: x,
		yPoints: y,
		a,
		b,
		predict: (x: number) => a * x ** b,
		x: (y: number) => (a && b ? (y / a) ** (1 / b) : 0), // Math.exp(Math.log(y / a) / b)
	}
}

// Computes the coefficients of a hyperbolic regression of the form y = b * sqrt(1 + ((x - c) / a)^2)
export function hyperbolicRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): HyperbolicRegression {
	// Get the initial guess for A, for A, we take the mean value of the y
	const A = meanOf(y)

	// Get the initial guess for B, for B, we take the min value of the y
	const B = minOf(y)[0]

	// Get the initial guess for C, for C, we take the mean value of the x
	const C = meanOf(x)

	// https://github.com/observerly/iris/blob/main/pkg/vcurve/vcurve.go
	function hyperbolic(x: number, [a, b, c]: NumberArray) {
		return b * Math.sqrt(1 + ((x - c) / a) ** 2)
	}

	// Use Levenberg-Marquardt to optimize the parameters
	const [a, b, c] = levenbergMarquardt(x, y, hyperbolic, [Math.round(A), B, C], { maxIterations: 1000, tolerance: 1e-8 })

	return {
		xPoints: x,
		yPoints: y,
		a,
		b,
		c,
		minimum: { x: c, y: b },
		predict: (x: number) => b * Math.sqrt(1 + ((x - c) / a) ** 2),
		// wolfram: solve y = b sqrt(1 + ((x - c)/a)^2) for x
		// x = c - sqrt(a^2 y^2 - a^2 b^2)/b
		x: (y: number) => c - Math.sqrt(a * a * (y * y - b * b)) / b,
	}
}

// Computes the score of a regression against a set of x and y values
// Returns the correlation coefficient (r), coefficient of determination (r²), residual sum of squares (RSS), and root mean square deviation (RMSD)
export function regressionScore(regression: Regression, x: Readonly<NumberArray> = regression.xPoints, y: Readonly<NumberArray> = regression.yPoints): RegressionScore {
	const n = Math.min(x.length, y.length)

	let sx = 0
	let sx2 = 0
	let sy = 0
	let sy2 = 0
	let sxy = 0
	let rss = 0

	for (let i = 0; i < n; i++) {
		const xi = x[i]
		const yi = y[i]
		const p = regression.predict(xi)

		sx += xi
		sx2 += xi * xi
		sy += yi
		sy2 += yi * yi
		sxy += xi * yi

		const d = yi - p
		rss += d * d
	}

	const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy))
	const r = denom === 0 ? NaN : (n * sxy - sx * sy) / denom
	const r2 = r * r
	const rmsd = Math.sqrt(rss / n)

	return { r, r2, rss, rmsd }
}

export function intersect(a: LinearRegression, b: LinearRegression): Readonly<Point> {
	// Parallel lines do not intersect
	if (a.slope === b.slope) return { x: 0, y: 0 }

	const x = (b.intercept - a.intercept) / (a.slope - b.slope)
	const y = a.slope * x + a.intercept

	return { x, y }
}

const LEVENBERG_MARQUARDT_DELTA = 1e-8

// Computes the coefficients of a Levenberg-Marquardt regression
// This is a non-linear least squares optimization algorithm
// It minimizes the sum of squared residuals between the model and the data
export function levenbergMarquardt(x: Readonly<NumberArray>, y: Readonly<NumberArray>, model: (x: number, params: NumberArray) => number, params: number[], { maxIterations = 100, lambda = 0.01, tolerance = 1e-6 }: LevenbergMarquardtOptions = {}) {
	const n = Math.min(x.length, y.length)
	const m = params.length

	const J = new Array<Float64Array>(m)
	const PJ = new Float64Array(m)
	const JTJ = Matrix.square(m)
	const JTJData = JTJ.data
	const JTR = new Float64Array(m)

	const R = new Float64Array(n)
	const UP = new Float64Array(m)
	const DP = new Float64Array(m)

	const YP = new Float64Array(n)
	const YPJ = new Float64Array(n)

	for (let i = 0; i < m; i++) {
		J[i] = new Float64Array(n)
	}

	const predict = (params: NumberArray, o: NumberArray) => {
		for (let i = 0; i < o.length; i++) o[i] = model(x[i], params)
	}

	while (maxIterations-- > 0) {
		predict(params, YP)

		// residual
		for (let i = 0; i < n; i++) R[i] = y[i] - YP[i]

		// Jacobian
		for (let j = 0; j < m; j++) {
			for (let k = 0; k < m; k++) PJ[k] = params[k]
			PJ[j] += LEVENBERG_MARQUARDT_DELTA
			predict(PJ, YPJ)

			for (let k = 0; k < n; k++) {
				J[j][k] = (YPJ[k] - YP[k]) / LEVENBERG_MARQUARDT_DELTA
			}
		}

		// Jᵀ * J and Jᵀ * r
		for (let i = 0; i < m; i++) {
			const Ji = J[i]

			let sum = 0
			for (let k = 0; k < n; k++) sum += Ji[k] * R[k]
			JTR[i] = sum

			const iOffset = i * m

			for (let j = i; j < m; j++) {
				const Jj = J[j]

				let dot = 0
				for (let k = 0; k < n; k++) dot += Ji[k] * Jj[k]

				JTJData[iOffset + j] = dot
				JTJData[j * m + i] = dot
			}
		}

		for (let i = 0, p = 0; i < m; i++, p += m) {
			JTJData[p + i] *= 1 + lambda
		}

		// Solve JTJ * dp = JTr
		gaussianElimination(JTJ, JTR, DP)

		if (Number.isNaN(DP[0])) break

		// Update parameters
		for (let i = 0; i < m; i++) UP[i] = params[i] + DP[i]
		predict(UP, YPJ)

		let error = 0
		let newError = 0

		for (let i = 0; i < n; i++) {
			const ri = R[i]
			const di = y[i] - YPJ[i]
			error += ri * ri
			newError += di * di
		}

		if (newError < error) {
			for (let i = 0; i < m; i++) params[i] = UP[i]
			if (Math.abs(error - newError) <= tolerance) break
			lambda /= 10
		} else {
			lambda *= 10
		}
	}

	return params
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

	const effectiveRidge = ridge > 0 ? ridge : 0
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

// Builds the normal matrix XᵀWX with optional ridge regularization.
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

// Builds the weighted right-hand side XᵀWy.
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
