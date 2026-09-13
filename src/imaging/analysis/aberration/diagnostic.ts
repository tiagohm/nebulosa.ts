import { PI, PIOVERTWO } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import type { FocusCurvatureAnalysis, FocusPlaneAnalysis, FocusSurfaceFitResult, FocusSurfaceModel, FocusSurfaceSample } from '../../../math/numerical/surface.fit'
import type { Angle } from '../../../math/units/angle'
import type { FocusFieldOffset } from './physical'
import type { AberrationFinding, AberrationInspectionQuality, AberrationLimitationCode, AberrationRegionResult, AberrationStar } from './types'

// Conservative evidence-based single-frame aberration findings without mechanical conclusions.

// Minimum oriented samples required for directional quick findings.
const MINIMUM_ORIENTATION_SAMPLES = 5
// Minimum HFD samples required for scalar quick findings.
const MINIMUM_SIZE_SAMPLES = 5
// Minimum coherence needed before calling a field direction uniform.
const UNIFORM_COHERENCE = 0.65
// Minimum radial/tangential alignment score needed for a directional finding.
const DIRECTIONAL_ALIGNMENT = 0.65
// Minimum edge-to-center size ratio treated as field degradation.
const FIELD_DEGRADATION_RATIO = 1.1
// Minimum combined HFD coordinate correlation treated as a one-frame focus gradient.
const FOCUS_GRADIENT_CORRELATION = 0.55
// Two-sided unit-Gaussian 3σ tail, 2(1-Φ(3)), used as the Wald/F false-positive budget.
const SIGNIFICANCE_ALPHA = 0.002699796063260207
// Minimum residual degrees of freedom required before a finite Wald statistic is published.
const MINIMUM_WALD_DEGREES_OF_FREEDOM = 4
// Extra tail factor applied after robust sample rejection, which otherwise inflates Wald statistics.
const REJECTED_SAMPLE_ALPHA_FACTOR = 10
// Lanczos g=7 coefficients for log Γ(z) after the reflection formula for z < 0.5.
const LOG_GAMMA_LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7] as const

// Evaluates non-definitive optical patterns from selected profiles and regional support diagnostics.
export function diagnoseSingleFrameAberration(stars: readonly AberrationStar[], regions: readonly AberrationRegionResult[], quality: AberrationInspectionQuality): AberrationFinding[] {
	const limitations = inspectionLimitations(quality)
	const oriented = collectOriented(stars)
	const sized = collectSized(stars)
	const findings: AberrationFinding[] = []

	if (sized.length < MINIMUM_SIZE_SAMPLES || quality.occupiedRegionCount < 2) {
		findings.push({
			kind: 'insufficientData',
			likelihood: 1,
			confidence: quality.confidence,
			evidence: [
				{ code: 'usableHFDCount', value: sized.length, reference: MINIMUM_SIZE_SAMPLES, confidence: 1 },
				{ code: 'occupiedRegionCount', value: quality.occupiedRegionCount, reference: 2, confidence: 1 },
			],
			limitations: uniqueLimitations([...limitations, 'insufficientStars', 'insufficientCoverage']),
		})
		return findings
	}

	const fieldDegradation = fieldDegradationFinding(sized, quality, limitations)
	if (fieldDegradation) findings.push(fieldDegradation)

	const gradient = focusGradientFinding(sized, quality, limitations)
	if (gradient) findings.push(gradient)

	if (oriented.length >= MINIMUM_ORIENTATION_SAMPLES) {
		const orientation = axialSummary(oriented)
		const uniform = uniformElongationFinding(oriented, orientation, quality, limitations)
		if (uniform) findings.push(uniform)

		const directional = radialTangentialFindings(oriented, quality, limitations)
		for (let i = 0; i < directional.length; i++) findings.push(directional[i])
	} else if (findings.length === 0) {
		findings.push({
			kind: 'inconclusive',
			likelihood: 1,
			confidence: quality.confidence,
			evidence: [{ code: 'orientedStarCount', value: oriented.length, reference: MINIMUM_ORIENTATION_SAMPLES, confidence: 1 }],
			limitations: uniqueLimitations([...limitations, 'lowOrientationCoherence']),
		})
	}

	if (findings.length === 0) {
		findings.push({
			kind: 'inconclusive',
			likelihood: 1,
			confidence: quality.confidence,
			evidence: [{ code: 'regionalSupport', value: supportedRegionFraction(regions), reference: 1, confidence: quality.confidence }],
			limitations,
		})
	}

	return findings
}

