import { PI, PIOVERTWO } from '../../../core/constants'
import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { Point } from '../../../math/numerical/geometry'
import type { Image } from '../../model/types'
import { areStreakSegmentsMergeCompatible, canonicalizeStreakEndpoints, clipStreakLineToArea, normalizeStreakAngle, streakAxialAngleDistance, streakLineVectors, streakPlanePointToImage, streakSegmentProjectionRelation, type WeightedLineFit } from './geometry'
import { collectStreakEdges, detectStreakHoughCandidates, MAX_STREAK_LOCAL_ANGLE_VOTES, type StreakHoughCandidate } from './hough'
import { preprocessStreakImage, type PreparedStreakImage, STREAK_MASK_INVALID, STREAK_MASK_SATURATED, streakLocalNoise } from './preprocess'
import { DEFAULT_STREAK_DETECTION_OPTIONS, type Streak, type StreakDetectionOptions } from './types'
import type { StreakDetectionWorkspace } from './workspace'

// End-to-end deterministic detector for approximately straight luminous structures. Processing stays
// on one native image plane; all public geometry is converted back to received-image pixel units.

// Widest supported streak FWHM in received-image pixels; broader structures need another model.
const MAXIMUM_STREAK_WIDTH = 256

// Largest public refinement-candidate count accepted by the v1 detector.
const MAXIMUM_STREAK_CANDIDATES = 512

// Maximum candidate/longitudinal/transverse sample combinations processed per detection call.
const MAXIMUM_STREAK_REFINEMENT_WORK = 100_000_000

// Maximum supported runs admitted to final support and photometric measurement.
const MAXIMUM_STREAK_SUPPORTED_RUNS = MAXIMUM_STREAK_CANDIDATES

// Maximum compatible detection pairs admitted to a full pipeline refit.
const MAXIMUM_STREAK_MERGE_REFITS = MAXIMUM_STREAK_CANDIDATES

// Per-call accounting shared by initial hypotheses, supported runs, and merge refits.
interface StreakWorkBudget {
	work: number
	supportedRuns: number
	mergeRefits: number
}

// Fully resolved options used by every pipeline stage.
interface ResolvedStreakDetectionOptions {
	// Minimum accepted segment length in received-image pixels.
	readonly minLength: number
	// Maximum accepted equivalent FWHM in received-image pixels.
	readonly maxWidth: number
	// Minimum measurable-noise SNR.
	readonly minSNR: number
	// Minimum covariance anisotropy.
	readonly minLinearity: number
	// Maximum final result count.
	readonly maxStreaks: number
	// Positive-signal threshold in local noise sigmas.
	readonly thresholdSigma: number
	// Sobel threshold in local noise sigmas.
	readonly gradientSigma: number
	// Coarse Hough angle step in radians.
	readonly angleStep: number
	// Local-orientation voting tolerance in radians.
	readonly orientationTolerance: number
	// Hough rho step in plane pixels.
	readonly distanceStep: number
	// Maximum Hough hypotheses refined.
	readonly maxCandidates: number
	// Maximum unsupported gap within one seed line, in received-image pixels.
	readonly mergeGap: number
	// Maximum axial angle difference for global fragment merging, in radians.
	readonly mergeAngleTolerance: number
	// Maximum perpendicular line separation for global fragment merging, in received-image pixels.
	readonly mergeDistance: number
	// Whether ROI-truncated results are retained.
	readonly allowBorderClipping: boolean
}

// Final corridor photometry accumulated around a refined segment axis.
interface StreakPhotometry {
	// Signed background-subtracted flux from unique corridor pixels, in input image units.
	readonly flux: number
	// Mean signed residual over valid unique corridor pixels, in input image units.
	readonly meanSignal: number
	// Maximum positive residual sample in input image units.
	readonly peakSignal: number
	// Equivalent transverse FWHM in plane pixels.
	readonly width: number
	// Positive-corridor covariance anisotropy in [0, 1].
	readonly linearity: number
	// Axial offset between positive-corridor covariance and the refined axis, in radians.
	readonly angleOffset: number
	// Count of unique positive-residual pixels in the final corridor.
	readonly supportPixels: number
	// Count of valid unique pixels evaluated for flux and saturation.
	readonly validSamples: number
	// Sum of local residual-noise variances for valid unique pixels; zero means unresolved.
	readonly noiseVariance: number
	// Fraction at or above a known saturation level, when configured.
	readonly saturationFraction?: number
}

// Supported interval found by rescanning the final TLS axis.
interface FinalStreakSupport {
	// First supported point on the final axis, in plane pixels.
	readonly start: Readonly<Point>
	// Last supported point on the final axis, in plane pixels.
	readonly end: Readonly<Point>
	// Supported longitudinal fraction inside the selected run.
	readonly coverage: number
	// Whether the selected run reaches either plane/ROI boundary.
	readonly clippedAtBorder: boolean
}

// Detects, measures, and deterministically ranks straight luminous streaks without physical classification.
export function detectStreaks(image: Image, options: Readonly<StreakDetectionOptions> = {}, workspace?: StreakDetectionWorkspace): readonly Streak[] {
	const resolved = resolveStreakOptions(options)
	const prepared = preprocessStreakImage(image, options, workspace)
	const edges = collectStreakEdges(prepared, resolved)

	if (edges.count === 0) return []

	const candidates = detectStreakHoughCandidates(edges, prepared.grid.width, prepared.grid.height, prepared.workspace, {
		angleStep: resolved.angleStep,
		orientationTolerance: resolved.orientationTolerance,
		distanceStep: resolved.distanceStep,
		maximumCandidates: resolved.maxCandidates,
	})
	const maximumHalfWidth = operationalStreakHalfWidth(prepared, resolved.maxWidth / prepared.grid.step)
	const maximumScanWork = (Math.ceil(Math.hypot(prepared.grid.width, prepared.grid.height)) + 1) * (2 * maximumHalfWidth + 1)
	let initialScanWork = 0
	for (let index = 0; index < candidates.length; index++) initialScanWork += estimateInitialCandidateScanWork(prepared, candidates[index], maximumHalfWidth)
	// Every admitted candidate is scanned once initially and may require one full final-axis scan.
	// Reject an unsafe option/candidate combination before entering either expensive stage.
	if (initialScanWork + candidates.length * maximumScanWork > MAXIMUM_STREAK_REFINEMENT_WORK) throw new RangeError('streak refinement exceeds the bounded work budget')
	const budget: StreakWorkBudget = { work: 0, supportedRuns: 0, mergeRefits: 0 }

	const detections: Streak[] = []
	for (let i = 0; i < candidates.length; i++) refineStreakCandidate(prepared, candidates[i], resolved, detections, budget)
	detections.sort(streaksComparator)
	if (detections.length > resolved.maxCandidates) detections.length = resolved.maxCandidates

	const merged = suppressStreakDuplicates(mergeStreakDetections(prepared, detections, resolved, budget), resolved, prepared.grid.step)
	merged.sort(streaksComparator)
	if (merged.length > resolved.maxStreaks) merged.length = resolved.maxStreaks

	return merged
}

