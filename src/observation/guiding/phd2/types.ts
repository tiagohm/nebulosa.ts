import type { ImageRawType } from '../../../imaging/model/types'
import type { Point, Size } from '../../../math/numerical/geometry'

// Types and constants of PHD2's TCP event-monitoring / JSON-RPC protocol, shared by the PHD2 client, the
// PHD2-compatible server and the local guider: event names and payloads, command and reply envelopes, settle
// criteria, calibration and star-image shapes. Field names mirror the PHD2 protocol; nothing here allocates.

// Default PHD2 server TCP port.
export const DEFAULT_PHD2_PORT = 4400

// Names of the asynchronous events PHD2 emits.
// https://github.com/OpenPHDGuiding/phd2/wiki/EventMonitoring
export type PHD2EventType =
	| 'Alert'
	| 'AppState'
	| 'Calibrating'
	| 'CalibrationComplete'
	| 'CalibrationDataFlipped'
	| 'CalibrationFailed'
	| 'ConfigurationChange'
	| 'GuideParamChange'
	| 'GuideStep'
	| 'GuidingDithered'
	| 'GuidingStopped'
	| 'LockPositionLost'
	| 'LockPositionSet'
	| 'LockPositionShiftLimitReached'
	| 'LoopingExposures'
	| 'LoopingExposuresStopped'
	| 'Paused'
	| 'Resumed'
	| 'SettleBegin'
	| 'SettleDone'
	| 'Settling'
	| 'StarLost'
	| 'StarSelected'
	| 'StartCalibration'
	| 'StartGuiding'
	| 'Version'

// PHD2 application/guiding state.
export type PHD2AppState = 'Stopped' | 'Selected' | 'Calibrating' | 'Guiding' | 'LostLock' | 'Paused' | 'Looping'

// Severity of an Alert event, using the lowercase values PHD2 sends on the wire.
export type PHD2AlertType = 'info' | 'question' | 'warning' | 'error'

// Guide pulse direction.
export type PHD2GuideDirection = 'North' | 'South' | 'West' | 'East'

// Target of a mount-related command: the mount, the adaptive optics, or both.
export type PHD2WhichMount = 'MOUNT' | 'AO' | 'BOTH'

// Declination guiding mode.
export type PHD2DeclinationGuideMode = 'Off' | 'Auto' | 'North' | 'South'

// Units for a lock-shift rate.
export type PHD2RateUnit = 'arcsec/hr' | 'pixels/hr'

// Axes a lock-shift rate is expressed in.
export type PHD2ShiftAxis = 'RA/Dec' | 'X/Y'

// Guide algorithm axis selector.
export type PHD2GuideAxis = 'RA' | 'DEC'

// Event aliases for events that carry only the common base fields.
export type PHD2ConfigurationChangeEvent = PHD2Event<'ConfigurationChange'>

export type PHD2GuidingStoppedEvent = PHD2Event<'GuidingStopped'>

export type PHD2LockPositionLostEvent = PHD2Event<'LockPositionLost'>

export type PHD2LockPositionShiftLimitReachedEvent = PHD2Event<'LockPositionShiftLimitReached'>

export type PHD2LoopingExposuresStoppedEvent = PHD2Event<'LoopingExposuresStopped'>

export type PHD2PausedEvent = PHD2Event<'Paused'>

export type PHD2ResumedEvent = PHD2Event<'Resumed'>

export type PHD2SettleBeginEvent = PHD2Event<'SettleBegin'>

export type PHD2StartGuidingEvent = PHD2Event<'StartGuiding'>

// Common fields on every PHD2 event: the event name, timestamp, host, and instance number.
export interface PHD2Event<E extends PHD2EventType> {
	readonly Event: E
	readonly Timestamp: number
	readonly Host: string
	readonly Inst: number
}

// Event-specific payloads. Each interface adds the fields PHD2 sends for that event to the common base;
// field names follow the PHD2 protocol.

// PHD2 version/capability announcement sent on connect.
export interface PHD2VersionEvent extends PHD2Event<'Version'> {
	readonly PHDVersion: string
	readonly PHDSubver: string
	readonly OverlapSupport: boolean
	readonly MsgVersion: number
}

// User-facing alert message with a severity.
export interface PHD2AlertEvent extends PHD2Event<'Alert'> {
	readonly Msg: string
	readonly Type: PHD2AlertType
}

// Current application/guiding state.
export interface PHD2AppStateEvent extends PHD2Event<'AppState'> {
	readonly State: PHD2AppState
}

// One calibration step with its direction, distance, and offsets.
export interface PHD2CalibratingEvent extends PHD2Event<'Calibrating'> {
	readonly Mount: string
	readonly dir: string
	readonly dist: number
	readonly dx: number
	readonly dy: number
	readonly pos: unknown
	readonly step: number
	readonly State: string
}

