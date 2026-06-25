import { type GuideCommand, type GuideDirectionDEC, type GuideFrame, type GuidingMode, NO_PULSE, oppositeDEC } from './guider'
import type { CalibrationPulseCommand } from './guider.calibrator'

// Minimum sampling interval used by PHD2 before final recommendations are trusted, in seconds.
const DEFAULT_MIN_SAMPLING_SECONDS = 120

// Long-run seeing windows use two-minute spans with one-minute overlap, matching PHD2's guiding assistant.
const SEEING_WINDOW_SECONDS = 120

// Seeing windows covering less than this span are ignored to avoid unstable RMS estimates.
// A discrete [start, start+120] window can only reach a full 120 s span when samples land
// exactly on both edges, so this floor lets interior windows qualify like the trailing one.
const MIN_SEEING_WINDOW_SECONDS = 96

// Backlash compensation above this value is treated as too large for ordinary DEC compensation.
const MAX_BACKLASH_COMPENSATION_MS = 3000

// Backlash measurements below this value are treated as negligible measurement noise.
const SMALL_BACKLASH_MS = 100

// Polar alignment estimates become numerically unstable too close to the pole.
const MIN_ABS_COS_DECLINATION = 1e-3

// PHD2 Barrett-formula factor converting DEC drift to polar alignment error in arc-minutes.
const POLAR_ALIGNMENT_DRIFT_FACTOR = 3.8197

// Min-move recommendations are rounded up to this pixel unit.
const MIN_MOVE_UNIT_PX = 0.05

// Default lower bound for seeing-based single-star min-move recommendations.
const DEFAULT_MIN_MOVE_FLOOR_PX = 0.1

// Default lower bound for seeing-based multi-star min-move recommendations.
const MULTISTAR_MIN_MOVE_FLOOR_PX = 0.05

// Guiding assistant state while collecting passive guide samples and optional backlash measurements.
export type GuidingAssistantStatus = 'idle' | 'measuring' | 'backlash' | 'completed' | 'failed'

// Backlash test sub-state used to describe progress and failure reasons.
export type GuidingAssistantBacklashPhase = 'idle' | 'north' | 'south' | 'completed' | 'failed' | 'aborted'

// Recommendation categories surfaced to applications.
export type GuidingAssistantRecommendationKind = 'exposure' | 'binning' | 'calibration' | 'star' | 'focus' | 'polar-alignment' | 'ra-min-move' | 'dec-min-move' | 'backlash' | 'dec-mode'

// Configuration for one guiding assistant run.
export interface GuidingAssistantConfig {
	// Minimum passive measurement time in seconds before recommendations are marked as sufficiently sampled.
	readonly minSamplingSeconds: number
	// Current guide exposure in seconds; used for exposure recommendations and filter cadence.
	readonly exposureSeconds: number
	// Image scale in arc-seconds per pixel; when omitted, arc-second values are returned as null.
	readonly imageScaleArcsecPerPixel?: number
	// Current pointing declination in radians; required for polar alignment error estimates.
	readonly declination?: number
	// Whether the current guiding run uses multi-star tracking.
	readonly multiStar: boolean
	// Whether the mount has high-precision encoders that tolerate longer guide cadence and lower RA multiplier.
	readonly hasHighPrecisionEncoders: boolean
	// Whether calibration should be treated as suspect in the final recommendations.
	readonly suspectCalibration: boolean
	// Whether to run a DEC backlash test after passive sampling stops.
	readonly measureBacklash: boolean
	// DEC output direction represented by positive DEC-axis guide error.
	readonly decPositiveDirection: GuideDirectionDEC
	// Minimum mean SNR expected for the selected guide star.
	readonly minSnr: number
	// HFD threshold above which focus should be improved when image scale is coarse enough.
	readonly focusHfdThreshold: number
	// Image-scale threshold in arc-seconds per pixel where HFD focus advice is meaningful.
	readonly focusImageScaleThreshold: number
	// Pixel scale sanity limit for seeing-based min-move recommendations.
	readonly minMoveArcsecSanityLimit: number
	// DEC min-move multiplier for fine image scales.
	readonly fineScaleDecMultiplier: number
	// DEC min-move multiplier for coarser image scales.
	readonly coarseScaleDecMultiplier: number
	// Image scale below which the fine DEC min-move multiplier is used.
	readonly fineScaleThresholdArcsecPerPixel: number
	// RA min-move multiplier relative to DEC when the mount has no high-precision encoders.
	readonly raMinMoveMultiplier: number
	// Fallback DEC min-move in pixels when seeing-based estimation fails sanity checks.
	readonly fallbackDecMinMove: number
	// North pulse direction used by the DEC backlash test.
	readonly backlashNorthDirection: GuideDirectionDEC
	// Duration of each DEC backlash test pulse in milliseconds.
	readonly backlashPulseMs: number
	// Target north motion in DEC-axis pixels before starting the south return.
	readonly backlashTargetPx: number
	// Return tolerance in DEC-axis pixels for completing the south return.
	readonly backlashReturnTolerancePx: number
	// Minimum DEC-axis motion per pulse that counts as backlash movement.
	readonly backlashMinMotionPx: number
	// Maximum pulse count per backlash direction.
	readonly backlashMaxPulsesPerDirection: number
}