// Validates bounded-work settings and fills operational defaults.
function resolveStreakOptions(options: Readonly<StreakDetectionOptions>): ResolvedStreakDetectionOptions {
	const resolved: ResolvedStreakDetectionOptions = {
		minLength: options.minLength ?? DEFAULT_STREAK_DETECTION_OPTIONS.minLength,
		maxWidth: options.maxWidth ?? DEFAULT_STREAK_DETECTION_OPTIONS.maxWidth,
		minSNR: options.minSNR ?? DEFAULT_STREAK_DETECTION_OPTIONS.minSNR,
		minLinearity: options.minLinearity ?? DEFAULT_STREAK_DETECTION_OPTIONS.minLinearity,
		maxStreaks: options.maxStreaks ?? DEFAULT_STREAK_DETECTION_OPTIONS.maxStreaks,
		thresholdSigma: options.thresholdSigma ?? DEFAULT_STREAK_DETECTION_OPTIONS.thresholdSigma,
		gradientSigma: options.gradientSigma ?? DEFAULT_STREAK_DETECTION_OPTIONS.gradientSigma,
		angleStep: options.angleStep ?? DEFAULT_STREAK_DETECTION_OPTIONS.angleStep,
		orientationTolerance: options.orientationTolerance ?? DEFAULT_STREAK_DETECTION_OPTIONS.orientationTolerance,
		distanceStep: options.distanceStep ?? DEFAULT_STREAK_DETECTION_OPTIONS.distanceStep,
		maxCandidates: options.maxCandidates ?? DEFAULT_STREAK_DETECTION_OPTIONS.maxCandidates,
		mergeGap: options.mergeGap ?? DEFAULT_STREAK_DETECTION_OPTIONS.mergeGap,
		mergeAngleTolerance: options.mergeAngleTolerance ?? DEFAULT_STREAK_DETECTION_OPTIONS.mergeAngleTolerance,
		mergeDistance: options.mergeDistance ?? DEFAULT_STREAK_DETECTION_OPTIONS.mergeDistance,
		allowBorderClipping: options.allowBorderClipping ?? DEFAULT_STREAK_DETECTION_OPTIONS.allowBorderClipping,
	}

	validateInRange(resolved.minLength, 1, 1_000_000)
	validateInRange(resolved.maxWidth, 1, MAXIMUM_STREAK_WIDTH)
	validateInRange(resolved.minSNR, 0, 1_000_000)
	validateInRange(resolved.minLinearity, 0, 1)
	validatePositiveInteger(resolved.maxStreaks)
	validatePositiveInteger(resolved.maxCandidates)
	validateInRange(resolved.maxStreaks, 1, 4096)
	validateInRange(resolved.maxCandidates, 1, MAXIMUM_STREAK_CANDIDATES)
	validateInRange(resolved.thresholdSigma, 0, 64)
	validateInRange(resolved.gradientSigma, 0, 64)
	validateInRange(resolved.angleStep, PI / 4096, PI)
	validateInRange(resolved.orientationTolerance, 0, PIOVERTWO)
	validateInRange(resolved.distanceStep, 1 / 16, 65_536)
	validateInRange(resolved.mergeGap, 0, 1_000_000)
	validateInRange(resolved.mergeAngleTolerance, 0, PIOVERTWO)
	validateInRange(resolved.mergeDistance, 0, 1_000_000)
	const actualAngleStep = PI / Math.ceil(PI / resolved.angleStep)
	const localAngleVotes = 2 * Math.ceil(resolved.orientationTolerance / actualAngleStep) + 1
	if (localAngleVotes > MAX_STREAK_LOCAL_ANGLE_VOTES) throw new RangeError('streak orientation tolerance exceeds the local Hough voting budget')

	return resolved
}

// Merges compatible refined fragments by rescanning a combined native-plane seed until stable.
function mergeStreakDetections(prepared: PreparedStreakImage, detections: readonly Streak[], options: ResolvedStreakDetectionOptions, budget: StreakWorkBudget): Streak[] {
	const merged = detections.slice()
	let changed = true

	while (changed) {
		changed = false

		outer: for (let first = 0; first < merged.length - 1; first++) {
			for (let second = first + 1; second < merged.length; second++) {
				if (!areStreakSegmentsMergeCompatible(merged[first], merged[second], { angle: options.mergeAngleTolerance, gap: options.mergeGap, distance: options.mergeDistance })) continue
				chargeMergeRefit(prepared, budget)
				const refitted = refitMergedStreak(prepared, merged[first], merged[second], options, budget)
				if (!refitted) continue
				merged[first] = refitted
				merged.splice(second, 1)
				changed = true
				break outer
			}
		}
	}

	return merged
}

// Builds a union seed from two image-space detections and returns the best full photometric refit.
function refitMergedStreak(prepared: PreparedStreakImage, first: Streak, second: Streak, options: ResolvedStreakDetectionOptions, budget: StreakWorkBudget): Streak | undefined {
	const sine = Math.sin(2 * first.angle) + Math.sin(2 * second.angle)
	const cosine = Math.cos(2 * first.angle) + Math.cos(2 * second.angle)
	const angle = normalizeStreakAngle(0.5 * Math.atan2(sine, cosine))
	const centerX = (first.center.x * first.length + second.center.x * second.length) / (first.length + second.length)
	const centerY = (first.center.y * first.length + second.center.y * second.length) / (first.length + second.length)
	const planeX = (centerX - prepared.grid.sourceLeft) / prepared.grid.step
	const planeY = (centerY - prepared.grid.sourceTop) / prepared.grid.step
	const normal = streakLineVectors(angle).normal
	const output: Streak[] = []
	refineStreakCandidate(prepared, { angle, rho: planeX * normal.x + planeY * normal.y, score: Math.max(first.confidence, second.confidence) }, options, output, budget)
	if (output.length === 0) return undefined
	output.sort(streaksComparator)
	const requiredLength = Math.max(first.length, second.length)
	return output.find((candidate) => candidate.length >= requiredLength * 0.9)
}

