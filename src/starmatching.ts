import { type Angle, normalizePI } from './angle'
import { euclideanSquaredDistance, type Point } from './geometry'
import { clamp } from './math'
import type { DetectedStar } from './stardetector'
import { medianAbsoluteDeviationOf, medianOf } from './util'
import { type Vec3, vecDistance } from './vec3'

// https://www.hnsky.org/astap_astrometric_solving.htm

// The solver uses deterministic local triangle patterns.
// Each triangle is canonically ordered by side-rank, then described with [shortest/longest, middle/longest, normalized area],
// with chirality kept separately for mirror detection.
// Matching is robust because it hashes descriptors into buckets, aggregates repeated star-pair evidence across pattern matches,
// scores whole-frame hypotheses, and then iteratively rematches/refits with outlier clipping.

// Similarity is the default because it captures the common stacking case without introducing shear overfit.
// Affine fallback is only accepted when it gives materially better RMS while keeping comparable support and plausible geometry.

// Performance-wise, it is bounded for the intended regime of tens to a few hundred stars:
// local neighborhoods limit pattern growth, descriptor lookup is bucketed, and hypothesis evaluation is capped by ransacIterations/maxHypotheses.
// Known limitation: the implementation is triangle-based only.

export type StarMatchingModel = 'similarity' | 'affine'

export type StarMatchingPatternType = 'triangle' | 'quad'

export interface SimilarityTransform {
	readonly a: number
	readonly b: number
	readonly tx: number
	readonly ty: number
	readonly mirrored: boolean
}

export interface AffineTransform {
	readonly m00: number
	readonly m01: number
	readonly tx: number
	readonly m10: number
	readonly m11: number
	readonly ty: number
}

export interface StarMatchingConfig {
	readonly maxStars?: number
	readonly minStars?: number
	// readonly patternType?: StarMatchingPatternType
	readonly allowMirror?: boolean
	readonly initialMatchRadius?: number // px
	readonly finalMatchRadius?: number // px
	readonly maxScaleRatio?: number
	readonly minScaleRatio?: number
	readonly maxRotation?: Angle | null
	readonly ransacIterations?: number
	readonly minInliers?: number
	readonly maxResidual?: number
	readonly useWeightedFit?: boolean
	readonly refineIterations?: number
	readonly descriptorTolerance?: number
	readonly localNeighborCount?: number
	readonly preferCompactPatterns?: boolean
	readonly modelPreference?: StarMatchingModel
	readonly allowAffineFallback?: boolean
	readonly dedupeDistance?: number // px
	readonly minPatternSide?: number // px
	readonly minPatternAreaRatio?: number
	readonly symmetricPatternTolerance?: number
	readonly maxPatternMatchesPerPattern?: number
	readonly maxHypotheses?: number
}

export interface StarMatch {
	readonly currentIndex: number
	readonly referenceIndex: number
	readonly residual: number
}

export interface StarMatchingResult {
	readonly success: boolean
	readonly model?: StarMatchingModel
	readonly similarity?: SimilarityTransform & {
		readonly scale: number
		readonly rotation: Angle
	}
	readonly affine?: AffineTransform
	readonly matches: readonly StarMatch[]
	readonly inlierCount: number
	readonly rmsError?: number // px
	readonly medianError?: number // px
	readonly score: number
	readonly failureReason?: string
}

export interface TrianglePattern {
	readonly starIndices: Vec3
	readonly descriptor: Vec3
	readonly chirality: 1 | -1
	readonly centroidX: number
	readonly centroidY: number
	readonly maxRadius: number
	readonly areaScore: number
	readonly compactness: number
	readonly qualityScore: number
}

interface RankedStar extends DetectedStar {
	readonly index: number
	readonly qualityScore: number
}

interface PatternMatchCandidate {
	readonly referencePatternIndex: number
	readonly currentPatternIndex: number
	readonly descriptorDistance: number
	readonly pairVoteScore: number
}

interface MatchPair {
	readonly currentStar: RankedStar
	readonly referenceStar: RankedStar
	readonly residual: number
	readonly weight: number
}

interface HypothesisScore {
	readonly model: StarMatchingModel
	readonly score: number
	readonly inlierCount: number
	readonly rmsError: number // px
	readonly medianError: number // px
	readonly spreadScore: number
	readonly similarity?: SimilarityTransform
	readonly affine?: AffineTransform
	readonly matches: readonly MatchPair[]
}

const DEFAULT_STAR_MATCHING_CONFIG: Required<StarMatchingConfig> = {
	maxStars: 96,
	minStars: 6,
	// patternType: 'triangle',
	allowMirror: true,
	initialMatchRadius: 10,
	finalMatchRadius: 2.5,
	maxScaleRatio: 1.2,
	minScaleRatio: 0.8,
	maxRotation: null,
	ransacIterations: 96,
	minInliers: 6,
	maxResidual: 3,
	useWeightedFit: true,
	refineIterations: 4,
	descriptorTolerance: 0.025,
	localNeighborCount: 7,
	preferCompactPatterns: true,
	modelPreference: 'similarity',
	allowAffineFallback: true,
	dedupeDistance: 2,
	minPatternSide: 6,
	minPatternAreaRatio: 0.015,
	symmetricPatternTolerance: 0.018,
	maxPatternMatchesPerPattern: 4,
	maxHypotheses: 128,
}

