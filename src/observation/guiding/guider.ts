import type { Writable } from '../../core/types'
import { medianAbsoluteDeviationOf, medianOf } from '../../core/util'
import type { Image } from '../../imaging/model/types'
import type { DetectedStar } from '../../imaging/stars/detector'
import { Matrix } from '../../math/linear-algebra/matrix'
import { clamp } from '../../math/numerical/math'

// Self-contained autoguiding controller. Given a stream of star-detection frames and a calibration
// matrix mapping image pixels to mount RA/DEC axes, the Guider averages a lock reference, measures
// per-frame translation (single- or multi-star with robust outlier rejection), rejects bad/dropped
// frames, and emits RA/DEC pulse commands using deadband, hysteresis smoothing, cadence-aware gain,
// and DEC backlash/reversal handling. Also provides standalone star filtering and guide-star selection.
// Image coordinates are pixels; pulse durations are milliseconds; calibration is dimensionless.

// RA correction direction.
export type GuideDirectionRA = 'WEST' | 'EAST'

// DEC correction direction.
export type GuideDirectionDEC = 'NORTH' | 'SOUTH'

// DEC guiding policy; restricts or disables corrections to manage backlash.
export type DeclinationGuideMode = 'auto' | 'north-only' | 'south-only' | 'off'

// Whether translation is measured from one star or many.
export type GuidingMode = 'single-star' | 'multi-star'

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

// One guide-camera frame of detected stars.
export interface GuideFrame {
	// Stars detected in this frame.
	readonly stars: readonly GuideStar[]
	// Frame width, in pixels.
	readonly width: number
	// Frame height, in pixels.
	readonly height: number
	// Capture timestamp, in milliseconds; enables cadence and dropped-frame detection.
	readonly timestamp?: number
	// Optional monotonic frame identifier.
	readonly frameId?: number
	// Exposure duration that produced this frame, in milliseconds. When set, pulse-gain cadence
	// scaling and dropped-frame detection use this instead of the wall-clock gap between frames,
	// so a pulse wait is not treated as extra uncorrected drift or a dropped frame. Frames without
	// `cadenceMs` still classify drops from `timestamp`.
	readonly cadenceMs?: number
	// Center of the star-search window, in pixels. When set together with `searchRegion`, lock
	// quality and primary acquisition use only detections inside this box; `stars` still holds the
	// full-frame list so multi-star matching can use neighbors outside the box.
	readonly searchPosition?: readonly [number, number]
	// Side of the square star-search window, in pixels. Ignored unless `searchPosition` is set.
	readonly searchRegion?: number
}

// A commanded pulse on one mount axis.
export interface AxisPulse {
	// Pulse direction, or undefined for no motion.
	readonly direction?: GuideDirectionRA | GuideDirectionDEC
	// Pulse duration, in milliseconds.
	readonly duration: number
}

// Result of processing one frame: the resulting state and per-axis pulses with diagnostics.
export interface GuideCommand {
	// Guider state after this frame.
	readonly state: GuiderState
	// RA-axis pulse.
	readonly ra: AxisPulse
	// DEC-axis pulse.
	readonly dec: AxisPulse
	// Detailed diagnostics for this frame.
	readonly diagnostics: GuideDiagnostics
	// Stars that passed the quality filter on this frame, in detection order. This is the subset the
	// controller actually measured from, so it excludes low-SNR, saturated, elongated, and border
	// stars present in `frame.stars`. Undefined only when the command was not produced by
	// `Guider.processFrame`. The array is owned by the guider and must not be mutated.
	readonly stars?: readonly GuideStar[]
}

// Detailed per-frame telemetry for monitoring and testing.
export interface GuideDiagnostics {
	// Frame identifier, if provided.
	readonly frameId?: number
	// Total detected stars.
	readonly totalStars: number
	// Stars accepted after filtering.
	readonly acceptedStars: number
	// Accepted/total ratio in [0, 1].
	readonly qualityScore: number
	// Measurement mode actually used, or undefined when no measurement was made.
	readonly modeUsed?: GuidingMode
	// Measured guide-star X, in pixels.
	readonly measurementX?: number
	// Measured guide-star Y, in pixels.
	readonly measurementY?: number
	// Reference lock X, in pixels.
	readonly referenceX?: number
	// Reference lock Y, in pixels.
	readonly referenceY?: number
	// Target (reference + dither) X, in pixels.
	readonly targetX?: number
	// Target (reference + dither) Y, in pixels.
	readonly targetY?: number
	// Image-space error along X, in pixels.
	readonly dx?: number
	// Image-space error along Y, in pixels.
	readonly dy?: number
	// Calibrated RA-axis error.
	readonly axisErrorRA?: number
	// Calibrated DEC-axis error.
	readonly axisErrorDEC?: number
	// Hysteresis-filtered RA error.
	readonly filteredRA?: number
	// Hysteresis-filtered DEC error.
	readonly filteredDEC?: number
	// Count of rejected stars by reason.
	readonly rejectedReasons: Readonly<Record<string, number>>
	// Whether this frame was rejected.
	readonly badFrame: boolean
	// Consecutive bad-frame count.
	readonly lostFrames: number
	// Whether the guider has entered the lost state.
	readonly lost: boolean
	// Whether a dither settle is in progress. A non-zero target offset from lock-shift or a
	// finished dither does not by itself set this flag.
	readonly ditherActive: boolean
	// Whether this frame was classified as dropped by cadence.
	readonly droppedFrame: boolean
	// Free-form per-frame notes.
	readonly notes: readonly string[]
}

// Row-major 2×2 image-to-axis calibration matrix [a, b, c, d].
export type CalibrationMatrix = readonly [number, number, number, number]

