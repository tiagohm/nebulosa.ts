import { PI, TAU } from '../../core/constants'
import { medianAbsoluteDeviationOf, medianBySelectionOf } from '../../core/util'
import { LuDecomposition, Matrix } from '../linear-algebra/matrix'
import type { EllipseGeometry } from './ellipse.geometry'
import { estimateLeastSquaresConditioning } from './least.squares'
import type { NumberArray } from './math'
import { levenbergMarquardt } from './optimization'

// Independent ellipse fitting in Cartesian coordinates with common length units. A normalized
// Halir-Flusser initializer is refined with normal-distance IRLS. Inputs are preserved; returned
// geometry, residuals and weights own their storage. No regularization can rescue a deficient fit.

// Successful canonical ellipse and diagnostics; residuals approximate normal distance near the edge.
export interface EllipseFit {
	// Independent ellipse with semiMajor >= semiMinor and theta in [0, PI); circles use theta = 0.
	readonly ellipse: EllipseGeometry
	// Weighted normal-distance RMS in the input length unit.
	readonly rms: number
	// Signed normal-distance residual per input, in input units; zero for zero-precision samples.
	readonly residuals: Float64Array
	// Final capped precision times robust weights; zero excludes a point.
	readonly weights: Float64Array
	// Condition number of the final geometric Jacobian in normalized coordinates.
	readonly conditionNumber: number
}

// Six coefficients of A*x*x + B*x*y + C*y*y + D*x + E*y + F = 0 in a local Cartesian frame.
export type EllipseConic = readonly [number, number, number, number, number, number]

// Maximum geometric design condition accepted without turning short arcs into plausible ellipses.
const MAXIMUM_CONDITION = 1e4
// Three fixed robust passes, each with at most 50 LM iterations and no per-evaluation allocation.
const IRLS_PASSES = 3
// Shift normalized parameters away from zero: LM uses a relative finite-difference step, which loses
// derivative precision for almost-zero centers, log-scales and shear on an almost circular boundary.
const PARAMETER_ORIGIN = 2

// Converts a local conic to a real canonical ellipse, or undefined for imaginary, degenerate or
// ill-conditioned forms. Coefficients are not mutated; lengths retain the conic coordinate unit.
export function ellipseFromConic(conic: EllipseConic): EllipseGeometry | undefined {
	let [a, b, c, d, e, f] = conic
	const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c))
	if (!(scale > 0) || !Number.isFinite(scale)) return undefined
	const sign = a < 0 ? -1 : 1
	a = (a / scale) * sign
	b = (b / scale) * sign
	c = (c / scale) * sign
	d = (d / scale) * sign
	e = (e / scale) * sign
	f = (f / scale) * sign
	const determinant = a * c - b * b * 0.25
	const high = (a + c) * 0.5 + Math.hypot((a - c) * 0.5, b * 0.5)
	const low = determinant / high
	if (!(low > high * 1e-12)) return undefined
	const x = (b * e * 0.5 - c * d) / (2 * determinant)
	const y = (b * d * 0.5 - a * e) / (2 * determinant)
	const radiusSquared = -(f + (d * x + e * y) * 0.5)
	if (!(radiusSquared > 0)) return undefined
	const semiMajor = Math.sqrt(radiusSquared / low)
	const semiMinor = Math.sqrt(radiusSquared / high)
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(semiMajor) || !Number.isFinite(semiMinor)) return undefined
	let theta = Math.abs(high - low) <= 32 * Number.EPSILON * high ? 0 : Math.atan2(-b, c - a) * 0.5
	if (theta < 0) theta += PI
	if (theta >= PI) theta = 0
	return { center: { x, y }, semiMajor, semiMinor, theta }
}

