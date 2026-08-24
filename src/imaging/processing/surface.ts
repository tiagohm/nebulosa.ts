import { medianOf, STANDARD_DEVIATION_SCALE, standardDeviationOf } from '../../core/util'
import { LuDecomposition, Matrix, QrDecomposition } from '../../math/linear-algebra/matrix'

// Generic scattered-data scalar surface fitting over a pixel plane. Fits a smooth function
// f(x, y) to weighted point samples using either a 2D tensor Chebyshev polynomial (least squares by
// QR, with optional iterative residual rejection) or a smoothing thin-plate spline through the
// samples, then evaluates it back over the plane. Coordinates are pixel centers; the fit normalizes
// them to [-1, 1] over a configurable domain rectangle, which keeps the least-squares system well
// conditioned even when the samples only cover part of the frame.
//
// This module knows nothing about images, background modeling, or normalization: it takes scalar
// samples and returns a surface. Callers that need a specific pass ordering (the background extractor
// interleaves its own structure rejection between the generic steps) compose the exported primitives
// directly instead of calling `fitScalarSurface`.
//
// Expected failures are reported as a result union, never thrown. Nothing is validated at runtime:
// samples are assumed finite and inside the domain, weights positive, and dimensions positive.

// The surface model used to represent the data.
// - `polynomial`: a global low-degree 2D Chebyshev surface; cheap, best for smooth trends, but cannot
//   follow complex non-monotonic shapes without oscillating.
// - `thinPlateSpline`: a smoothing spline through the samples; follows arbitrary smooth shapes at a
//   higher fit (O(k^3)) and evaluation cost.
export type SurfaceModelType = 'polynomial' | 'thinPlateSpline'

// Rectangle of pixel coordinates mapped onto the normalized [-1, 1]^2 fitting domain. Restricting it
// to the bounding box of the samples keeps a partially covered frame well conditioned: normalizing a
// thin band against the whole frame collapses one axis to a near-constant coordinate, which the
// degeneracy guards reject even though the layout is locally fine.
export interface SurfaceDomain {
	// Pixel x mapped to u = -1.
	readonly x0: number
	// Pixel y mapped to v = -1.
	readonly y0: number
	// Pixel x mapped to u = +1.
	readonly x1: number
	// Pixel y mapped to v = +1.
	readonly y1: number
}

// One scalar sample fed to the fit, in pixel coordinates.
export interface SurfaceSample {
	// Sample x in pixels.
	readonly x: number
	// Sample y in pixels.
	readonly y: number
	// Sampled scalar value; the quantity the surface approximates.
	readonly value: number
	// Least-squares weight in (0, 1]. Defaults to 1 when omitted.
	readonly weight?: number
}

// A sample as reported back by the fit, with its acceptance flag.
export interface SurfaceFitSample extends SurfaceSample {
	// Whether the sample fed the final fit (false when dropped by rejection, dedup, or the control cap).
	readonly accepted: boolean
}

// How residual outliers are rejected between refits.
// - `none`: fit once and keep every sample. Required by the thin-plate spline path, whose flexible
//   surface would otherwise reject the very structure it exists to model.
// - `symmetric`: reject with the same sigma multiple above and below the surface.
// - `asymmetric`: use `high` above the surface and `low` below it.
export type SurfaceRejectionMode = 'none' | 'symmetric' | 'asymmetric'

// Iterative residual rejection settings.
export interface SurfaceRejectionOptions {
	// Rejection strategy. Default `none`.
	readonly mode?: SurfaceRejectionMode
	// Sigma multiple for samples BELOW the surface (residual < 0). Ignored when mode is `none`, and
	// mirrored from `high` when mode is `symmetric`.
	readonly low?: number
	// Sigma multiple for samples ABOVE the surface (residual > 0). Ignored when mode is `none`.
	readonly high?: number
	// Number of fit / reject / refit passes. 0 fits once without rejecting.
	readonly iterations?: number
}

// Options for `fitScalarSurface`.
export interface SurfaceFitOptions {
	// Surface model. Default `polynomial`.
	readonly model?: SurfaceModelType
	// Total degree of the polynomial surface (also the affine reference for the spline). Expected 1..6;
	// needs at least (degree+1)*(degree+2)/2 accepted samples.
	readonly degree?: number
	// Thin-plate spline regularization added to the system diagonal, scaled by each sample's inverse
	// weight. 0 interpolates every sample exactly. Ignored by the polynomial model.
	readonly smoothing?: number
	// Residual rejection settings. Applies to the polynomial model only.
	readonly rejection?: SurfaceRejectionOptions
	// Upper bound on thin-plate spline control points. Defaults to, and is clamped to,
	// `SURFACE_MAX_CONTROL_POINTS`: that constant is the fit's tractability ceiling, not a preference.
	readonly maxControlPoints?: number
	// Coordinate normalization rectangle. Defaults to the full frame (0, 0)..(width-1, height-1).
	readonly domain?: SurfaceDomain
}

// A fitted scalar surface plus its fit diagnostics.
export interface ScalarSurfaceModel {
	// Model the fit produced; determines how `coefficients`/`controlPoints` are interpreted.
	readonly type: SurfaceModelType
	// Width, in pixels, of the plane the surface applies to.
	readonly width: number
	// Height, in pixels, of the plane the surface applies to.
	readonly height: number
	// Rectangle the coordinates were normalized against.
	readonly domain: SurfaceDomain
	// Polynomial total degree (of the surface, or of the spline's affine part).
	readonly degree: number
	// Spline smoothing used (0 for the polynomial model).
	readonly smoothing: number
	// For `polynomial`, the tensor Chebyshev coefficients T_i(u)*T_j(v) ordered by ascending total
	// degree. For `thinPlateSpline`, [a0, a1, a2, w0..w_{k-1}]: affine part then one RBF weight per
	// control point, in `controlPoints` order.
	readonly coefficients: Float64Array
	// Thin-plate spline only: interleaved normalized control points [u0, v0, u1, v1, ...].
	readonly controlPoints?: Float64Array
	// Samples that survived every rejection pass and fed the final fit.
	readonly acceptedSamples: number
	// Samples discarded before the final fit.
	readonly rejectedSamples: number
	// Robust dispersion (normalized MAD) of the final residuals; a fit-quality indicator.
	readonly residual: number
	// Every input sample with its acceptance flag, for inspection.
	readonly samples: readonly SurfaceFitSample[]
}