// Matches local geometric star patterns and solves a deterministic image registration transform.
export function matchStars(referenceStars: readonly DetectedStar[], currentStars: readonly DetectedStar[], config: StarMatchingConfig = DEFAULT_STAR_MATCHING_CONFIG): StarMatchingResult {
	const resolved = resolveConfig(config)
	const preparedReference = preprocessStars(referenceStars, resolved)
	const preparedCurrent = preprocessStars(currentStars, resolved)

	if (preparedReference.length < resolved.minStars) {
		return failureResult('too few usable reference stars')
	}

	if (preparedCurrent.length < resolved.minStars) {
		return failureResult('too few usable current stars')
	}

	const referencePatterns = buildTrianglePatternsFromRanked(preparedReference, resolved)
	const currentPatterns = buildTrianglePatternsFromRanked(preparedCurrent, resolved)

	if (referencePatterns.length < 2 || currentPatterns.length < 2) {
		return failureResult('too few stable local patterns')
	}

	const patternMatches = matchTrianglePatterns(referencePatterns, currentPatterns, resolved)

	if (patternMatches.length === 0) {
		return failureResult('no plausible pattern matches')
	}

	let best: HypothesisScore | undefined
	let secondBest: HypothesisScore | undefined
	const hypothesisLimit = Math.min(patternMatches.length, Math.min(resolved.maxHypotheses, resolved.ransacIterations))

	for (let i = 0; i < hypothesisLimit; i++) {
		const candidate = evaluatePatternMatch(referencePatterns, currentPatterns, preparedReference, preparedCurrent, patternMatches[i], resolved)
		if (candidate === undefined) continue

		if (best === undefined || compareHypotheses(candidate, best) < 0) {
			secondBest = best
			best = candidate
		} else if (secondBest === undefined || compareHypotheses(candidate, secondBest) < 0) {
			secondBest = candidate
		}
	}

	if (best === undefined) {
		return failureResult('no transform with enough inliers')
	}

	if (secondBest !== undefined && best.inlierCount === secondBest.inlierCount && Math.abs(best.score - secondBest.score) < 0.4 && transformSeparation(best, secondBest) > 1) {
		return failureResult('ambiguous multiple solutions')
	}

	const upgraded = maybeUpgradeToAffine(best, preparedReference, preparedCurrent, resolved)
	const chosen = upgraded ?? best
	if (chosen.inlierCount < resolved.minInliers) return failureResult('no transform with enough inliers')
	if (!Number.isFinite(chosen.rmsError) || chosen.rmsError > resolved.maxResidual * 1.6) return failureResult('residual too high')

	const { affine, similarity } = chosen

	return {
		success: true,
		model: chosen.model,
		similarity: similarity === undefined ? undefined : { ...similarity, scale: Math.hypot(similarity.a, similarity.b), rotation: Math.atan2(similarity.b, similarity.a) },
		affine,
		matches: materializeMatches(chosen.matches),
		inlierCount: chosen.inlierCount,
		rmsError: chosen.rmsError,
		medianError: chosen.medianError,
		score: chosen.score,
	}
}

// Applies similarity parameters to a single point.
export function applySimilarityTransformToPoint(x: number, y: number, transform: SimilarityTransform): Point {
	return transform.mirrored ? { x: transform.a * x + transform.b * y + transform.tx, y: transform.b * x - transform.a * y + transform.ty } : { x: transform.a * x - transform.b * y + transform.tx, y: transform.b * x + transform.a * y + transform.ty }
}

// Applies affine parameters to a single point.
export function applyAffineTransformToPoint(x: number, y: number, transform: AffineTransform): Point {
	return { x: transform.m00 * x + transform.m01 * y + transform.tx, y: transform.m10 * x + transform.m11 * y + transform.ty }
}

// Applies either similarity or affine parameters to a single point.
export function applyTransformToPoint(x: number, y: number, transform: SimilarityTransform | AffineTransform) {
	if ('mirrored' in transform) {
		return applySimilarityTransformToPoint(x, y, transform)
	} else {
		return applyAffineTransformToPoint(x, y, transform)
	}
}

// Applies a transform to all input stars while preserving their additional fields.
export function applyTransformToStars<T extends Point>(stars: readonly T[], transform: SimilarityTransform | AffineTransform): T[] {
	const out = new Array<T>(stars.length)

	if ('mirrored' in transform) {
		for (let i = 0; i < stars.length; i++) {
			const star = stars[i]
			const point = applySimilarityTransformToPoint(star.x, star.y, transform)
			out[i] = { ...star, x: point.x, y: point.y }
		}
	} else {
		for (let i = 0; i < stars.length; i++) {
			const star = stars[i]
			const point = applyAffineTransformToPoint(star.x, star.y, transform)
			out[i] = { ...star, x: point.x, y: point.y }
		}
	}

	return out
}

// Inverts similarity parameters when the transform is well-conditioned.
export function invertSimilarityTransform(transform: SimilarityTransform): SimilarityTransform | undefined {
	const scaleSq = transform.a * transform.a + transform.b * transform.b
	if (!(scaleSq > 0) || !Number.isFinite(scaleSq)) return undefined

	if (transform.mirrored) {
		const a = transform.a / scaleSq
		const b = transform.b / scaleSq
		const tx = -(a * transform.tx + b * transform.ty)
		const ty = -(b * transform.tx - a * transform.ty)
		return { a, b, tx, ty, mirrored: true }
	}

	const a = transform.a / scaleSq
	const b = -transform.b / scaleSq
	const tx = -(a * transform.tx - b * transform.ty)
	const ty = -(b * transform.tx + a * transform.ty)
	return { a, b, tx, ty, mirrored: false }
}

// Inverts affine parameters when the transform is well-conditioned.
export function invertAffineTransform(transform: AffineTransform): AffineTransform | undefined {
	const det = transform.m00 * transform.m11 - transform.m01 * transform.m10
	if (Math.abs(det) <= 1e-12 || !Number.isFinite(det)) return undefined
	const invDet = 1 / det
	const m00 = transform.m11 * invDet
	const m01 = -transform.m01 * invDet
	const m10 = -transform.m10 * invDet
	const m11 = transform.m00 * invDet
	const tx = -(m00 * transform.tx + m01 * transform.ty)
	const ty = -(m10 * transform.tx + m11 * transform.ty)
	return { m00, m01, tx, m10, m11, ty }
}

export function invertTransform<T extends SimilarityTransform | AffineTransform>(transform: T): T | undefined {
	return 'mirrored' in transform ? (invertSimilarityTransform(transform) as T) : (invertAffineTransform(transform) as T)
}

// Canonicalizes one triangle into a deterministic descriptor and vertex order.
export function canonicalTrianglePattern(points: readonly [Point, Point, Point], indices: Vec3, config: StarMatchingConfig = DEFAULT_STAR_MATCHING_CONFIG): TrianglePattern | undefined {
	return canonicalizeTriangle(points[0], points[1], points[2], indices[0], indices[1], indices[2], [1, 1, 1], resolveConfig(config))
}

