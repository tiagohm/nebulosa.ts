import type { NumberArray } from './math'

// Polynomial and piecewise interpolating splines: a single-interval polynomial spline (with derivative
// and integral) and the cubic Hermite family of interpolators over ordered control points - linear,
// shape-preserving monotone (Fritsch-Carlson) cubic Hermite, PCHIP, Akima, Catmull-Rom, and natural
// cubic - plus dense look-up-table samplers. Control points must be finite with strictly increasing x.
// Evaluation caches the last segment for fast monotonic query streams; call reset() before random access.

// Single coefficient of a constant zero polynomial, returned as the derivative of a constant spline.
const ZERO_POLYNOMIAL = [0] as const

// A polynomial spline defined over one [lower, upper] interval evaluated in normalized coordinates.
export interface Spline {
	// Lower bound of the interval (maps to normalized t = 0).
	readonly lower: number
	// Upper bound of the interval (maps to normalized t = 1).
	readonly upper: number
	// Polynomial coefficients in descending power (Horner) order over the normalized parameter.
	readonly coefficients: Readonly<NumberArray>
	// Computes the spline value through Horner evaluation in normalized coordinates.
	readonly compute: (value: number) => number
	// Builds the x-derivative spline and preserves constant splines as an explicit zero polynomial.
	readonly derivative: () => Spline
	// Builds the antiderivative spline with integral(lower) = constant.
	readonly integral: (constant?: number) => Spline
}

// A piecewise interpolant sampled at the control points (x, y).
export interface PiecewiseSpline {
	// Strictly increasing knot abscissae.
	readonly x: Readonly<NumberArray>
	// Knot ordinates aligned with `x`.
	readonly y: Readonly<NumberArray>
	// Computes the interpolated value on the piecewise spline.
	readonly compute: (value: number) => number
	// Resets the cached segment lookup used by monotonic query streams.
	readonly reset: () => void
}

// A piecewise interpolant that also exposes its per-knot first derivatives (slopes).
export interface InterpolatingSpline extends PiecewiseSpline {
	// First derivative at each knot used to build the cubic Hermite segments.
	readonly slopes: Readonly<NumberArray>
}

// Options shared by the interpolating-spline builders.
export interface SplineOptions {
	// When true, queries outside [x[0], x[last]] extrapolate the endpoint segment instead of clamping.
	readonly extrapolate?: boolean
}

// Out-of-range query behavior for PCHIP: clamp to the endpoint value, extrapolate, or throw.
export type PchipOutOfRange = 'clamp' | 'extrapolate' | 'throw'

// Options for the PCHIP interpolator.
export interface PchipOptions extends SplineOptions {
	// Behavior when a query falls outside the sampled range; defaults to 'clamp'.
	readonly outOfRange?: PchipOutOfRange
}

// Piecewise Cubic Hermite Interpolating Polynomial, exposing its precomputed segment data.
export interface PchipSpline extends InterpolatingSpline {
	// Knot abscissae (alias of `x`).
	readonly knots: Readonly<NumberArray>
	// Knot ordinates (alias of `y`).
	readonly values: Readonly<NumberArray>
	// Shape-preserving nodal derivatives (alias of `slopes`).
	readonly derivatives: Readonly<NumberArray>
	// Per-segment interval widths x[i+1] - x[i].
	readonly widths: Readonly<NumberArray>
	// Per-segment secant slopes (y[i+1] - y[i]) / width.
	readonly secants: Readonly<NumberArray>
}

// Precomputed PCHIP state: knot data plus the per-segment Horner coefficients a + b·dx + c·dx² + d·dx³.
interface PchipData {
	readonly knots: Float64Array
	readonly values: Float64Array
	readonly derivatives: Float64Array
	readonly widths: Float64Array
	readonly secants: Float64Array
	readonly a: Float64Array
	readonly b: Float64Array
	readonly c: Float64Array
	readonly d: Float64Array
}