// Removes numerically equivalent corridor hypotheses while preserving resolved parallels and crossings.
function suppressStreakDuplicates(detections: readonly Streak[], options: ResolvedStreakDetectionOptions, planeStep: 1 | 2): Streak[] {
	const retained: Streak[] = []
	const angleTolerance = Math.min(PI / 18, Math.max(options.angleStep, options.orientationTolerance * 2))

	for (let index = 0; index < detections.length; index++) {
		const candidate = detections[index]
		let duplicate = -1

		for (let previous = 0; previous < retained.length; previous++) {
			const accepted = retained[previous]
			const angleDistance = streakAxialAngleDistance(candidate.angle, accepted.angle)
			if (angleDistance > angleTolerance) continue
			const relation = streakSegmentProjectionRelation(candidate, accepted, accepted.angle)
			if (relation.overlap < Math.min(candidate.length, accepted.length) * 0.5) continue
			const baseDistanceTolerance = Math.max(planeStep * 0.75, options.distanceStep * planeStep * 1.5)
			const nearAngleTolerance = Math.max(options.angleStep * 2.5, options.mergeAngleTolerance)
			const distanceTolerance = angleDistance <= nearAngleTolerance ? Math.max(baseDistanceTolerance, (candidate.width + accepted.width) * 0.75) : Math.max(baseDistanceTolerance, Math.min(candidate.width, accepted.width) * 0.35)
			if (segmentCorridorOverlap(candidate, accepted, distanceTolerance) < 0.75 || segmentCorridorOverlap(accepted, candidate, distanceTolerance) < 0.75) continue
			duplicate = previous
			break
		}

		if (duplicate < 0) {
			retained.push(candidate)
			continue
		}

		const accepted = retained[duplicate]
		const candidateEvidence = candidate.flux * candidate.linearity * candidate.coverage
		const acceptedEvidence = accepted.flux * accepted.linearity * accepted.coverage
		if (candidateEvidence > acceptedEvidence || (candidateEvidence === acceptedEvidence && streaksComparator(candidate, accepted) < 0)) retained[duplicate] = candidate
	}

	return retained
}

// Estimates how much of one segment lies inside the finite corridor of another.
function segmentCorridorOverlap(segment: Streak, corridor: Streak, tolerance: number): number {
	const samples = 17
	let overlapping = 0

	for (let sample = 0; sample < samples; sample++) {
		const fraction = sample / (samples - 1)
		const x = segment.start.x + (segment.end.x - segment.start.x) * fraction
		const y = segment.start.y + (segment.end.y - segment.start.y) * fraction
		if (pointSegmentDistance(x, y, corridor.start, corridor.end) <= tolerance) overlapping++
	}

	return overlapping / samples
}

// Returns Euclidean distance from a point to a finite line segment in received-image pixels.
function pointSegmentDistance(x: number, y: number, start: Readonly<Point>, end: Readonly<Point>): number {
	const dx = end.x - start.x
	const dy = end.y - start.y
	const squaredLength = dx * dx + dy * dy
	const fraction = squaredLength > 0 ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / squaredLength)) : 0
	return Math.hypot(x - start.x - fraction * dx, y - start.y - fraction * dy)
}

// Converts one infinite Hough seed into one or more supported longitudinal segments.
function refineStreakCandidate(prepared: PreparedStreakImage, candidate: StreakHoughCandidate, options: ResolvedStreakDetectionOptions, output: Streak[], budget: StreakWorkBudget): void {
	const { grid, workspace } = prepared

	const clipped = clipStreakLineToArea(candidate.angle, candidate.rho, { left: 0, top: 0, right: grid.width, bottom: grid.height })
	if (!clipped) return

	const dx = clipped[1].x - clipped[0].x
	const dy = clipped[1].y - clipped[0].y

	const visibleLength = Math.hypot(dx, dy)
	if (!(visibleLength > 0)) return

	const sampleCount = Math.min(workspace.longitudinalSignal.length, Math.floor(visibleLength) + 1)
	if (sampleCount < 2) return

	const sampleStep = visibleLength / (sampleCount - 1)
	const tangentX = dx / visibleLength
	const tangentY = dy / visibleLength
	const normalX = -tangentY
	const normalY = tangentX
	const halfWidth = operationalStreakHalfWidth(prepared, options.maxWidth / grid.step)
	const numericalFloor = prepared.residualFloor
	chargeStreakWork(prepared, budget, sampleCount * (2 * halfWidth + 1))
	workspace.statistics.reset()

	for (let sample = 0; sample < sampleCount; sample++) {
		const baseX = clipped[0].x + tangentX * sample * sampleStep
		const baseY = clipped[0].y + tangentY * sample * sampleStep
		let signedFlux = 0
		let positiveFlux = 0
		let offsetMoment = 0
		let valid = 0

		for (let offset = -halfWidth; offset <= halfWidth; offset++) {
			const x = Math.round(baseX + normalX * offset)
			const y = Math.round(baseY + normalY * offset)
			if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) continue
			const index = y * grid.width + x
			if (workspace.mask[index] & STREAK_MASK_INVALID) continue

			valid++

			const signal = workspace.signal[index]
			signedFlux += signal

			if (signal > 0) {
				positiveFlux += signal
				offsetMoment += signal * offset
			}
		}

		const noise = streakLocalNoise(prepared, baseX, baseY)
		const threshold = noise > 0 ? options.thresholdSigma * noise * Math.sqrt(valid) : numericalFloor * Math.sqrt(valid)
		workspace.longitudinalSignal[sample] = signedFlux
		workspace.longitudinalOffset[sample] = positiveFlux > 0 ? offsetMoment / positiveFlux : 0
		workspace.longitudinalWeight[sample] = positiveFlux
		workspace.longitudinalSupported[sample] = signedFlux > threshold && positiveFlux > 0 ? 1 : 0
	}

	const maximumGap = Math.floor(options.mergeGap / grid.step)
	let first = -1
	let last = -1

	for (let sample = 0; sample <= sampleCount; sample++) {
		const supported = sample < sampleCount && workspace.longitudinalSupported[sample] !== 0

		if (supported) {
			if (first < 0) first = sample
			last = sample
			continue
		}

		if (first < 0 || sample - last - 1 <= maximumGap) continue

		finishStreakRun(prepared, candidate, options, clipped[0], tangentX, tangentY, normalX, normalY, sampleStep, sampleCount, first, last, output, budget)

		first = -1
		last = -1
	}

	if (first >= 0) finishStreakRun(prepared, candidate, options, clipped[0], tangentX, tangentY, normalX, normalY, sampleStep, sampleCount, first, last, output, budget)
}

