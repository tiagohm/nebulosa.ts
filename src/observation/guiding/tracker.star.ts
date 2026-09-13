import type { Image } from '../../imaging/model/types'
import { detectStars, type DetectedStar } from '../../imaging/stars/detector'
import { clamp } from '../../math/numerical/math'
import { medianAbsoluteDeviationOf, medianOf } from '../../math/numerical/statistics'
import type { GuideMeasurement, GuideTracker, GuideTrackerContext, GuideTrackerFrame, GuideTrackerResult, GuideTrackerTelemetry } from './tracker'

// Star-based implementation of the generic guide tracker. It performs one detector pass per image,
// enriches peaks once, preserves the selected identity, and exposes a frame-local stellar result
// for the controller, calibration state machine, PHD2 events, and overlay.

// Whether translation is measured from one star or many.
export type GuidingMode = 'singleStar' | 'multiStar'

// A detected star augmented with optional guiding-quality attributes.
export interface GuideStar extends DetectedStar {
	// Whether the detector flagged the star as usable.
	readonly valid?: boolean
	// Whether the star is saturated.
	readonly saturated?: boolean
	// Peak pixel value sampled around the centroid.
	readonly peak?: number
	// Shape ellipticity in [0, 1); higher means more elongated.
	readonly ellipticity?: number
	// Full width at half maximum, in pixels.
	readonly fwhm?: number
}

// Star detections plus the image geometry and optional search window used by star-only helpers.
export interface StarDetectionFrame {
	// Current frame detections in overlay order.
	readonly stars: readonly GuideStar[]
	// Frame width in pixels.
	readonly width: number
	// Frame height in pixels.
	readonly height: number
	// Search-box center in image pixels.
	readonly searchPosition?: readonly [number, number]
	// Search-box side in pixels.
	readonly searchRegion?: number
}

// Quality and geometry thresholds used to accept or reject guide stars.
export interface StarFilterConfig {
	// Minimum signal-to-noise ratio in the detector's sample scale.
	readonly minStarSnr: number
	// Minimum integrated flux above background in the detector's sample scale.
	readonly minFlux: number
	// Maximum half-flux diameter, in pixels.
	readonly maxHfd: number
	// Border exclusion margin, in pixels.
	readonly borderMarginPx: number
	// Maximum allowed ellipticity in [0, 1).
	readonly maxEllipticity: number
	// Maximum allowed FWHM, in pixels.
	readonly maxFwhm?: number
	// Peak value at/above which a star is saturated in the detector's sample scale.
	readonly saturationPeak?: number
}

// Output of star filtering: accepted detections plus rejection statistics.
export interface FilteredStars {
	// Detections that passed the filter; freshly allocated by every filter call.
	readonly accepted: GuideStar[]
	// Count of rejected detections by reason.
	readonly rejectedReasons: Record<string, number>
	// Accepted/total ratio in [0, 1].
	readonly qualityScore: number
}

// Estimated stellar translation with the mode and match count that produced it.
export interface TranslationMeasurement {
	// Measured X coordinate in pixels.
	readonly x: number
	// Measured Y coordinate in pixels.
	readonly y: number
	// Mode used for this measurement.
	readonly usedMode: GuidingMode
	// Number of detections contributing to the estimate.
	readonly matches: number
}

// Resolved configuration for stellar primary selection and alternatives.
export interface GuideStarSelectionConfig {
	// Star filtering thresholds.
	readonly filter: StarFilterConfig
	// Absolute minimum neighbor separation, in pixels.
	readonly minNeighborDistancePx: number
	// Neighbor separation as a multiple of HFD.
	readonly minNeighborDistanceHfdRatio: number
	// Minimum spacing between chosen alternatives, in pixels.
	readonly alternativeSeparationPx: number
	// Maximum number of alternative stars to return.
	readonly maxAlternatives: number
}

// Optional overrides for stellar primary selection.
export interface GuideStarSelectionOptions {
	// Filter threshold overrides.
	readonly filter?: Partial<StarFilterConfig>
	// Absolute minimum neighbor separation, in pixels.
	readonly minNeighborDistancePx?: number
	// Neighbor separation as a multiple of HFD.
	readonly minNeighborDistanceHfdRatio?: number
	// Minimum spacing between alternatives, in pixels.
	readonly alternativeSeparationPx?: number
	// Maximum number of alternatives to return.
	readonly maxAlternatives?: number
}

