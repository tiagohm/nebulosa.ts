import type { Angle } from './angle'
import { DEG2RAD } from './constants'
import type { CartesianCoordinate } from './coordinate'
import { eraS2c } from './erfa'
import { clamp } from './math'
import { gibbs, type GibbsWarning } from './orbit.fit.gibbs'
import { herrickGibbs, type HerrickGibbsWarning } from './orbit.fit.herrickgibbs'
import { type Time, timeSubtract } from './time'
import { validateFinite, validateLatitude, validateNonNegativeFinite, validatePositiveFinite, validateTime, validateVector } from './validation'
import { type MutVec3, type Vec3, vecCross, vecCrossLength, vecDot, vecLength, vecNormalizeMut, vecTripleProduct } from './vec3'

const DEFAULT_MIN_POSITIVE_RHO = 1e-12
const DEFAULT_MAX_ITERATIONS = 96
const DEFAULT_TOLERANCE = 1e-12
const MIN_ANGULAR_SEPARATION = 1e-7
const HERRICK_GIBBS_MAX_ARC = 5 * DEG2RAD
const HERRICK_GIBBS_MAX_INTERVAL = 5
const MAX_ROOT_SCAN_STEPS = 256
const ROOT_SCAN_EXPANSION = 1e6
const ROOT_UNIQUENESS_TOLERANCE = 1e-8

export type GaussVelocityMethod = 'gibbs' | 'herrick-gibbs'
export type GaussWarning = GibbsWarning | HerrickGibbsWarning | 'WEAK_D0_GEOMETRY' | 'MULTIPLE_POSITIVE_ROOTS' | 'NON_POSITIVE_RANGE' | 'ROOT_RECONSTRUCTION_MISMATCH' | 'SMALL_ANGULAR_SEPARATION' | 'POSSIBLE_COPLANARITY_PROBLEM' | 'LARGE_HERRICK_GIBBS_ARC'

export interface GaussObservation {
	readonly time: Time
	readonly rightAscension: Angle
	readonly declination: Angle
	readonly observer: Vec3
}

export interface GaussOptions {
	readonly mu: number
	readonly method?: GaussVelocityMethod
	readonly minPositiveRho?: number
	readonly maxIterations?: number
	readonly tolerance?: number
}

export interface GaussState {
	readonly r: CartesianCoordinate
	readonly v: CartesianCoordinate
}

export interface GaussResult {
	readonly state: GaussState
	readonly positions: {
		readonly r1: CartesianCoordinate
		readonly r2: CartesianCoordinate
		readonly r3: CartesianCoordinate
	}
	readonly ranges: {
		readonly rho1: number
		readonly rho2: number
		readonly rho3: number
	}
	readonly diagnostics: {
		readonly selectedRoot: number
		readonly candidateRoots: readonly number[]
		readonly angles: {
			readonly theta12: Angle
			readonly theta23: Angle
			readonly theta13: Angle
		}
		readonly methodForVelocity: GaussVelocityMethod
		readonly warnings: readonly GaussWarning[]
	}
}

interface ResolvedGaussOptions {
	readonly mu: number
	readonly method?: GaussVelocityMethod
	readonly minPositiveRho: number
	readonly maxIterations: number
	readonly tolerance: number
}

interface Determinants {
	readonly D0: number
	readonly D11: number
	readonly D12: number
	readonly D13: number
	readonly D21: number
	readonly D22: number
	readonly D23: number
	readonly D31: number
	readonly D32: number
	readonly D33: number
}

interface Candidate {
	readonly root: number
	readonly rho1: number
	readonly rho2: number
	readonly rho3: number
	readonly r1: MutVec3
	readonly r2: MutVec3
	readonly r3: MutVec3
	readonly score: number
	readonly warnings: readonly GaussWarning[]
}

