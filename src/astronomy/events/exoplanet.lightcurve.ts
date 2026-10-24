import { PI, PIOVERTWO, TAU } from '../../core/constants'
import { validatePositiveInteger } from '../../core/validation'
import { LuDecomposition, Matrix } from '../../math/linear-algebra/matrix'
import { estimateLeastSquaresConditioning } from '../../math/numerical/least.squares'
import type { NumberArray } from '../../math/numerical/math'
import { levenbergMarquardt } from '../../math/numerical/optimization'
import { chiSquareCdf } from '../../math/numerical/statistics'

// Physical light curve of an exoplanet transit: an opaque spherical planet crossing a quadratically
// limb-darkened spherical star on a circular orbit, and a weighted least-squares fit of that model to
// photometry. The occulted flux is the analytic solution of Mandel & Agol (2002, ApJ 580, L171) in the
// case split of Eastman, Gaudi & Agol (2013, PASP 125, 83), with the complete elliptic integrals from
// Bulirsch's cel. Separations, radii and the semi-major axis are in stellar radii; times, periods,
// durations and exposures are days of one uniform scale (for example BJD_TDB); angles are radians;
// fluxes are relative to the out-of-transit level (1 out of transit). The orbit is circular, the planet
// is dark (no secondary eclipse, phase curve or planetary light), and time delays across the orbit,
// gravity darkening, spots and oblateness are not modeled. Exposure averaging is a midpoint rule over
// equal sub-exposures (Kipping 2010, MNRAS 408, 1758). The fit derives no planet mass: a/R* and the
// impact parameter come from the transit shape alone. Model functions allocate nothing except the
// optional output curve; the fit allocates its per-call work arrays.

// Quadratic limb-darkening coefficients [u1, u2] of I(μ) / I(1) = 1 − u1 (1 − μ) − u2 (1 − μ)², with μ
// the cosine of the angle between the line of sight and the stellar surface normal. Positive intensities
// darkening monotonically toward the limb need u1 >= 0, u1 + u2 <= 1 and u1 + 2 u2 >= 0 (Kipping 2013,
// MNRAS 435, 2152); the flux is defined while 1 − u1/3 − u2/6 > 0.
export type QuadraticLimbDarkening = readonly [u1: number, u2: number]

// Geometry and limb darkening of a transiting planet on a circular orbit.
export interface TransitParameters {
	// Mid-transit time T0 (conjunction, least projected separation), days in the scale of the sample times.
	readonly epoch: number
	// Orbital period P, days, positive.
	readonly period: number
	// Planet-to-star radius ratio p = Rp / R*, non-negative; 0 means no occultation.
	readonly radiusRatio: number
	// Impact parameter b = (a / R*) cos i, the projected separation at conjunction in stellar radii,
	// non-negative. A value above a / R* is treated as a / R* (a pole-on orbit).
	readonly impactParameter: number
	// Semi-major axis in stellar radii a / R*, positive.
	readonly scaledSemiMajorAxis: number
	// Quadratic limb-darkening coefficients of the star in the observed band.
	readonly limbDarkening: QuadraticLimbDarkening
}

// Finite-exposure averaging of a modeled flux sample.
export interface TransitExposureOptions {
	// Exposure (integration) time centered on each sample time, days, finite and non-negative. Defaults
	// to 0 (instantaneous samples).
	readonly exposureTime?: number
	// Number of equal sub-exposures averaged by the midpoint rule, a positive integer at most 1000.
	// Defaults to ceil(exposureTime / 1 minute), at least 1; a larger exposure throws a RangeError instead
	// of silently running a huge integration (often an exposure in seconds passed as days).
	readonly supersample?: number
}

// Parameter that the fit can adjust. 'limbDarkening' frees both coefficients through the Kipping
// (2013) parameters q1 = (u1 + u2)² and q2 = u1 / (2 (u1 + u2)), each bounded to [0, 1], which keeps
// the intensity positive and monotonic.
export type TransitFitParameter = 'epoch' | 'period' | 'radiusRatio' | 'impactParameter' | 'scaledSemiMajorAxis' | 'limbDarkening' | 'baseline'

// Fit parameter with explicit box bounds.
export type TransitBoundedParameter = Exclude<TransitFitParameter, 'limbDarkening'>

// Physical parameter of the covariance matrix: the bounded parameters and the two limb-darkening
// coefficients.
export type TransitCovarianceParameter = TransitBoundedParameter | 'u1' | 'u2'

// Outcome of the fit.
// 'ok': the optimizer converged (the Gauss-Newton step from the result would lower the chi-square by at
// most 1e-3 over the free parameters not at a bound).
// 'notConverged': the iteration limit was reached first; the parameters and diagnostics describe the
// last accepted point.
// 'insufficientData': at most as many usable samples as free coefficients, fewer than
// minInTransitPoints usable samples overlapping the initial transit, or no positive out-of-transit
// level; no fit was run and the initial parameters are returned.
export type TransitFitStatus = 'ok' | 'notConverged' | 'insufficientData'

// Diagnostic flag of a fit. None of them changes the status.
// 'parameterAtBound': a free parameter ended within 1e-6 of its range from a bound, or the impact parameter on
// the physical bound b = 0 (atBound names them). The uncertainty of a parameter at a box bound is not
// meaningful; b on 0 is held there, leaves the covariance (the light curve has no first-order dependence on
// b at 0), and the other uncertainties are conditional on b = 0.
// 'singularCovariance': the column-scaled Jacobian is rank deficient (condition number above 1e12), so
// some combination of the free parameters is unconstrained and there is no covariance.
// 'strongDegeneracy': two free parameters are correlated by more than 0.95 in absolute value.
// 'grazing': b > 1 − p, so the planet never lies wholly inside the stellar disk; the radius ratio and
// the impact parameter are then strongly degenerate.
// 'noTransit': the fitted geometry has no occultation (p = 0 or b >= 1 + p).
// 'missingIngress', 'missingEgress': no usable exposure overlaps the fitted ingress (first to second
// contact) or egress (third to fourth contact) of any event, so that side's shape is unconstrained.
// 'poorFit': the chi-square exceeds its 99.9% quantile for the degrees of freedom, so the errors are
// underestimated or the model is inadequate (spots, trends, eccentricity); the covariance is then too
// optimistic.
export type TransitFitFlag = 'parameterAtBound' | 'singularCovariance' | 'strongDegeneracy' | 'grazing' | 'noTransit' | 'missingIngress' | 'missingEgress' | 'poorFit'

// Initial model of the fit and the values of its fixed parameters.
export interface TransitFitInitial extends TransitParameters {
	// Out-of-transit flux level in the unit of the samples, positive. Defaults to the inverse-variance
	// weighted mean of the usable samples outside the initial transit (of all of them when none is).
	readonly baseline?: number
}

// Options of fitTransit.
export interface TransitFitOptions extends TransitExposureOptions {
	// Parameters to adjust; the others keep their initial values. Defaults to epoch, radiusRatio,
	// impactParameter, scaledSemiMajorAxis and baseline: the period and the limb darkening are fixed
	// because a single transit cannot constrain the period and the limb darkening is degenerate with the
	// radius ratio and the impact parameter at modest signal-to-noise.
	readonly free?: readonly TransitFitParameter[]
	// Box bounds [min, max] of the free parameters, finite with min < max; an initial value outside them
	// starts inside the nearest bound. Defaults, with T14 the initial total duration: epoch ± T14 / 2;
	// period ± T14 / (2 max(1, N)) with N the largest distance of a sample from the initial epoch in
	// periods (the farthest event moves by at most T14 / 2); radiusRatio [0, 1]; impactParameter
	// [0, 1 + max radiusRatio]; scaledSemiMajorAxis [1, 10 a/R*]; baseline ± 50%. An impact parameter
	// range starting at 0 is searched symmetrically in [−max, max], because the light curve is even in b.
	readonly bounds?: { readonly [K in TransitBoundedParameter]?: readonly [min: number, max: number] }
	// Levenberg-Marquardt iterations per run, a positive integer; the fit restarts from the last point up
	// to three runs while not converged (one more when the impact parameter is held on 0 or released).
	// Defaults to 200.
	readonly maxIterations?: number
	// Minimum number of usable samples overlapping the initial transit, a positive integer. Defaults to 3.
	readonly minInTransitPoints?: number
}

