import type { Point } from './geometry'
import type { NumberArray } from './math'
import { gaussianElimination, Matrix } from './matrix'
import { levenbergMarquardt } from './optimization'
import type { Writable } from './types'
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

export interface ChebyshevRegression extends Regression {
	readonly degree: number
	readonly coefficients: Readonly<NumberArray>
}

// Fits Chebyshev-basis coefficients T_0..T_degree with a QR least-squares solve.
export function chebyshevLeastSquares(x: Readonly<NumberArray>, y: Readonly<NumberArray>, degree: number): ChebyshevRegression {
	if (x.length !== y.length) throw new Error('chebyshev x and y arrays must have the same length')
	if (!Number.isInteger(degree) || degree < 0) throw new RangeError('chebyshev degree must be a non-negative integer')

	const rows = x.length
	const columns = degree + 1

	if (rows < columns) throw new RangeError(`chebyshev fit requires at least ${columns} samples`)

	const q = new Float64Array(rows * columns)
	const r = new Float64Array(columns * columns)
	const qty = new Float64Array(columns)
	const coefficients = new Float64Array(columns)

	// Build T_j(x_i) on the supplied normalized domain before orthogonalizing.
	for (let row = 0; row < rows; row++) {
		const xRow = x[row]
		const yRow = y[row]

		if (!Number.isFinite(xRow)) throw new RangeError(`chebyshev x value at index ${row} must be finite`)
		if (!Number.isFinite(yRow)) throw new RangeError(`chebyshev y value at index ${row} must be finite`)

		const offset = row * columns
		q[offset] = 1

		if (columns > 1) q[offset + 1] = xRow

		for (let column = 2; column < columns; column++) {
			q[offset + column] = 2 * xRow * q[offset + column - 1] - q[offset + column - 2]
		}
	}

	for (let column = 0; column < columns; column++) {
		let norm = 0

		for (let row = 0; row < rows; row++) {
			const value = q[row * columns + column]
			norm += value * value
		}

		norm = Math.sqrt(norm)

		if (!(norm > Number.EPSILON)) {
			throw new RangeError('chebyshev fit is rank deficient')
		}

		r[column * columns + column] = norm

		for (let row = 0; row < rows; row++) q[row * columns + column] /= norm

		let projection = 0

		for (let row = 0; row < rows; row++) projection += q[row * columns + column] * y[row]

		qty[column] = projection

		for (let next = column + 1; next < columns; next++) {
			projection = 0

			for (let row = 0; row < rows; row++) projection += q[row * columns + column] * q[row * columns + next]

			r[column * columns + next] = projection

			for (let row = 0; row < rows; row++) q[row * columns + next] -= projection * q[row * columns + column]
		}
	}

	for (let row = columns - 1; row >= 0; row--) {
		let value = qty[row]

		for (let column = row + 1; column < columns; column++) value -= r[row * columns + column] * coefficients[column]

		coefficients[row] = value / r[row * columns + row]
	}

	// Clenshaw evaluation is stable for Chebyshev basis coefficients.
	function predict(x: number) {
		let b1 = 0
		let b2 = 0

		for (let i = coefficients.length - 1; i >= 1; i--) {
			const b0 = 2 * x * b1 - b2 + coefficients[i]
			b2 = b1
			b1 = b0
		}

		return x * b1 - b2 + coefficients[0]
	}

	return {
		degree,
		coefficients,
		xPoints: x,
		yPoints: y,
		predict,
	}
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
	const regression = polynomialRegression(x, y, 2, interceptAtZero) as Writable<QuadraticRegression>
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
		slope = medianOf(data.subarray(0, slopesLength).sort())
	}

	// cuts

	for (let i = 0; i < n; i++) {
		data[i] = y[i] - slope * x[i]
	}

	// median

	const intercept = n === 0 ? Number.NaN : medianOf(data.subarray(0, n).sort())

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
	const r = denom === 0 ? Number.NaN : (n * sxy - sx * sy) / denom
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