// One measured guide sample normalized into mount-axis pixels.
export interface GuidingAssistantSample {
	// Source guide frame id when available.
	readonly frameId?: number
	// Sample timestamp in milliseconds.
	readonly timestamp: number
	// Elapsed seconds from the beginning of the run.
	readonly elapsedSeconds: number
	// RA-axis guide displacement in pixels.
	readonly raPx: number
	// DEC-axis guide displacement in pixels.
	readonly decPx: number
	// Image-space X displacement in pixels, when diagnostics include it.
	readonly dx?: number
	// Image-space Y displacement in pixels, when diagnostics include it.
	readonly dy?: number
	// Selected guide-star SNR for this frame.
	readonly snr: number
	// Selected guide-star flux or star mass for this frame.
	readonly starMass: number
	// Selected guide-star half-flux diameter in pixels.
	readonly hfd: number
	// Whether the guider considered this a bad frame.
	readonly badFrame: boolean
	// Actual guide mode used by the guider for this accepted sample.
	readonly modeUsed: GuidingMode | null
}

// RMS and peak motion statistics for one axis.
export interface GuidingAssistantAxisMotion {
	// High-frequency RMS in pixels after drift removal.
	readonly rmsPx: number
	// High-frequency RMS in arc-seconds, or null when image scale is unknown.
	readonly rmsArcsec: number | null
	// Largest absolute displacement from the run origin in pixels.
	readonly peakPx: number
	// Largest absolute displacement from the run origin in arc-seconds, or null when image scale is unknown.
	readonly peakArcsec: number | null
	// Linear drift rate in pixels per minute.
	readonly driftRatePxPerMinute: number
	// Linear drift rate in arc-seconds per minute, or null when image scale is unknown.
	readonly driftRateArcsecPerMinute: number | null
}

// Passive guide-motion metrics matching the groups shown by PHD2's assistant.
export interface GuidingAssistantMotionMetrics {
	// RA high-frequency and drift statistics.
	readonly ra: GuidingAssistantAxisMotion
	// DEC high-frequency and drift statistics.
	readonly dec: GuidingAssistantAxisMotion
	// Combined high-frequency RMS in pixels.
	readonly totalRmsPx: number
	// Combined high-frequency RMS in arc-seconds, or null when image scale is unknown.
	readonly totalRmsArcsec: number | null
	// RA peak-to-peak low-frequency motion in pixels.
	readonly raPeakPeakPx: number
	// RA peak-to-peak low-frequency motion in arc-seconds, or null when image scale is unknown.
	readonly raPeakPeakArcsec: number | null
	// Maximum adjacent RA drift rate in pixels per second.
	readonly raMaxDriftRatePxPerSecond: number
	// Maximum adjacent RA drift rate in arc-seconds per second, or null when image scale is unknown.
	readonly raMaxDriftRateArcsecPerSecond: number | null
	// Drift-limiting exposure in seconds from recommended RA min-move and maximum RA drift rate.
	readonly driftLimitingExposureSeconds: number | null
	// Polar alignment error in arc-minutes, or null when declination/image scale is unavailable.
	readonly polarAlignmentErrorArcmin: number | null
	// Drift-corrected DEC RMS used as the seeing estimate for min-move recommendations.
	readonly decCorrectedRmsPx: number
}

// DEC backlash measurement result.
export interface GuidingAssistantBacklashResult {
	// Final backlash sub-state.
	readonly phase: GuidingAssistantBacklashPhase
	// Measured backlash in milliseconds, or null when measurement failed or was not run.
	readonly backlashMs: number | null
	// Backlash compensation value recommended for DEC, or null when not applicable.
	readonly recommendedCompensationMs: number | null
	// North motion covered during the measurement in DEC-axis pixels.
	readonly northDistancePx: number
	// South return motion covered during the measurement in DEC-axis pixels.
	readonly southDistancePx: number
	// Number of north pulses issued.
	readonly northPulses: number
	// Number of south pulses issued.
	readonly southPulses: number
	// Failure or status note for callers that want to render detailed text.
	readonly message: string
}

// One actionable or informational guiding-assistant recommendation.
export interface GuidingAssistantRecommendation {
	// Recommendation category.
	readonly kind: GuidingAssistantRecommendationKind
	// Human-readable recommendation text.
	readonly message: string
	// Optional target setting path for applying the recommendation.
	readonly appliesTo?: 'exposure' | 'raMinMove' | 'decMinMove' | 'decBacklashCompensation' | 'decGuideMode' | 'calibration'
	// Numeric recommendation value when the message maps to a setting.
	readonly value?: number
	// Unit for numeric values, such as px, ms, s, or arc-min.
	readonly unit?: string
	// Whether an application can offer a direct apply action.
	readonly actionable: boolean
}

