import { PI, PIOVERTWO } from '../../../core/constants'
import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { Angle } from '../../../math/units/angle'
import { normalizeStreakAngle, streakAxialAngleDistance } from './geometry'
import { type PreparedStreakImage, STREAK_MASK_INVALID, streakLocalNoiseAtPixel } from './preprocess'
import type { StreakDetectionWorkspace } from './workspace'

// Sparse orientation-gated Hough seeding for straight streaks. Edge arrays are structure-of-arrays,
// angles are axial tangent bins, and rho storage is reused one angle at a time.

// Maximum local angular bins visited for one edge-equivalent Hough vote.
export const MAX_STREAK_LOCAL_ANGLE_VOTES = 33

// Maximum edge/local-angle combinations accepted by one Hough call.
export const MAX_STREAK_HOUGH_EDGE_VOTES = 16_777_216

// Maximum accumulator slots cleared and scanned by the coarse Hough raster.
export const MAX_STREAK_HOUGH_RHO_WORK = 100_000_000

// Coarse processing clears once and scans twice for peaks at every active angle.
const STREAK_HOUGH_FULL_RHO_PASSES = 3

// A bounded structure-of-arrays view of oriented edge samples.
export interface StreakEdgePoints {
	// Number of populated entries in each array.
	readonly count: number
	// Native-plane X coordinates in pixels.
	readonly x: Float32Array
	// Native-plane Y coordinates in pixels.
	readonly y: Float32Array
	// Positive bounded vote weights.
	readonly weight: Float32Array
	// Quantized local axial tangent bin for each point.
	readonly angleBin: Uint16Array | Uint32Array
	// Number of equally spaced axial bins spanning [0, PI).
	readonly angleCount: number
	// Actual bin spacing in radians.
	readonly angleStep: Angle
}

// One locally refined normal-form line hypothesis in native-plane coordinates.
export interface StreakHoughCandidate {
	// Axial tangent angle in radians in [0, PI).
	readonly angle: Angle
	// Signed distance along the left-hand normal (-sin(angle), cos(angle)), in plane pixels.
	readonly rho: number
	// Bounded-vote accumulator response; useful only for ranking candidates from the same call.
	readonly score: number
}

// Operational settings for sparse edge extraction and orientation-gated Hough voting.
export interface StreakHoughOptions {
	// Positive residual threshold in local noise sigmas.
	readonly thresholdSigma?: number
	// Sobel magnitude threshold in local noise sigmas.
	readonly gradientSigma?: number
	// Coarse axial bin target step, in radians.
	readonly angleStep?: Angle
	// Maximum local-tangent separation allowed to vote, in radians.
	readonly orientationTolerance?: Angle
	// Rho-bin spacing in native-plane pixels.
	readonly distanceStep?: number
	// Maximum returned hypotheses after two-dimensional NMS.
	readonly maximumCandidates?: number
}