// Why a fit could not be produced. These are expected outcomes of a degenerate sample layout, not
// programming errors, so they travel in a result union instead of an exception.
export type SurfaceFitFailureReason =
	// Fewer accepted samples than the model needs (polynomial terms, or 3 for a spline).
	| 'too-few-samples'
	// Samples confined to a thin strip or a line, leaving the surface unconstrained across the frame.
	| 'degenerate-layout'
	// The least-squares system is rank deficient.
	| 'rank-deficient'
	// The solved coefficients dwarf the sampled values, so the surface would explode between samples.
	| 'unstable-magnitude'
	// The spline saddle-point system is singular or produced non-finite coefficients.
	| 'singular-system'

// Outcome of a surface fit.
export type SurfaceFitResult = { readonly ok: true; readonly model: ScalarSurfaceModel } | { readonly ok: false; readonly reason: SurfaceFitFailureReason }

// Precomputed Chebyshev basis for a fixed set of evaluation columns, shared by every surface that maps
// the same domain at the same degree. Building it once and reusing it across channels and across the
// scale/offset surfaces of a frame avoids rebuilding a width*(degree+1) table per evaluator.
export interface SurfaceColumnTable {
	// Number of columns covered.
	readonly count: number
	// Polynomial degree the Chebyshev values were built for.
	readonly degree: number
	// Normalized u of each column.
	readonly u: Float64Array
	// T_0..T_degree(u) per column, row-major with stride degree+1.
	readonly chebyshev: Float64Array
}

// Evaluates a fitted surface one row at a time over the columns of a `SurfaceColumnTable`.
export interface ScalarSurfaceEvaluator {
	// Number of values `fillRow` writes.
	readonly count: number
	// Writes the surface along row `y` (pixels, may be fractional) into `output[offset + i * stride]`
	// for i in [0, count). Allocates nothing.
	readonly fillRow: (y: number, output: Float64Array | Float32Array, offset: number, stride: number) => void
}

// Upper bound on thin-plate spline control points. The fit solves a dense (k+3)x(k+3) system in
// O(k^3) and an exact (zero-smoothing) spline evaluates in O(pixels*k), so both blow up for dense
// grids. Chosen as a perfect square so the spatial buckets below tile evenly.
export const SURFACE_MAX_CONTROL_POINTS = 1024

// Control points a thin-plate spline needs before its affine part is determined. Also the floor the
// control-point subsampling tops up to, so a small cap cannot turn a fittable layout into a failure.
const MIN_CONTROL_POINTS = 3

// Minimum 2D spread (RMS extent along the least-covered direction, in the normalized [-1, 1] domain)
// the accepted samples must have for the system to be well-posed. Samples confined to a thin strip
// give one basis direction almost no variation, so the surface is unconstrained across the rest of the
// domain and extrapolates wildly even though the QR reports full rank (the tiny pivot is non-zero only
// through floating-point noise). Full coverage has a spread near 0.58; a thin strip approaches 0.
export const MIN_SAMPLE_SPREAD = 0.02

// Maximum ratio of the fitted surface's magnitude bound to the largest sampled magnitude. On [-1, 1]^2
// the surface value is bounded by the L1 norm of its Chebyshev coefficients (each |T_i| <= 1), so a
// well-posed fit keeps that bound within a small multiple of the sampled values. A near-rank-deficient
// layout that slips past the rank check instead yields coefficients whose sum dwarfs the data. The
// factor is generous so genuine smooth surfaces are never rejected; only gross blow-ups are caught.
export const MAX_SURFACE_MAGNITUDE_FACTOR = 100

// Coarse-grid node spacing for spline materialization, as a fraction of the mean control-point
// spacing. A spline is smooth at the control-point scale, so evaluating it on nodes this much finer
// and bilinearly upsampling keeps the interpolation error well below the fit accuracy (~0.5% of the
// local amplitude at this fraction).
export const TPS_COARSE_FRACTION = 0.2

// Smoothing at or below this is treated as exact interpolation. The regularization added to the spline
// diagonal is `smoothing / weight`; against the O(1) normalized kernel entries a value this small is
// negligible, so the spline effectively interpolates the samples and can have sharp local structure a
// coarse-grid approximation would miss.
export const TPS_EXACT_SMOOTHING_MAX = 1e-6

// Mutable working set of samples held as parallel flat arrays. Rejection passes flip `active` instead
// of reshaping objects, which keeps the layout stable and avoids per-sample allocation in the fit.
export interface SurfaceSampleSet {
	// Sample x in pixels.
	readonly x: Float64Array
	// Sample y in pixels.
	readonly y: Float64Array
	// Sample x normalized to [-1, 1] over the domain.
	readonly u: Float64Array
	// Sample y normalized to [-1, 1] over the domain.
	readonly v: Float64Array
	// Sampled scalar value.
	readonly value: Float64Array
	// Least-squares weight in (0, 1].
	readonly weight: Float64Array
	// 1 while the sample still feeds the fit, 0 once a pass rejects it.
	readonly active: Uint8Array
	// Number of populated entries; the arrays may be longer.
	count: number
}

// Allocates an empty sample set able to hold `capacity` samples.
export function createSurfaceSampleSet(capacity: number): SurfaceSampleSet {
	return {
		x: new Float64Array(capacity),
		y: new Float64Array(capacity),
		u: new Float64Array(capacity),
		v: new Float64Array(capacity),
		value: new Float64Array(capacity),
		weight: new Float64Array(capacity),
		active: new Uint8Array(capacity),
		count: 0,
	}
}

// Appends one active sample. The normalized coordinates are left untouched; call
// `normalizeSurfaceSampleSet` once the whole set is collected.
export function pushSurfaceSample(set: SurfaceSampleSet, x: number, y: number, value: number, weight: number) {
	const i = set.count++
	set.x[i] = x
	set.y[i] = y
	set.value[i] = value
	set.weight[i] = weight
	set.active[i] = 1
}

// The full-frame normalization rectangle: pixel centers 0..width-1 and 0..height-1 map to [-1, 1].
export function fullSurfaceDomain(width: number, height: number): SurfaceDomain {
	return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 }
}

// Normalized-coordinate scale factor for one axis: `u = (x - lo) * scale - 1`. A zero-extent range
// yields 0, mapping the whole axis to -1 (matching the width == 1 behavior of the original fit).
function domainScale(lo: number, hi: number) {
	return hi > lo ? 2 / (hi - lo) : 0
}

// Fills `u`/`v` for every sample by normalizing its pixel coordinates against `domain`.
export function normalizeSurfaceSampleSet(set: SurfaceSampleSet, domain: SurfaceDomain) {
	const su = domainScale(domain.x0, domain.x1)
	const sv = domainScale(domain.y0, domain.y1)

	for (let i = 0; i < set.count; i++) {
		set.u[i] = (set.x[i] - domain.x0) * su - 1
		set.v[i] = (set.y[i] - domain.y0) * sv - 1
	}
}