// Fits a similarity transform with optional mirrored branch from matched point pairs.
export function fitSimilarityTransform(current: readonly Point[], reference: readonly Point[], mirrored: boolean = false, weights?: Readonly<ArrayLike<number>>): SimilarityTransform | undefined {
	if (current.length !== reference.length || current.length < 2) return undefined
	return fitSimilarityPoints(current, reference, mirrored, weights)
}

// Fits a centered affine least-squares transform from matched point pairs.
export function fitAffineTransform(current: readonly Point[], reference: readonly Point[], weights?: Readonly<ArrayLike<number>>): AffineTransform | undefined {
	if (current.length !== reference.length || current.length < 3) return undefined
	return fitAffinePoints(current, reference, weights)
}

// Builds deterministic local triangle descriptors from input stars.
export function buildTrianglePatterns(stars: readonly DetectedStar[], config: StarMatchingConfig = DEFAULT_STAR_MATCHING_CONFIG): TrianglePattern[] {
	const resolved = resolveConfig(config)
	const prepared = preprocessStars(stars, resolved)
	return buildTrianglePatternsFromRanked(prepared, resolved)
}

// Merges defaults with caller overrides while keeping deterministic limits.
function resolveConfig(config: StarMatchingConfig): Required<StarMatchingConfig> {
	return {
		...DEFAULT_STAR_MATCHING_CONFIG,
		...config,
		maxStars: Math.max(6, Math.trunc(config.maxStars ?? DEFAULT_STAR_MATCHING_CONFIG.maxStars)),
		minStars: Math.max(3, Math.trunc(config.minStars ?? DEFAULT_STAR_MATCHING_CONFIG.minStars)),
		localNeighborCount: Math.max(3, Math.trunc(config.localNeighborCount ?? DEFAULT_STAR_MATCHING_CONFIG.localNeighborCount)),
		ransacIterations: Math.max(8, Math.trunc(config.ransacIterations ?? DEFAULT_STAR_MATCHING_CONFIG.ransacIterations)),
		minInliers: Math.max(3, Math.trunc(config.minInliers ?? DEFAULT_STAR_MATCHING_CONFIG.minInliers)),
		refineIterations: Math.max(1, Math.trunc(config.refineIterations ?? DEFAULT_STAR_MATCHING_CONFIG.refineIterations)),
		maxPatternMatchesPerPattern: Math.max(1, Math.trunc(config.maxPatternMatchesPerPattern ?? DEFAULT_STAR_MATCHING_CONFIG.maxPatternMatchesPerPattern)),
		maxHypotheses: Math.max(8, Math.trunc(config.maxHypotheses ?? DEFAULT_STAR_MATCHING_CONFIG.maxHypotheses)),
	}
}

// Returns a clean failure payload for expected non-match scenarios.
function failureResult(failureReason: string): StarMatchingResult {
	return { success: false, matches: [], inlierCount: 0, score: 0, failureReason }
}

// Computes a stable star quality ranking and removes implausible duplicates.
function preprocessStars(stars: readonly DetectedStar[], config: Required<StarMatchingConfig>) {
	const ranked: RankedStar[] = []

	for (let i = 0; i < stars.length; i++) {
		const { x, y, hfd, snr, flux } = stars[i]
		if (hfd <= 0 || snr <= 0 || flux <= 0) continue
		const qualityScore = (Math.max(0.25, snr) * Math.sqrt(Math.max(1, flux))) / Math.max(0.25, hfd)
		ranked.push({ x, y, hfd, snr, flux, index: i, qualityScore })
	}

	ranked.sort(RankedStarComparator)

	const deduped: RankedStar[] = []
	const dedupeDistanceSq = config.dedupeDistance * config.dedupeDistance

	for (let i = 0; i < ranked.length && deduped.length < config.maxStars; i++) {
		const star = ranked[i]
		let duplicate = false

		for (let j = 0; j < deduped.length; j++) {
			const other = deduped[j]
			const dx = other.x - star.x
			const dy = other.y - star.y

			if (dx * dx + dy * dy <= dedupeDistanceSq) {
				duplicate = true
				break
			}
		}

		if (!duplicate) deduped.push(star)
	}

	return deduped
}

// Sorts stars by descending quality with deterministic geometric tie-breaks.
function RankedStarComparator(a: RankedStar, b: RankedStar) {
	if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore
	if (a.snr !== b.snr) return b.snr - a.snr
	if (a.flux !== b.flux) return b.flux - a.flux
	if (a.hfd !== b.hfd) return a.hfd - b.hfd
	if (a.x !== b.x) return a.x - b.x
	if (a.y !== b.y) return a.y - b.y
	return a.index - b.index
}

function TrianglePatternsFromRankedComparator(a: TrianglePattern, b: TrianglePattern) {
	if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore
	if (a.compactness !== b.compactness) return b.compactness - a.compactness
	if (a.areaScore !== b.areaScore) return b.areaScore - a.areaScore
	if (a.starIndices[0] !== b.starIndices[0]) return a.starIndices[0] - b.starIndices[0]
	if (a.starIndices[1] !== b.starIndices[1]) return a.starIndices[1] - b.starIndices[1]
	return a.starIndices[2] - b.starIndices[2]
}

// Builds compact local triangles from nearby stars and rejects unstable geometry.
function buildTrianglePatternsFromRanked(stars: readonly RankedStar[], config: ReturnType<typeof resolveConfig>) {
	const patterns: TrianglePattern[] = []
	const unique = new Set<string>()
	const neighborCount = Math.min(config.localNeighborCount, Math.max(0, stars.length - 1))

	for (let anchorIndex = 0; anchorIndex < stars.length; anchorIndex++) {
		const neighbors = collectNearestNeighbors(stars, anchorIndex, neighborCount)

		for (let i = 0; i < neighbors.length - 1; i++) {
			const firstIndex = neighbors[i]
			for (let j = i + 1; j < neighbors.length; j++) {
				const secondIndex = neighbors[j]
				const key = triangleKey(anchorIndex, firstIndex, secondIndex)
				if (unique.has(key)) continue
				unique.add(key)

				const anchor = stars[anchorIndex]
				const first = stars[firstIndex]
				const second = stars[secondIndex]
				const pattern = canonicalizeTriangle(anchor, first, second, anchorIndex, firstIndex, secondIndex, [anchor.qualityScore, first.qualityScore, second.qualityScore], config)
				if (pattern !== undefined) patterns.push(pattern)
			}
		}
	}

	patterns.sort(TrianglePatternsFromRankedComparator)

	return patterns
}

