import type { NumberArray } from './math'

const ZERO_POLYNOMIAL = [0] as const

export interface Spline {
	readonly lower: number
	readonly upper: number
	readonly coefficients: Readonly<NumberArray>
	// Computes the spline value through Horner evaluation in normalized coordinates.
	readonly compute: (value: number) => number
	// Builds the x-derivative spline and preserves constant splines as an explicit zero polynomial.
	readonly derivative: () => Spline
	// Builds the antiderivative spline with integral(lower) = constant.
	readonly integral: (constant?: number) => Spline
}

// Validates the spline interval and coefficient array, then returns the interval width.
function splineWidth(lower: number, upper: number, coefficients: Readonly<NumberArray>) {
	const width = upper - lower
	if (!Number.isFinite(width) || width === 0) throw new RangeError('spline interval must have a finite non-zero width')
	if (coefficients.length === 0) throw new RangeError('spline requires at least one coefficient')
	return width
}

// Creates a polynomial spline over a normalized [lower, upper] interval.
export function spline(lower: number, upper: number, coefficients: Readonly<NumberArray>): Spline {
	const width = splineWidth(lower, upper, coefficients)
	const invWidth = 1 / width
	const degree = coefficients.length - 1

	return {
		lower,
		upper,
		coefficients,
		compute: (value: number) => {
			const t = (value - lower) * invWidth
			let res = coefficients[0]
			for (let i = 1; i < coefficients.length; i++) res = res * t + coefficients[i]
			return res
		},
		derivative: () => {
			if (degree === 0) return spline(lower, upper, ZERO_POLYNOMIAL)

			const c = new Float64Array(degree)
			const n = degree
			for (let i = 0; i < n; i++) c[i] = ((n - i) * coefficients[i]) / width
			return spline(lower, upper, c)
		},
		integral: (constant: number = 0) => {
			const n = coefficients.length
			const c = new Float64Array(n + 1)
			for (let i = 0; i < n; i++) c[i] = (coefficients[i] * width) / (n - i)
			c[n] = constant
			return spline(lower, upper, c)
		},
	}
}

// Creates a cubic Hermite spline constrained by endpoint values and endpoint slopes.
export function splineGivenEnds(x0: number, y0: number, slope0: number, x1: number, y1: number, slope1: number): Spline {
	const width = x1 - x0
	const dy = y1 - y0
	const s0 = slope0 * width
	const s1 = slope1 * width
	const a2 = 3 * dy - 2 * s0 - s1
	const a3 = s0 + s1 - 2 * dy
	return spline(x0, x1, [a3, a2, s0, y0])
}