// Per-segment cubic Horner coefficients evaluated as a + b·dx + c·dx² + d·dx³ with dx = value - x[i].
interface CubicSegmentCoefficients {
	readonly a: Float64Array
	readonly b: Float64Array
	readonly c: Float64Array
	readonly d: Float64Array
}

// Natural cubic segment coefficients together with the derived per-knot slopes.
interface NaturalCubicCoefficients extends CubicSegmentCoefficients {
	readonly slopes: Float64Array
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

function pchipOutOfRange(options?: PchipOptions | boolean) {
	if (typeof options === 'boolean') return options ? 'extrapolate' : 'clamp'

	const outOfRange = options?.outOfRange ?? (options?.extrapolate ? 'extrapolate' : 'clamp')

	if (outOfRange !== 'clamp' && outOfRange !== 'extrapolate' && outOfRange !== 'throw') {
		throw new Error('pchip outOfRange must be clamp, extrapolate, or throw')
	}

	return outOfRange
}

function splineExtrapolate(options: SplineOptions | boolean) {
	return typeof options === 'boolean' ? options : options.extrapolate === true
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

// Finds the active segment using a cached index, adjacent checks, then binary search.
function splineSegmentIndex(x: Readonly<NumberArray>, value: number, lastIndex: number) {
	const lastSegment = x.length - 2
	let i = lastIndex

	if (value >= x[i] && value <= x[i + 1]) return i

	if (i < lastSegment && value >= x[i + 1] && value <= x[i + 2]) return i + 1

	if (i > 0 && value >= x[i - 1] && value <= x[i]) return i - 1

	if (value <= x[0]) return 0
	if (value >= x[lastSegment + 1]) return lastSegment

	let low = 0
	let high = lastSegment

	while (low <= high) {
		i = (low + high) >> 1

		if (value < x[i]) high = i - 1
		else if (value > x[i + 1]) low = i + 1
		else return i
	}

	return lastSegment
}

// Converts cubic Hermite knots and nodal slopes into per-segment Horner coefficients.
function hermiteCoefficients(x: Readonly<NumberArray>, y: Readonly<NumberArray>, slopes: Readonly<NumberArray>): CubicSegmentCoefficients {
	const segmentCount = x.length - 1
	const a = new Float64Array(segmentCount)
	const b = new Float64Array(segmentCount)
	const c = new Float64Array(segmentCount)
	const d = new Float64Array(segmentCount)

	for (let i = 0; i < segmentCount; i++) {
		const width = x[i + 1] - x[i]
		const invWidth = 1 / width
		const secant = (y[i + 1] - y[i]) * invWidth
		const m0 = slopes[i]
		const m1 = slopes[i + 1]

		a[i] = y[i]
		b[i] = m0
		c[i] = (3 * secant - 2 * m0 - m1) * invWidth
		d[i] = (m0 + m1 - 2 * secant) * invWidth * invWidth
	}

	return { a, b, c, d }
}

// Creates a piecewise linear interpolating spline from ordered control points.
export function linearSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, options: SplineOptions | boolean = false): PiecewiseSpline {
	const n = interpolatingSplinePointCount(x, y)
	const last = n - 1
	const extrapolate = splineExtrapolate(options)
	const invWidths = new Float64Array(last)
	let lastIndex = 0

	for (let i = 0; i < last; i++) invWidths[i] = 1 / (x[i + 1] - x[i])

	return {
		x,
		y,
		compute: (value: number) => {
			if (!extrapolate) {
				if (value <= x[0]) return y[0]
				if (value >= x[last]) return y[last]
			}

			// Use endpoint segments outside the sampled range
			const i = splineSegmentIndex(x, value, lastIndex)
			lastIndex = i

			const t = (value - x[i]) * invWidths[i]
			return y[i] + t * (y[i + 1] - y[i])
		},
		reset: () => {
			lastIndex = 0
		},
	}
}

// Builds the shared evaluator used by the cubic Hermite-family interpolators.
function interpolatingSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, slopes: Readonly<NumberArray>, options: SplineOptions | boolean = false): InterpolatingSpline {
	const last = x.length - 1
	const extrapolate = splineExtrapolate(options)
	const { a, b, c, d } = hermiteCoefficients(x, y, slopes)
	let lastIndex = 0

	return {
		x,
		y,
		slopes,
		compute: (value: number) => {
			if (!extrapolate) {
				if (value <= x[0]) return y[0]
				if (value >= x[last]) return y[last]
			}

			// Use endpoint segments outside the sampled range
			const i = splineSegmentIndex(x, value, lastIndex)
			lastIndex = i
			const dx = value - x[i]

			return a[i] + dx * (b[i] + dx * (c[i] + dx * d[i]))
		},
		reset: () => {
			lastIndex = 0
		},
	}
}

