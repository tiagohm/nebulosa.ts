import { PI, PIOVERTWO } from '../../../core/constants'
import type { Angle } from '../../../math/units/angle'
import { bahtinovAxialAngleDistance, canonicalizeBahtinovLine, clipBahtinovLineToArea } from './geometry'
import type { BahtinovRidgePoints, BahtinovWorkspace } from './types'

// Coarse-to-fine weighted Hough search for Bahtinov ridge points. Angles are axial radians in
// `[0, PI)`, distances use local ROI pixels, and the caller-owned workspace stores accumulators.

// Default maximum number of angular candidates retained after circular NMS.
const DEFAULT_MAXIMUM_CANDIDATES = 8
// Default minimum axial separation between retained candidate normals, in radians.
const DEFAULT_MINIMUM_AXIAL_SEPARATION = PI / 36
// Default half-range for local angular refinement, in radians.
const DEFAULT_REFINEMENT_RANGE = PI / 180
// Default local angular refinement step, in radians.
const DEFAULT_REFINEMENT_STEP = PI / 3600
// Distance from a Hough peak used to measure longitudinal support, in distance bins.
const SUPPORT_DISTANCE_BINS = 2

// One refined local normal-form line candidate and its support evidence.
export interface BahtinovHoughCandidate {
	// Refined canonical normal angle in `[0, PI)`, in radians.
	readonly normalAngle: Angle
	// Refined normal-form distance from the local ROI origin, in pixels.
	readonly distance: number
	// Weighted Hough peak score after coverage and balance penalties.
	readonly score: number
	// Fraction of the visible line segment spanned by supporting ridges, from 0 to 1.
	readonly coverage: number
	// Weaker-to-stronger support ratio around the segment midpoint, from 0 to 1.
	readonly balance: number
	// Sum of ridge weights close to the candidate line.
	readonly strength: number
}

// Search controls for coarse circular NMS and local angular refinement.
export interface BahtinovHoughOptions {
	// Maximum number of candidates returned.
	readonly maximumCandidates?: number
	// Minimum axial normal-angle separation between returned candidates, in radians.
	readonly minimumAxialSeparation?: Angle
	// Half-range of local normal-angle refinement in radians.
	readonly refinementRange?: Angle
	// Local normal-angle refinement step in radians.
	readonly refinementStep?: Angle
}

// Detects and refines weighted line candidates from local ROI ridge samples.
// `width` and `height` are ROI pixels. The ridge arrays and workspace remain caller-owned.
export function detectBahtinovHoughCandidates(ridgePoints: BahtinovRidgePoints, width: number, height: number, workspace: BahtinovWorkspace, options: BahtinovHoughOptions = {}): readonly BahtinovHoughCandidate[] {
	validateHoughInput(ridgePoints, width, height, workspace)
	const maximumCandidates = options.maximumCandidates ?? DEFAULT_MAXIMUM_CANDIDATES
	const minimumAxialSeparation = options.minimumAxialSeparation ?? DEFAULT_MINIMUM_AXIAL_SEPARATION
	const refinementRange = options.refinementRange ?? DEFAULT_REFINEMENT_RANGE
	const refinementStep = options.refinementStep ?? DEFAULT_REFINEMENT_STEP
	if (!Number.isInteger(maximumCandidates) || maximumCandidates < 3 || maximumCandidates > workspace.angleCount) throw new RangeError('maximumCandidates must be an integer from 3 to angleCount')
	if (!Number.isFinite(minimumAxialSeparation) || minimumAxialSeparation <= 0 || minimumAxialSeparation > PIOVERTWO) throw new RangeError('minimumAxialSeparation must be in (0, PI / 2]')
	if (!Number.isFinite(refinementRange) || refinementRange < 0 || refinementRange > minimumAxialSeparation * 0.5) throw new RangeError('refinementRange must be finite and no greater than half the candidate separation')
	if (!Number.isFinite(refinementStep) || refinementStep <= 0 || (refinementRange > 0 && refinementStep > refinementRange)) throw new RangeError('refinementStep must be finite, positive, and no greater than refinementRange')

	const angleCount = workspace.angleCount
	const binCount = workspace.distanceBinCount
	const accumulator = workspace.accumulator
	workspace.angleScore.fill(0)

	for (let angleIndex = 0; angleIndex < angleCount; angleIndex++) {
		const peak = accumulateHoughAngle(ridgePoints, workspace.angleCos[angleIndex], workspace.angleSin[angleIndex], workspace.rhoMax, workspace.distanceStep, accumulator, binCount)
		workspace.angleScore[angleIndex] = peak.score
		workspace.angleDistance[angleIndex] = peak.distance
	}

	const nmsRadius = Math.max(1, Math.ceil(minimumAxialSeparation / workspace.angleStep))
	const coarse: BahtinovHoughCandidate[] = []
	for (let angleIndex = 0; angleIndex < angleCount; angleIndex++) {
		const score = workspace.angleScore[angleIndex]
		if (!(score > 0) || !isCircularMaximum(workspace.angleScore, angleIndex, nmsRadius)) continue
		const normalAngle = angleIndex * workspace.angleStep
		const support = measureHoughSupport(ridgePoints, width, height, normalAngle, workspace.angleDistance[angleIndex], workspace.distanceStep)
		if (!(support.strength > 0)) continue
		insertCandidate(
			coarse,
			{
				normalAngle,
				distance: workspace.angleDistance[angleIndex],
				score: score * Math.sqrt(support.coverage * support.balance),
				coverage: support.coverage,
				balance: support.balance,
				strength: support.strength,
			},
			maximumCandidates,
		)
	}

	const refined: BahtinovHoughCandidate[] = []
	for (let index = 0; index < coarse.length; index++) {
		const next = refineCandidate(coarse[index], ridgePoints, width, height, workspace, refinementRange, refinementStep)
		if (!refined.some((candidate) => bahtinovAxialAngleDistance(candidate.normalAngle, next.normalAngle) < minimumAxialSeparation)) insertCandidate(refined, next, maximumCandidates)
	}
	return refined
}