// Evaluates uncertainty-qualified patterns from a completed regional focus scan.
export function diagnoseFocusScan(surface: FocusSurfaceFitResult | undefined, plane: FocusPlaneAnalysis | undefined, curvature: FocusCurvatureAnalysis | undefined, fieldOffset: FocusFieldOffset | undefined, backfocusCalibrated: boolean = false): AberrationFinding[] {
	if (!surface?.success || plane === undefined || curvature === undefined) {
		return [{ kind: 'inconclusive', likelihood: 1, confidence: 0, evidence: [], limitations: ['modelUncertaintyUnavailable'] }]
	}
	if (surface.covariance === undefined) {
		return [{ kind: 'inconclusive', likelihood: 1, confidence: surface.confidence, evidence: [{ code: 'surfaceConditionNumber', value: surface.conditionNumber, confidence: surface.confidence }], limitations: ['modelUncertaintyUnavailable'] }]
	}

	const findings: AberrationFinding[] = []
	const columns = surface.model === 'plane' ? 3 : surface.model === 'radialQuadratic' ? 4 : 6
	const degreesOfFreedom = surface.degreesOfFreedom
	const covariance = retainedCovariance(surface, columns)
	if (!(degreesOfFreedom > 0) || covariance === undefined || covariance.length !== columns * columns) {
		return [{ kind: 'inconclusive', likelihood: 1, confidence: surface.confidence, evidence: [{ code: 'surfaceConditionNumber', value: surface.conditionNumber, confidence: surface.confidence }], limitations: ['modelUncertaintyUnavailable'] }]
	}

	const rejectedCount = surface.rejectedIndices.length
	const tiltWald = coefficientWald([surface.coefficients.ax, surface.coefficients.ay], covariance, [1, 2], columns)
	if (tiltWald !== undefined) {
		const pValue = fTailProbability(tiltWald, 2, degreesOfFreedom)
		if (significantWald(pValue, degreesOfFreedom, rejectedCount)) {
			findings.push({
				kind: 'sensorTiltPattern',
				likelihood: significanceLikelihood(pValue),
				confidence: surface.confidence,
				evidence: [
					{ code: 'planeEffect', value: plane.effect, confidence: surface.confidence },
					{ code: 'planePValue', value: pValue, reference: SIGNIFICANCE_ALPHA, confidence: surface.confidence },
				],
				limitations: ['missingPhysicalScale'],
			})
		}
	}

	const curvatureParameters = surface.model === 'radialQuadratic' ? 1 : surface.model === 'quadratic' ? 3 : 0
	const curvatureWald = curvatureParameters === 1 ? coefficientWald([surface.coefficients.qxx], covariance, [3], columns) : curvatureParameters === 3 ? coefficientWald([surface.coefficients.qxx, surface.coefficients.qxy, surface.coefficients.qyy], covariance, [3, 4, 5], columns) : undefined
	if (curvatureWald !== undefined) {
		const pValue = fTailProbability(curvatureWald, curvatureParameters, degreesOfFreedom)
		if (significantWald(pValue, degreesOfFreedom, rejectedCount)) {
			findings.push({
				kind: 'fieldCurvature',
				likelihood: significanceLikelihood(pValue),
				confidence: surface.confidence,
				evidence: [
					{ code: 'curvatureEffect', value: curvature.effect, confidence: surface.confidence },
					{ code: 'curvaturePValue', value: pValue, reference: SIGNIFICANCE_ALPHA, confidence: surface.confidence },
				],
				limitations: [],
			})
			if ((curvature.anisotropy ?? 0) >= 0.2)
				findings.push({ kind: 'astigmaticCurvature', likelihood: clamp(curvature.anisotropy ?? 0, 0, 1), confidence: surface.confidence, evidence: [{ code: 'curvatureAnisotropy', value: curvature.anisotropy ?? 0, reference: 0.2, confidence: surface.confidence }], limitations: [] })
		}
	}

	if (backfocusCalibrated && fieldOffset !== undefined) {
		const curvatureUncertainty = quadraticEffectUncertainty(surface, covariance, columns)
		if (curvatureUncertainty !== undefined) {
			const offset = Math.abs(fieldOffset.centerToEdge)
			const wald = curvatureUncertainty > 0 ? (offset * offset) / (curvatureUncertainty * curvatureUncertainty) : offset === 0 ? 0 : Number.POSITIVE_INFINITY
			const pValue = fTailProbability(wald, 1, degreesOfFreedom)
			if (significantWald(pValue, degreesOfFreedom, rejectedCount)) {
				findings.push({
					kind: 'backfocusMismatch',
					likelihood: clamp(offset / Math.max(curvature.effect, Number.EPSILON), 0, 1),
					confidence: Math.min(surface.confidence, fieldOffset.confidence),
					evidence: [
						{ code: 'centerToEdgeFocus', value: fieldOffset.centerToEdge, confidence: fieldOffset.confidence },
						{ code: 'backfocusPValue', value: pValue, reference: SIGNIFICANCE_ALPHA, confidence: fieldOffset.confidence },
					],
					limitations: [],
				})
			}
		}
	}

	return findings.length > 0 ? findings : [{ kind: 'inconclusive', likelihood: 1, confidence: surface.confidence, evidence: [{ code: 'surfaceConditionNumber', value: surface.conditionNumber, confidence: surface.confidence }], limitations: [] }]
}