// Number of samples still feeding the fit.
export function activeSurfaceSampleCount(set: SurfaceSampleSet) {
	let active = 0
	for (let i = 0; i < set.count; i++) active += set.active[i]
	return active
}

// Number of polynomial basis terms for a 2D surface of the given total degree: (d+1)*(d+2)/2.
export function basisTermCount(degree: number) {
	return ((degree + 1) * (degree + 2)) / 2
}

// Fills `ti`/`tj` with the (i, j) index pairs of the tensor basis T_i(u) * T_j(v) ordered by
// ascending total degree i + j. Returns the number of terms written.
export function fillBasisExponents(degree: number, ti: Uint8Array, tj: Uint8Array) {
	let k = 0

	for (let d = 0; d <= degree; d++) {
		for (let i = d; i >= 0; i--) {
			ti[k] = i
			tj[k] = d - i
			k++
		}
	}

	return k
}

// Fills `out[offset..offset+degree]` with Chebyshev polynomials of the first kind T_0..T_degree at
// `x` (expected in [-1, 1]) via the recurrence T_0 = 1, T_1 = x, T_d = 2x*T_{d-1} - T_{d-2}. The
// surface basis is the tensor product T_i(u)*T_j(v); Chebyshev polynomials are orthogonal on
// [-1, 1], so the least-squares design matrix is far better conditioned than with raw monomials
// u^i*v^j, which keeps the fit stable at higher degrees.
export function fillChebyshev(out: Float64Array, offset: number, x: number, degree: number) {
	out[offset] = 1
	if (degree >= 1) out[offset + 1] = x
	const x2 = 2 * x
	for (let d = 2; d <= degree; d++) out[offset + d] = x2 * out[offset + d - 1] - out[offset + d - 2]
}

// Robust normalized MAD of the first `count` values in `values`, using `scratch` for sorting and
// absolute deviations. Leaves `values` order intact so residuals can still be mapped to samples.
export function computeResidualDispersion(values: Float64Array, scratch: Float64Array, count: number) {
	if (count === 0) return Number.NaN

	scratch.set(values.subarray(0, count))
	scratch.subarray(0, count).sort()
	const median = medianOf(scratch, count)
	for (let i = 0; i < count; i++) scratch[i] = Math.abs(values[i] - median)
	scratch.subarray(0, count).sort()
	return STANDARD_DEVIATION_SCALE * medianOf(scratch, count)
}

// RMS extent of the active samples along their least-covered direction: sqrt of the smaller eigenvalue
// of the (u, v) covariance. About 0.58 for full [-1, 1] coverage, ~0 for a collinear / thin-strip
// layout regardless of orientation. `m` must be the number of active samples and be > 0.
export function activeSampleSpread(set: SurfaceSampleSet, m: number) {
	const { u, v, active, count } = set
	let su = 0
	let sv = 0
	for (let i = 0; i < count; i++) {
		if (active[i] === 0) continue
		su += u[i]
		sv += v[i]
	}
	const mu = su / m
	const mv = sv / m

	let cuu = 0
	let cvv = 0
	let cuv = 0
	for (let i = 0; i < count; i++) {
		if (active[i] === 0) continue
		const du = u[i] - mu
		const dv = v[i] - mv
		cuu += du * du
		cvv += dv * dv
		cuv += du * dv
	}
	cuu /= m
	cvv /= m
	cuv /= m

	// Smaller eigenvalue of the symmetric 2x2 covariance [[cuu, cuv], [cuv, cvv]].
	const tr = cuu + cvv
	const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (cuu * cvv - cuv * cuv)))
	return Math.sqrt(Math.max(0, tr / 2 - disc))
}

// Whether the active samples span a genuine 2D region rather than a thin strip or a collinear set. A
// spline over collinear control points has its affine component unconstrained perpendicular to the
// line, so it extrapolates wildly across the frame. The spread test is orientation-agnostic (smallest
// covariance eigenvalue), so it catches any line direction. Must be re-checked after every pass that
// can deactivate samples, since a layout that started 2D can collapse to collinear once the off-strip
// samples are rejected.
export function hasSurfaceTwoDimensionalCoverage(set: SurfaceSampleSet) {
	const active = activeSurfaceSampleCount(set)
	return active >= 3 && activeSampleSpread(set, active) >= MIN_SAMPLE_SPREAD
}

// Deactivates all but one active sample per distinct (u, v) coordinate. Overlapping sample boxes —
// common on small images or dense grids where edge boxes are clamped inward to the same window — can
// produce repeated control-point coordinates; two identical points give the spline system two
// identical rows, making it singular (the zero-smoothing diagonal cannot break the tie) so the fit
// fails. Keeping one representative per location leaves the system solvable and keeps the reported
// accepted set consistent with the control points.
export function deduplicateSurfaceSamples(set: SurfaceSampleSet) {
	const seen = new Set<string>()
	for (let i = 0; i < set.count; i++) {
		if (set.active[i] === 0) continue
		const key = `${set.u[i]},${set.v[i]}`
		if (seen.has(key)) set.active[i] = 0
		else seen.add(key)
	}
}