function NearestNeighborDistanceComparator<T extends { index: number; distanceSq: number }>(a: T, b: T) {
	if (a.distanceSq !== b.distanceSq) return a.distanceSq - b.distanceSq
	return a.index - b.index
}

// Collects deterministic nearest neighbors for one anchor.
function collectNearestNeighbors(stars: readonly RankedStar[], anchorIndex: number, count: number) {
	const distances = new Array<{ index: number; distanceSq: number }>(Math.max(0, stars.length - 1))
	const anchor = stars[anchorIndex]
	let used = 0

	for (let i = 0; i < stars.length; i++) {
		if (i === anchorIndex) continue
		const star = stars[i]
		const dx = star.x - anchor.x
		const dy = star.y - anchor.y
		distances[used++] = { index: i, distanceSq: dx * dx + dy * dy }
	}

	distances.length = used
	distances.sort(NearestNeighborDistanceComparator)

	const out = new Array<number>(Math.min(count, distances.length))
	for (let i = 0; i < out.length; i++) out[i] = distances[i].index
	return out
}

// Creates an order-independent key for duplicate triangle suppression.
function triangleKey(a: number, b: number, c: number) {
	let x = a
	let y = b
	let z = c
	if (x > y) [x, y] = [y, x]
	if (y > z) [y, z] = [z, y]
	if (x > y) [x, y] = [y, x]
	return `${x}|${y}|${z}`
}

function SideLengthComparator<T extends { length: number }>(u: T, v: T) {
	return u.length - v.length
}

// Canonicalizes triangle vertices by side-rank so descriptor ordering is deterministic.
function canonicalizeTriangle(a: Point, b: Point, c: Point, ia: number, ib: number, ic: number, quality: Vec3, config: ReturnType<typeof resolveConfig>): TrianglePattern | undefined {
	const dABSq = euclideanSquaredDistance(a, b)
	const dACSq = euclideanSquaredDistance(a, c)
	const dBCSq = euclideanSquaredDistance(b, c)
	if (!(dABSq > 0) || !(dACSq > 0) || !(dBCSq > 0)) return undefined

	const sideLengths = [
		{ length: Math.sqrt(dABSq), opposite: 2 },
		{ length: Math.sqrt(dACSq), opposite: 1 },
		{ length: Math.sqrt(dBCSq), opposite: 0 },
	]

	sideLengths.sort(SideLengthComparator)

	const shortest = sideLengths[0].length
	const middle = sideLengths[1].length
	const longest = sideLengths[2].length

	if (longest < config.minPatternSide) return undefined
	if ((middle - shortest) / longest < config.symmetricPatternTolerance) return undefined
	if ((longest - middle) / longest < config.symmetricPatternTolerance) return undefined

	const vertices = [a, b, c]
	const indices = [ia, ib, ic]
	const weights = [quality[0], quality[1], quality[2]]
	const order = [sideLengths[2].opposite, sideLengths[1].opposite, sideLengths[0].opposite] as const
	const p0 = vertices[order[0]]
	const p1 = vertices[order[1]]
	const p2 = vertices[order[2]]
	const i0 = indices[order[0]]
	const i1 = indices[order[1]]
	const i2 = indices[order[2]]
	const w0 = weights[order[0]]
	const w1 = weights[order[1]]
	const w2 = weights[order[2]]

	const dx01 = p1.x - p0.x
	const dy01 = p1.y - p0.y
	const dx02 = p2.x - p0.x
	const dy02 = p2.y - p0.y
	const twiceArea = dx01 * dy02 - dy01 * dx02
	const areaScore = Math.abs(twiceArea) / (longest * longest)
	if (areaScore < config.minPatternAreaRatio) return undefined

	const centroidX = (p0.x + p1.x + p2.x) / 3
	const centroidY = (p0.y + p1.y + p2.y) / 3
	let maxRadius = Math.hypot(p0.x - centroidX, p0.y - centroidY)
	maxRadius = Math.max(maxRadius, Math.hypot(p1.x - centroidX, p1.y - centroidY))
	maxRadius = Math.max(maxRadius, Math.hypot(p2.x - centroidX, p2.y - centroidY))
	const compactness = config.preferCompactPatterns ? 1 / (1 + maxRadius) : 1
	return { starIndices: [i0, i1, i2], descriptor: [shortest / longest, middle / longest, areaScore], chirality: twiceArea >= 0 ? 1 : -1, centroidX, centroidY, maxRadius, areaScore, compactness, qualityScore: (w0 + w1 + w2) * compactness * (1 + areaScore) }
}

function PatternMatchCandidateComparator(a: PatternMatchCandidate, b: PatternMatchCandidate) {
	if (a.descriptorDistance !== b.descriptorDistance) return a.descriptorDistance - b.descriptorDistance
	if (a.referencePatternIndex !== b.referencePatternIndex) return a.referencePatternIndex - b.referencePatternIndex
	return a.currentPatternIndex - b.currentPatternIndex
}

function PatternMatchCandidateRescoredComparator(a: PatternMatchCandidate, b: PatternMatchCandidate) {
	if (a.pairVoteScore !== b.pairVoteScore) return b.pairVoteScore - a.pairVoteScore
	if (a.descriptorDistance !== b.descriptorDistance) return a.descriptorDistance - b.descriptorDistance
	if (a.referencePatternIndex !== b.referencePatternIndex) return a.referencePatternIndex - b.referencePatternIndex
	return a.currentPatternIndex - b.currentPatternIndex
}