// Calibration finished for the named mount.
export interface PHD2CalibrationCompleteEvent extends PHD2Event<'CalibrationComplete'> {
	readonly Mount: string
}

// Calibration data was flipped (e.g. after a meridian flip).
export interface PHD2CalibrationDataFlippedEvent extends PHD2Event<'CalibrationDataFlipped'> {
	readonly Mount: string
}

// Calibration failed, with a reason.
export interface PHD2CalibrationFailedEvent extends PHD2Event<'CalibrationFailed'> {
	readonly Reason: string
}

// A guide-algorithm parameter changed.
export interface PHD2GuideParamChangeEvent extends PHD2Event<'GuideParamChange'> {
	readonly Name: string
	readonly Value?: unknown
}

// One guide-frame correction: raw/guided distances, pulse durations/directions, star metrics, and limits.
export interface PHD2GuideStepEvent extends PHD2Event<'GuideStep'> {
	readonly Frame: number
	readonly Time: number
	readonly Mount: string
	readonly dx: number
	readonly dy: number
	readonly RADistanceRaw: number
	readonly DECDistanceRaw: number
	readonly RADistanceGuide: number
	readonly DECDistanceGuide: number
	readonly RADuration: number
	readonly RADirection: PHD2GuideDirection
	readonly DECDuration: number
	readonly DECDirection: PHD2GuideDirection
	readonly StarMass: number
	readonly SNR: number
	readonly HFD: number
	readonly AvgDist: number
	// Present only when the corresponding axis pulse was clipped by the maximum-duration limit.
	readonly RALimited?: boolean
	readonly DecLimited?: boolean
	readonly ErrorCode: number
}

// A dither was applied, with its pixel offset.
export interface PHD2GuidingDitheredEvent extends PHD2Event<'GuidingDithered'> {
	readonly dx: number
	readonly dy: number
}

// The lock position was set to pixel (X, Y).
export interface PHD2LockPositionSetEvent extends PHD2Event<'LockPositionSet'> {
	readonly X: number
	readonly Y: number
}

// One looping (non-guiding) exposure with its star metrics.
export interface PHD2LoopingExposuresEvent extends PHD2Event<'LoopingExposures'> {
	readonly Frame: number
	readonly StarMass: number
	readonly SNR: number
	readonly HFD: number
}

// Settling finished, with the frame totals and optional error.
export interface PHD2SettleDoneEvent extends PHD2Event<'SettleDone'> {
	readonly Status: number
	readonly TotalFrames: number
	readonly DroppedFrames: number
	readonly Error?: string
}

// Settling progress: current distance, elapsed/required time, and whether the star is locked.
export interface PHD2SettlingEvent extends PHD2Event<'Settling'> {
	readonly Distance: number
	readonly Time: number
	readonly SettleTime: number
	readonly StarLocked: boolean
}

// The guide star was lost, with the frame metrics and error/status.
export interface PHD2StarLostEvent extends PHD2Event<'StarLost'> {
	readonly Frame: number
	readonly Time: number
	readonly StarMass: number
	readonly SNR: number
	readonly AvgDist: number
	readonly ErrorCode: number
	readonly Status: string
}

// A star was selected at pixel (X, Y).
export interface PHD2StarSelectedEvent extends PHD2Event<'StarSelected'> {
	readonly X: number
	readonly Y: number
}

// Calibration started for the named mount.
export interface PHD2StartCalibrationEvent extends PHD2Event<'StartCalibration'> {
	readonly Mount: string
}

// Maps each event name to its concrete event interface.
export interface PHD2EventMap {
	readonly Version: PHD2VersionEvent
	readonly Alert: PHD2AlertEvent
	readonly AppState: PHD2AppStateEvent
	readonly Calibrating: PHD2CalibratingEvent
	readonly CalibrationComplete: PHD2CalibrationCompleteEvent
	readonly CalibrationDataFlipped: PHD2CalibrationDataFlippedEvent
	readonly CalibrationFailed: PHD2CalibrationFailedEvent
	readonly GuideParamChange: PHD2GuideParamChangeEvent
	readonly GuideStep: PHD2GuideStepEvent
	readonly GuidingDithered: PHD2GuidingDitheredEvent
	readonly LockPositionSet: PHD2LockPositionSetEvent
	readonly LoopingExposures: PHD2LoopingExposuresEvent
	readonly SettleDone: PHD2SettleDoneEvent
	readonly Settling: PHD2SettlingEvent
	readonly StarLost: PHD2StarLostEvent
	readonly StarSelected: PHD2StarSelectedEvent
	readonly StartCalibration: PHD2StartCalibrationEvent
	readonly ConfigurationChange: PHD2ConfigurationChangeEvent
	readonly GuidingStopped: PHD2GuidingStoppedEvent
	readonly LockPositionLost: PHD2LockPositionLostEvent
	readonly LockPositionShiftLimitReached: PHD2LockPositionShiftLimitReachedEvent
	readonly LoopingExposuresStopped: PHD2LoopingExposuresStoppedEvent
	readonly Paused: PHD2PausedEvent
	readonly Resumed: PHD2ResumedEvent
	readonly SettleBegin: PHD2SettleBeginEvent
	readonly StartGuiding: PHD2StartGuidingEvent
}