// Deterministically subsamples the active samples down to at most `maxPoints` control points,
// preserving spatial coverage: the normalized [-1, 1] domain is split into a g x g grid
// (g = floor(sqrt(maxPoints))) and the first active sample landing in each bucket is kept. Returns the
// chosen indices, or `undefined` when the active count is already within the cap so the common case
// allocates nothing.
export function subsampleSurfaceControlPoints(set: SurfaceSampleSet, maxPoints: number): Uint32Array | undefined {
	if (activeSurfaceSampleCount(set) <= maxPoints) return undefined

	const g = Math.max(1, Math.floor(Math.sqrt(maxPoints)))
	const seen = new Uint8Array(g * g)
	const chosen = new Uint32Array(Math.max(g * g, MIN_CONTROL_POINTS))
	let n = 0

	for (let i = 0; i < set.count; i++) {
		if (set.active[i] === 0) continue
		// Map u, v in [-1, 1] to a bucket in [0, g); clamp guards the exact +1 edge.
		const bu = Math.min(g - 1, Math.floor(((set.u[i] + 1) / 2) * g))
		const bv = Math.min(g - 1, Math.floor(((set.v[i] + 1) / 2) * g))
		const b = bv * g + bu
		if (seen[b]) continue
		seen[b] = 1
		chosen[n++] = i
	}

	// The bucket sweep guarantees spatial coverage of the whole ACTIVE set, but not of the SELECTION it
	// returns, and the spline is solved from the selection alone. Two ways it can come back degenerate:
	// a cap below 4 collapses the grid to a single bucket and yields one control point, and a set whose
	// occupied buckets happen to line up can have its first-in-bucket representatives be collinear even
	// though later samples in those same buckets give the whole set genuine 2D spread. Either leaves the
	// saddle-point system singular for a layout the uncapped fit handles, so the selection is repaired
	// against its own coverage rather than the set's.
	if (n > 0 && (n < MIN_CONTROL_POINTS || !isSpanningSelection(set, chosen, n))) {
		// The anchor pair fixes the longest axis of the selection: its first point and whichever point is
		// farthest from it. Both come from the selection when it has two, so a good spread is preserved.
		let anchor = chosen[0]
		let far = -1
		let bestDistance = 0

		for (let i = 0; i < set.count; i++) {
			if (set.active[i] === 0) continue
			const du = set.u[i] - set.u[anchor]
			const dv = set.v[i] - set.v[anchor]
			const distance = du * du + dv * dv
			if (distance > bestDistance) {
				bestDistance = distance
				far = i
			}
		}

		if (far >= 0) {
			if (n < 2) chosen[n++] = far
			else if (!containsIndex(chosen, n, far)) chosen[1] = far

			// The third control maximizes triangle area with the anchor pair, which is the property the
			// spline actually needs. Choosing it by distance instead would happily land on the midpoint of a
			// long collinear run whenever the off-line samples cluster near an endpoint.
			anchor = chosen[0]
			const u0 = set.u[anchor]
			const v0 = set.v[anchor]
			const du1 = set.u[chosen[1]] - u0
			const dv1 = set.v[chosen[1]] - v0
			let best = -1
			let bestArea = 0

			for (let i = 0; i < set.count; i++) {
				if (set.active[i] === 0) continue
				// Twice the triangle area, as the magnitude of the 2D cross product.
				const area = Math.abs(du1 * (set.v[i] - v0) - dv1 * (set.u[i] - u0))
				if (area > bestArea) {
					bestArea = area
					best = i
				}
			}

			if (best >= 0) {
				if (n < MIN_CONTROL_POINTS) chosen[n++] = best
				else if (!containsIndex(chosen, n, best)) chosen[2] = best
			}
		}
	}

	return chosen.subarray(0, n)
}

// Whether the first `n` entries of `chosen` span a genuine 2D region, using the same spread threshold as
// the sample-set predicate.
function isSpanningSelection(set: SurfaceSampleSet, chosen: Uint32Array, n: number) {
	if (n < MIN_CONTROL_POINTS) return false

	let su = 0
	let sv = 0
	for (let k = 0; k < n; k++) {
		su += set.u[chosen[k]]
		sv += set.v[chosen[k]]
	}
	const mu = su / n
	const mv = sv / n

	let cuu = 0
	let cvv = 0
	let cuv = 0
	for (let k = 0; k < n; k++) {
		const du = set.u[chosen[k]] - mu
		const dv = set.v[chosen[k]] - mv
		cuu += du * du
		cvv += dv * dv
		cuv += du * dv
	}
	cuu /= n
	cvv /= n
	cuv /= n

	const tr = cuu + cvv
	const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (cuu * cvv - cuv * cuv)))
	return Math.sqrt(Math.max(0, tr / 2 - disc)) >= MIN_SAMPLE_SPREAD
}

// Whether index `value` is among the first `n` entries of `chosen`.
function containsIndex(chosen: Uint32Array, n: number, value: number) {
	for (let k = 0; k < n; k++) if (chosen[k] === value) return true
	return false
}

// Fits a 2D Chebyshev surface to the active samples by weighted least squares (QR). Returns the
// coefficient vector, or a failure reason when there are too few samples, the layout is degenerate (a
// thin strip or too few coordinate bands for the degree), or the system is rank deficient or
// ill-conditioned enough that the surface would explode between samples.
export function fitPolynomialSurface(set: SurfaceSampleSet, degree: number, terms: number, ti: Uint8Array, tj: Uint8Array): Float64Array | SurfaceFitFailureReason {
	const { u, v, value, weight, active, count } = set

	let m = 0
	for (let i = 0; i < count; i++) m += active[i]
	if (m < terms) return 'too-few-samples'

	// Reject thin-strip / collinear layouts before trusting the solve: the QR can be nominally full rank
	// yet so ill-conditioned that the surface extrapolates wildly across the unsampled part of the frame.
	if (activeSampleSpread(set, m) < MIN_SAMPLE_SPREAD) return 'degenerate-layout'

	const A = new Matrix(m, terms)
	const b = new Float64Array(m)
	const data = A.data
	const uCheb = new Float64Array(degree + 1)
	const vCheb = new Float64Array(degree + 1)

	let row = 0
	let maxAbsValue = 0

	for (let i = 0; i < count; i++) {
		if (active[i] === 0) continue

		fillChebyshev(uCheb, 0, u[i], degree)
		fillChebyshev(vCheb, 0, v[i], degree)

		// Weighted least squares: scaling each equation (design row and right-hand side) by sqrt(weight)
		// makes QR minimize the weighted residual sum, giving reliable samples more pull.
		const w = Math.sqrt(weight[i])
		const base = row * terms
		for (let k = 0; k < terms; k++) data[base + k] = w * uCheb[ti[k]] * vCheb[tj[k]]
		b[row] = w * value[i]
		if (Math.abs(value[i]) > maxAbsValue) maxAbsValue = Math.abs(value[i])
		row++
	}

	try {
		// `A` is a throwaway design matrix used only for this solve, so factorize in place and skip the clone.
		const qr = new QrDecomposition(A, true)
		if (!qr.isFullRank) return 'rank-deficient'
		// solve() returns a vector sized to the sample count (rows); only the first `terms` entries are
		// the least-squares coefficients, the rest are residual internals. Copy just the coefficients.
		const coefficients = qr.solve(b).slice(0, terms)

		// Guard against ill-conditioned layouts that pass isFullRank through floating-point noise (e.g.
		// too few distinct coordinate bands for the degree): the surface value on [-1, 1]^2 is bounded by
		// the L1 norm of the coefficients, so reject when that bound explodes past the sampled value scale.
		let coefficientL1 = 0
		for (let k = 0; k < terms; k++) coefficientL1 += Math.abs(coefficients[k])
		if (coefficientL1 > MAX_SURFACE_MAGNITUDE_FACTOR * maxAbsValue) return 'unstable-magnitude'

		return coefficients
	} catch {
		return 'rank-deficient'
	}
}