// Robustly fits and measures one supported run from a single Hough hypothesis.
function finishStreakRun(
	prepared: PreparedStreakImage,
	candidate: StreakHoughCandidate,
	options: ResolvedStreakDetectionOptions,
	origin: Readonly<Point>,
	seedTangentX: number,
	seedTangentY: number,
	seedNormalX: number,
	seedNormalY: number,
	sampleStep: number,
	sampleCount: number,
	first: number,
	last: number,
	output: Streak[],
	budget: StreakWorkBudget,
): void {
	const { workspace, grid } = prepared

	const observedLength = (last - first) * sampleStep * grid.step
	if (observedLength < options.minLength) return

	let longitudinalCount = 0

	for (let sample = first; sample <= last; sample++) {
		if (!workspace.longitudinalSupported[sample]) continue
		longitudinalCount++
	}
	if (longitudinalCount < 2) return

	const fit = fitLongitudinalCentroids(workspace, origin, seedTangentX, seedTangentY, seedNormalX, seedNormalY, sampleStep, first, last)
	if (!fit || fit.linearity < options.minLinearity) return
	chargeSupportedRun(prepared, budget)

	const vectors = streakLineVectors(fit.angle)
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	let supported = 0

	for (let sample = first; sample <= last; sample++) {
		if (!workspace.longitudinalSupported[sample]) continue
		const x = origin.x + seedTangentX * sample * sampleStep + seedNormalX * workspace.longitudinalOffset[sample]
		const y = origin.y + seedTangentY * sample * sampleStep + seedNormalY * workspace.longitudinalOffset[sample]
		const projection = (x - fit.center.x) * vectors.tangent.x + (y - fit.center.y) * vectors.tangent.y
		minimum = Math.min(minimum, projection)
		maximum = Math.max(maximum, projection)
		supported++
	}

	if (!(maximum > minimum)) return

	const fittedClip = clipStreakLineToArea(fit.angle, fit.rho, { left: 0, top: 0, right: grid.width, bottom: grid.height })
	if (!fittedClip) return

	const clipFirst = (fittedClip[0].x - fit.center.x) * vectors.tangent.x + (fittedClip[0].y - fit.center.y) * vectors.tangent.y
	const clipSecond = (fittedClip[1].x - fit.center.x) * vectors.tangent.x + (fittedClip[1].y - fit.center.y) * vectors.tangent.y

	minimum = Math.max(minimum, Math.min(clipFirst, clipSecond))
	maximum = Math.min(maximum, Math.max(clipFirst, clipSecond))
	if (!(maximum > minimum)) return

	let planeStart = { x: Math.max(0, Math.min(grid.width - 1, fit.center.x + minimum * vectors.tangent.x)), y: Math.max(0, Math.min(grid.height - 1, fit.center.y + minimum * vectors.tangent.y)) }
	let planeEnd = { x: Math.max(0, Math.min(grid.width - 1, fit.center.x + maximum * vectors.tangent.x)), y: Math.max(0, Math.min(grid.height - 1, fit.center.y + maximum * vectors.tangent.y)) }
	let coverage = supported / (last - first + 1)
	let clippedAtBorder = first === 0 || last === sampleCount - 1
	const finalSupport = scanFinalStreakSupport(prepared, fit, options, budget)

	if (finalSupport && Math.hypot(finalSupport.end.x - finalSupport.start.x, finalSupport.end.y - finalSupport.start.y) >= Math.hypot(planeEnd.x - planeStart.x, planeEnd.y - planeStart.y)) {
		planeStart = { x: finalSupport.start.x, y: finalSupport.start.y }
		planeEnd = { x: finalSupport.end.x, y: finalSupport.end.y }
		coverage = finalSupport.coverage
		clippedAtBorder = finalSupport.clippedAtBorder
	}

	const photometry = measureStreakPhotometry(prepared, planeStart, planeEnd, fit.angle, options.maxWidth / grid.step, options.thresholdSigma, budget)
	if (!photometry) return
	// A single hot sample must not turn smooth residual structure into a long accepted segment.
	if (photometry.peakSignal > photometry.flux * 0.5) return
	const width = photometry.width * grid.step
	if (!Number.isFinite(width) || width > options.maxWidth) return
	if (photometry.angleOffset > Math.max(options.angleStep, options.orientationTolerance * 0.5)) return
	if (fit.rmsResidual * grid.step > Math.max(grid.step, width * 0.5)) return

	const linearity = Math.min(fit.linearity, photometry.linearity)
	if (linearity < options.minLinearity) return

	const snr = photometry.noiseVariance > 0 ? photometry.flux / Math.sqrt(photometry.noiseVariance) : undefined
	if (snr !== undefined && snr < options.minSNR) return
	if (clippedAtBorder && !options.allowBorderClipping) return

	const [start, end] = canonicalizeStreakEndpoints(streakPlanePointToImage(planeStart, grid.sourceLeft, grid.sourceTop, grid.step), streakPlanePointToImage(planeEnd, grid.sourceLeft, grid.sourceTop, grid.step))
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	if (length < options.minLength) return

	const snrEvidence = snr === undefined ? Math.min(1, candidate.score / Math.max(1, supported * 8)) : snr / (snr + Math.max(1, options.minSNR))
	const residualEvidence = 1 / (1 + (fit.rmsResidual * grid.step) / Math.max(width, 0.5))
	const confidence = Math.max(0, Math.min(1, (snrEvidence + linearity + coverage + residualEvidence) * 0.25 * (clippedAtBorder ? 0.95 : 1)))

	output.push({
		start,
		end,
		center: { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 },
		length,
		width,
		angle: normalizeStreakAngle(fit.angle),
		linearity,
		rmsResidual: fit.rmsResidual * grid.step,
		coverage,
		supportPixels: photometry.supportPixels,
		clippedAtBorder,
		flux: photometry.flux,
		meanSignal: photometry.meanSignal,
		peakSignal: photometry.peakSignal,
		snr,
		saturationFraction: photometry.saturationFraction,
		confidence,
	})
}