// Accumulates interpolated normal-distance votes for one angle and returns its peak.
function accumulateHoughAngle(ridgePoints: BahtinovRidgePoints, normalX: number, normalY: number, rhoMax: number, distanceStep: number, accumulator: Float64Array, binCount: number): { readonly score: number; readonly distance: number } {
	accumulator.fill(0, 0, binCount)
	for (let index = 0; index < ridgePoints.count; index++) {
		const rho = ridgePoints.x[index] * normalX + ridgePoints.y[index] * normalY
		const position = (rho + rhoMax) / distanceStep
		const lower = Math.floor(position)
		if (lower < 0 || lower >= binCount) continue
		const fraction = position - lower
		const weight = ridgePoints.weight[index]
		accumulator[lower] += weight * (1 - fraction)
		if (lower + 1 < binCount) accumulator[lower + 1] += weight * fraction
	}

	let peakBin = 0
	let peakScore = accumulator[0]
	for (let bin = 1; bin < binCount; bin++) {
		const score = accumulator[bin]
		if (score > peakScore) {
			peakBin = bin
			peakScore = score
		}
	}

	let subBin = 0
	if (peakBin > 0 && peakBin + 1 < binCount) {
		const left = accumulator[peakBin - 1]
		const center = peakScore
		const right = accumulator[peakBin + 1]
		const denominator = left - 2 * center + right
		if (denominator < 0 && Number.isFinite(denominator)) subBin = Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator))
	}
	return { score: peakScore, distance: -rhoMax + (peakBin + subBin) * distanceStep }
}

// Tests circular angular non-maximum suppression with deterministic lower-index tie breaking.
function isCircularMaximum(scores: Float64Array, index: number, radius: number): boolean {
	const count = scores.length
	const score = scores[index]
	for (let delta = 1; delta <= radius; delta++) {
		const left = (index - delta + count) % count
		const right = (index + delta) % count
		if (scores[left] > score || scores[right] > score || (scores[left] === score && left < index) || (scores[right] === score && right < index)) return false
	}
	return true
}