// Estimates an initial Cartesian state from exactly three astrometric
// observations with the classical Gauss initial orbit determination method.
export function gauss(obs1: GaussObservation, obs2: GaussObservation, obs3: GaussObservation, options: GaussOptions): GaussResult {
	const config = resolveOptions(options)
	validateObservation(obs1, 'obs1')
	validateObservation(obs2, 'obs2')
	validateObservation(obs3, 'obs3')

	const tau1 = timeSubtract(obs1.time, obs2.time, obs2.time.scale)
	const tau3 = timeSubtract(obs3.time, obs2.time, obs2.time.scale)
	const tau = tau3 - tau1

	if (!(tau1 < 0 && tau3 > 0 && tau > 0)) {
		throw new RangeError(`gauss requires strictly increasing observation times with t1 < t2 < t3 (tau1=${formatMetric(tau1)}, tau3=${formatMetric(tau3)})`)
	}

	const rhoHat1 = lineOfSight(obs1.rightAscension, obs1.declination)
	const rhoHat2 = lineOfSight(obs2.rightAscension, obs2.declination)
	const rhoHat3 = lineOfSight(obs3.rightAscension, obs3.declination)
	const angles = angularDiagnostics(rhoHat1, rhoHat2, rhoHat3)
	const diagnosticsWarnings = geometryWarnings(angles)
	const determinants = computeDeterminants(obs1.observer, obs2.observer, obs3.observer, rhoHat1, rhoHat2, rhoHat3)

	if (Math.abs(determinants.D0) <= config.tolerance) {
		throw new RangeError(`gauss line-of-sight geometry is degenerate: |D0|=${formatMetric(Math.abs(determinants.D0))}`)
	}

	if (Math.abs(determinants.D0) <= 100 * config.tolerance) {
		addWarning(diagnosticsWarnings, 'WEAK_D0_GEOMETRY')
	}

	const coefficients = gaussPolynomialCoefficients(determinants, obs2.observer, rhoHat2, tau1, tau3, tau, config.mu)
	const candidateRoots = positivePolynomialRoots(coefficients.a, coefficients.b, coefficients.c, rootScale(coefficients.a, coefficients.b, coefficients.c, obs1.observer, obs2.observer, obs3.observer), config)

	if (candidateRoots.length === 0) {
		throw new RangeError(`gauss failed to find a positive real root for |r2| (D0=${formatMetric(determinants.D0)}, A=${formatMetric(coefficients.A)}, B=${formatMetric(coefficients.B)})`)
	}

	if (candidateRoots.length > 1) {
		addWarning(diagnosticsWarnings, 'MULTIPLE_POSITIVE_ROOTS')
	}

	const candidates = buildCandidates(candidateRoots, determinants, coefficients.A, coefficients.B, obs1.observer, obs2.observer, obs3.observer, rhoHat1, rhoHat2, rhoHat3, tau1, tau3, tau, angles, config)

	if (candidates.length === 0) {
		throw new RangeError(`gauss rejected all positive range candidates (roots=${candidateRoots.map(formatMetric).join(', ')})`)
	}

	const selected = selectCandidate(candidates)
	const methodForVelocity = selectVelocityMethod(config.method, angles, tau1, tau3)
	const velocity = estimateVelocity(selected, obs1.time, obs2.time, obs3.time, methodForVelocity, config.mu, diagnosticsWarnings)
	if (!isFiniteVector(velocity)) {
		throw new RangeError(`gauss produced a non-finite ${methodForVelocity} velocity estimate`)
	}

	const warnings = [...diagnosticsWarnings]
	for (const warning of selected.warnings) addWarning(warnings, warning)

	return {
		state: {
			r: selected.r2,
			v: velocity,
		},
		positions: {
			r1: selected.r1,
			r2: selected.r2,
			r3: selected.r3,
		},
		ranges: {
			rho1: selected.rho1,
			rho2: selected.rho2,
			rho3: selected.rho3,
		},
		diagnostics: {
			selectedRoot: selected.root,
			candidateRoots,
			angles,
			methodForVelocity,
			warnings,
		},
	}
}

function resolveOptions(options: GaussOptions): ResolvedGaussOptions {
	if (options === undefined || options === null) throw new TypeError('gauss options are required')
	validatePositiveFinite(options.mu)
	const minPositiveRho = validateNonNegativeFinite(options.minPositiveRho ?? DEFAULT_MIN_POSITIVE_RHO)
	const maxIterations = validatePositiveFinite(options.maxIterations ?? DEFAULT_MAX_ITERATIONS)
	const tolerance = validatePositiveFinite(options.tolerance ?? DEFAULT_TOLERANCE)
	return { mu: options.mu, method: options.method, minPositiveRho, maxIterations, tolerance }
}

function validateObservation(observation: GaussObservation, name: string) {
	validateTime(observation.time)
	validateFinite(observation.rightAscension)
	validateLatitude(observation.declination)
	validateVector(observation.observer)
}