// Rescans the final TLS axis and returns the supported run containing its fitted center.
function scanFinalStreakSupport(prepared: PreparedStreakImage, fit: WeightedLineFit, options: ResolvedStreakDetectionOptions, budget: StreakWorkBudget): FinalStreakSupport | undefined {
	const { workspace, grid } = prepared

	const clipped = clipStreakLineToArea(fit.angle, fit.rho, { left: 0, top: 0, right: grid.width, bottom: grid.height })
	if (!clipped) return undefined

	const dx = clipped[1].x - clipped[0].x
	const dy = clipped[1].y - clipped[0].y
	const length = Math.hypot(dx, dy)

	const sampleCount = Math.min(workspace.longitudinalSignal.length, Math.floor(length) + 1)
	if (sampleCount < 2) return undefined

	const sampleStep = length / (sampleCount - 1)
	const tangentX = dx / length
	const tangentY = dy / length
	const normalX = -tangentY
	const normalY = tangentX
	const halfWidth = operationalStreakHalfWidth(prepared, options.maxWidth / grid.step)
	const numericalFloor = prepared.residualFloor
	chargeStreakWork(prepared, budget, sampleCount * (2 * halfWidth + 1))

	workspace.statistics.reset()

	for (let sample = 0; sample < sampleCount; sample++) {
		const baseX = clipped[0].x + tangentX * sample * sampleStep
		const baseY = clipped[0].y + tangentY * sample * sampleStep
		let flux = 0
		let valid = 0

		for (let offset = -halfWidth; offset <= halfWidth; offset++) {
			const x = Math.round(baseX + normalX * offset)
			const y = Math.round(baseY + normalY * offset)
			if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) continue

			const index = y * grid.width + x
			if (workspace.mask[index] & STREAK_MASK_INVALID) continue

			valid++

			flux += workspace.signal[index]
		}

		workspace.longitudinalSignal[sample] = flux
		workspace.longitudinalWeight[sample] = valid
		if (flux > 0) workspace.statistics.push(flux)
	}

	const positiveMedian = workspace.statistics.median()
	workspace.statistics.reset()
	for (let sample = 0; sample < sampleCount; sample++) if (workspace.longitudinalSignal[sample] > positiveMedian) workspace.statistics.push(workspace.longitudinalSignal[sample])
	const upperQuartile = workspace.statistics.median()
	// The robust profile floor breaks weak bridges between sparse compact sources without
	// letting a single crossing star or flare raise the threshold for a real trail.
	const sparseProfile = Number.isFinite(positiveMedian) && positiveMedian > 0 && upperQuartile > positiveMedian * 2
	const profileFloor = Number.isFinite(upperQuartile) && upperQuartile > 0 ? upperQuartile * (sparseProfile ? 0.3 : 0.15) : 0

	for (let sample = 0; sample < sampleCount; sample++) {
		const baseX = clipped[0].x + tangentX * sample * sampleStep
		const baseY = clipped[0].y + tangentY * sample * sampleStep
		const valid = workspace.longitudinalWeight[sample]
		const noise = streakLocalNoise(prepared, baseX, baseY)
		const noiseThreshold = noise > 0 ? options.thresholdSigma * noise * Math.sqrt(valid) : numericalFloor * Math.sqrt(valid)
		workspace.longitudinalSupported[sample] = workspace.longitudinalSignal[sample] > Math.max(noiseThreshold, profileFloor) ? 1 : 0
	}

	const centerProjection = (fit.center.x - clipped[0].x) * tangentX + (fit.center.y - clipped[0].y) * tangentY
	const centerIndex = Math.max(0, Math.min(sampleCount - 1, Math.round(centerProjection / sampleStep)))
	const maximumGap = Math.floor(options.mergeGap / grid.step)

	let selectedFirst = -1
	let selectedLast = -1
	let selectedSupported = 0
	let selectedContainsCenter = false
	let first = -1
	let last = -1
	let supported = 0

	for (let sample = 0; sample <= sampleCount; sample++) {
		if (sample < sampleCount && workspace.longitudinalSupported[sample]) {
			if (first < 0) first = sample
			last = sample
			supported++
			continue
		}

		if (first < 0 || sample - last - 1 <= maximumGap) continue

		const containsCenter = first <= centerIndex && centerIndex <= last

		if (containsCenter || (!selectedContainsCenter && (selectedFirst < 0 || last - first > selectedLast - selectedFirst))) {
			selectedFirst = first
			selectedLast = last
			selectedSupported = supported
			selectedContainsCenter = containsCenter
		}

		first = -1
		last = -1
		supported = 0
	}

	if (first >= 0) {
		const containsCenter = first <= centerIndex && centerIndex <= last

		if (containsCenter || (!selectedContainsCenter && (selectedFirst < 0 || last - first > selectedLast - selectedFirst))) {
			selectedFirst = first
			selectedLast = last
			selectedSupported = supported
		}
	}

	if (selectedFirst < 0 || selectedLast <= selectedFirst) return undefined

	return {
		start: { x: clipped[0].x + tangentX * selectedFirst * sampleStep, y: clipped[0].y + tangentY * selectedFirst * sampleStep },
		end: { x: clipped[0].x + tangentX * selectedLast * sampleStep, y: clipped[0].y + tangentY * selectedLast * sampleStep },
		coverage: selectedSupported / (selectedLast - selectedFirst + 1),
		clippedAtBorder: selectedFirst === 0 || selectedLast === sampleCount - 1,
	}
}

