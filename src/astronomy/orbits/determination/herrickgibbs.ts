import { DEG2RAD } from '../../../core/constants'
import { type MutVec3, type Vec3, vecAngleUnit, vecCrossLength, vecLength, vecTripleProduct } from '../../../math/linear-algebra/vec3'
import type { Angle } from '../../../math/units/angle'
import type { CartesianCoordinate } from '../../coordinates/coordinate'
import { type Time, type Timescale, timeSubtract } from '../../time/time'

// Herrick-Gibbs method of orbit determination: recovers the middle velocity from three position
// vectors closely spaced in time, using a Taylor-series formulation suited to short arcs (unlike the
// purely geometric Gibbs method). Time differences are in days, so `mu` must be in
// position-unit^3/day^2 and the output velocity in position-unit/day. Conservative default thresholds
// flag degenerate spacing, separation, or coplanarity; inspect diagnostics before trusting the state.

// Smallest time interval (days) before the geometry is treated as numerically singular.
const DEFAULT_MIN_TIME_INTERVAL = 1e-9
// Largest time interval (days) within the usual short-arc Herrick-Gibbs regime.
const DEFAULT_MAX_TIME_INTERVAL = 5
// Smallest acceptable position-vector magnitude.
const DEFAULT_MIN_POSITION_NORM = 1e-15
// Smallest angular separation between positions (radians) before flagging.
const DEFAULT_MIN_ANGULAR_SEPARATION = 1e-8
// Largest angular separation between positions (radians) within the short-arc regime.
const DEFAULT_MAX_ANGULAR_SEPARATION = 5 * DEG2RAD
// Upper bound on the normalized coplanarity error (dimensionless).
const DEFAULT_COPLANARITY_TOLERANCE = 1e-3
// Smallest acceptable cross-product/|r||r| ratio before positions are deemed near-colinear.
const DEFAULT_MIN_CROSS_NORM_RATIO = 1e-10

// Condition flags raised during a Herrick-Gibbs solution.
export type HerrickGibbsWarning = 'NON_INCREASING_TIME' | 'TIME_INTERVAL_TOO_LARGE' | 'TIME_INTERVAL_TOO_SMALL' | 'ANGULAR_SEPARATION_TOO_SMALL' | 'ANGULAR_SEPARATION_TOO_LARGE' | 'POOR_COPLANARITY' | 'NEAR_COLINEAR_POSITIONS' | 'INVALID_POSITION_NORM' | 'INVALID_GRAVITATIONAL_PARAMETER' | 'LOW_RELIABILITY_GEOMETRY'

// Quality metrics computed alongside a Herrick-Gibbs velocity estimate.
export interface HerrickGibbsDiagnostics {
	// Time from epoch 1 to epoch 2, days.
	readonly dt21: number
	// Time from epoch 1 to epoch 3, days.
	readonly dt31: number
	// Time from epoch 2 to epoch 3, days.
	readonly dt32: number
	// Angular separation between positions 1 and 2 (radians).
	readonly angle12: Angle
	// Angular separation between positions 2 and 3 (radians).
	readonly angle23: Angle
	// Angular separation between positions 1 and 3 (radians).
	readonly angle13: Angle
	// Normalized coplanarity error (dimensionless).
	readonly coplanarityError: number
	// Magnitude of r1 x r2.
	readonly crossNorm12: number
	// Magnitude of r2 x r3.
	readonly crossNorm23: number
	// Magnitude of r1 x r3.
	readonly crossNorm13: number
	// All condition flags raised.
	readonly warnings: readonly HerrickGibbsWarning[]
	// True when no warnings were raised.
	readonly reliable: boolean
}

// Output of a Herrick-Gibbs solution: the middle state vector plus diagnostics.
export interface HerrickGibbsResult {
	// Middle position vector (copy of the input r2).
	readonly r: CartesianCoordinate
	// Estimated middle velocity; NaN components if the geometry was rejected.
	readonly v: CartesianCoordinate
	// Quality metrics and warnings.
	readonly diagnostics: HerrickGibbsDiagnostics
}

// Optional thresholds and behavior for herrickGibbs(); omitted fields use the module defaults.
export interface HerrickGibbsOptions {
	// Timescale used when differencing the epochs; defaults to t2's scale.
	readonly timescale?: Timescale
	// Smallest acceptable time interval (days).
	readonly minTimeInterval?: number
	// Largest acceptable time interval (days).
	readonly maxTimeInterval?: number
	// Smallest acceptable position-vector magnitude.
	readonly minPositionNorm?: number
	// Smallest acceptable angular separation between positions (radians).
	readonly minAngularSeparation?: Angle
	// Largest acceptable angular separation between positions (radians).
	readonly maxAngularSeparation?: Angle
	// Upper bound on the normalized coplanarity error.
	readonly coplanarityTolerance?: number
	// Smallest acceptable cross-product/|r||r| ratio.
	readonly minCrossNormRatio?: number
	// When true, throw instead of returning an unreliable result.
	readonly throwOnInvalid?: boolean
}