// A guide star scored and annotated for selection.
export interface SelectedGuideStar extends GuideStar {
	// Composite selection score; higher is better.
	readonly score: number
	// Distance to the nearest frame edge, in pixels.
	readonly edgeDistance: number
	// Distance to the optical center, in pixels.
	readonly centerDistance: number
	// Distance to the nearest neighbor, in pixels.
	readonly nearestNeighborDistance: number
	// Whether the star is close to saturation.
	readonly nearSaturation: boolean
}

// Outcome of stellar primary selection and alternative ranking.
export interface GuideStarSelection {
	// Best qualified guide star.
	readonly primary?: SelectedGuideStar
	// Spaced alternative guide stars.
	readonly alternatives: SelectedGuideStar[]
	// All scored candidates in ranked order.
	readonly candidates: SelectedGuideStar[]
	// Rejected detections by reason.
	readonly rejectedReasons: Record<string, number>
	// Accepted/total ratio in [0, 1].
	readonly qualityScore: number
}

// Default stellar filtering and selection thresholds preserved from the former guider.
export const DEFAULT_STAR_FILTER_CONFIG: Readonly<StarFilterConfig> = {
	minStarSnr: 2,
	minFlux: 1,
	maxHfd: 10,
	borderMarginPx: 10,
	maxEllipticity: 0.5,
	maxFwhm: 12,
	saturationPeak: 0.98,
}

// Default stellar selection thresholds preserved from the former guider.
export const DEFAULT_GUIDE_STAR_SELECTION_CONFIG: Readonly<GuideStarSelectionConfig> = {
	filter: DEFAULT_STAR_FILTER_CONFIG,
	minNeighborDistancePx: 12,
	minNeighborDistanceHfdRatio: 3.5,
	alternativeSeparationPx: 32,
	maxAlternatives: 5,
}

// Filters detections and emits rejection diagnostics without mutating the source array.
export function filterGuideStars(frame: StarDetectionFrame, config: StarFilterConfig): FilteredStars {
	const accepted: GuideStar[] = []
	const rejectedReasons: Record<string, number> = {}
	const borderRight = frame.width - config.borderMarginPx
	const borderBottom = frame.height - config.borderMarginPx

	for (const star of frame.stars) {
		const reason = rejectStarReason(star, config, borderRight, borderBottom, config.borderMarginPx)

		if (reason !== undefined) {
			rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1
			continue
		}

		accepted.push(star)
	}

	const ratio = frame.stars.length > 0 ? accepted.length / frame.stars.length : 0
	const qualityScore = clamp(ratio, 0, 1)
	return { accepted, rejectedReasons, qualityScore }
}

// Returns whether a detection falls inside the square search box centered on a pixel position.
export function starInsideSearchRegion(star: GuideStar, position: readonly [number, number], searchRegion: number) {
	const half = searchRegion / 2
	return Math.abs(star.x - position[0]) <= half && Math.abs(star.y - position[1]) <= half
}

// Returns detections participating in lock quality, restricted to the active search box.
export function qualityStarsOf(frame: StarDetectionFrame): readonly GuideStar[] {
	if (frame.searchPosition === undefined || frame.searchRegion === undefined) return frame.stars

	const inside: GuideStar[] = []
	for (const star of frame.stars) {
		if (starInsideSearchRegion(star, frame.searchPosition, frame.searchRegion)) inside.push(star)
	}
	return inside
}

// Filters only detections inside the search box when one is active.
export function filterQualityGuideStars(frame: StarDetectionFrame, config: StarFilterConfig): FilteredStars {
	const stars = qualityStarsOf(frame)
	return filterGuideStars({ ...frame, stars }, config)
}