// Quality and geometry thresholds used to accept or reject guide stars. Photometric thresholds
// (minStarSnr, minFlux, saturationPeak) share the sample scale of the images the stars were
// measured from; the defaults target the normalized 0..1 processing scale used across imaging.
export interface StarFilterConfig {
	// Minimum signal-to-noise ratio, as reported by the star detector for the frame's sample scale.
	readonly minStarSnr: number
	// Minimum integrated flux above background, in the frame's sample scale.
	readonly minFlux: number
	// Maximum half-flux diameter, in pixels.
	readonly maxHfd: number
	// Border exclusion margin, in pixels.
	readonly borderMarginPx: number
	// Maximum allowed ellipticity in [0, 1).
	readonly maxEllipticity: number
	// Maximum allowed FWHM, in pixels.
	readonly maxFwhm?: number
	// Peak value at/above which a star is treated as saturated, in the frame's sample scale.
	readonly saturationPeak?: number
}

// Full guider configuration. All position fields are pixels; pulse durations are milliseconds.
export interface GuiderConfig {
	// Single- or multi-star measurement mode.
	readonly mode: GuidingMode
	// Image-to-axis calibration matrix.
	readonly calibration: CalibrationMatrix
	// Optional fixed lock reference, in pixels; overrides the averaged reference.
	readonly referencePosition?: readonly [number, number]
	// Optional preferred initial lock-star position, in pixels.
	readonly initialPosition?: readonly [number, number]
	// Number of frames averaged to establish the lock reference.
	readonly lockAveragingFrames: number
	// Maximum nearest-neighbor match distance, in pixels.
	readonly maxMatchDistancePx: number
	// Maximum per-frame centroid jump before rejecting the frame, in pixels.
	readonly maxFrameJumpPx: number
	// Sigma multiplier for translation outlier rejection.
	readonly outlierSigma: number
	// Minimum acceptable frame quality score in [0, 1]. When the frame carries a search window,
	// the score is accepted/total among detections inside that box, not across the whole sensor.
	readonly minFrameQuality: number
	// Consecutive bad frames before declaring the star lost.
	readonly lostStarFrameCount: number
	// Expected frame cadence, in milliseconds.
	readonly nominalCadence: number
	// Cadence multiple above which a frame is treated as dropped.
	readonly droppedFrameFactor: number
	// RA deadband; errors below this produce no pulse.
	readonly minMoveRA: number
	// DEC deadband; errors below this produce no pulse.
	readonly minMoveDEC: number
	// RA proportional gain in [0, 1].
	readonly aggressivenessRA: number
	// DEC proportional gain in [0, 1].
	readonly aggressivenessDEC: number
	// RA hysteresis smoothing factor in [0, 1].
	readonly hysteresisRA: number
	// DEC hysteresis smoothing factor in [0, 1].
	readonly hysteresisDEC: number
	// Milliseconds of RA pulse per unit of axis error.
	readonly msPerRAUnit: number
	// Milliseconds of DEC pulse per unit of axis error.
	readonly msPerDECUnit: number
	// Minimum RA pulse, in milliseconds.
	readonly minPulseMsRA: number
	// Maximum RA pulse, in milliseconds.
	readonly maxPulseMsRA: number
	// Minimum DEC pulse, in milliseconds.
	readonly minPulseMsDEC: number
	// Maximum DEC pulse, in milliseconds.
	readonly maxPulseMsDEC: number
	// Direction corresponding to a positive RA error.
	readonly raPositiveDirection: GuideDirectionRA
	// Direction corresponding to a positive DEC error.
	readonly decPositiveDirection: GuideDirectionDEC
	// DEC guiding policy.
	readonly decMode: DeclinationGuideMode
	// Minimum magnitude to permit a DEC direction reversal.
	readonly decReversalThreshold: number
	// Accumulated opposite-direction error needed before resuming DEC pulses after a reversal.
	readonly decBacklashAccumThreshold: number
	// Star filtering thresholds.
	readonly filter: StarFilterConfig
}

// Output of star filtering: accepted stars plus rejection statistics.
export interface FilteredStars {
	// Stars that passed the filter. Freshly allocated by every filterGuideStars call and never
	// mutated afterwards, so callers may retain it directly instead of copying it.
	readonly accepted: GuideStar[]
	// Count of rejected stars by reason.
	readonly rejectedReasons: Record<string, number>
	// Accepted/total ratio in [0, 1].
	readonly qualityScore: number
}

// Estimated guide-star position with the mode and match count that produced it.
export interface TranslationMeasurement {
	// Measured X, in pixels.
	readonly x: number
	// Measured Y, in pixels.
	readonly y: number
	// Mode used for this measurement.
	readonly usedMode: GuidingMode
	// Number of star matches contributing to the estimate.
	readonly matches: number
}

// High-level guider lifecycle state.
export type GuiderState = 'idle' | 'initializing' | 'guiding' | 'lost'

// One averaged lock-acquisition sample.
interface LockSample {
	readonly x: number
	readonly y: number
	readonly stars: readonly GuideStar[]
}

// Internal mutable runtime state of the guider.
interface GuiderInternalState {
	state: GuiderState
	lockSamples: LockSample[]
	referenceX: number
	referenceY: number
	measurementOriginX: number
	measurementOriginY: number
	referenceStars: readonly GuideStar[]
	ditherOffsetX: number
	ditherOffsetY: number
	ditherActive: boolean
	lastTimestamp?: number
	lastCadence: number
	consecutiveBadFrames: number
	lastGoodMeasurementX?: number
	lastGoodMeasurementY?: number
	filteredRA: number
	filteredDEC: number
	lastDecDirection?: GuideDirectionDEC
	oppositeDecErrorAccum: number
	lastDiagnostics: GuideDiagnostics
}

// Measurement payload passed to diagnostics assembly (pixels and calibrated axis errors).
export interface DiagnosticMeasurement {
	measurementX: number
	measurementY: number
	dx: number
	dy: number
	axisErrorRA: number
	axisErrorDEC: number
	modeUsed: GuidingMode
	targetX: number
	targetY: number
	notes: readonly string[]
}