// Extracts deterministic, orientation-stratified Sobel edge points into fixed workspace arrays.
export function collectStreakEdges(prepared: PreparedStreakImage, options: Readonly<StreakHoughOptions> = {}): StreakEdgePoints {
	const { workspace, grid } = prepared
	const angleStep = options.angleStep ?? PI / 90
	const thresholdSigma = options.thresholdSigma ?? 2.5
	const gradientSigma = options.gradientSigma ?? 1.5
	validateInRange(angleStep, PI / 4096, PI)
	validateInRange(thresholdSigma, 0, 64)
	validateInRange(gradientSigma, 0, 64)
	const angleCount = Math.ceil(PI / angleStep)
	if (angleCount > workspace.angleCapacity) throw new RangeError('streak workspace angular capacity is too small')
	const actualAngleStep = PI / angleCount
	const counts = workspace.angleCounts
	counts.fill(0, 0, angleCount)
	workspace.rhoNearest.fill(0, 0, angleCount)
	let eligible = 0

	forEachEligibleEdge(prepared, thresholdSigma, gradientSigma, actualAngleStep, angleCount, (x, y, weight, bin) => {
		counts[bin]++
		workspace.rhoNearest[bin] = Math.max(workspace.rhoNearest[bin], weight)
		if (eligible < workspace.maximumEdgePoints) {
			workspace.edgeX[eligible] = x
			workspace.edgeY[eligible] = y
			workspace.edgeWeight[eligible] = weight
			workspace.edgeAngleBin[eligible] = bin
		}
		eligible++
	})

	if (eligible <= workspace.maximumEdgePoints) {
		workspace.state.edgeCount = eligible
		workspace.state.edgesTruncated = false
		return { count: eligible, x: workspace.edgeX, y: workspace.edgeY, weight: workspace.edgeWeight, angleBin: workspace.edgeAngleBin, angleCount, angleStep: actualAngleStep }
	}

	const nonempty: number[] = []
	for (let bin = 0; bin < angleCount; bin++) if (counts[bin] > 0) nonempty.push(bin)
	if (nonempty.length > workspace.maximumEdgePoints) nonempty.sort((a, b) => workspace.rhoNearest[b] - workspace.rhoNearest[a] || a - b).length = workspace.maximumEdgePoints
	const baseQuota = nonempty.length > 0 ? Math.floor(workspace.maximumEdgePoints / nonempty.length) : 0
	let remaining = workspace.maximumEdgePoints - baseQuota * nonempty.length
	const quotas = workspace.angleOffsets
	quotas.fill(0, 0, angleCount)

	for (let i = 0; i < nonempty.length; i++) {
		const bin = nonempty[i]
		quotas[bin] = Math.min(counts[bin], baseQuota + (remaining-- > 0 ? 1 : 0))
	}

	const seen = new Uint32Array(angleCount)
	let edgeCount = 0

	forEachEligibleEdge(prepared, thresholdSigma, gradientSigma, actualAngleStep, angleCount, (x, y, weight, bin) => {
		const occurrence = seen[bin]++
		const quota = quotas[bin]
		const total = counts[bin]
		if (quota === 0 || Math.floor(((occurrence + 1) * quota) / total) <= Math.floor((occurrence * quota) / total)) return
		const index = edgeCount++
		workspace.edgeX[index] = x
		workspace.edgeY[index] = y
		workspace.edgeWeight[index] = weight
		workspace.edgeAngleBin[index] = bin
	})

	workspace.state.edgeCount = edgeCount
	workspace.state.edgesTruncated = eligible > edgeCount
	return { count: edgeCount, x: workspace.edgeX, y: workspace.edgeY, weight: workspace.edgeWeight, angleBin: workspace.edgeAngleBin, angleCount, angleStep: actualAngleStep }
}