// Fits longitudinal flux centroids with bounded weights and three Huber-like residual iterations.
function fitLongitudinalCentroids(workspace: StreakDetectionWorkspace, origin: Readonly<Point>, tangentX: number, tangentY: number, normalX: number, normalY: number, sampleStep: number, first: number, last: number): WeightedLineFit | undefined {
	workspace.statistics.reset()

	for (let sample = first; sample <= last; sample++) if (workspace.longitudinalSupported[sample]) workspace.statistics.push(workspace.longitudinalWeight[sample])

	const medianWeight = workspace.statistics.median()
	const weightCap = Number.isFinite(medianWeight) && medianWeight > 0 ? medianWeight * 2 : Number.POSITIVE_INFINITY
	let previous: WeightedLineFit | undefined

	for (let iteration = 0; iteration < 3; iteration++) {
		let residualLimit = Number.POSITIVE_INFINITY
		const previousNormal = previous ? streakLineVectors(previous.angle).normal : undefined

		if (previous && previousNormal) {
			workspace.statistics.reset()

			for (let sample = first; sample <= last; sample++) {
				if (!workspace.longitudinalSupported[sample]) continue
				const x = origin.x + tangentX * sample * sampleStep + normalX * workspace.longitudinalOffset[sample]
				const y = origin.y + tangentY * sample * sampleStep + normalY * workspace.longitudinalOffset[sample]
				workspace.statistics.push(Math.abs(x * previousNormal.x + y * previousNormal.y - previous.rho))
			}

			const mad = workspace.statistics.mad(true, workspace.scratch)
			residualLimit = Math.max(0.5, Number.isFinite(mad) ? mad * 4 : 0.5)
		}

		let weightSum = 0
		let centerX = 0
		let centerY = 0

		for (let sample = first; sample <= last; sample++) {
			if (!workspace.longitudinalSupported[sample]) continue

			const x = origin.x + tangentX * sample * sampleStep + normalX * workspace.longitudinalOffset[sample]
			const y = origin.y + tangentY * sample * sampleStep + normalY * workspace.longitudinalOffset[sample]
			let weight = Math.min(weightCap, workspace.longitudinalWeight[sample])

			if (previous && previousNormal) {
				const residual = Math.abs(x * previousNormal.x + y * previousNormal.y - previous.rho)
				if (residual > residualLimit) weight *= residualLimit / residual
			}

			weightSum += weight
			centerX += weight * x
			centerY += weight * y
		}

		if (!(weightSum > 0)) return undefined

		centerX /= weightSum
		centerY /= weightSum

		let xx = 0
		let xy = 0
		let yy = 0

		for (let sample = first; sample <= last; sample++) {
			if (!workspace.longitudinalSupported[sample]) continue

			const x = origin.x + tangentX * sample * sampleStep + normalX * workspace.longitudinalOffset[sample]
			const y = origin.y + tangentY * sample * sampleStep + normalY * workspace.longitudinalOffset[sample]
			let weight = Math.min(weightCap, workspace.longitudinalWeight[sample])

			if (previous && previousNormal) {
				const residual = Math.abs(x * previousNormal.x + y * previousNormal.y - previous.rho)
				if (residual > residualLimit) weight *= residualLimit / residual
			}

			const offsetX = x - centerX
			const offsetY = y - centerY
			xx += weight * offsetX * offsetX
			xy += weight * offsetX * offsetY
			yy += weight * offsetY * offsetY
		}

		xx /= weightSum
		xy /= weightSum
		yy /= weightSum

		const discriminant = Math.hypot(xx - yy, 2 * xy)
		const majorVariance = Math.max(0, (xx + yy + discriminant) * 0.5)
		const minorVariance = Math.max(0, (xx + yy - discriminant) * 0.5)

		if (!(majorVariance > 0)) return undefined

		const angle = normalizeStreakAngle(0.5 * Math.atan2(2 * xy, xx - yy))
		const normal = streakLineVectors(angle).normal
		previous = { center: { x: centerX, y: centerY }, angle, rho: centerX * normal.x + centerY * normal.y, majorVariance, minorVariance, linearity: Math.max(0, Math.min(1, 1 - minorVariance / majorVariance)), rmsResidual: Math.sqrt(minorVariance) }
	}

	return previous
}