// Whether a Wald/F p-value may be published, requiring residual df and a tighter tail after robust rejection.
function significantWald(pValue: number, degreesOfFreedom: number, rejectedCount: number): boolean {
	if (!(pValue < SIGNIFICANCE_ALPHA)) return false
	if (pValue === 0) return true
	if (!(degreesOfFreedom >= MINIMUM_WALD_DEGREES_OF_FREEDOM)) return false
	return rejectedCount > 0 ? pValue < SIGNIFICANCE_ALPHA / REJECTED_SAMPLE_ALPHA_FACTOR : true
}

// Maps a significant Wald/F p-value onto 0..1, reaching 1 at a 100× smaller tail than the 3σ budget.
function significanceLikelihood(pValue: number): number {
	if (!(pValue > 0)) return 1
	return clamp(Math.log(SIGNIFICANCE_ALPHA / pValue) / Math.log(100), 0, 1)
}

// Survival function of p * F_{p, ν} evaluated at a Wald statistic, returning 1 when the test is undefined.
function fTailProbability(wald: number, parameters: number, degreesOfFreedom: number): number {
	if (wald === Number.POSITIVE_INFINITY && parameters > 0 && degreesOfFreedom > 0) return 0
	if (!(wald >= 0) || !(parameters > 0) || !(degreesOfFreedom > 0) || !Number.isFinite(wald) || !Number.isFinite(parameters) || !Number.isFinite(degreesOfFreedom)) return 1
	if (wald === 0) return 1
	const x = degreesOfFreedom / (degreesOfFreedom + wald)
	if (parameters === 2) {
		const pValue = Math.exp((degreesOfFreedom / 2) * -Math.log1p(wald / degreesOfFreedom))
		return Number.isFinite(pValue) ? clamp(pValue, 0, 1) : 0
	}
	const pValue = regularizedIncompleteBeta(x, degreesOfFreedom / 2, parameters / 2)
	return Number.isFinite(pValue) ? clamp(pValue, 0, 1) : 1
}

