import type { NumberArray } from './math'

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

// Calculates intercept and slope using the ordinary least squares method
// https://en.wikipedia.org/wiki/Ordinary_least_squares
export function simpleLinearRegression(x: NumberArray, y: NumberArray): LinearRegression {
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

export function regressionScore(regression: Regression, x: NumberArray, y: NumberArray): RegressionScore {
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
