import { detectStars } from '../../imaging/stars/detector'
import { clamp } from '../../math/numerical/math'
import { type GuideFrame, type GuideStar, type GuideStarSelectionConfig, type GuidingMode, enrichGuideStars, estimateTranslation, filterGuideStars, filterQualityGuideStars, selectGuideStar, starInsideSearchRegion } from './guider'
import type { GuideMeasurement, GuideTracker, GuideTrackerContext, GuideTrackerFrame, GuideTrackerResult, GuideTrackerTelemetry } from './tracker'

// Star-based implementation of the generic guide tracker. It performs one detector pass per image,
// enriches peaks once, preserves the selected identity, and exposes a frame-local stellar result
// for the controller, calibration state machine, PHD2 events, and overlay.

// Star filtering and geometry configuration owned by StarTracker rather than the pulse controller.
export type { FilteredStars, GuideStar, GuideStarSelection, GuideStarSelectionConfig, GuideStarSelectionOptions, SelectedGuideStar, StarFilterConfig, TranslationMeasurement } from './guider'

// Configuration for stellar acquisition, identity matching, and robust multi-star translation.
export interface StarTrackerConfig {
	// Single- or multi-star measurement mode.
	readonly mode: GuidingMode
	// Maximum nearest-neighbor association distance, in pixels.
	readonly maxMatchDistancePx: number
	// Sigma multiplier used by robust translation rejection.
	readonly outlierSigma: number
	// Quality and geometry thresholds applied to detections.
	readonly filter: import('./guider').StarFilterConfig
	// Initial selection, isolation, and alternative-star rules.
	readonly selection: GuideStarSelectionConfig
}

// Default star-tracker configuration, preserving the previous guider's stellar tuning.
export const DEFAULT_STAR_TRACKER_CONFIG: Readonly<StarTrackerConfig> = {
	mode: 'multi-star',
	maxMatchDistancePx: 6,
	outlierSigma: 2.5,
	filter: {
		minStarSnr: 2,
		minFlux: 1,
		maxHfd: 10,
		borderMarginPx: 10,
		maxEllipticity: 0.5,
		maxFwhm: 12,
		saturationPeak: 0.98,
	},
	selection: {
		filter: {
			minStarSnr: 2,
			minFlux: 1,
			maxHfd: 10,
			borderMarginPx: 10,
			maxEllipticity: 0.5,
			maxFwhm: 12,
			saturationPeak: 0.98,
		},
		minNeighborDistancePx: 12,
		minNeighborDistanceHfdRatio: 3.5,
		alternativeSeparationPx: 32,
		maxAlternatives: 5,
	},
}

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
	readonly modeUsed?: GuidingMode
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

		const frameForFilter: GuideFrame = {
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

		if (primaryInsideSearchRegion && accepted.length > 0 && (this.#measurementOrigin === undefined || !context.preserveIdentity)) {
			const acquired = pickAcquisition(quality.accepted, context.initialPosition)
			if (acquired !== undefined && context.allowAcquisition) {
				this.#measurementOrigin = [acquired.x, acquired.y]
				this.#referenceStars = accepted
				this.#lastMeasurement = { x: acquired.x, y: acquired.y, confidence: confidenceOf(quality.qualityScore) }
				measurement = this.#lastMeasurement
				measurementMode = 'single-star'
				matches = 1
				notes.push('acquired')
			}
		} else if (primaryInsideSearchRegion && accepted.length > 0 && this.#measurementOrigin !== undefined) {
			const translation = this.#measureTranslation(accepted)
			if (translation !== undefined) {
				measurement = { x: translation.x, y: translation.y, confidence: confidenceOf(quality.qualityScore) }
				this.#lastMeasurement = measurement
				measurementMode = translation.mode
				matches = translation.matches
			}
		}

		if (measurement === undefined && primaryInsideSearchRegion && accepted.length > 0 && context.allowAcquisition && this.#measurementOrigin !== undefined) {
			const fallback = nearestWithin(accepted, this.#measurementOrigin, this.config.maxMatchDistancePx)
			if (fallback !== undefined) {
				measurement = { x: fallback.x, y: fallback.y, confidence: confidenceOf(quality.qualityScore) }
				this.#lastMeasurement = measurement
				measurementMode = 'single-star'
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
			modeUsed: measurementMode,
			matches,
		})
	}

	// Estimates current translation from the stored identity, falling back to one-star association.
	#measureTranslation(stars: readonly GuideStar[]) {
		if (this.#measurementOrigin === undefined) return undefined

		if (this.config.mode === 'multi-star' && this.#referenceStars.length > 1 && stars.length > 1) {
			const translation = estimateTranslation(this.#referenceStars, stars, this.config.maxMatchDistancePx, this.config.outlierSigma)
			if (translation !== undefined) return { x: this.#measurementOrigin[0] + translation.dx, y: this.#measurementOrigin[1] + translation.dy, mode: 'multi-star' as const, matches: translation.matches }
		}

		const nearest = nearestWithin(stars, this.#measurementOrigin, this.config.maxMatchDistancePx)
		return nearest === undefined ? undefined : { x: nearest.x, y: nearest.y, mode: 'single-star' as const, matches: 1 }
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