// Samples a piecewise spline into a dense LUT over its full x-range.
function piecewiseSplineLUT(spline: PiecewiseSpline, size: number) {
	if (!Number.isFinite(size) || size < 2) throw new Error('spline LUT size must be at least two')

	const output = new Float32Array(size)
	const lower = spline.x[0]
	const upper = spline.x.at(-1)!
	const scale = (upper - lower) / (size - 1)

	spline.reset()

	for (let i = 0; i < size; i++) output[i] = spline.compute(lower + scale * i)

	spline.reset()

	return output
}

// Samples a piecewise cubic spline into a dense LUT over its full x-range.
function interpolatingSplineLUT(x: Readonly<NumberArray>, y: Readonly<NumberArray>, slopes: Readonly<NumberArray>, size: number) {
	if (!Number.isFinite(size) || size < 2) throw new Error('spline LUT size must be at least two')

	const output = new Float32Array(size)
	const last = x.length - 1
	const lower = x[0]
	const upper = x[last]
	const scale = (upper - lower) / (size - 1)
	const { a, b, c, d } = hermiteCoefficients(x, y, slopes)
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

		const dx = value - x[segment]
		output[i] = a[segment] + dx * (b[segment] + dx * (c[segment] + dx * d[segment]))
	}

	return output
}

// Applies the one-sided PCHIP endpoint limiter.
function pchipEndpointDerivative(h0: number, h1: number, d0: number, d1: number) {
	let derivative = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)

	if (derivative * d0 <= 0) derivative = 0
	else if (d0 * d1 < 0 && Math.abs(derivative) > Math.abs(3 * d0)) derivative = 3 * d0

	return derivative
}

// Computes PCHIP nodal derivatives, zeroing extrema and flat joins.
function pchipDerivatives(widths: Readonly<NumberArray>, secants: Readonly<NumberArray>, derivatives: NumberArray) {
	const segmentCount = secants.length

	if (segmentCount === 1) {
		derivatives[0] = secants[0]
		derivatives[1] = secants[0]
		return
	}

	derivatives[0] = pchipEndpointDerivative(widths[0], widths[1], secants[0], secants[1])

	for (let i = 1; i < segmentCount; i++) {
		const prev = secants[i - 1]
		const next = secants[i]

		if (prev === 0 || next === 0 || prev * next < 0) {
			derivatives[i] = 0
			continue
		}

		const w0 = 2 * widths[i] + widths[i - 1]
		const w1 = widths[i] + 2 * widths[i - 1]
		derivatives[i] = (w0 + w1) / (w0 / prev + w1 / next)
	}

	const last = segmentCount
	derivatives[last] = pchipEndpointDerivative(widths[last - 1], widths[last - 2], secants[last - 1], secants[last - 2])
}

function pchipData(x: Readonly<NumberArray>, y: Readonly<NumberArray>): PchipData {
	const n = interpolatingSplinePointCount(x, y)
	const segmentCount = n - 1
	const knots = new Float64Array(n)
	const values = new Float64Array(n)
	const widths = new Float64Array(segmentCount)
	const secants = new Float64Array(segmentCount)
	const derivatives = new Float64Array(n)

	for (let i = 0; i < n; i++) {
		knots[i] = x[i]
		values[i] = y[i]
	}

	for (let i = 0; i < segmentCount; i++) {
		const width = knots[i + 1] - knots[i]
		widths[i] = width
		secants[i] = (values[i + 1] - values[i]) / width
	}

	pchipDerivatives(widths, secants, derivatives)
	const { a, b, c, d } = hermiteCoefficients(knots, values, derivatives)

	return { knots, values, derivatives, widths, secants, a, b, c, d }
}

