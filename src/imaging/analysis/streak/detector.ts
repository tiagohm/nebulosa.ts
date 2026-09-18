import { PI } from '../../../core/constants'
import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { Point } from '../../../math/numerical/geometry'
import type { Image } from '../../model/types'
import { canonicalizeStreakEndpoints, clipStreakLineToArea, normalizeStreakAngle, streakLineVectors, streakPlanePointToImage, type WeightedLineFit } from './geometry'
import { collectStreakEdges, detectStreakHoughCandidates, type StreakHoughCandidate } from './hough'
import { preprocessStreakImage, type PreparedStreakImage, STREAK_MASK_INVALID, STREAK_MASK_SATURATED, streakLocalNoise } from './preprocess'
import { DEFAULT_STREAK_DETECTION_OPTIONS, type Streak, type StreakDetectionOptions } from './types'
import type { StreakDetectionWorkspace } from './workspace'

// End-to-end deterministic detector for approximately straight luminous structures. Processing stays
// on one native image plane; all public geometry is converted back to received-image pixel units.

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
	// Whether ROI-truncated results are retained.
	readonly allowBorderClipping: boolean
}

// Final corridor photometry accumulated around a refined segment axis.
interface StreakPhotometry {
	// Positive residual flux in input image units.
	readonly flux: number
	// Mean positive residual sample in input image units.
	readonly meanSignal: number
	// Maximum positive residual sample in input image units.
	readonly peakSignal: number
	// Equivalent transverse FWHM in plane pixels.
	readonly width: number
	// Count of positive samples contributing flux.
	readonly supportPixels: number
	// Count of valid samples evaluated for noise scaling and saturation.
	readonly validSamples: number
	// Fraction at or above a known saturation level, when configured.
	readonly saturationFraction?: number
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
	const detections: Streak[] = []
	for (let i = 0; i < candidates.length; i++) refineStreakCandidate(prepared, candidates[i], resolved, detections)
	detections.sort(compareStreaks)
	if (detections.length > resolved.maxStreaks) detections.length = resolved.maxStreaks
	return detections
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
		allowBorderClipping: options.allowBorderClipping ?? DEFAULT_STREAK_DETECTION_OPTIONS.allowBorderClipping,
	}
	validateInRange(resolved.minLength, 1, 1_000_000)
	validateInRange(resolved.maxWidth, 0.5, 65_536)
	validateInRange(resolved.minSNR, 0, 1_000_000)
	validateInRange(resolved.minLinearity, 0, 1)
	validatePositiveInteger(resolved.maxStreaks)
	validatePositiveInteger(resolved.maxCandidates)
	validateInRange(resolved.maxStreaks, 1, 4096)
	validateInRange(resolved.maxCandidates, 1, 4096)
	validateInRange(resolved.thresholdSigma, 0, 64)
	validateInRange(resolved.gradientSigma, 0, 64)
	validateInRange(resolved.angleStep, PI / 4096, PI)
	validateInRange(resolved.orientationTolerance, 0, PI / 2)
	validateInRange(resolved.distanceStep, 1 / 16, 65_536)
	validateInRange(resolved.mergeGap, 0, 1_000_000)
	return resolved
}