// Selects the strongest isolated guide star and spaced alternatives for multi-star tracking.
export function selectGuideStar(stars: readonly GuideStar[], width: number, height: number, image?: Image, options?: GuideStarSelectionOptions): GuideStarSelection {
	const config = mergeGuideStarSelectionConfig(options)
	stars = enrichGuideStars(stars, image)
	const filtered = filterGuideStars({ width, height, stars }, config.filter)
	const rejectedReasons = { ...filtered.rejectedReasons }

	if (filtered.accepted.length === 0) return { primary: undefined, alternatives: [], candidates: [], rejectedReasons, qualityScore: filtered.qualityScore }

	const count = filtered.accepted.length
	const nearestDistanceSq = new Float64Array(count)
	const nearestNeighborHfd = new Float64Array(count)
	nearestDistanceSq.fill(Infinity)

	for (let i = 0; i < count; i++) {
		const a = filtered.accepted[i]

		for (let j = i + 1; j < count; j++) {
			const b = filtered.accepted[j]
			const dx = a.x - b.x
			const dy = a.y - b.y
			const distanceSq = dx * dx + dy * dy

			if (distanceSq < nearestDistanceSq[i]) {
				nearestDistanceSq[i] = distanceSq
				nearestNeighborHfd[i] = b.hfd
			}

			if (distanceSq < nearestDistanceSq[j]) {
				nearestDistanceSq[j] = distanceSq
				nearestNeighborHfd[j] = a.hfd
			}
		}
	}

	const candidates: SelectedGuideStar[] = []
	for (let i = 0; i < count; i++) {
		const star = filtered.accepted[i]
		const nearestNeighborDistance = Number.isFinite(nearestDistanceSq[i]) ? Math.sqrt(nearestDistanceSq[i]) : Number.POSITIVE_INFINITY
		const separationLimit = Math.max(config.minNeighborDistancePx, Math.max(star.hfd, nearestNeighborHfd[i]) * config.minNeighborDistanceHfdRatio)

		if (nearestNeighborDistance < separationLimit) {
			rejectedReasons.double_star = (rejectedReasons.double_star ?? 0) + 1
			continue
		}

		const edgeDistance = edgeDistanceOf(star, width, height)
		const centerDistance = centerDistanceOf(star, width, height)
		const score = guideStarSelectionScore(star, config, edgeDistance, centerDistance, nearestNeighborDistance, width, height)
		const nearSaturation = isNearSaturation(star, config.filter.saturationPeak)
		candidates.push({ ...star, score, edgeDistance, centerDistance, nearestNeighborDistance, nearSaturation })
	}

	candidates.sort(compareGuideStarsByScore)
	const primary = candidates[0]
	const alternatives: SelectedGuideStar[] = []

	if (primary !== undefined && config.maxAlternatives > 0) {
		const minSeparationSq = config.alternativeSeparationPx * config.alternativeSeparationPx

		for (let i = 1; i < candidates.length; i++) {
			const candidate = candidates[i]
			let separated = minSeparationSq <= 0 || distanceSqBetween(candidate, primary) >= minSeparationSq

			for (let j = 0; separated && j < alternatives.length; j++) {
				if (distanceSqBetween(candidate, alternatives[j]) < minSeparationSq) separated = false
			}

			if (!separated) continue
			alternatives.push(candidate)
			if (alternatives.length >= config.maxAlternatives) break
		}
	}

	return { primary, alternatives, candidates, rejectedReasons, qualityScore: filtered.qualityScore }
}

// Samples image peaks when detector results do not already contain them.
export function enrichGuideStars(stars: readonly GuideStar[], image?: Image) {
	if (image === undefined) return stars

	const enriched = new Array<GuideStar>(stars.length)
	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		enriched[i] = star.peak === undefined ? { ...star, peak: samplePeakAroundStar(star, image) } : star
	}
	return enriched
}

