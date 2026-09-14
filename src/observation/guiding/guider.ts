import type { Writable } from '../../core/types'
import { Matrix } from '../../math/linear-algebra/matrix'
import { clamp } from '../../math/numerical/math'
import { type GuideFrame, type GuideTargetEnvelope, type GuideTrackerResult, trackingOf } from './tracker'
import { starTrackingOf } from './tracker.star'

// Generic autoguiding controller. Given a stream of tracker results and a calibration matrix mapping
// image pixels to mount RA/DEC axes, the Guider averages a lock reference, rejects bad/dropped
// measurements, and emits RA/DEC pulse commands using deadband, hysteresis smoothing, cadence-aware
// gain, and DEC backlash/reversal handling. Image coordinates are pixels; pulse durations are
// milliseconds; calibration is dimensionless.

// RA correction direction.
export type GuideDirectionRA = 'WEST' | 'EAST'

// DEC correction direction.
export type GuideDirectionDEC = 'NORTH' | 'SOUTH'

// DEC guiding policy; restricts or disables corrections to manage backlash.
export type DeclinationGuideMode = 'auto' | 'north-only' | 'south-only' | 'off'

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
	// Generic tracking result consumed for this command.
	readonly tracking: GuideTrackerResult
}

// Detailed per-frame telemetry for monitoring and testing.
export interface GuideDiagnostics {
	// Frame identifier, if provided.
	readonly frameId?: number
	// Deprecated stellar alias; generic controllers leave it at zero.
	readonly totalStars: number
	// Deprecated stellar alias; generic controllers leave it at zero.
	readonly acceptedStars: number
	// Generic candidate count for this frame.
	readonly candidateCount?: number
	// Generic accepted-candidate count for this frame.
	readonly acceptedCount?: number
	// Accepted/total ratio in [0, 1].
	readonly qualityScore: number
	// Informational measurement mode actually used, or undefined when no measurement was made.
	readonly usedMode?: string
	// Informational tracker mode, including non-stellar values.
	readonly measurementMode?: string
	// Measured target X, in pixels.
	readonly measurementX?: number
	// Measured target Y, in pixels.
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
	// Count of rejected candidates by reason.
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
	// Generic tracking result used to produce these diagnostics.
	readonly tracking?: GuideTrackerResult
	// Structured target-envelope rejection, when the proposed target could not be pulsed safely.
	readonly targetLimit?: GuideTargetLimitDiagnostic
}

// Structured preflight failure for the combined reference, dither, lock-shift, and tracker target.
export interface GuideTargetLimitDiagnostic {
	// Reason the proposed target was rejected.
	readonly reason: 'nonFiniteTarget' | 'outsideEnvelope'
	// Proposed combined target in image pixels.
	readonly proposed: readonly [number, number]
	// Inclusive permitted target bounds in image pixels.
	readonly envelope: GuideTargetEnvelope
}

// Row-major 2×2 image-to-axis calibration matrix [a, b, c, d].
export type CalibrationMatrix = readonly [number, number, number, number]

// Full guider configuration. All position fields are pixels; pulse durations are milliseconds.
export interface GuiderConfig {
	// Image-to-axis calibration matrix.
	readonly calibration: CalibrationMatrix
	// Optional fixed lock reference, in pixels; overrides the averaged reference.
	readonly referencePosition?: readonly [number, number]
	// Optional preferred initial target position, in pixels.
	readonly initialPosition?: readonly [number, number]
	// Number of frames averaged to establish the lock reference.
	readonly lockAveragingFrames: number
	// Maximum per-frame centroid jump before rejecting the frame, in pixels.
	readonly maxFrameJumpPx: number
	// Minimum acceptable frame quality score in [0, 1]. The tracker defines the candidate set and
	// denominator used for this score, including any search-region semantics.
	readonly minFrameQuality: number
	// Consecutive bad frames before declaring the tracked target lost.
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
}

// High-level guider lifecycle state.
export type GuiderState = 'idle' | 'initializing' | 'guiding' | 'lost'

// One averaged lock-acquisition measurement.
interface LockSample {
	readonly x: number
	readonly y: number
}

// Internal mutable runtime state of the guider.
interface GuiderInternalState {
	state: GuiderState
	lockSamples: LockSample[]
	referenceX: number
	referenceY: number
	ditherOffsetX: number
	ditherOffsetY: number
	ditherActive: boolean
	lastTimestamp?: number
	// Monotonic capture clock of the last accepted frame, in milliseconds.
	lastCaptureMonotonic?: number
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
	usedMode?: string
	measurementMode?: string
	targetX: number
	targetY: number
	notes: readonly string[]
}