// Integrates unique pixels in a measured-width corridor and derives local-noise SNR inputs.
function measureStreakPhotometry(prepared: PreparedStreakImage, start: Readonly<Point>, end: Readonly<Point>, angle: number, maximumWidth: number, thresholdSigma: number, budget: StreakWorkBudget): StreakPhotometry | undefined {
	const width = measureStreakWidth(prepared, start, end, angle, maximumWidth, thresholdSigma, budget)
	if (width === undefined) return undefined

	const halfWidth = Math.min(operationalStreakHalfWidth(prepared, maximumWidth), Math.max(1, Math.ceil(width * 1.5)))
	const { workspace } = prepared
	chargeStreakWork(prepared, budget, estimateStreakCorridorWork(start, end, halfWidth))

	let flux = 0
	let peakSignal = 0
	let supportPixels = 0
	let validSamples = 0
	let saturatedSamples = 0
	let noiseVariance = 0

	const medianPositiveSignal = workspace.statistics.median()
	const weightCap = Number.isFinite(medianPositiveSignal) && medianPositiveSignal > 0 ? medianPositiveSignal * 3 : Number.POSITIVE_INFINITY
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	const longitudinalBins = Math.min(workspace.longitudinalWeight.length, Math.ceil(length) + 2)
	workspace.longitudinalWeight.fill(0, 0, longitudinalBins)
	workspace.longitudinalSignal.fill(0, 0, longitudinalBins)
	workspace.longitudinalOffset.fill(0, 0, longitudinalBins)
	workspace.longitudinalNormalFirst.fill(0, 0, longitudinalBins)
	workspace.longitudinalNormalSecond.fill(0, 0, longitudinalBins)
	workspace.longitudinalPositionFirst.fill(0, 0, longitudinalBins)
	workspace.longitudinalPositionSecond.fill(0, 0, longitudinalBins)
	workspace.longitudinalPositionNormal.fill(0, 0, longitudinalBins)

	forEachStreakCorridorPixel(prepared, start, end, angle, halfWidth, (x, y, index, normal, longitudinal) => {
		const mask = workspace.mask[index]
		if (mask & STREAK_MASK_INVALID) return
		validSamples++
		if (mask & STREAK_MASK_SATURATED) saturatedSamples++
		const signal = workspace.signal[index]
		flux += signal
		if (signal > 0) {
			peakSignal = Math.max(peakSignal, signal)
			supportPixels++
		}
		const noise = streakLocalNoise(prepared, x, y)
		const sampleNoiseVariance = noise * noise
		noiseVariance += sampleNoiseVariance
		const bin = Math.round(longitudinal)
		if (bin < 0 || bin >= longitudinalBins) return
		workspace.longitudinalSignal[bin] += signal
		workspace.longitudinalOffset[bin] += sampleNoiseVariance
		if (signal > 0) {
			const weight = Math.min(weightCap, signal)
			workspace.longitudinalWeight[bin] += weight
			workspace.longitudinalNormalFirst[bin] += weight * normal
			workspace.longitudinalNormalSecond[bin] += weight * normal * normal
			workspace.longitudinalPositionFirst[bin] += weight * longitudinal
			workspace.longitudinalPositionSecond[bin] += weight * longitudinal * longitudinal
			workspace.longitudinalPositionNormal[bin] += weight * longitudinal * normal
		}
	})

	if (!(validSamples > 0) || !(flux > 0) || !(supportPixels > 0)) return undefined

	let positiveWeight = 0
	let longitudinalFirst = 0
	let longitudinalSecond = 0
	let normalFirst = 0
	let normalSecond = 0
	let crossMoment = 0

	for (let bin = 0; bin < longitudinalBins; bin++) {
		const binWeight = workspace.longitudinalWeight[bin]
		const binThreshold = workspace.longitudinalOffset[bin] > 0 ? Math.max(0.5, thresholdSigma * 0.25) * Math.sqrt(workspace.longitudinalOffset[bin]) : prepared.residualFloor
		if (!(binWeight > 0) || !(workspace.longitudinalSignal[bin] > binThreshold)) continue
		// Give each longitudinal position equal total influence so stars, flares, and
		// longitudinal brightness profiles cannot rotate the shape estimate.
		positiveWeight++
		longitudinalFirst += workspace.longitudinalPositionFirst[bin] / binWeight
		longitudinalSecond += workspace.longitudinalPositionSecond[bin] / binWeight
		normalFirst += workspace.longitudinalNormalFirst[bin] / binWeight
		normalSecond += workspace.longitudinalNormalSecond[bin] / binWeight
		crossMoment += workspace.longitudinalPositionNormal[bin] / binWeight
	}

	const longitudinalCenter = positiveWeight > 0 ? longitudinalFirst / positiveWeight : 0
	const normalCenter = positiveWeight > 0 ? normalFirst / positiveWeight : 0
	const longitudinalVariance = positiveWeight > 0 ? Math.max(0, longitudinalSecond / positiveWeight - longitudinalCenter * longitudinalCenter) : 0
	const normalVariance = positiveWeight > 0 ? Math.max(0, normalSecond / positiveWeight - normalCenter * normalCenter) : 0
	const covariance = positiveWeight > 0 ? crossMoment / positiveWeight - longitudinalCenter * normalCenter : 0
	const discriminant = Math.hypot(longitudinalVariance - normalVariance, 2 * covariance)
	const majorVariance = Math.max(0, (longitudinalVariance + normalVariance + discriminant) * 0.5)
	const minorVariance = Math.max(0, (longitudinalVariance + normalVariance - discriminant) * 0.5)

	return {
		flux,
		meanSignal: flux / validSamples,
		peakSignal,
		width,
		linearity: majorVariance > 0 ? Math.max(0, Math.min(1, 1 - minorVariance / majorVariance)) : 0,
		angleOffset: Math.abs(0.5 * Math.atan2(2 * covariance, longitudinalVariance - normalVariance)),
		supportPixels,
		validSamples,
		noiseVariance,
		saturationFraction: prepared.saturationLevel === undefined ? undefined : saturatedSamples / validSamples,
	}
}

// Estimates transverse FWHM from signed profiles accumulated over unique corridor pixels.
function measureStreakWidth(prepared: PreparedStreakImage, start: Readonly<Point>, end: Readonly<Point>, angle: number, maximumWidth: number, thresholdSigma: number, budget: StreakWorkBudget): number | undefined {
	const halfWidth = operationalStreakHalfWidth(prepared, maximumWidth)
	chargeStreakWork(prepared, budget, estimateStreakCorridorWork(start, end, halfWidth))
	const binCount = 2 * halfWidth + 1
	const profile = prepared.workspace.transverseSignal.fill(0, 0, binCount)
	const noiseVariance = prepared.workspace.transverseNoise.fill(0, 0, binCount)
	prepared.workspace.statistics.reset()

	forEachStreakCorridorPixel(prepared, start, end, angle, halfWidth, (x, y, index, normal) => {
		if (prepared.workspace.mask[index] & STREAK_MASK_INVALID) return
		const bin = Math.round(normal) + halfWidth
		if (bin < 0 || bin >= binCount) return
		const signal = prepared.workspace.signal[index]
		profile[bin] += signal
		if (signal > 0) prepared.workspace.statistics.push(signal)
		const noise = streakLocalNoise(prepared, x, y)
		noiseVariance[bin] += noise * noise
	})

	let peak = -1
	for (let bin = 0; bin < binCount; bin++) if (peak < 0 || profile[bin] > profile[peak]) peak = bin
	if (peak < 0) return undefined
	const numericalFloor = prepared.residualFloor
	const significant = (bin: number) => profile[bin] > (noiseVariance[bin] > 0 ? Math.max(0.5, thresholdSigma * 0.25) * Math.sqrt(noiseVariance[bin]) : numericalFloor)
	if (!significant(peak)) return undefined

	let first = peak
	let last = peak
	while (first > 0 && significant(first - 1)) first--
	while (last + 1 < binCount && significant(last + 1)) last++
	let weight = 0
	let firstMoment = 0
	let secondMoment = 0

	for (let bin = first; bin <= last; bin++) {
		const signal = Math.max(0, profile[bin])
		const normal = bin - halfWidth
		weight += signal
		firstMoment += signal * normal
		secondMoment += signal * normal * normal
	}

	if (!(weight > 0)) return undefined
	const center = firstMoment / weight
	const variance = Math.max(0, secondMoment / weight - center * center)
	return Math.max(1, 2 * Math.sqrt(2 * Math.log(2)) * Math.sqrt(variance))
}

