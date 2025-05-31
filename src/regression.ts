import { isNumberArray, minOf } from './helper'
import type { NumberArray } from './math'
import { LuDecomposition, gaussianElimination } from './matrix'

export type TrendLineRegressionMethod = 'simple' | 'theil-sen'

export interface Regression {
	readonly predict: (x: number) => number
}

export interface InverseRegression {
	readonly x: (x: number) => number
}

export interface RegressionScore {
	readonly r: number
	readonly r2: number
	readonly chi2: number
	readonly rmsd: number
}

export interface LinearRegression extends Regression, InverseRegression {
	readonly slope: number
	readonly intercept: number
}

export interface PolynomialRegression extends Regression {
	readonly coefficients: Float64Array
}

export interface ExponentialRegression extends Regression, InverseRegression {
	readonly a: number
	readonly b: number
}

export interface HyperbolicRegression extends Regression, InverseRegression {
	readonly a: number
	readonly b: number
	readonly p: number
	readonly minimum: readonly [number, number]
}

export interface TrendLineRegression extends Regression {
	readonly left: LinearRegression
	readonly right: LinearRegression
	readonly minimum: readonly [number, number]
	readonly intersection: readonly [number, number]
}

export interface LevenbergMarquardtOptions {
	maxIterations?: number
	lambda?: number
	tolerance?: number
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

	// https://github.com/mljs/regression-polynomial/blob/ce1c94bcb03f0f244ef26bae6ba7529bcdd8894e/src/index.ts#L183C18-L183C37

	// DxN * NxD = DxD
	// const A = mulMTxN(F, F) // Fᵀ*F
	const A = new Float64Array(powers.length * powers.length)

	for (let i = 0, p = 0; i < powers.length; i++) {
		for (let j = 0; j < powers.length; j++, p++) {
			let s = 0

			for (let k = 0; k < n; k++) {
				const s0 = powers[i] === 0 ? 1 : x[k] ** powers[i]
				const s1 = powers[j] === 0 ? 1 : x[k] ** powers[j]

				s += s0 * s1
			}

			A[p] = s
		}
	}

	// 1xN * NxD = 1xD
	// const B = mulMxN([y], F) // Fᵀ*Yᵀ = (Y*F)ᵀ
	const B = new Float64Array(powers.length)

	for (let j = 0; j < powers.length; j++) {
		let s = 0

		for (let k = 0; k < n; k++) {
			const s1 = powers[j] === 0 ? 1 : x[k] ** powers[j]

			s += y[k] * s1
		}

		B[j] = s
	}

	// Solve A*x=B
	const LU = new LuDecomposition(A)
	const coefficients = LU.solve(B)

	return {
		coefficients: new Float64Array(coefficients),
		predict: (x) => {
			let y = 0
			for (let k = 0; k < powers.length; k++) y += coefficients[k] * x ** powers[k]
			return y
		},
	}
}

// https://en.wikipedia.org/wiki/Theil%E2%80%93Sen_estimator
// Computes the coefficients of a linear regression using the Theil-Sen method
export function theilSenRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): LinearRegression {
	const data = new Float64Array(x.length * x.length)

	// slopes

	let n = 0

	for (let i = 0; i < x.length; ++i) {
		for (let j = i + 1; j < x.length; ++j) {
			if (x[i] !== x[j]) {
				data[n++] = (y[j] - y[i]) / (x[j] - x[i])
			}
		}
	}

	data.subarray(0, n).sort()

	// median
	const slope = n % 2 === 0 ? (data[n / 2 - 1] + data[n / 2]) / 2 : data[Math.floor(n / 2)]

	// cuts

	n = x.length

	for (let i = 0; i < n; i++) {
		data[i] = y[i] - slope * x[i]
	}

	data.subarray(0, n).sort()

	// median
	const intercept = n % 2 === 0 ? (data[n / 2 - 1] + data[n / 2]) / 2 : data[Math.floor(n / 2)]

	return {
		slope,
		intercept,
		predict: (x: number) => slope * x + intercept,
		x: (y: number) => (y - intercept) / slope,
	}
}

// Computes the coefficients of a trend line regression, which is a piecewise linear regression with a minimum point
export function trendLineRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>, method: TrendLineRegressionMethod = 'simple'): TrendLineRegression {
	const minimum = minOf(y)
	const minY = minimum[0]
	const minX = x[minimum[1]]

	const a = new Array<number>()
	const b = new Array<number>()
	const c = new Array<number>()
	const d = new Array<number>()

	for (let i = 0; i < x.length; i++) {
		const xi = x[i]
		const yi = y[i]

		if (xi < minX && yi > minY) {
			a.push(xi)
			b.push(yi)
		}
		if (xi > minX && yi > minY) {
			c.push(xi)
			d.push(yi)
		}
	}

	const regression = method === 'theil-sen' ? theilSenRegression : simpleLinearRegression
	const left = regression(a, b)
	const right = regression(c, d)

	return {
		left,
		right,
		minimum: [minX, minY],
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
		a,
		b,
		predict: (x: number) => a * x ** b,
		x: (y: number) => (a && b ? (y / a) ** (1 / b) : 0), // Math.exp(Math.log(y / a) / b)
	}
}