// Complete or in-progress guiding assistant result snapshot.
export interface GuidingAssistantResult {
	// Current assistant status.
	readonly status: GuidingAssistantStatus
	// Start time in milliseconds since Unix epoch.
	readonly startTime: number
	// Elapsed time in seconds.
	readonly elapsedSeconds: number
	// Current exposure in seconds.
	readonly exposureSeconds: number
	// Number of guide samples accepted into the statistics.
	readonly sampleCount: number
	// Mean selected-star SNR.
	readonly meanSnr: number
	// Mean selected-star mass or flux.
	readonly meanStarMass: number
	// Mean selected-star HFD in pixels.
	readonly meanHfd: number
	// Motion metrics derived from accepted guide samples.
	readonly motion: GuidingAssistantMotionMetrics
	// DEC backlash result or null when the test has not been run.
	readonly backlash: GuidingAssistantBacklashResult | null
	// Recommended RA min-move in pixels.
	readonly recommendedRaMinMove: number
	// Recommended DEC min-move in pixels.
	readonly recommendedDecMinMove: number
	// Recommended minimum guide exposure in seconds.
	readonly recommendedMinExposureSeconds: number
	// Recommended maximum guide exposure in seconds.
	readonly recommendedMaxExposureSeconds: number
	// Recommendations generated from the current result.
	readonly recommendations: readonly GuidingAssistantRecommendation[]
	// Notes about unavailable inputs or low-confidence estimates.
	readonly notes: readonly string[]
}

// Result of advancing one assistant frame.
export interface GuidingAssistantStep {
	// Current result snapshot after processing the frame.
	readonly result: GuidingAssistantResult
	// Optional calibration-style pulse the caller should send before the next frame.
	readonly pulse?: CalibrationPulseCommand
}

// PHD2-like defaults for guiding assistant analysis and recommendations.
export const DEFAULT_GUIDING_ASSISTANT_CONFIG: GuidingAssistantConfig = {
	minSamplingSeconds: DEFAULT_MIN_SAMPLING_SECONDS,
	exposureSeconds: 1,
	multiStar: true,
	hasHighPrecisionEncoders: false,
	suspectCalibration: false,
	measureBacklash: false,
	decPositiveDirection: 'north',
	minSnr: 10,
	focusHfdThreshold: 4.5,
	focusImageScaleThreshold: 1,
	minMoveArcsecSanityLimit: 1.25,
	fineScaleDecMultiplier: 1.28,
	coarseScaleDecMultiplier: 1.65,
	fineScaleThresholdArcsecPerPixel: 1.5,
	raMinMoveMultiplier: 0.65,
	fallbackDecMinMove: 0.2,
	backlashNorthDirection: 'north',
	backlashPulseMs: 100,
	backlashTargetPx: 4,
	backlashReturnTolerancePx: 0.5,
	backlashMinMotionPx: 0.05,
	backlashMaxPulsesPerDirection: 40,
}

interface LinearFit {
	readonly slope: number
	readonly intercept: number
	readonly residualRms: number
}

interface BacklashState {
	phase: GuidingAssistantBacklashPhase
	originDec: number
	previousDec: number
	noMotionMs: number
	northPulses: number
	southPulses: number
	northDistancePx: number
	southDistancePx: number
	lastPulseDirection?: GuideDirectionDEC
	lastPulseDuration: number
	result: GuidingAssistantBacklashResult | null
}

// Stateful core for PHD2-style guiding assistant analysis without UI or device dependencies.
export class GuidingAssistant {
	readonly config: GuidingAssistantConfig
	readonly samples: GuidingAssistantSample[] = []
	#status: GuidingAssistantStatus = 'idle'
	#startTime = 0
	#backlash: BacklashState = makeBacklashState()

	constructor(config: Partial<GuidingAssistantConfig> = {}) {
		this.config = { ...DEFAULT_GUIDING_ASSISTANT_CONFIG, ...config }
	}

	// Starts a fresh assistant run and clears prior samples.
	start(timestamp: number = Date.now()) {
		this.samples.length = 0
		this.#status = 'measuring'
		this.#startTime = timestamp
		this.#backlash = makeBacklashState()
		return this.result(timestamp)
	}