// Charges one coarse stage estimate before its pixel loop can monopolize the event loop.
function chargeStreakWork(prepared: PreparedStreakImage, budget: StreakWorkBudget, work: number): void {
	if (budget.work + work > MAXIMUM_STREAK_REFINEMENT_WORK) throw new RangeError('streak refinement exceeds the bounded work budget')
	budget.work += work
	prepared.workspace.state.refinementWork = budget.work
}

// Admits one fitted run to the expensive final-support and photometry stages.
function chargeSupportedRun(prepared: PreparedStreakImage, budget: StreakWorkBudget): void {
	if (budget.supportedRuns >= MAXIMUM_STREAK_SUPPORTED_RUNS) throw new RangeError('streak refinement exceeds the supported-run budget')
	budget.supportedRuns++
	prepared.workspace.state.supportedRuns = budget.supportedRuns
}

// Admits one compatible pair to a full merge refit.
function chargeMergeRefit(prepared: PreparedStreakImage, budget: StreakWorkBudget): void {
	if (budget.mergeRefits >= MAXIMUM_STREAK_MERGE_REFITS) throw new RangeError('streak refinement exceeds the merge-refit budget')
	budget.mergeRefits++
	prepared.workspace.state.mergeRefits = budget.mergeRefits
}

// Conservatively bounds raster work for the unique-pixel corridor iterator.
function estimateStreakCorridorWork(start: Readonly<Point>, end: Readonly<Point>, halfWidth: number): number {
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	const radius = halfWidth + 0.5
	return (Math.ceil(length + 2 * radius) + 2) * (Math.ceil(2 * Math.SQRT2 * radius) + 2)
}

// Computes the exact transverse-loop bound for one clipped Hough seed without scanning pixels.
function estimateInitialCandidateScanWork(prepared: PreparedStreakImage, candidate: StreakHoughCandidate, halfWidth: number): number {
	const clipped = clipStreakLineToArea(candidate.angle, candidate.rho, { left: 0, top: 0, right: prepared.grid.width, bottom: prepared.grid.height })
	if (!clipped) return 0
	const length = Math.hypot(clipped[1].x - clipped[0].x, clipped[1].y - clipped[0].y)
	const sampleCount = Math.min(prepared.workspace.longitudinalSignal.length, Math.floor(length) + 1)
	return sampleCount >= 2 ? sampleCount * (2 * halfWidth + 1) : 0
}

// Returns a frame-clamped transverse half-width so oversized requests cannot expand hot loops.
function operationalStreakHalfWidth(prepared: PreparedStreakImage, maximumWidth: number): number {
	return Math.max(1, Math.ceil(Math.min(maximumWidth, Math.hypot(prepared.grid.width, prepared.grid.height))))
}

// Visits each integer pixel center in an oriented segment corridor at most once.
function forEachStreakCorridorPixel(prepared: PreparedStreakImage, start: Readonly<Point>, end: Readonly<Point>, angle: number, halfWidth: number, visit: (x: number, y: number, index: number, normal: number, longitudinal: number) => void): void {
	const vectors = streakLineVectors(angle)
	const forward = (end.x - start.x) * vectors.tangent.x + (end.y - start.y) * vectors.tangent.y >= 0
	const axialStart = forward ? start : end
	const axialEnd = forward ? end : start
	const length = Math.hypot(axialEnd.x - axialStart.x, axialEnd.y - axialStart.y)
	if (!(length > 0)) return
	const radius = halfWidth + 0.5
	const { width, height } = prepared.grid

	if (Math.abs(vectors.tangent.x) >= Math.abs(vectors.tangent.y)) {
		const firstX = Math.max(0, Math.floor(Math.min(axialStart.x, axialEnd.x) - Math.abs(vectors.normal.x) * radius))
		const lastX = Math.min(width - 1, Math.ceil(Math.max(axialStart.x, axialEnd.x) + Math.abs(vectors.normal.x) * radius))

		for (let x = firstX; x <= lastX; x++) {
			const axisY = axialStart.y - (vectors.normal.x * (x - axialStart.x)) / vectors.normal.y
			const span = radius / Math.abs(vectors.normal.y)
			const firstY = Math.max(0, Math.ceil(axisY - span))
			const lastY = Math.min(height - 1, Math.floor(axisY + span))
			for (let y = firstY; y <= lastY; y++) visitCorridorPixel(x, y, width, axialStart, length, radius, vectors.tangent, vectors.normal, visit)
		}
	} else {
		const firstY = Math.max(0, Math.floor(Math.min(axialStart.y, axialEnd.y) - Math.abs(vectors.normal.y) * radius))
		const lastY = Math.min(height - 1, Math.ceil(Math.max(axialStart.y, axialEnd.y) + Math.abs(vectors.normal.y) * radius))

		for (let y = firstY; y <= lastY; y++) {
			const axisX = axialStart.x - (vectors.normal.y * (y - axialStart.y)) / vectors.normal.x
			const span = radius / Math.abs(vectors.normal.x)
			const firstX = Math.max(0, Math.ceil(axisX - span))
			const lastX = Math.min(width - 1, Math.floor(axisX + span))
			for (let x = firstX; x <= lastX; x++) visitCorridorPixel(x, y, width, axialStart, length, radius, vectors.tangent, vectors.normal, visit)
		}
	}
}

// Applies exact axial and transverse corridor bounds to one unique integer pixel center.
function visitCorridorPixel(x: number, y: number, width: number, start: Readonly<Point>, length: number, radius: number, tangent: Readonly<Point>, normalVector: Readonly<Point>, visit: (x: number, y: number, index: number, normal: number, longitudinal: number) => void): void {
	const offsetX = x - start.x
	const offsetY = y - start.y
	const longitudinal = offsetX * tangent.x + offsetY * tangent.y
	if (longitudinal < -0.5 || longitudinal > length + 0.5) return
	const normal = offsetX * normalVector.x + offsetY * normalVector.y
	if (Math.abs(normal) > radius) return
	visit(x, y, y * width + x, normal, longitudinal)
}

// Stable final ranking: quality, flux, length, angle, then image position.
function streaksComparator(first: Streak, second: Streak): number {
	return second.confidence - first.confidence || second.flux - first.flux || second.length - first.length || first.angle - second.angle || first.center.y - second.center.y || first.center.x - second.center.x
}