// JSON-RPC error returned for a failed command.
export interface PHD2Error {
	readonly code: number
	readonly message: string
}

// A JSON-RPC reply correlating to a sent command by id.
export interface PHD2JsonRpcEvent {
	readonly jsonrpc: string
	readonly id: string
	readonly result: unknown
	readonly error?: PHD2Error
}

// Discriminated union of all concrete event payloads.
export type PHD2Events =
	| PHD2AlertEvent
	| PHD2AppStateEvent
	| PHD2CalibratingEvent
	| PHD2CalibrationCompleteEvent
	| PHD2CalibrationDataFlippedEvent
	| PHD2CalibrationFailedEvent
	| PHD2ConfigurationChangeEvent
	| PHD2GuideParamChangeEvent
	| PHD2GuideStepEvent
	| PHD2GuidingDitheredEvent
	| PHD2GuidingStoppedEvent
	| PHD2LockPositionLostEvent
	| PHD2LockPositionSetEvent
	| PHD2LockPositionShiftLimitReachedEvent
	| PHD2LoopingExposuresEvent
	| PHD2LoopingExposuresStoppedEvent
	| PHD2PausedEvent
	| PHD2ResumedEvent
	| PHD2SettleBeginEvent
	| PHD2SettleDoneEvent
	| PHD2SettlingEvent
	| PHD2StarLostEvent
	| PHD2StarSelectedEvent
	| PHD2StartCalibrationEvent
	| PHD2StartGuidingEvent
	| PHD2VersionEvent

// An outgoing JSON-RPC command: unique id, method name, and optional positional/named params.
export interface PHD2Command {
	readonly id: string
	readonly method: string
	readonly params?: Readonly<Record<string, unknown> | unknown[]>
}

// A connected PHD2 equipment device by name.
export interface PHD2Device {
	readonly name: string
	readonly connected: boolean
}

// The currently selected PHD2 equipment profile devices.
export interface PHD2Equipment {
	readonly camera?: PHD2Device
	readonly mount?: PHD2Device
	readonly aux_mount?: PHD2Device
	readonly AO?: PHD2Device
	readonly rotator?: PHD2Device
}

// Settle criteria: settle tolerance (pixels), required settle time (s), and overall timeout (s).
export interface PHD2Settle {
	pixels: number
	time: number
	timeout: number
}

// Calibration geometry per axis: angle, rate, and parity.
export interface PHD2CalibrationData {
	readonly calibrated: boolean
	readonly xAngle: number
	readonly xRate: number
	readonly xParity: '+' | '-'
	readonly yAngle: number
	readonly yRate: number
	readonly yParity: '+' | '-'
}

// Lock-position shift parameters: enabled flag, [x, y] rate, units, and axes.
export interface PHD2LockShiftParams {
	readonly enabled: boolean
	readonly rate: readonly [number, number]
	readonly units: PHD2RateUnit
	readonly axes: PHD2ShiftAxis
}

// A PHD2 equipment profile.
export interface PHD2Profile {
	readonly id: number
	readonly name: string
	readonly selected: boolean
}

// A guide-star thumbnail: frame number, star position, and pixel data (base64 string or raw array).
export interface PHD2StarImage<P extends string | ImageRawType> extends Readonly<Size> {
	readonly frame: number
	// PHD2 sends the star position on the wire as [x, y]; the in-memory guider form is { x, y }. Pixels, relative to the crop origin.
	readonly star_pos: P extends string ? readonly [number, number] : Readonly<Point>
	readonly pixels: P
}

// Empty region-of-interest (no subframe).
export const DEFAULT_ROI: Readonly<Point & Size> = {
	x: 0,
	y: 0,
	width: 0,
	height: 0,
}

// Default settle criteria: 1.5 px within 10 s, timing out after 30 s.
export const DEFAULT_PHD2_SETTLE: Readonly<PHD2Settle> = {
	pixels: 1.5, // px
	time: 10, // s
	timeout: 30, // s
}

// PHD2 application version announced in the Version event. The local guider is not PHD2, so this
// reports the PHD2 release whose event protocol it reproduces.
export const PHD2_VERSION = '2.6.13'

// PHD2 sub-version component of the Version event; empty for a non-PHD2 implementation.
export const PHD2_SUBVER = ''

// Event protocol message version implemented by the local guider and server, matching PHD2's MsgVersion.
export const PHD2_MSG_VERSION = 1

// Overlapping exposures are not implemented by the local guider.
export const PHD2_OVERLAP_SUPPORT = false