// Fits paired finite x/y samples of one well-distributed ellipse. Optional nonnegative precision
// weights are capped relative to their median so isolated bright sectors cannot dominate; zero
// precision fully excludes a coordinate pair. At least six informative points are needed.
// Degeneracy, inadequate conditioning or nonstationarity returns undefined; the caller separately
// checks angular coverage and an appropriate RMS tolerance.
export function fitEllipse(x: Readonly<NumberArray>, y: Readonly<NumberArray>, precision?: Readonly<NumberArray>): EllipseFit | undefined {
	const n = x.length

	// Mismatched coordinates silently fit different points; check this structural relation once.
	if (y.length !== n || (precision !== undefined && precision.length !== n)) throw new RangeError('ellipse coordinates and weights must have equal lengths')
	if (n < 6) return undefined

	const base = new Float64Array(n)
	const scratch = new Float64Array(n)
	let count = 0

	for (let i = 0; i < n; i++) if ((precision?.[i] ?? 1) > 0) scratch[count++] = precision?.[i] ?? 1
	if (count < 6) return undefined

	const medianPrecision = medianBySelectionOf(scratch, count)
	let anchorX = 0
	let anchorY = 0
	let sum = 0
	let mx = 0
	let my = 0

	for (let i = 0; i < n; i++) {
		// Cap the relative precision before scaling; four times a finite median can overflow.
		const w = Math.min((precision?.[i] ?? 1) / medianPrecision, 4) * 0.25
		base[i] = w
		if (w === 0) continue
		// Excluded coordinates must not set the origin or participate in distance arithmetic.
		if (sum === 0) {
			anchorX = x[i]
			anchorY = y[i]
		}
		sum += w
		mx += w * (x[i] - anchorX)
		my += w * (y[i] - anchorY)
	}

	mx = anchorX + mx / sum
	my = anchorY + my / sum

	let variance = 0
	for (let i = 0; i < n; i++) if (base[i] > 0) variance += base[i] * ((x[i] - mx) ** 2 + (y[i] - my) ** 2)

	const scale = Math.sqrt(variance / sum)
	if (!(scale > 0) || !Number.isFinite(scale)) return undefined

	const nx = new Float64Array(n)
	const ny = new Float64Array(n)

	for (let i = 0; i < n; i++) {
		if (base[i] > 0) {
			nx[i] = (x[i] - mx) / scale
			ny[i] = (y[i] - my) / scale
		}
	}

	const initial = directEllipse(nx, ny, base)
	if (!initial) return undefined

	const cos = Math.cos(initial.theta)
	const sin = Math.sin(initial.theta)
	const major = 1 / initial.semiMajor ** 2
	const minor = 1 / initial.semiMinor ** 2
	const q00 = cos * cos * major + sin * sin * minor
	const q01 = cos * sin * (major - minor)
	const q11 = sin * sin * major + cos * cos * minor
	const l00 = Math.sqrt(q00)
	const l01 = q01 / l00
	const params = [initial.center.x, initial.center.y, Math.log(l00), l01, Math.log(Math.sqrt(q11 - l01 * l01))]

	for (let i = 0; i < params.length; i++) params[i] += PARAMETER_ORIGIN

	const weights = base.slice()
	const residuals = new Float64Array(n)
	const indices = new Float64Array(n)
	const zero = new Float64Array(n)

	for (let i = 0; i < n; i++) indices[i] = i

	const model = (i: number, p: NumberArray) => (base[i] > 0 ? normalResidual(nx[i], ny[i], p) : 0)

	for (let pass = 0; pass < IRLS_PASSES; pass++) {
		levenbergMarquardt(indices, zero, model, params, { weights, maxIterations: 50, tolerance: 1e-16 })
		count = 0

		for (let i = 0; i < n; i++) {
			residuals[i] = model(i, params)
			if (!Number.isFinite(residuals[i])) return undefined
			if (base[i] > 0) scratch[count++] = residuals[i]
		}

		if (pass === IRLS_PASSES - 1) break

		const median = medianBySelectionOf(scratch, count)
		const sigma = medianAbsoluteDeviationOf(scratch, median, true, count, scratch)
		// This is a numerical zero-residual threshold in normalized coordinates, not image resolution.
		const cutoff = Math.max(4.685 * sigma, 1e-9)
		count = 0

		for (let i = 0; i < n; i++) {
			const u = Math.abs(residuals[i] - median) / cutoff
			weights[i] = u < 1 ? base[i] * (1 - u * u) ** 2 : 0
			if (weights[i] > 0) count++
		}

		if (count < 6) return undefined
	}

	const jacobian = new Array<Float64Array>(n)
	const gradient = new Float64Array(5)
	const diagonal = new Float64Array(5)
	let sse = 0
	sum = 0

	for (let i = 0; i < n; i++) {
		const row = new Float64Array(5)
		jacobian[i] = row

		for (let j = 0; j < 5; j++) {
			const saved = params[j]
			const h = 1e-5 * Math.max(1, Math.abs(saved))
			params[j] = saved + h
			const plus = model(i, params)
			params[j] = saved - h
			const minus = model(i, params)
			params[j] = saved
			row[j] = (plus - minus) / (2 * h)
			gradient[j] += weights[i] * row[j] * residuals[i]
			diagonal[j] += weights[i] * row[j] * row[j]
		}

		sse += weights[i] * residuals[i] * residuals[i]
		sum += weights[i]
	}

	const conditioning = estimateLeastSquaresConditioning(jacobian, weights)

	if (conditioning.rankDeficient || !(conditioning.conditionNumber < MAXIMUM_CONDITION)) return undefined

	// Test stationarity using the undamped geometric Jacobian, even when LM rejected every trial step.
	for (let j = 0; j < 5; j++) if (!(Math.abs(gradient[j]) <= 2e-6 * Math.sqrt(diagonal[j]) * Math.max(Math.sqrt(sse), 1e-8 * Math.sqrt(sum)))) return undefined

	const l0 = Math.exp(params[2] - PARAMETER_ORIGIN)
	const l1 = params[3] - PARAMETER_ORIGIN
	const l2 = Math.exp(params[4] - PARAMETER_ORIGIN)
	const a = l0 * l0
	const b = 2 * l0 * l1
	const c = l1 * l1 + l2 * l2

	const local = ellipseFromConic([a, b, c, 0, 0, -1])
	if (!local) return undefined

	const ellipse = { center: { x: mx + (params[0] - PARAMETER_ORIGIN) * scale, y: my + (params[1] - PARAMETER_ORIGIN) * scale }, semiMajor: local.semiMajor * scale, semiMinor: local.semiMinor * scale, theta: local.theta }
	for (let i = 0; i < n; i++) residuals[i] *= scale
	return { ellipse, rms: Math.sqrt(sse / sum) * scale, residuals, weights, conditionNumber: conditioning.conditionNumber }
}