// Gets rejection reason for one star using quality, saturation, shape, and border checks.
function rejectStarReason(star: GuideStar, config: StarFilterConfig, borderRight: number, borderBottom: number, borderLeft: number) {
	if (star.valid === false) return 'invalid'
	if (!Number.isFinite(star.x) || !Number.isFinite(star.y) || !Number.isFinite(star.snr) || !Number.isFinite(star.flux) || !Number.isFinite(star.hfd)) return 'nan'
	if (star.snr < config.minStarSnr) return 'low_snr'
	if (star.flux < config.minFlux) return 'low_flux'
	if (star.hfd > config.maxHfd) return 'high_hfd'
	if (star.saturated === true) return 'saturated'
	if (config.saturationPeak !== undefined && star.peak !== undefined && star.peak >= config.saturationPeak) return 'saturated_peak'
	const ellipticity = star.ellipticity ?? star.eccentricity
	if (ellipticity !== undefined && ellipticity > config.maxEllipticity) return 'elongated'
	if (config.maxFwhm !== undefined && star.fwhm !== undefined && star.fwhm > config.maxFwhm) return 'high_fwhm'
	if (star.x < borderLeft || star.y < borderLeft || star.x >= borderRight || star.y >= borderBottom) return 'border'
	return undefined
}

// Merges selector overrides with the stable default stellar configuration.
function mergeGuideStarSelectionConfig(options?: GuideStarSelectionOptions): GuideStarSelectionConfig {
	return {
		...DEFAULT_GUIDE_STAR_SELECTION_CONFIG,
		...options,
		filter: { ...DEFAULT_GUIDE_STAR_SELECTION_CONFIG.filter, ...options?.filter },
	}
}

// Measures a local maximum around a star centroid from a monochrome or RGB image.
function samplePeakAroundStar(star: GuideStar, image: Image) {
	const { raw, metadata } = image
	const { width, height, channels, stride } = metadata
	const x = clamp(Math.round(star.x), 0, width - 1)
	const y = clamp(Math.round(star.y), 0, height - 1)
	const maxY = Math.min(height - 1, y + 1)
	const maxX = Math.min(width - 1, x + 1)
	let peak = Number.NEGATIVE_INFINITY

	for (let py = Math.max(0, y - 1); py <= maxY; py++) {
		const row = py * stride
		for (let px = Math.max(0, x - 1); px <= maxX; px++) {
			const base = row + px * channels
			for (let channel = 0; channel < channels; channel++) {
				const value = raw[base + channel]
				if (value > peak) peak = value
			}
		}
	}

	return peak
}

// Computes border clearance in pixels.
function edgeDistanceOf(star: GuideStar, width: number, height: number) {
	return Math.min(star.x, star.y, width - star.x, height - star.y)
}

// Computes distance from the optical center in pixels.
function centerDistanceOf(star: GuideStar, width: number, height: number) {
	const dx = star.x - width * 0.5
	const dy = star.y - height * 0.5
	return Math.hypot(dx, dy)
}

// Detects stars close enough to clipping to be deprioritized.
function isNearSaturation(star: GuideStar, saturationPeak?: number) {
	return saturationPeak !== undefined && star.peak !== undefined && star.peak >= saturationPeak * 0.85
}

// Scores a candidate using signal, compactness, isolation, and frame geometry.
function guideStarSelectionScore(star: GuideStar, config: GuideStarSelectionConfig, edgeDistance: number, centerDistance: number, nearestNeighborDistance: number, width: number, height: number) {
	const snrScore = clamp(Math.log1p(Math.max(0, star.snr)) / 4, 0, 2)
	const fluxScore = clamp(Math.log1p(Math.max(0, star.flux)) / 9, 0, 2)
	const sharpnessScore = clamp(3 / Math.max(1, star.hfd), 0, 2)
	const isolationScore = clamp(Math.log1p(Math.max(0, nearestNeighborDistance)) / Math.log1p(Math.max(config.alternativeSeparationPx * 2, 2)), 0, 1.25)
	const edgeScore = clamp(edgeDistance / Math.max(Math.min(width, height) * 0.5, 1), 0, 1.5)
	const centerScore = 1 - clamp(centerDistance / Math.max(Math.min(width, height) * 0.5, 1), 0, 1)
	const saturationPenalty = isNearSaturation(star, config.filter.saturationPeak) && star.peak !== undefined && config.filter.saturationPeak !== undefined ? clamp((star.peak - config.filter.saturationPeak * 0.85) / Math.max(config.filter.saturationPeak * 0.15, 1e-6), 0, 1.5) : 0

	return snrScore * 3 + fluxScore * 2.25 + sharpnessScore * 2 + isolationScore * 1.5 + edgeScore * 1.25 + centerScore * 3 - saturationPenalty * 3
}

