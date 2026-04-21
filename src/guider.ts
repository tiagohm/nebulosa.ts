import type { Image } from './image.types'
import { clamp } from './math'
import { Matrix } from './matrix'
import type { DetectedStar } from './star.detector'
import { medianAbsoluteDeviationOf, medianOf } from './util'

export type GuideDirectionRA = 'west' | 'east'

export type GuideDirectionDEC = 'north' | 'south'

export type DeclinationGuideMode = 'auto' | 'north-only' | 'south-only' | 'off'

export type GuidingMode = 'single-star' | 'multi-star'

export interface GuideStar extends DetectedStar {
	readonly valid?: boolean
	readonly saturated?: boolean
	readonly peak?: number
	readonly ellipticity?: number
	readonly fwhm?: number
}

export interface GuideFrame {
	readonly stars: readonly GuideStar[]
	readonly width: number
	readonly height: number
	readonly timestamp?: number // ms
	readonly frameId?: number
}

export interface AxisPulse {
	readonly direction: GuideDirectionRA | GuideDirectionDEC | null
	readonly duration: number // ms
}

export interface GuideCommand {
	readonly state: GuiderState
	readonly ra: AxisPulse
	readonly dec: AxisPulse
	readonly diagnostics: GuideDiagnostics
}

export interface GuideDiagnostics {
	readonly frameId?: number
	readonly totalStars: number
	readonly acceptedStars: number
	readonly qualityScore: number
	readonly modeUsed: GuidingMode | null
	readonly measurementX?: number
	readonly measurementY?: number
	readonly referenceX?: number
	readonly referenceY?: number
	readonly targetX?: number
	readonly targetY?: number
	readonly dx?: number // px
	readonly dy?: number // px
	readonly axisErrorRA?: number
	readonly axisErrorDEC?: number
	readonly filteredRA?: number
	readonly filteredDEC?: number
	readonly rejectedReasons: Readonly<Record<string, number>>
	readonly badFrame: boolean
	readonly lostFrames: number
	readonly lost: boolean
	readonly ditherActive: boolean
	readonly droppedFrame: boolean
	readonly notes: readonly string[]
}

export type CalibrationMatrix = readonly [number, number, number, number]

export interface StarFilterConfig {
	readonly minStarSnr: number
	readonly minFlux: number
	readonly maxHfd: number
	readonly borderMarginPx: number
	readonly maxEllipticity: number
	readonly maxFwhm?: number
	readonly saturationPeak?: number
}

export interface GuiderConfig {
	readonly mode: GuidingMode
	readonly calibration: CalibrationMatrix
	readonly referencePosition?: readonly [number, number] // px
	readonly initialPosition?: readonly [number, number] // px
	readonly lockAveragingFrames: number
	readonly maxMatchDistancePx: number
	readonly maxFrameJumpPx: number
	readonly outlierSigma: number
	readonly minFrameQuality: number
	readonly lostStarFrameCount: number
	readonly nominalCadence: number // ms
	readonly droppedFrameFactor: number
	readonly minMoveRA: number
	readonly minMoveDEC: number
	readonly aggressivenessRA: number
	readonly aggressivenessDEC: number
	readonly hysteresisRA: number
	readonly hysteresisDEC: number
	readonly msPerRAUnit: number
	readonly msPerDECUnit: number
	readonly minPulseMsRA: number
	readonly maxPulseMsRA: number
	readonly minPulseMsDEC: number
	readonly maxPulseMsDEC: number
	readonly raPositiveDirection: GuideDirectionRA
	readonly decPositiveDirection: GuideDirectionDEC
	readonly decMode: DeclinationGuideMode
	readonly decReversalThreshold: number
	readonly decBacklashAccumThreshold: number
	readonly filter: StarFilterConfig
}

export interface FilteredStars {
	readonly accepted: GuideStar[]
	readonly rejectedReasons: Record<string, number>
	readonly qualityScore: number
}

export interface TranslationMeasurement {
	readonly x: number
	readonly y: number
	readonly usedMode: GuidingMode
	readonly matches: number
}

export type GuiderState = 'idle' | 'initializing' | 'guiding' | 'lost'

interface LockSample {
	readonly x: number
	readonly y: number
	readonly stars: readonly GuideStar[]
}

interface GuiderInternalState {
	state: GuiderState
	lockSamples: LockSample[]
	referenceX: number
	referenceY: number
	measurementOriginX: number
	measurementOriginY: number
	referenceStars: GuideStar[]
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
	lastDecDirection: GuideDirectionDEC | null
	oppositeDecErrorAccum: number
	lastDiagnostics: GuideDiagnostics
}

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

export interface ConfigIssue {
	readonly key: string
	readonly reason: string
}

