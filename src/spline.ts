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

export interface InterpolatingSpline {
	readonly x: Readonly<NumberArray>
	readonly y: Readonly<NumberArray>
	readonly slopes: Readonly<NumberArray>
	// Computes the interpolated value on the piecewise cubic spline.
	readonly compute: (value: number) => number
}

// Validates the spline interval and coefficient array, then returns the interval width.
function splineWidth(lower: number, upper: number, coefficients: Readonly<NumberArray>) {
	const width = upper - lower
	if (!Number.isFinite(width) || width === 0) throw new Error('spline interval must have a finite non-zero width')
	if (coefficients.length === 0) throw new Error('spline requires at least one coefficient')
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

// Evaluates one cubic Hermite segment at normalized parameter t in [0,1].
function cubicHermiteSegment(y0: number, m0: number, y1: number, m1: number, h: number, t: number) {
	const t2 = t * t
	const t3 = t2 * t
	return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1
}

// Validates point arrays for a piecewise interpolating spline and returns the point count.
function interpolatingSplinePointCount(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = x.length

	if (n !== y.length) throw new Error('spline x and y arrays must have the same length')
	if (n < 2) throw new Error('spline requires at least two points')

	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) throw new Error('spline control points must be finite')
		if (i > 0 && !(x[i] > x[i - 1])) throw new Error('spline x coordinates must be strictly increasing')
	}

	return n
}

// Builds the shared evaluator used by the cubic Hermite-family interpolators.
function interpolatingSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, slopes: Readonly<NumberArray>): InterpolatingSpline {
	const last = x.length - 1

	return {
		x,
		y,
		slopes,
		compute: (value: number) => {
			if (value <= x[0]) return y[0]
			if (value >= x[last]) return y[last]

			let low = 0
			let high = last - 1

			while (low <= high) {
				const mid = (low + high) >> 1
				if (value < x[mid]) high = mid - 1
				else if (value > x[mid + 1]) low = mid + 1
				else {
					const width = x[mid + 1] - x[mid]
					return cubicHermiteSegment(y[mid], slopes[mid], y[mid + 1], slopes[mid + 1], width, (value - x[mid]) / width)
				}
			}

			return y[last]
		},
	}
}

// Samples a piecewise cubic spline into a dense LUT over its full x-range.
function interpolatingSplineLUT(x: Readonly<NumberArray>, y: Readonly<NumberArray>, slopes: Readonly<NumberArray>, size: number) {
	if (!Number.isFinite(size) || size < 2) throw new Error('spline LUT size must be at least two')

	const output = new Float32Array(size)
	const last = x.length - 1
	const lower = x[0]
	const upper = x[last]
	const scale = (upper - lower) / (size - 1)
	let segment = 0

	for (let i = 0; i < size; i++) {
		const value = lower + scale * i

		if (value <= lower) {
			output[i] = y[0]
			continue
		}

		if (value >= upper) {
			output[i] = y[last]
			continue
		}

		while (segment + 1 < last && value > x[segment + 1]) segment++

		const width = x[segment + 1] - x[segment]
		output[i] = cubicHermiteSegment(y[segment], slopes[segment], y[segment + 1], slopes[segment + 1], width, (value - x[segment]) / width)
	}

	return output
}

// Computes shape-preserving slopes using the Fritsch-Carlson monotone cubic Hermite recipe.
function cubicHermiteSlopes(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = interpolatingSplinePointCount(x, y)

	const h = new Float64Array(n - 1)
	const d = new Float64Array(n - 1)
	const slopes = new Float64Array(n)

	for (let i = 0; i < n - 1; i++) {
		const width = x[i + 1] - x[i]
		h[i] = width
		d[i] = (y[i + 1] - y[i]) / width
	}

	if (n === 2) {
		slopes[0] = d[0]
		slopes[1] = d[0]
		return slopes
	}

	let slope0 = ((2 * h[0] + h[1]) * d[0] - h[0] * d[1]) / (h[0] + h[1])

	if (slope0 * d[0] <= 0) slope0 = 0
	else if (d[0] * d[1] < 0 && Math.abs(slope0) > Math.abs(3 * d[0])) slope0 = 3 * d[0]

	slopes[0] = slope0

	for (let i = 1; i < n - 1; i++) {
		const prev = d[i - 1]
		const next = d[i]

		if (prev === 0 || next === 0 || prev * next < 0) {
			slopes[i] = 0
			continue
		}

		const w0 = 2 * h[i] + h[i - 1]
		const w1 = h[i] + 2 * h[i - 1]
		slopes[i] = (w0 + w1) / (w0 / prev + w1 / next)
	}

	const last = n - 1
	let slopeN = ((2 * h[last - 1] + h[last - 2]) * d[last - 1] - h[last - 1] * d[last - 2]) / (h[last - 1] + h[last - 2])

	if (slopeN * d[last - 1] <= 0) slopeN = 0
	else if (d[last - 1] * d[last - 2] < 0 && Math.abs(slopeN) > Math.abs(3 * d[last - 1])) slopeN = 3 * d[last - 1]

	slopes[last] = slopeN

	return slopes
}