// Result of fitTransit. Uncertainties are 1σ from the inverse of the Fisher matrix JᵀWJ at the result,
// with W the inverse flux variances as given (not rescaled by the reduced chi-square), and are
// meaningful only for a converged fit away from the bounds.
export interface TransitFitResult {
	readonly status: TransitFitStatus
	// Diagnostic flags, in the TransitFitFlag declaration order.
	readonly flags: readonly TransitFitFlag[]
	// Fitted model, with the fixed parameters as given; the epoch is in the scale of the sample times.
	readonly parameters: TransitParameters
	// Fitted out-of-transit flux level, in the unit of the samples.
	readonly baseline: number
	// Free physical parameters, in TransitCovarianceParameter declaration order, naming the rows and
	// columns of covariance; a free 'limbDarkening' contributes 'u1' and 'u2', and an impact parameter held on
	// b = 0 is left out.
	readonly parameterNames: readonly TransitCovarianceParameter[]
	// Row-major covariance of parameterNames (days for epoch and period, days² for their product),
	// freshly allocated; undefined for 'singularCovariance' and 'insufficientData'.
	readonly covariance?: Float64Array
	// 1σ uncertainties of the free physical parameters, when the covariance exists.
	readonly uncertainties?: { readonly [K in TransitCovarianceParameter]?: number }
	// Orbital inclination i, radians in [0, π/2], and its 1σ uncertainty.
	readonly inclination: number
	readonly inclinationError?: number
	// Total duration T14 (first to fourth contact), days, 0 without a transit, and its 1σ uncertainty.
	readonly totalDuration: number
	readonly totalDurationError?: number
	// Full duration T23 (second to third contact), days, 0 for a grazing or no transit, and its 1σ
	// uncertainty (undefined for a grazing or no transit).
	readonly fullDuration: number
	readonly fullDurationError?: number
	// Free parameters at a bound.
	readonly atBound: readonly TransitFitParameter[]
	// Weighted sum of squared residuals Σ ((flux − model) / fluxError)² of the usable samples.
	readonly chiSquare: number
	// Usable samples minus free physical parameters, at least 0.
	readonly degreesOfFreedom: number
	// chiSquare / degreesOfFreedom, undefined without degrees of freedom.
	readonly reducedChiSquare?: number
	// Chi-square decrease predicted by one Gauss-Newton step from the result over the free parameters
	// not at a bound, the convergence measure; undefined for 'insufficientData'.
	readonly predictedImprovement?: number
	// Samples with finite time and flux and a finite positive error.
	readonly sampleCount: number
	// Samples skipped for a non-finite time or flux or a non-finite or non-positive error.
	readonly rejectedSampleCount: number
	// Usable samples whose exposure overlaps the fitted (or, for 'insufficientData', initial) transit.
	readonly inTransitCount: number
}

// Absolute tolerance, stellar radii, inside which the separation snaps to a special case of the
// Mandel-Agol solution (z = p, z = 1 − p, z = 0), where the general expressions divide by zero or need
// an elliptic integral of unit modulus. The flux changes by about its slope times this distance.
const SEPARATION_SNAP = 1e-12

// Relative convergence threshold of Bulirsch's cel; its AGM iteration converges quadratically, so the
// result is accurate to about the square of this, below double rounding.
const CEL_TOLERANCE = 1e-9

// Iteration cap of cel: the AGM converges in fewer than 10 iterations for any modulus that the snapping
// leaves, and the cap prevents an endless loop on a non-finite argument.
const CEL_MAX_ITERATIONS = 40

// Default duration of one sub-exposure, days (1 minute).
const DEFAULT_SUBEXPOSURE = 1 / 1440

// Largest number of sub-exposures of one sample.
const MAX_SUPERSAMPLE = 1000

// Default Levenberg-Marquardt iterations per run, and the number of runs from the last point while not
// converged; pinning the impact parameter on 0, or releasing it, adds one run.
const DEFAULT_MAX_ITERATIONS = 200
const MAX_RUNS = 3

// Absolute chi-square improvement at which a Levenberg-Marquardt run stops early.
const LM_TOLERANCE = 1e-9

// Largest Gauss-Newton predicted chi-square decrease of a converged fit: the remaining step is then about
// 0.03σ or less.
const CONVERGED_IMPROVEMENT = 1e-3

// Default minimum number of usable samples overlapping the initial transit.
const DEFAULT_MIN_IN_TRANSIT_POINTS = 3

// Fraction of a parameter range inside which an initial value is moved off a bound: the sine transform
// of the bounds has a zero derivative there, which would freeze the parameter.
const INITIAL_BOUND_MARGIN = 1e-4

// Fraction of a parameter range within which a fitted value counts as at a bound.
const AT_BOUND_TOLERANCE = 1e-6

// Smallest initial |b| of the fit, and of a b released from 0: the light curve is even in b, so b = 0 has a
// zero gradient and the optimizer could never leave it.
const MIN_INITIAL_IMPACT_PARAMETER = 0.1

// Step in b², stellar radii squared, of the check that a minimum pinned on b = 0 stays there.
const IMPACT_KKT_STEP = 1e-6

// Absolute correlation above which two parameters are flagged as degenerate.
const DEGENERACY_CORRELATION = 0.95

// Chi-square survival probability below which the fit is flagged as poor.
const POOR_FIT_PROBABILITY = 1e-3

// Relative central-difference step of the covariance Jacobian; truncation (h²) and rounding (ε / h)
// errors are both near 1e-10 relative.
const JACOBIAN_STEP = 1e-6

// Ridge added to the diagonal of the correlation-scaled Fisher matrix when solving the convergence step
// of a rank-deficient fit, so the predicted improvement stays finite.
const CONVERGENCE_RIDGE = 1e-10

// Indices of the physical state vector [epoch offset, period, p, b, a/R*, u1, u2, baseline].
const EPOCH = 0
const PERIOD = 1
const RADIUS_RATIO = 2
const IMPACT_PARAMETER = 3
const SEMI_MAJOR_AXIS = 4
const U1 = 5
const U2 = 6
const BASELINE = 7

// Physical state entries of each covariance parameter, in declaration order.
const COVARIANCE_PARAMETERS: readonly (readonly [name: TransitCovarianceParameter, index: number])[] = [
	['epoch', EPOCH],
	['period', PERIOD],
	['radiusRatio', RADIUS_RATIO],
	['impactParameter', IMPACT_PARAMETER],
	['scaledSemiMajorAxis', SEMI_MAJOR_AXIS],
	['u1', U1],
	['u2', U2],
	['baseline', BASELINE],
]

// Fit parameters in declaration order.
const FIT_PARAMETERS: readonly TransitFitParameter[] = ['epoch', 'period', 'radiusRatio', 'impactParameter', 'scaledSemiMajorAxis', 'limbDarkening', 'baseline']

// Default free parameters of the fit.
const DEFAULT_FREE: readonly TransitFitParameter[] = ['epoch', 'radiusRatio', 'impactParameter', 'scaledSemiMajorAxis', 'baseline']

