import type { GuidingAssistantResult } from './assistant'
import type { GuidingCalibrationDiagnostics, GuidingCalibrationFailure, GuidingCalibrationResult } from './calibrator'
import type { DitherMode } from './dither'
import type { AxisPulse, DeclinationGuideMode, GuideDiagnostics } from './guider'

// Native observation stream of the local guider (GuiderClient), emitted where its state machines decide:
// lifecycle and state changes, lock, calibration, per-frame guide steps, settling, dithering, the guiding
// assistant, alerts and setting changes. Each event is a fresh, immutable value carrying its own data, so a
// protocol adapter such as the PHD2 server translates it without querying the client. Positions and distances
// are guide-image pixels with the origin at the top-left of the full frame, X right and Y down; pulse
// durations are milliseconds; `timestamp` is the Unix time of the emission in milliseconds; guiding-relative
// times are seconds since guiding started.

// State of the local guider: stopped, exposing without a target, exposing with a selected target,
// calibrating, guiding, guiding with the lock lost, or paused.
export type GuiderState = 'stopped' | 'looping' | 'selected' | 'calibrating' | 'guiding' | 'lostLock' | 'paused'

// Severity of an alert.
export type GuidingAlertSeverity = 'info' | 'warning' | 'error'

// Unit of a lock-shift rate: guide pixels per hour or arcseconds per hour.
export type GuiderLockShiftUnit = 'pixelsPerHour' | 'arcsecPerHour'

// Axes a lock-shift rate is expressed in: the mount RA/DEC axes or the image X/Y axes.
export type GuiderLockShiftAxes = 'raDec' | 'xy'

// Drift compensation that moves the lock position at a constant rate.
export interface GuiderLockShift {
	// Whether the lock position is being shifted.
	readonly enabled: boolean
	// Rate along the first and second axis of `axes`, in `unit`.
	readonly rate: readonly [number, number]
	// Unit of `rate`.
	readonly unit: GuiderLockShiftUnit
	// Axes `rate` is expressed in.
	readonly axes: GuiderLockShiftAxes
}

// One runtime setting of the guider with its new value.
export type GuiderSettingChange =
	| { readonly setting: 'exposure'; readonly value: number }
	| { readonly setting: 'decGuideMode'; readonly value: DeclinationGuideMode }
	| { readonly setting: 'guideOutputEnabled'; readonly value: boolean }
	| { readonly setting: 'ditherMode'; readonly value: DitherMode }
	| { readonly setting: 'stickyLockPosition'; readonly value: boolean }
	| { readonly setting: 'lockShiftEnabled'; readonly value: boolean }
	| { readonly setting: 'lockShift'; readonly value: GuiderLockShift }

// Fields every guider event carries.
interface GuidingEventBase<T extends string> {
	// Event discriminant.
	readonly type: T
	// Unix time of the emission, in milliseconds.
	readonly timestamp: number
}

// Star metrics of the tracked target of one frame, zero when the frame has no measurable target.
export interface GuidingStarMetrics {
	// Integrated star flux, in the tracker's normalized units.
	readonly mass: number
	// Signal-to-noise ratio of the target.
	readonly snr: number
	// Half-flux diameter of the target, in pixels.
	readonly hfd: number
}

// Correction of one mount axis in one guide step.
export interface GuidingAxisCorrection {
	// Direction of the correction, absent when the axis was not corrected.
	readonly direction?: AxisPulse['direction']
	// Pulse duration the controller asked for, in milliseconds, before output gating.
	readonly requested: number
	// Pulse duration reported as issued, in whole milliseconds: zero while the output is disabled or paused.
	readonly duration: number
	// Whether the issued pulse reached the per-axis maximum and was limited by it.
	readonly limited: boolean
}

// The client bound a camera and a guide output; `state` is the guider state right after binding.
export interface GuiderConnectedEvent extends GuidingEventBase<'connected'> {
	readonly state: GuiderState
}

// The client released its camera and guide output.
export type GuiderDisconnectedEvent = GuidingEventBase<'disconnected'>