// Computes Akima endpoint slopes from local secants with two extrapolated ghost intervals.
function akimaSlopes(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = interpolatingSplinePointCount(x, y)
	const secants = new Float64Array(n + 3)
	const slopes = new Float64Array(n)

	for (let i = 0; i < n - 1; i++) {
		secants[i + 2] = (y[i + 1] - y[i]) / (x[i + 1] - x[i])
	}

	if (n === 2) {
		slopes[0] = secants[2]
		slopes[1] = secants[2]
		return slopes
	}

	secants[1] = 2 * secants[2] - secants[3]
	secants[0] = 2 * secants[1] - secants[2]
	secants[n + 1] = 2 * secants[n] - secants[n - 1]
	secants[n + 2] = 2 * secants[n + 1] - secants[n]

	for (let i = 0; i < n; i++) {
		const w0 = Math.abs(secants[i + 3] - secants[i + 2])
		const w1 = Math.abs(secants[i + 1] - secants[i])
		const total = w0 + w1

		slopes[i] = total === 0 ? 0.5 * (secants[i + 1] + secants[i + 2]) : (w0 * secants[i + 1] + w1 * secants[i + 2]) / total
	}

	return slopes
}

// Computes Catmull-Rom slopes from centered finite differences in x.
function catmullRomSlopes(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = interpolatingSplinePointCount(x, y)
	const slopes = new Float64Array(n)
	const first = (y[1] - y[0]) / (x[1] - x[0])

	if (n === 2) {
		slopes[0] = first
		slopes[1] = first
		return slopes
	}

	slopes[0] = first

	for (let i = 1; i < n - 1; i++) {
		slopes[i] = (y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1])
	}

	slopes[n - 1] = (y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2])

	return slopes
}

// Computes natural cubic spline slopes by solving the tridiagonal second-derivative system.
function naturalCubicSlopes(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = interpolatingSplinePointCount(x, y)
	const slopes = new Float64Array(n)
	const h = new Float64Array(n - 1)
	const d = new Float64Array(n - 1)

	for (let i = 0; i < n - 1; i++) {
		const width = x[i + 1] - x[i]
		h[i] = width
		d[i] = (y[i + 1] - y[i]) / width
	}

	if (n === 2) {
		slopes[0] = d[0]
		slopes[1] = d[0]
		return slopes
	}

	const internal = n - 2
	const lower = new Float64Array(internal)
	const diagonal = new Float64Array(internal)
	const upper = new Float64Array(internal)
	const rhs = new Float64Array(internal)
	const second = new Float64Array(n)

	for (let i = 0; i < internal; i++) {
		lower[i] = i === 0 ? 0 : h[i]
		diagonal[i] = 2 * (h[i] + h[i + 1])
		upper[i] = i === internal - 1 ? 0 : h[i + 1]
		rhs[i] = 6 * (d[i + 1] - d[i])
	}

	for (let i = 1; i < internal; i++) {
		const factor = lower[i] / diagonal[i - 1]
		diagonal[i] -= factor * upper[i - 1]
		rhs[i] -= factor * rhs[i - 1]
	}

	second[n - 2] = rhs[internal - 1] / diagonal[internal - 1]

	for (let i = internal - 2; i >= 0; i--) {
		second[i + 1] = (rhs[i] - upper[i] * second[i + 2]) / diagonal[i]
	}

	slopes[0] = d[0] - (h[0] * second[1]) / 6

	for (let i = 1; i < n - 1; i++) {
		slopes[i] = d[i - 1] + (h[i - 1] * (second[i - 1] + 2 * second[i])) / 6
	}

	slopes[n - 1] = d[n - 2] + (h[n - 2] * second[n - 2]) / 6

	return slopes
}

// Builds a shape-preserving piecewise cubic Hermite spline from ordered control points.
export function cubicHermiteSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>): InterpolatingSpline {
	const slopes = cubicHermiteSlopes(x, y)
	return interpolatingSpline(x, y, slopes)
}

// Builds an Akima piecewise cubic spline from ordered control points.
export function akimaSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>): InterpolatingSpline {
	const slopes = akimaSlopes(x, y)
	return interpolatingSpline(x, y, slopes)
}

// Builds a Catmull-Rom piecewise cubic spline from ordered control points.
export function catmullRomSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>): InterpolatingSpline {
	const slopes = catmullRomSlopes(x, y)
	return interpolatingSpline(x, y, slopes)
}

// Builds a natural cubic spline from ordered control points.
export function naturalCubicSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>): InterpolatingSpline {
	const slopes = naturalCubicSlopes(x, y)
	return interpolatingSpline(x, y, slopes)
}

// Samples a Hermite spline into a dense LUT over its full x-range.
export function cubicHermiteSplineLUT(x: Readonly<NumberArray>, y: Readonly<NumberArray>, size: number) {
	const spline = cubicHermiteSpline(x, y)
	return interpolatingSplineLUT(spline.x, spline.y, spline.slopes, size)
}

// Samples an Akima spline into a dense LUT over its full x-range.
export function akimaSplineLUT(x: Readonly<NumberArray>, y: Readonly<NumberArray>, size: number) {
	const spline = akimaSpline(x, y)
	return interpolatingSplineLUT(spline.x, spline.y, spline.slopes, size)
}

// Samples a Catmull-Rom spline into a dense LUT over its full x-range.
export function catmullRomSplineLUT(x: Readonly<NumberArray>, y: Readonly<NumberArray>, size: number) {
	const spline = catmullRomSpline(x, y)
	return interpolatingSplineLUT(spline.x, spline.y, spline.slopes, size)
}

// Samples a natural cubic spline into a dense LUT over its full x-range.
export function naturalCubicSplineLUT(x: Readonly<NumberArray>, y: Readonly<NumberArray>, size: number) {
	const spline = naturalCubicSpline(x, y)
	return interpolatingSplineLUT(spline.x, spline.y, spline.slopes, size)
}