// Relative flux of a quadratically limb-darkened star of unit radius partly hidden by an opaque disk of
// radius `radiusRatio` (stellar radii, non-negative) whose center lies `separation` stellar radii
// (non-negative) from the stellar center, normalized to 1 for the unocculted star; 0 when the disk covers
// the whole star. Mandel & Agol (2002) with the case split of Eastman et al. (2013): the separation snaps
// to z = p, z = 1 − p or z = 0 within 1e-12 stellar radii, and the elliptic integrals come from cel. The
// result agrees with exoplanet-core 0.4.0 (Agol, Luger & Foreman-Mackey 2020) within 1e-13 over the (z, p)
// plane, contacts included, except within 1e-8 stellar radii of the center for p near 1, where the
// 1 / sqrt(pz) factor of the published expression amplifies rounding to about 3e-11.
export function quadraticTransitFlux(separation: number, radiusRatio: number, limbDarkening: QuadraticLimbDarkening) {
	const p = radiusRatio
	let z = separation

	if (!(p > 0) || !(z < 1 + p)) return 1
	if (p >= 1 && z <= p - 1) return 0

	if (Math.abs(z - p) < SEPARATION_SNAP) z = p
	else if (Math.abs(z - (1 - p)) < SEPARATION_SNAP) z = 1 - p
	else if (z < SEPARATION_SNAP) z = 0

	const u1 = limbDarkening[0]
	const u2 = limbDarkening[1]
	const pp = p * p
	const zz = z * z

	// Uniform occulted fraction λe, the integral of ρ² over the occulted area divided by π (η), and the
	// occulted fraction of the μ term (λd, including the 2/3 Θ(p − z) step of Mandel & Agol).
	let lambdaE: number
	let eta: number
	let lambdaD: number

	if (z <= 1 - p) {
		lambdaE = pp
		eta = 0.5 * pp * (pp + 2 * zz)
		lambdaD = insideLambdaD(z, p)
	} else {
		// sqrt(4z² − (1 + z² − p²)²) in factored form, twice the area of the triangle of the two centers and
		// one intersection of the limbs.
		const s = Math.sqrt(Math.max(0, (1 - z + p) * (1 + z - p) * (z + p - 1) * (z + p + 1)))
		const oneMinusPP = (1 - p) * (1 + p)
		const kappa1 = Math.atan2(s, oneMinusPP + zz)
		const kappa0 = Math.atan2(s, zz - oneMinusPP)
		lambdaE = (pp * kappa0 + kappa1 - 0.5 * s) / PI
		eta = (kappa1 + pp * (pp + 2 * zz) * kappa0 - 0.25 * (1 + 5 * pp + zz) * s) / TAU
		lambdaD = partialLambdaD(z, p)
	}

	const c2 = u1 + 2 * u2
	return 1 - ((1 - c2) * lambdaE + c2 * lambdaD + u2 * eta) / (1 - u1 / 3 - u2 / 6)
}

// λd + 2/3 Θ(p − z) of Mandel & Agol for a planet wholly inside the stellar disk (p < 1, z <= 1 − p, z
// already snapped): cases 3, 4, 5, 6, 9 and 10.
function insideLambdaD(z: number, p: number) {
	const pp = p * p

	if (z === p) return centerEdgeLambdaD(p)

	// Case 4, internal tangency; the 2/3 Θ(p − 1/2) of the published expression cancels the step.
	if (z === 1 - p) return (4 / (3 * PI)) * Math.asin(Math.sqrt(p)) - (4 / (9 * PI)) * Math.sqrt(p * (1 - p)) * (3 + 2 * p - 8 * pp)

	// Case 10, concentric disks: (2/3)(1 − (1 − p²)^(3/2)), written without cancellation for small p.
	if (z === 0) return (-2 / 3) * Math.expm1(1.5 * Math.log1p(-pp))

	const zz = z * z
	const x1 = (p - z) * (p - z)
	const x3 = (p - z) * (p + z)
	const oneMinusX1 = (1 - p + z) * (1 + p - z)
	const kc = Math.sqrt(((1 - p - z) * (1 + p + z)) / oneMinusX1)
	const n = (4 * p * z) / x1
	const k = cel(kc, 1, 1, 1)
	const e = cel(kc, 1, 1, kc * kc)
	const pi = cel(kc, n + 1, 1, 1)
	const lambda = (2 / (9 * PI * Math.sqrt(oneMinusX1))) * ((1 - 5 * zz + pp + x3 * x3) * k + oneMinusX1 * (zz + 7 * pp - 4) * e - 3 * (x3 / x1) * pi)
	return z < p ? lambda + 2 / 3 : lambda
}

// λd + 2/3 Θ(p − z) of Mandel & Agol for a planet crossing the stellar limb (|1 − p| < z < 1 + p, z
// already snapped): cases 2, 7 and 8.
function partialLambdaD(z: number, p: number) {
	if (z === p) return centerEdgeLambdaD(p)

	const pp = p * p
	const zz = z * z
	const x1 = (p - z) * (p - z)
	const x2 = (p + z) * (p + z)
	const x3 = (p - z) * (p + z)
	const pz = p * z
	const kc = Math.sqrt(((z + p - 1) * (z + p + 1)) / (4 * pz))
	const n = ((1 - z + p) * (1 + z - p)) / x1
	const k = cel(kc, 1, 1, 1)
	const e = cel(kc, 1, 1, kc * kc)
	const pi = cel(kc, n + 1, 1, 1)
	const lambda = (1 / (9 * PI * Math.sqrt(pz))) * (((1 - x2) * (2 * x2 + x1 - 3) - 3 * x3 * (x2 - 2)) * k + 4 * pz * (zz + 7 * pp - 4) * e - 3 * (x3 / x1) * pi)
	return z < p ? lambda + 2 / 3 : lambda
}

// λd of Mandel & Agol when the planet's limb passes through the stellar center (z = p): cases 5
// (p < 1/2), 6 (p = 1/2) and 7 (p > 1/2), with elliptic modulus 2p or 1/(2p).
function centerEdgeLambdaD(p: number) {
	const pp = p * p

	if (p < 0.5) {
		const kc = Math.sqrt((1 - 2 * p) * (1 + 2 * p))
		return 1 / 3 + (2 / (9 * PI)) * (4 * (2 * pp - 1) * cel(kc, 1, 1, kc * kc) + (1 - 4 * pp) * cel(kc, 1, 1, 1))
	} else if (p > 0.5) {
		const kc = Math.sqrt((2 * p - 1) * (2 * p + 1)) / (2 * p)
		return 1 / 3 + ((16 * p) / (9 * PI)) * (2 * pp - 1) * cel(kc, 1, 1, kc * kc) - ((32 * pp * pp - 20 * pp + 3) / (9 * PI * p)) * cel(kc, 1, 1, 1)
	} else {
		return 1 / 3 - 4 / (9 * PI)
	}
}

// Bulirsch's general complete elliptic integral
// cel(kc, p, a, b) = ∫₀^{π/2} (a cos²φ + b sin²φ) / ((cos²φ + p sin²φ) sqrt(cos²φ + kc² sin²φ)) dφ
// for a complementary modulus kc > 0 and p > 0 (Bulirsch 1969, Numer. Math. 13, 305; Numerical Recipes
// §6.11). K = cel(kc, 1, 1, 1), E = cel(kc, 1, 1, kc²) and Π(n) = cel(kc, n + 1, 1, 1) for the
// characteristic convention 1 + n sin²φ.
function cel(kc: number, p: number, a: number, b: number) {
	let qc = Math.abs(kc)
	let e = qc
	let m = 1
	p = Math.sqrt(p)
	b /= p

	for (let i = 0; i < CEL_MAX_ITERATIONS; i++) {
		const f = a
		a += b / p
		let g = e / p
		b += f * g
		b += b
		p += g
		g = m
		m += qc
		if (Math.abs(g - qc) <= g * CEL_TOLERANCE) break
		qc = 2 * Math.sqrt(e)
		e = qc * m
	}

	return (PIOVERTWO * (b + a * m)) / (m * (m + p))
}