// HerrickGibbsOptions with all fields resolved to concrete values.
interface ResolvedHerrickGibbsOptions {
	readonly timescale?: Timescale
	readonly minTimeInterval: number
	readonly maxTimeInterval: number
	readonly minPositionNorm: number
	readonly minAngularSeparation: Angle
	readonly maxAngularSeparation: Angle
	readonly coplanarityTolerance: number
	readonly minCrossNormRatio: number
	readonly throwOnInvalid: boolean
}

// Estimates the middle velocity from three close-in-time Cartesian positions.
// Time differences are measured in days with `timeSubtract`, so `mu` must be in
// position-unit^3/day^2 and the output velocity is in position-unit/day. The
// default thresholds are intentionally conservative short-arc checks: sub-0.1 ms
// spacing is treated as numerically singular, spans above 5 days and separations
// above 5 degrees are flagged as outside the usual Herrick-Gibbs regime, and
// small dimensionless geometry tolerances catch near-radial or non-coplanar arcs.
// Diagnostics should be inspected before using the state as a nonlinear fit seed.
export function herrickGibbs(r1: Vec3, r2: Vec3, r3: Vec3, t1: Time, t2: Time, t3: Time, mu: number, options?: HerrickGibbsOptions): HerrickGibbsResult {
	const config = resolveOptions(options)
	const dt21 = timeSubtract(t2, t1, config.timescale ?? t2.scale)
	const dt32 = timeSubtract(t3, t2, config.timescale ?? t2.scale)
	const dt31 = timeSubtract(t3, t1, config.timescale ?? t2.scale)
	const r1mag = vectorNorm(r1)
	const r2mag = vectorNorm(r2)
	const r3mag = vectorNorm(r3)
	const angle12 = angleBetween(r1, r2, r1mag, r2mag)
	const angle23 = angleBetween(r2, r3, r2mag, r3mag)
	const angle13 = angleBetween(r1, r3, r1mag, r3mag)
	const crossNorm12 = crossNorm(r1, r2)
	const crossNorm23 = crossNorm(r2, r3)
	const crossNorm13 = crossNorm(r1, r3)
	const coplanarityError = normalizedCoplanarity(r1, r2, r3, crossNorm12, r3mag)
	const warnings: HerrickGibbsWarning[] = []

	if (!(dt21 > 0 && dt32 > 0 && dt31 > 0)) {
		addWarning(warnings, 'NON_INCREASING_TIME')
	}

	if (isTooSmallTime(dt21, config) || isTooSmallTime(dt32, config) || isTooSmallTime(dt31, config)) {
		addWarning(warnings, 'TIME_INTERVAL_TOO_SMALL')
	}

	if (dt21 > config.maxTimeInterval || dt32 > config.maxTimeInterval || dt31 > config.maxTimeInterval) {
		addWarning(warnings, 'TIME_INTERVAL_TOO_LARGE')
	}

	if (!isValidPositionNorm(r1mag, config) || !isValidPositionNorm(r2mag, config) || !isValidPositionNorm(r3mag, config)) {
		addWarning(warnings, 'INVALID_POSITION_NORM')
	}

	if (!(Number.isFinite(mu) && mu > 0)) {
		addWarning(warnings, 'INVALID_GRAVITATIONAL_PARAMETER')
	}

	if (isTooSmallAngle(angle12, config) || isTooSmallAngle(angle23, config) || isTooSmallAngle(angle13, config)) {
		addWarning(warnings, 'ANGULAR_SEPARATION_TOO_SMALL')
	}

	if (angle12 > config.maxAngularSeparation || angle23 > config.maxAngularSeparation || angle13 > config.maxAngularSeparation) {
		addWarning(warnings, 'ANGULAR_SEPARATION_TOO_LARGE')
	}

	if (coplanarityError > config.coplanarityTolerance) {
		addWarning(warnings, 'POOR_COPLANARITY')
	}

	if (isNearColinear(crossNorm12, r1mag, r2mag, config) || isNearColinear(crossNorm23, r2mag, r3mag, config) || isNearColinear(crossNorm13, r1mag, r3mag, config)) {
		addWarning(warnings, 'NEAR_COLINEAR_POSITIONS')
	}

	if (hasGeometryWarning(warnings)) {
		addWarning(warnings, 'LOW_RELIABILITY_GEOMETRY')
	}

	const diagnostics: HerrickGibbsDiagnostics = {
		dt21,
		dt31,
		dt32,
		angle12,
		angle23,
		angle13,
		coplanarityError,
		crossNorm12,
		crossNorm23,
		crossNorm13,
		warnings,
		reliable: warnings.length === 0,
	}

	if (config.throwOnInvalid && !diagnostics.reliable) {
		throw new Error(`herrick-gibbs input is unreliable: ${warnings.join(', ')}`)
	}

	return {
		r: [r2[0], r2[1], r2[2]],
		v: estimateVelocity(r1, r2, r3, dt21, dt31, dt32, r1mag, r2mag, r3mag, mu, config),
		diagnostics,
	}
}