// Converts one infinite Hough seed into one or more supported longitudinal segments.
function refineStreakCandidate(prepared: PreparedStreakImage, candidate: StreakHoughCandidate, options: ResolvedStreakDetectionOptions, output: Streak[]): void {
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
	const halfWidth = Math.max(1, Math.ceil(options.maxWidth / grid.step))
	const numericalFloor = Math.max(1e-12, Number.EPSILON * Math.max(1, Math.abs(prepared.globalBackground)) * 32)

	for (let sample = 0; sample < sampleCount; sample++) {
		const baseX = clipped[0].x + tangentX * sample * sampleStep
		const baseY = clipped[0].y + tangentY * sample * sampleStep
		let flux = 0
		let offsetMoment = 0
		let valid = 0
		for (let offset = -halfWidth; offset <= halfWidth; offset++) {
			const x = Math.round(baseX + normalX * offset)
			const y = Math.round(baseY + normalY * offset)
			if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) continue
			const index = y * grid.width + x
			if (workspace.mask[index] & STREAK_MASK_INVALID) continue
			valid++
			const signal = Math.max(0, workspace.signal[index])
			flux += signal
			offsetMoment += signal * offset
		}
		const noise = streakLocalNoise(prepared, baseX, baseY)
		const threshold = noise > 0 ? options.thresholdSigma * noise * Math.sqrt(valid) : numericalFloor
		workspace.longitudinalSignal[sample] = flux
		workspace.longitudinalOffset[sample] = flux > 0 ? offsetMoment / flux : 0
		workspace.longitudinalWeight[sample] = flux
		workspace.longitudinalSupported[sample] = flux > threshold ? 1 : 0
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
		finishStreakRun(prepared, candidate, options, clipped[0], tangentX, tangentY, normalX, normalY, sampleStep, sampleCount, first, last, output)
		first = -1
		last = -1
	}
	if (first >= 0) finishStreakRun(prepared, candidate, options, clipped[0], tangentX, tangentY, normalX, normalY, sampleStep, sampleCount, first, last, output)
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
): void {
	const { workspace, grid } = prepared
	const observedLength = (last - first) * sampleStep * grid.step
	if (observedLength < options.minLength) return
	const fit = fitLongitudinalCentroids(workspace, origin, seedTangentX, seedTangentY, seedNormalX, seedNormalY, sampleStep, first, last)
	if (!fit || fit.linearity < options.minLinearity) return
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
	const planeStart = { x: fit.center.x + minimum * vectors.tangent.x, y: fit.center.y + minimum * vectors.tangent.y }
	const planeEnd = { x: fit.center.x + maximum * vectors.tangent.x, y: fit.center.y + maximum * vectors.tangent.y }
	const photometry = measureStreakPhotometry(prepared, planeStart, planeEnd, fit.angle, options.maxWidth / grid.step)
	const width = photometry.width * grid.step
	if (!Number.isFinite(width) || width > options.maxWidth) return
	const snr = prepared.globalNoise > 0 && photometry.validSamples > 0 ? photometry.flux / (prepared.globalNoise * Math.sqrt(photometry.validSamples)) : undefined
	if (snr !== undefined && snr < options.minSNR) return
	const clippedAtBorder = first === 0 || last === sampleCount - 1
	if (clippedAtBorder && !options.allowBorderClipping) return
	const [start, end] = canonicalizeStreakEndpoints(streakPlanePointToImage(planeStart, grid.sourceLeft, grid.sourceTop, grid.step), streakPlanePointToImage(planeEnd, grid.sourceLeft, grid.sourceTop, grid.step))
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	if (length < options.minLength) return
	const coverage = supported / (last - first + 1)
	const snrEvidence = snr === undefined ? Math.min(1, candidate.score / Math.max(1, supported * 8)) : snr / (snr + Math.max(1, options.minSNR))
	const residualEvidence = 1 / (1 + (fit.rmsResidual * grid.step) / Math.max(width, 0.5))
	const confidence = Math.max(0, Math.min(1, (snrEvidence + fit.linearity + coverage + residualEvidence) * 0.25 * (clippedAtBorder ? 0.95 : 1)))
	output.push({
		start,
		end,
		center: { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 },
		length,
		width,
		angle: normalizeStreakAngle(fit.angle),
		linearity: fit.linearity,
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

// Fits longitudinal flux centroids with bounded weights and three Huber-like residual iterations.
function fitLongitudinalCentroids(workspace: StreakDetectionWorkspace, origin: Readonly<Point>, tangentX: number, tangentY: number, normalX: number, normalY: number, sampleStep: number, first: number, last: number): WeightedLineFit | undefined {
	workspace.statistics.reset()
	for (let sample = first; sample <= last; sample++) if (workspace.longitudinalSupported[sample]) workspace.statistics.push(workspace.longitudinalWeight[sample])
	const medianWeight = workspace.statistics.median()
	const weightCap = Number.isFinite(medianWeight) && medianWeight > 0 ? medianWeight * 5 : Number.POSITIVE_INFINITY
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

// Integrates the final corridor and derives transverse second-moment width in native-plane pixels.
function measureStreakPhotometry(prepared: PreparedStreakImage, start: Readonly<Point>, end: Readonly<Point>, angle: number, maximumWidth: number): StreakPhotometry {
	const { workspace, grid } = prepared
	const vectors = streakLineVectors(angle)
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	const samples = Math.max(2, Math.floor(length) + 1)
	const halfWidth = Math.max(1, Math.ceil(maximumWidth))
	let flux = 0
	let normalFirst = 0
	let normalSecond = 0
	let peakSignal = 0
	let supportPixels = 0
	let validSamples = 0
	let saturatedSamples = 0
	for (let sample = 0; sample < samples; sample++) {
		const fraction = sample / (samples - 1)
		const baseX = start.x + (end.x - start.x) * fraction
		const baseY = start.y + (end.y - start.y) * fraction
		for (let offset = -halfWidth; offset <= halfWidth; offset++) {
			const x = Math.round(baseX + vectors.normal.x * offset)
			const y = Math.round(baseY + vectors.normal.y * offset)
			if (x < 0 || x >= grid.width || y < 0 || y >= grid.height) continue
			const index = y * grid.width + x
			const mask = workspace.mask[index]
			if (mask & STREAK_MASK_INVALID) continue
			validSamples++
			if (mask & STREAK_MASK_SATURATED) saturatedSamples++
			const signal = Math.max(0, workspace.signal[index])
			if (!(signal > 0)) continue
			flux += signal
			normalFirst += signal * offset
			normalSecond += signal * offset * offset
			peakSignal = Math.max(peakSignal, signal)
			supportPixels++
		}
	}
	const center = flux > 0 ? normalFirst / flux : 0
	const variance = flux > 0 ? Math.max(0, normalSecond / flux - center * center) : 0
	return {
		flux,
		meanSignal: supportPixels > 0 ? flux / supportPixels : 0,
		peakSignal,
		width: 2 * Math.sqrt(2 * Math.log(2)) * Math.sqrt(variance),
		supportPixels,
		validSamples,
		saturationFraction: prepared.saturationLevel === undefined || validSamples === 0 ? undefined : saturatedSamples / validSamples,
	}
}

// Stable final ranking: quality, flux, length, angle, then image position.
function compareStreaks(first: Streak, second: Streak): number {
	return second.confidence - first.confidence || second.flux - first.flux || second.length - first.length || first.angle - second.angle || first.center.y - second.center.y || first.center.x - second.center.x
}