export interface GuideStarSelectionConfig {
	readonly filter: StarFilterConfig
	readonly minNeighborDistancePx: number
	readonly minNeighborDistanceHfdRatio: number
	readonly alternativeSeparationPx: number
	readonly maxAlternatives: number
}

export interface GuideStarSelectionOptions {
	readonly filter?: Partial<StarFilterConfig>
	readonly minNeighborDistancePx?: number
	readonly minNeighborDistanceHfdRatio?: number
	readonly alternativeSeparationPx?: number
	readonly maxAlternatives?: number
}

export interface SelectedGuideStar extends GuideStar {
	readonly score: number
	readonly edgeDistance: number
	readonly centerDistance: number
	readonly nearestNeighborDistance: number
	readonly nearSaturation: boolean
}

export interface GuideStarSelection {
	readonly primary?: SelectedGuideStar
	readonly alternatives: SelectedGuideStar[]
	readonly candidates: SelectedGuideStar[]
	readonly rejectedReasons: Record<string, number>
	readonly qualityScore: number
}

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
	raPositiveDirection: 'west',
	decPositiveDirection: 'north',
	decMode: 'auto',
	decReversalThreshold: 0.08,
	decBacklashAccumThreshold: 0.32,
	filter: {
		minStarSnr: 8,
		minFlux: 100,
		maxHfd: 10,
		borderMarginPx: 10,
		maxEllipticity: 0.5,
		maxFwhm: 12,
		saturationPeak: 65500,
	},
}

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