// Inclination i in radians, [0, π/2], of a circular orbit with impact parameter b and a / R*:
// cos i = b / (a / R*), 0 for b >= a / R*.
export function transitInclination(parameters: Pick<TransitParameters, 'impactParameter' | 'scaledSemiMajorAxis'>) {
	const b = Math.min(parameters.impactParameter, parameters.scaledSemiMajorAxis)
	return Math.atan2(Math.sqrt((parameters.scaledSemiMajorAxis - b) * (parameters.scaledSemiMajorAxis + b)), b)
}

// Total transit duration T14 from first to fourth contact, days, of a circular orbit (Seager &
// Mallén-Ornelas 2003): (P / π) asin(sqrt(((1 + p)² − b²) / ((a/R*)² − b²))), 0 without a transit
// (b >= 1 + p or p = 0) and P / 2 when the disks overlap during the whole front half of the orbit.
export function transitTotalDuration(parameters: Pick<TransitParameters, 'period' | 'radiusRatio' | 'impactParameter' | 'scaledSemiMajorAxis'>) {
	return contactDuration(parameters.period, parameters.radiusRatio > 0 ? 1 + parameters.radiusRatio : 0, parameters.impactParameter, parameters.scaledSemiMajorAxis)
}

// Full transit duration T23 from second to third contact, days, of a circular orbit:
// (P / π) asin(sqrt(((1 − p)² − b²) / ((a/R*)² − b²))), 0 for a grazing transit (b >= 1 − p), no transit or
// p >= 1.
export function transitFullDuration(parameters: Pick<TransitParameters, 'period' | 'radiusRatio' | 'impactParameter' | 'scaledSemiMajorAxis'>) {
	const p = parameters.radiusRatio
	return p > 0 && p < 1 ? contactDuration(parameters.period, 1 - p, parameters.impactParameter, parameters.scaledSemiMajorAxis) : 0
}

// Semi-major axis a / R* of a circular orbit that gives the total duration T14 (days, in (0, P/2)) for
// the period (days), radius ratio and impact parameter (b < 1 + p):
// sqrt(b² + ((1 + p)² − b²) / sin²(π T14 / P)), the inverse of transitTotalDuration.
export function scaledSemiMajorAxisFromDuration(period: number, totalDuration: number, radiusRatio: number, impactParameter: number) {
	const s = Math.sin((PI * totalDuration) / period)
	const q = 1 + radiusRatio
	return Math.sqrt(impactParameter * impactParameter + ((q - impactParameter) * (q + impactParameter)) / (s * s))
}

// Duration, days, during which the projected separation of a circular orbit is below `radius` stellar
// radii: (P / π) asin(sqrt((radius² − b²) / ((a/R*)² − b²))), with b capped at a/R*.
function contactDuration(period: number, radius: number, impactParameter: number, scaledSemiMajorAxis: number) {
	const b = Math.min(impactParameter, scaledSemiMajorAxis)
	const chord = (radius - b) * (radius + b)
	if (!(chord > 0)) return 0
	const orbit = (scaledSemiMajorAxis - b) * (scaledSemiMajorAxis + b)
	if (!(chord < orbit)) return period / 2
	return (period / PI) * Math.asin(Math.sqrt(chord / orbit))
}

// Projected separation of the planet and star centers, stellar radii, at `time` (days), or undefined while
// the planet is behind the star (no transit possible): (a/R*) sqrt(sin²φ + cos²i cos²φ) with the orbital
// phase φ = 2π (time − epoch) / P from conjunction.
export function transitSeparation(time: number, parameters: TransitParameters) {
	const a = parameters.scaledSemiMajorAxis
	const cosI = Math.min(parameters.impactParameter / a, 1)
	const phase = (TAU * wrapToPeriod(time - parameters.epoch, parameters.period)) / parameters.period
	const c = Math.cos(phase)
	if (!(c > 0)) return undefined
	const s = Math.sin(phase)
	return a * Math.sqrt(s * s + cosI * cosI * c * c)
}

// Model flux, relative to the out-of-transit level, of a sample centered at `time` (days), averaged over
// the exposure when one is given.
export function transitFlux(time: number, parameters: TransitParameters, options?: TransitExposureOptions) {
	const model = prepareModel(parameters, options)
	return exposureFlux(model, time - parameters.epoch)
}

// Model fluxes, relative to the out-of-transit level, of samples centered at `times` (days, any order),
// averaged over the exposure when one is given. Writes into `out` when given (at least times.length long)
// and returns it; otherwise allocates a Float64Array.
export function transitLightCurve(times: Readonly<NumberArray>, parameters: TransitParameters, options?: TransitExposureOptions, out?: NumberArray) {
	const model = prepareModel(parameters, options)
	const n = times.length
	const flux = out ?? new Float64Array(n)
	for (let i = 0; i < n; i++) flux[i] = exposureFlux(model, times[i] - parameters.epoch)
	return flux
}

// Geometry of a transit model with its invariants hoisted out of the per-sample evaluation.
interface PreparedModel {
	// Period, days.
	period: number
	// Radius ratio p.
	radiusRatio: number
	// a / R*.
	scaledSemiMajorAxis: number
	// cos² i, with b capped at a / R*.
	cos2i: number
	// Limb-darkening coefficients.
	limbDarkening: [number, number]
	// Half the total duration plus half the exposure, days: a sample farther from conjunction is unocculted.
	halfWindow: number
	// Exposure time, days.
	exposureTime: number
	// Number of sub-exposures.
	supersample: number
}

// Validates the exposure options and returns [exposureTime, supersample].
function resolveExposure(options?: TransitExposureOptions) {
	const exposureTime = options?.exposureTime ?? 0
	// A negative or non-finite exposure would produce a meaningless average or an unbounded supersample.
	if (!(exposureTime >= 0 && exposureTime < Number.POSITIVE_INFINITY)) throw new RangeError('exposureTime must be finite and non-negative')
	const supersample = options?.supersample ?? Math.max(1, Math.ceil(exposureTime / DEFAULT_SUBEXPOSURE))
	validatePositiveInteger(supersample)
	// Bounds the work per sample.
	if (supersample > MAX_SUPERSAMPLE) throw new RangeError(`supersample must be at most ${MAX_SUPERSAMPLE}`)
	return [exposureTime, supersample] as const
}

// Builds the prepared model of the parameters, validating the exposure options.
function prepareModel(parameters: TransitParameters, options?: TransitExposureOptions): PreparedModel {
	const [exposureTime, supersample] = resolveExposure(options)
	const model: PreparedModel = { period: 0, radiusRatio: 0, scaledSemiMajorAxis: 0, cos2i: 0, limbDarkening: [0, 0], halfWindow: 0, exposureTime, supersample }
	updateModel(model, parameters.period, parameters.radiusRatio, parameters.impactParameter, parameters.scaledSemiMajorAxis, parameters.limbDarkening[0], parameters.limbDarkening[1])
	return model
}