function lineOfSight(rightAscension: Angle, declination: Angle) {
	return vecNormalizeMut(eraS2c(rightAscension, declination))
}

function computeDeterminants(R1: Vec3, R2: Vec3, R3: Vec3, rhoHat1: Vec3, rhoHat2: Vec3, rhoHat3: Vec3): Determinants {
	const p1 = vecCross(rhoHat2, rhoHat3)
	const p2 = vecCross(rhoHat1, rhoHat3)
	const p3 = vecCross(rhoHat1, rhoHat2)

	return {
		D0: vecDot(rhoHat1, p1),
		D11: vecDot(R1, p1),
		D12: vecDot(R1, p2),
		D13: vecDot(R1, p3),
		D21: vecDot(R2, p1),
		D22: vecDot(R2, p2),
		D23: vecDot(R2, p3),
		D31: vecDot(R3, p1),
		D32: vecDot(R3, p2),
		D33: vecDot(R3, p3),
	}
}

function gaussPolynomialCoefficients(D: Determinants, R2: Vec3, rhoHat2: Vec3, tau1: number, tau3: number, tau: number, mu: number) {
	const A = (-D.D12 * (tau3 / tau) + D.D22 + D.D32 * (tau1 / tau)) / D.D0
	const B = (D.D12 * (tau3 * tau3 - tau * tau) * (tau3 / tau) + D.D32 * (tau * tau - tau1 * tau1) * (tau1 / tau)) / (6 * D.D0)
	const E = vecDot(R2, rhoHat2)
	const R2NormSquared = vecDot(R2, R2)

	// Classical Gauss IOD scalar equation for x = |r2|:
	// x^8 + a*x^6 + b*x^3 + c = 0.
	const a = -(A * A + 2 * A * E + R2NormSquared)
	const b = -2 * mu * B * (A + E)
	const c = -(mu * mu) * B * B

	return { A, B, a, b, c }
}

function positivePolynomialRoots(a: number, b: number, c: number, scale: number, config: ResolvedGaussOptions) {
	const roots: number[] = []
	const lower = Math.max(Number.MIN_VALUE, scale * 1e-12, config.minPositiveRho * 1e-3)
	const upper = Math.max(scale * ROOT_SCAN_EXPANSION, lower * 10)
	let previousX = 0
	let previousY = polynomial(0, a, b, c)

	if (isNearZero(previousY, config.tolerance)) {
		addUniqueRoot(roots, lower, config.tolerance)
	}

	for (let i = 0; i <= MAX_ROOT_SCAN_STEPS; i++) {
		const t = i / MAX_ROOT_SCAN_STEPS
		const x = lower * (upper / lower) ** t
		const y = polynomial(x, a, b, c)

		if (!Number.isFinite(y)) break

		if (isNearZero(y, rootTolerance(x, scale, config.tolerance))) {
			addUniqueRoot(roots, refineRootNear(x, a, b, c, scale, config), config.tolerance)
		} else if (previousY * y < 0) {
			addUniqueRoot(roots, bisectRoot(previousX, x, a, b, c, scale, config), config.tolerance)
		}

		previousX = x
		previousY = y
	}

	if (roots.length === 0 && Number.isFinite(previousY)) {
		let low = upper
		let yLow = previousY
		let high = upper

		for (let i = 0; i < config.maxIterations; i++) {
			high *= 2
			const yHigh = polynomial(high, a, b, c)

			if (!Number.isFinite(yHigh)) break
			if (isNearZero(yHigh, rootTolerance(high, scale, config.tolerance))) {
				addUniqueRoot(roots, high, config.tolerance)
				break
			}

			if (yLow * yHigh < 0) {
				addUniqueRoot(roots, bisectRoot(low, high, a, b, c, scale, config), config.tolerance)
				break
			}

			low = high
			yLow = yHigh
		}
	}

	return roots.filter((root) => Number.isFinite(root) && root > 0).sort((x, y) => x - y)
}

function polynomial(x: number, a: number, b: number, c: number) {
	const x2 = x * x
	const x3 = x2 * x
	const x6 = x3 * x3
	return x6 * x2 + a * x6 + b * x3 + c
}

