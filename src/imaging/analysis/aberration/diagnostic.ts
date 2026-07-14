import { PI, PIOVERTWO } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import type { FocusCurvatureAnalysis, FocusPlaneAnalysis, FocusSurfaceFitResult } from '../../../math/numerical/surface.fit'
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
	const planeUncertainty = linearEffectUncertainty(surface.coefficients.ax, surface.coefficients.ay, surface.covariance, columns)
	if (planeUncertainty !== undefined && plane.effect > 3 * planeUncertainty) {
		const significance = plane.effect / Math.max(planeUncertainty, Number.EPSILON)
		findings.push({
			kind: 'sensorTiltPattern',
			likelihood: clamp((significance - 3) / 7, 0, 1),
			confidence: surface.confidence,
			evidence: [
				{ code: 'planeEffect', value: plane.effect, reference: 3 * planeUncertainty, confidence: surface.confidence },
				{ code: 'planeSignificance', value: significance, reference: 3, confidence: surface.confidence },
			],
			limitations: ['missingPhysicalScale'],
		})
	}

	const curvatureUncertainty = quadraticEffectUncertainty(surface, columns)
	if (curvatureUncertainty !== undefined && curvature.effect > 3 * curvatureUncertainty) {
		const significance = curvature.effect / Math.max(curvatureUncertainty, Number.EPSILON)
		findings.push({ kind: 'fieldCurvature', likelihood: clamp((significance - 3) / 7, 0, 1), confidence: surface.confidence, evidence: [{ code: 'curvatureEffect', value: curvature.effect, reference: 3 * curvatureUncertainty, confidence: surface.confidence }], limitations: [] })
		if ((curvature.anisotropy ?? 0) >= 0.2)
			findings.push({ kind: 'astigmaticCurvature', likelihood: clamp(curvature.anisotropy ?? 0, 0, 1), confidence: surface.confidence, evidence: [{ code: 'curvatureAnisotropy', value: curvature.anisotropy ?? 0, reference: 0.2, confidence: surface.confidence }], limitations: [] })
	}

	if (backfocusCalibrated && fieldOffset !== undefined && curvatureUncertainty !== undefined && Math.abs(fieldOffset.centerToEdge) > 3 * curvatureUncertainty) {
		findings.push({
			kind: 'backfocusMismatch',
			likelihood: clamp(Math.abs(fieldOffset.centerToEdge) / Math.max(curvature.effect, Number.EPSILON), 0, 1),
			confidence: Math.min(surface.confidence, fieldOffset.confidence),
			evidence: [{ code: 'centerToEdgeFocus', value: fieldOffset.centerToEdge, reference: 3 * curvatureUncertainty, confidence: fieldOffset.confidence }],
			limitations: [],
		})
	}

	return findings.length > 0 ? findings : [{ kind: 'inconclusive', likelihood: 1, confidence: surface.confidence, evidence: [{ code: 'surfaceConditionNumber', value: surface.conditionNumber, confidence: surface.confidence }], limitations: [] }]
}

// Propagates the covariance of ax and ay to abs(ax) + abs(ay).
function linearEffectUncertainty(ax: number, ay: number, covariance: Float64Array, columns: number): number | undefined {
	if (covariance.length !== columns * columns) return undefined
	const signX = ax < 0 ? -1 : 1
	const signY = ay < 0 ? -1 : 1
	const variance = covariance[columns + 1] + covariance[2 * columns + 2] + 2 * signX * signY * covariance[columns + 2]
	return variance >= 0 && Number.isFinite(variance) ? Math.sqrt(variance) : undefined
}

// Estimates a conservative curvature-effect uncertainty from quadratic coefficient covariance.
function quadraticEffectUncertainty(surface: FocusSurfaceFitResult & { readonly success: true }, columns: number): number | undefined {
	const covariance = surface.covariance
	if (covariance === undefined || covariance.length !== columns * columns || surface.model === 'plane') return undefined
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