// Recomputes the geometry of a prepared model in place.
function updateModel(model: PreparedModel, period: number, radiusRatio: number, impactParameter: number, scaledSemiMajorAxis: number, u1: number, u2: number) {
	const cosI = Math.min(Math.abs(impactParameter) / scaledSemiMajorAxis, 1)
	model.period = period
	model.radiusRatio = radiusRatio
	model.scaledSemiMajorAxis = scaledSemiMajorAxis
	model.cos2i = cosI * cosI
	model.limbDarkening[0] = u1
	model.limbDarkening[1] = u2
	model.halfWindow = 0.5 * (contactDuration(period, radiusRatio > 0 ? 1 + radiusRatio : 0, Math.abs(impactParameter), scaledSemiMajorAxis) + model.exposureTime)
}

// Exposure-averaged relative flux of a sample centered `dt` days from the epoch.
function exposureFlux(model: PreparedModel, dt: number) {
	dt = wrapToPeriod(dt, model.period)
	if (!(Math.abs(dt) < model.halfWindow)) return 1

	const { supersample, exposureTime } = model
	if (supersample === 1) return instantFlux(model, dt)

	let sum = 0
	for (let j = 0; j < supersample; j++) sum += instantFlux(model, dt + ((j + 0.5) / supersample - 0.5) * exposureTime)
	return sum / supersample
}

// Instantaneous relative flux `dt` days from the epoch.
function instantFlux(model: PreparedModel, dt: number) {
	const phase = (TAU * dt) / model.period
	const c = Math.cos(phase)
	if (!(c > 0)) return 1
	const s = Math.sin(phase)
	const z = model.scaledSemiMajorAxis * Math.sqrt(s * s + model.cos2i * c * c)
	return quadraticTransitFlux(z, model.radiusRatio, model.limbDarkening)
}

// Offset `dt` reduced to [−P/2, P/2] days by whole periods.
function wrapToPeriod(dt: number, period: number) {
	return dt - Math.round(dt / period) * period
}

// Kipping (2013) q1, q2 of quadratic limb-darkening coefficients, clamped to [0, 1] (q1 = 0 for u1 + u2 <= 0).
function kippingFromLimbDarkening(u1: number, u2: number) {
	const sum = u1 + u2
	const q1 = sum > 0 ? Math.min(1, sum * sum) : 0
	const q2 = sum > 0 ? Math.min(1, Math.max(0, u1 / (2 * sum))) : 0.5
	return [q1, q2] as const
}

// Free coefficient of the optimizer: an internal value bounded to [min, max] through
// value = min + (max − min)(1 + sin θ) / 2 (the MINUIT transform), so that every θ stays inside the bounds.
interface FitCoefficient {
	// Fit parameter it belongs to.
	readonly parameter: TransitFitParameter
	// Index in the internal state [epoch offset, period, p, b, a/R*, q1, q2, baseline].
	readonly index: number
	// Bounds of the internal value; the epoch bounds are offsets from the initial epoch, days.
	readonly min: number
	readonly max: number
}

// Chi-square, Jacobian and convergence measure of a physical state.
interface FitDiagnostics {
	// Weighted sum of squared residuals.
	readonly chiSquare: number
	// Jacobian columns ∂model/∂parameter over the usable samples, one per covariance parameter.
	readonly jacobian: readonly Float64Array[]
	// Square roots of the Fisher matrix diagonal, sqrt(Σ w J²), per covariance parameter.
	readonly scale: Float64Array
	// Correlation-scaled Fisher matrix JᵀWJ / (scale_i scale_j), row-major.
	readonly fisher: Float64Array
	// Chi-square decrease predicted by a Gauss-Newton step over the parameters not at a bound.
	readonly predictedImprovement: number
	// Whether the minimum lies on the constraint b >= 0 (b free, at or driven to 0).
	readonly impactAtZero: boolean
}

