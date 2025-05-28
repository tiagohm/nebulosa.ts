import type { NumberArray } from './math'
import { LuDecomposition } from './matrix'

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

// Calculates intercept and slope using the ordinary least squares method
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

export function polynomialRegression(x: Readonly<NumberArray>, y: Readonly<NumberArray>, degree: number, interceptAtZero: boolean = false): PolynomialRegression {
	const n = Math.min(x.length, y.length)
	const powers = new Int32Array(interceptAtZero ? degree : degree + 1)

	if (interceptAtZero) {
		for (let k = 0; k < degree; k++) {
			powers[k] = k + 1
		}
	} else {
		for (let k = 0; k <= degree; k++) {
			powers[k] = k
		}
	}

	// Avoid creating a new Float64Array for each x value

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

	for (let j = 0; j < n; j++) {
		let s = 0

		for (let k = 0; k < y.length; k++) {
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

export function regressionScore(regression: Regression, x: Readonly<NumberArray>, y: Readonly<NumberArray>): RegressionScore {
	const n = Math.min(x.length, y.length)

	let sum = 0
	let ySquared = 0
	let sumY = 0
	let chi2 = 0

	for (let i = 0; i < n; i++) {
		const xi = x[i]
		const yi = y[i]
		const yiHat = regression.predict(xi)

		const d2 = (yi - yiHat) ** 2
		sum += d2
		ySquared += yi ** 2
		sumY += yi
		chi2 += d2 / yi
	}

	const r2 = 1 - sum / (ySquared - sumY ** 2 / n)
	const r = Math.sqrt(r2)
	const rmsd = Math.sqrt(sum / n)
	// const r2Adjusted = 1 - (1 - r2) * (n - 1) / (n - 2)

	return { r, r2, chi2, rmsd }
}