// The guider state changed from `previous` to `state`.
export interface GuiderStateChangedEvent extends GuidingEventBase<'stateChanged'> {
	readonly state: GuiderState
	readonly previous: GuiderState
}

// A runtime setting changed.
export type GuiderSettingChangedEvent = GuidingEventBase<'settingChanged'> & GuiderSettingChange

// A target star was selected from the current frame at (`x`, `y`), which also became the lock position.
export interface GuiderTargetSelectedEvent extends GuidingEventBase<'targetSelected'> {
	readonly x: number
	readonly y: number
}

// The lock position was set explicitly to (`x`, `y`).
export interface GuiderLockPositionSetEvent extends GuidingEventBase<'lockPositionSet'> {
	readonly x: number
	readonly y: number
}

// The lock was given up after the target could not be measured; corrections stop until it is recovered.
export type GuiderLockLostEvent = GuidingEventBase<'lockLost'>

// The target could not be measured in one guiding frame.
export interface GuiderStarLostEvent extends GuidingEventBase<'starLost'>, GuidingStarMetrics {
	// Frame the target was lost in.
	readonly frameId: number
	// Seconds since guiding started, zero outside guiding.
	readonly guidingTime: number
	// Smoothed guide distance of the last measured frames, in pixels.
	readonly averageDistance: number
	// Controller notes explaining the loss.
	readonly notes: readonly string[]
}

// Lock-shift drift compensation reached the edge of the search area and stopped moving the lock.
export type GuiderLockShiftLimitReachedEvent = GuidingEventBase<'lockShiftLimitReached'>

// One frame was exposed while looping without guiding.
export interface GuiderLoopingFrameEvent extends GuidingEventBase<'loopingFrame'>, GuidingStarMetrics {
	readonly frameId: number
}

// Calibration started on the named guide output.
export interface GuiderCalibrationStartedEvent extends GuidingEventBase<'calibrationStarted'> {
	readonly guideOutput: string
}

// One calibration frame was processed.
export interface GuiderCalibrationStepEvent extends GuidingEventBase<'calibrationStep'> {
	readonly guideOutput: string
	// Calibrator diagnostics after the frame.
	readonly diagnostics: GuidingCalibrationDiagnostics
}

// Calibration solved on the named guide output.
export interface GuiderCalibrationCompletedEvent extends GuidingEventBase<'calibrationCompleted'> {
	readonly guideOutput: string
	readonly calibration: GuidingCalibrationResult
}

// Calibration failed; the incomplete solution was discarded.
export interface GuiderCalibrationFailedEvent extends GuidingEventBase<'calibrationFailed'> {
	readonly guideOutput: string
	readonly failure: GuidingCalibrationFailure
}

// The solved calibration was cleared.
export type GuiderCalibrationClearedEvent = GuidingEventBase<'calibrationCleared'>

// The solved calibration was flipped for the other side of the pier.
export interface GuiderCalibrationFlippedEvent extends GuidingEventBase<'calibrationFlipped'> {
	readonly guideOutput: string
}

// Guiding started with a valid calibration.
export type GuiderGuidingStartedEvent = GuidingEventBase<'guidingStarted'>

// Guiding stopped; the exposure loop may still be running.
export type GuiderGuidingStoppedEvent = GuidingEventBase<'guidingStopped'>

// The exposure loop stopped.
export type GuiderLoopingStoppedEvent = GuidingEventBase<'loopingStopped'>

// One guiding frame was measured and corrected.
export interface GuiderGuideStepEvent extends GuidingEventBase<'guideStep'>, GuidingStarMetrics {
	readonly frameId: number
	// Seconds since guiding started.
	readonly guidingTime: number
	readonly guideOutput: string
	// Image-space error of the target from the lock position, in pixels.
	readonly dx: number
	readonly dy: number
	// Error along the RA and DEC mount axes, in pixels: the controller's pulse-equivalent milliseconds
	// converted with the solved axis rates, or the raw controller value before calibration.
	readonly raDistance: number
	readonly decDistance: number
	// Filtered error the controller corrected along each axis, in pixels; zero while the output is disabled
	// or paused.
	readonly raGuideDistance: number
	readonly decGuideDistance: number
	readonly ra: GuidingAxisCorrection
	readonly dec: GuidingAxisCorrection
	// Smoothed guide distance, in pixels.
	readonly averageDistance: number
	// Controller diagnostics of the step.
	readonly diagnostics: GuideDiagnostics
}

