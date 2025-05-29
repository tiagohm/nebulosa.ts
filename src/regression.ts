import { isNumberArray, minOf } from './helper'
import type { NumberArray } from './math'
import { LuDecomposition } from './matrix'

export type TrendLineRegressionMethod = 'simple' | 'theil-sen'

export interface Regression {
	readonly predict: (x: number) => number
}

export interface RegressionScore {
	readonly r: number
	readonly r2: number
	readonly chi2: number
	readonly rmsd: number
}

export interface LinearRegression extends Regression {
	readonly slope: number
	readonly intercept: number
	readonly x: (y: number) => number
}

export interface PolynomialRegression extends Regression {
	readonly coefficients: Float64Array
}

export interface ExponentialRegression extends Regression {
	readonly a: number
	readonly b: number
	readonly x: (y: number) => number
}

export interface TrendLineRegression extends Regression {
	readonly left: LinearRegression
	readonly right: LinearRegression
	readonly minimum: readonly [number, number]
	readonly intersection: readonly [number, number]
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
		x: (y: number) => Math.exp(Math.log(y / a) / b) || 0,
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
	// const r2Adjusted = 1 - (1 - r2) * (n - 1) / (n - 2)

	return { r, r2, chi2, rmsd }
}

export function intersect(a: LinearRegression, b: LinearRegression): readonly [number, number] {
	// Parallel lines do not intersect
	if (a.slope === b.slope) return [0, 0]

	const x = (b.intercept - a.intercept) / (a.slope - b.slope)
	const y = a.slope * x + a.intercept

	return [x, y]
}