// Orders candidates by score, signal quality, flux, and centrality.
function compareGuideStarsByScore(a: SelectedGuideStar, b: SelectedGuideStar) {
	return b.score - a.score || b.snr - a.snr || b.flux - a.flux || a.centerDistance - b.centerDistance
}

// Computes squared separation without a square root.
function distanceSqBetween(a: GuideStar, b: GuideStar) {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return dx * dx + dy * dy
}

// Estimates translation with one-to-one nearest-neighbor association and robust outlier rejection.
export function estimateTranslation(referenceStars: readonly GuideStar[], stars: readonly GuideStar[], maxMatchDistancePx: number, outlierSigma: number) {
	const used = new Uint8Array(stars.length)
	const dx = new Float64Array(referenceStars.length)
	const dy = new Float64Array(referenceStars.length)
	const weights = new Float64Array(referenceStars.length)
	const maxDistSq = maxMatchDistancePx * maxMatchDistancePx
	let count = 0

	for (const ref of referenceStars) {
		let bestIdx = -1
		let bestDistSq = Infinity

		for (let i = 0; i < stars.length; i++) {
			if (used[i] === 1) continue
			const star = stars[i]
			const ddx = star.x - ref.x
			const ddy = star.y - ref.y
			const d2 = ddx * ddx + ddy * ddy

			if (d2 < bestDistSq && d2 <= maxDistSq) {
				bestDistSq = d2
				bestIdx = i
			}
		}

		if (bestIdx < 0) continue
		used[bestIdx] = 1
		const matched = stars[bestIdx]
		dx[count] = matched.x - ref.x
		dy[count] = matched.y - ref.y
		weights[count] = (Math.max(0.5, matched.snr) * Math.sqrt(Math.max(1, matched.flux))) / Math.max(0.5, matched.hfd)
		count++
	}

	if (count === 0) return undefined
	return robustWeightedTranslation(dx, dy, weights, count, outlierSigma)
}

// Computes weighted translation after robust residual rejection.
function robustWeightedTranslation(dx: Float64Array, dy: Float64Array, weights: Float64Array, count: number, outlierSigma: number) {
	let initial = weightedMean(dx, dy, weights, count)
	if (count < 3) return { ...initial, matches: count }

	const residual = new Float64Array(count)
	for (let i = 0; i < count; i++) {
		const ddx = dx[i] - initial.dx
		const ddy = dy[i] - initial.dy
		residual[i] = Math.sqrt(ddx * ddx + ddy * ddy)
	}

	const sortedResidual = residual.toSorted()
	const median = medianOf(sortedResidual)
	const mad = medianAbsoluteDeviationOf(sortedResidual, median, true, undefined, sortedResidual)
	const threshold = outlierSigma * Math.max(mad, 1e-9)

	let kept = 0
	for (let i = 0; i < count; i++) if (Math.abs(residual[i] - median) <= threshold) kept++

	if (kept === 0) return undefined
	if (kept === count) return { ...initial, matches: count }

	const fdx = new Float64Array(kept)
	const fdy = new Float64Array(kept)
	const fw = new Float64Array(kept)
	for (let i = 0, j = 0; i < count; i++) {
		if (Math.abs(residual[i] - median) > threshold) continue
		fdx[j] = dx[i]
		fdy[j] = dy[i]
		fw[j] = weights[i]
		j++
	}

	initial = weightedMean(fdx, fdy, fw, kept)
	return { ...initial, matches: kept }
}

// Computes a weighted mean translation in pixels.
function weightedMean(dx: Float64Array, dy: Float64Array, weights: Float64Array, count: number) {
	let sumW = 0
	let sumX = 0
	let sumY = 0
	for (let i = 0; i < count; i++) {
		const w = Math.max(weights[i], 1e-6)
		sumW += w
		sumX += dx[i] * w
		sumY += dy[i] * w
	}
	if (sumW <= 0) return { dx: 0, dy: 0 }
	return { dx: sumX / sumW, dy: sumY / sumW }
}