// Fits the physical transit model to a light curve by weighted least squares. `time` holds the sample
// centers (days of one uniform scale, for example BJD_TDB, any order), `flux` the fluxes in any linear
// unit and `fluxError` their 1σ errors (an array, or one value for every sample); a sample with a
// non-finite time or flux or a non-finite or non-positive error is skipped. The model is
// baseline × relative flux, averaged over the exposure of the options. `initial` starts the
// Levenberg-Marquardt search (for example from a box least squares candidate) and supplies the fixed
// parameters; it must describe a transit (radiusRatio > 0, impactParameter in [0, 1 + radiusRatio),
// scaledSemiMajorAxis > 1), otherwise a RangeError is thrown, as for arrays of different lengths or
// invalid bounds. The search is local: a poor initial epoch or duration can converge to a wrong minimum.
// Inputs are never mutated.
export function fitTransit(time: Readonly<NumberArray>, flux: Readonly<NumberArray>, fluxError: Readonly<NumberArray> | number, initial: TransitFitInitial, options: TransitFitOptions = {}): TransitFitResult {
	const n = time.length
	// Mismatched arrays would pair the wrong samples.
	if (flux.length !== n || (typeof fluxError !== 'number' && fluxError.length !== n)) throw new RangeError('time, flux and fluxError must have the same length')
	// A non-transiting start has a zero Jacobian and would be returned unchanged as a converged fit.
	if (!(initial.radiusRatio > 0) || !(initial.impactParameter >= 0 && initial.impactParameter < 1 + initial.radiusRatio) || !(initial.scaledSemiMajorAxis > 1)) throw new RangeError('initial parameters must describe a transit')

	const [exposureTime, supersample] = resolveExposure(options)
	const maxIterations = validatePositiveInteger(options.maxIterations ?? DEFAULT_MAX_ITERATIONS)
	const minInTransitPoints = validatePositiveInteger(options.minInTransitPoints ?? DEFAULT_MIN_IN_TRANSIT_POINTS)
	const free = new Set(options.free ?? DEFAULT_FREE)

	// Usable samples, with times relative to the initial epoch so that small epoch steps keep their
	// precision against a Julian Date.
	const epoch0 = initial.epoch
	const t = new Float64Array(n)
	const y = new Float64Array(n)
	const w = new Float64Array(n)
	let count = 0

	for (let i = 0; i < n; i++) {
		const sigma = typeof fluxError === 'number' ? fluxError : fluxError[i]
		if (!Number.isFinite(time[i]) || !Number.isFinite(flux[i]) || !(sigma > 0 && sigma < Number.POSITIVE_INFINITY)) continue
		t[count] = time[i] - epoch0
		y[count] = flux[i]
		w[count] = 1 / (sigma * sigma)
		count++
	}

	const ts = t.subarray(0, count)
	const ys = y.subarray(0, count)
	const ws = w.subarray(0, count)

	const initialTotalDuration = transitTotalDuration(initial)
	const initialHalfWindow = 0.5 * (initialTotalDuration + exposureTime)
	let initialInTransitCount = 0
	let outSum = 0
	let outWeight = 0
	let allSum = 0
	let allWeight = 0
	let maxCycles = 0

	for (let i = 0; i < count; i++) {
		allSum += ws[i] * ys[i]
		allWeight += ws[i]
		maxCycles = Math.max(maxCycles, Math.abs(ts[i]) / initial.period)

		if (Math.abs(wrapToPeriod(ts[i], initial.period)) < initialHalfWindow) {
			initialInTransitCount++
		} else {
			outSum += ws[i] * ys[i]
			outWeight += ws[i]
		}
	}

	const baseline0 = initial.baseline ?? (outWeight > 0 ? outSum / outWeight : allWeight > 0 ? allSum / allWeight : 1)

	// Physical state [epoch offset, period, p, b, a/R*, u1, u2, baseline] of the initial model.
	const state0 = new Float64Array([0, initial.period, initial.radiusRatio, initial.impactParameter, initial.scaledSemiMajorAxis, initial.limbDarkening[0], initial.limbDarkening[1], baseline0])
	const names = COVARIANCE_PARAMETERS.filter(([name]) => free.has(name === 'u1' || name === 'u2' ? 'limbDarkening' : name))
	const model: PreparedModel = { period: 0, radiusRatio: 0, scaledSemiMajorAxis: 0, cos2i: 0, limbDarkening: [0, 0], halfWindow: 0, exposureTime, supersample }
	const modelFlux = new Float64Array(count)

	if (count <= names.length || initialInTransitCount < minInTransitPoints || !(baseline0 > 0)) {
		const chiSquare = chiSquareOf(ys, ws, evaluateCurve(state0, ts, model, modelFlux))

		return {
			...resultGeometry(initial, baseline0, state0),
			status: 'insufficientData',
			flags: [],
			parameterNames: names.map(([name]) => name),
			atBound: [],
			chiSquare,
			degreesOfFreedom: Math.max(0, count - names.length),
			reducedChiSquare: count > names.length ? chiSquare / (count - names.length) : undefined,
			sampleCount: count,
			rejectedSampleCount: n - count,
			inTransitCount: initialInTransitCount,
		}
	}

	const coefficients = fitCoefficients(free, initial, baseline0, initialTotalDuration, maxCycles, options.bounds)

	// Internal state [epoch offset, period, p, b, a/R*, q1, q2, baseline] and the optimizer coefficients θ.
	const internal = new Float64Array(state0)
	const [q1, q2] = kippingFromLimbDarkening(initial.limbDarkening[0], initial.limbDarkening[1])
	internal[U1] = q1
	internal[U2] = q2
	const theta = new Array<number>(coefficients.length)

	for (let j = 0; j < coefficients.length; j++) {
		const { index, min, max } = coefficients[j]
		let value = internal[index]
		if (index === IMPACT_PARAMETER && min < 0) value = Math.max(value, MIN_INITIAL_IMPACT_PARAMETER)
		const margin = INITIAL_BOUND_MARGIN * (max - min)
		value = Math.min(max - margin, Math.max(min + margin, value))
		// The branch θ in [π/2, 3π/2] keeps |θ| >= π/2: levenbergMarquardt differentiates with a step proportional to
		// |θ|, which would vanish for a value in the middle of its range on the principal branch.
		theta[j] = PI - Math.asin((2 * (value - min)) / (max - min) - 1)
	}

	// Physical state of θ.
	const toState = (params: Readonly<NumberArray>, out: Float64Array) => {
		out.set(internal)

		for (let j = 0; j < coefficients.length; j++) {
			const { index, min, max } = coefficients[j]
			out[index] = min + 0.5 * (max - min) * (1 + Math.sin(params[j]))
		}

		const sqrtQ1 = Math.sqrt(out[U1])
		const kq2 = out[U2]
		out[U1] = 2 * sqrtQ1 * kq2
		out[U2] = sqrtQ1 * (1 - 2 * kq2)
		return out
	}

	// The per-sample model rebuilds the geometry only when θ changes, once per curve evaluation.
	const state = new Float64Array(8)
	const cached = new Float64Array(coefficients.length).fill(Number.NaN)

	const sampleModel = (x: number, params: NumberArray) => {
		let changed = false

		for (let j = 0; j < coefficients.length; j++) {
			if (cached[j] !== params[j]) {
				cached[j] = params[j]
				changed = true
			}
		}

		if (changed) updateStateModel(model, toState(params, state))
		return state[BASELINE] * exposureFlux(model, x - state[EPOCH])
	}

	const final = new Float64Array(8)
	const atBound = new Set<TransitFitParameter>()
	let fitNames = names
	let impactPinned = false
	let impactReleased = false
	let impactCoefficient: FitCoefficient | undefined
	let diagnostics: FitDiagnostics | undefined
	let runs = MAX_RUNS

	for (let run = 0; run < runs; run++) {
		if (coefficients.length > 0) levenbergMarquardt(ts, ys, sampleModel, theta, { weights: ws, maxIterations, tolerance: LM_TOLERANCE })
		toState(theta, final)

		atBound.clear()
		if (impactPinned) atBound.add('impactParameter')

		for (let j = 0; j < coefficients.length; j++) {
			const { parameter, min, max } = coefficients[j]
			const value = min + 0.5 * (max - min) * (1 + Math.sin(theta[j]))
			const tolerance = AT_BOUND_TOLERANCE * (max - min)
			if (value - min <= tolerance || max - value <= tolerance) atBound.add(parameter)
		}

		const active = fitNames.map(([name]) => !atBound.has(name === 'u1' || name === 'u2' ? 'limbDarkening' : name))
		diagnostics = fitDiagnostics(final, ts, ys, ws, model, fitNames, active, maxCycles, modelFlux)
		// The diagnostics reused the prepared geometry, so the next run must rebuild it.
		cached.fill(Number.NaN)

		// A minimum on b = 0 pins b there for one more run: the light curve has no first-order dependence on b
		// at 0, which stalls the optimizer and leaves b out of the covariance.
		if (diagnostics.impactAtZero && coefficients.some((c) => c.index === IMPACT_PARAMETER && c.min < 0)) {
			const j = coefficients.findIndex((c) => c.index === IMPACT_PARAMETER)
			impactCoefficient = coefficients[j]
			coefficients.splice(j, 1)
			theta.splice(j, 1)
			internal[IMPACT_PARAMETER] = 0
			impactPinned = true
			fitNames = fitNames.filter(([, index]) => index !== IMPACT_PARAMETER)
			runs++
			continue
		}

		// The pin holds only while χ² grows with b² at b = 0 (the Karush-Kuhn-Tucker condition of the bound);
		// otherwise b is released once from MIN_INITIAL_IMPACT_PARAMETER.
		if (impactPinned && !impactReleased && impactCoefficient !== undefined) {
			final[IMPACT_PARAMETER] = Math.sqrt(IMPACT_KKT_STEP)
			const raised = chiSquareOf(ys, ws, evaluateCurve(final, ts, model, modelFlux))
			final[IMPACT_PARAMETER] = 0
			evaluateCurve(final, ts, model, modelFlux)

			if (raised < diagnostics.chiSquare) {
				const { min, max } = impactCoefficient
				const j = coefficients.findIndex((c) => c.index > IMPACT_PARAMETER)
				const at = j < 0 ? coefficients.length : j
				coefficients.splice(at, 0, impactCoefficient)
				theta.splice(at, 0, PI - Math.asin((2 * (Math.min(MIN_INITIAL_IMPACT_PARAMETER, 0.5 * max) - min)) / (max - min) - 1))
				impactPinned = false
				impactReleased = true
				fitNames = names
				runs++
				continue
			}
		}

		if (diagnostics.predictedImprovement <= CONVERGED_IMPROVEMENT) break
	}

	const fitted: TransitParameters = {
		epoch: epoch0 + final[EPOCH],
		period: final[PERIOD],
		radiusRatio: final[RADIUS_RATIO],
		impactParameter: Math.abs(final[IMPACT_PARAMETER]),
		scaledSemiMajorAxis: final[SEMI_MAJOR_AXIS],
		limbDarkening: [final[U1], final[U2]],
	}

	final[IMPACT_PARAMETER] = fitted.impactParameter
	const atBoundParameters = FIT_PARAMETERS.filter((parameter) => atBound.has(parameter))
	return fittedResult(diagnostics!, fitted, final, fitNames, atBoundParameters, ts, ws, maxCycles, model, n, count)
}