// Regularized incomplete beta I_x(a, b) via the continued-fraction representation and log Γ.
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
	if (!Number.isFinite(x) || !(a > 0) || !(b > 0)) return Number.NaN
	if (!(x > 0)) return 0
	if (!(x < 1)) return 1
	const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
	const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta)
	if (!Number.isFinite(front)) return x < (a + 1) / (a + b + 2) ? 0 : 1
	if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a
	return 1 - (Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta) * betaContinuedFraction(1 - x, b, a)) / b
}

// Lentz continued fraction for the incomplete-beta series, converging for x in (0, 1) and a, b > 0.
function betaContinuedFraction(x: number, a: number, b: number): number {
	const qab = a + b
	const qap = a + 1
	const qam = a - 1
	let c = 1
	let d = 1 - (qab * x) / qap
	if (Math.abs(d) < Number.MIN_VALUE) d = Number.MIN_VALUE
	d = 1 / d
	let h = d
	for (let m = 1; m <= 200; m++) {
		const m2 = 2 * m
		let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
		d = 1 + aa * d
		if (Math.abs(d) < Number.MIN_VALUE) d = Number.MIN_VALUE
		c = 1 + aa / c
		if (Math.abs(c) < Number.MIN_VALUE) c = Number.MIN_VALUE
		d = 1 / d
		h *= d * c
		aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
		d = 1 + aa * d
		if (Math.abs(d) < Number.MIN_VALUE) d = Number.MIN_VALUE
		c = 1 + aa / c
		if (Math.abs(c) < Number.MIN_VALUE) c = Number.MIN_VALUE
		d = 1 / d
		const delta = d * c
		h *= delta
		if (Math.abs(delta - 1) < 1e-14) break
	}
	return h
}