// Finds coarse line peaks, applies theta/rho NMS, and refines each survivor in a small angular window.
export function detectStreakHoughCandidates(edges: StreakEdgePoints, width: number, height: number, workspace: StreakDetectionWorkspace, options: Readonly<StreakHoughOptions> = {}): readonly StreakHoughCandidate[] {
	validatePositiveInteger(width)
	validatePositiveInteger(height)
	workspace.state.houghActiveAngles = 0
	workspace.state.houghRhoWork = 0
	if (edges.count > workspace.maximumEdgePoints || edges.angleCount > workspace.angleCapacity) throw new RangeError('streak edge input exceeds workspace capacity')
	const distanceStep = options.distanceStep ?? 1
	const orientationTolerance = options.orientationTolerance ?? PI / 36
	const maximumCandidates = options.maximumCandidates ?? Math.min(128, workspace.maximumCandidates)
	validateInRange(distanceStep, 1 / 16, Math.hypot(width, height))
	validateInRange(orientationTolerance, 0, PIOVERTWO)
	validatePositiveInteger(maximumCandidates)
	if (maximumCandidates > workspace.maximumCandidates) throw new RangeError('streak workspace candidate capacity is too small')
	const diagonal = Math.hypot(width - 1, height - 1)
	const rhoCount = Math.ceil((2 * diagonal) / distanceStep) + 3
	if (rhoCount > workspace.rhoCapacity) throw new RangeError('streak workspace rho capacity is too small')
	const toleranceBins = Math.ceil(orientationTolerance / edges.angleStep)
	const localAngleVotes = 2 * toleranceBins + 1
	// This prevents a type-valid tolerance/step combination from degenerating into global Hough work.
	if (localAngleVotes > MAX_STREAK_LOCAL_ANGLE_VOTES || edges.count * localAngleVotes > MAX_STREAK_HOUGH_EDGE_VOTES) throw new RangeError('streak Hough voting exceeds the bounded work budget')
	const rhoWork = STREAK_HOUGH_FULL_RHO_PASSES * edges.angleCount * rhoCount
	if (rhoWork > MAX_STREAK_HOUGH_RHO_WORK) throw new RangeError('streak Hough rho scan exceeds the bounded work budget')
	workspace.state.houghRhoWork = rhoWork
	countingSortEdges(edges, workspace)
	const coarse: StreakHoughCandidate[] = []
	const peakBins = new Int32Array(4)
	const peakScores = new Float64Array(4)
	const counts = workspace.angleCounts
	let supportedEdges = edges.count
	if (localAngleVotes < edges.angleCount) {
		supportedEdges = 0
		for (let offset = -toleranceBins; offset <= toleranceBins; offset++) supportedEdges += counts[(offset + edges.angleCount) % edges.angleCount]
	}

	for (let angleBin = 0; angleBin < edges.angleCount; angleBin++) {
		if (supportedEdges > 0) {
			workspace.state.houghActiveAngles++
			const angle = angleBin * edges.angleStep
			const peak = accumulateAngle(edges, workspace, angle, angleBin, toleranceBins, diagonal, distanceStep, rhoCount)

			if (peak.score > 0) {
				peakBins.fill(-1)
				peakScores.fill(0)

				for (let rhoBin = 1; rhoBin < rhoCount - 1; rhoBin++) {
					const score = workspace.rhoAccumulator[rhoBin]
					if (!(score > 0) || score < workspace.rhoAccumulator[rhoBin - 1] || score < workspace.rhoAccumulator[rhoBin + 1]) continue

					for (let slot = 0; slot < peakScores.length; slot++) {
						if (score <= peakScores[slot]) continue

						for (let shift = peakScores.length - 1; shift > slot; shift--) {
							peakScores[shift] = peakScores[shift - 1]
							peakBins[shift] = peakBins[shift - 1]
						}

						peakScores[slot] = score
						peakBins[slot] = rhoBin

						break
					}
				}

				for (let slot = 0; slot < peakBins.length && peakBins[slot] >= 0; slot++) {
					insertHoughCandidate(coarse, { angle, rho: peakBins[slot] * distanceStep - diagonal, score: peakScores[slot] }, maximumCandidates, edges.angleStep * 1.5, distanceStep * 2)
				}
			}
		}

		if (localAngleVotes < edges.angleCount) {
			const outgoing = (angleBin - toleranceBins + edges.angleCount) % edges.angleCount
			const incoming = (angleBin + toleranceBins + 1) % edges.angleCount
			supportedEdges += counts[incoming] - counts[outgoing]
		}
	}

	const refined: StreakHoughCandidate[] = []
	for (let i = 0; i < coarse.length; i++) {
		const seed = coarse[i]
		let best = seed

		for (let offset = -2; offset <= 2; offset++) {
			const angle = normalizeStreakAngle(seed.angle + (offset * edges.angleStep) / 4)
			const bin = Math.round(angle / edges.angleStep) % edges.angleCount
			const peak = accumulateAngle(edges, workspace, angle, bin, toleranceBins, diagonal, distanceStep, rhoCount, seed.rho)
			if (peak.score > best.score) best = { angle, rho: peak.rho, score: peak.score }
		}

		insertHoughCandidate(refined, best, maximumCandidates, edges.angleStep, distanceStep * 1.5)
	}

	workspace.state.candidateCount = refined.length

	return refined
}

// Visits every qualifying Sobel edge without allocating per-pixel records.
function forEachEligibleEdge(prepared: PreparedStreakImage, thresholdSigma: number, gradientSigma: number, angleStep: number, angleCount: number, visit: (x: number, y: number, weight: number, bin: number) => void): void {
	const { signal, mask } = prepared.workspace
	const { width, height } = prepared.grid
	const numericalFloor = prepared.residualFloor

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const center = y * width + x
			if (mask[center] & STREAK_MASK_INVALID) continue
			const noise = streakLocalNoiseAtPixel(prepared, x, y)
			const signalThreshold = noise > 0 ? thresholdSigma * noise : numericalFloor
			const gradientThreshold = noise > 0 ? gradientSigma * noise * 4 : numericalFloor * 4
			let positive = 0

			for (let offsetY = -1; offsetY <= 1; offsetY++) {
				const row = center + offsetY * width
				for (let offsetX = -1; offsetX <= 1; offsetX++) positive = Math.max(positive, signal[row + offsetX])
			}

			if (!(positive > signalThreshold)) continue

			const gx = -signal[center - width - 1] + signal[center - width + 1] - 2 * signal[center - 1] + 2 * signal[center + 1] - signal[center + width - 1] + signal[center + width + 1]
			const gy = -signal[center - width - 1] - 2 * signal[center - width] - signal[center - width + 1] + signal[center + width - 1] + 2 * signal[center + width] + signal[center + width + 1]

			const magnitude = Math.hypot(gx, gy)
			if (!(magnitude > gradientThreshold)) continue

			const angle = normalizeStreakAngle(Math.atan2(gy, gx) + PIOVERTWO)
			const bin = Math.min(angleCount - 1, Math.floor(angle / angleStep))
			const weight = Math.min(64, Math.max(positive / signalThreshold, magnitude / gradientThreshold))
			visit(x, y, weight, bin)
		}
	}
}