function rootScale(a: number, b: number, c: number, R1: Vec3, R2: Vec3, R3: Vec3) {
	return Math.max(1, Math.sqrt(Math.abs(a)), Math.abs(b) ** 0.2, Math.abs(c) ** 0.125, vecLength(R1), vecLength(R2), vecLength(R3))
}

function rootTolerance(x: number, scale: number, tolerance: number) {
	return Math.max(1, x ** 8, scale ** 8) * tolerance * 100
}

function isNearZero(value: number, tolerance: number) {
	return Math.abs(value) <= tolerance
}

function refineRootNear(x: number, a: number, b: number, c: number, scale: number, config: ResolvedGaussOptions) {
	let center = x
	let step = Math.max(x * 1e-3, scale * 1e-9, config.tolerance)

	for (let i = 0; i < config.maxIterations; i++) {
		const left = Math.max(0, center - step)
		const right = center + step
		const yLeft = polynomial(left, a, b, c)
		const yRight = polynomial(right, a, b, c)

		if (Number.isFinite(yLeft) && Number.isFinite(yRight) && yLeft * yRight < 0) {
			return bisectRoot(left, right, a, b, c, scale, config)
		}

		const yCenter = polynomial(center, a, b, c)
		const derivative = polynomialDerivative(center, a, b)
		if (Number.isFinite(yCenter) && Number.isFinite(derivative) && derivative !== 0) {
			const next = center - yCenter / derivative
			if (Number.isFinite(next) && next > 0 && Math.abs(next - center) <= step) {
				center = next
			}
		}

		step *= 2
	}

	return center
}

function polynomialDerivative(x: number, a: number, b: number) {
	const x2 = x * x
	const x3 = x2 * x
	const x5 = x3 * x2
	const x7 = x5 * x2
	return 8 * x7 + 6 * a * x5 + 3 * b * x2
}

function bisectRoot(lower: number, upper: number, a: number, b: number, c: number, scale: number, config: ResolvedGaussOptions) {
	let low = lower
	let high = upper
	let yLow = polynomial(low, a, b, c)

	for (let i = 0; i < config.maxIterations; i++) {
		const mid = 0.5 * (low + high)
		const yMid = polynomial(mid, a, b, c)

		if (!Number.isFinite(yMid) || Math.abs(high - low) <= Math.max(config.tolerance * Math.max(1, mid), scale * Number.EPSILON)) {
			return mid
		}

		if (isNearZero(yMid, rootTolerance(mid, scale, config.tolerance))) {
			return mid
		}

		if (yLow * yMid <= 0) {
			high = mid
		} else {
			low = mid
			yLow = yMid
		}
	}

	return 0.5 * (low + high)
}

function addUniqueRoot(roots: number[], root: number, tolerance: number) {
	if (!(Number.isFinite(root) && root > 0)) return
	const threshold = Math.max(ROOT_UNIQUENESS_TOLERANCE, tolerance * Math.max(1, root))
	for (const current of roots) {
		if (Math.abs(current - root) <= threshold * Math.max(1, Math.abs(current), Math.abs(root))) return
	}
	roots.push(root)
}

function buildCandidates(roots: readonly number[], D: Determinants, A: number, B: number, R1: Vec3, R2: Vec3, R3: Vec3, rhoHat1: Vec3, rhoHat2: Vec3, rhoHat3: Vec3, tau1: number, tau3: number, tau: number, angles: GaussResult['diagnostics']['angles'], config: ResolvedGaussOptions) {
	const candidates: Candidate[] = []

	for (const root of roots) {
		const candidate = buildCandidate(root, D, A, B, R1, R2, R3, rhoHat1, rhoHat2, rhoHat3, tau1, tau3, tau, angles, config)

		if (candidate) {
			candidates.push(candidate)
		}
	}

	return candidates
}