// Configuration for stellar acquisition, identity matching, and robust multi-star translation.
export interface StarTrackerConfig {
	// Single- or multi-star measurement mode.
	readonly mode: GuidingMode
	// Maximum nearest-neighbor association distance, in pixels.
	readonly maxMatchDistancePx: number
	// Sigma multiplier used by robust translation rejection.
	readonly outlierSigma: number
	// Quality and geometry thresholds applied to detections.
	readonly filter: StarFilterConfig
	// Initial selection, isolation, and alternative-star rules.
	readonly selection: GuideStarSelectionConfig
}

// Default star-tracker configuration, preserving the previous guider's stellar tuning.
export const DEFAULT_STAR_TRACKER_CONFIG: Readonly<StarTrackerConfig> = {
	mode: 'multiStar',
	maxMatchDistancePx: 6,
	outlierSigma: 2.5,
	filter: DEFAULT_STAR_FILTER_CONFIG,
	selection: DEFAULT_GUIDE_STAR_SELECTION_CONFIG,
}

// Fallback calibration association radius, in pixels, matching the default calibrator jump budget
// when a tracker is called without the guide-client context.
const DEFAULT_CALIBRATION_MATCH_DISTANCE_PX = 12

// Result of stellar tracking, including the current frame's detections and quality subsets.
export interface StarTrackerResult extends GuideTrackerResult {
	// All detector results in current-frame overlay order.
	readonly detections: readonly GuideStar[]
	// Filtered detections available to the current measurement.
	readonly accepted: readonly GuideStar[]
	// Primary detection used for overlay and stellar telemetry.
	readonly primary?: GuideStar
	// Whether the primary is inside the active search region.
	readonly primaryInsideSearchRegion: boolean
	// Configured mode used by this tracker.
	readonly usedMode?: GuidingMode
	// Number of associations used by the translation estimate.
	readonly matches: number
}

// Stateful stellar tracker that replaces repeated client-side detection and matching.
export class StarTracker implements GuideTracker {
	readonly config: StarTrackerConfig
	#lastResult?: StarTrackerResult
	#referenceStars: readonly GuideStar[] = []
	#measurementOrigin?: readonly [number, number]
	#lastMeasurement?: GuideMeasurement
	#width = 0
	#height = 0

	constructor(config: Partial<StarTrackerConfig> = {}) {
		const filter = { ...DEFAULT_STAR_TRACKER_CONFIG.filter, ...config.filter }
		const selection = {
			...DEFAULT_STAR_TRACKER_CONFIG.selection,
			...config.selection,
			filter: { ...DEFAULT_STAR_TRACKER_CONFIG.selection.filter, ...config.selection?.filter },
		}
		this.config = { ...DEFAULT_STAR_TRACKER_CONFIG, ...config, filter, selection }
	}

	// Clears the tracked identity, translation reference, and last frame result.
	reset() {
		this.#lastResult = undefined
		this.#referenceStars = []
		this.#measurementOrigin = undefined
		this.#lastMeasurement = undefined
		this.#width = 0
		this.#height = 0
	}

	// Returns only the result for the most recently tracked frame.
	get lastResult() {
		return this.#lastResult
	}