// Computes shape-preserving slopes using the Fritsch-Carlson monotone cubic Hermite recipe.
function cubicHermiteSlopes(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = interpolatingSplinePointCount(x, y)

	const segmentCount = n - 1
	const widths = new Float64Array(segmentCount)
	const secants = new Float64Array(segmentCount)
	const slopes = new Float64Array(n)

	for (let i = 0; i < segmentCount; i++) {
		const width = x[i + 1] - x[i]
		widths[i] = width
		secants[i] = (y[i + 1] - y[i]) / width
	}

	pchipDerivatives(widths, secants, slopes)

	return slopes
}

// Computes Akima endpoint slopes from local secants with two extrapolated ghost intervals.
function akimaSlopes(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	const n = interpolatingSplinePointCount(x, y)
	const secants = new Float64Array(n + 3)
	const slopes = new Float64Array(n)
	const segmentCount = n - 1

	for (let i = 0; i < segmentCount; i++) {
		secants[i + 2] = (y[i + 1] - y[i]) / (x[i + 1] - x[i])
	}

	if (n === 2) {
		slopes[0] = secants[2]
		slopes[1] = secants[2]
		return slopes
	}

	secants[1] = 2 * secants[2] - secants[3]
	secants[0] = 2 * secants[1] - secants[2]
	secants[n + 1] = 2 * secants[n] - secants[segmentCount]
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
	const segmentCount = n - 1
	const first = (y[1] - y[0]) / (x[1] - x[0])

	if (n === 2) {
		slopes[0] = first
		slopes[1] = first
		return slopes
	}

	slopes[0] = first

	for (let i = 1; i < segmentCount; i++) {
		slopes[i] = (y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1])
	}

	slopes[segmentCount] = (y[segmentCount] - y[n - 2]) / (x[segmentCount] - x[n - 2])

	return slopes
}

// Computes natural cubic spline coefficients by solving the tridiagonal second-derivative system.
function naturalCubicCoefficients(x: Readonly<NumberArray>, y: Readonly<NumberArray>): NaturalCubicCoefficients {
	const n = interpolatingSplinePointCount(x, y)
	const slopes = new Float64Array(n)
	const segmentCount = n - 1
	const h = new Float64Array(segmentCount)
	const delta = new Float64Array(segmentCount)
	const a = new Float64Array(segmentCount)
	const b = new Float64Array(segmentCount)
	const c = new Float64Array(segmentCount)
	const d = new Float64Array(segmentCount)

	for (let i = 0; i < segmentCount; i++) {
		const width = x[i + 1] - x[i]
		h[i] = width
		delta[i] = (y[i + 1] - y[i]) / width
	}

	if (n === 2) {
		slopes[0] = delta[0]
		slopes[1] = delta[0]
		a[0] = y[0]
		b[0] = delta[0]
		return { slopes, a, b, c, d }
	}

	const internal = segmentCount - 1
	const lower = new Float64Array(internal)
	const diagonal = new Float64Array(internal)
	const upper = new Float64Array(internal)
	const rhs = new Float64Array(internal)
	const second = new Float64Array(n)

	for (let i = 0; i < internal; i++) {
		lower[i] = i === 0 ? 0 : h[i]
		diagonal[i] = 2 * (h[i] + h[i + 1])
		upper[i] = i === internal - 1 ? 0 : h[i + 1]
		rhs[i] = 6 * (delta[i + 1] - delta[i])
	}

	for (let i = 1; i < internal; i++) {
		const factor = lower[i] / diagonal[i - 1]
		diagonal[i] -= factor * upper[i - 1]
		rhs[i] -= factor * rhs[i - 1]
	}

	second[internal] = rhs[internal - 1] / diagonal[internal - 1]

	for (let i = internal - 2; i >= 0; i--) {
		second[i + 1] = (rhs[i] - upper[i] * second[i + 2]) / diagonal[i]
	}

	slopes[0] = delta[0] - (h[0] * second[1]) / 6

	for (let i = 1; i < segmentCount; i++) {
		slopes[i] = delta[i - 1] + (h[i - 1] * (second[i - 1] + 2 * second[i])) / 6
	}

	slopes[segmentCount] = delta[internal] + (h[internal] * second[internal]) / 6

	// Coefficients are stored as a + b * dx + c * dx^2 + d * dx^3 per segment.
	for (let i = 0; i < segmentCount; i++) {
		a[i] = y[i]
		b[i] = delta[i] - (h[i] * (2 * second[i] + second[i + 1])) / 6
		c[i] = second[i] / 2
		d[i] = (second[i + 1] - second[i]) / (6 * h[i])
	}

	return { slopes, a, b, c, d }
}