function resolveOptions(options?: HerrickGibbsOptions): ResolvedHerrickGibbsOptions {
	return {
		timescale: options?.timescale,
		minTimeInterval: positiveOption(options?.minTimeInterval, DEFAULT_MIN_TIME_INTERVAL),
		maxTimeInterval: positiveOption(options?.maxTimeInterval, DEFAULT_MAX_TIME_INTERVAL),
		minPositionNorm: positiveOption(options?.minPositionNorm, DEFAULT_MIN_POSITION_NORM),
		minAngularSeparation: nonNegativeOption(options?.minAngularSeparation, DEFAULT_MIN_ANGULAR_SEPARATION),
		maxAngularSeparation: positiveOption(options?.maxAngularSeparation, DEFAULT_MAX_ANGULAR_SEPARATION),
		coplanarityTolerance: nonNegativeOption(options?.coplanarityTolerance, DEFAULT_COPLANARITY_TOLERANCE),
		minCrossNormRatio: nonNegativeOption(options?.minCrossNormRatio, DEFAULT_MIN_CROSS_NORM_RATIO),
		throwOnInvalid: options?.throwOnInvalid ?? false,
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

function crossNorm(a: Vec3, b: Vec3) {
	return isFiniteVector(a) && isFiniteVector(b) ? vecCrossLength(a, b) : Number.NaN
}

function isFiniteVector(v: Vec3) {
	return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
}

function isValidPositionNorm(norm: number, config: ResolvedHerrickGibbsOptions) {
	return Number.isFinite(norm) && norm > config.minPositionNorm
}

function angleBetween(a: Vec3, b: Vec3, amag: number, bmag: number): Angle {
	const denominator = amag * bmag
	if (!(Number.isFinite(denominator) && denominator > 0)) return Number.NaN
	return vecAngleUnit(a, b)
}

function normalizedCoplanarity(r1: Vec3, r2: Vec3, r3: Vec3, crossNorm12: number, r3mag: number) {
	const denominator = crossNorm12 * r3mag
	if (!(Number.isFinite(denominator) && denominator > 0)) return Number.NaN
	return Math.abs(vecTripleProduct(r1, r2, r3)) / denominator
}

function isTooSmallTime(value: number, config: ResolvedHerrickGibbsOptions) {
	return !Number.isFinite(value) || value <= config.minTimeInterval
}

function isTooSmallAngle(value: Angle, config: ResolvedHerrickGibbsOptions) {
	return Number.isFinite(value) && value < config.minAngularSeparation
}

function isNearColinear(crossNorm: number, aNorm: number, bNorm: number, config: ResolvedHerrickGibbsOptions) {
	const denominator = aNorm * bNorm
	if (!(Number.isFinite(crossNorm) && Number.isFinite(denominator) && denominator > 0)) return false
	return crossNorm / denominator <= config.minCrossNormRatio
}

function hasGeometryWarning(warnings: readonly HerrickGibbsWarning[]) {
	return warnings.includes('ANGULAR_SEPARATION_TOO_SMALL') || warnings.includes('ANGULAR_SEPARATION_TOO_LARGE') || warnings.includes('POOR_COPLANARITY') || warnings.includes('NEAR_COLINEAR_POSITIONS')
}

function addWarning(warnings: HerrickGibbsWarning[], warning: HerrickGibbsWarning) {
	if (!warnings.includes(warning)) warnings.push(warning)
}

// Forms the Herrick-Gibbs middle velocity as a weighted sum c1*r1 + c2*r2 + c3*r3, where each
// weight combines the time-spacing terms with the mu/(12 r^3) gravity correction. Returns a NaN
// vector when the geometry, position norms, or mu are invalid.
function estimateVelocity(r1: Vec3, r2: Vec3, r3: Vec3, dt21: number, dt31: number, dt32: number, r1mag: number, r2mag: number, r3mag: number, mu: number, config: ResolvedHerrickGibbsOptions): MutVec3 {
	if (isTooSmallTime(dt21, config) || isTooSmallTime(dt32, config) || isTooSmallTime(dt31, config) || !isValidPositionNorm(r1mag, config) || !isValidPositionNorm(r2mag, config) || !isValidPositionNorm(r3mag, config) || !(Number.isFinite(mu) && mu > 0)) {
		return [Number.NaN, Number.NaN, Number.NaN]
	}

	const c1 = -dt32 * (1 / (dt21 * dt31) + mu / (12 * r1mag ** 3))
	const c2 = (dt32 - dt21) * (1 / (dt21 * dt32) + mu / (12 * r2mag ** 3))
	const c3 = dt21 * (1 / (dt32 * dt31) + mu / (12 * r3mag ** 3))

	return [c1 * r1[0] + c2 * r2[0] + c3 * r3[0], c1 * r1[1] + c2 * r2[1] + c3 * r3[1], c1 * r1[2] + c2 * r2[2] + c3 * r3[2]]
}