// Lanczos log Γ(z) for z > 0, using the reflection formula below 0.5.
function logGamma(z: number): number {
	if (!(z > 0) || !Number.isFinite(z)) return Number.NaN
	if (z < 0.5) return Math.log(PI / Math.sin(PI * z)) - logGamma(1 - z)
	z -= 1
	let x = LOG_GAMMA_LANCZOS[0]
	for (let i = 1; i < LOG_GAMMA_LANCZOS.length; i++) x += LOG_GAMMA_LANCZOS[i] / (z + i)
	const t = z + 7.5
	return 0.5 * Math.log(2 * PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

// Wald statistic v' Σ^{-1} v for a coefficient block, or infinity when a zero covariance meets a non-zero estimate.
function coefficientWald(values: readonly number[], covariance: Float64Array, indices: readonly number[], columns: number): number | undefined {
	if (covariance.length !== columns * columns || values.length !== indices.length) return undefined
	const n = indices.length
	if (n === 1) {
		const variance = covariance[indices[0] * columns + indices[0]]
		if (!Number.isFinite(variance) || variance < 0) return undefined
		if (!(variance > 0)) return zeroSubmatrixWald(values)
		const wald = (values[0] * values[0]) / variance
		return Number.isFinite(wald) ? wald : undefined
	}
	if (n === 2) {
		const i = indices[0]
		const j = indices[1]
		const s11 = covariance[i * columns + i]
		const s12 = covariance[i * columns + j]
		const s22 = covariance[j * columns + j]
		if (!Number.isFinite(s11) || !Number.isFinite(s12) || !Number.isFinite(s22)) return undefined
		const det = s11 * s22 - s12 * s12
		if (!(s11 > 0) || !(det > 0)) return s11 === 0 && s12 === 0 && s22 === 0 ? zeroSubmatrixWald(values) : undefined
		const wald = (s22 * values[0] * values[0] - 2 * s12 * values[0] * values[1] + s11 * values[1] * values[1]) / det
		return wald >= 0 && Number.isFinite(wald) ? wald : undefined
	}
	if (n !== 3) return undefined
	const i0 = indices[0]
	const i1 = indices[1]
	const i2 = indices[2]
	const a00 = covariance[i0 * columns + i0]
	const a01 = covariance[i0 * columns + i1]
	const a02 = covariance[i0 * columns + i2]
	const a11 = covariance[i1 * columns + i1]
	const a12 = covariance[i1 * columns + i2]
	const a22 = covariance[i2 * columns + i2]
	if (!Number.isFinite(a00) || !Number.isFinite(a01) || !Number.isFinite(a02) || !Number.isFinite(a11) || !Number.isFinite(a12) || !Number.isFinite(a22)) return undefined
	const minor = a00 * a11 - a01 * a01
	const det = a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a02 * a12) + a02 * (a01 * a12 - a02 * a11)
	if (!(a00 > 0) || !(minor > 0) || !(det > 0)) return a00 === 0 && a01 === 0 && a02 === 0 && a11 === 0 && a12 === 0 && a22 === 0 ? zeroSubmatrixWald(values) : undefined
	const c00 = a11 * a22 - a12 * a12
	const c01 = a02 * a12 - a01 * a22
	const c02 = a01 * a12 - a02 * a11
	const c11 = a00 * a22 - a02 * a02
	const c12 = a02 * a01 - a00 * a12
	const c22 = a00 * a11 - a01 * a01
	const y0 = c00 * values[0] + c01 * values[1] + c02 * values[2]
	const y1 = c01 * values[0] + c11 * values[1] + c12 * values[2]
	const y2 = c02 * values[0] + c12 * values[1] + c22 * values[2]
	const wald = (values[0] * y0 + values[1] * y1 + values[2] * y2) / det
	return wald >= 0 && Number.isFinite(wald) ? wald : undefined
}

// Infinite significance when a non-zero coefficient block has a numerically zero covariance, otherwise 0.
function zeroSubmatrixWald(values: readonly number[]): number {
	let maxAbs = 0
	for (let i = 0; i < values.length; i++) maxAbs = Math.max(maxAbs, Math.abs(values[i]))
	// Roundoff-sized coefficients on an exact interpolant are not a physical signal.
	return maxAbs > 1e-8 * Math.max(1, maxAbs) ? Number.POSITIVE_INFINITY : 0
}

// OLS covariance on robustly retained samples using caller weights, not fractional IRLS weights.
function retainedCovariance(surface: FocusSurfaceFitResult & { readonly success: true }, columns: number): Float64Array | undefined {
	if (!(surface.degreesOfFreedom > 0)) return undefined
	const normal = new Float64Array(columns * columns)
	let weightedSse = 0
	for (let row = 0; row < surface.samples.length; row++) {
		if (!surface.used[row]) continue
		const sample = surface.samples[row]
		const weight = retainedSampleWeight(sample)
		const residual = surface.residuals[row]
		weightedSse += weight * residual * residual
		const design = retainedDesignRow(sample.u, sample.v, surface.model)
		for (let i = 0; i < columns; i++) {
			const left = design[i] * weight
			for (let j = 0; j < columns; j++) normal[i * columns + j] += left * design[j]
		}
	}
	const inverse = invertSquareMatrix(normal, columns)
	if (inverse === undefined) return undefined
	const variance = weightedSse / surface.degreesOfFreedom
	if (!Number.isFinite(variance) || variance < 0) return undefined
	for (let i = 0; i < inverse.length; i++) inverse[i] *= variance
	return inverse
}

// Caller statistical weight used to retain a sample after robust rejection.
function retainedSampleWeight(sample: FocusSurfaceSample): number {
	return sample.weight ?? (sample.uncertainty === undefined ? 1 : 1 / (sample.uncertainty * sample.uncertainty))
}

// Design row matching the focus-surface model column order used by the published covariance.
function retainedDesignRow(u: number, v: number, model: FocusSurfaceModel): Float64Array {
	return model === 'plane' ? new Float64Array([1, u, v]) : model === 'radialQuadratic' ? new Float64Array([1, u, v, u * u + v * v]) : new Float64Array([1, u, v, u * u, u * v, v * v])
}

// Inverts a small dense square matrix by partial-pivot Gauss-Jordan elimination.
function invertSquareMatrix(source: Readonly<Float64Array>, size: number): Float64Array | undefined {
	const width = size * 2
	const augmented = new Float64Array(size * width)
	for (let row = 0; row < size; row++) {
		for (let column = 0; column < size; column++) augmented[row * width + column] = source[row * size + column]
		augmented[row * width + size + row] = 1
	}

	for (let column = 0; column < size; column++) {
		let pivot = column
		let maximum = Math.abs(augmented[pivot * width + column])
		for (let row = column + 1; row < size; row++) {
			const candidate = Math.abs(augmented[row * width + column])
			if (candidate > maximum) {
				maximum = candidate
				pivot = row
			}
		}
		if (!(maximum > Number.EPSILON) || !Number.isFinite(maximum)) return undefined

		if (pivot !== column) {
			for (let index = 0; index < width; index++) {
				const temporary = augmented[column * width + index]
				augmented[column * width + index] = augmented[pivot * width + index]
				augmented[pivot * width + index] = temporary
			}
		}

		const divisor = augmented[column * width + column]
		for (let index = 0; index < width; index++) augmented[column * width + index] /= divisor
		for (let row = 0; row < size; row++) {
			if (row === column) continue
			const factor = augmented[row * width + column]
			if (factor === 0) continue
			for (let index = 0; index < width; index++) augmented[row * width + index] -= factor * augmented[column * width + index]
		}
	}

	const inverse = new Float64Array(size * size)
	for (let row = 0; row < size; row++) {
		for (let column = 0; column < size; column++) inverse[row * size + column] = augmented[row * width + size + column]
	}
	return inverse
}

// Estimates a conservative curvature-effect uncertainty from quadratic coefficient covariance.
function quadraticEffectUncertainty(surface: FocusSurfaceFitResult & { readonly success: true }, covariance: Float64Array, columns: number): number | undefined {
	if (covariance.length !== columns * columns || surface.model === 'plane') return undefined
	if (surface.model === 'radialQuadratic') {
		const variance = covariance[3 * columns + 3]
		return variance >= 0 && Number.isFinite(variance) ? 0.5 * Math.sqrt(variance) : undefined
	}
	const variance = 0.0625 * (covariance[3 * columns + 3] + covariance[5 * columns + 5] + 2 * Math.abs(covariance[3 * columns + 5])) + 0.0625 * covariance[4 * columns + 4]
	return variance >= 0 && Number.isFinite(variance) ? Math.sqrt(variance) : undefined
}

// Collects selected profiles that have a usable HFD measurement.
function collectSized(stars: readonly AberrationStar[]): readonly AberrationStar[] {
	const output: AberrationStar[] = []

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		if (star.selected && star.profile.hfd !== undefined && Number.isFinite(star.profile.hfd) && !hasRejection(star, 'hfd')) output.push(star)
	}

	return output
}