// A configuration-validation problem: which key failed and why.
export interface ConfigIssue {
	readonly key: string
	readonly reason: string
}

// Resolved configuration for guide-star selection (filter plus isolation/alternative rules).
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

// Optional overrides for guide-star selection; unset fields fall back to defaults.
export interface GuideStarSelectionOptions {
	readonly filter?: Partial<StarFilterConfig>
	readonly minNeighborDistancePx?: number
	readonly minNeighborDistanceHfdRatio?: number
	readonly alternativeSeparationPx?: number
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
	// Distance to the nearest neighbor star, in pixels.
	readonly nearestNeighborDistance: number
	// Whether the star is close to saturation.
	readonly nearSaturation: boolean
}

// Outcome of guide-star selection: the primary pick, spaced alternatives, and all candidates.
export interface GuideStarSelection {
	// Best guide star, if any qualified.
	readonly primary?: SelectedGuideStar
	// Spaced alternative guide stars.
	readonly alternatives: SelectedGuideStar[]
	// All scored candidates in ranked order.
	readonly candidates: SelectedGuideStar[]
	// Count of rejected stars by reason.
	readonly rejectedReasons: Record<string, number>
	// Accepted/total ratio in [0, 1].
	readonly qualityScore: number
}

// Default guider tuning: multi-star, identity calibration, conservative gains and pulse limits.
export const DEFAULT_GUIDER_CONFIG: Readonly<GuiderConfig> = {
	mode: 'multi-star',
	calibration: [1, 0, 0, 1],
	lockAveragingFrames: 6,
	maxMatchDistancePx: 6,
	maxFrameJumpPx: 12,
	outlierSigma: 2.5,
	minFrameQuality: 0.2,
	lostStarFrameCount: 4,
	nominalCadence: 1000,
	droppedFrameFactor: 2.5,
	minMoveRA: 0.12,
	minMoveDEC: 0.14,
	aggressivenessRA: 0.7,
	aggressivenessDEC: 0.65,
	hysteresisRA: 0.7,
	hysteresisDEC: 0.6,
	msPerRAUnit: 850,
	msPerDECUnit: 850,
	minPulseMsRA: 20,
	maxPulseMsRA: 2000,
	minPulseMsDEC: 30,
	maxPulseMsDEC: 2500,
	raPositiveDirection: 'WEST',
	decPositiveDirection: 'NORTH',
	decMode: 'auto',
	decReversalThreshold: 0.08,
	decBacklashAccumThreshold: 0.32,
	filter: {
		// Detector SNR is flux / sqrt(flux + aperturePixels * backgroundVariance), so on the normalized
		// 0..1 scale it cannot exceed sqrt(flux) and flux itself is bounded by the ~49-pixel aperture.
		// A usable guide star measures around 2..6 there; 2 keeps faint-but-trackable stars and still
		// rejects noise blobs, which stay near or below 1.
		minStarSnr: 2,
		// Integrated flux above background on the normalized scale; a single-pixel noise excursion
		// contributes far less than 1, while a trackable star reaches several units.
		minFlux: 1,
		maxHfd: 10,
		borderMarginPx: 10,
		maxEllipticity: 0.5,
		maxFwhm: 12,
		// Normalized full-scale clipping level: pixels at or above this are at the sensor ceiling.
		saturationPeak: 0.98,
	},
}

// Default guide-star selection tuning, reusing the default filter and isolation/alternative spacing.
export const DEFAULT_GUIDE_STAR_SELECTION_CONFIG: Readonly<GuideStarSelectionConfig> = {
	filter: DEFAULT_GUIDER_CONFIG.filter,
	minNeighborDistancePx: 12,
	minNeighborDistanceHfdRatio: 3.5,
	alternativeSeparationPx: 32,
	maxAlternatives: 5,
}

// Validates calibration matrix shape and determinant to avoid unstable transforms.
export function validateCalibration(calibration: CalibrationMatrix, minDeterminant = 1e-9) {
	const matrix = new Matrix(2, 2, calibration)
	const determinant = matrix.determinant
	return { valid: Number.isFinite(determinant) && Math.abs(determinant) > minDeterminant, determinant } as const
}

// Validates guider configuration limits and controller constraints.
function validateGuiderConfig(config: GuiderConfig) {
	const issues: ConfigIssue[] = []
	if (config.referencePosition !== undefined && (!Number.isFinite(config.referencePosition[0]) || !Number.isFinite(config.referencePosition[1]))) issues.push({ key: 'referencePosition', reason: 'must contain finite x/y values' })
	if (config.initialPosition !== undefined && (!Number.isFinite(config.initialPosition[0]) || !Number.isFinite(config.initialPosition[1]))) issues.push({ key: 'initialPosition', reason: 'must contain finite x/y values' })
	if (config.minMoveRA < 0) issues.push({ key: 'minMoveRA', reason: 'must be >= 0' })
	if (config.minMoveDEC < 0) issues.push({ key: 'minMoveDEC', reason: 'must be >= 0' })
	if (config.minPulseMsRA < 0) issues.push({ key: 'minPulseMsRA', reason: 'must be >= 0' })
	if (config.minPulseMsDEC < 0) issues.push({ key: 'minPulseMsDEC', reason: 'must be >= 0' })
	if (config.maxPulseMsRA < config.minPulseMsRA) issues.push({ key: 'maxPulseMsRA', reason: 'must be >= minPulseMsRA' })
	if (config.maxPulseMsDEC < config.minPulseMsDEC) issues.push({ key: 'maxPulseMsDEC', reason: 'must be >= minPulseMsDEC' })
	if (config.hysteresisRA < 0 || config.hysteresisRA > 1) issues.push({ key: 'hysteresisRA', reason: 'must be within [0, 1]' })
	if (config.hysteresisDEC < 0 || config.hysteresisDEC > 1) issues.push({ key: 'hysteresisDEC', reason: 'must be within [0, 1]' })
	if (config.maxMatchDistancePx <= 0) issues.push({ key: 'maxMatchDistancePx', reason: 'must be > 0' })
	if (config.lostStarFrameCount <= 0) issues.push({ key: 'lostStarFrameCount', reason: 'must be > 0' })
	return issues
}