// Matches local descriptors through quantized buckets plus bounded neighbor search.
function matchTrianglePatterns(referencePatterns: readonly TrianglePattern[], currentPatterns: readonly TrianglePattern[], config: ReturnType<typeof resolveConfig>) {
	const buckets = new Map<string, number[]>()
	const quant = 1 / config.descriptorTolerance

	for (let i = 0; i < referencePatterns.length; i++) {
		const key = descriptorKey(referencePatterns[i].descriptor, quant)
		const bucket = buckets.get(key)
		if (bucket === undefined) buckets.set(key, [i])
		else bucket.push(i)
	}

	const rawMatches: PatternMatchCandidate[] = []
	const pairVotes = new Map<string, number>()

	for (let currentIndex = 0; currentIndex < currentPatterns.length; currentIndex++) {
		const currentPattern = currentPatterns[currentIndex]
		const cells = neighboringDescriptorKeys(currentPattern.descriptor, quant)
		const candidates: PatternMatchCandidate[] = []

		for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
			const bucket = buckets.get(cells[cellIndex])
			if (bucket === undefined) continue

			for (let j = 0; j < bucket.length; j++) {
				const referenceIndex = bucket[j]
				const descriptorDistance = vecDistance(referencePatterns[referenceIndex].descriptor, currentPattern.descriptor)
				if (descriptorDistance > config.descriptorTolerance) continue
				candidates.push({ referencePatternIndex: referenceIndex, currentPatternIndex: currentIndex, descriptorDistance, pairVoteScore: 0 })
			}
		}

		candidates.sort(PatternMatchCandidateComparator)

		if (candidates.length === 0 || candidates.length > config.maxPatternMatchesPerPattern * 4) continue
		const kept = Math.min(config.maxPatternMatchesPerPattern, candidates.length)

		for (let j = 0; j < kept; j++) {
			const candidate = candidates[j]
			rawMatches.push(candidate)
			const currentIndices = currentPatterns[candidate.currentPatternIndex].starIndices
			const referenceIndices = referencePatterns[candidate.referencePatternIndex].starIndices

			for (let k = 0; k < 3; k++) {
				const key = `${currentIndices[k]}|${referenceIndices[k]}`
				pairVotes.set(key, (pairVotes.get(key) ?? 0) + 1)
			}
		}
	}

	const rescored = new Array<PatternMatchCandidate>(rawMatches.length)

	for (let i = 0; i < rawMatches.length; i++) {
		const candidate = rawMatches[i]
		const currentIndices = currentPatterns[candidate.currentPatternIndex].starIndices
		const referenceIndices = referencePatterns[candidate.referencePatternIndex].starIndices
		let pairVoteScore = 0
		for (let k = 0; k < 3; k++) pairVoteScore += pairVotes.get(`${currentIndices[k]}|${referenceIndices[k]}`) ?? 0
		rescored[i] = { ...candidate, pairVoteScore }
	}

	rescored.sort(PatternMatchCandidateRescoredComparator)

	return rescored
}

// Quantizes a triangle descriptor into a stable bucket key.
function descriptorKey(descriptor: Vec3, quant: number) {
	return `${Math.round(descriptor[0] * quant)}|${Math.round(descriptor[1] * quant)}|${Math.round(descriptor[2] * quant)}`
}

// Enumerates the 3x3x3 local bucket neighborhood for tolerant descriptor matching.
function neighboringDescriptorKeys(descriptor: Vec3, quant: number) {
	const q0 = Math.round(descriptor[0] * quant)
	const q1 = Math.round(descriptor[1] * quant)
	const q2 = Math.round(descriptor[2] * quant)
	const keys = new Array<string>(27)
	let used = 0

	for (let dz = -1; dz <= 1; dz++) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				keys[used++] = `${q0 + dx}|${q1 + dy}|${q2 + dz}`
			}
		}
	}

	return keys
}

// Evaluates one pattern correspondence by global support and iterative refinement.
function evaluatePatternMatch(referencePatterns: readonly TrianglePattern[], currentPatterns: readonly TrianglePattern[], referenceStars: readonly RankedStar[], currentStars: readonly RankedStar[], candidate: PatternMatchCandidate, config: ReturnType<typeof resolveConfig>): HypothesisScore | undefined {
	const referencePattern = referencePatterns[candidate.referencePatternIndex]
	const currentPattern = currentPatterns[candidate.currentPatternIndex]
	const currentPoints = [currentStars[currentPattern.starIndices[0]], currentStars[currentPattern.starIndices[1]], currentStars[currentPattern.starIndices[2]]]
	const referencePoints = [referenceStars[referencePattern.starIndices[0]], referenceStars[referencePattern.starIndices[1]], referenceStars[referencePattern.starIndices[2]]]

	const mirroredPreference = referencePattern.chirality !== currentPattern.chirality
	const branches = config.allowMirror ? [mirroredPreference, !mirroredPreference] : [false]
	let best: HypothesisScore | undefined

	for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
		const initial = fitSimilarityPoints(currentPoints, referencePoints, branches[branchIndex])
		if (initial === undefined) continue
		if (!transformPlausible(initial, config)) continue
		const refined = refineSimilarityHypothesis(initial, referenceStars, currentStars, config)
		if (refined === undefined) continue
		if (best === undefined || compareHypotheses(refined, best) < 0) best = refined
	}

	return best
}

// Iteratively rematches and refits a similarity transform with shrinking radii.
function refineSimilarityHypothesis(transform: SimilarityTransform, referenceStars: readonly RankedStar[], currentStars: readonly RankedStar[], config: ReturnType<typeof resolveConfig>): HypothesisScore | undefined {
	let currentTransform = transform
	let radius = config.initialMatchRadius
	let best: HypothesisScore | undefined

	for (let iteration = 0; iteration < config.refineIterations; iteration++) {
		const pairs = matchStarsByTransform(referenceStars, currentStars, currentTransform, radius, config.useWeightedFit)
		if (pairs.length < config.minInliers) return best
		const clipped = clipPairsByResidual(pairs, radius, config.maxResidual)
		if (clipped.length < config.minInliers) return best

		const fit = fitSimilarityFromPairs(clipped, currentTransform.mirrored)
		if (fit === undefined || !transformPlausible(fit, config)) return best
		currentTransform = fit
		radius = interpolateRadius(config.initialMatchRadius, config.finalMatchRadius, iteration + 1, config.refineIterations)

		const metrics = hypothesisMetrics(currentTransform, clipped, referenceStars)
		if (best === undefined || compareHypotheses(metrics, best) < 0) best = metrics
	}

	return best
}