// Collects selected profiles that have a usable axial orientation and elongation.
function collectOriented(stars: readonly AberrationStar[]): readonly AberrationStar[] {
	const output: AberrationStar[] = []

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		if (star.selected && star.profile.theta !== undefined && Number.isFinite(star.profile.theta) && star.profile.elongation !== undefined && Number.isFinite(star.profile.elongation) && !hasRejection(star, 'orientation')) output.push(star)
	}

	return output
}

// Builds a center-versus-edge HFD evidence finding when the peripheral field is materially broader.
function fieldDegradationFinding(stars: readonly AberrationStar[], quality: AberrationInspectionQuality, limitations: readonly AberrationLimitationCode[]): AberrationFinding | undefined {
	let centerSum = 0
	let centerCount = 0
	let edgeSum = 0
	let edgeCount = 0

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const hfd = star.profile.hfd!
		const radius = Math.hypot(star.u, star.v)
		if (radius <= 0.2) {
			centerSum += hfd
			centerCount++
		} else if (radius >= 0.45) {
			edgeSum += hfd
			edgeCount++
		}
	}

	if (centerCount === 0 || edgeCount === 0) return undefined

	const center = centerSum / centerCount
	const edge = edgeSum / edgeCount
	const ratio = edge / Math.max(center, Number.EPSILON)
	if (ratio < FIELD_DEGRADATION_RATIO) return undefined

	return {
		kind: 'fieldDegradation',
		likelihood: clamp((ratio - 1) / 0.3, 0, 1),
		confidence: quality.confidence,
		evidence: [
			{ code: 'edgeToCenterHFD', value: ratio, reference: FIELD_DEGRADATION_RATIO, confidence: quality.confidence },
			{ code: 'edgeSampleCount', value: edgeCount, confidence: 1 },
		],
		limitations,
	}
}