// Inverts a 2x2 calibration matrix for optional inverse-transform workflows.
export function invertCalibration(calibration: CalibrationMatrix): CalibrationMatrix {
	const matrix = new Matrix(2, 2, calibration)
	const { data } = matrix.invert()
	return [data[0], data[1], data[2], data[3]]
}

// Applies calibration as axisError = calibration * imageError.
export function applyCalibration(calibration: CalibrationMatrix, dx: number, dy: number) {
	return { ra: calibration[0] * dx + calibration[1] * dy, dec: calibration[2] * dx + calibration[3] * dy } as const
}

// Returns whether two calibration matrices have identical elements.
function isCalibrationEquals(left: CalibrationMatrix, right: CalibrationMatrix) {
	return left[0] === right[0] && left[1] === right[1] && left[2] === right[2] && left[3] === right[3]
}

// Filters stars and emits both accepted stars and rejection diagnostics.
export function filterGuideStars(frame: GuideFrame, config: StarFilterConfig): FilteredStars {
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

// Returns whether `star` falls inside the square search box of side `searchRegion` centered on
// `position`. The box is axis-aligned in image pixels, matching PHD2's search region.
export function starInsideSearchRegion(star: GuideStar, position: readonly [number, number], searchRegion: number) {
	const half = searchRegion / 2
	return Math.abs(star.x - position[0]) <= half && Math.abs(star.y - position[1]) <= half
}

// Stars that participate in lock quality and primary acquisition. When the frame carries a search
// window, only detections inside that box are returned; otherwise every detection is used.
export function qualityStarsOf(frame: GuideFrame): readonly GuideStar[] {
	const { searchPosition, searchRegion, stars } = frame
	if (searchPosition === undefined || searchRegion === undefined) return stars

	const inside: GuideStar[] = []
	for (const star of stars) {
		if (starInsideSearchRegion(star, searchPosition, searchRegion)) inside.push(star)
	}
	return inside
}

// Filters stars for lock quality. When the frame carries a search window, only detections inside
// that box contribute to the quality score and the accepted lock set.
export function filterQualityGuideStars(frame: GuideFrame, config: StarFilterConfig): FilteredStars {
	const stars = qualityStarsOf(frame)
	return filterGuideStars(stars === frame.stars ? frame : { ...frame, stars }, config)
}

// Selects the strongest isolated guide star and spaced alternatives for multi-star guiding.
export function selectGuideStar(stars: readonly GuideStar[], width: number, height: number, image?: Image, options?: GuideStarSelectionOptions): GuideStarSelection {
	const config = mergeGuideStarSelectionConfig(options)
	stars = enrichGuideStars(stars, image)
	const filtered = filterGuideStars({ width, height, stars }, config.filter)
	const rejectedReasons = { ...filtered.rejectedReasons }

	if (filtered.accepted.length === 0) {
		return { primary: undefined, alternatives: [], candidates: [], rejectedReasons, qualityScore: filtered.qualityScore }
	}

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
			let separated = true

			if (minSeparationSq > 0 && distanceSqBetween(candidate, primary) < minSeparationSq) separated = false

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

// Gets rejection reason for one star using quality and geometry checks.
function rejectStarReason(star: GuideStar, config: StarFilterConfig, borderRight: number, borderBottom: number, borderLeft: number) {
	if (star.valid === false) return 'invalid'
	if (!Number.isFinite(star.x) || !Number.isFinite(star.y) || !Number.isFinite(star.snr) || !Number.isFinite(star.flux) || !Number.isFinite(star.hfd)) return 'nan'
	if (star.snr < config.minStarSnr) return 'low_snr'
	if (star.flux < config.minFlux) return 'low_flux'
	if (star.hfd > config.maxHfd) return 'high_hfd'
	if (star.saturated === true) return 'saturated'
	if (config.saturationPeak !== undefined && star.peak !== undefined && star.peak >= config.saturationPeak) return 'saturated_peak'
	if (star.ellipticity !== undefined && star.ellipticity > config.maxEllipticity) return 'elongated'
	if (config.maxFwhm !== undefined && star.fwhm !== undefined && star.fwhm > config.maxFwhm) return 'high_fwhm'
	if (star.x < borderLeft || star.y < borderLeft || star.x >= borderRight || star.y >= borderBottom) return 'border'
	return undefined
}

// Merges selector options on top of the default filtering constraints.
function mergeGuideStarSelectionConfig(options?: GuideStarSelectionOptions): GuideStarSelectionConfig {
	return {
		...DEFAULT_GUIDE_STAR_SELECTION_CONFIG,
		...options,
		filter: {
			...DEFAULT_GUIDE_STAR_SELECTION_CONFIG.filter,
			...options?.filter,
		},
	}
}

// Samples image peaks when the caller only provides detector photometry.
function enrichGuideStars(stars: readonly GuideStar[], image?: Image) {
	if (image === undefined) return stars

	const enriched = new Array<GuideStar>(stars.length)

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]

		if (star.peak !== undefined) {
			enriched[i] = star
		} else {
			enriched[i] = { ...star, peak: samplePeakAroundStar(star, image) }
		}
	}

	return enriched
}

// Measures the local maximum around a star centroid from a monochrome or RGB image.
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

// Computes a border clearance metric so centered stars outrank stars near the edge.
function edgeDistanceOf(star: GuideStar, width: number, height: number) {
	return Math.min(star.x, star.y, width - star.x, height - star.y)
}

