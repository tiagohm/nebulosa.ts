import { DEG2RAD } from '../../../core/constants'
import { type MutVec3, type Vec3, vecAngleUnit, vecCross, vecCrossLength, vecLength, vecTripleProduct } from '../../../math/linear-algebra/vec3'
import type { Angle } from '../../../math/units/angle'
import type { CartesianCoordinate } from '../../coordinates/coordinate'

// Classical Gibbs method of orbit determination: recovers the middle velocity from three coplanar
// position vectors of a body under two-body motion, with extensive degeneracy/quality diagnostics
// (coplanarity, angular separations, near-colinearity, vanishing auxiliary vectors). Unit-agnostic
// as long as positions and `mu` share consistent units; the geometry must already be reduced to
// central-body position vectors, not raw RA/Dec observations.

// Smallest acceptable position-vector magnitude before a norm is treated as invalid.
const DEFAULT_MIN_POSITION_NORM = 1e-15
// Default upper bound on the normalized coplanarity error (dimensionless) before flagging.
const DEFAULT_COPLANARITY_TOLERANCE = 1e-5
// Default minimum angular separation between positions (radians); below this geometry is ill-conditioned.
const DEFAULT_MIN_ANGULAR_SEPARATION = DEG2RAD
// Default maximum angular separation between adjacent positions (radians).
const DEFAULT_MAX_ANGULAR_SEPARATION = 60 * DEG2RAD
// Default relative tolerance for declaring auxiliary vectors (D, N) or cross products degenerate.
const DEFAULT_DEGENERACY_TOLERANCE = 1e-12

// Overall quality verdict for a Gibbs solution.
export type GibbsReliability = 'good' | 'warning' | 'bad'
// Individual condition flags raised during a Gibbs solution.
export type GibbsWarning = 'INVALID_POSITION_NORM' | 'INVALID_GRAVITATIONAL_PARAMETER' | 'ANGULAR_SEPARATION_TOO_SMALL' | 'ANGULAR_SEPARATION_TOO_LARGE' | 'POOR_COPLANARITY' | 'NEAR_COLINEAR_POSITIONS' | 'NEAR_ZERO_D_VECTOR' | 'NEAR_ZERO_N_VECTOR' | 'INVALID_GIBBS_SCALE' | 'NON_FINITE_VELOCITY'

// Quality metrics computed alongside a Gibbs velocity estimate.
export interface GibbsDiagnostics {
	// Normalized coplanarity error of the three positions (dimensionless).
	readonly coplanarityError: number
	// Angular separation between positions 1 and 2 (radians).
	readonly angle12: Angle
	// Angular separation between positions 2 and 3 (radians).
	readonly angle23: Angle
	// Angular separation between positions 1 and 3 (radians).
	readonly angle13: Angle
	// Magnitude of position vector 1.
	readonly normR1: number
	// Magnitude of position vector 2.
	readonly normR2: number
	// Magnitude of position vector 3.
	readonly normR3: number
	// Magnitude of the auxiliary N vector.
	readonly normN: number
	// Magnitude of the auxiliary D vector.
	readonly normD: number
	// Magnitude of the auxiliary S vector.
	readonly normS: number
	// Overall reliability verdict.
	readonly reliability: GibbsReliability
	// All condition flags raised.
	readonly warnings: readonly GibbsWarning[]
}

// Output of a Gibbs solution: the middle state vector plus diagnostics.
export interface GibbsResult {
	// Middle position vector (copy of the input r2).
	readonly r: CartesianCoordinate
	// Estimated middle velocity; NaN components if the solution was rejected.
	readonly v: CartesianCoordinate
	// Quality metrics and warnings.
	readonly diagnostics: GibbsDiagnostics
}

// Optional thresholds and behavior for gibbs(); omitted fields use the module defaults.
export interface GibbsOptions {
	// Upper bound on normalized coplanarity error before flagging.
	readonly coplanarityTolerance?: number
	// Minimum acceptable angular separation between positions (radians).
	readonly minAngularSeparation?: Angle
	// Maximum acceptable angular separation between positions (radians).
	readonly maxAngularSeparation?: Angle
	// Relative tolerance for degeneracy of auxiliary vectors.
	readonly degeneracyTolerance?: number
	// Smallest acceptable position-vector magnitude.
	readonly minPositionNorm?: number
	// When true, return a 'bad' solution instead of throwing.
	readonly allowUnreliable?: boolean
}