function buildCandidate(root: number, D: Determinants, A: number, B: number, R1: Vec3, R2: Vec3, R3: Vec3, rhoHat1: Vec3, rhoHat2: Vec3, rhoHat3: Vec3, tau1: number, tau3: number, tau: number, angles: GaussResult['diagnostics']['angles'], config: ResolvedGaussOptions): Candidate | undefined {
	const warnings: GaussWarning[] = []
	const x3 = root * root * root
	const rho2 = A + (config.mu * B) / x3
	const f1 = 1 - (0.5 * config.mu * tau1 * tau1) / x3
	const f3 = 1 - (0.5 * config.mu * tau3 * tau3) / x3
	const g1 = tau1 - (config.mu * tau1 * tau1 * tau1) / (6 * x3)
	const g3 = tau3 - (config.mu * tau3 * tau3 * tau3) / (6 * x3)
	const denominator = f1 * g3 - f3 * g1

	if (!(Number.isFinite(denominator) && Math.abs(denominator) > config.tolerance)) {
		return undefined
	}

	const c1 = g3 / denominator
	const c3 = -g1 / denominator
	if (!Number.isFinite(c1) || !Number.isFinite(c3)) return undefined

	const rho1Numerator = 6 * (D.D31 * (tau1 / tau3) + D.D21 * (tau / tau3)) * x3 + config.mu * D.D31 * (tau * tau - tau1 * tau1) * (tau1 / tau3)
	const rho1Denominator = 6 * x3 + config.mu * (tau * tau - tau3 * tau3)
	const rho3Numerator = 6 * (D.D13 * (tau3 / tau1) - D.D23 * (tau / tau1)) * x3 + config.mu * D.D13 * (tau * tau - tau3 * tau3) * (tau3 / tau1)
	const rho3Denominator = 6 * x3 + config.mu * (tau * tau - tau1 * tau1)

	if (!(Math.abs(rho1Denominator) > config.tolerance && Math.abs(rho3Denominator) > config.tolerance)) {
		return undefined
	}

	const rho1 = (rho1Numerator / rho1Denominator - D.D11) / D.D0
	const rho3 = (rho3Numerator / rho3Denominator - D.D33) / D.D0

	if (!Number.isFinite(rho1) || !Number.isFinite(rho2) || !Number.isFinite(rho3)) {
		return undefined
	}

	if (rho1 <= config.minPositiveRho || rho2 <= config.minPositiveRho || rho3 <= config.minPositiveRho) {
		addWarning(warnings, 'NON_POSITIVE_RANGE')
		return undefined
	}

	const r1 = reconstructPosition(R1, rho1, rhoHat1)
	const r2 = reconstructPosition(R2, rho2, rhoHat2)
	const r3 = reconstructPosition(R3, rho3, rhoHat3)

	if (!isFiniteVector(r1) || !isFiniteVector(r2) || !isFiniteVector(r3)) {
		return undefined
	}

	const rootMismatch = Math.abs(vecLength(r2) - root) / Math.max(1, root)
	if (rootMismatch > Math.max(1e-6, 1000 * config.tolerance)) {
		addWarning(warnings, 'ROOT_RECONSTRUCTION_MISMATCH')
		return undefined
	}

	if (hasSmallAngle(angles)) {
		addWarning(warnings, 'SMALL_ANGULAR_SEPARATION')
	}

	const geometryScale = Math.max(vecCrossLength(r1, r2), vecCrossLength(r2, r3), vecCrossLength(r1, r3))
	const coplanarity = geometryScale > 0 ? Math.abs(vecTripleProduct(r1, r2, r3)) / (vecLength(r2) * geometryScale) : Number.POSITIVE_INFINITY
	if (!(Number.isFinite(coplanarity) && coplanarity <= 1e-2)) {
		addWarning(warnings, 'POSSIBLE_COPLANARITY_PROBLEM')
	}

	const rangeMean = (rho1 + rho2 + rho3) / 3
	const rangeSpread = Math.max(Math.abs(rho1 - rangeMean), Math.abs(rho2 - rangeMean), Math.abs(rho3 - rangeMean)) / Math.max(config.minPositiveRho, rangeMean)
	const lagrangeVelocity = centralVelocityFromFG(r1, r3, f1, f3, denominator)
	const eccentricity = stateEccentricity(r2, lagrangeVelocity, config.mu)

	if (!Number.isFinite(eccentricity)) {
		return undefined
	}

	// Multiple positive Gauss roots can all reproject exactly. Prefer the
	// smoother two-body branch instead of rewarding the largest position arc.
	const score = warnings.length * 100 + rootMismatch * 100 + rangeSpread + 10 * eccentricity + root * 1e-9

	return {
		root,
		rho1,
		rho2,
		rho3,
		r1,
		r2,
		r3,
		score,
		warnings,
	}
}

function reconstructPosition(observer: Vec3, rho: number, rhoHat: Vec3): MutVec3 {
	return [observer[0] + rho * rhoHat[0], observer[1] + rho * rhoHat[1], observer[2] + rho * rhoHat[2]]
}