// Computes distance from the optical center to prefer stars with stable guide windows.
function centerDistanceOf(star: GuideStar, width: number, height: number) {
	const dx = star.x - width * 0.5
	const dy = star.y - height * 0.5
	return Math.hypot(dx, dy)
}

// Detects stars that are close enough to clipping that they should be deprioritized.
function isNearSaturation(star: GuideStar, saturationPeak?: number) {
	return saturationPeak !== undefined && star.peak !== undefined && star.peak >= saturationPeak * 0.85
}

// Scores one guide-star candidate using signal, compactness, isolation and geometry.
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

// Orders stars by selection score, then by signal quality and finally by centrality.
function compareGuideStarsByScore(a: SelectedGuideStar, b: SelectedGuideStar) {
	return b.score - a.score || b.snr - a.snr || b.flux - a.flux || a.centerDistance - b.centerDistance
}

// Computes squared separation without an unnecessary square root.
function distanceSqBetween(a: GuideStar, b: GuideStar) {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return dx * dx + dy * dy
}

// Picks a stable anchor star during initialization from the first accepted star.
function pickInitialGuideStar(stars: readonly GuideStar[]) {
	return stars[0]
}

// Picks the nearest star to the previous tracked position to preserve identity.
function pickNearestGuideStar(stars: readonly GuideStar[], targetX: number, targetY: number) {
	let best: GuideStar | undefined
	let bestDistSq = Infinity

	for (const star of stars) {
		const dx = star.x - targetX
		const dy = star.y - targetY
		const distSq = dx * dx + dy * dy

		if (distSq < bestDistSq) {
			best = star
			bestDistSq = distSq
		}
	}

	return best
}

// Estimates translation from reference stars with nearest-neighbor matching.
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

// Computes robust weighted translation after outlier rejection.
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
	const scale = Math.max(mad, 1e-9)
	const threshold = outlierSigma * scale
	let kept = 0

	for (let i = 0; i < count; i++) {
		if (Math.abs(residual[i] - median) <= threshold) kept++
	}

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

// Computes weighted mean translation in x/y.
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

// Applies deadband threshold and emits zero when magnitude is below threshold.
export function applyDeadband(error: number, minMove: number) {
	return Math.abs(error) < minMove ? 0 : error
}

// Sentinel axis pulse representing no commanded motion on one axis.
export const NO_PULSE: AxisPulse = Object.freeze({ direction: undefined, duration: 0 })

// Pristine internal state cloned on construction and reset; all counters and filters start cleared.
const EMPTY_STATE: Readonly<GuiderInternalState> = {
	state: 'idle',
	lockSamples: [],
	referenceX: 0,
	referenceY: 0,
	measurementOriginX: 0,
	measurementOriginY: 0,
	referenceStars: [],
	ditherOffsetX: 0,
	ditherOffsetY: 0,
	ditherActive: false,
	consecutiveBadFrames: 0,
	// Explicit undefined so reset()'s Object.assign actually clears these optional fields.
	// Without the keys present, Object.assign would leave stale values: a stale lastGoodMeasurement
	// makes the first frame after a re-lock look like an impossible jump, and a stale lastTimestamp
	// corrupts the dropped-frame cadence check.
	lastTimestamp: undefined,
	lastGoodMeasurementX: undefined,
	lastGoodMeasurementY: undefined,
	filteredRA: 0,
	filteredDEC: 0,
	lastDecDirection: undefined,
	oppositeDecErrorAccum: 0,
	lastCadence: 0,
	lastDiagnostics: {
		totalStars: 0,
		acceptedStars: 0,
		qualityScore: 0,
		modeUsed: undefined,
		rejectedReasons: {},
		badFrame: true,
		lostFrames: 0,
		lost: false,
		ditherActive: false,
		droppedFrame: false,
		notes: [],
	},
}

// Guider implements reference lock, measurement, transform and axis control.
export class Guider {
	readonly config: GuiderConfig
	readonly state: GuiderInternalState

	constructor(config: Partial<GuiderConfig> = {}) {
		this.config = {
			...DEFAULT_GUIDER_CONFIG,
			...config,
			filter: {
				...DEFAULT_GUIDER_CONFIG.filter,
				...config.filter,
			},
		}

		const validation = validateCalibration(this.config.calibration)
		if (!validation.valid) throw new Error(`invalid calibration matrix: determinant=${validation.determinant}`)

		const configIssues = validateGuiderConfig(this.config)

		if (configIssues.length > 0) {
			const message = configIssues.map((issue) => `${issue.key}:${issue.reason}`).join(', ')
			throw new Error(`invalid guider config: ${message}`)
		}

		this.state = structuredClone(EMPTY_STATE)
		this.state.lastCadence = this.config.nominalCadence
	}

	// Clears runtime state while preserving immutable config.
	reset() {
		const empty = structuredClone(EMPTY_STATE)
		Object.assign(this.state, empty)
		this.state.lastCadence = this.config.nominalCadence
	}

	// Shifts the lock target in image pixels without marking a dither settle in progress. Lock-shift
	// and a finished dither keep a constant offset this way so `ditherActive` stays reserved for an
	// in-flight settle.
	setTargetOffset(dx: number, dy: number) {
		this.state.ditherOffsetX = dx
		this.state.ditherOffsetY = dy
	}

	// Starts dithering by shifting lock target and marking the settle in progress.
	startDither(dx: number, dy: number) {
		this.setTargetOffset(dx, dy)
		this.state.ditherActive = true
	}

	// Stops dithering and re-targets lock back to reference center.
	stopDither() {
		this.setTargetOffset(0, 0)
		this.state.ditherActive = false
	}

	// Sets or clears the in-progress dither flag without changing the target offset. Settle
	// completion uses this so a finished dither keeps its offset while no longer blocking the
	// guiding assistant.
	setDithering(active: boolean) {
		this.state.ditherActive = active
	}