// Builds a one-frame scalar-size gradient finding from normalized sensor-coordinate correlations.
function focusGradientFinding(stars: readonly AberrationStar[], quality: AberrationInspectionQuality, limitations: readonly AberrationLimitationCode[]): AberrationFinding | undefined {
	const hfd = new Float64Array(stars.length)
	const u = new Float64Array(stars.length)
	const v = new Float64Array(stars.length)

	for (let i = 0; i < stars.length; i++) {
		hfd[i] = stars[i].profile.hfd!
		u[i] = stars[i].u
		v[i] = stars[i].v
	}

	const correlationU = correlation(hfd, u)
	const correlationV = correlation(hfd, v)
	const magnitude = Math.hypot(correlationU, correlationV) / Math.SQRT2
	if (magnitude < FOCUS_GRADIENT_CORRELATION) return undefined

	return {
		kind: 'singleFrameFocusGradient',
		likelihood: clamp((magnitude - FOCUS_GRADIENT_CORRELATION) / (1 - FOCUS_GRADIENT_CORRELATION), 0, 1),
		confidence: quality.confidence,
		evidence: [
			{ code: 'hfdCoordinateCorrelation', value: magnitude, reference: FOCUS_GRADIENT_CORRELATION, confidence: quality.confidence },
			{ code: 'hfdCorrelationU', value: correlationU, confidence: quality.confidence },
			{ code: 'hfdCorrelationV', value: correlationV, confidence: quality.confidence },
		],
		limitations,
	}
}

// Builds a uniform-direction elongation finding when orientation coherence and size stability agree.
function uniformElongationFinding(stars: readonly AberrationStar[], orientation: AxialSummary, quality: AberrationInspectionQuality, limitations: readonly AberrationLimitationCode[]): AberrationFinding | undefined {
	if (orientation.coherence < UNIFORM_COHERENCE) return undefined

	let minimum = Number.POSITIVE_INFINITY
	let maximum = 0
	let sum = 0
	let count = 0

	for (let i = 0; i < stars.length; i++) {
		if (hasRejection(stars[i], 'elongation')) continue
		const elongation = stars[i].profile.elongation!
		minimum = Math.min(minimum, elongation)
		maximum = Math.max(maximum, elongation)
		sum += elongation
		count++
	}

	if (count < MINIMUM_ORIENTATION_SAMPLES) return undefined
	const mean = sum / count
	const variation = (maximum - minimum) / Math.max(mean, Number.EPSILON)
	const stability = clamp(1 - variation, 0, 1)
	const score = orientation.coherence * stability
	if (score < UNIFORM_COHERENCE) return undefined

	return {
		kind: 'uniformElongation',
		likelihood: score,
		confidence: quality.confidence * orientation.coherence,
		evidence: [
			{ code: 'axialCoherence', value: orientation.coherence, reference: UNIFORM_COHERENCE, confidence: orientation.coherence },
			{ code: 'elongationVariation', value: variation, confidence: stability },
		],
		limitations,
	}
}