// GibbsOptions with all fields resolved to concrete values.
interface ResolvedGibbsOptions {
	readonly coplanarityTolerance: number
	readonly minAngularSeparation: Angle
	readonly maxAngularSeparation: Angle
	readonly degeneracyTolerance: number
	readonly minPositionNorm: number
	readonly allowUnreliable: boolean
}

// Estimates the middle velocity from three coplanar Cartesian positions with
// the classical Gibbs method. The method is unit-agnostic, but all positions
// and `mu` must use consistent units: position-unit vectors with
// position-unit^3/time-unit^2 `mu` produce position-unit/time-unit velocity.
// It assumes two-body Keplerian motion and requires already reconstructed
// central-body position vectors, not direct RA/Dec observations.
export function gibbs(r1: Vec3, r2: Vec3, r3: Vec3, mu: number, options?: GibbsOptions): GibbsResult {
	const config = resolveOptions(options)
	const R1 = vectorNorm(r1)
	const R2 = vectorNorm(r2)
	const R3 = vectorNorm(r3)
	const C12 = crossVector(r1, r2)
	const C23 = crossVector(r2, r3)
	const C31 = crossVector(r3, r1)
	const crossNorm12 = crossNorm(r1, r2)
	const crossNorm23 = crossNorm(r2, r3)
	const crossNorm31 = crossNorm(r3, r1)
	const N = auxiliaryN(C12, C23, C31, R1, R2, R3)
	const D = add3(C12, C23, C31)
	const S = auxiliaryS(r1, r2, r3, R1, R2, R3)
	const normN = vectorNorm(N)
	const normD = vectorNorm(D)
	const normS = vectorNorm(S)
	const angle12 = angleBetween(r1, r2, R1, R2)
	const angle23 = angleBetween(r2, r3, R2, R3)
	const angle13 = angleBetween(r1, r3, R1, R3)
	const coplanarityError = normalizedCoplanarity(r1, r2, r3, R1, crossNorm23)
	const warnings: GibbsWarning[] = []

	if (!isValidPositionNorm(R1, config) || !isValidPositionNorm(R2, config) || !isValidPositionNorm(R3, config)) {
		addWarning(warnings, 'INVALID_POSITION_NORM')
	}

	if (!(Number.isFinite(mu) && mu > 0)) {
		addWarning(warnings, 'INVALID_GRAVITATIONAL_PARAMETER')
	}

	if (isTooSmallAngle(angle12, config) || isTooSmallAngle(angle23, config) || isTooSmallAngle(angle13, config)) {
		addWarning(warnings, 'ANGULAR_SEPARATION_TOO_SMALL')
	}

	if (angle12 > config.maxAngularSeparation || angle23 > config.maxAngularSeparation || angle13 > 2 * config.maxAngularSeparation) {
		addWarning(warnings, 'ANGULAR_SEPARATION_TOO_LARGE')
	}

	if (coplanarityError > config.coplanarityTolerance) {
		addWarning(warnings, 'POOR_COPLANARITY')
	}

	if (isNearColinear(crossNorm12, R1, R2, config) || isNearColinear(crossNorm23, R2, R3, config) || isNearColinear(crossNorm31, R3, R1, config)) {
		addWarning(warnings, 'NEAR_COLINEAR_POSITIONS')
	}

	if (isNearZeroD(normD, crossNorm12, crossNorm23, crossNorm31, config)) {
		addWarning(warnings, 'NEAR_ZERO_D_VECTOR')
	}

	if (isNearZeroN(normN, R1, R2, R3, crossNorm12, crossNorm23, crossNorm31, config)) {
		addWarning(warnings, 'NEAR_ZERO_N_VECTOR')
	}

	const gibbsScale = normN * normD

	if (!(Number.isFinite(gibbsScale) && gibbsScale > 0)) {
		addWarning(warnings, 'INVALID_GIBBS_SCALE')
	}

	const v = canEstimateVelocity(warnings) ? estimateVelocity(D, r2, S, R2, mu, normN, normD) : invalidVector()

	if (!isFiniteVector(v)) {
		addWarning(warnings, 'NON_FINITE_VELOCITY')
	}

	const diagnostics = buildDiagnostics(coplanarityError, angle12, angle23, angle13, R1, R2, R3, normN, normD, normS, warnings)

	if (diagnostics.reliability === 'bad' && !config.allowUnreliable) {
		throw new RangeError(formatInvalidError(diagnostics))
	}

	return {
		r: [r2[0], r2[1], r2[2]],
		v,
		diagnostics,
	}
}