// Builds a shape-preserving piecewise cubic Hermite spline from ordered control points.
export function cubicHermiteSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, options: SplineOptions | boolean = false): InterpolatingSpline {
	const slopes = cubicHermiteSlopes(x, y)
	return interpolatingSpline(x, y, slopes, options)
}

// Builds a PCHIP interpolator. Values outside the sampled range clamp by default.
export function pchip(x: Readonly<NumberArray>, y: Readonly<NumberArray>, options?: PchipOptions | boolean): PchipSpline {
	const outOfRange = pchipOutOfRange(options)
	const { knots, values, derivatives, widths, secants, a, b, c, d } = pchipData(x, y)
	const last = knots.length - 1
	let lastIndex = 0

	return {
		x: knots,
		y: values,
		slopes: derivatives,
		knots,
		values,
		derivatives,
		widths,
		secants,
		compute: (value: number) => {
			if (value <= knots[0]) {
				if (value === knots[0] || outOfRange === 'clamp') return values[0]
				if (outOfRange === 'throw') throw new Error('pchip value is outside interpolation range')
			}

			if (value >= knots[last]) {
				if (value === knots[last] || outOfRange === 'clamp') return values[last]
				if (outOfRange === 'throw') throw new Error('pchip value is outside interpolation range')
			}

			const i = splineSegmentIndex(knots, value, lastIndex)
			lastIndex = i
			const dx = value - knots[i]

			return a[i] + dx * (b[i] + dx * (c[i] + dx * d[i]))
		},
		reset: () => {
			lastIndex = 0
		},
	}
}

// Builds an Akima piecewise cubic spline from ordered control points.
export function akimaSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, options: SplineOptions | boolean = false): InterpolatingSpline {
	const slopes = akimaSlopes(x, y)
	return interpolatingSpline(x, y, slopes, options)
}

// Builds a Catmull-Rom piecewise cubic spline from ordered control points.
export function catmullRomSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, options: SplineOptions | boolean = false): InterpolatingSpline {
	const slopes = catmullRomSlopes(x, y)
	return interpolatingSpline(x, y, slopes, options)
}

// Builds a natural cubic spline from ordered control points.
export function naturalCubicSpline(x: Readonly<NumberArray>, y: Readonly<NumberArray>, options: SplineOptions | boolean = false): InterpolatingSpline {
	const coefficients = naturalCubicCoefficients(x, y)
	const last = x.length - 1
	const extrapolate = splineExtrapolate(options)
	const { a, b, c, d } = coefficients
	let lastIndex = 0

	return {
		x,
		y,
		slopes: coefficients.slopes,
		compute: (value: number) => {
			if (!extrapolate) {
				if (value <= x[0]) return y[0]
				if (value >= x[last]) return y[last]
			}

			// Use endpoint segments outside the sampled range
			const i = splineSegmentIndex(x, value, lastIndex)
			lastIndex = i
			const dx = value - x[i]

			return a[i] + dx * (b[i] + dx * (c[i] + dx * d[i]))
		},
		reset: () => {
			lastIndex = 0
		},
	}
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
	return piecewiseSplineLUT(spline, size)
}