	// Updates the expected frame cadence without resetting lock or hysteresis. Callers that change
	// camera exposure mid-session must keep this matched so gain scaling and dropped-frame detection
	// use the real loop instead of the constructor default.
	setNominalCadence(nominalCadence: number) {
		if (nominalCadence <= 0 || !Number.isFinite(nominalCadence)) return
		;(this.config as Writable<GuiderConfig>).nominalCadence = nominalCadence
	}

	// Updates the DEC guiding policy without resetting lock, RA hysteresis, or dither. Entering or
	// leaving `off` clears DEC filter and reversal memory: `#computeDEC` returns before updating
	// those fields while disabled, so a stale pre-disable error would otherwise pulse as soon as
	// DEC is re-enabled even if the star is already centered.
	setDecMode(decMode: DeclinationGuideMode) {
		const previous = this.config.decMode
		if (previous === decMode) return
		;(this.config as Writable<GuiderConfig>).decMode = decMode
		if (previous === 'off' || decMode === 'off') this.#clearDecControlState()
	}

	// Drops DEC hysteresis, last direction, and backlash accumulation without touching lock or dither.
	#clearDecControlState() {
		this.state.filteredDEC = 0
		this.state.lastDecDirection = undefined
		this.state.oppositeDecErrorAccum = 0
	}

	// Drops RA hysteresis without touching lock, dither, or DEC memory.
	#clearRaControlState() {
		this.state.filteredRA = 0
	}

	// Replaces the image-to-axis transform and related pulse scaling without resetting lock or
	// dither. Axis-controller memory is cleared when that axis's transform or polarity changes:
	// a meridian flip inverts the RA row and often `raPositiveDirection`, so retaining `filteredRA`
	// in the old convention blends opposite-signed errors and can pulse the pre-flip direction.
	// Pulse-scale-only updates keep hysteresis because `filteredRA` stays in axis-error units.
	setCalibration(calibration: CalibrationMatrix, options: Partial<Pick<GuiderConfig, 'msPerRAUnit' | 'msPerDECUnit' | 'minMoveRA' | 'minMoveDEC' | 'decReversalThreshold' | 'decBacklashAccumThreshold' | 'raPositiveDirection' | 'decPositiveDirection'>> = {}) {
		const validation = validateCalibration(calibration)
		if (!validation.valid) throw new Error(`invalid calibration matrix: determinant=${validation.determinant}`)

		const previousCalibration = this.config.calibration
		const previousRaDirection = this.config.raPositiveDirection
		const previousDecDirection = this.config.decPositiveDirection
		const next: GuiderConfig = { ...this.config, calibration, ...options }
		const issues = validateGuiderConfig(next)
		if (issues.length > 0) {
			const message = issues.map((issue) => `${issue.key}:${issue.reason}`).join(', ')
			throw new Error(`invalid guider config: ${message}`)
		}

		Object.assign(this.config as Writable<GuiderConfig>, next)

		const calibrationChanged = !isCalibrationEquals(next.calibration, previousCalibration)
		if (next.raPositiveDirection !== previousRaDirection || calibrationChanged) {
			this.#clearRaControlState()
		}
		if (next.decPositiveDirection !== previousDecDirection || calibrationChanged) {
			this.#clearDecControlState()
		}
	}

	// Processes one frame and returns RA/DEC pulse commands.
	processFrame(frame: GuideFrame): GuideCommand {
		if (this.state.state === 'idle') {
			this.state.state = 'initializing'
			this.state.lockSamples.length = 0
			this.state.referenceStars = []
		}

		if (this.state.state === 'initializing') {
			const stars = this.#processInitializationFrame(frame)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics, stars }
		}

		const quality = filterQualityGuideStars(frame, this.config.filter)
		const filtered = filterGuideStars(frame, this.config.filter)
		const droppedFrame = this.#isDroppedFrame(frame)
		const notes: string[] = []

		if (droppedFrame) notes.push('dropped_frame')

		let badFrame = quality.accepted.length === 0 || quality.qualityScore < this.config.minFrameQuality
		let measurement: TranslationMeasurement | undefined

		if (!badFrame) {
			measurement = this.#measureTranslation(filtered.accepted)

			if (measurement === undefined) {
				badFrame = true
				notes.push('measurement_failed')
			}
		}

		// A commanded dither walk can exceed maxFrameJumpPx in one pulse; that motion is expected,
		// not a meteor or wrong-star swap.
		if (!badFrame && measurement !== undefined && !this.state.ditherActive && this.#isImpossibleJump(measurement)) {
			badFrame = true
			notes.push('jump_rejected')
		}

		if (badFrame) {
			this.state.consecutiveBadFrames++
			if (this.state.consecutiveBadFrames >= this.config.lostStarFrameCount) this.state.state = 'lost'
			this.#updateDiagnostics(frame, quality, undefined, droppedFrame, true, notes)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics, stars: filtered.accepted }
		}

		this.state.consecutiveBadFrames = 0
		this.state.state = 'guiding'
		this.state.lastGoodMeasurementX = measurement!.x
		this.state.lastGoodMeasurementY = measurement!.y
		this.state.measurementOriginX = measurement!.x
		this.state.measurementOriginY = measurement!.y
		this.state.referenceStars = filtered.accepted
		const targetX = this.state.referenceX + this.state.ditherOffsetX
		const targetY = this.state.referenceY + this.state.ditherOffsetY
		const dx = measurement!.x - targetX
		const dy = measurement!.y - targetY
		const axisError = applyCalibration(this.config.calibration, dx, dy)
		const cadenceScale = this.#cadenceScale(frame)
		const ra = this.#computeRA(axisError.ra, cadenceScale)
		const dec = this.#computeDEC(axisError.dec, cadenceScale)
		this.#updateDiagnostics(
			frame,
			quality,
			{
				measurementX: measurement!.x,
				measurementY: measurement!.y,
				dx,
				dy,
				axisErrorRA: axisError.ra,
				axisErrorDEC: axisError.dec,
				modeUsed: measurement!.usedMode,
				targetX,
				targetY,
				notes,
			},
			droppedFrame,
			false,
			notes,
		)

		return { state: this.state.state, ra, dec, diagnostics: this.state.lastDiagnostics, stars: filtered.accepted }
	}

	// Returns a public snapshot of current guider runtime state.
	get currentState() {
		return {
			state: this.state.state,
			referenceX: this.state.referenceX,
			referenceY: this.state.referenceY,
			ditherOffsetX: this.state.ditherOffsetX,
			ditherOffsetY: this.state.ditherOffsetY,
			ditherActive: this.state.ditherActive,
			consecutiveBadFrames: this.state.consecutiveBadFrames,
			filteredRA: this.state.filteredRA,
			filteredDEC: this.state.filteredDEC,
			lastDecDirection: this.state.lastDecDirection,
			oppositeDecErrorAccum: this.state.oppositeDecErrorAccum,
		}
	}

	// Returns diagnostics from the most recent processed frame.
	lastDiagnostics() {
		return this.state.lastDiagnostics
	}

	// Selects the best guide star and spaced alternatives using this guider's filter defaults.
	selectGuideStar(frame: GuideFrame, options?: GuideStarSelectionOptions): GuideStarSelection {
		return selectGuideStar(frame.stars, frame.width, frame.height, undefined, { ...options, filter: { ...this.config.filter, ...options?.filter } })
	}

	// Consumes frame while the lock reference is being averaged. Returns the stars accepted by the
	// quality filter on this frame so callers can surface them even before the lock is acquired.
	#processInitializationFrame(frame: GuideFrame): readonly GuideStar[] {
		const quality = filterQualityGuideStars(frame, this.config.filter)
		const filtered = filterGuideStars(frame, this.config.filter)

		if (quality.accepted.length === 0) {
			this.#updateDiagnostics(frame, quality, undefined, false, true, ['init_waiting'])
			return filtered.accepted
		}

		const previous = this.state.lockSamples.at(-1)
		const preferred = previous === undefined ? pickInitialLockStar(quality.accepted, this.config.initialPosition) : pickNearestGuideStar(quality.accepted, previous.x, previous.y)

		if (preferred === undefined) {
			this.#updateDiagnostics(frame, quality, undefined, false, true, ['init_no_star'])
			return filtered.accepted
		}

		this.state.lockSamples.push({ x: preferred.x, y: preferred.y, stars: filtered.accepted })

		const [targetX, targetY] = this.config.referencePosition ?? [preferred.x, preferred.y]
		const dx = preferred.x - targetX
		const dy = preferred.y - targetY

		if (this.state.lockSamples.length < this.config.lockAveragingFrames) {
			this.#updateDiagnostics(
				frame,
				quality,
				{
					measurementX: preferred.x,
					measurementY: preferred.y,
					dx,
					dy,
					axisErrorRA: 0,
					axisErrorDEC: 0,
					modeUsed: 'single-star',
					targetX,
					targetY,
					notes: ['init_collecting'],
				},
				false,
				true,
				['init_collecting'],
			)

			return filtered.accepted
		}

		let sumX = 0
		let sumY = 0

		for (const sample of this.state.lockSamples) {
			sumX += sample.x
			sumY += sample.y
		}

		const referenceX = sumX / this.state.lockSamples.length
		const referenceY = sumY / this.state.lockSamples.length
		this.state.referenceX = this.config.referencePosition?.[0] ?? referenceX
		this.state.referenceY = this.config.referencePosition?.[1] ?? referenceY
		this.state.measurementOriginX = preferred.x
		this.state.measurementOriginY = preferred.y
		this.state.referenceStars = this.state.lockSamples.at(-1)!.stars
		this.state.state = 'guiding'
		this.#updateDiagnostics(
			frame,
			quality,
			{
				measurementX: preferred.x,
				measurementY: preferred.y,
				dx: preferred.x - this.state.referenceX,
				dy: preferred.y - this.state.referenceY,
				axisErrorRA: 0,
				axisErrorDEC: 0,
				modeUsed: this.config.mode,
				targetX: this.state.referenceX,
				targetY: this.state.referenceY,
				notes: ['lock_acquired'],
			},
			false,
			false,
			['lock_acquired'],
		)

		return filtered.accepted
	}

	// Measures current guide position using configured mode with fallback.
	#measureTranslation(stars: readonly GuideStar[]): TranslationMeasurement | undefined {
		if (this.config.mode === 'multi-star' && this.state.referenceStars.length > 1 && stars.length > 1) {
			const translation = estimateTranslation(this.state.referenceStars, stars, this.config.maxMatchDistancePx, this.config.outlierSigma)

			if (translation !== undefined) {
				return {
					x: this.state.measurementOriginX + translation.dx,
					y: this.state.measurementOriginY + translation.dy,
					usedMode: 'multi-star',
					matches: translation.matches,
				}
			}
		}

		const single = pickNearestGuideStar(stars, this.state.measurementOriginX, this.state.measurementOriginY)
		if (single === undefined) return undefined
		return { x: single.x, y: single.y, usedMode: 'single-star', matches: 1 }
	}

	// Detects impossible centroid jumps to avoid runaway corrections.
	#isImpossibleJump(measurement: TranslationMeasurement) {
		if (this.state.lastGoodMeasurementX === undefined || this.state.lastGoodMeasurementY === undefined) return false
		const dx = measurement.x - this.state.lastGoodMeasurementX
		const dy = measurement.y - this.state.lastGoodMeasurementY
		return dx * dx + dy * dy > this.config.maxFrameJumpPx * this.config.maxFrameJumpPx
	}

	// Detects dropped frames. When the frame reports the exposure that produced it, classify from
	// that cadence rather than the wall-clock gap so an ST4 pulse wait is not a drop. Frames
	// without `cadenceMs` still use timestamp deltas.
	#isDroppedFrame(frame: GuideFrame) {
		const { timestamp, cadenceMs } = frame

		if (cadenceMs !== undefined) {
			if (timestamp !== undefined) this.state.lastTimestamp = timestamp
			if (cadenceMs > 0) this.state.lastCadence = cadenceMs
			return cadenceMs > this.config.nominalCadence * this.config.droppedFrameFactor
		}

		if (timestamp === undefined) return false

		const lastTimestamp = this.state.lastTimestamp

		if (lastTimestamp === undefined) {
			this.state.lastTimestamp = timestamp
			this.state.lastCadence = this.config.nominalCadence
			return false
		}

		const dt = Math.max(1, timestamp - lastTimestamp)
		this.state.lastTimestamp = timestamp
		this.state.lastCadence = dt
		return dt > this.config.nominalCadence * this.config.droppedFrameFactor
	}

	// Computes frame cadence scale to keep pulse gain stable across variable cadence.
	#cadenceScale(frame: GuideFrame) {
		const cadence = frame.cadenceMs ?? (frame.timestamp === undefined ? this.config.nominalCadence : this.state.lastCadence)
		if (cadence <= 0 || this.config.nominalCadence <= 0) return 1
		return clamp(cadence / this.config.nominalCadence, 0.5, 2)
	}

	// Computes RA pulse with hysteresis smoothing, deadband and proportional gain.
	#computeRA(axisErrorRA: number, cadenceScale: number): AxisPulse {
		const deadbanded = applyDeadband(axisErrorRA, this.config.minMoveRA)
		this.state.filteredRA = this.config.hysteresisRA * this.state.filteredRA + (1 - this.config.hysteresisRA) * deadbanded
		const magnitude = Math.abs(this.state.filteredRA)
		if (magnitude < this.config.minMoveRA) return NO_PULSE
		const duration = clamp(magnitude * this.config.msPerRAUnit * this.config.aggressivenessRA * cadenceScale, this.config.minPulseMsRA, this.config.maxPulseMsRA)
		const direction = this.state.filteredRA >= 0 ? this.config.raPositiveDirection : oppositeRA(this.config.raPositiveDirection)
		return { direction, duration }
	}

	// Computes DEC pulse with backlash-aware reversal suppression and mode constraints.
	#computeDEC(axisErrorDEC: number, cadenceScale: number): AxisPulse {
		if (this.config.decMode === 'off') return NO_PULSE

		const deadbanded = applyDeadband(axisErrorDEC, this.config.minMoveDEC)
		this.state.filteredDEC = this.config.hysteresisDEC * this.state.filteredDEC + (1 - this.config.hysteresisDEC) * deadbanded

		const magnitude = Math.abs(this.state.filteredDEC)
		if (magnitude < this.config.minMoveDEC) return NO_PULSE

		const direction = this.state.filteredDEC >= 0 ? this.config.decPositiveDirection : oppositeDEC(this.config.decPositiveDirection)
		if (this.config.decMode === 'north-only' && direction !== 'NORTH') return NO_PULSE
		if (this.config.decMode === 'south-only' && direction !== 'SOUTH') return NO_PULSE

		const last = this.state.lastDecDirection

		if (last !== undefined && last !== direction) {
			if (magnitude < this.config.decReversalThreshold) return NO_PULSE
			this.state.oppositeDecErrorAccum += magnitude
			if (this.state.oppositeDecErrorAccum < this.config.decBacklashAccumThreshold) return NO_PULSE
		} else {
			this.state.oppositeDecErrorAccum = 0
		}

		const duration = clamp(magnitude * this.config.msPerDECUnit * this.config.aggressivenessDEC * cadenceScale, this.config.minPulseMsDEC, this.config.maxPulseMsDEC)
		this.state.lastDecDirection = direction
		this.state.oppositeDecErrorAccum = 0
		return { direction, duration }
	}

	// Updates diagnostics payload for telemetry and testing.
	#updateDiagnostics(frame: GuideFrame, filtered: FilteredStars, measurement: DiagnosticMeasurement | undefined, droppedFrame: boolean, badFrame: boolean, notes: readonly string[]) {
		this.state.lastDiagnostics = {
			frameId: frame.frameId,
			totalStars: qualityStarsOf(frame).length,
			acceptedStars: filtered.accepted.length,
			qualityScore: filtered.qualityScore,
			modeUsed: measurement?.modeUsed,
			measurementX: measurement?.measurementX,
			measurementY: measurement?.measurementY,
			referenceX: this.state.referenceX,
			referenceY: this.state.referenceY,
			targetX: measurement?.targetX,
			targetY: measurement?.targetY,
			dx: measurement?.dx,
			dy: measurement?.dy,
			axisErrorRA: measurement?.axisErrorRA,
			axisErrorDEC: measurement?.axisErrorDEC,
			filteredRA: this.state.filteredRA,
			filteredDEC: this.state.filteredDEC,
			rejectedReasons: filtered.rejectedReasons,
			badFrame,
			lostFrames: this.state.consecutiveBadFrames,
			lost: this.state.state === 'lost',
			ditherActive: this.state.ditherActive,
			droppedFrame,
			notes,
		}
	}
}

// Picks the initial lock star from an explicit reference point when provided.
function pickInitialLockStar(stars: readonly GuideStar[], referencePosition?: readonly [number, number]) {
	if (referencePosition !== undefined) return pickNearestGuideStar(stars, referencePosition[0], referencePosition[1])
	return pickInitialGuideStar(stars)
}

// Gets opposite RA guide direction.
export function oppositeRA(direction: GuideDirectionRA) {
	return direction === 'WEST' ? 'EAST' : 'WEST'
}

// Gets opposite DEC guide direction.
export function oppositeDEC(direction: GuideDirectionDEC) {
	return direction === 'NORTH' ? 'SOUTH' : 'NORTH'
}