function resolveOptions(options?: GibbsOptions): ResolvedGibbsOptions {
	const minAngularSeparation = nonNegativeOption(options?.minAngularSeparation, DEFAULT_MIN_ANGULAR_SEPARATION)
	const maxAngularSeparation = positiveOption(options?.maxAngularSeparation, DEFAULT_MAX_ANGULAR_SEPARATION)

	return {
		coplanarityTolerance: nonNegativeOption(options?.coplanarityTolerance, DEFAULT_COPLANARITY_TOLERANCE),
		minAngularSeparation,
		maxAngularSeparation: maxAngularSeparation > minAngularSeparation ? maxAngularSeparation : DEFAULT_MAX_ANGULAR_SEPARATION,
		degeneracyTolerance: nonNegativeOption(options?.degeneracyTolerance, DEFAULT_DEGENERACY_TOLERANCE),
		minPositionNorm: positiveOption(options?.minPositionNorm, DEFAULT_MIN_POSITION_NORM),
		allowUnreliable: options?.allowUnreliable ?? false,
	}
}

function positiveOption(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeOption(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback
}

function vectorNorm(v: Vec3) {
	return isFiniteVector(v) ? vecLength(v) : Number.NaN
}

function crossVector(a: Vec3, b: Vec3): MutVec3 {
	return isFiniteVector(a) && isFiniteVector(b) ? vecCross(a, b) : invalidVector()
}

function crossNorm(a: Vec3, b: Vec3) {
	return isFiniteVector(a) && isFiniteVector(b) ? vecCrossLength(a, b) : Number.NaN
}

function isFiniteVector(v: Vec3) {
	return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
}

function invalidVector(): MutVec3 {
	return [Number.NaN, Number.NaN, Number.NaN]
}

function isValidPositionNorm(norm: number, config: ResolvedGibbsOptions) {
	return Number.isFinite(norm) && norm > config.minPositionNorm
}

function angleBetween(a: Vec3, b: Vec3, amag: number, bmag: number): Angle {
	const denominator = amag * bmag
	if (!(Number.isFinite(denominator) && denominator > 0)) return Number.NaN
	return vecAngleUnit(a, b)
}

function normalizedCoplanarity(r1: Vec3, r2: Vec3, r3: Vec3, r1mag: number, crossNorm23: number) {
	const denominator = r1mag * crossNorm23
	if (!(Number.isFinite(denominator) && denominator > 0)) return Number.NaN
	return Math.abs(vecTripleProduct(r1, r2, r3)) / denominator
}

// Gibbs auxiliary vector N = R1*(r2xr3) + R2*(r3xr1) + R3*(r1xr2).
function auxiliaryN(C12: Vec3, C23: Vec3, C31: Vec3, R1: number, R2: number, R3: number): MutVec3 {
	return [R1 * C23[0] + R2 * C31[0] + R3 * C12[0], R1 * C23[1] + R2 * C31[1] + R3 * C12[1], R1 * C23[2] + R2 * C31[2] + R3 * C12[2]]
}

// Gibbs auxiliary vector S = (R2-R3)*r1 + (R3-R1)*r2 + (R1-R2)*r3.
function auxiliaryS(r1: Vec3, r2: Vec3, r3: Vec3, R1: number, R2: number, R3: number): MutVec3 {
	return [(R2 - R3) * r1[0] + (R3 - R1) * r2[0] + (R1 - R2) * r3[0], (R2 - R3) * r1[1] + (R3 - R1) * r2[1] + (R1 - R2) * r3[1], (R2 - R3) * r1[2] + (R3 - R1) * r2[2] + (R1 - R2) * r3[2]]
}

function add3(a: Vec3, b: Vec3, c: Vec3): MutVec3 {
	return [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]
}

function isTooSmallAngle(value: Angle, config: ResolvedGibbsOptions) {
	return Number.isFinite(value) && value < config.minAngularSeparation
}

function isNearColinear(crossNorm: number, aNorm: number, bNorm: number, config: ResolvedGibbsOptions) {
	const denominator = aNorm * bNorm
	if (!(Number.isFinite(crossNorm) && Number.isFinite(denominator) && denominator > 0)) return false
	return crossNorm / denominator <= config.degeneracyTolerance
}

function isNearZeroD(normD: number, crossNorm12: number, crossNorm23: number, crossNorm31: number, config: ResolvedGibbsOptions) {
	const scale = crossNorm12 + crossNorm23 + crossNorm31
	if (!(Number.isFinite(normD) && Number.isFinite(scale) && scale > 0)) return false
	return normD / scale <= config.degeneracyTolerance
}

function isNearZeroN(normN: number, R1: number, R2: number, R3: number, crossNorm12: number, crossNorm23: number, crossNorm31: number, config: ResolvedGibbsOptions) {
	const scale = R1 * crossNorm23 + R2 * crossNorm31 + R3 * crossNorm12
	if (!(Number.isFinite(normN) && Number.isFinite(scale) && scale > 0)) return false
	return normN / scale <= config.degeneracyTolerance
}

function canEstimateVelocity(warnings: readonly GibbsWarning[]) {
	return !warnings.some((warning) => warning === 'INVALID_POSITION_NORM' || warning === 'INVALID_GRAVITATIONAL_PARAMETER' || warning === 'NEAR_COLINEAR_POSITIONS' || warning === 'NEAR_ZERO_D_VECTOR' || warning === 'NEAR_ZERO_N_VECTOR' || warning === 'INVALID_GIBBS_SCALE')
}

// Forms the Gibbs middle velocity v2 = sqrt(mu/(|N||D|)) * ((DxR2)/R2 + S).
function estimateVelocity(D: Vec3, r2: Vec3, S: Vec3, R2: number, mu: number, normN: number, normD: number): MutVec3 {
	const B = vecCross(D, r2)
	const L = Math.sqrt(mu / (normN * normD))
	const invR2 = 1 / R2

	return [L * (B[0] * invR2 + S[0]), L * (B[1] * invR2 + S[1]), L * (B[2] * invR2 + S[2])]
}

function buildDiagnostics(coplanarityError: number, angle12: Angle, angle23: Angle, angle13: Angle, normR1: number, normR2: number, normR3: number, normN: number, normD: number, normS: number, warnings: readonly GibbsWarning[]): GibbsDiagnostics {
	const reliability = hasBadWarning(warnings) ? 'bad' : warnings.length > 0 ? 'warning' : 'good'

	return {
		coplanarityError,
		angle12,
		angle23,
		angle13,
		normR1,
		normR2,
		normR3,
		normN,
		normD,
		normS,
		reliability,
		warnings,
	}
}

function hasBadWarning(warnings: readonly GibbsWarning[]) {
	return warnings.some(
		(warning) =>
			warning === 'INVALID_POSITION_NORM' || warning === 'INVALID_GRAVITATIONAL_PARAMETER' || warning === 'POOR_COPLANARITY' || warning === 'NEAR_COLINEAR_POSITIONS' || warning === 'NEAR_ZERO_D_VECTOR' || warning === 'NEAR_ZERO_N_VECTOR' || warning === 'INVALID_GIBBS_SCALE' || warning === 'NON_FINITE_VELOCITY',
	)
}

function addWarning(warnings: GibbsWarning[], warning: GibbsWarning) {
	if (!warnings.includes(warning)) warnings.push(warning)
}

function formatInvalidError(diagnostics: GibbsDiagnostics) {
	return `gibbs input is invalid: ${diagnostics.warnings.join(', ')} (coplanarityError=${formatMetric(diagnostics.coplanarityError)}, angle12=${formatMetric(diagnostics.angle12)}, angle23=${formatMetric(diagnostics.angle23)}, angle13=${formatMetric(diagnostics.angle13)}, normR1=${formatMetric(diagnostics.normR1)}, normR2=${formatMetric(diagnostics.normR2)}, normR3=${formatMetric(diagnostics.normR3)}, normN=${formatMetric(diagnostics.normN)}, normD=${formatMetric(diagnostics.normD)})`
}

function formatMetric(value: number) {
	return Number.isFinite(value) ? value.toExponential(6) : String(value)
}