// A configuration-validation problem: which key failed and why.
export interface ConfigIssue {
	readonly key: string
	readonly reason: string
}

// Default generic-controller tuning: identity calibration, conservative gains, and pulse limits.
export const DEFAULT_GUIDER_CONFIG: Readonly<GuiderConfig> = {
	calibration: [1, 0, 0, 1],
	lockAveragingFrames: 6,
	maxFrameJumpPx: 12,
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
	ditherOffsetX: 0,
	ditherOffsetY: 0,
	ditherActive: false,
	consecutiveBadFrames: 0,
	// Explicit undefined so reset()'s Object.assign actually clears these optional fields.
	// Without the keys present, Object.assign would leave stale values: a stale lastGoodMeasurement
	// makes the first frame after a re-lock look like an impossible jump, and a stale lastTimestamp
	// corrupts the dropped-frame cadence check.
	lastTimestamp: undefined,
	lastCaptureMonotonic: undefined,
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
		candidateCount: 0,
		acceptedCount: 0,
		qualityScore: 0,
		usedMode: undefined,
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
		this.config = { ...DEFAULT_GUIDER_CONFIG, ...config }

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
	// DEC is re-enabled even if the target is already centered.
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
		const frameClock = this.#classifyFrameClock(frame)

		if (this.state.state === 'idle') {
			this.state.state = 'initializing'
			this.state.lockSamples.length = 0
		}

		if (frameClock.outOfOrder) {
			const notes = [...trackingOf(frame).notes, frameClock.duplicate ? 'duplicate_frame' : 'out_of_order']
			this.#updateDiagnostics(frame, trackingOf(frame), undefined, false, true, notes)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics, tracking: trackingOf(frame) }
		}

		if (this.state.state === 'initializing') {
			this.#processInitializationFrame(frame)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics, tracking: trackingOf(frame) }
		}

		const tracking = trackingOf(frame)
		const droppedFrame = frameClock.dropped
		const notes = [...tracking.notes]

		if (droppedFrame) notes.push('dropped_frame')

		const measurement = tracking.measurement
		let badFrame = measurement === undefined || tracking.qualityScore < this.config.minFrameQuality
		if (measurement === undefined && !notes.includes('measurement_lost')) notes.push('measurement_failed')

		// A commanded dither walk can exceed maxFrameJumpPx in one pulse; that motion is expected,
		// not an invalid target swap.
		if (!badFrame && measurement !== undefined && !this.state.ditherActive && this.#isImpossibleJump(measurement)) {
			badFrame = true
			notes.push('jump_rejected')
		}

		if (badFrame) {
			this.state.consecutiveBadFrames++
			if (this.state.consecutiveBadFrames >= this.config.lostStarFrameCount) {
				this.state.state = 'lost'
				this.#clearRaControlState()
				this.#clearDecControlState()
			}
			this.#updateDiagnostics(frame, tracking, undefined, droppedFrame, true, notes)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics, tracking }
		}
		if (measurement === undefined) throw new Error('missing guide measurement after quality check')

		this.state.consecutiveBadFrames = 0
		this.state.state = 'guiding'
		this.state.lastGoodMeasurementX = measurement.x
		this.state.lastGoodMeasurementY = measurement.y
		const targetX = this.state.referenceX + this.state.ditherOffsetX + (tracking.targetOffset?.[0] ?? 0)
		const targetY = this.state.referenceY + this.state.ditherOffsetY + (tracking.targetOffset?.[1] ?? 0)
		const targetLimit = this.#preflightTarget(frame, targetX, targetY)
		if (targetLimit !== undefined) {
			this.state.state = 'lost'
			this.state.consecutiveBadFrames = this.config.lostStarFrameCount
			this.#clearRaControlState()
			this.#clearDecControlState()
			notes.push('target_limit')
			this.#updateDiagnostics(frame, tracking, undefined, droppedFrame, true, notes, targetLimit)
			return { state: this.state.state, ra: NO_PULSE, dec: NO_PULSE, diagnostics: this.state.lastDiagnostics, tracking }
		}
		const dx = measurement.x - targetX
		const dy = measurement.y - targetY
		const axisError = applyCalibration(this.config.calibration, dx, dy)
		const cadenceScale = this.#cadenceScale(frame)
		const ra = this.#computeRA(axisError.ra, cadenceScale)
		const dec = this.#computeDEC(axisError.dec, cadenceScale)
		this.#updateDiagnostics(
			frame,
			tracking,
			{
				measurementX: measurement.x,
				measurementY: measurement.y,
				dx,
				dy,
				axisErrorRA: axisError.ra,
				axisErrorDEC: axisError.dec,
				usedMode: tracking.measurementMode,
				measurementMode: tracking.measurementMode,
				targetX,
				targetY,
				notes,
			},
			droppedFrame,
			false,
			notes,
		)

		return { state: this.state.state, ra, dec, diagnostics: this.state.lastDiagnostics, tracking }
	}

	// Rejects a combined target before any axis controller can turn it into a pulse. The default
	// envelope is the decoded image; callers can provide tighter search-region or detector margins.
	#preflightTarget(frame: GuideFrame, targetX: number, targetY: number): GuideTargetLimitDiagnostic | undefined {
		const configuredEnvelope = frame.targetEnvelope
		const envelope =
			configuredEnvelope === undefined
				? frame.width > 0 && frame.height > 0
					? { minX: 0, maxX: frame.width - 1, minY: 0, maxY: frame.height - 1 }
					: undefined
				: { minX: configuredEnvelope.minX, maxX: configuredEnvelope.maxX, minY: configuredEnvelope.minY, maxY: configuredEnvelope.maxY, marginPx: configuredEnvelope.marginPx }
		const proposed: readonly [number, number] = [Number.isFinite(targetX) ? targetX : 0, Number.isFinite(targetY) ? targetY : 0]
		if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return { reason: 'nonFiniteTarget', proposed, envelope: envelope ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 } }
		if (envelope === undefined || !Number.isFinite(envelope.minX) || !Number.isFinite(envelope.maxX) || !Number.isFinite(envelope.minY) || !Number.isFinite(envelope.maxY) || envelope.minX > envelope.maxX || envelope.minY > envelope.maxY)
			return envelope === undefined ? undefined : { reason: 'outsideEnvelope', proposed, envelope }
		if (targetX < envelope.minX || targetX > envelope.maxX || targetY < envelope.minY || targetY > envelope.maxY) return { reason: 'outsideEnvelope', proposed, envelope }
		return undefined
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

	// Consumes tracker measurements while averaging the generic lock reference.
	#processInitializationFrame(frame: GuideFrame) {
		const tracking = trackingOf(frame)
		const measurement = tracking.measurement
		const notes = [...tracking.notes]
		if (measurement === undefined || tracking.qualityScore < this.config.minFrameQuality) {
			if (!notes.includes('init_waiting')) notes.push('init_waiting')
			this.#updateDiagnostics(frame, tracking, undefined, false, true, notes)
			return
		}

		const previous = this.state.lockSamples.at(-1)
		if (previous !== undefined) {
			const dx = measurement.x - previous.x
			const dy = measurement.y - previous.y
			const maxLockSampleDistance = this.config.maxFrameJumpPx
			if (dx * dx + dy * dy > maxLockSampleDistance * maxLockSampleDistance) {
				notes.push('init_waiting')
				this.#updateDiagnostics(frame, tracking, undefined, false, true, notes)
				return
			}
		}

		this.state.lockSamples.push({ x: measurement.x, y: measurement.y })
		const [targetX, targetY] = this.config.referencePosition ?? [measurement.x, measurement.y]
		const dx = measurement.x - targetX
		const dy = measurement.y - targetY

		if (this.state.lockSamples.length < this.config.lockAveragingFrames) {
			notes.push('init_collecting')
			this.#updateDiagnostics(frame, tracking, { measurementX: measurement.x, measurementY: measurement.y, dx, dy, axisErrorRA: 0, axisErrorDEC: 0, usedMode: tracking.measurementMode, measurementMode: tracking.measurementMode, targetX, targetY, notes }, false, false, notes)
			return
		}

		let sumX = 0
		let sumY = 0
		for (const sample of this.state.lockSamples) {
			sumX += sample.x
			sumY += sample.y
		}

		this.state.referenceX = this.config.referencePosition?.[0] ?? sumX / this.state.lockSamples.length
		this.state.referenceY = this.config.referencePosition?.[1] ?? sumY / this.state.lockSamples.length
		this.state.state = 'guiding'
		notes.push('lock_acquired')
		this.#updateDiagnostics(
			frame,
			tracking,
			{
				measurementX: measurement.x,
				measurementY: measurement.y,
				dx: measurement.x - this.state.referenceX,
				dy: measurement.y - this.state.referenceY,
				axisErrorRA: 0,
				axisErrorDEC: 0,
				usedMode: tracking.measurementMode,
				measurementMode: tracking.measurementMode,
				targetX: this.state.referenceX,
				targetY: this.state.referenceY,
				notes,
			},
			false,
			false,
			notes,
		)
	}

	// Detects impossible centroid jumps to avoid runaway corrections.
	#isImpossibleJump(measurement: { x: number; y: number }) {
		if (this.state.lastGoodMeasurementX === undefined || this.state.lastGoodMeasurementY === undefined) return false
		const dx = measurement.x - this.state.lastGoodMeasurementX
		const dy = measurement.y - this.state.lastGoodMeasurementY
		return dx * dx + dy * dy > this.config.maxFrameJumpPx * this.config.maxFrameJumpPx
	}

	// Classifies capture order and elapsed time from the monotonic clock when available. A supplied
	// cadence is the commanded exposure duration, so pulse and decode delays cannot look like a lost
	// exposure even when the arrival-clock interval is long.
	#classifyFrameClock(frame: GuideFrame) {
		const monotonic = frame.captureMonotonic
		const hasMonotonic = monotonic !== undefined && Number.isFinite(monotonic)
		const hasTimestamp = frame.timestamp !== undefined && frame.timestamp > 0 && Number.isFinite(frame.timestamp)
		const current = hasMonotonic ? monotonic : hasTimestamp ? frame.timestamp : undefined

		if (current === undefined) {
			if (frame.cadence !== undefined && frame.cadence > 0) this.state.lastCadence = frame.cadence
			return { outOfOrder: false, duplicate: false, dropped: false } as const
		}

		const previous = hasMonotonic ? this.state.lastCaptureMonotonic : this.state.lastTimestamp
		if (previous !== undefined && current <= previous) {
			return { outOfOrder: true, duplicate: current === previous, dropped: false } as const
		}

		if (hasMonotonic) this.state.lastCaptureMonotonic = monotonic
		else this.state.lastTimestamp = current

		const interval = previous === undefined ? undefined : current - previous
		if (frame.cadence !== undefined && frame.cadence > 0) this.state.lastCadence = frame.cadence
		else if (interval !== undefined && interval > 0) this.state.lastCadence = interval

		const dropped = frame.cadence === undefined && interval !== undefined && interval > this.config.nominalCadence * this.config.droppedFrameFactor
		return { outOfOrder: false, duplicate: false, dropped } as const
	}

	// Computes frame cadence scale to keep pulse gain stable across variable cadence.
	#cadenceScale(frame: GuideFrame) {
		const cadence = frame.cadence ?? (frame.timestamp === undefined ? this.config.nominalCadence : this.state.lastCadence)
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
	#updateDiagnostics(frame: GuideFrame, tracking: GuideTrackerResult, measurement: DiagnosticMeasurement | undefined, droppedFrame: boolean, badFrame: boolean, notes: readonly string[], targetLimit?: GuideTargetLimitDiagnostic) {
		const stellar = starTrackingOf(tracking)
		this.state.lastDiagnostics = {
			frameId: frame.frameId,
			totalStars: stellar?.detections.length ?? 0,
			acceptedStars: stellar?.accepted.length ?? 0,
			candidateCount: tracking.candidateCount,
			acceptedCount: tracking.acceptedCount,
			qualityScore: tracking.qualityScore,
			usedMode: measurement?.usedMode,
			measurementMode: measurement?.measurementMode ?? tracking.measurementMode,
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
			rejectedReasons: tracking.rejectedReasons,
			badFrame,
			lostFrames: this.state.consecutiveBadFrames,
			lost: this.state.state === 'lost',
			ditherActive: this.state.ditherActive,
			droppedFrame,
			notes,
			tracking,
			targetLimit,
		}
	}
}

// Gets opposite RA guide direction.
export function oppositeRA(direction: GuideDirectionRA) {
	return direction === 'WEST' ? 'EAST' : 'WEST'
}

// Gets opposite DEC guide direction.
export function oppositeDEC(direction: GuideDirectionDEC) {
	return direction === 'NORTH' ? 'SOUTH' : 'NORTH'
}