// Evaluates the Chebyshev surface at a normalized point, using `uCheb`/`vCheb` as reusable scratch.
export function evaluatePolynomialSurfaceAt(coefficients: Float64Array, u: number, v: number, degree: number, terms: number, ti: Uint8Array, tj: Uint8Array, uCheb: Float64Array, vCheb: Float64Array) {
	fillChebyshev(uCheb, 0, u, degree)
	fillChebyshev(vCheb, 0, v, degree)

	let sum = 0
	for (let k = 0; k < terms; k++) sum += coefficients[k] * uCheb[ti[k]] * vCheb[tj[k]]
	return sum
}

// Outcome of the iterative polynomial fit.
interface PolynomialFitOutcome {
	readonly coefficients: Float64Array
	readonly residual: number
}

// Fits the polynomial surface with iterative residual rejection, deactivating outliers between refits.
// `residuals`/`scratch` are reusable buffers sized to `set.count`.
//
// Rejection can be asymmetric: when the modeled quantity is a lower envelope (the sky background),
// samples above the surface are contamination and are rejected with a tight sigma while samples below
// it are only dropped when they are gross outliers. When a refit turns out to be unsolvable the
// samples rejected in that pass are reinstated, so the reported accepted set always matches the kept
// coefficients.
export function fitPolynomialSurfaceWithRejection(set: SurfaceSampleSet, degree: number, terms: number, ti: Uint8Array, tj: Uint8Array, rejection: Required<SurfaceRejectionOptions>, residuals: Float64Array, scratch: Float64Array): PolynomialFitOutcome | SurfaceFitFailureReason {
	const first = fitPolynomialSurface(set, degree, terms, ti, tj)
	if (typeof first === 'string') return first

	let coefficients = first
	let residualDispersion = 0

	const uCheb = new Float64Array(degree + 1)
	const vCheb = new Float64Array(degree + 1)
	const { u, v, value, active, count } = set

	// Sigma multiples per side. `symmetric` mirrors `high`; `none` short-circuits the loop below.
	const highLimitSigma = rejection.high
	const lowLimitSigma = rejection.mode === 'symmetric' ? rejection.high : rejection.low
	const iterations = rejection.mode === 'none' ? 0 : rejection.iterations

	// Samples rejected during the current pass. Tracked so they can be reinstated if the subsequent
	// refit turns out to be unsolvable, keeping the reported accepted set consistent with the kept fit.
	const rejectedThisPass: number[] = []

	for (let iteration = 0; iteration <= iterations; iteration++) {
		let n = 0
		for (let i = 0; i < count; i++) {
			if (active[i] === 0) continue
			residuals[n++] = value[i] - evaluatePolynomialSurfaceAt(coefficients, u[i], v[i], degree, terms, ti, tj, uCheb, vCheb)
		}

		residualDispersion = computeResidualDispersion(residuals, scratch, n)

		if (iteration === iterations || !Number.isFinite(residualDispersion)) break

		// The robust MAD collapses toward 0 on a nearly flat set where most residuals are identical, even
		// when a few gross outliers remain; floating point can leave it at ~1e-17 rather than exactly 0.
		// Using it directly would make the thresholds ~0, flag every sample, and reinstate them all on the
		// failed refit — leaving the outliers active and the surface pulled toward them. Compare it to the
		// overall standard deviation (scale-invariant): when the MAD is negligible but real spread exists
		// the bulk is degenerate, so fall back to the non-robust std to keep the thresholds meaningful.
		// When the std is 0 too the residuals are genuinely constant and there is nothing to reject.
		const spread = standardDeviationOf(residuals, n)
		if (spread === 0 || Number.isNaN(spread)) break
		const scale = residualDispersion > 1e-6 * spread ? residualDispersion : spread

		const highLimit = highLimitSigma * scale
		const lowLimit = lowLimitSigma * scale
		rejectedThisPass.length = 0
		let index = 0
		for (let i = 0; i < count; i++) {
			if (active[i] === 0) continue
			// residual = sample - surface: positive above the surface, negative below it.
			const residual = residuals[index]
			if (residual > highLimit || residual < -lowLimit) {
				active[i] = 0
				rejectedThisPass.push(i)
			}
			index++
		}

		if (rejectedThisPass.length === 0) break

		const refit = fitPolynomialSurface(set, degree, terms, ti, tj)
		if (typeof refit === 'string') {
			// The reduced sample set is unsolvable. Reinstate the samples rejected in this pass and keep the
			// previous fit, which matches those samples, so the accepted set stays consistent with it.
			for (const i of rejectedThisPass) active[i] = 1
			break
		}
		coefficients = refit
	}

	return { coefficients, residual: Number.isFinite(residualDispersion) ? residualDispersion : 0 }
}

// Thin-plate spline radial basis U(r) = r^2 * ln(r), expressed from the squared distance s = r^2 as
// 0.5 * s * ln(s) with U(0) = 0. Taking the squared distance avoids a sqrt in the hot evaluation loop.
function tpsKernel(sq: number) {
	return sq > 0 ? 0.5 * sq * Math.log(sq) : 0
}

// Fits a smoothing thin-plate spline. Solves the (k+3)x(k+3) saddle-point system
// [K + s*W^-1, P; P^T, 0] [w; a] = [f; 0], where K_ij = U(|p_i - p_j|), P rows are [1, u_i, v_i], `s`
// is the smoothing term scaled by each sample's inverse weight, and the P^T rows enforce the affine
// side conditions. Control points are the active samples, or the subset named by `indices` when the
// caller capped them. Returns the packed coefficients [a0, a1, a2, w...] and the interleaved control
// points, or a failure reason when there are fewer than 3 points or the system is singular.
export function fitThinPlateSplineSurface(set: SurfaceSampleSet, indices: Uint32Array | undefined, smoothing: number): { coefficients: Float64Array; controlPoints: Float64Array } | SurfaceFitFailureReason {
	const us: number[] = []
	const vs: number[] = []
	const fs: number[] = []
	const ws: number[] = []

	if (indices === undefined) {
		for (let i = 0; i < set.count; i++) {
			if (set.active[i] === 0) continue
			us.push(set.u[i])
			vs.push(set.v[i])
			fs.push(set.value[i])
			ws.push(set.weight[i])
		}
	} else {
		for (const i of indices) {
			us.push(set.u[i])
			vs.push(set.v[i])
			fs.push(set.value[i])
			ws.push(set.weight[i])
		}
	}

	const k = us.length
	if (k < MIN_CONTROL_POINTS) return 'too-few-samples'

	const size = k + 3
	const L = new Matrix(size, size)
	const data = L.data

	for (let i = 0; i < k; i++) {
		const ui = us[i]
		const vi = vs[i]
		const rowI = i * size

		for (let j = i + 1; j < k; j++) {
			const du = ui - us[j]
			const dv = vi - vs[j]
			const value = tpsKernel(du * du + dv * dv)
			data[rowI + j] = value
			data[j * size + i] = value
		}

		// Diagonal smoothing: reliable samples (weight ~ 1) get the base smoothing, noisy ones more.
		data[rowI + i] = smoothing > 0 ? smoothing / ws[i] : 0

		// Affine block P (columns k..k+2) and its transpose P^T (rows k..k+2).
		data[rowI + k] = 1
		data[rowI + k + 1] = ui
		data[rowI + k + 2] = vi
		data[k * size + i] = 1
		data[(k + 1) * size + i] = ui
		data[(k + 2) * size + i] = vi
	}

	const b = new Float64Array(size)
	for (let i = 0; i < k; i++) b[i] = fs[i]

	try {
		// `L` is a throwaway system matrix used only for this solve, so factorize in place and skip the clone.
		const x = new LuDecomposition(L, true).solve(b)
		for (let i = 0; i < size; i++) if (!Number.isFinite(x[i])) return 'singular-system'

		const coefficients = new Float64Array(size)
		coefficients[0] = x[k]
		coefficients[1] = x[k + 1]
		coefficients[2] = x[k + 2]
		for (let i = 0; i < k; i++) coefficients[3 + i] = x[i]

		const controlPoints = new Float64Array(2 * k)
		for (let i = 0; i < k; i++) {
			controlPoints[2 * i] = us[i]
			controlPoints[2 * i + 1] = vs[i]
		}

		return { coefficients, controlPoints }
	} catch {
		return 'singular-system'
	}
}