// Computes the first-order signed normal distance at x/y using center and log-Cholesky parameters.
// Invalid trial shapes return Infinity so LM cannot accept them. Accurate only near the boundary.
function normalResidual(x: number, y: number, p: NumberArray) {
	const dx = x - (p[0] - PARAMETER_ORIGIN)
	const dy = y - (p[1] - PARAMETER_ORIGIN)
	const a = Math.exp(p[2] - PARAMETER_ORIGIN)
	const b = p[3] - PARAMETER_ORIGIN
	const c = Math.exp(p[4] - PARAMETER_ORIGIN)
	const u = a * dx + b * dy
	const v = c * dy
	const qx = a * u
	const qy = b * u + c * v
	const denominator = 2 * Math.hypot(qx, qy)
	const residual = (u * u + v * v - 1) / denominator
	return denominator > 1e-15 && Number.isFinite(residual) ? residual : Infinity
}

// Weighted Halir-Flusser reduction in centered, isotropically scaled coordinates. See Fig. 2 of
// https://autotrace.sourceforge.net/WSCG98.pdf. Solve S3*T = -S2' using LU, never an explicit inverse.
function directEllipse(x: Float64Array, y: Float64Array, weights: Float64Array): EllipseGeometry | undefined {
	const s1 = new Float64Array(9)
	const s2 = new Float64Array(9)
	const s3 = Matrix.square(3)
	const linear = new Array<Float64Array>(x.length)
	const quadratic = new Float64Array(3)

	for (let i = 0; i < x.length; i++) {
		const row = new Float64Array([x[i], y[i], 1])
		linear[i] = row
		quadratic[0] = x[i] * x[i]
		quadratic[1] = x[i] * y[i]
		quadratic[2] = y[i] * y[i]

		for (let j = 0; j < 3; j++) {
			for (let k = 0; k < 3; k++) {
				s1[j * 3 + k] += weights[i] * quadratic[j] * quadratic[k]
				s2[j * 3 + k] += weights[i] * quadratic[j] * row[k]
				s3.data[j * 3 + k] += weights[i] * row[j] * row[k]
			}
		}
	}

	const condition = estimateLeastSquaresConditioning(linear, weights)
	if (condition.rankDeficient || !(condition.conditionNumber < MAXIMUM_CONDITION)) return undefined

	const lu = new LuDecomposition(s3, true)
	if (lu.isSingular) return undefined
	const t = new Float64Array(9)

	for (let j = 0; j < 3; j++) {
		const column = lu.solve([-s2[j * 3], -s2[j * 3 + 1], -s2[j * 3 + 2]])
		for (let i = 0; i < 3; i++) t[i * 3 + j] = column[i]
	}

	const reduced = s1.slice()
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) reduced[i * 3 + j] += s2[i * 3 + k] * t[k * 3 + j]

	const m = new Float64Array(9)
	for (let j = 0; j < 3; j++) {
		m[j] = reduced[6 + j] * 0.5
		m[3 + j] = -reduced[3 + j]
		m[6 + j] = reduced[j] * 0.5
	}

	for (const v of ellipseEigenvectors(m)) {
		// A zero or slightly negative eigenvalue is valid for exact data; use the ellipse constraint.
		if (!(4 * v[0] * v[2] - v[1] * v[1] > 1e-12)) continue
		const d = t[0] * v[0] + t[1] * v[1] + t[2] * v[2]
		const e = t[3] * v[0] + t[4] * v[1] + t[5] * v[2]
		const f = t[6] * v[0] + t[7] * v[1] + t[8] * v[2]
		const ellipse = ellipseFromConic([v[0], v[1], v[2], d, e, f])
		if (ellipse) return ellipse
	}

	return undefined
}