	// Detects and tracks exactly one image frame synchronously.
	track(frame: GuideTrackerFrame, context: GuideTrackerContext): StarTrackerResult {
		if (frame.width !== this.#width || frame.height !== this.#height) {
			this.#referenceStars = []
			this.#measurementOrigin = undefined
			this.#lastMeasurement = undefined
			this.#width = frame.width
			this.#height = frame.height
		}

		if (frame.image === undefined) {
			return this.#publish({
				candidateCount: 0,
				acceptedCount: 0,
				qualityScore: 0,
				rejectedReasons: {},
				notes: ['image_unavailable'],
				detections: [],
				accepted: [],
				primaryInsideSearchRegion: false,
				matches: 0,
			})
		}

		const detections = enrichGuideStars(detectStars(frame.image), frame.image)
		const orderedDetections = detections.slice()
		const searchPosition = context.searchPosition
		const searchRegion = context.searchRegion
		const searchPrimary = searchPosition === undefined || searchRegion === undefined ? undefined : nearestInSearchRegion(orderedDetections, searchPosition, searchRegion)
		const primaryInsideSearchRegion = searchPosition === undefined || searchRegion === undefined || searchPrimary !== undefined

		if (searchPrimary !== undefined) moveToFront(orderedDetections, searchPrimary)

		const frameForFilter: StarDetectionFrame = {
			stars: orderedDetections,
			width: frame.width,
			height: frame.height,
			searchPosition,
			searchRegion,
		}
		const quality = filterQualityGuideStars(frameForFilter, this.config.filter)
		const filtered = filterGuideStars({ stars: orderedDetections, width: frame.width, height: frame.height }, this.config.filter)
		const selection = selectGuideStar(orderedDetections, frame.width, frame.height, undefined, { ...this.config.selection, filter: { ...this.config.selection.filter, ...this.config.filter } })
		const primary = searchPosition === undefined || searchRegion === undefined ? selection.primary : searchPrimary
		const notes: string[] = []

		if (!primaryInsideSearchRegion) notes.push('primary_outside_search_region')

		let measurement: GuideMeasurement | undefined
		let measurementMode: GuidingMode | undefined
		let matches = 0
		const accepted = primaryInsideSearchRegion ? filtered.accepted : []
		const maxMatchDistancePx = context.phase === 'calibrating' ? Math.max(this.config.maxMatchDistancePx, context.maxMeasurementJumpPx ?? DEFAULT_CALIBRATION_MATCH_DISTANCE_PX) : this.config.maxMatchDistancePx

		if (primaryInsideSearchRegion && accepted.length > 0 && (this.#measurementOrigin === undefined || !context.preserveIdentity)) {
			const acquired = searchPosition === undefined || searchRegion === undefined ? selection.primary : pickAcquisition(quality.accepted, context.initialPosition)
			if (acquired !== undefined && context.allowAcquisition) {
				this.#measurementOrigin = [acquired.x, acquired.y]
				this.#referenceStars = accepted
				this.#lastMeasurement = { x: acquired.x, y: acquired.y, confidence: confidenceOf(quality.qualityScore) }
				measurement = this.#lastMeasurement
				measurementMode = 'singleStar'
				matches = 1
				notes.push('acquired')
			}
		} else if (primaryInsideSearchRegion && accepted.length > 0 && this.#measurementOrigin !== undefined) {
			const translation = this.#measureTranslation(accepted, maxMatchDistancePx)
			if (translation !== undefined) {
				measurement = { x: translation.x, y: translation.y, confidence: confidenceOf(quality.qualityScore) }
				this.#lastMeasurement = measurement
				this.#rememberMeasurement(accepted, measurement)
				measurementMode = translation.mode
				matches = translation.matches
			}
		}

		if (measurement === undefined && primaryInsideSearchRegion && accepted.length > 0 && context.allowAcquisition && this.#measurementOrigin !== undefined) {
			// Preserve the controller's legacy single-star fallback: the generic jump guard, rather
			// than identity association, decides whether a larger measured displacement is safe.
			const fallback = nearestWithin(accepted, this.#measurementOrigin, Number.POSITIVE_INFINITY)
			if (fallback !== undefined) {
				measurement = { x: fallback.x, y: fallback.y, confidence: confidenceOf(quality.qualityScore) }
				this.#lastMeasurement = measurement
				this.#rememberMeasurement(accepted, measurement)
				measurementMode = 'singleStar'
				matches = 1
			}
		}

		if (measurement === undefined) {
			if (primaryInsideSearchRegion && accepted.length === 0) notes.push('no_usable_measurement')
			else if (primaryInsideSearchRegion && !context.allowAcquisition) notes.push('acquisition_disabled')
			else notes.push('measurement_lost')
		}

		const telemetry = telemetryOf(primary)
		return this.#publish({
			measurement,
			candidateCount: detections.length,
			acceptedCount: accepted.length,
			qualityScore: quality.qualityScore,
			rejectedReasons: quality.rejectedReasons,
			notes,
			measurementMode,
			telemetry,
			detections: orderedDetections,
			accepted,
			primary,
			primaryInsideSearchRegion,
			usedMode: measurementMode,
			matches,
		})
	}

	// Estimates current translation from the stored identity, falling back to one-star association.
	#measureTranslation(stars: readonly GuideStar[], maxMatchDistancePx: number) {
		if (this.#measurementOrigin === undefined) return undefined

		if (this.config.mode === 'multiStar' && this.#referenceStars.length > 1 && stars.length > 1) {
			const translation = estimateTranslation(this.#referenceStars, stars, maxMatchDistancePx, this.config.outlierSigma)
			if (translation !== undefined) return { x: this.#measurementOrigin[0] + translation.dx, y: this.#measurementOrigin[1] + translation.dy, mode: 'multiStar' as const, matches: translation.matches }
		}

		const nearest = nearestWithin(stars, this.#measurementOrigin, Number.POSITIVE_INFINITY)
		return nearest === undefined ? undefined : { x: nearest.x, y: nearest.y, mode: 'singleStar' as const, matches: 1 }
	}

	// Advances the association reference to the latest accepted frame while keeping measurements in
	// the original image coordinate frame. Failed frames leave the last good reference untouched.
	#rememberMeasurement(stars: readonly GuideStar[], measurement: GuideMeasurement) {
		this.#referenceStars = stars
		this.#measurementOrigin = [measurement.x, measurement.y]
	}

	// Stores a fresh result while keeping no per-frame result history.
	#publish(result: Omit<StarTrackerResult, 'targetOffset'>): StarTrackerResult {
		this.#lastResult = result
		return result
	}
}

