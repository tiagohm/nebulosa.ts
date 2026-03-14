import { Matrix } from './matrix'
import type { DetectedStar } from './stardetector'
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
	referenceStars: GuideStar[]
	ditherOffsetX: number
	ditherOffsetY: number
	ditherActive: boolean
	lastTimestamp?: number
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

// Validates calibration matrix shape and determinant to avoid unstable transforms.
export function validateCalibration(calibration: CalibrationMatrix, minDeterminant = 1e-9) {
	const matrix = new Matrix(2, 2, calibration)
	const determinant = matrix.determinant
	return { valid: Number.isFinite(determinant) && Math.abs(determinant) > minDeterminant, determinant } as const
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

// Gets rejection reason for one star using quality and geometry checks.
function rejectStarReason(star: GuideStar, config: StarFilterConfig, borderRight: number, borderBottom: number, borderLeft: number) {
	if (star.valid === false) return 'invalid'
	if (!Number.isFinite(star.x) || !Number.isFinite(star.y) || !Number.isFinite(star.snr) || !Number.isFinite(star.flux) || !Number.isFinite(star.hfd)) return 'nan'
	if (star.snr < config.minStarSnr) return 'low_snr'
	if (star.flux < config.minFlux) return 'low_flux'
	if (star.hfd > config.maxHfd) return 'high_hfd'
	if (star.saturated === true) return 'saturated'
	if (config.saturationPeak !== undefined && star.peak !== undefined && star.peak >= config.saturationPeak) return 'saturated_peak'
	if (star.x < borderLeft || star.y < borderLeft || star.x >= borderRight || star.y >= borderBottom) return 'border'
	if (star.ellipticity !== undefined && star.ellipticity > config.maxEllipticity) return 'elongated'
	if (config.maxFwhm !== undefined && star.fwhm !== undefined && star.fwhm > config.maxFwhm) return 'high_fwhm'
	return null
}

// Picks highest quality star for single-star fallback and initialization.
function pickGuideStar(stars: readonly GuideStar[]) {
	let best: GuideStar | undefined
	let bestScore = -1

	for (const star of stars) {
		const score = (star.snr * Math.sqrt(Math.max(star.flux, 1))) / Math.max(star.hfd, 0.5)

		if (score > bestScore) {
			best = star
			bestScore = score
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
	const trimmed = robustWeightedTranslation(dx, dy, weights, count, outlierSigma)
	if (trimmed === null) return null
	return { dx: trimmed.dx, dy: trimmed.dy, matches: trimmed.matches }
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

	let j = 0

	for (let i = 0; i < count; i++) {
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

// Clamps numeric value inside [min, max].
function clamp(value: number, min: number, max: number) {
	if (value < min) return min
	if (value > max) return max
	return value
}

const NO_PULSE_COMMAND: AxisPulse = { direction: null, duration: 0 }

const EMPTY_STATE: Readonly<GuiderInternalState> = {
	state: 'idle',
	lockSamples: [],
	referenceX: 0,
	referenceY: 0,
	referenceStars: [],
	ditherOffsetX: 0,
	ditherOffsetY: 0,
	ditherActive: false,
	consecutiveBadFrames: 0,
	filteredRA: 0,
	filteredDEC: 0,
	lastDecDirection: null,
	oppositeDecErrorAccum: 0,
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
				...(config.filter ?? {}),
			},
		}

		const validation = validateCalibration(this.config.calibration)
		if (!validation.valid) throw new Error(`invalid calibration matrix: determinant=${validation.determinant}`)
		this.state = structuredClone(EMPTY_STATE)
	}

	// Clears runtime state while preserving immutable config.
	reset() {
		Object.assign(this.state, structuredClone(EMPTY_STATE))
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
			this.processInitializationFrame(frame)

			return {
				state: this.state.state,
				ra: NO_PULSE_COMMAND,
				dec: NO_PULSE_COMMAND,
				diagnostics: this.state.lastDiagnostics,
			}
		}

		const filtered = filterGuideStars(frame, this.config.filter)
		const previousTimestamp = this.state.lastTimestamp
		if (frame.timestamp !== undefined) this.state.lastTimestamp = frame.timestamp
		const droppedFrame = this.isDroppedFrame(frame, previousTimestamp)
		const notes: string[] = []

		if (droppedFrame) notes.push('dropped_frame')

		let badFrame = filtered.accepted.length === 0 || filtered.qualityScore < this.config.minFrameQuality
		let measurement: TranslationMeasurement | null = null

		if (!badFrame) {
			measurement = this.measureTranslation(filtered.accepted)

			if (measurement === null) {
				badFrame = true
				notes.push('measurement_failed')
			}
		}

		if (!badFrame && measurement !== null && this.isImpossibleJump(measurement)) {
			badFrame = true
			notes.push('jump_rejected')
		}

		if (badFrame) {
			this.state.consecutiveBadFrames++
			if (this.state.consecutiveBadFrames >= this.config.lostStarFrameCount) this.state.state = 'lost'
			this.updateDiagnostics(frame, filtered, null, droppedFrame, true, notes)

			return {
				state: this.state.state,
				ra: NO_PULSE_COMMAND,
				dec: NO_PULSE_COMMAND,
				diagnostics: this.state.lastDiagnostics,
			}
		}

		this.state.consecutiveBadFrames = 0
		this.state.state = 'guiding'
		this.state.lastGoodMeasurementX = measurement!.x
		this.state.lastGoodMeasurementY = measurement!.y
		const targetX = this.state.referenceX + this.state.ditherOffsetX
		const targetY = this.state.referenceY + this.state.ditherOffsetY
		const dx = measurement!.x - targetX
		const dy = measurement!.y - targetY
		const axisError = applyCalibration(this.config.calibration, dx, dy)
		const cadenceScale = this.cadenceScale(frame, previousTimestamp)
		const ra = this.computeRA(axisError.ra, cadenceScale)
		const dec = this.computeDEC(axisError.dec, cadenceScale)
		this.updateDiagnostics(
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

	// Consumes frame while the lock reference is being averaged.
	private processInitializationFrame(frame: GuideFrame) {
		const filtered = filterGuideStars(frame, this.config.filter)

		if (filtered.accepted.length === 0) {
			this.updateDiagnostics(frame, filtered, null, false, true, ['init_waiting'])
			return
		}

		const preferred = pickGuideStar(filtered.accepted)

		if (preferred === undefined) {
			this.updateDiagnostics(frame, filtered, null, false, true, ['init_no_star'])
			return
		}

		this.state.lockSamples.push({ x: preferred.x, y: preferred.y, stars: filtered.accepted.slice() })

		if (this.state.lockSamples.length < this.config.lockAveragingFrames) {
			this.updateDiagnostics(
				frame,
				filtered,
				{
					measurementX: preferred.x,
					measurementY: preferred.y,
					dx: 0,
					dy: 0,
					axisErrorRA: 0,
					axisErrorDEC: 0,
					modeUsed: 'single-star',
					targetX: preferred.x,
					targetY: preferred.y,
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

		this.state.referenceX = sumX / this.state.lockSamples.length
		this.state.referenceY = sumY / this.state.lockSamples.length
		this.state.referenceStars = this.state.lockSamples[this.state.lockSamples.length - 1].stars.slice()
		this.state.state = 'guiding'
		this.updateDiagnostics(
			frame,
			filtered,
			{
				measurementX: this.state.referenceX,
				measurementY: this.state.referenceY,
				dx: 0,
				dy: 0,
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
	private measureTranslation(stars: readonly GuideStar[]): TranslationMeasurement | null {
		if (this.config.mode === 'multi-star' && this.state.referenceStars.length > 1 && stars.length > 1) {
			const translation = estimateTranslation(this.state.referenceStars, stars, this.config.maxMatchDistancePx, this.config.outlierSigma)

			if (translation !== null) {
				return {
					x: this.state.referenceX + translation.dx,
					y: this.state.referenceY + translation.dy,
					usedMode: 'multi-star',
					matches: translation.matches,
				}
			}
		}

		const single = pickGuideStar(stars)
		if (single === undefined) return null
		return { x: single.x, y: single.y, usedMode: 'single-star', matches: 1 }
	}

	// Detects impossible centroid jumps to avoid runaway corrections.
	private isImpossibleJump(measurement: TranslationMeasurement) {
		if (this.state.lastGoodMeasurementX === undefined || this.state.lastGoodMeasurementY === undefined) return false
		const dx = measurement.x - this.state.lastGoodMeasurementX
		const dy = measurement.y - this.state.lastGoodMeasurementY
		return dx * dx + dy * dy > this.config.maxFrameJumpPx * this.config.maxFrameJumpPx
	}

	// Detects dropped frames from timestamp deltas.
	private isDroppedFrame({ timestamp }: GuideFrame, previousTimestamp: number | undefined) {
		if (timestamp === undefined) return false
		if (previousTimestamp === undefined) return false
		const dt = timestamp - previousTimestamp
		return dt > this.config.nominalCadence * this.config.droppedFrameFactor
	}

	// Computes frame cadence scale to keep pulse gain stable across variable cadence.
	private cadenceScale({ timestamp }: GuideFrame, previousTimestamp: number | undefined) {
		if (timestamp === undefined || previousTimestamp === undefined) return 1
		const dt = Math.max(1, timestamp - previousTimestamp)
		return clamp(dt / this.config.nominalCadence, 0.5, 2)
	}

	// Computes RA pulse with hysteresis smoothing, deadband and proportional gain.
	private computeRA(axisErrorRA: number, cadenceScale: number): AxisPulse {
		this.state.filteredRA = this.config.hysteresisRA * this.state.filteredRA + (1 - this.config.hysteresisRA) * axisErrorRA
		const magnitude = Math.abs(this.state.filteredRA)
		if (magnitude < this.config.minMoveRA) return NO_PULSE_COMMAND
		const duration = clamp(magnitude * this.config.msPerRAUnit * this.config.aggressivenessRA * cadenceScale, this.config.minPulseMsRA, this.config.maxPulseMsRA)
		const direction = this.state.filteredRA >= 0 ? this.config.raPositiveDirection : oppositeRA(this.config.raPositiveDirection)
		return { direction, duration }
	}

	// Computes DEC pulse with backlash-aware reversal suppression and mode constraints.
	private computeDEC(axisErrorDEC: number, cadenceScale: number): AxisPulse {
		if (this.config.decMode === 'off') return NO_PULSE_COMMAND
		this.state.filteredDEC = this.config.hysteresisDEC * this.state.filteredDEC + (1 - this.config.hysteresisDEC) * axisErrorDEC

		const magnitude = Math.abs(this.state.filteredDEC)
		if (magnitude < this.config.minMoveDEC) return NO_PULSE_COMMAND

		const direction = this.state.filteredDEC >= 0 ? this.config.decPositiveDirection : oppositeDEC(this.config.decPositiveDirection)
		if (this.config.decMode === 'north-only' && direction !== 'north') return NO_PULSE_COMMAND
		if (this.config.decMode === 'south-only' && direction !== 'south') return NO_PULSE_COMMAND

		const last = this.state.lastDecDirection
		if (last !== null && last !== direction) {
			if (magnitude < this.config.decReversalThreshold) return NO_PULSE_COMMAND
			this.state.oppositeDecErrorAccum += magnitude
			if (this.state.oppositeDecErrorAccum < this.config.decBacklashAccumThreshold) return NO_PULSE_COMMAND
		} else {
			this.state.oppositeDecErrorAccum = 0
		}

		const duration = clamp(magnitude * this.config.msPerDECUnit * this.config.aggressivenessDEC * cadenceScale, this.config.minPulseMsDEC, this.config.maxPulseMsDEC)
		this.state.lastDecDirection = direction
		this.state.oppositeDecErrorAccum = 0
		return { direction, duration }
	}

	// Updates diagnostics payload for telemetry and testing.
	private updateDiagnostics(frame: GuideFrame, filtered: FilteredStars, measurement: DiagnosticMeasurement | null, droppedFrame: boolean, badFrame: boolean, notes: readonly string[]) {
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

// Gets opposite RA guide direction.
function oppositeRA(direction: GuideDirectionRA) {
	return direction === 'west' ? 'east' : 'west'
}

// Gets opposite DEC guide direction.
function oppositeDEC(direction: GuideDirectionDEC) {
	return direction === 'north' ? 'south' : 'north'
}