// Real eigenvectors of the nonsymmetric 3x3 Halir-Flusser matrix only. Its spectrum is real;
// solve the scaled characteristic cubic, polish at most eight times, and verify each eigenvector
// against the original scaled matrix. Repeated uninformative roots need not supply a full basis.
function ellipseEigenvectors(input: Float64Array): Float64Array[] {
	let scale = 0
	for (let i = 0; i < 9; i++) scale = Math.max(scale, Math.abs(input[i]))
	if (!(scale > 0) || !Number.isFinite(scale)) return []

	const m = new Float64Array(9)
	for (let i = 0; i < 9; i++) m[i] = input[i] / scale

	const trace = m[0] + m[4] + m[8]
	const pair = m[0] * m[4] + m[0] * m[8] + m[4] * m[8] - m[1] * m[3] - m[2] * m[6] - m[5] * m[7]
	const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
	const p = pair - (trace * trace) / 3
	const q = (-2 * trace ** 3) / 27 + (trace * pair) / 3 - det

	if (!(p < 0)) return []

	const radius = 2 * Math.sqrt(-p / 3)
	const arg = (3 * q) / (p * radius)
	if (Math.abs(arg) > 1 + 1e-10) return []
	const phi = Math.acos(Math.max(-1, Math.min(1, arg))) / 3
	const vectors: Float64Array[] = []

	for (let root = 0; root < 3; root++) {
		let lambda = trace / 3 + radius * Math.cos(phi - (root * TAU) / 3)

		for (let iteration = 0; iteration < 8; iteration++) {
			const value = ((lambda - trace) * lambda + pair) * lambda - det
			const derivative = (3 * lambda - 2 * trace) * lambda + pair
			if (Math.abs(derivative) < 1e-12) break
			const step = value / derivative
			lambda -= step
			if (Math.abs(step) < 1e-15) break
		}

		const rows = m
		rows[0] -= lambda
		rows[4] -= lambda
		rows[8] -= lambda
		let norm = 0
		const v = new Float64Array(3)

		for (let i = 0; i < 3; i++) {
			const j = (i + 1) % 3
			const x = rows[i * 3 + 1] * rows[j * 3 + 2] - rows[i * 3 + 2] * rows[j * 3 + 1]
			const y = rows[i * 3 + 2] * rows[j * 3] - rows[i * 3] * rows[j * 3 + 2]
			const z = rows[i * 3] * rows[j * 3 + 1] - rows[i * 3 + 1] * rows[j * 3]
			const candidate = Math.hypot(x, y, z)

			if (candidate > norm) {
				norm = candidate
				v[0] = x
				v[1] = y
				v[2] = z
			}
		}

		if (!(norm > 1e-12)) continue

		for (let i = 0; i < 3; i++) v[i] /= norm

		let error = 0
		for (let i = 0; i < 3; i++) error = Math.max(error, Math.abs(rows[i * 3] * v[0] + rows[i * 3 + 1] * v[1] + rows[i * 3 + 2] * v[2]))
		if (error <= 1e-9) vectors.push(v)
	}

	return vectors
}