export function hyperbolicRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>): HyperbolicRegression {
	const n = Math.min(x.length, y.length)

	const lowestPoint: [number, number] = [x[0], y[0]]
	const highestPoint: [number, number] = [x[0], y[0]]

	for (let i = 1; i < n; i++) {
		if (y[i] < lowestPoint[1]) {
			lowestPoint[0] = x[i]
			lowestPoint[1] = y[i]
		}
		if (y[i] > highestPoint[1]) {
			highestPoint[0] = x[i]
			highestPoint[1] = y[i]
		}
	}

	// Always go up
	if (highestPoint[0] < lowestPoint[0]) {
		highestPoint[0] = 2 * lowestPoint[0] - highestPoint[0]
	}

	const ae = lowestPoint[1] // y(0) = a * cosh(0) = a * 1 = a
	// const be = highestPoint[0] / Math.acosh(highestPoint[1] / ae) // b = x / arcosh(y/a)
	// Alternative hyperbola formula: sqrt(y)/sqrt(a)-sqrt(x)/sqrt(b)=1 ==>  sqrt(b)=sqrt(x)*sqrt(a)/(sqrt(y)-sqrt(a)
	const be = Math.sqrt(((highestPoint[0] - lowestPoint[0]) * (highestPoint[0] - lowestPoint[0]) * ae * ae) / (highestPoint[1] * highestPoint[1] - ae * ae))
	const pe = lowestPoint[0]

	function hyperbolic(x: number, [a, b, p]: number[]) {
		return a * Math.cosh(Math.asinh((p - x) / b))
	}

	// Use Levenberg-Marquardt to optimize the parameters a and b
	const [a, b, p] = levenbergMarquardt(x, y, hyperbolic, [ae, be, pe], { maxIterations: 1000, tolerance: 1e-8 })

	return {
		a,
		b,
		p,
		minimum: [p, a],
		predict: (x: number) => a * Math.cosh(Math.asinh((p - x) / b)),
		// https://www.wolframalpha.com/input?i=isolate+x+for+y+%3D+a+*+cosh%28asinh%28%28p+-+x%29+%2F+b%29%29
		x: (y: number) => (y > a ? Math.sqrt(b * b * (y * y - a * a)) / a + p : p),
	}
}

// Computes the score of a regression against a set of x and y values
// Returns the correlation coefficient (r), coefficient of determination (r²), chi-squared statistic, and root mean square deviation (RMSD)
export function regressionScore(regression: Regression, x: Readonly<NumberArray>, y: Readonly<NumberArray>): RegressionScore {
	const n = Math.min(x.length, y.length)

	let sum = 0
	let ySquared = 0
	let sumY = 0
	let chi2 = 0

	for (let i = 0; i < n; i++) {
		const yi = y[i]
		const yp = regression.predict(x[i])

		const d2 = (yi - yp) ** 2
		sum += d2
		ySquared += yi ** 2
		sumY += yi
		if (yi !== 0) chi2 += d2 / yi
	}

	const r2 = 1 - sum / (ySquared - sumY ** 2 / n)
	const r = Math.sqrt(r2)
	const rmsd = Math.sqrt(sum / n)

	return { r, r2, chi2, rmsd }
}

export function intersect(a: LinearRegression, b: LinearRegression): readonly [number, number] {
	// Parallel lines do not intersect
	if (a.slope === b.slope) return [0, 0]

	const x = (b.intercept - a.intercept) / (a.slope - b.slope)
	const y = a.slope * x + a.intercept

	return [x, y]
}

const LEVENBERG_MARQUARDT_DELTA = 1e-8

// Computes the coefficients of a Levenberg-Marquardt regression
// This is a non-linear least squares optimization algorithm
// It minimizes the sum of squared residuals between the model and the data
export function levenbergMarquardt(x: Readonly<NumberArray>, y: Readonly<NumberArray>, model: (x: number, params: number[]) => number, params: number[], { maxIterations = 100, lambda = 0.01, tolerance = 1e-6 }: LevenbergMarquardtOptions = {}) {
	const n = Math.min(x.length, y.length)
	const m = params.length

	const J = new Array<NumberArray>(m)
	const PJ = new Array<number>(m)
	const JTJ = new Array<Float64Array>(m)
	const JTR = new Float64Array(m)

	const R = new Float64Array(n)
	const UP = new Array<number>(m)
	const DP = new Float64Array(m)

	const YP = new Float64Array(n)
	const YPJ = new Float64Array(n)

	for (let i = 0; i < m; i++) {
		J[i] = new Float64Array(n)
		JTJ[i] = new Float64Array(m)
	}

	const predict = (params: number[], o: NumberArray) => {
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
			// Jᵀ * J
			for (let j = 0; j < m; j++) {
				JTJ[i][j] = (J[i] as number[]).reduce((sum, v, k) => sum + v * J[j][k], 0)
			}

			// Jᵀ * residuals
			JTR[i] = (J[i] as number[]).reduce((sum, v, k) => sum + v * R[k], 0)
		}

		for (let i = 0; i < m; i++) {
			JTJ[i][i] *= 1 + lambda
		}

		// Solve JTJ * dp = JTr
		gaussianElimination(JTJ, JTR, DP)

		// Update parameters
		for (let i = 0; i < m; i++) UP[i] = params[i] + DP[i]
		const error = R.reduce((sum, r) => sum + r * r, 0)
		const newError = (y as number[]).reduce((sum, r, i) => sum + (r - model(x[i], UP)) ** 2, 0)

		if (newError < error) {
			params = UP
			if (Math.abs(error - newError) < tolerance) break
			lambda /= 10
		} else {
			lambda *= 10
		}
	}

	return params
}