// Settling began after a dither, a guide start or a resume.
export type GuiderSettleStartedEvent = GuidingEventBase<'settleStarted'>

// Settling progress after one frame.
export interface GuiderSettlingEvent extends GuidingEventBase<'settling'> {
	// Current guide distance, in pixels.
	readonly distance: number
	// Seconds the distance has stayed within tolerance.
	readonly timeInRange: number
	// Seconds the distance must stay within tolerance.
	readonly settleTime: number
	// Whether the target was measured in the frame.
	readonly starLocked: boolean
}

// Settling ended, successfully or with `error`.
export interface GuiderSettleDoneEvent extends GuidingEventBase<'settleDone'> {
	readonly succeeded: boolean
	// Frames processed while settling.
	readonly totalFrames: number
	// Frames dropped while settling.
	readonly droppedFrames: number
	// Reason of a failed settle.
	readonly error?: string
}

// The lock position moved by (`dx`, `dy`) pixels for a dither.
export interface GuiderDitheredEvent extends GuidingEventBase<'dithered'> {
	readonly dx: number
	readonly dy: number
}

// The guider paused; a full pause also stops exposing.
export interface GuiderPausedEvent extends GuidingEventBase<'paused'> {
	readonly full: boolean
}

// The guider resumed from a pause.
export type GuiderResumedEvent = GuidingEventBase<'resumed'>

// Something the user should know about went wrong or needs attention.
export interface GuiderAlertEvent extends GuidingEventBase<'alert'> {
	readonly message: string
	readonly severity: GuidingAlertSeverity
}

// Stage of the guiding assistant: started, measured one more frame, completed or failed.
export type GuiderAssistantEventType = 'assistantStarted' | 'assistantUpdated' | 'assistantCompleted' | 'assistantFailed'

// Guiding assistant lifecycle, each carrying its latest result.
export interface GuiderAssistantEvent<T extends GuiderAssistantEventType = GuiderAssistantEventType> extends GuidingEventBase<T> {
	readonly result: GuidingAssistantResult
}

// Every event the local guider emits.
export type GuidingEvent =
	| GuiderConnectedEvent
	| GuiderDisconnectedEvent
	| GuiderStateChangedEvent
	| GuiderSettingChangedEvent
	| GuiderTargetSelectedEvent
	| GuiderLockPositionSetEvent
	| GuiderLockLostEvent
	| GuiderStarLostEvent
	| GuiderLockShiftLimitReachedEvent
	| GuiderLoopingFrameEvent
	| GuiderCalibrationStartedEvent
	| GuiderCalibrationStepEvent
	| GuiderCalibrationCompletedEvent
	| GuiderCalibrationFailedEvent
	| GuiderCalibrationClearedEvent
	| GuiderCalibrationFlippedEvent
	| GuiderGuidingStartedEvent
	| GuiderGuidingStoppedEvent
	| GuiderLoopingStoppedEvent
	| GuiderGuideStepEvent
	| GuiderSettleStartedEvent
	| GuiderSettlingEvent
	| GuiderSettleDoneEvent
	| GuiderDitheredEvent
	| GuiderPausedEvent
	| GuiderResumedEvent
	| GuiderAlertEvent
	| GuiderAssistantEvent<'assistantStarted'>
	| GuiderAssistantEvent<'assistantUpdated'>
	| GuiderAssistantEvent<'assistantCompleted'>
	| GuiderAssistantEvent<'assistantFailed'>

// Discriminant of a guider event.
export type GuidingEventType = GuidingEvent['type']

// Data of a guider event of type `T`, without its `type` and `timestamp`; a union stays a union of data.
export type GuidingEventData<T extends GuidingEventType> = Extract<GuidingEvent, { readonly type: T }> extends infer E ? (E extends unknown ? Omit<E, 'type' | 'timestamp'> : never) : never