	// Records one guide frame and optionally advances the DEC backlash state machine.
	addSample(frame: GuideFrame, command: GuideCommand): GuidingAssistantStep {
		if (this.#status === 'completed' || this.#status === 'failed') {
			return { result: this.result(frame.timestamp ?? Date.now()) }
		}

		if (this.#status === 'idle') this.start(frame.timestamp ?? Date.now())

		const sample = makeSample(frame, command, this.#startTime)

		let pulse: CalibrationPulseCommand | undefined

		if (sample !== null && this.#status === 'backlash') {
			pulse = this.#advanceBacklash(sample)
		} else if (sample !== null) {
			this.samples.push(sample)
		}

		return { result: this.result(frame.timestamp ?? Date.now()), pulse }
	}

	// Starts the optional DEC backlash test after passive sampling has collected guide drift.
	startBacklashTest(): GuidingAssistantStep {
		if (this.#status !== 'measuring') return { result: this.result() }

		const last = this.samples.at(-1)

		if (last === undefined) {
			this.#status = 'failed'
			this.#backlash.result = makeBacklashResult('failed', null, 0, 0, 0, 0, 'no guide samples available for backlash test')
			return { result: this.result() }
		}

		this.#status = 'backlash'
		this.#backlash = {
			...makeBacklashState(),
			phase: 'north',
			originDec: last.decPx,
			previousDec: last.decPx,
		}

		const pulse = this.#makeBacklashPulse(this.config.backlashNorthDirection)
		return { result: this.result(), pulse }
	}

	// Moves a just-started backlash origin to the next frame boundary before the first pulse is applied.
	alignBacklashOrigin(frame: GuideFrame, command: GuideCommand) {
		const timestamp = frame.timestamp ?? Date.now()

		if (this.#status !== 'backlash' || this.#backlash.phase !== 'north' || this.#backlash.northPulses !== 1 || this.#backlash.southPulses !== 0 || this.#backlash.northDistancePx !== 0) {
			return { result: this.result(timestamp), aligned: false }
		}

		const sample = makeSample(frame, command, this.#startTime)
		if (sample === null) return { result: this.result(timestamp), aligned: false }

		this.#backlash.originDec = sample.decPx
		this.#backlash.previousDec = sample.decPx

		return { result: this.result(timestamp), aligned: true }
	}

	// Completes the run and freezes the final recommendation snapshot.
	complete(timestamp: number = Date.now()) {
		if (this.#status === 'backlash') return this.abortBacklash('backlash test aborted', timestamp)
		if (this.#status !== 'failed') this.#status = 'completed'
		const result = this.result(timestamp)
		return result
	}

	// Fails the run with a status note while preserving measured data.
	fail(message: string, timestamp: number = Date.now()) {
		const backlashWasActive = this.#status === 'backlash' || this.#backlash.phase !== 'idle'
		this.#status = 'failed'
		if (backlashWasActive) this.#backlash.result ??= makeBacklashResultFromState('failed', this.#backlash, message)
		const result = this.result(timestamp)
		return result
	}

	// Aborts an in-progress DEC backlash measurement without marking the assistant as completed.
	abortBacklash(message: string = 'backlash test aborted', timestamp: number = Date.now()) {
		if (this.#status !== 'backlash') return this.fail(message, timestamp)

		const state = this.#backlash
		this.#status = 'failed'
		state.phase = 'aborted'
		state.result = makeBacklashResult('aborted', null, state.northDistancePx, state.southDistancePx, state.northPulses, state.southPulses, message)

		return this.result(timestamp)
	}

	// Returns the latest computed result snapshot.
	result(timestamp: number = Date.now()): GuidingAssistantResult {
		const seeingPx = bestDecSeeingEstimate(this.samples)
		const minMove = computeMinMove(this.samples, this.config, seeingPx)
		const metrics = computeMotionMetrics(this.samples, this.config, seeingPx, minMove.ra)
		const exposure = exposureRange(this.config, metrics, minMove.ra)
		const meanSnr = meanOf(this.samples, 'snr')
		const meanStarMass = meanOf(this.samples, 'starMass')
		const meanHfd = meanOf(this.samples, 'hfd')
		const recommendations = makeRecommendations(this.samples, this.config, metrics, this.#backlash.result, minMove, exposure, meanSnr, meanHfd)
		const elapsedSeconds = elapsedSecondsOf(this.samples, timestamp, this.#startTime)
		const notes: string[] = []

		if (this.samples.length === 0) notes.push('no_samples')
		if (this.samples.length > 0 && elapsedSeconds < this.config.minSamplingSeconds) notes.push('sampling_interval_short')
		if (!hasPositiveScale(this.config)) notes.push('image_scale_unavailable')
		if (this.config.declination === undefined) notes.push('declination_unavailable')

		const result: GuidingAssistantResult = {
			status: this.#status,
			startTime: this.#startTime,
			elapsedSeconds,
			exposureSeconds: this.config.exposureSeconds,
			sampleCount: this.samples.length,
			meanSnr,
			meanStarMass,
			meanHfd,
			motion: metrics,
			backlash: this.#backlash.result,
			recommendedRaMinMove: minMove.ra,
			recommendedDecMinMove: minMove.dec,
			recommendedMinExposureSeconds: exposure.min,
			recommendedMaxExposureSeconds: exposure.max,
			recommendations,
			notes,
		}

		return result
	}

	// Returns true when passive sampling can transition into a DEC backlash test.
	get canMeasureBacklash() {
		return this.config.measureBacklash && this.#status === 'measuring' && this.samples.length > 0
	}

	// Returns true while the DEC backlash state machine expects more guide frames.
	get measuringBacklash() {
		return this.#status === 'backlash'
	}

	#advanceBacklash(sample: GuidingAssistantSample): CalibrationPulseCommand | undefined {
		const state = this.#backlash

		if (state.phase === 'north') {
			const signedMotion = decSignedDistance(this.config.backlashNorthDirection, this.config.decPositiveDirection, state.originDec, sample.decPx)
			state.northDistancePx = Math.max(state.northDistancePx, signedMotion)
			state.previousDec = sample.decPx

			if (state.northDistancePx >= this.config.backlashTargetPx) {
				state.phase = 'south'
				return this.#makeBacklashPulse(oppositeDEC(this.config.backlashNorthDirection))
			}

			if (state.northPulses >= this.config.backlashMaxPulsesPerDirection) {
				this.#status = 'failed'
				state.phase = 'failed'
				state.result = makeBacklashResult('failed', null, state.northDistancePx, 0, state.northPulses, state.southPulses, 'insufficient north DEC motion')
				return undefined
			}

			return this.#makeBacklashPulse(this.config.backlashNorthDirection)
		}

		if (state.phase === 'south') {
			const previousOffset = state.previousDec - state.originDec
			const currentOffset = sample.decPx - state.originDec
			const crossedOrigin = previousOffset !== 0 && currentOffset !== 0 && Math.sign(previousOffset) !== Math.sign(currentOffset)
			const before = Math.abs(previousOffset)
			const after = crossedOrigin ? 0 : Math.abs(currentOffset)
			const moved = Math.max(0, before - after)
			state.southDistancePx += moved
			state.previousDec = sample.decPx

			if (moved <= this.config.backlashMinMotionPx) {
				state.noMotionMs += state.lastPulseDuration
			}

			const remaining = crossedOrigin ? 0 : Math.abs(currentOffset)
			if (remaining <= this.config.backlashReturnTolerancePx) {
				const backlashMs = state.noMotionMs
				state.phase = 'completed'
				this.#status = 'completed'
				state.result = makeBacklashResult('completed', backlashMs, state.northDistancePx, state.southDistancePx, state.northPulses, state.southPulses, 'backlash measurement completed')
				return undefined
			}

			if (state.southPulses >= this.config.backlashMaxPulsesPerDirection) {
				state.phase = 'failed'
				this.#status = 'failed'
				state.result = makeBacklashResult('failed', null, state.northDistancePx, state.southDistancePx, state.northPulses, state.southPulses, 'south DEC motion did not return far enough')
				return undefined
			}

			return this.#makeBacklashPulse(oppositeDEC(this.config.backlashNorthDirection))
		}

		return undefined
	}

	#makeBacklashPulse(direction: GuideDirectionDEC): CalibrationPulseCommand {
		if (direction === this.config.backlashNorthDirection) {
			this.#backlash.northPulses++
		} else {
			this.#backlash.southPulses++
		}

		this.#backlash.lastPulseDirection = direction
		this.#backlash.lastPulseDuration = this.config.backlashPulseMs
		return { ra: NO_PULSE, dec: { direction, duration: this.config.backlashPulseMs } }
	}
}

function makeSample(frame: GuideFrame, command: GuideCommand, startTime: number): GuidingAssistantSample | null {
	if (command.state !== 'guiding' || command.diagnostics.badFrame) return null

	const timestamp = frame.timestamp ?? Date.now()
	const star = frame.stars[0]
	const hasAxisErrors = isFiniteNumber(command.diagnostics.axisErrorRA) && isFiniteNumber(command.diagnostics.axisErrorDEC)
	const hasImageDeltas = isFiniteNumber(command.diagnostics.dx) && isFiniteNumber(command.diagnostics.dy)

	if (!hasAxisErrors && !hasImageDeltas) return null

	const raPx = hasAxisErrors ? command.diagnostics.axisErrorRA! : command.diagnostics.dx!
	const decPx = hasAxisErrors ? command.diagnostics.axisErrorDEC! : command.diagnostics.dy!

	return {
		frameId: frame.frameId,
		timestamp,
		elapsedSeconds: Math.max(0, (timestamp - startTime) / 1000),
		raPx,
		decPx,
		dx: command.diagnostics.dx,
		dy: command.diagnostics.dy,
		snr: finiteOrZero(star?.snr),
		starMass: finiteOrZero(star?.flux),
		hfd: finiteOrZero(star?.hfd),
		badFrame: command.diagnostics.badFrame,
		modeUsed: command.diagnostics.modeUsed,
	}
}

// Derives passive motion metrics. `decCorrectedRmsPx` is the precomputed drift-removed DEC
// seeing estimate and `raMinMovePx` the recommended RA min-move, both passed in so a snapshot
// computes them once instead of repeating the work here.
function computeMotionMetrics(samples: readonly GuidingAssistantSample[], config: GuidingAssistantConfig, decCorrectedRmsPx: number, raMinMovePx: number): GuidingAssistantMotionMetrics {
	const raFit = linearFit(samples, 'raPx')
	const decFit = linearFit(samples, 'decPx')
	const maxRateRA = maxAdjacentRate(samples, 'raPx')
	const scale = scaleOrNull(config)
	const raPeakPx = peakFromOrigin(samples, 'raPx')
	const decPeakPx = peakFromOrigin(samples, 'decPx')
	const raPeakPeakPx = peakToPeak(samples, 'raPx')
	const polarAlignmentErrorArcmin = computePolarAlignmentError(decFit.slope * 60, config)

	return {
		ra: {
			rmsPx: raFit.residualRms,
			rmsArcsec: scaleValue(raFit.residualRms, scale),
			peakPx: raPeakPx,
			peakArcsec: scaleValue(raPeakPx, scale),
			driftRatePxPerMinute: raFit.slope * 60,
			driftRateArcsecPerMinute: scaleValue(raFit.slope * 60, scale),
		},
		dec: {
			rmsPx: decFit.residualRms,
			rmsArcsec: scaleValue(decFit.residualRms, scale),
			peakPx: decPeakPx,
			peakArcsec: scaleValue(decPeakPx, scale),
			driftRatePxPerMinute: decFit.slope * 60,
			driftRateArcsecPerMinute: scaleValue(decFit.slope * 60, scale),
		},
		totalRmsPx: Math.hypot(raFit.residualRms, decFit.residualRms),
		totalRmsArcsec: scaleValue(Math.hypot(raFit.residualRms, decFit.residualRms), scale),
		raPeakPeakPx,
		raPeakPeakArcsec: scaleValue(raPeakPeakPx, scale),
		raMaxDriftRatePxPerSecond: maxRateRA,
		raMaxDriftRateArcsecPerSecond: scaleValue(maxRateRA, scale),
		driftLimitingExposureSeconds: maxRateRA > 0 ? raMinMovePx / maxRateRA : null,
		polarAlignmentErrorArcmin,
		decCorrectedRmsPx,
	}
}

function computeMinMove(samples: readonly GuidingAssistantSample[], config: GuidingAssistantConfig, seeingPx = bestDecSeeingEstimate(samples)) {
	const multiplierDec = (config.imageScaleArcsecPerPixel ?? Number.POSITIVE_INFINITY) < config.fineScaleThresholdArcsecPerPixel ? config.fineScaleDecMultiplier : config.coarseScaleDecMultiplier
	const multiStarMeasured = config.multiStar && samples.length > 0 && samples.every((sample) => sample.modeUsed === 'multi-star')
	const minMoveFloor = multiStarMeasured ? MULTISTAR_MIN_MOVE_FLOOR_PX : DEFAULT_MIN_MOVE_FLOOR_PX
	const adjustedSeeing = multiStarMeasured ? seeingPx * 0.9 : seeingPx
	const dec = roundUpToUnit(Math.max(adjustedSeeing * multiplierDec, minMoveFloor), MIN_MOVE_UNIT_PX)
	const sane = !hasPositiveScale(config) || dec * config.imageScaleArcsecPerPixel! <= config.minMoveArcsecSanityLimit
	const recDec = sane && Number.isFinite(dec) ? dec : config.fallbackDecMinMove
	const raMultiplier = config.hasHighPrecisionEncoders ? 1 : config.raMinMoveMultiplier
	const recRa = Math.max(minMoveFloor, roundUpToUnit(recDec * raMultiplier, MIN_MOVE_UNIT_PX))
	return { ra: recRa, dec: recDec }
}

// Builds the recommendation list. `exposure`, `meanSnr`, and `meanHfd` are precomputed by the
// caller so a snapshot does not recompute the exposure range or sample means twice.
function makeRecommendations(
	samples: readonly GuidingAssistantSample[],
	config: GuidingAssistantConfig,
	metrics: GuidingAssistantMotionMetrics,
	backlash: GuidingAssistantBacklashResult | null,
	minMove: ReturnType<typeof computeMinMove>,
	exposure: ReturnType<typeof exposureRange>,
	meanSnr: number,
	meanHfd: number,
): readonly GuidingAssistantRecommendation[] {
	const recommendations: GuidingAssistantRecommendation[] = [{ kind: 'exposure', message: `Use exposure times in the range of ${exposure.min.toFixed(1)}s to ${exposure.max.toFixed(1)}s`, appliesTo: 'exposure', value: exposure.min, unit: 's', actionable: true }]

	if (config.suspectCalibration) {
		recommendations.push({ kind: 'calibration', message: 'Consider re-doing your calibration', appliesTo: 'calibration', actionable: false })
	}

	if (samples.length > 0 && meanSnr < config.minSnr) {
		recommendations.push({ kind: 'star', message: 'Consider using a brighter star for the test or increasing the exposure time', actionable: false })
	}

	if (hasPositiveScale(config) && config.imageScaleArcsecPerPixel! > config.focusImageScaleThreshold && meanHfd > config.focusHfdThreshold) {
		recommendations.push({ kind: 'focus', message: 'Consider trying to improve focus on the guide camera', actionable: false })
	}

	if (metrics.polarAlignmentErrorArcmin !== null && metrics.polarAlignmentErrorArcmin > 5) {
		const threshold = metrics.polarAlignmentErrorArcmin < 10 ? 5 : 10
		recommendations.push({ kind: 'polar-alignment', message: `Polar alignment error > ${threshold} arc-min; ${threshold === 5 ? 'that could probably be improved.' : 'try using drift alignment to improve alignment.'}`, value: metrics.polarAlignmentErrorArcmin, unit: 'arc-min', actionable: false })
	}

	recommendations.push({ kind: 'ra-min-move', message: `Try setting RA min-move to ${minMove.ra.toFixed(2)}`, appliesTo: 'raMinMove', value: minMove.ra, unit: 'px', actionable: true })
	recommendations.push({ kind: 'dec-min-move', message: `Try setting Dec min-move to ${minMove.dec.toFixed(2)}`, appliesTo: 'decMinMove', value: minMove.dec, unit: 'px', actionable: true })

	if (backlash !== null && backlash.phase === 'completed' && backlash.backlashMs !== null) {
		if (backlash.backlashMs < SMALL_BACKLASH_MS) {
			recommendations.push({ kind: 'backlash', message: 'Backlash is small, no compensation needed', actionable: false })
		} else if (backlash.backlashMs <= MAX_BACKLASH_COMPENSATION_MS) {
			recommendations.push({ kind: 'backlash', message: `Try starting with a Dec backlash compensation of ${backlash.recommendedCompensationMs} ms`, appliesTo: 'decBacklashCompensation', value: backlash.recommendedCompensationMs ?? undefined, unit: 'ms', actionable: backlash.recommendedCompensationMs !== null })
		} else {
			const direction = metrics.dec.driftRatePxPerMinute >= 0 ? config.decPositiveDirection : oppositeDEC(config.decPositiveDirection)
			recommendations.push({ kind: 'dec-mode', message: `Backlash is >= ${Math.round(backlash.backlashMs)} ms; you may need to guide in only one Dec direction (currently ${direction})`, appliesTo: 'decGuideMode', actionable: true })
		}
	} else if (backlash !== null && backlash.phase === 'failed') {
		recommendations.push({ kind: 'backlash', message: `DEC backlash test failed: ${backlash.message}`, actionable: false })
	}

	return recommendations
}

function exposureRange(config: GuidingAssistantConfig, metrics: GuidingAssistantMotionMetrics, raMinMovePx: number) {
	const idealMin = config.hasHighPrecisionEncoders ? 4 : 2
	const idealMax = config.hasHighPrecisionEncoders ? 8 : 4
	const driftExposure = metrics.raMaxDriftRatePxPerSecond > 0 ? Math.ceil(raMinMovePx / metrics.raMaxDriftRatePxPerSecond / 0.5) * 0.5 : idealMax
	const min = Math.max(1, Math.min(driftExposure, idealMin))
	const max = Math.max(min, Math.min(driftExposure, idealMax))

	return { min, max }
}

function bestDecSeeingEstimate(samples: readonly GuidingAssistantSample[]) {
	if (samples.length <= 1) return 0

	const first = samples[0].elapsedSeconds
	const last = samples.at(-1)!.elapsedSeconds

	if (last - first <= 1.2 * SEEING_WINDOW_SECONDS) {
		return linearFit(samples, 'decPx').residualRms
	}

	let best = Number.POSITIVE_INFINITY
	let start = first

	while (start <= last) {
		const end = start + SEEING_WINDOW_SECONDS
		const window = samples.filter((sample) => sample.elapsedSeconds >= start && sample.elapsedSeconds <= end)
		const span = window.length > 1 ? window.at(-1)!.elapsedSeconds - window[0].elapsedSeconds : 0

		if (span >= MIN_SEEING_WINDOW_SECONDS) {
			best = Math.min(best, linearFit(window, 'decPx').residualRms)
		}

		start += SEEING_WINDOW_SECONDS / 2
	}

	return Number.isFinite(best) ? best : linearFit(samples, 'decPx').residualRms
}

function linearFit(samples: readonly GuidingAssistantSample[], key: 'raPx' | 'decPx'): LinearFit {
	if (samples.length === 0) return { slope: 0, intercept: 0, residualRms: 0 }
	if (samples.length === 1) return { slope: 0, intercept: samples[0][key], residualRms: 0 }

	let sumT = 0
	let sumY = 0
	let sumTT = 0
	let sumTY = 0

	for (const sample of samples) {
		sumT += sample.elapsedSeconds
		sumY += sample[key]
		sumTT += sample.elapsedSeconds * sample.elapsedSeconds
		sumTY += sample.elapsedSeconds * sample[key]
	}

	const count = samples.length
	const denominator = count * sumTT - sumT * sumT
	const slope = Math.abs(denominator) <= Number.EPSILON ? 0 : (count * sumTY - sumT * sumY) / denominator
	const intercept = (sumY - slope * sumT) / count
	let residualSum = 0

	for (const sample of samples) {
		const residual = sample[key] - (slope * sample.elapsedSeconds + intercept)
		residualSum += residual * residual
	}

	return {
		slope,
		intercept,
		residualRms: Math.sqrt(residualSum / count),
	}
}

function peakFromOrigin(samples: readonly GuidingAssistantSample[], key: 'raPx' | 'decPx') {
	if (samples.length === 0) return 0

	const origin = samples[0][key]
	let peak = 0

	for (const sample of samples) {
		peak = Math.max(peak, Math.abs(sample[key] - origin))
	}

	return peak
}

function peakToPeak(samples: readonly GuidingAssistantSample[], key: 'raPx' | 'decPx') {
	if (samples.length === 0) return 0

	let min = samples[0][key]
	let max = min

	for (const sample of samples) {
		min = Math.min(min, sample[key])
		max = Math.max(max, sample[key])
	}

	return max - min
}

function maxAdjacentRate(samples: readonly GuidingAssistantSample[], key: 'raPx' | 'decPx') {
	let maxRate = 0

	for (let i = 1; i < samples.length; i++) {
		const dt = samples[i].elapsedSeconds - samples[i - 1].elapsedSeconds
		if (dt > 0) maxRate = Math.max(maxRate, Math.abs(samples[i][key] - samples[i - 1][key]) / dt)
	}

	return maxRate
}

function computePolarAlignmentError(decDriftPxPerMinute: number, config: GuidingAssistantConfig) {
	if (!hasPositiveScale(config) || config.declination === undefined || !Number.isFinite(config.declination)) return null

	const cosDec = Math.cos(config.declination)
	if (Math.abs(cosDec) < MIN_ABS_COS_DECLINATION) return null
	return (POLAR_ALIGNMENT_DRIFT_FACTOR * Math.abs(decDriftPxPerMinute) * config.imageScaleArcsecPerPixel!) / Math.abs(cosDec)
}

function makeBacklashResult(phase: GuidingAssistantBacklashPhase, backlashMs: number | null, northDistancePx: number, southDistancePx: number, northPulses: number, southPulses: number, message: string): GuidingAssistantBacklashResult {
	const compensable = backlashMs !== null && backlashMs >= SMALL_BACKLASH_MS && backlashMs <= MAX_BACKLASH_COMPENSATION_MS
	const compensation = compensable ? Math.floor(backlashMs / 10) * 10 : null
	return { phase, backlashMs, recommendedCompensationMs: compensation, northDistancePx, southDistancePx, northPulses, southPulses, message }
}

// Converts the active backlash state into a terminal result while keeping partial measurements.
function makeBacklashResultFromState(phase: GuidingAssistantBacklashPhase, state: BacklashState, message: string) {
	return makeBacklashResult(phase, null, state.northDistancePx, state.southDistancePx, state.northPulses, state.southPulses, message)
}

function makeBacklashState(): BacklashState {
	return {
		phase: 'idle',
		originDec: 0,
		previousDec: 0,
		noMotionMs: 0,
		northPulses: 0,
		southPulses: 0,
		northDistancePx: 0,
		southDistancePx: 0,
		lastPulseDuration: 0,
		result: null,
	}
}

// Elapsed passive-sampling time in seconds. Once any sample exists this tracks the last
// accepted sample, so it intentionally freezes during the backlash phase (which records no
// passive samples) and ignores `timestamp`; `timestamp` is only used before the first sample.
function elapsedSecondsOf(samples: readonly GuidingAssistantSample[], timestamp: number, startTime: number) {
	if (samples.length > 0) return Math.max(0, samples.at(-1)!.elapsedSeconds)
	if (startTime <= 0) return 0
	return Math.max(0, (timestamp - startTime) / 1000)
}

function meanOf(samples: readonly GuidingAssistantSample[], key: 'snr' | 'starMass' | 'hfd') {
	if (samples.length === 0) return 0

	let sum = 0

	for (const sample of samples) sum += sample[key]

	return sum / samples.length
}

function scaleValue(value: number, scale: number | null) {
	return scale === null ? null : value * scale
}

function scaleOrNull(config: GuidingAssistantConfig) {
	return hasPositiveScale(config) ? config.imageScaleArcsecPerPixel! : null
}

function hasPositiveScale(config: GuidingAssistantConfig) {
	return config.imageScaleArcsecPerPixel !== undefined && Number.isFinite(config.imageScaleArcsecPerPixel) && config.imageScaleArcsecPerPixel > 0
}

function roundUpToUnit(value: number, unit: number) {
	return Math.max(unit, Math.ceil(value / unit) * unit)
}

function finiteOrZero(value: number | undefined) {
	return value !== undefined && Number.isFinite(value) ? value : 0
}

function isFiniteNumber(value: number | undefined) {
	return value !== undefined && Number.isFinite(value)
}

function decSignedDistance(direction: GuideDirectionDEC, decPositiveDirection: GuideDirectionDEC, from: number, to: number) {
	const sign = direction === decPositiveDirection ? 1 : -1
	return (to - from) * sign
}