// Returns the closest detection inside the square search region.
function nearestInSearchRegion(stars: readonly GuideStar[], position: readonly [number, number], searchRegion: number) {
	let selected: GuideStar | undefined
	let distanceSq = Number.POSITIVE_INFINITY

	for (const star of stars) {
		if (!starInsideSearchRegion(star, position, searchRegion)) continue
		const dx = star.x - position[0]
		const dy = star.y - position[1]
		const candidateDistanceSq = dx * dx + dy * dy
		if (candidateDistanceSq < distanceSq) {
			distanceSq = candidateDistanceSq
			selected = star
		}
	}

	return selected
}

// Moves one detection to the first overlay slot without removing neighboring detections.
function moveToFront(stars: GuideStar[], star: GuideStar) {
	const index = stars.indexOf(star)
	if (index > 0) {
		stars[index] = stars[0]
		stars[0] = star
	}
}

// Selects the nearest acquisition candidate, honoring an explicit initial image position.
function pickAcquisition(stars: readonly GuideStar[], initialPosition?: readonly [number, number]) {
	if (initialPosition === undefined) return stars[0]
	let selected: GuideStar | undefined
	let distanceSq = Number.POSITIVE_INFINITY

	for (const star of stars) {
		const dx = star.x - initialPosition[0]
		const dy = star.y - initialPosition[1]
		const candidateDistanceSq = dx * dx + dy * dy
		if (candidateDistanceSq < distanceSq) {
			distanceSq = candidateDistanceSq
			selected = star
		}
	}

	return selected
}

// Finds an accepted detection within the identity association radius.
function nearestWithin(stars: readonly GuideStar[], position: readonly [number, number], maxDistancePx: number) {
	let selected: GuideStar | undefined
	let distanceSq = maxDistancePx * maxDistancePx

	for (const star of stars) {
		const dx = star.x - position[0]
		const dy = star.y - position[1]
		const candidateDistanceSq = dx * dx + dy * dy
		if (candidateDistanceSq <= distanceSq) {
			distanceSq = candidateDistanceSq
			selected = star
		}
	}

	return selected
}

// Converts quality into the generic confidence range without allowing non-finite values.
function confidenceOf(qualityScore: number) {
	return Number.isFinite(qualityScore) ? clamp(qualityScore, 0, 1) : 0
}

// Exposes stellar telemetry only when a primary detection exists.
function telemetryOf(star: GuideStar | undefined): GuideTrackerTelemetry | undefined {
	return star === undefined ? undefined : { signalToNoise: star.snr, mass: star.flux, hfdPx: star.hfd }
}