function centralVelocityFromFG(r1: Vec3, r3: Vec3, f1: number, f3: number, denominator: number): MutVec3 {
	return [(f1 * r3[0] - f3 * r1[0]) / denominator, (f1 * r3[1] - f3 * r1[1]) / denominator, (f1 * r3[2] - f3 * r1[2]) / denominator]
}

function stateEccentricity(r: Vec3, v: Vec3, mu: number) {
	const rNorm = vecLength(r)
	const vSquared = vecDot(v, v)
	const rv = vecDot(r, v)

	if (!(Number.isFinite(rNorm) && rNorm > 0 && Number.isFinite(vSquared) && Number.isFinite(rv))) {
		return Number.POSITIVE_INFINITY
	}

	const radialScale = vSquared - mu / rNorm
	const ex = (r[0] * radialScale - v[0] * rv) / mu
	const ey = (r[1] * radialScale - v[1] * rv) / mu
	const ez = (r[2] * radialScale - v[2] * rv) / mu
	return Math.hypot(ex, ey, ez)
}

function selectCandidate(candidates: readonly Candidate[]) {
	let best = candidates[0]

	for (let i = 1; i < candidates.length; i++) {
		const candidate = candidates[i]
		if (candidate.score < best.score || (candidate.score === best.score && candidate.root < best.root)) {
			best = candidate
		}
	}

	return best
}

function angularDiagnostics(rhoHat1: Vec3, rhoHat2: Vec3, rhoHat3: Vec3): GaussResult['diagnostics']['angles'] {
	return {
		theta12: angleBetweenUnit(rhoHat1, rhoHat2),
		theta23: angleBetweenUnit(rhoHat2, rhoHat3),
		theta13: angleBetweenUnit(rhoHat1, rhoHat3),
	}
}

function angleBetweenUnit(a: Vec3, b: Vec3): Angle {
	return Math.acos(clamp(vecDot(a, b), -1, 1))
}

function geometryWarnings(angles: GaussResult['diagnostics']['angles']) {
	const warnings: GaussWarning[] = []

	if (hasSmallAngle(angles)) {
		addWarning(warnings, 'SMALL_ANGULAR_SEPARATION')
	}

	return warnings
}

function hasSmallAngle(angles: GaussResult['diagnostics']['angles']) {
	return angles.theta12 < MIN_ANGULAR_SEPARATION || angles.theta23 < MIN_ANGULAR_SEPARATION || angles.theta13 < MIN_ANGULAR_SEPARATION
}

function selectVelocityMethod(requested: GaussVelocityMethod | undefined, angles: GaussResult['diagnostics']['angles'], tau1: number, tau3: number): GaussVelocityMethod {
	if (requested) return requested
	const maxInterval = Math.max(Math.abs(tau1), Math.abs(tau3))
	return maxInterval <= HERRICK_GIBBS_MAX_INTERVAL && angles.theta13 <= HERRICK_GIBBS_MAX_ARC ? 'herrick-gibbs' : 'gibbs'
}

function estimateVelocity(candidate: Candidate, t1: Time, t2: Time, t3: Time, method: GaussVelocityMethod, mu: number, warnings: GaussWarning[]): MutVec3 {
	if (method === 'herrick-gibbs') {
		const result = herrickGibbs(candidate.r1, candidate.r2, candidate.r3, t1, t2, t3, mu)
		for (const warning of result.diagnostics.warnings) addWarning(warnings, warning)
		if (!result.diagnostics.reliable && result.diagnostics.warnings.includes('ANGULAR_SEPARATION_TOO_LARGE')) addWarning(warnings, 'LARGE_HERRICK_GIBBS_ARC')
		return [result.v[0], result.v[1], result.v[2]]
	}

	const result = gibbs(candidate.r1, candidate.r2, candidate.r3, mu, { allowUnreliable: true })
	for (const warning of result.diagnostics.warnings) addWarning(warnings, warning)
	return [result.v[0], result.v[1], result.v[2]]
}

function isFiniteVector(v: Vec3) {
	return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
}

function addWarning(warnings: GaussWarning[], warning: GaussWarning) {
	if (!warnings.includes(warning)) warnings.push(warning)
}

function formatMetric(value: number) {
	return Number.isFinite(value) ? value.toExponential(6) : String(value)
}
