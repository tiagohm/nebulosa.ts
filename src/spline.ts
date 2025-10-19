import type { NumberArray } from './math'

export interface Spline {
	readonly lower: number
	readonly upper: number
	readonly coefficients: Readonly<NumberArray>
	readonly compute: (value: number) => number
	readonly derivative: () => Spline
}

// Creates spline curve
export function spline(lower: number, upper: number, coefficients: Readonly<NumberArray>): Spline {
	return {
		lower,
		upper,
		coefficients,
		compute: (value) => {
			const width = upper - lower
			const t = (value - lower) / width
			let res = coefficients[0]
			for (let i = 1; i < coefficients.length; i++) res = res * t + coefficients[i]
			return res
		},
		derivative: () => {
			const c = new Float64Array(coefficients.length - 1)
			const width = upper - lower
			const n = c.length
			for (let i = 0; i < n; i++) c[i] = ((n - i) * coefficients[i]) / width
			return spline(lower, upper, c)
		},
	}
}

export function splineGivenEnds(x0: number, y0: number, slope0: number, x1: number, y1: number, slope1: number) {
	const width = x1 - x0
	const s0 = slope0 * width
	const s1 = slope1 * width
	const a2 = -2 * s0 - s1 - 3 * y0 + 3 * y1
	const a3 = s0 + s1 + 2 * y0 - 2 * y1
	return spline(x0, x1, [a3, a2, s0, y0])
}