// Optimizer coefficients of the free parameters, in internal state order, with their bounds.
function fitCoefficients(free: ReadonlySet<TransitFitParameter>, initial: TransitFitInitial, baseline: number, totalDuration: number, maxCycles: number, bounds: TransitFitOptions['bounds'] = {}) {
	const halfDuration = 0.5 * totalDuration
	const coefficients: FitCoefficient[] = []

	const add = (parameter: TransitBoundedParameter, index: number, defaultMin: number, defaultMax: number, offset: number = 0) => {
		if (!free.has(parameter)) return
		const range = bounds[parameter]
		let min = range === undefined ? defaultMin : range[0] - offset
		const max = range === undefined ? defaultMax : range[1] - offset
		// Reversed or non-finite bounds would map every θ outside the intended range.
		if (!(min < max) || !Number.isFinite(min) || !Number.isFinite(max)) throw new RangeError(`bounds of ${parameter} must be finite with min < max`)
		// An impact parameter range from 0 is searched over [−max, max], where b = 0 is an interior point.
		if (index === IMPACT_PARAMETER && min === 0) min = -max
		coefficients.push({ parameter, index, min, max })
	}

	const periodHalfWidth = halfDuration / Math.max(1, maxCycles)
	add('epoch', EPOCH, -halfDuration, halfDuration, initial.epoch)
	add('period', PERIOD, initial.period - periodHalfWidth, initial.period + periodHalfWidth)
	add('radiusRatio', RADIUS_RATIO, 0, 1)

	const maxRadiusRatio = free.has('radiusRatio') ? (bounds.radiusRatio?.[1] ?? 1) : initial.radiusRatio
	add('impactParameter', IMPACT_PARAMETER, 0, 1 + maxRadiusRatio)
	add('scaledSemiMajorAxis', SEMI_MAJOR_AXIS, 1, 10 * initial.scaledSemiMajorAxis)

	if (free.has('limbDarkening')) {
		coefficients.push({ parameter: 'limbDarkening', index: U1, min: 0, max: 1 })
		coefficients.push({ parameter: 'limbDarkening', index: U2, min: 0, max: 1 })
	}

	add('baseline', BASELINE, 0.5 * baseline, 1.5 * baseline)
	return coefficients
}

// Recomputes a prepared model from a physical state [epoch offset, period, p, b, a/R*, u1, u2, baseline].
function updateStateModel(model: PreparedModel, state: Readonly<Float64Array>) {
	updateModel(model, state[PERIOD], state[RADIUS_RATIO], state[IMPACT_PARAMETER], state[SEMI_MAJOR_AXIS], state[U1], state[U2])
}

// Writes baseline × relative flux of a physical state at the sample times (days from the initial epoch).
function evaluateCurve(state: Readonly<Float64Array>, ts: Readonly<Float64Array>, model: PreparedModel, out: Float64Array) {
	updateStateModel(model, state)
	const baseline = state[BASELINE]
	const epoch = state[EPOCH]
	for (let i = 0; i < ts.length; i++) out[i] = baseline * exposureFlux(model, ts[i] - epoch)
	return out
}

// Weighted sum of squared residuals.
function chiSquareOf(ys: Readonly<Float64Array>, ws: Readonly<Float64Array>, modelFlux: Readonly<Float64Array>) {
	let sum = 0

	for (let i = 0; i < ys.length; i++) {
		const r = ys[i] - modelFlux[i]
		sum += ws[i] * r * r
	}

	return sum
}

// Central-difference step of a physical state entry, scaled by the size of its effect: the total
// duration for the epoch, the total duration over the cycles spanned for the period.
function jacobianStep(state: Readonly<Float64Array>, index: number, maxCycles: number) {
	const totalDuration = contactDuration(state[PERIOD], 1 + state[RADIUS_RATIO], Math.abs(state[IMPACT_PARAMETER]), state[SEMI_MAJOR_AXIS]) || 0.01 * state[PERIOD]

	switch (index) {
		case EPOCH:
			return JACOBIAN_STEP * totalDuration
		case PERIOD:
			return (JACOBIAN_STEP * totalDuration) / Math.max(1, maxCycles)
		case RADIUS_RATIO:
			return JACOBIAN_STEP * Math.max(state[RADIUS_RATIO], 0.01)
		case IMPACT_PARAMETER:
			return JACOBIAN_STEP * (1 + state[RADIUS_RATIO])
		case SEMI_MAJOR_AXIS:
			return JACOBIAN_STEP * state[SEMI_MAJOR_AXIS]
		case BASELINE:
			return JACOBIAN_STEP * Math.abs(state[BASELINE])
		default:
			return JACOBIAN_STEP
	}
}

// Chi-square, central-difference Jacobian over the covariance parameters, correlation-scaled Fisher matrix
// and Gauss-Newton predicted improvement over the `active` parameters of a physical state. Writes the model
// of the state into modelFlux.
function fitDiagnostics(state: Readonly<Float64Array>, ts: Readonly<Float64Array>, ys: Readonly<Float64Array>, ws: Readonly<Float64Array>, model: PreparedModel, names: readonly (readonly [TransitCovarianceParameter, number])[], active: readonly boolean[], maxCycles: number, modelFlux: Float64Array): FitDiagnostics {
	const count = ts.length
	const k = names.length
	const chiSquare = chiSquareOf(ys, ws, evaluateCurve(state, ts, model, modelFlux))
	const probe = new Float64Array(state)
	const lower = new Float64Array(count)
	const jacobian = new Array<Float64Array>(k)
	const scale = new Float64Array(k)
	const gradient = new Float64Array(k)

	for (let j = 0; j < k; j++) {
		const index = names[j][1]
		const h = jacobianStep(state, index, maxCycles)
		const column = new Float64Array(count)
		probe[index] = state[index] + h
		evaluateCurve(probe, ts, model, column)
		probe[index] = state[index] - h
		evaluateCurve(probe, ts, model, lower)
		probe[index] = state[index]

		let norm = 0
		let g = 0

		for (let i = 0; i < count; i++) {
			const d = (column[i] - lower[i]) / (2 * h)
			column[i] = d
			norm += ws[i] * d * d
			g += ws[i] * d * (ys[i] - modelFlux[i])
		}

		jacobian[j] = column
		scale[j] = Math.sqrt(norm)
		gradient[j] = g
	}

	const fisher = new Float64Array(k * k)

	for (let a = 0; a < k; a++) {
		for (let b = a; b < k; b++) {
			const ja = jacobian[a]
			const jb = jacobian[b]
			let sum = 0
			for (let i = 0; i < count; i++) sum += ws[i] * ja[i] * jb[i]
			const value = scale[a] > 0 && scale[b] > 0 ? sum / (scale[a] * scale[b]) : 0
			fisher[a * k + b] = value
			fisher[b * k + a] = value
		}
	}

	// Gauss-Newton step over the active parameters with a non-zero Jacobian. The light curve is even in b,
	// so the problem is regular in b², whose step is 2b δb: when it would make b² negative (or the b column
	// vanishes at b = 0) the minimum lies on the constraint b >= 0, and b leaves the step.
	const selected: number[] = []
	const impact = names.findIndex(([, index]) => index === IMPACT_PARAMETER)
	for (let j = 0; j < k; j++) if (active[j] && scale[j] > 0) selected.push(j)
	let impactAtZero = impact >= 0 && active[impact] && !(scale[impact] > 0) && state[IMPACT_PARAMETER] === 0
	let step = gaussNewtonStep(selected, gradient, scale, fisher, k)
	const impactSlot = selected.indexOf(impact)

	if (impactSlot >= 0) {
		const b = state[IMPACT_PARAMETER]

		if (b * (b + (2 * step[impactSlot]) / scale[impact]) <= 0) {
			impactAtZero = true
			selected.splice(impactSlot, 1)
			step = gaussNewtonStep(selected, gradient, scale, fisher, k)
		}
	}

	let predictedImprovement = 0
	for (let a = 0; a < selected.length; a++) predictedImprovement += (gradient[selected[a]] / scale[selected[a]]) * step[a]

	return { chiSquare, jacobian, scale, fisher, predictedImprovement: Math.max(0, predictedImprovement), impactAtZero }
}