// Measures longitudinal coverage, bilateral balance, and strength around one candidate line.
function measureHoughSupport(ridgePoints: BahtinovRidgePoints, width: number, height: number, normalAngle: Angle, distance: number, distanceStep: number): { readonly coverage: number; readonly balance: number; readonly strength: number } {
	const normalX = Math.cos(normalAngle)
	const normalY = Math.sin(normalAngle)
	const tangentX = -normalY
	const tangentY = normalX
	const segment = clipBahtinovLineToArea({ normalAngle, distance }, { left: 0, top: 0, right: width, bottom: height })
	if (!segment) return { coverage: 0, balance: 0, strength: 0 }
	const middleX = (segment[0].x + segment[1].x) * 0.5
	const middleY = (segment[0].y + segment[1].y) * 0.5
	const supportDistance = distanceStep * SUPPORT_DISTANCE_BINS
	let minimumTangent = Number.POSITIVE_INFINITY
	let maximumTangent = Number.NEGATIVE_INFINITY
	let negativeStrength = 0
	let positiveStrength = 0

	for (let index = 0; index < ridgePoints.count; index++) {
		const orthogonal = ridgePoints.x[index] * normalX + ridgePoints.y[index] * normalY - distance
		if (Math.abs(orthogonal) > supportDistance) continue
		const tangent = (ridgePoints.x[index] - middleX) * tangentX + (ridgePoints.y[index] - middleY) * tangentY
		minimumTangent = Math.min(minimumTangent, tangent)
		maximumTangent = Math.max(maximumTangent, tangent)
		if (tangent < 0) negativeStrength += ridgePoints.weight[index]
		else positiveStrength += ridgePoints.weight[index]
	}

	const strength = negativeStrength + positiveStrength
	if (!(strength > 0) || !Number.isFinite(minimumTangent) || !Number.isFinite(maximumTangent)) return { coverage: 0, balance: 0, strength: 0 }
	const segmentLength = Math.hypot(segment[1].x - segment[0].x, segment[1].y - segment[0].y)
	const coverage = segmentLength > 0 ? Math.min(1, Math.max(0, (maximumTangent - minimumTangent) / segmentLength)) : 0
	const stronger = Math.max(negativeStrength, positiveStrength)
	const balance = stronger > 0 ? Math.min(negativeStrength, positiveStrength) / stronger : 0
	return { coverage, balance, strength }
}

// Refines one coarse candidate by scanning a bounded local angle window.
function refineCandidate(candidate: BahtinovHoughCandidate, ridgePoints: BahtinovRidgePoints, width: number, height: number, workspace: BahtinovWorkspace, range: Angle, step: Angle): BahtinovHoughCandidate {
	if (range === 0) return candidate
	let best = candidate
	const sampleCount = Math.ceil((range * 2) / step)
	for (let sample = 0; sample <= sampleCount; sample++) {
		const angle = canonicalizeBahtinovLine(candidate.normalAngle - range + sample * step, 0).normalAngle
		const peak = accumulateHoughAngle(ridgePoints, Math.cos(angle), Math.sin(angle), workspace.rhoMax, workspace.distanceStep, workspace.accumulator, workspace.distanceBinCount)
		if (!(peak.score > 0)) continue
		const support = measureHoughSupport(ridgePoints, width, height, angle, peak.distance, workspace.distanceStep)
		const score = peak.score * Math.sqrt(support.coverage * support.balance)
		if (score > best.score) best = { normalAngle: angle, distance: peak.distance, score, coverage: support.coverage, balance: support.balance, strength: support.strength }
	}
	return best
}

// Inserts one candidate into a descending bounded score list.
function insertCandidate(candidates: BahtinovHoughCandidate[], candidate: BahtinovHoughCandidate, maximumCandidates: number): void {
	let index = 0
	while (index < candidates.length && candidates[index].score >= candidate.score) index++
	candidates.splice(index, 0, candidate)
	if (candidates.length > maximumCandidates) candidates.pop()
}

// Validates ridge-array counts, ROI geometry, and workspace Hough capacity.
function validateHoughInput(ridgePoints: BahtinovRidgePoints, width: number, height: number, workspace: BahtinovWorkspace): void {
	if (!Number.isInteger(width) || width <= 1 || !Number.isInteger(height) || height <= 1 || width > workspace.width || height > workspace.height) throw new RangeError('invalid ROI dimensions for Bahtinov Hough search')
	if (!Number.isInteger(ridgePoints.count) || ridgePoints.count < 3 || ridgePoints.count > workspace.maximumRidgePoints || ridgePoints.x.length < ridgePoints.count || ridgePoints.y.length < ridgePoints.count || ridgePoints.weight.length < ridgePoints.count) {
		throw new RangeError('invalid Bahtinov ridge-point arrays')
	}
	if (workspace.accumulator.length < workspace.distanceBinCount || workspace.angleScore.length < workspace.angleCount || workspace.angleDistance.length < workspace.angleCount) throw new RangeError('Bahtinov Hough workspace capacity is inconsistent')
}