// Filters stars and emits both accepted stars and rejection diagnostics.
export function filterGuideStars(frame: GuideFrame, config: StarFilterConfig): FilteredStars {
	const accepted: GuideStar[] = []
	const rejectedReasons: Record<string, number> = {}
	const borderRight = frame.width - config.borderMarginPx
	const borderBottom = frame.height - config.borderMarginPx

	for (const star of frame.stars) {
		const reason = rejectStarReason(star, config, borderRight, borderBottom, config.borderMarginPx)

		if (reason !== null) {
			rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1
			continue
		}

		accepted.push(star)
	}

	const ratio = frame.stars.length > 0 ? accepted.length / frame.stars.length : 0
	const qualityScore = clamp(ratio, 0, 1)
	return { accepted, rejectedReasons, qualityScore }
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
	return null
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

	if (count === 0) return null

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

	const median = medianOf(residual.toSorted())
	const mad = medianAbsoluteDeviationOf(residual, median, true)
	const scale = Math.max(mad, 1e-9)
	const threshold = outlierSigma * scale
	let kept = 0

	for (let i = 0; i < count; i++) {
		if (Math.abs(residual[i] - median) <= threshold) kept++
	}

	if (kept === 0) return null
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

const NO_PULSE: AxisPulse = { direction: null, duration: 0 }

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
	filteredRA: 0,
	filteredDEC: 0,
	lastDecDirection: null,
	oppositeDecErrorAccum: 0,
	lastCadence: 0,
	lastDiagnostics: {
		totalStars: 0,
		acceptedStars: 0,
		qualityScore: 0,
		modeUsed: null,
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

	// Starts dithering by shifting lock target without touching calibration.
	startDither(dx: number, dy: number) {
		this.state.ditherOffsetX = dx
		this.state.ditherOffsetY = dy
		this.state.ditherActive = true
	}

	// Stops dithering and re-targets lock back to reference center.
	stopDither() {
		this.state.ditherOffsetX = 0
		this.state.ditherOffsetY = 0
		this.state.ditherActive = false
	}

	// Processes one frame and returns RA/DEC pulse commands.
	processFrame(frame: GuideFrame): GuideCommand {
		if (this.state.state === 'idle') {
			this.state.state = 'initializing'
			this.state.lockSamples.length = 0
			this.state.referenceStars.length = 0
		}

		if (this.state.state === 'initializing') {
			this.#processInitializationFrame(frame)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics }
		}

		const filtered = filterGuideStars(frame, this.config.filter)
		const droppedFrame = this.#isDroppedFrame(frame)
		const notes: string[] = []

		if (droppedFrame) notes.push('dropped_frame')

		let badFrame = filtered.accepted.length === 0 || filtered.qualityScore < this.config.minFrameQuality
		let measurement: TranslationMeasurement | null = null

		if (!badFrame) {
			measurement = this.#measureTranslation(filtered.accepted)

			if (measurement === null) {
				badFrame = true
				notes.push('measurement_failed')
			}
		}

		if (!badFrame && measurement !== null && this.#isImpossibleJump(measurement)) {
			badFrame = true
			notes.push('jump_rejected')
		}

		if (badFrame) {
			this.state.consecutiveBadFrames++
			if (this.state.consecutiveBadFrames >= this.config.lostStarFrameCount) this.state.state = 'lost'
			this.#updateDiagnostics(frame, filtered, null, droppedFrame, true, notes)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics }
		}

		this.state.consecutiveBadFrames = 0
		this.state.state = 'guiding'
		this.state.lastGoodMeasurementX = measurement!.x
		this.state.lastGoodMeasurementY = measurement!.y
		this.state.measurementOriginX = measurement!.x
		this.state.measurementOriginY = measurement!.y
		this.state.referenceStars = filtered.accepted.slice()
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
			filtered,
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

		return { state: this.state.state, ra, dec, diagnostics: this.state.lastDiagnostics }
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

	// Consumes frame while the lock reference is being averaged.
	#processInitializationFrame(frame: GuideFrame) {
		const filtered = filterGuideStars(frame, this.config.filter)

		if (filtered.accepted.length === 0) {
			this.#updateDiagnostics(frame, filtered, null, false, true, ['init_waiting'])
			return
		}

		const previous = this.state.lockSamples[this.state.lockSamples.length - 1]
		const preferred = previous === undefined ? pickInitialLockStar(filtered.accepted, this.config.initialPosition) : pickNearestGuideStar(filtered.accepted, previous.x, previous.y)

		if (preferred === undefined) {
			this.#updateDiagnostics(frame, filtered, null, false, true, ['init_no_star'])
			return
		}

		this.state.lockSamples.push({ x: preferred.x, y: preferred.y, stars: filtered.accepted.slice() })

		const [targetX, targetY] = this.config.referencePosition ?? [preferred.x, preferred.y]
		const dx = preferred.x - targetX
		const dy = preferred.y - targetY

		if (this.state.lockSamples.length < this.config.lockAveragingFrames) {
			this.#updateDiagnostics(
				frame,
				filtered,
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

			return
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
		this.state.referenceStars = this.state.lockSamples[this.state.lockSamples.length - 1].stars.slice()
		this.state.state = 'guiding'
		this.#updateDiagnostics(
			frame,
			filtered,
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
	}

	// Measures current guide position using configured mode with fallback.
	#measureTranslation(stars: readonly GuideStar[]): TranslationMeasurement | null {
		if (this.config.mode === 'multi-star' && this.state.referenceStars.length > 1 && stars.length > 1) {
			const translation = estimateTranslation(this.state.referenceStars, stars, this.config.maxMatchDistancePx, this.config.outlierSigma)

			if (translation !== null) {
				return {
					x: this.state.measurementOriginX + translation.dx,
					y: this.state.measurementOriginY + translation.dy,
					usedMode: 'multi-star',
					matches: translation.matches,
				}
			}
		}

		const single = pickNearestGuideStar(stars, this.state.measurementOriginX, this.state.measurementOriginY)
		if (single === undefined) return null
		return { x: single.x, y: single.y, usedMode: 'single-star', matches: 1 }
	}

	// Detects impossible centroid jumps to avoid runaway corrections.
	#isImpossibleJump(measurement: TranslationMeasurement) {
		if (this.state.lastGoodMeasurementX === undefined || this.state.lastGoodMeasurementY === undefined) return false
		const dx = measurement.x - this.state.lastGoodMeasurementX
		const dy = measurement.y - this.state.lastGoodMeasurementY
		return dx * dx + dy * dy > this.config.maxFrameJumpPx * this.config.maxFrameJumpPx
	}

	// Detects dropped frames from timestamp deltas.
	#isDroppedFrame({ timestamp }: GuideFrame) {
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
		if (frame.timestamp === undefined) return 1
		return clamp(this.state.lastCadence / this.config.nominalCadence, 0.5, 2)
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
		if (this.config.decMode === 'north-only' && direction !== 'north') return NO_PULSE
		if (this.config.decMode === 'south-only' && direction !== 'south') return NO_PULSE

		const last = this.state.lastDecDirection

		if (last !== null && last !== direction) {
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
	#updateDiagnostics(frame: GuideFrame, filtered: FilteredStars, measurement: DiagnosticMeasurement | null, droppedFrame: boolean, badFrame: boolean, notes: readonly string[]) {
		this.state.lastDiagnostics = {
			frameId: frame.frameId,
			totalStars: frame.stars.length,
			acceptedStars: filtered.accepted.length,
			qualityScore: filtered.qualityScore,
			modeUsed: measurement?.modeUsed ?? null,
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
	return direction === 'west' ? 'east' : 'west'
}

// Gets opposite DEC guide direction.
export function oppositeDEC(direction: GuideDirectionDEC) {
	return direction === 'north' ? 'south' : 'north'
}