// Gauss-Newton step H δ = g over the `selected` covariance parameters, in correlation scale (δ_j × scale_j)
// with a tiny ridge so that a rank-deficient system stays finite.
function gaussNewtonStep(selected: readonly number[], gradient: Readonly<Float64Array>, scale: Readonly<Float64Array>, fisher: Readonly<Float64Array>, k: number) {
	const s = selected.length
	if (s === 0) return new Float64Array(0)
	const system = new Matrix(s, s)
	const rhs = new Float64Array(s)

	for (let a = 0; a < s; a++) {
		rhs[a] = gradient[selected[a]] / scale[selected[a]]
		for (let b = 0; b < s; b++) system.data[a * s + b] = fisher[selected[a] * k + selected[b]] + (a === b ? CONVERGENCE_RIDGE : 0)
	}

	return new LuDecomposition(system, true).solve(rhs)
}

// Inclination, total and full durations of a physical state.
function stateGeometry(state: Readonly<Float64Array>) {
	const geometry = { period: state[PERIOD], radiusRatio: state[RADIUS_RATIO], impactParameter: Math.abs(state[IMPACT_PARAMETER]), scaledSemiMajorAxis: state[SEMI_MAJOR_AXIS] }
	return [transitInclination(geometry), transitTotalDuration(geometry), transitFullDuration(geometry)] as const
}

// Geometry fields of a result for the parameters, baseline and physical state.
function resultGeometry(parameters: TransitParameters, baseline: number, state: Readonly<Float64Array>) {
	const [inclination, totalDuration, fullDuration] = stateGeometry(state)
	const fitted: TransitParameters = { ...parameters, limbDarkening: [parameters.limbDarkening[0], parameters.limbDarkening[1]] }
	return { parameters: fitted, baseline, inclination, totalDuration, fullDuration }
}

// Result of a fit that ran: covariance and its derived uncertainties, flags and sample counts.
function fittedResult(
	diagnostics: FitDiagnostics,
	parameters: TransitParameters,
	state: Readonly<Float64Array>,
	names: readonly (readonly [TransitCovarianceParameter, number])[],
	atBound: readonly TransitFitParameter[],
	ts: Readonly<Float64Array>,
	ws: Readonly<Float64Array>,
	maxCycles: number,
	model: PreparedModel,
	sampleTotal: number,
	count: number,
): TransitFitResult {
	const k = names.length
	const { chiSquare, jacobian, scale, fisher, predictedImprovement } = diagnostics
	const geometry = resultGeometry(parameters, state[BASELINE], state)
	const degreesOfFreedom = count - k

	// Conditioning of the column-scaled Jacobian, independent of the parameter units.
	const design = new Array<Float64Array>(count)

	for (let i = 0; i < count; i++) {
		const row = new Float64Array(k)
		for (let j = 0; j < k; j++) row[j] = scale[j] > 0 ? jacobian[j][i] / scale[j] : 0
		design[i] = row
	}

	let covariance: Float64Array | undefined

	if (k > 0 && !estimateLeastSquaresConditioning(design, ws).rankDeficient) {
		const inverse = new LuDecomposition(new Matrix(k, k, fisher), true).invert()
		covariance = new Float64Array(k * k)

		for (let a = 0; a < k; a++) {
			for (let b = 0; b < k; b++) covariance[a * k + b] = inverse.data[a * k + b] / (scale[a] * scale[b])
		}

		let positive = true
		for (let a = 0; a < k; a++) if (!(covariance[a * k + a] > 0 && covariance[a * k + a] < Number.POSITIVE_INFINITY)) positive = false
		if (!positive) covariance = undefined
	} else if (k === 0) {
		covariance = new Float64Array(0)
	}

	let uncertainties: { [K in TransitCovarianceParameter]?: number } | undefined
	let inclinationError: number | undefined
	let totalDurationError: number | undefined
	let fullDurationError: number | undefined
	let strongDegeneracy = false

	if (covariance !== undefined) {
		uncertainties = {}
		for (let a = 0; a < k; a++) uncertainties[names[a][0]] = Math.sqrt(covariance[a * k + a])

		for (let a = 0; a < k; a++) {
			for (let b = a + 1; b < k; b++) {
				if (Math.abs(covariance[a * k + b]) > DEGENERACY_CORRELATION * Math.sqrt(covariance[a * k + a] * covariance[b * k + b])) strongDegeneracy = true
			}
		}

		// First-order propagation of the covariance into the derived geometry.
		const gradients = [new Float64Array(k), new Float64Array(k), new Float64Array(k)]
		const probe = new Float64Array(state)

		for (let j = 0; j < k; j++) {
			const index = names[j][1]
			const h = jacobianStep(state, index, maxCycles)
			probe[index] = state[index] + h
			const upper = stateGeometry(probe)
			probe[index] = state[index] - h
			const lower = stateGeometry(probe)
			probe[index] = state[index]
			for (let d = 0; d < 3; d++) gradients[d][j] = (upper[d] - lower[d]) / (2 * h)
		}

		const c = covariance
		const [inclinationSigma, totalSigma, fullSigma] = gradients.map((g) => {
			let variance = 0
			for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) variance += g[a] * c[a * k + b] * g[b]
			return Math.sqrt(Math.max(0, variance))
		})

		inclinationError = inclinationSigma
		totalDurationError = geometry.totalDuration > 0 ? totalSigma : undefined
		fullDurationError = geometry.fullDuration > 0 ? fullSigma : undefined
	}

	// Coverage of the fitted transit: in-transit samples and the ingress and egress.
	const halfTotal = 0.5 * geometry.totalDuration
	const halfFull = 0.5 * geometry.fullDuration
	const halfExposure = 0.5 * model.exposureTime
	const noTransit = !(geometry.totalDuration > 0)
	let inTransitCount = 0
	let ingress = false
	let egress = false

	if (!noTransit) {
		for (let i = 0; i < count; i++) {
			const dt = wrapToPeriod(ts[i] - state[EPOCH], state[PERIOD])
			if (Math.abs(dt) < halfTotal + halfExposure) inTransitCount++
			if (dt + halfExposure > -halfTotal && dt - halfExposure < -halfFull) ingress = true
			if (dt - halfExposure < halfTotal && dt + halfExposure > halfFull) egress = true
		}
	}

	const flags: TransitFitFlag[] = []
	if (atBound.length > 0) flags.push('parameterAtBound')
	if (covariance === undefined) flags.push('singularCovariance')
	if (strongDegeneracy) flags.push('strongDegeneracy')
	if (!noTransit && parameters.impactParameter > 1 - parameters.radiusRatio) flags.push('grazing')
	if (noTransit) flags.push('noTransit')
	if (!noTransit && !ingress) flags.push('missingIngress')
	if (!noTransit && !egress) flags.push('missingEgress')
	if (degreesOfFreedom > 0 && 1 - chiSquareCdf(chiSquare, degreesOfFreedom) < POOR_FIT_PROBABILITY) flags.push('poorFit')

	return {
		...geometry,
		status: predictedImprovement <= CONVERGED_IMPROVEMENT ? 'ok' : 'notConverged',
		flags,
		parameterNames: names.map(([name]) => name),
		covariance,
		uncertainties,
		inclinationError,
		totalDurationError,
		fullDurationError,
		atBound,
		chiSquare,
		degreesOfFreedom,
		reducedChiSquare: degreesOfFreedom > 0 ? chiSquare / degreesOfFreedom : undefined,
		predictedImprovement,
		sampleCount: count,
		rejectedSampleCount: sampleTotal - count,
		inTransitCount,
	}
}