// Builds radial and tangential direction findings from axial angular distances to the sensor center.
function radialTangentialFindings(stars: readonly AberrationStar[], quality: AberrationInspectionQuality, limitations: readonly AberrationLimitationCode[]): readonly AberrationFinding[] {
	let radialScore = 0
	let tangentialScore = 0
	let count = 0

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const radius = Math.hypot(star.u, star.v)
		if (radius <= Number.EPSILON) continue

		const radial = Math.atan2(star.v, star.u)
		const delta = axialDistance(star.profile.theta!, radial)
		const normalized = (2 * delta) / PI
		radialScore += 1 - normalized
		tangentialScore += normalized
		count++
	}

	if (count === 0) return []

	const radial = radialScore / count
	const tangential = tangentialScore / count
	const findings: AberrationFinding[] = []

	if (radial >= DIRECTIONAL_ALIGNMENT) {
		findings.push({
			kind: 'radialElongation',
			likelihood: radial,
			confidence: quality.confidence,
			evidence: [{ code: 'radialAlignment', value: radial, reference: DIRECTIONAL_ALIGNMENT, confidence: quality.confidence }],
			limitations,
		})
	}

	if (tangential >= DIRECTIONAL_ALIGNMENT) {
		findings.push({
			kind: 'tangentialElongation',
			likelihood: tangential,
			confidence: quality.confidence,
			evidence: [{ code: 'tangentialAlignment', value: tangential, reference: DIRECTIONAL_ALIGNMENT, confidence: quality.confidence }],
			limitations,
		})
	}

	return findings
}

// Stores an axial mean and coherence from selected orientation samples.
interface AxialSummary {
	// Axial mean orientation in [0, PI).
	readonly theta: Angle
	// Coherence in 0..1.
	readonly coherence: number
}

// Computes a weighted axial mean and coherence from profile orientation angles.
function axialSummary(stars: readonly AberrationStar[]): AxialSummary {
	let cosine = 0
	let sine = 0
	let weightSum = 0

	for (let i = 0; i < stars.length; i++) {
		const weight = stars[i].weight
		const theta = stars[i].profile.theta!
		cosine += weight * Math.cos(2 * theta)
		sine += weight * Math.sin(2 * theta)
		weightSum += weight
	}

	let theta = 0.5 * Math.atan2(sine, cosine)
	if (theta < 0) theta += PI
	return { theta, coherence: weightSum > 0 ? Math.hypot(cosine, sine) / weightSum : 0 }
}

// Computes the shortest angular distance between axial directions in 0..PI/2 radians.
function axialDistance(a: Angle, b: Angle): number {
	let delta = Math.abs(a - b) % PI
	if (delta > PIOVERTWO) delta = PI - delta
	return delta
}

// Computes Pearson correlation for equal-length numeric arrays, returning zero for a degenerate axis.
function correlation(a: Readonly<Float64Array>, b: Readonly<Float64Array>): number {
	let sumA = 0
	let sumB = 0
	for (let i = 0; i < a.length; i++) {
		sumA += a[i]
		sumB += b[i]
	}

	const meanA = sumA / a.length
	const meanB = sumB / b.length
	let covariance = 0
	let varianceA = 0
	let varianceB = 0

	for (let i = 0; i < a.length; i++) {
		const da = a[i] - meanA
		const db = b[i] - meanB
		covariance += da * db
		varianceA += da * da
		varianceB += db * db
	}

	return varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : 0
}

// Builds the mandatory single-frame limitation list from inspection support metrics.
function inspectionLimitations(quality: AberrationInspectionQuality): AberrationLimitationCode[] {
	const limitations: AberrationLimitationCode[] = ['singleFrameOnly']
	if (quality.selectedStarCount < MINIMUM_SIZE_SAMPLES) limitations.push('insufficientStars')
	if (quality.occupiedRegionCount < 2) limitations.push('insufficientCoverage')
	return limitations
}

// Removes duplicated limitation codes while preserving first-seen order.
function uniqueLimitations(limitations: readonly AberrationLimitationCode[]): AberrationLimitationCode[] {
	return [...new Set(limitations)]
}

// Computes the fraction of regions that publish a scalar HFD summary.
function supportedRegionFraction(regions: readonly AberrationRegionResult[]): number {
	if (regions.length === 0) return 0

	let count = 0
	for (let i = 0; i < regions.length; i++) {
		if (regions[i].medianHFD !== undefined) count++
	}

	return count / regions.length
}

// Tests whether a profile has a metric-specific exclusion.
function hasRejection(star: AberrationStar, metric: 'hfd' | 'elongation' | 'orientation'): boolean {
	for (let i = 0; i < star.rejections.length; i++) {
		if (star.rejections[i].metric === metric) return true
	}

	return false
}