// Evaluates a fitted thin-plate spline at one normalized point (u, v).
export function evaluateThinPlateSplineAt(coefficients: Float64Array, controlPoints: Float64Array, k: number, u: number, v: number) {
	let sum = coefficients[0] + coefficients[1] * u + coefficients[2] * v

	for (let c = 0; c < k; c++) {
		const du = u - controlPoints[2 * c]
		const dv = v - controlPoints[2 * c + 1]
		const sq = du * du + dv * dv
		if (sq > 0) sum += coefficients[3 + c] * (0.5 * sq * Math.log(sq))
	}

	return sum
}

// Whether a spline with this smoothing must be materialized exactly rather than through the coarse-grid
// approximation, which would break its interpolation contract.
export function isExactThinPlateSpline(model: ScalarSurfaceModel) {
	return model.type === 'thinPlateSpline' && model.smoothing <= TPS_EXACT_SMOOTHING_MAX
}

// Builds the Chebyshev basis for `count` evaluation columns starting at pixel `x0` with spacing
// `xStep`, normalized against `domain`. Depends only on the column geometry and the degree, so one
// table serves every surface sharing them.
export function createSurfaceColumnTable(degree: number, domain: SurfaceDomain, count: number, x0 = 0, xStep = 1): SurfaceColumnTable {
	const su = domainScale(domain.x0, domain.x1)
	const stride = degree + 1
	const u = new Float64Array(count)
	const chebyshev = new Float64Array(count * stride)

	for (let i = 0; i < count; i++) {
		const ui = (x0 + i * xStep - domain.x0) * su - 1
		u[i] = ui
		fillChebyshev(chebyshev, i * stride, ui, degree)
	}

	return { count, degree, u, chebyshev }
}

// Polynomial row evaluator. The tensor basis T_i(u)*T_j(v) is separable, so each row first collapses
// the 2D terms into per-u-degree coefficients rowCoef[i] = sum_j coef[i,j]*T_j(v); the per-column inner
// loop then costs degree+1 multiplies instead of `terms` (5 vs 15 at degree 4, 7 vs 28 at degree 6).
class PolynomialSurfaceEvaluator implements ScalarSurfaceEvaluator {
	readonly count: number

	readonly #coefficients: Float64Array
	readonly #table: SurfaceColumnTable
	readonly #degree: number
	readonly #terms: number
	readonly #ti: Uint8Array
	readonly #tj: Uint8Array
	readonly #sv: number
	readonly #y0: number
	readonly #vRow: Float64Array
	readonly #rowCoef: Float64Array