function CandidateStarsByTransformComparator<T extends { currentIndex: number; referenceIndex: number; residualSq: number }>(a: T, b: T) {
	if (a.residualSq !== b.residualSq) return a.residualSq - b.residualSq
	if (a.currentIndex !== b.currentIndex) return a.currentIndex - b.currentIndex
	return a.referenceIndex - b.referenceIndex
}

// Matches transformed current stars to reference stars using deterministic one-to-one greedy assignment.
function matchStarsByTransform(referenceStars: readonly RankedStar[], currentStars: readonly RankedStar[], transform: SimilarityTransform | AffineTransform, radius: number, weighted: boolean) {
	const radiusSq = radius * radius
	const candidates: { currentIndex: number; referenceIndex: number; residualSq: number; weight: number }[] = []
	let used = 0

	for (let currentIndex = 0; currentIndex < currentStars.length; currentIndex++) {
		const current = currentStars[currentIndex]
		const projected = applyTransformToPoint(current.x, current.y, transform)

		for (let referenceIndex = 0; referenceIndex < referenceStars.length; referenceIndex++) {
			const reference = referenceStars[referenceIndex]
			const dx = projected.x - reference.x
			const dy = projected.y - reference.y
			const residualSq = dx * dx + dy * dy
			if (residualSq > radiusSq) continue
			const weight = weighted ? Math.sqrt(current.qualityScore * reference.qualityScore) : 1
			candidates[used++] = { currentIndex, referenceIndex, residualSq, weight }
		}
	}

	candidates.length = used
	candidates.sort(CandidateStarsByTransformComparator)

	const takenCurrent = new Uint8Array(currentStars.length)
	const takenReference = new Uint8Array(referenceStars.length)
	const matches: MatchPair[] = []

	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i]
		if (takenCurrent[candidate.currentIndex] === 1 || takenReference[candidate.referenceIndex] === 1) continue
		takenCurrent[candidate.currentIndex] = 1
		takenReference[candidate.referenceIndex] = 1
		matches.push({ currentStar: currentStars[candidate.currentIndex], referenceStar: referenceStars[candidate.referenceIndex], residual: Math.sqrt(candidate.residualSq), weight: candidate.weight })
	}

	return matches
}

// Rejects large residual outliers using a deterministic MAD-informed threshold.
function clipPairsByResidual(pairs: readonly MatchPair[], radius: number, maxResidual: number) {
	if (pairs.length <= 3) return [...pairs]
	const residuals = new Float64Array(pairs.length)
	for (let i = 0; i < pairs.length; i++) residuals[i] = pairs[i].residual
	const median = medianOf(residuals.sort())
	const mad = medianAbsoluteDeviationOf(residuals, median, true)
	const sigma = mad > 0 ? mad : radius * 0.25
	const threshold = Math.min(radius, maxResidual, Math.max(median + 3 * sigma, maxResidual * 0.4))
	const clipped: MatchPair[] = []
	for (let i = 0; i < pairs.length; i++) if (pairs[i].residual <= threshold) clipped.push(pairs[i])
	return clipped
}

// Computes comparable hypothesis metrics from final inlier pairs.
function hypothesisMetrics(transform: SimilarityTransform | AffineTransform, pairs: readonly MatchPair[], referenceStars: readonly RankedStar[]): HypothesisScore {
	const residuals = new Float64Array(pairs.length)
	const normalizedPairs = new Array<MatchPair>(pairs.length)
	let sumSq = 0

	for (let i = 0; i < pairs.length; i++) {
		const pair = pairs[i]
		const projected = applyTransformToPoint(pair.currentStar.x, pair.currentStar.y, transform)
		const residual = Math.hypot(projected.x - pair.referenceStar.x, projected.y - pair.referenceStar.y)
		residuals[i] = residual
		sumSq += residual * residual
		normalizedPairs[i] = { ...pair, residual: residual }
	}

	const rmsError = Math.sqrt(sumSq / pairs.length)
	const medianError = medianOf(residuals.sort())
	const spreadScore = inlierSpreadScore(pairs, referenceStars)
	const inlierRatio = pairs.length / Math.max(1, referenceStars.length)
	const score = pairs.length * 12 + spreadScore * 20 + inlierRatio * 10 - rmsError * 5 - medianError * 3

	return 'mirrored' in transform ? { model: 'similarity', score, inlierCount: pairs.length, rmsError, medianError, spreadScore, similarity: transform, matches: normalizedPairs } : { model: 'affine', score, inlierCount: pairs.length, rmsError, medianError, spreadScore, affine: transform, matches: normalizedPairs }
}

// Computes the spatial spread of inliers so tiny clusters do not dominate selection.
function inlierSpreadScore(pairs: readonly MatchPair[], referenceStars: readonly RankedStar[]) {
	if (pairs.length < 2 || referenceStars.length < 2) return 0
	let refMinX = Infinity
	let refMinY = Infinity
	let refMaxX = -Infinity
	let refMaxY = -Infinity

	for (let i = 0; i < referenceStars.length; i++) {
		const star = referenceStars[i]
		if (star.x < refMinX) refMinX = star.x
		if (star.y < refMinY) refMinY = star.y
		if (star.x > refMaxX) refMaxX = star.x
		if (star.y > refMaxY) refMaxY = star.y
	}

	let inlierMinX = Infinity
	let inlierMinY = Infinity
	let inlierMaxX = -Infinity
	let inlierMaxY = -Infinity

	for (let i = 0; i < pairs.length; i++) {
		const star = pairs[i].referenceStar
		if (star.x < inlierMinX) inlierMinX = star.x
		if (star.y < inlierMinY) inlierMinY = star.y
		if (star.x > inlierMaxX) inlierMaxX = star.x
		if (star.y > inlierMaxY) inlierMaxY = star.y
	}

	const totalArea = Math.max(1, (refMaxX - refMinX) * (refMaxY - refMinY))
	const inlierArea = Math.max(0, (inlierMaxX - inlierMinX) * (inlierMaxY - inlierMinY))
	return clamp(inlierArea / totalArea, 0, 1)
}