// Counting-sorts edge indices into angular ranges while leaving structure-of-arrays data in place.
function countingSortEdges(edges: StreakEdgePoints, workspace: StreakDetectionWorkspace): void {
	const counts = workspace.angleCounts
	const offsets = workspace.angleOffsets

	counts.fill(0, 0, edges.angleCount)
	for (let i = 0; i < edges.count; i++) counts[edges.angleBin[i]]++

	offsets[0] = 0
	for (let bin = 0; bin < edges.angleCount; bin++) offsets[bin + 1] = offsets[bin] + counts[bin]

	counts.fill(0, 0, edges.angleCount)

	for (let i = 0; i < edges.count; i++) {
		const bin = edges.angleBin[i]
		workspace.edgeOrder[offsets[bin] + counts[bin]++] = i
	}
}

// Accumulates one tangent angle using only nearby local-orientation bins and returns its strongest rho.
function accumulateAngle(edges: StreakEdgePoints, workspace: StreakDetectionWorkspace, angle: number, centerBin: number, toleranceBins: number, diagonal: number, distanceStep: number, rhoCount: number, preferredRho?: number): { readonly rho: number; readonly score: number } {
	const accumulator = workspace.rhoAccumulator
	const preferredBin = preferredRho === undefined ? undefined : (preferredRho + diagonal) / distanceStep
	const firstPeakBin = preferredBin === undefined ? 1 : Math.max(1, Math.ceil(preferredBin - 4))
	const lastPeakBin = preferredBin === undefined ? rhoCount - 2 : Math.min(rhoCount - 2, Math.floor(preferredBin + 4))
	const firstAccumulatorBin = Math.max(0, firstPeakBin - 1)
	const lastAccumulatorBin = Math.min(rhoCount - 1, lastPeakBin + 1)
	accumulator.fill(0, firstAccumulatorBin, lastAccumulatorBin + 1)
	const normalX = -Math.sin(angle)
	const normalY = Math.cos(angle)

	for (let offset = -toleranceBins; offset <= toleranceBins; offset++) {
		const bin = (centerBin + offset + edges.angleCount) % edges.angleCount

		for (let order = workspace.angleOffsets[bin]; order < workspace.angleOffsets[bin + 1]; order++) {
			const edge = workspace.edgeOrder[order]
			const position = (edges.x[edge] * normalX + edges.y[edge] * normalY + diagonal) / distanceStep
			const lower = Math.floor(position)
			const fraction = position - lower
			if (lower >= firstAccumulatorBin && lower <= lastAccumulatorBin) accumulator[lower] += edges.weight[edge] * (1 - fraction)
			if (lower + 1 >= firstAccumulatorBin && lower + 1 <= lastAccumulatorBin) accumulator[lower + 1] += edges.weight[edge] * fraction
		}
	}

	let peak = 0
	let score = 0

	for (let bin = firstPeakBin; bin <= lastPeakBin; bin++) {
		const value = accumulator[bin]
		if (value > score && value >= accumulator[bin - 1] && value >= accumulator[bin + 1]) {
			peak = bin
			score = value
		}
	}

	if (!(score > 0)) return { rho: 0, score: 0 }

	const left = accumulator[peak - 1]
	const right = accumulator[peak + 1]
	const denominator = left - 2 * score + right
	const correction = denominator !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator)) : 0
	return { rho: (peak + correction) * distanceStep - diagonal, score }
}

function streakHoughCandidateComparator(a: StreakHoughCandidate, b: StreakHoughCandidate) {
	return b.score - a.score || a.angle - b.angle || a.rho - b.rho
}

// Inserts a score-sorted candidate unless a stronger nearby theta/rho hypothesis already represents it.
function insertHoughCandidate(candidates: StreakHoughCandidate[], candidate: StreakHoughCandidate, capacity: number, angleTolerance: number, distanceTolerance: number): void {
	for (let i = 0; i < candidates.length; i++) {
		const previous = candidates[i]
		const rawAngleDistance = Math.abs(previous.angle - candidate.angle)
		const rhoDistance = rawAngleDistance <= PIOVERTWO ? Math.abs(previous.rho - candidate.rho) : Math.abs(previous.rho + candidate.rho)

		if (streakAxialAngleDistance(previous.angle, candidate.angle) <= angleTolerance && rhoDistance <= distanceTolerance) {
			if (candidate.score > previous.score) candidates[i] = candidate
			candidates.sort(streakHoughCandidateComparator)
			return
		}
	}

	candidates.push(candidate)
	candidates.sort(streakHoughCandidateComparator)
	if (candidates.length > capacity) candidates.length = capacity
}