	constructor(model: ScalarSurfaceModel, table: SurfaceColumnTable) {
		this.count = table.count
		this.#coefficients = model.coefficients
		this.#table = table
		this.#degree = model.degree
		this.#terms = basisTermCount(model.degree)
		this.#ti = new Uint8Array(this.#terms)
		this.#tj = new Uint8Array(this.#terms)
		fillBasisExponents(model.degree, this.#ti, this.#tj)
		this.#sv = domainScale(model.domain.y0, model.domain.y1)
		this.#y0 = model.domain.y0
		this.#vRow = new Float64Array(model.degree + 1)
		this.#rowCoef = new Float64Array(model.degree + 1)
	}

	fillRow(y: number, output: Float64Array | Float32Array, offset: number, stride: number) {
		const degree = this.#degree
		const rowCoef = this.#rowCoef
		const vRow = this.#vRow
		const cheb = this.#table.chebyshev
		const columnStride = degree + 1

		fillChebyshev(vRow, 0, (y - this.#y0) * this.#sv - 1, degree)

		rowCoef.fill(0)
		for (let k = 0; k < this.#terms; k++) rowCoef[this.#ti[k]] += this.#coefficients[k] * vRow[this.#tj[k]]

		let out = offset
		for (let i = 0; i < this.count; i++, out += stride) {
			const base = i * columnStride
			let sum = 0
			for (let d = 0; d <= degree; d++) sum += rowCoef[d] * cheb[base + d]
			output[out] = sum
		}
	}
}

// Thin-plate spline row evaluator. Costs O(count * controlPoints) per row, so callers that materialize
// a whole plane should use `evaluateScalarSurfaceInto`, which coarsens; this evaluator is meant for the
// already-sparse node grids of local normalization.
class ThinPlateSplineSurfaceEvaluator implements ScalarSurfaceEvaluator {
	readonly count: number

	readonly #coefficients: Float64Array
	readonly #controlPoints: Float64Array
	readonly #k: number
	readonly #u: Float64Array
	readonly #sv: number
	readonly #y0: number

	constructor(model: ScalarSurfaceModel, table: SurfaceColumnTable) {
		this.count = table.count
		this.#coefficients = model.coefficients
		this.#controlPoints = model.controlPoints!
		this.#k = model.controlPoints!.length / 2
		this.#u = table.u
		this.#sv = domainScale(model.domain.y0, model.domain.y1)
		this.#y0 = model.domain.y0
	}

	fillRow(y: number, output: Float64Array | Float32Array, offset: number, stride: number) {
		const v = (y - this.#y0) * this.#sv - 1
		let out = offset
		for (let i = 0; i < this.count; i++, out += stride) output[out] = evaluateThinPlateSplineAt(this.#coefficients, this.#controlPoints, this.#k, this.#u[i], v)
	}
}

// Creates a row evaluator for `model` over the columns of `table`. The table's degree must match the
// model's for the polynomial path; the spline path uses only its normalized column coordinates.
export function createScalarSurfaceEvaluator(model: ScalarSurfaceModel, table: SurfaceColumnTable): ScalarSurfaceEvaluator {
	return model.type === 'thinPlateSpline' ? new ThinPlateSplineSurfaceEvaluator(model, table) : new PolynomialSurfaceEvaluator(model, table)
}

// Evaluates a fitted surface at arbitrary, irregularly placed points.
export interface ScalarSurfacePointEvaluator {
	// Value of the surface at one pixel position, which may be fractional. Allocates nothing.
	readonly at: (x: number, y: number) => number
}

// Creates a point evaluator for `model`, reusing its own scratch across calls. Use it for scattered
// positions; a regular row of points is cheaper through `createScalarSurfaceEvaluator`, which shares
// one precomputed Chebyshev basis across every row.
export function createScalarSurfacePointEvaluator(model: ScalarSurfaceModel): ScalarSurfacePointEvaluator {
	const su = domainScale(model.domain.x0, model.domain.x1)
	const sv = domainScale(model.domain.y0, model.domain.y1)
	const { x0, y0 } = model.domain

	if (model.type === 'thinPlateSpline') {
		const controlPoints = model.controlPoints!
		const k = controlPoints.length / 2
		return { at: (x, y) => evaluateThinPlateSplineAt(model.coefficients, controlPoints, k, (x - x0) * su - 1, (y - y0) * sv - 1) }
	}

	const degree = model.degree
	const terms = basisTermCount(degree)
	const ti = new Uint8Array(terms)
	const tj = new Uint8Array(terms)
	fillBasisExponents(degree, ti, tj)
	const uCheb = new Float64Array(degree + 1)
	const vCheb = new Float64Array(degree + 1)

	return { at: (x, y) => evaluatePolynomialSurfaceAt(model.coefficients, (x - x0) * su - 1, (y - y0) * sv - 1, degree, terms, ti, tj, uCheb, vCheb) }
}

// Coarse evaluation step in pixels for a spline with `k` control points over a width*height plane.
// Nodes are spaced a fraction of the mean control-point spacing sqrt(area/k). Returns 1 (evaluate
// every pixel directly) for small planes or degenerate axes, where coarsening would not pay off.
function tpsCoarseStep(width: number, height: number, domain: SurfaceDomain, k: number) {
	if (k <= 0 || width < 2 || height < 2) return 1
	// The spacing must come from the area the control points actually occupy, which is the fitted domain,
	// not the output plane. A spline fitted over a small covered region of a large frame has its control
	// points packed into that region; scaling by the plane would space the nodes far wider than them and
	// the bilinear upsample would no longer track the fitted surface even inside the supported area. The
	// domain spans pixel centers, so its inclusive extent is what matches the plane's pixel count, and a
	// full-frame domain reproduces `width * height` exactly.
	const spacing = Math.sqrt(((domain.x1 - domain.x0 + 1) * (domain.y1 - domain.y0 + 1)) / k)
	return Math.max(1, Math.floor(spacing * TPS_COARSE_FRACTION))
}

// Materializes a fitted spline over the whole plane, writing into `output[offset + p * stride]` in
// row-major pixel order. Direct evaluation is O(width * height * controlPoints); since a smoothing
// surface is smooth, this instead evaluates the exact spline on a coarse grid and bilinearly upsamples
// to full resolution, cutting the cost by the squared coarsening factor for a tiny, documented
// interpolation error. Small planes fall back to exact per-pixel evaluation. When `exact` is set (a
// zero-smoothing, interpolating spline), coarsening is disabled so the materialized surface passes
// through the accepted samples as the interpolation contract requires.
function evaluateThinPlateSplineInto(model: ScalarSurfaceModel, output: Float64Array | Float32Array, offset: number, stride: number, exact: boolean) {
	const { width, height, domain } = model
	const coefficients = model.coefficients
	const controlPoints = model.controlPoints!
	const k = controlPoints.length / 2
	const su = domainScale(domain.x0, domain.x1)
	const sv = domainScale(domain.y0, domain.y1)
	const step = exact ? 1 : tpsCoarseStep(width, height, domain, k)

	if (step <= 1) {
		for (let y = 0; y < height; y++) {
			const v = (y - domain.y0) * sv - 1
			let idx = y * width * stride + offset
			for (let x = 0; x < width; x++, idx += stride) output[idx] = evaluateThinPlateSplineAt(coefficients, controlPoints, k, (x - domain.x0) * su - 1, v)
		}
		return
	}

	// Coarse node grid spanning the full plane (first node at 0, last exactly at the far edge), so
	// bilinear upsampling never extrapolates. Evaluate the exact spline at each node.
	const ncx = Math.max(2, Math.ceil((width - 1) / step) + 1)
	const ncy = Math.max(2, Math.ceil((height - 1) / step) + 1)
	const sx = (width - 1) / (ncx - 1)
	const sy = (height - 1) / (ncy - 1)
	const coarse = new Float64Array(ncx * ncy)

	for (let jy = 0; jy < ncy; jy++) {
		const v = (jy * sy - domain.y0) * sv - 1
		const row = jy * ncx
		for (let jx = 0; jx < ncx; jx++) coarse[row + jx] = evaluateThinPlateSplineAt(coefficients, controlPoints, k, (jx * sx - domain.x0) * su - 1, v)
	}

	for (let y = 0; y < height; y++) {
		const fy = y / sy
		const j0 = Math.min(ncy - 2, Math.floor(fy))
		const ty = fy - j0
		const row0 = j0 * ncx
		const row1 = row0 + ncx
		let idx = y * width * stride + offset

		for (let x = 0; x < width; x++, idx += stride) {
			const fx = x / sx
			const i0 = Math.min(ncx - 2, Math.floor(fx))
			const tx = fx - i0
			const c00 = coarse[row0 + i0]
			const c01 = coarse[row0 + i0 + 1]
			const c10 = coarse[row1 + i0]
			const c11 = coarse[row1 + i0 + 1]
			const top = c00 + (c01 - c00) * tx
			const bot = c10 + (c11 - c10) * tx
			output[idx] = top + (bot - top) * ty
		}
	}
}

// Materializes a fitted surface over its whole plane, writing width*height values into
// `output[offset + p * stride]` in row-major pixel order. The strided form lets callers write directly
// into one channel of an interleaved image buffer without an intermediate plane copy.
//
// `table` optionally supplies a precomputed per-column Chebyshev basis (see `createSurfaceColumnTable`)
// covering the plane's integer columns; sharing one across channels avoids rebuilding it per call. It
// is ignored by the spline model.
export function evaluateScalarSurfaceInto(model: ScalarSurfaceModel, output: Float64Array | Float32Array, offset = 0, stride = 1, table?: SurfaceColumnTable) {
	if (model.type === 'thinPlateSpline') {
		evaluateThinPlateSplineInto(model, output, offset, stride, isExactThinPlateSpline(model))
		return
	}

	const columns = table ?? createSurfaceColumnTable(model.degree, model.domain, model.width)
	const evaluator = new PolynomialSurfaceEvaluator(model, columns)
	const { width, height } = model

	for (let y = 0; y < height; y++) evaluator.fillRow(y, output, y * width * stride + offset, stride)
}

// Snapshots the sample set into the immutable per-sample diagnostics carried by the model.
function collectFitSamples(set: SurfaceSampleSet) {
	const samples = new Array<SurfaceFitSample>(set.count)
	for (let i = 0; i < set.count; i++) samples[i] = { x: set.x[i], y: set.y[i], value: set.value[i], weight: set.weight[i], accepted: set.active[i] !== 0 }
	return samples
}

// Fits a scalar surface to weighted point samples over a width x height pixel plane.
//
// The polynomial path fits by weighted least squares with optional iterative residual rejection. The
// spline path checks 2D coverage, drops duplicate coordinates, caps the control points, and fits a
// smoothing spline; it never rejects by residual, because a flexible surface would read the very
// structure it exists to model as outliers.
//
// Samples are expected to be finite and inside `options.domain` (the full frame by default); nothing is
// validated. Returns a failure reason instead of throwing when the layout cannot support a fit.
export function fitScalarSurface(samples: readonly SurfaceSample[], width: number, height: number, options: SurfaceFitOptions = {}): SurfaceFitResult {
	const model = options.model ?? 'polynomial'
	const degree = options.degree ?? 4
	const smoothing = model === 'thinPlateSpline' ? (options.smoothing ?? 0.1) : 0
	// Clamped to the module's tractability ceiling rather than replacing it: the spline builds a dense
	// (k+3)x(k+3) matrix and solves it in O(k^3), so an unclamped 4096 would allocate about 134 MB and a
	// larger value would exhaust the process outright. The floor keeps a spline-sized cap fittable.
	const maxControlPoints = Math.min(Math.max(options.maxControlPoints ?? SURFACE_MAX_CONTROL_POINTS, MIN_CONTROL_POINTS), SURFACE_MAX_CONTROL_POINTS)
	const domain = options.domain ?? fullSurfaceDomain(width, height)

	const set = createSurfaceSampleSet(samples.length)
	for (const sample of samples) pushSurfaceSample(set, sample.x, sample.y, sample.value, sample.weight ?? 1)
	normalizeSurfaceSampleSet(set, domain)

	const terms = basisTermCount(degree)
	const ti = new Uint8Array(terms)
	const tj = new Uint8Array(terms)
	fillBasisExponents(degree, ti, tj)

	const base = { width, height, domain, degree, smoothing }

	if (model === 'thinPlateSpline') {
		// Sample count is tested before spread so a sparse set is reported as `too-few-samples` rather than
		// as a degenerate layout: the spread predicate fails for both and cannot tell them apart, and the
		// two mean different things to the caller. Dedup needs no second count check, since a layout with
		// real 2D spread already holds three non-collinear distinct points and dedup drops only duplicates.
		if (activeSurfaceSampleCount(set) < MIN_CONTROL_POINTS) return { ok: false, reason: 'too-few-samples' }
		if (!hasSurfaceTwoDimensionalCoverage(set)) return { ok: false, reason: 'degenerate-layout' }

		deduplicateSurfaceSamples(set)

		if (!hasSurfaceTwoDimensionalCoverage(set)) return { ok: false, reason: 'degenerate-layout' }

		const indices = subsampleSurfaceControlPoints(set, maxControlPoints)
		const tps = fitThinPlateSplineSurface(set, indices, smoothing)
		if (typeof tps === 'string') return { ok: false, reason: tps }

		// An exact (interpolating) spline only passes through its control points. When the cap dropped some
		// active samples, mark those rejected so the reported accepted set matches the interpolated set.
		// A genuine smoothing spline interpolates nothing, so its dropped samples legitimately stay accepted.
		if (indices !== undefined && smoothing <= TPS_EXACT_SMOOTHING_MAX) {
			const kept = new Uint8Array(set.count)
			for (const i of indices) kept[i] = 1
			for (let i = 0; i < set.count; i++) if (kept[i] === 0) set.active[i] = 0
		}

		const k = tps.controlPoints.length / 2
		const residuals = new Float64Array(set.count)
		const scratch = new Float64Array(set.count)
		let n = 0
		for (let i = 0; i < set.count; i++) {
			if (set.active[i] === 0) continue
			residuals[n++] = set.value[i] - evaluateThinPlateSplineAt(tps.coefficients, tps.controlPoints, k, set.u[i], set.v[i])
		}
		const dispersion = computeResidualDispersion(residuals, scratch, n)
		const accepted = activeSurfaceSampleCount(set)

		return {
			ok: true,
			model: {
				...base,
				type: 'thinPlateSpline',
				coefficients: tps.coefficients,
				controlPoints: tps.controlPoints,
				acceptedSamples: accepted,
				rejectedSamples: set.count - accepted,
				residual: Number.isFinite(dispersion) ? dispersion : 0,
				samples: collectFitSamples(set),
			},
		}
	}

	const rejection: Required<SurfaceRejectionOptions> = {
		mode: options.rejection?.mode ?? 'none',
		low: options.rejection?.low ?? 3,
		high: options.rejection?.high ?? 3,
		iterations: options.rejection?.iterations ?? 0,
	}

	const residuals = new Float64Array(set.count)
	const scratch = new Float64Array(set.count)
	const outcome = fitPolynomialSurfaceWithRejection(set, degree, terms, ti, tj, rejection, residuals, scratch)
	if (typeof outcome === 'string') return { ok: false, reason: outcome }

	const accepted = activeSurfaceSampleCount(set)

	return {
		ok: true,
		model: {
			...base,
			type: 'polynomial',
			coefficients: outcome.coefficients,
			acceptedSamples: accepted,
			rejectedSamples: set.count - accepted,
			residual: outcome.residual,
			samples: collectFitSamples(set),
		},
	}
}