// Fits similarity from matched star pairs.
function fitSimilarityFromPairs(pairs: readonly MatchPair[], mirrored: boolean) {
	const current = new Array<Point>(pairs.length)
	const reference = new Array<Point>(pairs.length)
	const weights = new Float64Array(pairs.length)

	for (let i = 0; i < pairs.length; i++) {
		current[i] = pairs[i].currentStar
		reference[i] = pairs[i].referenceStar
		weights[i] = pairs[i].weight
	}

	return fitSimilarityPoints(current, reference, mirrored, weights)
}

// Solves a weighted centered similarity least-squares problem.
function fitSimilarityPoints(current: readonly Point[], reference: readonly Point[], mirrored: boolean, weights?: Readonly<ArrayLike<number>>) {
	let weightSum = 0
	let currentMeanX = 0
	let currentMeanY = 0
	let referenceMeanX = 0
	let referenceMeanY = 0

	for (let i = 0; i < current.length; i++) {
		const weight = weights?.[i] ?? 1
		weightSum += weight
		currentMeanX += current[i].x * weight
		currentMeanY += current[i].y * weight
		referenceMeanX += reference[i].x * weight
		referenceMeanY += reference[i].y * weight
	}

	if (!(weightSum > 0)) return undefined
	currentMeanX /= weightSum
	currentMeanY /= weightSum
	referenceMeanX /= weightSum
	referenceMeanY /= weightSum

	let denom = 0
	let numA = 0
	let numB = 0

	for (let i = 0; i < current.length; i++) {
		const weight = weights?.[i] ?? 1
		const x = current[i].x - currentMeanX
		const y = current[i].y - currentMeanY
		const rx = reference[i].x - referenceMeanX
		const ry = reference[i].y - referenceMeanY
		denom += weight * (x * x + y * y)

		if (mirrored) {
			numA += weight * (x * rx - y * ry)
			numB += weight * (y * rx + x * ry)
		} else {
			numA += weight * (x * rx + y * ry)
			numB += weight * (x * ry - y * rx)
		}
	}

	if (!(denom > 0) || !Number.isFinite(denom)) return undefined
	const a = numA / denom
	const b = numB / denom
	if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined

	const m00 = a
	const m01 = mirrored ? b : -b
	const m10 = b
	const m11 = mirrored ? -a : a
	const tx = referenceMeanX - (m00 * currentMeanX + m01 * currentMeanY)
	const ty = referenceMeanY - (m10 * currentMeanX + m11 * currentMeanY)
	if (!Number.isFinite(tx) || !Number.isFinite(ty)) return undefined
	return { a, b, tx, ty, mirrored }
}

// Solves a weighted centered affine least-squares problem.
function fitAffinePoints(current: readonly Point[], reference: readonly Point[], weights?: Readonly<ArrayLike<number>>) {
	let weightSum = 0
	let currentMeanX = 0
	let currentMeanY = 0
	let referenceMeanX = 0
	let referenceMeanY = 0

	for (let i = 0; i < current.length; i++) {
		const weight = weights?.[i] ?? 1
		weightSum += weight
		currentMeanX += current[i].x * weight
		currentMeanY += current[i].y * weight
		referenceMeanX += reference[i].x * weight
		referenceMeanY += reference[i].y * weight
	}

	if (!(weightSum > 0)) return undefined
	currentMeanX /= weightSum
	currentMeanY /= weightSum
	referenceMeanX /= weightSum
	referenceMeanY /= weightSum

	let sxx = 0
	let sxy = 0
	let syy = 0
	let rxx = 0
	let rxy = 0
	let ryx = 0
	let ryy = 0

	for (let i = 0; i < current.length; i++) {
		const weight = weights?.[i] ?? 1
		const x = current[i].x - currentMeanX
		const y = current[i].y - currentMeanY
		const rx = reference[i].x - referenceMeanX
		const ry = reference[i].y - referenceMeanY
		sxx += weight * x * x
		sxy += weight * x * y
		syy += weight * y * y
		rxx += weight * rx * x
		rxy += weight * rx * y
		ryx += weight * ry * x
		ryy += weight * ry * y
	}

	const det = sxx * syy - sxy * sxy
	if (Math.abs(det) <= 1e-12 || !Number.isFinite(det)) return undefined
	const invDet = 1 / det
	const m00 = (rxx * syy - rxy * sxy) * invDet
	const m01 = (rxy * sxx - rxx * sxy) * invDet
	const m10 = (ryx * syy - ryy * sxy) * invDet
	const m11 = (ryy * sxx - ryx * sxy) * invDet
	const tx = referenceMeanX - (m00 * currentMeanX + m01 * currentMeanY)
	const ty = referenceMeanY - (m10 * currentMeanX + m11 * currentMeanY)
	if (!Number.isFinite(tx) || !Number.isFinite(ty)) return undefined
	return { m00, m01, tx, m10, m11, ty }
}

// Keeps transforms within plausible scale and optional rotation limits.
function transformPlausible(transform: SimilarityTransform, config: ReturnType<typeof resolveConfig>) {
	const scale = Math.hypot(transform.a, transform.b)
	if (!Number.isFinite(scale) || scale < config.minScaleRatio || scale > config.maxScaleRatio) return false
	const maxRotation = config.maxRotation ?? null

	if (maxRotation !== null) {
		const rotation = normalizePI(Math.atan2(transform.b, transform.a))
		if (Math.abs(rotation) > maxRotation) return false
	}

	return true
}

// Interpolates the shrinking refinement radius.
function interpolateRadius(start: number, end: number, step: number, steps: number) {
	if (steps <= 1) return end
	const t = clamp(step / (steps - 1), 0, 1)
	return start + (end - start) * t
}

// Tries an affine refit only when it materially improves the similarity solution.
function maybeUpgradeToAffine(best: HypothesisScore, referenceStars: readonly RankedStar[], currentStars: readonly RankedStar[], config: ReturnType<typeof resolveConfig>) {
	if (!config.allowAffineFallback || best.matches.length < 3 || best.model === 'affine') return undefined
	const candidate = refineAffineFromPairs(best.matches, referenceStars, currentStars, config)
	if (candidate === undefined) return undefined
	const improvement = best.rmsError - candidate.rmsError
	const ratio = candidate.rmsError / Math.max(1e-9, best.rmsError)
	if (candidate.inlierCount + 1 < best.inlierCount) return undefined
	if (candidate.spreadScore + 0.05 < best.spreadScore) return undefined
	if (config.modelPreference !== 'affine' && improvement < 0.2 && ratio > 0.82) return undefined
	return candidate
}

// Refines affine parameters from an existing matched star set and re-matches globally.
function refineAffineFromPairs(seedPairs: readonly MatchPair[], referenceStars: readonly RankedStar[], currentStars: readonly RankedStar[], config: ReturnType<typeof resolveConfig>) {
	const current = new Array<Point>(seedPairs.length)
	const reference = new Array<Point>(seedPairs.length)
	const weights = new Float64Array(seedPairs.length)

	for (let i = 0; i < seedPairs.length; i++) {
		current[i] = seedPairs[i].currentStar
		reference[i] = seedPairs[i].referenceStar
		weights[i] = seedPairs[i].weight
	}

	let transform = fitAffinePoints(current, reference, weights)
	if (transform === undefined || !affinePlausible(transform, config)) return undefined
	let radius = Math.max(config.finalMatchRadius, config.initialMatchRadius * 0.7)
	let best: HypothesisScore | undefined

	for (let iteration = 0; iteration < config.refineIterations; iteration++) {
		const pairs = matchStarsByTransform(referenceStars, currentStars, transform, radius, config.useWeightedFit)
		if (pairs.length < config.minInliers) return best
		const clipped = clipPairsByResidual(pairs, radius, config.maxResidual)
		if (clipped.length < config.minInliers) return best

		current.length = clipped.length
		reference.length = clipped.length

		for (let i = 0; i < clipped.length; i++) {
			current[i] = clipped[i].currentStar
			reference[i] = clipped[i].referenceStar
			weights[i] = clipped[i].weight
		}

		const refit = fitAffinePoints(current, reference, weights)
		if (refit === undefined || !affinePlausible(refit, config)) return best
		transform = refit
		radius = interpolateRadius(radius, config.finalMatchRadius, iteration + 1, config.refineIterations)
		const metrics = hypothesisMetrics(transform, clipped, referenceStars)
		if (best === undefined || compareHypotheses(metrics, best) < 0) best = metrics
	}

	return best
}

// Rejects extreme affine shear or singular transforms.
function affinePlausible(transform: AffineTransform, config: ReturnType<typeof resolveConfig>) {
	const det = transform.m00 * transform.m11 - transform.m01 * transform.m10
	if (!Number.isFinite(det) || Math.abs(det) <= 1e-8) return false
	const scaleX = Math.hypot(transform.m00, transform.m10)
	const scaleY = Math.hypot(transform.m01, transform.m11)
	if (scaleX < config.minScaleRatio * 0.7 || scaleX > config.maxScaleRatio * 1.5) return false
	if (scaleY < config.minScaleRatio * 0.7 || scaleY > config.maxScaleRatio * 1.5) return false
	const shear = Math.abs(transform.m00 * transform.m01 + transform.m10 * transform.m11) / Math.max(1e-9, scaleX * scaleY)
	return shear < 0.45
}

function StarMatchComparator(a: StarMatch, b: StarMatch) {
	if (a.currentIndex !== b.currentIndex) return a.currentIndex - b.currentIndex
	return a.referenceIndex - b.referenceIndex
}

// Converts internal matches back to original caller star indices.
function materializeMatches(pairs: readonly MatchPair[]) {
	const matches = new Array<StarMatch>(pairs.length)
	for (let i = 0; i < pairs.length; i++) {
		const pair = pairs[i]
		matches[i] = {
			currentIndex: pair.currentStar.index,
			referenceIndex: pair.referenceStar.index,
			residual: pair.residual,
		}
	}

	matches.sort(StarMatchComparator)

	return matches
}

// Orders hypotheses by score, then inlier support, then residuals.
function compareHypotheses(a: HypothesisScore, b: HypothesisScore) {
	if (a.score !== b.score) return b.score - a.score
	if (a.inlierCount !== b.inlierCount) return b.inlierCount - a.inlierCount
	if (a.rmsError !== b.rmsError) return a.rmsError - b.rmsError
	if (a.medianError !== b.medianError) return a.medianError - b.medianError
	return a.model.localeCompare(b.model)
}

// Measures whether two competing transforms are materially different.
function transformSeparation(a: HypothesisScore, b: HypothesisScore) {
	if (a.model === 'similarity' && b.model === 'similarity' && a.similarity !== undefined && b.similarity !== undefined) {
		const dx = a.similarity.tx - b.similarity.tx
		const dy = a.similarity.ty - b.similarity.ty
		const da = a.similarity.a - b.similarity.a
		const db = a.similarity.b - b.similarity.b
		return Math.sqrt(dx * dx + dy * dy + 100 * (da * da + db * db))
	}

	if (a.affine !== undefined && b.affine !== undefined) {
		const d0 = a.affine.m00 - b.affine.m00
		const d1 = a.affine.m01 - b.affine.m01
		const d2 = a.affine.m10 - b.affine.m10
		const d3 = a.affine.m11 - b.affine.m11
		const d4 = a.affine.tx - b.affine.tx
		const d5 = a.affine.ty - b.affine.ty
		return Math.sqrt(d4 * d4 + d5 * d5 + 60 * (d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3))
	}

	return Infinity
}
