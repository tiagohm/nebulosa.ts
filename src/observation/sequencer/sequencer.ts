import { PI, PIOVERTWO, SIDEREAL_DRIFT_RATE, TAU } from '../../core/constants'
import type { FocuserCommander } from '../../devices/commanders/focuser'
import type { WheelCommander } from '../../devices/commanders/wheel'
import type { Camera, Cover, Dome, FlatPanel, Focuser, FrameType, Mount, PierSide, Rotator, TrackMode, Wheel } from '../../devices/indi/device'
import type { OperationCoordinator, OperationFailureReason, OperationResult } from '../../devices/orchestration/operation'
import { abortableDelay } from '../../devices/orchestration/operation.wait'
import type { CameraCaptureClock, CameraCaptureStart, CameraExposureTimeUnit } from '../../devices/runners/camera.capture.types'
import { isPathSegment } from '../../io/path'
import type { Angle } from '../../math/units/angle'
import type { AutoFocusFittingMode, AutoFocusOptions } from '../focus/autofocus'
import type { AutoFocusMeasurer } from '../focus/autofocus.runner'
import type { Ditherer } from '../guiding/ditherer'
import type { GuidingSession } from '../guiding/session'
import type { CenteringSolver } from '../mount/centering'
import type { SequencerStorage } from './storage'

// Public contracts of the acquisition Sequencer: the declarative, JSON-serializable session configuration,
// the resolved devices it runs against, its clock and safety boundaries, the frame-slot identity, the logical
// state persisted between processes (intents, trigger anchors, focus baseline, the checkpoint and its store), and the observable surface
// (snapshot, events, failure, result, handle). It also holds the structural validation of a configuration
// that arrives from outside the process (JSON, HTTP), which never touches devices.
//
// Conventions: angles in radians, configured durations in seconds (converted to milliseconds only where a
// clock or commander is called), wall instants in Unix milliseconds (UTC), monotonic instants in milliseconds
// of the process and named with the `Monotonic` suffix, temperatures in degrees Celsius, focuser positions in
// steps, filter-wheel slots 0-based. Every configuration object is read-only; validation returns the input
// object itself, never a copy.

// Identifies the only target frame of the first version. 'J2000' means ICRS here: the input frame of
// `mountTargetEquatorial` with `type: 'J2000'` and the frame `plateSolutionFrom` guarantees. FK5 J2000 differs
// by the frame bias (at most 0.03″) and is accepted only as a documented approximation at the solver input.
// The discriminant exists for later target kinds.
export interface SequencerTarget {
	// Equatorial frame of the coordinates; only 'J2000' (ICRS) in the first version.
	readonly frame: 'J2000'
	// Right ascension, in radians, in [0, 2π).
	readonly rightAscension: Angle
	// Declination, in radians, in [−π/2, π/2].
	readonly declination: Angle
	// Display name; never used as identity.
	readonly name?: string
}

// Filter selected by its 0-based wheel slot or by its name in `wheel.names`. It is resolved against the wheel
// before any movement is commanded; an unresolvable reference fails the safe point without moving anything.
export type SequencerFilterReference =
	// 0-based wheel slot.
	| { readonly kind: 'slot'; readonly slot: number }
	// Exact filter name as published in `wheel.names`.
	| { readonly kind: 'name'; readonly name: string }

// Camera settings a frame group controls. Every operational field of `CameraCaptureStart` (exposure mode,
// count, delay, transfer format, destination, snooped devices) is fixed by the Sequencer on every capture.
export type SequencerCameraCapture = Readonly<Pick<CameraCaptureStart, 'exposureTime' | 'exposureTimeUnit' | 'frameType' | 'x' | 'y' | 'width' | 'height' | 'subframe' | 'binX' | 'binY' | 'frameFormat' | 'gain' | 'offset' | 'compressed'>>

// Absolute focus offsets per filter name, in focuser steps relative to the in-focus position of the
// reference filter. `offsets[reference]` is implicitly 0; a filter without an entry has no known offset (never
// assumed 0) and never commands the focuser.
export interface SequencerFilterFocusOffsets {
	// Name of the reference filter whose in-focus position is the baseline.
	readonly reference: string
	// Offset of each filter from the reference, in steps; safe integers.
	readonly offsets: Readonly<Record<string, number>>
}

// Quality criteria that discard a physically completed exposure.
export interface SequencerDiscardCriteria {
	// Discards a frame the quality analyzer classified 'rejected'; 'unknown' never discards.
	readonly quality: boolean
	// Discards a frame whose exposure window [dispatch, end] (monotonic domain) contains a guiding interruption.
	// A window the interruption history no longer covers counts as interrupted (fail-closed).
	readonly guidingInterruption: boolean
	// Discards a frame whose exposure window [dispatch, end] (monotonic domain) saw safety unsafe (or unknown when
	// `unknownIsUnsafe`), according to the transition history, never to the state read after the exposure.
	readonly unsafeDuringExposure: boolean
}

// How discarded frames are bounded and disposed of.
export interface SequencerFrameDiscardPolicy {
	// Criteria that discard a frame.
	readonly criteria: SequencerDiscardCriteria
	// Discards allowed per slot before `onExhausted`; safe integer ≥ 0. 0 classifies and records the frame but
	// never retakes the slot.
	readonly maxDiscardsPerSlot: number
	// What happens when the slot budget is exhausted:
	// - keepLast: the last discarded frame is promoted as accepted, marked forced;
	// - skipSlot: the slot ends without an accepted frame and the group finishes with fewer frames;
	// - pause: the session pauses at a safe point; resume retakes the same slot with a renewed budget;
	// - fail: the session fails with a 'quality' failure.
	readonly onExhausted: 'keepLast' | 'skipSlot' | 'pause' | 'fail'
	// Circuit breaker across slots: consecutive discards in any group; safe integer ≥ 0. Present together with
	// `onConsecutiveExhausted`.
	readonly maxConsecutiveDiscards?: number
	// Session action when the circuit breaker trips.
	readonly onConsecutiveExhausted?: 'pause' | 'stop' | 'fail'
	// Disposition of the discarded file; 'moveToRejected' keeps the data outside the final destination.
	readonly artifact: 'moveToRejected' | 'keepInPlace' | 'delete'
}

// Fields shared by every frame group.
interface SequencerFrameGroupBase {
	// Stable identity; a portable path segment, unique among all groups. It composes the slot ids, so renaming it
	// creates a new identity.
	readonly id: string
	// Disabled groups keep their configuration but never produce slots.
	readonly enabled: boolean
	// Filter of every frame of the group; absent leaves the wheel where it is.
	readonly filter?: SequencerFilterReference
	// Camera settings of every frame of the group.
	readonly capture: SequencerCameraCapture
	// Discard policy; absent accepts every completed frame.
	readonly discard?: SequencerFrameDiscardPolicy
}

// Frames chosen by the scheduler according to `capture.order`.
export interface SequencerScheduledFrameGroup extends SequencerFrameGroupBase {
	// Discriminant of a scheduled group.
	readonly kind: 'scheduled'
	// Accepted frames requested (slots); safe integer ≥ 0. Discarded frames do not count.
	readonly count: number
	// Positive finite weight; required by 'weightedRoundRobin' and unused by the other orders.
	readonly weight?: number
}

// What injects a batch of a triggered group.
export type SequencerFrameGroupTrigger =
	// After every `frames` completed (accepted or discarded) light exposures of `sourceGroups`, or of every
	// scheduled LIGHT group when absent. `frames` is a safe integer ≥ 1.
	| { readonly kind: 'afterFrames'; readonly frames: number; readonly sourceGroups?: readonly string[] }
	// When the sensor temperature moved at least `delta` °C (finite > 0) from the anchor of the last accepted
	// batch; the anchor starts at the first light exposure.
	| { readonly kind: 'temperatureChange'; readonly delta: number; readonly sourceGroups?: readonly string[] }
	// Once, before the first scheduled frame.
	| { readonly kind: 'sessionStart' }
	// Once the scheduled groups are exhausted, before the shutdown; `onStop` also runs it on a graceful stop.
	| { readonly kind: 'sessionEnd'; readonly onStop: boolean }

// How a calibration frame keeps light out.
export type SequencerCalibrationOpticalPath =
	// The camera shutter, or darkness the user guarantees; nothing is commanded.
	| { readonly kind: 'none' }
	// Closes the cover (and turns off a co-resident flat panel); reopened before the next light.
	| { readonly kind: 'cover' }
	// Moves the wheel to an opaque slot, without focus offset.
	| { readonly kind: 'filter'; readonly filter: SequencerFilterReference }

// Frames injected by a trigger (interleaved darks and biases).
export interface SequencerTriggeredFrameGroup extends SequencerFrameGroupBase {
	// Discriminant of a triggered group.
	readonly kind: 'triggered'
	// What injects a batch.
	readonly trigger: SequencerFrameGroupTrigger
	// Frames per batch; safe integer ≥ 1.
	readonly batchSize: number
	// Absolute ceiling of the group in the session; safe integer ≥ `batchSize`. It guarantees termination.
	readonly maxFrames: number
	// 'triggeringFrame' copies exposure, unit, binning, gain, offset, subframe, frame format and compression of
	// the light that fired the batch; `capture.frameType` (DARK or BIAS) always prevails.
	readonly inherit: 'none' | 'triggeringFrame'
	// How light is kept out.
	readonly opticalPath: SequencerCalibrationOpticalPath
}

// A frame group of the session.
export type SequencerFrameGroup = SequencerScheduledFrameGroup | SequencerTriggeredFrameGroup

// Order in which scheduled groups receive slots:
// - sequential: exhausts the first enabled group before the next;
// - roundRobin: one slot per unfinished group, in declared order, wrapping;
// - weightedRoundRobin: deterministic weighted round robin over the group weights (Tijdeman's chairman assignment):
//   while the set of unfinished groups does not change, every group stays within one selection of its share.
export type SequencerCaptureOrder = 'sequential' | 'roundRobin' | 'weightedRoundRobin'

// Bounded retry of one operation. Attempt 1 is the initial execution; an abort never becomes a retry.
export interface SequencerRetryPolicy {
	// Total attempts, including the first; safe integer ≥ 1.
	readonly maxAttempts: number
	// Delay before the first retry, in seconds; finite ≥ 0.
	readonly delay: number
	// Multiplier applied to the delay after each retry; finite ≥ 1.
	readonly backoff: number
	// Ceiling of the delay, in seconds; finite ≥ `delay`.
	readonly maximumDelay: number
	// Failure reasons that are retried; any other reason applies the failure policy at once.
	readonly retryOn: readonly OperationFailureReason[]
}

// Session action once the retries of a step are exhausted.
export type SequencerFailureAction = 'fail' | 'pause' | 'stop'

// Failure action of an explicitly optional feature, which may also skip the step and continue.
export type SequencerOptionalFailureAction = SequencerFailureAction | 'skip'

// Failure action of a primary capture, which may also give up the slot and continue.
export type SequencerCaptureFailureAction = SequencerFailureAction | 'skipFrame'

// Whether a failed shutdown step makes the session fail ('required') or is only reported ('bestEffort').
export type SequencerShutdownStepPolicy = 'required' | 'bestEffort'

// Wait for a camera quarantined by a late frame payload before retrying a capture. The wait never consumes
// capture attempts.
export interface SequencerCameraRecoveryConfiguration {
	// Longest wait, in seconds (monotonic); finite > 0. Default `DEFAULT_SEQUENCER_CAMERA_RECOVERY.timeout`.
	readonly timeout?: number
	// Interval between availability checks, in seconds; finite > 0. Default `DEFAULT_SEQUENCER_CAMERA_RECOVERY.pollInterval`.
	readonly pollInterval?: number
	// Session action when the camera is still quarantined at the timeout.
	readonly onTimeout: SequencerFailureAction
}

// Cooperative limits of the caller-provided quality analyzer.
export interface SequencerQualityConfiguration {
	// Time after which the analysis is aborted and the frame classified 'unknown', in seconds; finite > 0.
	readonly timeout: number
	// Watchdog after the abort before the analyzer is reported unresponsive, in seconds; finite > 0. Default
	// `DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE`.
	readonly abortGrace?: number
}

// Primary frames of the session.
export interface SequencerCaptureConfiguration {
	// Order of the scheduled groups.
	readonly order: SequencerCaptureOrder
	// Frame groups in declared order; may be empty, which completes the session at once.
	readonly groups: readonly SequencerFrameGroup[]
	// Retry of a capture that produced no frame (not of a discarded frame).
	readonly retry: SequencerRetryPolicy
	// Action once `retry.maxAttempts` consecutive captures of a slot failed.
	readonly onFailure: SequencerCaptureFailureAction
	// Wait for a quarantined camera.
	readonly cameraRecovery: SequencerCameraRecoveryConfiguration
	// Absolute focus offsets per filter; absent never moves the focuser on a filter change.
	readonly focusOffsets?: SequencerFilterFocusOffsets
	// Limits of the quality analyzer; required when an analyzer is provided.
	readonly quality?: SequencerQualityConfiguration
}

// Camera cooling of the startup, also the thermal guard of DARK frames.
export interface SequencerCoolingConfiguration {
	// Sensor setpoint, in °C; finite.
	readonly setpoint: number
	// Accepted distance from the setpoint, in °C; finite > 0.
	readonly tolerance: number
	// Time the sensor must stay continuously within tolerance, in seconds; finite ≥ 0.
	readonly stableFor: number
	// Longest wait for stability, in seconds; finite > 0. Exhausted → startup failure policy.
	readonly timeout: number
	// Whether the startup waits for stability instead of only sending the setpoint.
	readonly waitForTemperature: boolean
}

// Equipment lifecycle of the startup. It never selects filters, rotates, focuses, guides, dithers or centers:
// every frame-specific preparation belongs to the pre-capture.
export interface SequencerStartupConfiguration {
	// Camera cooling; absent leaves the cooler untouched.
	readonly cooling?: SequencerCoolingConfiguration
	// Opens the dome or roof after a safety gate.
	readonly dome?: { readonly open: boolean }
	// Opens the cover after a safety gate.
	readonly cover?: { readonly open: boolean }
	// Unparks the mount after a safety gate and sets its tracking mode. The startup never turns tracking on.
	// With a target or a meridian flip the tracking mode is SIDEREAL; any other mode is refused.
	readonly mount?: { readonly unpark: boolean; readonly trackMode?: TrackMode }
	// Retry of a failed startup step; absent runs each step once.
	readonly retry?: SequencerRetryPolicy
	// Action once a startup step failed.
	readonly onFailure: SequencerFailureAction
}

// Shutdown steps, in the fixed physical order of the session: stop tracking, stop guiding, close the cover,
// park the mount, close or park the dome, turn off the flat panel, warm the camera. Absent steps never run.
// Guiding is always paused before tracking stops.
export interface SequencerShutdownConfiguration {
	// Timeout of each step, in seconds; finite > 0.
	readonly stepTimeout: number
	// Timeout of the whole shutdown, in seconds; finite > 0. It never cuts the pause-guiding → tracking-off prefix.
	readonly totalTimeout: number
	// Turns tracking off; required with a meridian flip, whose supervision ends at the observed tracking off.
	readonly stopTracking?: SequencerShutdownStepPolicy
	// Stops guiding.
	readonly stopGuiding?: SequencerShutdownStepPolicy
	// Closes the cover.
	readonly closeCover?: SequencerShutdownStepPolicy
	// Parks the mount.
	readonly parkMount?: SequencerShutdownStepPolicy
	// Closes or parks the dome or roof.
	readonly closeOrParkDome?: SequencerShutdownStepPolicy
	// Turns the flat panel off.
	readonly turnOffFlatPanel?: SequencerShutdownStepPolicy
	// Warms the camera and disables the cooler.
	readonly warmCamera?: SequencerShutdownStepPolicy
}

// Disposition of an auxiliary (centering or autofocus) FITS once its collaborator finished.
export type SequencerAuxiliaryArtifact = 'delete' | 'keep'

// Plate-solved centering after a slew and on recenter. Success is measured by a solve after the last
// correction, never assumed after a corrective slew.
export interface SequencerCenteringConfiguration {
	// Accepted angular distance between the solved center and the target, in radians; finite > 0.
	readonly tolerance: Angle
	// Capture-and-solve iterations; safe integer ≥ 1.
	readonly maximumAttempts: number
	// Mechanical settle after each corrective slew, in seconds; finite ≥ 0.
	readonly settle: number
	// Syncs the mount to the solution before a corrective slew.
	readonly syncMount: boolean
	// Camera settings of the auxiliary frames.
	readonly capture: SequencerCameraCapture
	// Cooperative timeout of one solve, in seconds; finite > 0.
	readonly solveTimeout: number
	// Watchdog after an aborted solve, in seconds; finite > 0. Default `DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE`.
	readonly abortGrace?: number
	// Disposition of the auxiliary frames. Default 'delete'.
	readonly auxiliary?: SequencerAuxiliaryArtifact
}

// Periodic recenter of an acquired target.
export interface SequencerRecenterConfiguration {
	// Light exposures between recenters; safe integer ≥ 1.
	readonly afterFrames?: number
	// Time between recenters, in seconds; finite > 0.
	readonly interval?: number
}

// Target acquisition and recentering; requires a target and a mount.
export interface SequencerPointingConfiguration {
	// Mechanical settle after a slew, in seconds; finite ≥ 0.
	readonly settle: number
	// Plate-solved centering; absent trusts the slew.
	readonly centering?: SequencerCenteringConfiguration
	// Periodic recenter; absent recenters only on request (meridian flip, quality, external motion).
	readonly recenter?: SequencerRecenterConfiguration
	// Retry of a failed acquisition; absent runs it once.
	readonly retry?: SequencerRetryPolicy
	// Action once the acquisition failed. The first frame is never exposed before the target is verified.
	readonly onFailure: SequencerFailureAction
}

// Field rotation before autofocus, of LIGHT frames only.
export interface SequencerRotatorConfiguration {
	// Mechanical angle of the rotator, in radians, in [0, 2π); converted to degrees only for the rotator commander,
	// which maps it into the range the driver publishes.
	readonly angle: Angle
	// Accepted angular distance (wrapped) from `angle`, in radians; finite > 0.
	readonly tolerance: Angle
	// Mechanical settle after a rotation, in seconds; finite ≥ 0.
	readonly settle: number
	// Retry of a failed rotation; absent runs it once.
	readonly retry?: SequencerRetryPolicy
	// Action once the rotation failed.
	readonly onFailure: SequencerFailureAction
}

// Curve-fitting options of the reusable `AutoFocus` state machine; the upper focuser bound comes from the device.
export type SequencerAutofocusAlgorithm = Readonly<Omit<AutoFocusOptions, 'maxPosition'>>

// When an autofocus is due. Light exposures count accepted and discarded lights; darks and biases never count.
// Anchors advance only after a successful autofocus.
export interface SequencerAutofocusTriggers {
	// Before the first light of the session.
	readonly onStart: boolean
	// Before the first light after `resume()` or a restart.
	readonly afterResume: boolean
	// After a meridian flip completed by the session.
	readonly afterFlip: boolean
	// When the filter in place for the light differs, by name, from the one of the light the last autofocus ran for;
	// never due before a first successful autofocus.
	readonly onFilterChange: boolean
	// Light exposures between autofocus runs; safe integer ≥ 1.
	readonly afterFrames?: number
	// Time between autofocus runs, in seconds (monotonic in runtime); finite > 0. Never due before a first success.
	readonly interval?: number
	// Focuser temperature change since the last autofocus, in °C; finite > 0. Never due before a first success nor
	// with a focuser that publishes no temperature.
	readonly temperatureDelta?: number
}

// Autofocus of the pre-capture; requires a focuser.
export interface SequencerAutofocusConfiguration {
	// Curve-fitting options.
	readonly algorithm: SequencerAutofocusAlgorithm
	// Camera settings of the auxiliary frames.
	readonly capture: SequencerCameraCapture
	// Dedicated autofocus filter; never an opaque slot. Absent focuses through the frame filter.
	readonly filter?: SequencerFilterReference
	// When an autofocus is due. A light with an unknown focus baseline always requires one.
	readonly triggers: SequencerAutofocusTriggers
	// Cooperative timeout of one HFD measurement, in seconds; finite > 0.
	readonly measureTimeout: number
	// Watchdog after an aborted measurement, in seconds; finite > 0. Default `DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE`.
	readonly abortGrace?: number
	// Disposition of the auxiliary frames. Default 'delete'.
	readonly auxiliary?: SequencerAuxiliaryArtifact
	// Retry of a failed autofocus; absent runs it once.
	readonly retry?: SequencerRetryPolicy
	// Action once the autofocus failed. 'skip' never exposes a light with an unknown focus baseline.
	readonly onFailure: SequencerOptionalFailureAction
}

// Settle condition of guiding, in the shape of a PHD2 settle.
export interface SequencerGuidingSettle {
	// Accepted guide error, in guide-camera pixels; finite > 0.
	readonly pixels: number
	// Time the error must stay within `pixels`, in seconds; finite ≥ 0.
	readonly time: number
	// Longest settle, in seconds; finite > 0.
	readonly timeout: number
}

// Guiding of LIGHT frames through the caller-provided guiding session.
export interface SequencerGuidingConfiguration {
	// Settle required after start, resume and recovery.
	readonly settle: SequencerGuidingSettle
	// Bound of a guiding pause, including the physical quiescence of dispatched pulses, in seconds; finite > 0.
	readonly pauseTimeout: number
	// Recoveries of lost guiding per safe point; safe integer ≥ 0.
	readonly maxRecoveries: number
	// Recalibrates when guiding starts.
	readonly recalibrate: boolean
	// Flips the guiding calibration after a meridian flip, when the session supports it.
	readonly flipCalibration: boolean
	// Action once guiding could not be established.
	readonly onFailure: SequencerOptionalFailureAction
}

// Dither amount.
export type SequencerDitherAmount =
	// Guide-camera pixels; finite > 0.
	| { readonly unit: 'guidePixel'; readonly value: number }
	// Angle on the sky plane, in radians; finite > 0.
	| { readonly unit: 'angle'; readonly value: Angle }

// Settle after a dither.
export type SequencerDitherSettle =
	// Guided settle: guide error within `pixels` (> 0) for `time` seconds (≥ 0), within `timeout` seconds (> 0).
	| { readonly kind: 'guided'; readonly pixels: number; readonly time: number; readonly timeout: number }
	// Fixed mechanical wait of `time` seconds (≥ 0).
	| { readonly kind: 'mechanical'; readonly time: number }

// Dither between light frames, through the caller-provided ditherer. Dither never runs for darks and biases, nor
// before the first light of the session or after a recenter or flip (the next due dither is postponed, not lost).
export interface SequencerDitherConfiguration {
	// Light exposures between dithers; safe integer ≥ 1.
	readonly afterFrames: number
	// Dither amount.
	readonly amount: SequencerDitherAmount
	// Dithers in right ascension only.
	readonly raOnly: boolean
	// Settle after the dither; the dither ends only when it is satisfied.
	readonly settle: SequencerDitherSettle
	// Action once the dither or its settle failed.
	readonly onFailure: SequencerOptionalFailureAction
}

// Timeouts of the hard meridian protection, in seconds, finite > 0.
export interface SequencerHardProtectionTiming {
	// Settle timeout of every supervised mount command (centering slews, dither by slew, motion stop).
	readonly mountStopTimeout?: number
	// Wait for a guiding stop when the guiding pause failed.
	readonly guidingStopTimeout?: number
	// Timeout of the protective tracking off.
	readonly trackingTimeout?: number
}

// Meridian flip driven by the pure state machine of `observation/mount/meridian.flip.ts`. Hour angles in
// radians in (−π, π]; durations in seconds. Optional fields default to `DEFAULT_SEQUENCER_MERIDIAN_FLIP`.
export interface SequencerMeridianFlipConfiguration {
	// Enables the flip and its supervision; the remaining fields are kept when disabled.
	readonly enabled: boolean
	// Hour angle where preparation (a warning without physical effect) begins; ≤ `flipAt`.
	readonly prepareAt: Angle
	// First hour angle at which the flip may start; < `latestAt` and ≤ `latestAt − protectionMargin × SIDEREAL_DRIFT_RATE`.
	readonly flipAt: Angle
	// Last hour angle at which the flip may start with tracking on, on the pre-flip side. A user policy, not a
	// collision limit during the slew.
	readonly latestAt: Angle
	// Pier side before the flip; EAST or WEST, distinct from `afterFlipPierSide`.
	readonly beforeFlipPierSide: PierSide
	// Pier side after the flip; EAST or WEST, distinct from `beforeFlipPierSide`.
	readonly afterFlipPierSide: PierSide
	// Wait for a NEITHER pier side to resolve, in seconds; finite > 0.
	readonly pierSideTimeout?: number
	// Flip retries after the first started flip; safe integer ≥ 0. A durable budget across restarts.
	readonly maxRetries?: number
	// Recenters after the flip; default true with a target.
	readonly requireRecentering?: boolean
	// Resumes guiding and waits for its settle after the flip; default true with guiding.
	readonly requireGuidingSettle?: boolean
	// Time added to the exposure by the final guard (download, driver latency), in seconds; finite ≥ 0.
	readonly exposureMargin?: number
	// Advance of the graceful protection deadline before `latestAt`, in seconds; finite > 0 and at least the hard
	// protection lead.
	readonly protectionMargin?: number
	// Timeouts of the hard protection.
	readonly hardProtection?: SequencerHardProtectionTiming
	// Longest sleep of the limit supervisor between re-evaluations, in seconds; finite > 0.
	readonly supervisionInterval?: number
	// Timeout passed explicitly to the flip command and watchdog of a supervised flip slew, in seconds; finite > 0.
	readonly flipTimeout?: number
	// Action of a graceful protection request while paused.
	readonly whilePaused?: 'flip' | 'stopTracking'
	// Session action once the flip or a protection failed.
	readonly onFailure?: SequencerFailureAction
}

// Session action when safety turns unsafe.
// - pauseAfterFrame: the current frame finishes, then the session pauses;
// - stopAfterFrame: the current frame finishes, then the session stops;
// - shutdownImmediately: the run is aborted and the critical shutdown steps start at once.
export type SequencerUnsafeAction = 'pauseAfterFrame' | 'stopAfterFrame' | 'shutdownImmediately'

// Safety policy over the caller-provided safety source.
export interface SequencerSafetyConfiguration {
	// Action when safety turns unsafe while running.
	readonly unsafeAction: SequencerUnsafeAction
	// Action when the startup gate before an opening is unsafe: wait (abortable by stop) or shut down.
	readonly onUnsafeAtStartup: 'wait' | 'stop'
	// Whether 'unknown' (no data, stale data) counts as unsafe.
	readonly unknownIsUnsafe: boolean
}

// Bounds of the physical undo of an interrupted task.
export interface SequencerCompensationPolicy {
	// Timeout of each compensation, in seconds; finite > 0.
	readonly timeout: number
}

// Execution limits of the runner.
export interface SequencerExecutionConfiguration {
	// Bounds of compensations.
	readonly compensation: SequencerCompensationPolicy
}

// Declarative, serializable configuration of one session. An absent feature is disabled. `id` and `revision`
// identify it; a checkpoint resumes only under the same pair.
export interface SequencerConfiguration {
	// Schema of this shape.
	readonly schemaVersion: 1
	// Stable identity of the configuration; non-empty.
	readonly id: string
	// Revision of the configuration; safe integer ≥ 0.
	readonly revision: number
	// Display name.
	readonly name: string
	// Fixed sidereal target; absent runs without pointing.
	readonly target?: SequencerTarget
	// Primary frames.
	readonly capture: SequencerCaptureConfiguration
	// Equipment startup.
	readonly startup: SequencerStartupConfiguration
	// Equipment shutdown.
	readonly shutdown: SequencerShutdownConfiguration
	// Target acquisition and recentering.
	readonly pointing?: SequencerPointingConfiguration
	// Field rotation.
	readonly rotator?: SequencerRotatorConfiguration
	// Autofocus.
	readonly autofocus?: SequencerAutofocusConfiguration
	// Guiding.
	readonly guiding?: SequencerGuidingConfiguration
	// Dither.
	readonly dither?: SequencerDitherConfiguration
	// Meridian flip.
	readonly meridianFlip?: SequencerMeridianFlipConfiguration
	// Safety policy.
	readonly safety?: SequencerSafetyConfiguration
	// Execution limits.
	readonly execution: SequencerExecutionConfiguration
}

// Devices the session runs against, already resolved by the caller; no application id enters the core. Two
// fields may be views of the same hardware, except that nothing may share the mount resource under hard
// meridian or safety protection.
export interface SequencerDevices {
	// Primary camera; always reserved.
	readonly camera: Camera
	// Mount, for a target, pointing, tracking or a meridian flip.
	readonly mount?: Mount
	// Filter wheel, for filters and focus offsets.
	readonly wheel?: Wheel
	// Focuser, for autofocus and focus offsets.
	readonly focuser?: Focuser
	// Field rotator.
	readonly rotator?: Rotator
	// Cover, for the startup, the shutdown and the calibration optical path.
	readonly cover?: Cover
	// Dome or roof.
	readonly dome?: Dome
	// Flat panel, turned off when co-resident with the cover in use.
	readonly flatPanel?: FlatPanel
}

// Default of the optional fields of `SequencerMeridianFlipConfiguration`, used by validation, guard,
// supervisor, protection lead, documentation and tests (never a literal elsewhere). Seconds.
export const DEFAULT_SEQUENCER_MERIDIAN_FLIP = {
	pierSideTimeout: 10,
	maxRetries: 1,
	exposureMargin: 30,
	protectionMargin: 120,
	supervisionInterval: 30,
	flipTimeout: 300,
	whilePaused: 'stopTracking',
	onFailure: 'stop',
	hardProtection: { mountStopTimeout: 10, guidingStopTimeout: 10, trackingTimeout: 10 },
} as const satisfies Required<Omit<SequencerMeridianFlipConfiguration, 'enabled' | 'prepareAt' | 'flipAt' | 'latestAt' | 'beforeFlipPierSide' | 'afterFlipPierSide' | 'requireRecentering' | 'requireGuidingSettle' | 'hardProtection'>> & { readonly hardProtection: Required<SequencerHardProtectionTiming> }

// Default of the optional fields of `SequencerCameraRecoveryConfiguration`, in seconds.
export const DEFAULT_SEQUENCER_CAMERA_RECOVERY = { timeout: 300, pollInterval: 1 } as const satisfies Required<Omit<SequencerCameraRecoveryConfiguration, 'onTimeout'>>

// Default watchdog, in seconds, between aborting a frame collaborator (quality analyzer, plate solver, HFD
// measurer) and reporting it unresponsive.
export const DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE = 5

// Plate solver of the centering, provided by the caller: an async function over the path of a complete auxiliary
// FITS and its exposure midpoint that honors the signal and resolves the `plateSolutionFrom` solution (ICRS center of
// a TAN/TAN-SIP solution with known dimensions) or undefined. Isolating its CPU work is the caller's responsibility.
export type SequencerPlateSolver = CenteringSolver

// HFD measurer of the autofocus, provided by the caller: an async function over the path of a complete auxiliary FITS
// that honors the signal and resolves the half-flux diameter in pixels, or undefined (a non-finite or non-positive value
// too) for a frame without a usable star. Isolating its CPU work is the caller's responsibility.
export type SequencerFocusMeasurer = AutoFocusMeasurer

// Primary frame handed to the quality analyzer: the durable FITS temporary of its attempt, once the durable writer
// resolved and the capture produced its result, never its bytes. Read-only for the analyzer: the file does not move
// before the analysis settles.
export interface SequencerQualityFrame {
	// Slot of the frame, with its frame type (`capture.frameType`) and attempt; the analyzer never applies stellar criteria
	// to darks and biases.
	readonly slot: SequencerFrameSlot
	// Path of the complete temporary FITS of the attempt (`.{slot id}.{attempt}.partial.fit`).
	readonly path: string
	// Wall instant of the first Busy of the exposure, in Unix ms.
	readonly exposureStartedAt: number
	// Wall instant of the end of the exposure, in Unix ms.
	readonly exposureFinishedAt: number
}

// What the quality analyzer concluded about one primary frame.
export interface SequencerQualityResult {
	// 'rejected' discards the frame when the quality criterion is enabled; 'unknown' never discards.
	readonly classification: 'accepted' | 'rejected' | 'unknown'
	// Measurements, opaque to the Sequencer; reported in the `frameCaptured` event. Finite numbers.
	readonly metrics?: Readonly<Record<string, number>>
	// Corrective intents to persist, whatever the classification and the criteria.
	readonly intents?: SequencerCorrectiveIntents
}

// Quality analyzer of the primary frames, provided by the caller: an async function over the path of the complete
// temporary FITS that honors the signal (aborted by `capture.quality.timeout` or by an immediate stop). Isolating its CPU
// work (a Worker, a process) is the caller's responsibility; it must yield the event loop at once.
export type SequencerQualityAnalyzer = (frame: SequencerQualityFrame, signal: AbortSignal) => Promise<SequencerQualityResult>

// Outcome of the quality analysis of one frame; the post-capture classifies only from it. Every kind but 'analyzed' is
// the classification 'unknown', which never discards.
export type SequencerQualityOutcome =
	// The analyzer resolved a well-formed result in time.
	| { readonly kind: 'analyzed'; readonly result: SequencerQualityResult }
	// `capture.quality.timeout` aborted the analysis; it was awaited to its end and its result discarded.
	| { readonly kind: 'timeout' }
	// A stop or a failure of the session aborted the analysis; it was awaited to its end and its result discarded.
	| { readonly kind: 'aborted' }
	// The analyzer threw, rejected, resolved a malformed result, or is faulted since an earlier unresponsive analysis.
	| { readonly kind: 'error'; readonly detail: string }
	// No analyzer.
	| { readonly kind: 'skipped' }

// Operational clock of the session, with two explicit domains and the wait of the monotonic one. Never
// compare a wall instant with a monotonic one. Scientific time is always `timeUnix(wallNow() / 1000)`.
export interface SequencerClock extends CameraCaptureClock {
	// Abortable wait in the monotonic domain: resolves ok only after `monotonicNow()` advanced by at least `ms`;
	// an abort resolves `aborted` at once without a pending timer. Says nothing about `wallNow()` on return.
	readonly delay: (ms: number, signal: AbortSignal) => Promise<OperationResult<void>>
}

// Clock of a session whose caller supplies none: `Date.now`, `performance.now` and `abortableDelay`.
export const SYSTEM_SEQUENCER_CLOCK: SequencerClock = {
	wallNow: () => Date.now(),
	monotonicNow: () => performance.now(),
	delay: abortableDelay,
}

// State reported by a safety source; stale data is reported 'unknown' by the source itself.
export type SequencerSafetyState = 'safe' | 'unsafe' | 'unknown'

// One reading of a safety source. It carries no timestamp: freshness is the source's responsibility.
export interface SequencerSafetySnapshot {
	// Current safety.
	readonly state: SequencerSafetyState
	// Human-readable detail.
	readonly detail?: string
}

// Read-only safety boundary (weather, roof, power). It never commands devices.
export interface SequencerSafetySource {
	// Current state, also before the first event ('unknown' without data).
	readonly current: () => SequencerSafetySnapshot
	// Subscribes to later changes without replaying the current state; returns the unsubscription.
	readonly subscribe: (listener: (snapshot: SequencerSafetySnapshot) => void) => VoidFunction
}

// Services a session runs with, resolved by the caller. The arbiter of the coordinator holds the one reservation
// of the session; every physical operation is a root of its reserved scope, so the session never creates another
// coordinator. Services of disabled features are not required.
export interface SequencerRunnerServices {
	// Orchestration core of the process.
	readonly coordinator: OperationCoordinator
	// Artifact protocol of the session: its directory lock, journal and frame files. Its session id is the session id.
	readonly storage: SequencerStorage
	// Durable checkpoints; absent persists nothing and resumes nothing.
	readonly checkpointStore?: SequencerCheckpointStore
	// Moves the focuser back when a focuser compensation runs.
	readonly focuserCommander?: FocuserCommander
	// Moves the wheel back when a wheel compensation runs.
	readonly wheelCommander?: WheelCommander
	// Guiding session of the guiding feature: its resources join the reservation, its run is begun right after the
	// reservation and ended once by the terminalization, and its root `guiding` survives the drains of the session.
	readonly guiding?: GuidingSession
	// Ditherer of the dither feature: its resources join the reservation, and a pulse mount ditherer gets the barrier of
	// the pulses inherited from a previous process right after the reservation. Often the guiding session itself.
	readonly ditherer?: Ditherer
	// Quality analyzer of the primary frames; requires `capture.quality`. Absent classifies every frame 'unknown'.
	readonly qualityAnalyzer?: SequencerQualityAnalyzer
	// Safety source, subscribed from the startup to the terminalization; its transitions, recorded in the monotonic
	// domain, decide the `unsafeDuringExposure` criterion. Without it no window is covered and the criterion discards.
	readonly safety?: SequencerSafetySource
	// Operational clock; default `SYSTEM_SEQUENCER_CLOCK`. Always the three members together.
	readonly clock?: SequencerClock
	// Receives the session events synchronously, in emission order.
	readonly listener?: SequencerListener
}

// Phase of the session run loop; observability only, never a persisted instruction pointer.
export type SequencerPhase = 'startup' | 'preCapture' | 'capture' | 'postCapture' | 'shutdown'

// Built-in tasks of the session, in the fixed lists of the runner. Telemetry identity only; there is no registry.
export type SequencerTaskId =
	// Startup.
	| 'bootstrapFocusBaseline'
	| 'quiesceGuiding'
	| 'quiesceDitherPulses'
	| 'coolCamera'
	| 'safetyGate'
	| 'openDome'
	| 'openCover'
	| 'unparkMount'
	| 'configureTracking'
	// Pre-capture.
	| 'awaitCameraRecovery'
	| 'meridianFlip'
	| 'ensureTracking'
	| 'prepareOpticalPath'
	| 'acquireOrRecenterTarget'
	| 'rotateField'
	| 'autofocus'
	| 'ensureGuiding'
	| 'ditherAndSettle'
	| 'prepareFrameDestination'
	| 'finalExposureGuard'
	// Capture.
	| 'captureFrame'
	// Shutdown.
	| 'pauseGuiding'
	| 'stopTracking'
	| 'stopGuiding'
	| 'closeCover'
	| 'parkMount'
	| 'closeOrParkDome'
	| 'turnOffFlatPanel'
	| 'warmCamera'
	// Graceful meridian protection.
	| 'protectMeridianWhilePaused'
	| 'protectMeridianDuringStartup'

// One accepted frame requested, with the counters of its physical attempts. Identity never derives from array
// positions, global counters, file names or timestamps.
export interface SequencerFrameSlot {
	// Stable slot id `frame[{groupId}][{ordinal}]`.
	readonly id: string
	// Group of the slot.
	readonly groupId: string
	// Kind of the group.
	readonly kind: 'scheduled' | 'triggered'
	// 1-based ordinal in the group; in triggered groups it keeps growing across batches.
	readonly ordinal: number
	// Physical attempt, 1-based and monotonic. It grows with every capture attempt (retried failure or discarded
	// frame); pre-capture re-entries and `beforeExposure` refusals never grow it. Never renewed.
	readonly attempt: number
	// Discards of the slot in total. Never renewed.
	readonly discardedTotal: number
	// Discards counted against `maxDiscardsPerSlot`; renewed only by `resume()` after a discard-budget pause.
	readonly discardBudgetUsed: number
	// Consecutive failed captures against `capture.retry.maxAttempts`; reset when an exposure of the slot
	// completes and by `resume()` after a capture-policy pause.
	readonly captureFailures: number
	// Effective camera settings, inheritance already applied.
	readonly capture: SequencerCameraCapture
	// Effective filter.
	readonly filter?: SequencerFilterReference
	// Slot of the light that fired this calibration frame.
	readonly triggeredBy?: string
}

// Lightweight projection of a frame slot for snapshots and events.
export interface SequencerFrameSlotSnapshot {
	// Stable slot id.
	readonly id: string
	// Group of the slot.
	readonly groupId: string
	// Kind of the group.
	readonly kind: 'scheduled' | 'triggered'
	// 1-based ordinal in the group.
	readonly ordinal: number
	// Current physical attempt.
	readonly attempt: number
	// Discards of the slot in total.
	readonly discardedTotal: number
	// Discards counted against the slot budget.
	readonly discardBudgetUsed: number
	// Consecutive failed captures.
	readonly captureFailures: number
	// Frame type of the slot.
	readonly frameType: FrameType
	// Slot of the light that fired this calibration frame.
	readonly triggeredBy?: string
}

// Corrective intents a quality analyzer may attach to a frame.
export interface SequencerCorrectiveIntents {
	// Requests an autofocus.
	readonly autofocus?: boolean
	// Requests a recenter.
	readonly recenter?: boolean
	// Requests a guiding recovery.
	readonly recoverGuiding?: boolean
}

// Pending corrective actions, persisted. An intent is set by an observation, cleared only after the matching task
// succeeded, and kept after a retryable failure. Periodic dither derives from anchors, never from an intent.
export interface SequencerIntents {
	// Autofocus requested.
	autofocus: boolean
	// Recenter requested.
	recenter: boolean
	// Guiding recovery requested.
	recoverGuiding: boolean
}

// Anchor of a periodic action: light exposures and wall instant of its last success.
export interface SequencerActionAnchor {
	// Value of `lightExposures` at the last success.
	lightExposures: number
	// Wall instant of the last success, in Unix ms.
	lastSuccessfulAt?: number
}

// Anchor of the autofocus, which also triggers on temperature and filter.
export interface SequencerAutofocusAnchor extends SequencerActionAnchor {
	// Focuser temperature at the last success, in °C.
	temperature?: number
	// Filter name at the last success.
	filter?: string
}

// Anchor of one triggered group.
export interface SequencerCalibrationAnchor {
	// Value of `lightExposures` when the last batch fired.
	lightExposures: number
	// Sensor temperature at the last accepted batch, in °C.
	sensorTemperature?: number
	// Batches fired so far (bounded by `maxFrames`).
	batches: number
}

// Persisted anchors of the triggers. "Frames since the last X" is `lightExposures − anchors.X.lightExposures`.
// An anchor advances only after its action succeeded.
export interface SequencerTriggerAnchors {
	// Monotonic count of completed (accepted or discarded) LIGHT exposures of the session.
	lightExposures: number
	// Autofocus anchor.
	autofocus: SequencerAutofocusAnchor
	// Dither anchor.
	dither: SequencerActionAnchor
	// Recenter anchor.
	recenter: SequencerActionAnchor
	// Anchor of each triggered group, by group id.
	calibration: Record<string, SequencerCalibrationAnchor>
}

// Calibration batch fired by a triggered group, persisted until every slot is done. Its slots are the ordinals
// [firstOrdinal, firstOrdinal + size − 1] of the group, completed in order. Camera settings and filter are frozen
// when the batch fires, so a resumed session exposes exactly the same frames.
export interface SequencerCalibrationBatch {
	// Triggered group of the batch.
	readonly groupId: string
	// 1-based ordinal of the first slot; ordinals keep growing across the batches of a group.
	readonly firstOrdinal: number
	// Slots of the batch; ≥ 1 and already limited by the free capacity of the group when it fired.
	readonly size: number
	// Effective camera settings of every slot, inheritance already applied.
	readonly capture: SequencerCameraCapture
	// Effective filter of every slot: the opaque filter of a 'filter' optical path, the group filter otherwise.
	readonly filter?: SequencerFilterReference
	// Slot of the light that fired the batch; absent for the session-boundary triggers.
	readonly triggeredBy?: string
}

// Persisted state of the frame scheduler, mutated in place by the selection. It is JSON-serializable and restored
// only under the configuration id and revision that produced it. The current slot and the per-group progress are
// kept apart, in the runtime state.
export interface SequencerSchedulerState {
	// Group id of the last scheduled selection (round-robin cursor); absent before the first one.
	cursor?: string
	// Weighted round-robin credit of each group of the current rotation (the unfinished scheduled groups), by group
	// id; empty before the first weighted selection and reset when the rotation changes. 'weightedRoundRobin' only.
	credits: Record<string, number>
	// Pending calibration batches in fire order (FIFO); the head may be in progress.
	batches: SequencerCalibrationBatch[]
	// Whether the 'sessionStart' batches were enqueued.
	sessionStartQueued: boolean
	// Whether the 'sessionEnd' batches were enqueued.
	sessionEndQueued: boolean
}

// Logical baseline of the focus offsets, persisted.
// - unset: never inspected; the only state in which the baseline may be derived (bootstrap);
// - unknown: inspected with a physical filter without known offset; nothing is derived until an autofocus;
// - known: `referencePosition` is the absolute focuser position (steps) at which the reference filter is in focus.
export type SequencerFocusBaseline = { readonly kind: 'unset' } | { readonly kind: 'unknown' } | { readonly kind: 'known'; readonly referencePosition: number }

// Done-slot counters of one group, as persisted.
export interface SequencerGroupCounters {
	// Frames accepted by their quality, excluding forced ones.
	readonly accepted: number
	// Discarded frames promoted as accepted by `keepLast`.
	readonly forced: number
	// Discarded frames.
	readonly discarded: number
	// Slots ended without an accepted frame.
	readonly skipped: number
}

// Last physical observation of the meridian supervisor, persisted with every checkpoint while it supervises and
// read only when a restart arms it again (the gap between two runtimes).
export interface SequencerMountRiskObservation {
	// Wall instant of the observation, in Unix ms.
	readonly at: number
	// Physical hour angle of the mount, in radians in (−π, π].
	readonly hourAngle: Angle
	// Pier side read with it.
	readonly pierSide: PierSide
	// Whether the mount tracked.
	readonly tracking: boolean
}

// Counters of the slot in progress, persisted while it is current (retake or retry pending). `attempt` is the
// physical attempt the slot is at and has not consumed yet: a capture failure or a discard persists `attempt + 1`.
export interface SequencerCheckpointSlot {
	// Stable slot id `frame[{groupId}][{ordinal}]`.
	readonly id: string
	// Next physical attempt to prepare, 1-based.
	readonly attempt: number
	// Discards of the slot in total.
	readonly discardedTotal: number
	// Discards counted against the slot budget.
	readonly discardBudgetUsed: number
	// Consecutive failed captures.
	readonly captureFailures: number
}

// Minimal logical state to continue a session, never a position in a list of instructions. Bound exactly to the
// configuration id and revision that produced it; JSON-serializable. Phase, task, acquired target, guiding, filter,
// rotator and focuser positions, and operation ids are never persisted: the next pre-capture reconciles them.
export interface SequencerCheckpoint {
	// Schema of this shape.
	readonly version: 1
	// Session the checkpoint belongs to.
	readonly sessionId: string
	// Id of the configuration that produced it.
	readonly configurationId: string
	// Revision of the configuration that produced it.
	readonly configurationRevision: number
	// Done-slot counters per group id.
	readonly capture: Readonly<Record<string, SequencerGroupCounters>>
	// Scheduler cursor, credits and pending calibration batches (camera settings frozen).
	readonly scheduler: SequencerSchedulerState
	// Trigger anchors.
	readonly anchors: SequencerTriggerAnchors
	// Pending corrective intents.
	readonly intents: SequencerIntents
	// Logical baseline of the focus offsets; `unset` only before the bootstrap.
	readonly focus: SequencerFocusBaseline
	// Started meridian flips (FLIP_STARTED) of the session across processes, saved before each one; the flip phase is
	// never persisted.
	readonly meridianFlipAttempts: number
	// Wall instant (Unix ms) of the upper transit that anchors the single meridian cycle; absent without meridian flip.
	readonly meridianTransitAt?: number
	// Last observation of the meridian supervisor; absent without meridian flip and before the first save.
	readonly mountRiskObservation?: SequencerMountRiskObservation
	// Slot in progress (retake or retry pending); absent between slots.
	readonly currentSlot?: SequencerCheckpointSlot
	// Consecutive discarded frames across slots.
	readonly consecutiveDiscards: number
	// Strictly increasing per session; a store refuses a sequence not above the persisted one. Each frame transaction
	// of the journal carries the checkpoint it produces, so the highest committed one above the persisted sequence is
	// the correct checkpoint after a crash.
	readonly sequence: number
	// Wall instant of the save, in Unix ms; diagnostic only, never a duration.
	readonly updatedAt: number
}

// Durable store of the checkpoints of sessions. The runner depends only on this interface.
export interface SequencerCheckpointStore {
	// Latest checkpoint of a session, or undefined when none was saved. Rejects when it cannot be read or is malformed.
	readonly load: (sessionId: string) => Promise<SequencerCheckpoint | undefined>
	// Replaces the checkpoint of its session durably. Rejects, persisting nothing, when its sequence is not above the
	// persisted one or the write failed.
	readonly save: (checkpoint: SequencerCheckpoint) => Promise<void>
	// Removes the checkpoint of a session.
	readonly remove?: (sessionId: string) => Promise<void>
}

// Progress of one group in a snapshot or result.
export interface SequencerGroupProgressSnapshot {
	// Group id.
	readonly groupId: string
	// Kind of the group.
	readonly kind: 'scheduled' | 'triggered'
	// Whether the group produces slots.
	readonly enabled: boolean
	// Requested frames: `count` of a scheduled group, `maxFrames` (a ceiling) of a triggered one.
	readonly requested: number
	// Frames accepted by their quality, excluding forced ones.
	readonly accepted: number
	// Discarded frames promoted as accepted by `keepLast`.
	readonly forced: number
	// Discarded frames.
	readonly discarded: number
	// Slots ended without an accepted frame.
	readonly skipped: number
}

// Capture progress of all groups, in declared order.
export interface SequencerCaptureProgressSnapshot {
	// Progress per group.
	readonly groups: readonly SequencerGroupProgressSnapshot[]
}

// Lifecycle state of a session: `starting → running ⇄ paused → stopping → shuttingDown → completed | stopped |
// failed`. The last three are terminal and reached once.
export type SequencerSessionState = 'starting' | 'running' | 'paused' | 'stopping' | 'shuttingDown' | 'completed' | 'stopped' | 'failed'

// Terminal state of a session.
export type SequencerTerminalState = 'completed' | 'stopped' | 'failed'

// Failure of a session or of a shutdown step. Quality, safety and storage are never operation failure reasons.
export type SequencerFailure =
	// Orchestration or device failure of a task.
	| { readonly kind: 'operation'; readonly reason: OperationFailureReason; readonly task?: SequencerTaskId; readonly detail?: string }
	// Safety forced the end.
	| { readonly kind: 'safety'; readonly detail?: string }
	// Storage, journal, lock or checkpoint failure.
	| { readonly kind: 'storage'; readonly detail?: string }
	// Discard policy failure.
	| { readonly kind: 'quality'; readonly detail?: string }
	// Configuration, preflight or meridian-cycle refusal.
	| { readonly kind: 'configuration'; readonly detail?: string }

// Collaborator a session waits for without response.
export type SequencerCollaboratorService = 'quality' | 'solve' | 'hfd'

// Observable projection of a session; never a source of truth.
export interface SequencerSnapshot {
	// Session id.
	readonly sessionId: string
	// Lifecycle state.
	readonly state: SequencerSessionState
	// Current phase; absent before the startup and once terminal.
	readonly phase?: SequencerPhase
	// Current task.
	readonly task?: SequencerTaskId
	// Slot being prepared, captured or classified.
	readonly currentFrame?: SequencerFrameSlotSnapshot
	// Capture progress.
	readonly capture: SequencerCaptureProgressSnapshot
	// Pending corrective intents.
	readonly intents: Readonly<SequencerIntents>
	// Unresponsive collaborator being waited for.
	readonly waitingFor?: 'qualityAnalyzer' | 'plateSolver' | 'focusMeasurer'
	// Wall instant the session started, in Unix ms.
	readonly startedAt: number
	// Wall instant of the last state change, in Unix ms.
	readonly updatedAt: number
	// Primary failure.
	readonly failure?: SequencerFailure
}

// Outcome of a terminated session. It never rejects for expected operational failures.
export interface SequencerResult {
	// Terminal state. 'completed' requires every enabled scheduled group satisfied (or its slots skipped) and no
	// pending calibration batch.
	readonly state: SequencerTerminalState
	// Session id.
	readonly sessionId: string
	// Wall instant the session started, in Unix ms.
	readonly startedAt: number
	// Wall instant the session terminated, in Unix ms.
	readonly finishedAt: number
	// Final capture progress.
	readonly capture: SequencerCaptureProgressSnapshot
	// Why a stopped session stopped.
	readonly stopCause?: 'user' | 'safety' | 'policy'
	// Primary failure, kept apart from the shutdown failures.
	readonly failure?: SequencerFailure
	// Every failed shutdown step, in execution order. A failed 'required' step makes the session 'failed'.
	readonly shutdownFailures: readonly SequencerFailure[]
	// Every failed compensation, in execution order, each naming the interrupted task it undid. Reported only:
	// it never changes the terminal state.
	readonly compensationFailures: readonly SequencerFailure[]
}

// Public control of a running session. No method rejects.
export interface SequencerHandle {
	// Session id.
	readonly id: string
	// Resolves once the session terminated, after shutdown, drain and release.
	readonly result: Promise<SequencerResult>
	// Current observable projection.
	readonly snapshot: () => SequencerSnapshot
	// Requests a pause at the next safe point. Resolves 'paused' at the hold, 'running' when `resume()` came first,
	// or the terminal state when the session ended first. Repeated calls share the promise.
	readonly pause: () => Promise<SequencerSessionState>
	// Cancels a pending pause or leaves the hold; true only when a pause was pending or held.
	readonly resume: () => boolean
	// Stops the session; 'immediate' after 'graceful' escalates, the reverse is a no-op. Resolves with the result.
	readonly stop: (mode?: 'graceful' | 'immediate') => Promise<SequencerResult>
}

// Reason a completed exposure was discarded.
export type SequencerDiscardReason = 'quality' | 'guidingInterruption' | 'unsafeDuringExposure'

// Definitive decision about a classified frame, taken before its file is touched.
// - accepted: the frame completes its slot;
// - forced: the discarded frame is promoted by `keepLast`;
// - retake: discarded; the same slot runs again from the pre-capture;
// - skipSlot: discarded; the slot ends without an accepted frame;
// - pause, stop, fail: discarded; the session follows the action of the slot budget or the circuit breaker;
// - discardFinal: discarded during a graceful stop, without a retake.
export type SequencerFrameDecision = 'accepted' | 'forced' | 'retake' | 'skipSlot' | 'pause' | 'stop' | 'fail' | 'discardFinal'

// Progress phase of a dither.
export type SequencerDitherPhase = 'dithering' | 'dithered' | 'settling' | 'settled'

// Failure outcome of a meridian protection; with several failures the first registered one.
export type SequencerMeridianProtectionFailure =
	// The guiding pause failed or timed out; a guiding stop was awaited.
	| 'guidingNotQuiescent'
	// Mount motion keys were not released in their bound, or the mount or a guide output still moved.
	| 'mountNotQuiescent'
	// The protective tracking off failed.
	| 'trackingNotStopped'
	// Late arming: the steps completed, but tracking went off with the hour angle at or past `latestAt`.
	| 'lateStart'
	// Under a CUSTOM track rate, tracking went off with the reported hour angle at or past `latestAt`.
	| 'trackRateUnknown'
	// A flip slew ended without the post-flip side after the hard deadline.
	| 'flipSideUnchanged'
	// A supervised flip slew outlasted `flipTimeout` after the hard deadline.
	| 'flipSlewTimeout'
	// Motion without a run owner, stopped by a motion abort.
	| 'externalMotion'
	// The gap between two runtimes may have crossed `latestAt`.
	| 'unsupervisedCrossing'

// Meridian protection events. Hour angles in radians in (−π, π] unless stated, durations in ms, instants in
// Unix ms (wall).
export type SequencerMeridianProtectionEvent =
	// Arming found less than the hard protection lead left; `hourAngle` is the physical one.
	| { readonly type: 'meridianProtectionLateStart'; readonly remainingMs: number; readonly requiredLeadMs: number; readonly hourAngle: Angle }
	// Hard protection turned tracking off cleanly; `hourAngle` at the tracking off.
	| { readonly type: 'meridianHardProtection'; readonly late: boolean; readonly hourAngle: Angle; readonly latestAt: Angle; readonly leadMs: number }
	// A protection failed.
	| { readonly type: 'meridianProtectionFailed'; readonly reason: SequencerMeridianProtectionFailure; readonly lateStart: boolean; readonly hourAngle: Angle }
	// The supervisor woke later than its jitter allowance (diagnostic).
	| { readonly type: 'supervisionLate'; readonly lateMs: number }
	// A non-sidereal track mode made the deadline unpredictable; hard protection follows.
	| { readonly type: 'meridianProtectionTrackModeUnsupervisable'; readonly trackMode: TrackMode; readonly hourAngle: Angle }
	// Graceful protection stopped tracking of a mount away from the target, without flipping.
	| { readonly type: 'meridianProtectionMountOffTarget'; readonly mountHourAngle: Angle; readonly targetHourAngle: Angle }
	// The mount does not publish the telemetry the deadline needs; hard protection follows.
	| { readonly type: 'meridianProtectionTelemetryUnobserved'; readonly missing: readonly ('geographicCoordinate' | 'equatorialCoordinate')[] }
	// The last persisted observation extrapolates past `latestAt` across a gap between runtimes.
	| {
			readonly type: 'meridianProtectionUnsupervisedGap'
			// Wall instant of the persisted observation.
			readonly observedAt: number
			// Physical hour angle of the persisted observation.
			readonly observedHourAngle: Angle
			// Unwrapped extrapolation (may exceed π), ≥ `latestAt`.
			readonly extrapolatedHourAngle: Angle
			// Current physical hour angle.
			readonly hourAngle: Angle
			// Whether the mount tracks now; false makes the event a diagnostic only.
			readonly tracking: boolean
	  }

// A flip completed by the session (transition to COMPLETED with attempts > 0), once.
export interface SequencerMeridianFlipCompletedEvent {
	// Discriminant.
	readonly type: 'meridianFlipCompleted'
	// Started flips of the session; ≥ 1.
	readonly attempts: number
	// Target hour angle at the pier-side verification, in radians.
	readonly hourAngle: Angle
	// Pier side read at the verification; always `afterFlipPierSide`.
	readonly pierSide: PierSide
	// Whether the commander observed the side change from a known side.
	readonly pierSideVerified: boolean
}

// Meridian cycle events.
export type SequencerMeridianCycleEvent =
	// The pre-flip side was read in COMPLETED; the flip state was recreated. `hourAngle` is the decision one.
	| { readonly type: 'meridianFlipSideReverted'; readonly pierSide: PierSide; readonly hourAngle: Angle }
	// The session left its single meridian cycle and ends with a configuration failure.
	| { readonly type: 'meridianCycleExceeded'; readonly meridianTransitAt: number; readonly wallNow: number }
	// Tracking stays off in the meridian zone until the acquisition decides.
	| { readonly type: 'trackingDeferred'; readonly reason: 'meridianZone'; readonly mountHourAngle: Angle }

// Payload of a session event, discriminated by `type`.
export type SequencerEventBody =
	| { readonly type: 'sessionStarted'; readonly configurationId: string; readonly configurationRevision: number }
	| { readonly type: 'stateChanged'; readonly state: SequencerSessionState; readonly previous: SequencerSessionState }
	| { readonly type: 'phaseChanged'; readonly phase?: SequencerPhase }
	| { readonly type: 'shutdownStarted' }
	| { readonly type: 'sessionCompleted' | 'sessionStopped' | 'sessionFailed'; readonly result: SequencerResult }
	| { readonly type: 'checkpointSaved'; readonly sequence: number }
	| { readonly type: 'taskStarted' | 'taskCompleted'; readonly task: SequencerTaskId; readonly phase: SequencerPhase }
	| { readonly type: 'taskFailed'; readonly task: SequencerTaskId; readonly phase: SequencerPhase; readonly failure: SequencerFailure }
	| { readonly type: 'frameSelected'; readonly frame: SequencerFrameSlotSnapshot }
	| { readonly type: 'exposureStarted'; readonly slot: string; readonly attempt: number }
	// `exposureStartedAt`/`exposureFinishedAt` are wall instants of the first Busy and of the Ok; `quality` is the outcome
	// of the analysis the frame was classified from.
	| { readonly type: 'frameCaptured'; readonly slot: string; readonly attempt: number; readonly exposureStartedAt: number; readonly exposureFinishedAt: number; readonly quality: SequencerQualityOutcome }
	// `path` is the final destination of the frame.
	| { readonly type: 'frameAccepted'; readonly slot: string; readonly attempt: number; readonly path: string; readonly forced: boolean }
	// `truncated` reports a window the history no longer covered; `remainingDiscards` is left in the slot budget.
	| {
			readonly type: 'frameDiscarded'
			readonly slot: string
			readonly attempt: number
			readonly reasons: readonly SequencerDiscardReason[]
			readonly truncated: boolean
			readonly decision: Exclude<SequencerFrameDecision, 'accepted' | 'forced'>
			readonly remainingDiscards: number
			readonly detail?: string
	  }
	| { readonly type: 'slotSkipped'; readonly slot: string; readonly reason: 'discardBudget' | 'captureFailures' }
	// `slots` is the effective batch size after the capacity of the group.
	| { readonly type: 'triggerFired'; readonly groupId: string; readonly slots: number; readonly triggeredBy?: string }
	| { readonly type: 'triggerSuppressed'; readonly groupId: string; readonly triggeredBy?: string }
	| { readonly type: 'ditherPhase'; readonly phase: SequencerDitherPhase }
	| { readonly type: 'guidingInterrupted'; readonly detail?: string }
	| { readonly type: 'qualityTimeout'; readonly slot: string; readonly attempt: number }
	| { readonly type: 'collaboratorUnresponsive'; readonly service: SequencerCollaboratorService; readonly slot?: string; readonly attempt?: number }
	| { readonly type: 'qualityAnalyzerFaulted' }
	| { readonly type: 'safetyChanged'; readonly snapshot: SequencerSafetySnapshot }
	// A persisted anchor lies `deltaMs` in the future of the wall clock; its age is taken as 0.
	| { readonly type: 'wallClockAnomaly'; readonly anchor: 'autofocus' | 'dither' | 'recenter'; readonly deltaMs: number }
	| SequencerMeridianProtectionEvent
	| SequencerMeridianFlipCompletedEvent
	| SequencerMeridianCycleEvent

// Event of a session, stamped with its session and the wall instant it was emitted (Unix ms).
export type SequencerEvent = SequencerEventBody & { readonly sessionId: string; readonly at: number }

// Receives the events of a session synchronously, in emission order. It must not throw nor block.
export type SequencerListener = (event: SequencerEvent) => void

// One structural problem of an external configuration.
export interface SequencerConfigurationDiagnostic {
	// Path of the offending field, such as `capture.groups[2].trigger.frames`; empty for the root.
	readonly path: string
	// What is wrong.
	readonly message: string
}

// Outcome of the structural validation of an external configuration.
export type SequencerConfigurationValidation =
	// The input satisfies every structural rule; `configuration` is the input object itself.
	| { readonly ok: true; readonly configuration: SequencerConfiguration }
	// Every problem found, in traversal order.
	| { readonly ok: false; readonly diagnostics: readonly SequencerConfigurationDiagnostic[] }

// Validates the shape and the structural rules of a configuration received from outside the process: types of
// every field, numeric domains, unique path-safe group ids, trigger references, threshold ordering, and the
// configuration-only feature rules (a J2000 target, a SIDEREAL startup track mode with a target or a meridian
// flip, the continuous flip window, shutdown tracking off with a meridian flip). Rules that need devices or
// services belong to the runtime preflight. Unknown extra fields are ignored. It never throws and never copies.
export function validateSequencerConfiguration(input: unknown): SequencerConfigurationValidation {
	const diagnostics: SequencerConfigurationDiagnostic[] = []
	const v = new ConfigurationValidator(diagnostics)

	if (!v.object(input, '')) return { ok: false, diagnostics }

	v.check(input.schemaVersion === 1, 'schemaVersion', 'must be 1')
	v.string(input.id, 'id', true)
	v.safeInteger(input.revision, 'revision', 0)
	v.string(input.name, 'name', false)

	if (input.target !== undefined) validateTarget(v, input.target, 'target')

	const capture = validateCapture(v, input.capture, 'capture')
	validateStartup(v, input.startup, 'startup')
	validateShutdown(v, input.shutdown, 'shutdown')

	if (input.pointing !== undefined) validatePointing(v, input.pointing, 'pointing')
	if (input.rotator !== undefined) validateRotator(v, input.rotator, 'rotator')
	if (input.autofocus !== undefined) validateAutofocus(v, input.autofocus, 'autofocus')
	if (input.guiding !== undefined) validateGuiding(v, input.guiding, 'guiding')
	if (input.dither !== undefined) validateDither(v, input.dither, 'dither')
	const meridianFlipEnabled = input.meridianFlip !== undefined && validateMeridianFlip(v, input.meridianFlip, 'meridianFlip')
	if (input.safety !== undefined) validateSafety(v, input.safety, 'safety')

	const { execution, startup, shutdown, autofocus } = input

	if (v.object(execution, 'execution')) {
		const { compensation } = execution
		if (v.object(compensation, 'execution.compensation')) v.positive(compensation.timeout, 'execution.compensation.timeout')
	}

	// The startup sets the track mode the target and the meridian deadline are computed for.
	if ((input.target !== undefined || meridianFlipEnabled) && isRecord(startup) && isRecord(startup.mount)) {
		const { trackMode } = startup.mount
		// An unknown mode was already reported by the startup validation.
		if (isMember(TRACK_MODES, trackMode)) v.check(trackMode === 'SIDEREAL', 'startup.mount.trackMode', 'must be SIDEREAL with a target or a meridian flip')
	}

	// The limit supervision lasts until the observed tracking off of the shutdown.
	if (meridianFlipEnabled && isRecord(shutdown)) {
		v.check(shutdown.stopTracking !== undefined, 'shutdown.stopTracking', 'is required with a meridian flip')
	}

	if (input.pointing !== undefined) v.check(input.target !== undefined, 'pointing', 'requires a target')

	// The dedicated autofocus filter derives the focus baseline, so its offset must be known.
	if (capture?.focusOffsets !== undefined && isRecord(autofocus)) {
		validateFilterHasOffset(v, autofocus.filter, capture.focusOffsets, 'autofocus.filter')
	}

	return diagnostics.length === 0 ? { ok: true, configuration: input as unknown as SequencerConfiguration } : { ok: false, diagnostics }
}

// Plain JSON object (not null, not an array).
type JsonRecord = Readonly<Record<string, unknown>>

// Whether a value is a plain object as JSON produces it.
function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Membership table of a string-literal union; a `Record` over the union keeps it exhaustive at compile time.
type MemberTable<T extends string> = Readonly<Record<T, true>>

// Whether a value is one of the members of a table, by own property (never inherited ones like `toString`).
function isMember<T extends string>(table: MemberTable<T>, value: unknown): value is T {
	return typeof value === 'string' && Object.hasOwn(table, value)
}

const FRAME_TYPES: MemberTable<FrameType> = { LIGHT: true, DARK: true, FLAT: true, BIAS: true }
const EXPOSURE_TIME_UNITS: MemberTable<CameraExposureTimeUnit> = { minute: true, second: true, millisecond: true, microsecond: true }
const CAPTURE_ORDERS: MemberTable<SequencerCaptureOrder> = { sequential: true, roundRobin: true, weightedRoundRobin: true }
const FAILURE_REASONS: MemberTable<OperationFailureReason> = { busy: true, aborted: true, disconnected: true, removed: true, timeout: true, alert: true, commandFailed: true, unexpectedState: true }
const FAILURE_ACTIONS: MemberTable<SequencerFailureAction> = { fail: true, pause: true, stop: true }
const OPTIONAL_FAILURE_ACTIONS: MemberTable<SequencerOptionalFailureAction> = { ...FAILURE_ACTIONS, skip: true }
const CAPTURE_FAILURE_ACTIONS: MemberTable<SequencerCaptureFailureAction> = { ...FAILURE_ACTIONS, skipFrame: true }
const SHUTDOWN_STEP_POLICIES: MemberTable<SequencerShutdownStepPolicy> = { required: true, bestEffort: true }
const SHUTDOWN_STEPS = ['stopTracking', 'stopGuiding', 'closeCover', 'parkMount', 'closeOrParkDome', 'turnOffFlatPanel', 'warmCamera'] as const satisfies readonly (keyof SequencerShutdownConfiguration)[]
const DISCARD_EXHAUSTED_ACTIONS: MemberTable<SequencerFrameDiscardPolicy['onExhausted']> = { keepLast: true, skipSlot: true, pause: true, fail: true }
const CONSECUTIVE_EXHAUSTED_ACTIONS: MemberTable<NonNullable<SequencerFrameDiscardPolicy['onConsecutiveExhausted']>> = FAILURE_ACTIONS
const DISCARD_ARTIFACTS: MemberTable<SequencerFrameDiscardPolicy['artifact']> = { moveToRejected: true, keepInPlace: true, delete: true }
const TRACK_MODES: MemberTable<TrackMode> = { SIDEREAL: true, SOLAR: true, LUNAR: true, KING: true, CUSTOM: true }
const FLIP_PIER_SIDES: MemberTable<Exclude<PierSide, 'NEITHER'>> = { EAST: true, WEST: true }
const FITTING_MODES: MemberTable<AutoFocusFittingMode> = { TRENDLINES: true, PARABOLIC: true, TREND_PARABOLIC: true, HYPERBOLIC: true, TREND_HYPERBOLIC: true }
const AUXILIARY_ARTIFACTS: MemberTable<SequencerAuxiliaryArtifact> = { delete: true, keep: true }
const UNSAFE_ACTIONS: MemberTable<SequencerUnsafeAction> = { pauseAfterFrame: true, stopAfterFrame: true, shutdownImmediately: true }
const UNSAFE_AT_STARTUP_ACTIONS: MemberTable<SequencerSafetyConfiguration['onUnsafeAtStartup']> = { wait: true, stop: true }
const WHILE_PAUSED_ACTIONS: MemberTable<NonNullable<SequencerMeridianFlipConfiguration['whilePaused']>> = { flip: true, stopTracking: true }

// Collects diagnostics while checking JSON values. Each check reports at most one diagnostic for its field and
// returns whether the value passed, so callers descend only into well-formed objects.
class ConfigurationValidator {
	constructor(readonly diagnostics: SequencerConfigurationDiagnostic[]) {}

	// Reports `message` at `path` unless `condition` holds.
	check(condition: boolean, path: string, message: string) {
		if (!condition) this.diagnostics.push({ path, message })
		return condition
	}

	object(value: unknown, path: string): value is JsonRecord {
		return this.check(isRecord(value), path, 'must be an object')
	}

	array(value: unknown, path: string): value is readonly unknown[] {
		return this.check(Array.isArray(value), path, 'must be an array')
	}

	readonly boolean = (value: unknown, path: string): value is boolean => this.check(typeof value === 'boolean', path, 'must be a boolean')

	string(value: unknown, path: string, nonEmpty: boolean): value is string {
		if (!this.check(typeof value === 'string', path, 'must be a string')) return false
		return !nonEmpty || this.check((value as string).length > 0, path, 'must not be empty')
	}

	member<T extends string>(table: MemberTable<T>, value: unknown, path: string): value is T {
		return this.check(isMember(table, value), path, `must be one of ${Object.keys(table).join(', ')}`)
	}

	finite(value: unknown, path: string): value is number {
		return this.check(typeof value === 'number' && Number.isFinite(value), path, 'must be a finite number')
	}

	// Finite and > 0; the inverted comparison also rejects NaN.
	readonly positive = (value: unknown, path: string): value is number => this.check(typeof value === 'number' && value > 0 && value < Infinity, path, 'must be a finite number > 0')

	// Finite and ≥ 0.
	readonly nonNegative = (value: unknown, path: string): value is number => this.check(typeof value === 'number' && value >= 0 && value < Infinity, path, 'must be a finite number >= 0')

	// Safe integer ≥ `minimum`.
	safeInteger(value: unknown, path: string, minimum: number): value is number {
		return this.check(Number.isSafeInteger(value) && (value as number) >= minimum, path, `must be a safe integer >= ${minimum}`)
	}

	// Finite in [minimum, maximum) or [minimum, maximum] when `inclusive`.
	range(value: unknown, path: string, minimum: number, maximum: number, inclusive: boolean): value is number {
		const ok = typeof value === 'number' && value >= minimum && (inclusive ? value <= maximum : value < maximum)
		return this.check(ok, path, `must be in [${minimum}, ${maximum}${inclusive ? ']' : ')'}`)
	}

	// Hour angle in (−π, π], in radians; −π names the same angle as π, which the flip engine reports as π.
	hourAngle(value: unknown, path: string): value is number {
		return this.check(typeof value === 'number' && value > -PI && value <= PI, path, 'must be an hour angle in (-PI, PI]')
	}

	// Accepts an absent value; otherwise applies `check`.
	optional(value: unknown, path: string, check: (value: unknown, path: string) => boolean) {
		return value === undefined || check(value, path)
	}
}

// Target: J2000 only, RA in [0, 2π), declination in [−π/2, π/2].
function validateTarget(v: ConfigurationValidator, target: unknown, path: string) {
	if (!v.object(target, path)) return
	v.check(target.frame === 'J2000', `${path}.frame`, 'must be J2000; other frames and time-dependent targets are not supported')
	v.range(target.rightAscension, `${path}.rightAscension`, 0, TAU, false)
	v.range(target.declination, `${path}.declination`, -PIOVERTWO, PIOVERTWO, true)
	v.optional(target.name, `${path}.name`, (value, path) => v.string(value, path, false))
}

// Filter reference by 0-based slot or by non-empty name.
function validateFilterReference(v: ConfigurationValidator, reference: unknown, path: string) {
	if (!v.object(reference, path)) return
	if (reference.kind === 'slot') v.safeInteger(reference.slot, `${path}.slot`, 0)
	else if (reference.kind === 'name') v.string(reference.name, `${path}.name`, true)
	else v.check(false, `${path}.kind`, 'must be slot or name')
}

// A filter referenced by name must have a known focus offset (the reference or an entry); a slot reference is
// resolved against the wheel by the preflight.
function validateFilterHasOffset(v: ConfigurationValidator, reference: unknown, offsets: SequencerFilterFocusOffsets, path: string) {
	if (!isRecord(reference) || reference.kind !== 'name' || typeof reference.name !== 'string') return
	const { name } = reference
	v.check(name === offsets.reference || Object.hasOwn(offsets.offsets, name), `${path}.name`, 'must have a known focus offset')
}

// Camera settings of a group or an auxiliary capture.
function validateCameraCapture(v: ConfigurationValidator, capture: unknown, path: string) {
	if (!v.object(capture, path)) return
	v.positive(capture.exposureTime, `${path}.exposureTime`)
	v.member(EXPOSURE_TIME_UNITS, capture.exposureTimeUnit, `${path}.exposureTimeUnit`)
	v.member(FRAME_TYPES, capture.frameType, `${path}.frameType`)
	v.nonNegative(capture.x, `${path}.x`)
	v.nonNegative(capture.y, `${path}.y`)
	v.finite(capture.width, `${path}.width`)
	v.finite(capture.height, `${path}.height`)
	v.boolean(capture.subframe, `${path}.subframe`)
	v.safeInteger(capture.binX, `${path}.binX`, 1)
	v.safeInteger(capture.binY, `${path}.binY`, 1)
	v.string(capture.frameFormat, `${path}.frameFormat`, false)
	v.finite(capture.gain, `${path}.gain`)
	v.finite(capture.offset, `${path}.offset`)
	v.boolean(capture.compressed, `${path}.compressed`)
}

// Bounded retry policy.
function validateRetry(v: ConfigurationValidator, retry: unknown, path: string) {
	if (!v.object(retry, path)) return
	const { delay, backoff, maximumDelay, retryOn } = retry
	v.safeInteger(retry.maxAttempts, `${path}.maxAttempts`, 1)
	const validDelay = v.nonNegative(delay, `${path}.delay`)
	v.check(typeof backoff === 'number' && backoff >= 1 && backoff < Infinity, `${path}.backoff`, 'must be a finite number >= 1')
	if (v.nonNegative(maximumDelay, `${path}.maximumDelay`) && validDelay) v.check(maximumDelay >= delay, `${path}.maximumDelay`, 'must be >= delay')
	if (v.array(retryOn, `${path}.retryOn`)) for (const [i, reason] of retryOn.entries()) v.member(FAILURE_REASONS, reason, `${path}.retryOn[${i}]`)
}

// Discard policy; a triggered group accepts only the quality criterion.
function validateDiscard(v: ConfigurationValidator, discard: unknown, path: string, triggered: boolean) {
	if (!v.object(discard, path)) return

	if (v.object(discard.criteria, `${path}.criteria`)) {
		const { criteria } = discard
		v.boolean(criteria.quality, `${path}.criteria.quality`)

		if (v.boolean(criteria.guidingInterruption, `${path}.criteria.guidingInterruption`) && triggered) {
			v.check(!criteria.guidingInterruption, `${path}.criteria.guidingInterruption`, 'is not accepted by a triggered group')
		}

		if (v.boolean(criteria.unsafeDuringExposure, `${path}.criteria.unsafeDuringExposure`) && triggered) {
			v.check(!criteria.unsafeDuringExposure, `${path}.criteria.unsafeDuringExposure`, 'is not accepted by a triggered group')
		}
	}

	v.safeInteger(discard.maxDiscardsPerSlot, `${path}.maxDiscardsPerSlot`, 0)
	v.member(DISCARD_EXHAUSTED_ACTIONS, discard.onExhausted, `${path}.onExhausted`)
	v.member(DISCARD_ARTIFACTS, discard.artifact, `${path}.artifact`)

	if (discard.maxConsecutiveDiscards === undefined && discard.onConsecutiveExhausted === undefined) return
	v.safeInteger(discard.maxConsecutiveDiscards, `${path}.maxConsecutiveDiscards`, 0)
	v.member(CONSECUTIVE_EXHAUSTED_ACTIONS, discard.onConsecutiveExhausted, `${path}.onConsecutiveExhausted`)
}

// Trigger of a triggered group; source groups must be scheduled groups of the configuration.
function validateTrigger(v: ConfigurationValidator, trigger: unknown, path: string, scheduledIds: ReadonlySet<string>) {
	if (!v.object(trigger, path)) return

	switch (trigger.kind) {
		case 'afterFrames':
			v.safeInteger(trigger.frames, `${path}.frames`, 1)
			break
		case 'temperatureChange':
			v.positive(trigger.delta, `${path}.delta`)
			break
		case 'sessionStart':
			return
		case 'sessionEnd':
			v.boolean(trigger.onStop, `${path}.onStop`)
			return
		default:
			v.check(false, `${path}.kind`, 'must be afterFrames, temperatureChange, sessionStart or sessionEnd')
			return
	}

	if (trigger.sourceGroups !== undefined && v.array(trigger.sourceGroups, `${path}.sourceGroups`)) {
		for (const [i, id] of trigger.sourceGroups.entries()) {
			v.check(typeof id === 'string' && scheduledIds.has(id), `${path}.sourceGroups[${i}]`, 'must reference a scheduled group')
		}
	}
}

// Frame groups: unique path-safe ids, per-kind fields, and the cross-group trigger references.
function validateGroups(v: ConfigurationValidator, groups: readonly unknown[], path: string, order: unknown, focusOffsets: SequencerFilterFocusOffsets | undefined) {
	const ids = new Set<string>()
	const scheduledIds = new Set<string>()

	for (const group of groups) {
		if (isRecord(group) && group.kind === 'scheduled' && typeof group.id === 'string') scheduledIds.add(group.id)
	}

	for (const [i, group] of groups.entries()) {
		const at = `${path}[${i}]`
		if (!v.object(group, at)) continue

		if (v.string(group.id, `${at}.id`, true) && v.check(isPathSegment(group.id), `${at}.id`, 'must be a portable path segment')) {
			v.check(!ids.has(group.id), `${at}.id`, 'must be unique')
			ids.add(group.id)
		}

		v.boolean(group.enabled, `${at}.enabled`)
		if (group.filter !== undefined) validateFilterReference(v, group.filter, `${at}.filter`)
		validateCameraCapture(v, group.capture, `${at}.capture`)
		if (group.discard !== undefined) validateDiscard(v, group.discard, `${at}.discard`, group.kind === 'triggered')

		if (group.kind === 'scheduled') validateScheduledGroup(v, group, at, order, focusOffsets)
		else if (group.kind === 'triggered') validateTriggeredGroup(v, group, at, scheduledIds)
		else v.check(false, `${at}.kind`, 'must be scheduled or triggered')
	}
}

// Fields of a scheduled group; a LIGHT filter referenced by name needs a known focus offset.
function validateScheduledGroup(v: ConfigurationValidator, group: JsonRecord, at: string, order: unknown, focusOffsets: SequencerFilterFocusOffsets | undefined) {
	v.safeInteger(group.count, `${at}.count`, 0)
	if (order === 'weightedRoundRobin') v.positive(group.weight, `${at}.weight`)
	else v.optional(group.weight, `${at}.weight`, v.positive)

	if (focusOffsets !== undefined && isRecord(group.capture) && group.capture.frameType === 'LIGHT') {
		validateFilterHasOffset(v, group.filter, focusOffsets, `${at}.filter`)
	}
}

// Fields of a triggered (calibration) group.
function validateTriggeredGroup(v: ConfigurationValidator, group: JsonRecord, at: string, scheduledIds: ReadonlySet<string>) {
	const { capture, batchSize, trigger, inherit, opticalPath } = group

	validateTrigger(v, trigger, `${at}.trigger`, scheduledIds)

	if (isRecord(capture)) {
		v.check(capture.frameType === 'DARK' || capture.frameType === 'BIAS', `${at}.capture.frameType`, 'must be DARK or BIAS in a triggered group')
	}

	if (v.safeInteger(batchSize, `${at}.batchSize`, 1)) v.safeInteger(group.maxFrames, `${at}.maxFrames`, batchSize)

	if (v.check(inherit === 'none' || inherit === 'triggeringFrame', `${at}.inherit`, 'must be none or triggeringFrame') && isRecord(trigger)) {
		v.check(inherit !== 'triggeringFrame' || trigger.kind !== 'sessionStart', `${at}.inherit`, 'cannot inherit from a triggering frame at session start')
	}

	if (v.object(opticalPath, `${at}.opticalPath`)) {
		if (opticalPath.kind === 'filter') validateFilterReference(v, opticalPath.filter, `${at}.opticalPath.filter`)
		else v.check(opticalPath.kind === 'none' || opticalPath.kind === 'cover', `${at}.opticalPath.kind`, 'must be none, cover or filter')
	}
}

// Focus offsets: a non-empty reference and integer step offsets, the reference one (when present) being 0.
function validateFocusOffsets(v: ConfigurationValidator, focusOffsets: unknown, path: string): focusOffsets is SequencerFilterFocusOffsets {
	if (!v.object(focusOffsets, path)) return false
	const { reference, offsets } = focusOffsets
	const validReference = v.string(reference, `${path}.reference`, true)
	if (!v.object(offsets, `${path}.offsets`)) return false

	let ok = validReference

	for (const name in offsets) {
		ok = v.safeInteger(offsets[name], `${path}.offsets.${name}`, Number.MIN_SAFE_INTEGER) && ok
	}

	if (validReference && Object.hasOwn(offsets, reference)) {
		ok = v.check(offsets[reference] === 0, `${path}.offsets.${reference}`, 'must be 0 for the reference filter') && ok
	}

	return ok
}

// Capture configuration; returns it when its focus offsets are usable by later cross-field rules.
function validateCapture(v: ConfigurationValidator, capture: unknown, path: string) {
	if (!v.object(capture, path)) return undefined

	v.member(CAPTURE_ORDERS, capture.order, `${path}.order`)
	const focusOffsets = capture.focusOffsets !== undefined && validateFocusOffsets(v, capture.focusOffsets, `${path}.focusOffsets`) ? capture.focusOffsets : undefined
	if (v.array(capture.groups, `${path}.groups`)) validateGroups(v, capture.groups, `${path}.groups`, capture.order, focusOffsets)
	validateRetry(v, capture.retry, `${path}.retry`)
	v.member(CAPTURE_FAILURE_ACTIONS, capture.onFailure, `${path}.onFailure`)

	if (v.object(capture.cameraRecovery, `${path}.cameraRecovery`)) {
		const recovery = capture.cameraRecovery
		v.optional(recovery.timeout, `${path}.cameraRecovery.timeout`, v.positive)
		v.optional(recovery.pollInterval, `${path}.cameraRecovery.pollInterval`, v.positive)
		v.member(FAILURE_ACTIONS, recovery.onTimeout, `${path}.cameraRecovery.onTimeout`)
	}

	if (capture.quality !== undefined && v.object(capture.quality, `${path}.quality`)) {
		v.positive(capture.quality.timeout, `${path}.quality.timeout`)
		v.optional(capture.quality.abortGrace, `${path}.quality.abortGrace`, v.positive)
	}

	return { focusOffsets }
}

// Startup lifecycle.
function validateStartup(v: ConfigurationValidator, startup: unknown, path: string) {
	if (!v.object(startup, path)) return

	if (startup.cooling !== undefined && v.object(startup.cooling, `${path}.cooling`)) {
		const { cooling } = startup
		v.finite(cooling.setpoint, `${path}.cooling.setpoint`)
		v.positive(cooling.tolerance, `${path}.cooling.tolerance`)
		v.nonNegative(cooling.stableFor, `${path}.cooling.stableFor`)
		v.positive(cooling.timeout, `${path}.cooling.timeout`)
		v.boolean(cooling.waitForTemperature, `${path}.cooling.waitForTemperature`)
	}

	if (startup.dome !== undefined && v.object(startup.dome, `${path}.dome`)) v.boolean(startup.dome.open, `${path}.dome.open`)
	if (startup.cover !== undefined && v.object(startup.cover, `${path}.cover`)) v.boolean(startup.cover.open, `${path}.cover.open`)

	if (startup.mount !== undefined && v.object(startup.mount, `${path}.mount`)) {
		v.boolean(startup.mount.unpark, `${path}.mount.unpark`)
		if (startup.mount.trackMode !== undefined) v.member(TRACK_MODES, startup.mount.trackMode, `${path}.mount.trackMode`)
	}

	if (startup.retry !== undefined) validateRetry(v, startup.retry, `${path}.retry`)
	v.member(FAILURE_ACTIONS, startup.onFailure, `${path}.onFailure`)
}

// Shutdown timeouts and step policies.
function validateShutdown(v: ConfigurationValidator, shutdown: unknown, path: string) {
	if (!v.object(shutdown, path)) return
	v.positive(shutdown.stepTimeout, `${path}.stepTimeout`)
	v.positive(shutdown.totalTimeout, `${path}.totalTimeout`)

	for (const step of SHUTDOWN_STEPS) {
		if (shutdown[step] !== undefined) v.member(SHUTDOWN_STEP_POLICIES, shutdown[step], `${path}.${step}`)
	}
}

// Target acquisition, centering and recenter.
function validatePointing(v: ConfigurationValidator, pointing: unknown, path: string) {
	if (!v.object(pointing, path)) return
	v.nonNegative(pointing.settle, `${path}.settle`)

	if (pointing.centering !== undefined && v.object(pointing.centering, `${path}.centering`)) {
		const { centering } = pointing
		v.positive(centering.tolerance, `${path}.centering.tolerance`)
		v.safeInteger(centering.maximumAttempts, `${path}.centering.maximumAttempts`, 1)
		v.nonNegative(centering.settle, `${path}.centering.settle`)
		v.boolean(centering.syncMount, `${path}.centering.syncMount`)
		validateCameraCapture(v, centering.capture, `${path}.centering.capture`)
		v.positive(centering.solveTimeout, `${path}.centering.solveTimeout`)
		v.optional(centering.abortGrace, `${path}.centering.abortGrace`, v.positive)
		if (centering.auxiliary !== undefined) v.member(AUXILIARY_ARTIFACTS, centering.auxiliary, `${path}.centering.auxiliary`)
	}

	if (pointing.recenter !== undefined && v.object(pointing.recenter, `${path}.recenter`)) {
		v.optional(pointing.recenter.afterFrames, `${path}.recenter.afterFrames`, (value, path) => v.safeInteger(value, path, 1))
		v.optional(pointing.recenter.interval, `${path}.recenter.interval`, v.positive)
	}

	if (pointing.retry !== undefined) validateRetry(v, pointing.retry, `${path}.retry`)
	v.member(FAILURE_ACTIONS, pointing.onFailure, `${path}.onFailure`)
}

// Field rotation.
function validateRotator(v: ConfigurationValidator, rotator: unknown, path: string) {
	if (!v.object(rotator, path)) return
	v.range(rotator.angle, `${path}.angle`, 0, TAU, false)
	v.positive(rotator.tolerance, `${path}.tolerance`)
	v.nonNegative(rotator.settle, `${path}.settle`)
	if (rotator.retry !== undefined) validateRetry(v, rotator.retry, `${path}.retry`)
	v.member(FAILURE_ACTIONS, rotator.onFailure, `${path}.onFailure`)
}

// Autofocus algorithm, auxiliary capture and triggers.
function validateAutofocus(v: ConfigurationValidator, autofocus: unknown, path: string) {
	if (!v.object(autofocus, path)) return

	if (v.object(autofocus.algorithm, `${path}.algorithm`)) {
		const { algorithm } = autofocus
		v.safeInteger(algorithm.initialOffsetSteps, `${path}.algorithm.initialOffsetSteps`, 1)
		v.safeInteger(algorithm.stepSize, `${path}.algorithm.stepSize`, 1)
		v.member(FITTING_MODES, algorithm.fittingMode, `${path}.algorithm.fittingMode`)
		v.optional(algorithm.rmsdThreshold, `${path}.algorithm.rmsdThreshold`, v.nonNegative)
		v.boolean(algorithm.reversed, `${path}.algorithm.reversed`)
	}

	validateCameraCapture(v, autofocus.capture, `${path}.capture`)
	if (autofocus.filter !== undefined) validateFilterReference(v, autofocus.filter, `${path}.filter`)

	if (v.object(autofocus.triggers, `${path}.triggers`)) {
		const { triggers } = autofocus
		v.boolean(triggers.onStart, `${path}.triggers.onStart`)
		v.boolean(triggers.afterResume, `${path}.triggers.afterResume`)
		v.boolean(triggers.afterFlip, `${path}.triggers.afterFlip`)
		v.boolean(triggers.onFilterChange, `${path}.triggers.onFilterChange`)
		v.optional(triggers.afterFrames, `${path}.triggers.afterFrames`, (value, path) => v.safeInteger(value, path, 1))
		v.optional(triggers.interval, `${path}.triggers.interval`, v.positive)
		v.optional(triggers.temperatureDelta, `${path}.triggers.temperatureDelta`, v.positive)
	}

	v.positive(autofocus.measureTimeout, `${path}.measureTimeout`)
	v.optional(autofocus.abortGrace, `${path}.abortGrace`, v.positive)
	if (autofocus.auxiliary !== undefined) v.member(AUXILIARY_ARTIFACTS, autofocus.auxiliary, `${path}.auxiliary`)
	if (autofocus.retry !== undefined) validateRetry(v, autofocus.retry, `${path}.retry`)
	v.member(OPTIONAL_FAILURE_ACTIONS, autofocus.onFailure, `${path}.onFailure`)
}

// Guiding settle, pause bound and recovery budget.
function validateGuiding(v: ConfigurationValidator, guiding: unknown, path: string) {
	if (!v.object(guiding, path)) return

	if (v.object(guiding.settle, `${path}.settle`)) {
		v.positive(guiding.settle.pixels, `${path}.settle.pixels`)
		v.nonNegative(guiding.settle.time, `${path}.settle.time`)
		v.positive(guiding.settle.timeout, `${path}.settle.timeout`)
	}

	v.positive(guiding.pauseTimeout, `${path}.pauseTimeout`)
	v.safeInteger(guiding.maxRecoveries, `${path}.maxRecoveries`, 0)
	v.boolean(guiding.recalibrate, `${path}.recalibrate`)
	v.boolean(guiding.flipCalibration, `${path}.flipCalibration`)
	v.member(OPTIONAL_FAILURE_ACTIONS, guiding.onFailure, `${path}.onFailure`)
}

// Dither cadence, amount and settle.
function validateDither(v: ConfigurationValidator, dither: unknown, path: string) {
	if (!v.object(dither, path)) return
	v.safeInteger(dither.afterFrames, `${path}.afterFrames`, 1)

	if (v.object(dither.amount, `${path}.amount`)) {
		v.check(dither.amount.unit === 'guidePixel' || dither.amount.unit === 'angle', `${path}.amount.unit`, 'must be guidePixel or angle')
		v.positive(dither.amount.value, `${path}.amount.value`)
	}

	v.boolean(dither.raOnly, `${path}.raOnly`)

	if (v.object(dither.settle, `${path}.settle`)) {
		const { settle } = dither

		if (settle.kind === 'guided') {
			v.positive(settle.pixels, `${path}.settle.pixels`)
			v.nonNegative(settle.time, `${path}.settle.time`)
			v.positive(settle.timeout, `${path}.settle.timeout`)
		} else if (settle.kind === 'mechanical') {
			v.nonNegative(settle.time, `${path}.settle.time`)
		} else {
			v.check(false, `${path}.settle.kind`, 'must be guided or mechanical')
		}
	}

	v.member(OPTIONAL_FAILURE_ACTIONS, dither.onFailure, `${path}.onFailure`)
}

// Meridian flip thresholds, pier sides and timings. Returns whether the flip is enabled, so the cross-feature
// rules that depend on it apply.
function validateMeridianFlip(v: ConfigurationValidator, flip: unknown, path: string) {
	if (!v.object(flip, path)) return false

	const { enabled, prepareAt, flipAt, latestAt, beforeFlipPierSide, afterFlipPierSide, protectionMargin } = flip

	v.boolean(enabled, `${path}.enabled`)
	const thresholds = v.hourAngle(prepareAt, `${path}.prepareAt`) && v.hourAngle(flipAt, `${path}.flipAt`) && v.hourAngle(latestAt, `${path}.latestAt`)

	if (v.member(FLIP_PIER_SIDES, beforeFlipPierSide, `${path}.beforeFlipPierSide`) && v.member(FLIP_PIER_SIDES, afterFlipPierSide, `${path}.afterFlipPierSide`)) {
		v.check(beforeFlipPierSide !== afterFlipPierSide, `${path}.afterFlipPierSide`, 'must differ from beforeFlipPierSide')
	}

	v.optional(flip.pierSideTimeout, `${path}.pierSideTimeout`, v.positive)
	v.optional(flip.maxRetries, `${path}.maxRetries`, (value, path) => v.safeInteger(value, path, 0))
	v.optional(flip.requireRecentering, `${path}.requireRecentering`, v.boolean)
	v.optional(flip.requireGuidingSettle, `${path}.requireGuidingSettle`, v.boolean)
	v.optional(flip.exposureMargin, `${path}.exposureMargin`, v.nonNegative)
	const margin = v.optional(protectionMargin, `${path}.protectionMargin`, v.positive)
	v.optional(flip.supervisionInterval, `${path}.supervisionInterval`, v.positive)
	v.optional(flip.flipTimeout, `${path}.flipTimeout`, v.positive)
	if (flip.whilePaused !== undefined) v.member(WHILE_PAUSED_ACTIONS, flip.whilePaused, `${path}.whilePaused`)
	if (flip.onFailure !== undefined) v.member(FAILURE_ACTIONS, flip.onFailure, `${path}.onFailure`)

	if (flip.hardProtection !== undefined && v.object(flip.hardProtection, `${path}.hardProtection`)) {
		v.optional(flip.hardProtection.mountStopTimeout, `${path}.hardProtection.mountStopTimeout`, v.positive)
		v.optional(flip.hardProtection.guidingStopTimeout, `${path}.hardProtection.guidingStopTimeout`, v.positive)
		v.optional(flip.hardProtection.trackingTimeout, `${path}.hardProtection.trackingTimeout`, v.positive)
	}

	if (thresholds) {
		const a = prepareAt
		const f = flipAt
		const l = latestAt

		if (v.check(a <= f, `${path}.prepareAt`, 'must be <= flipAt') && v.check(f < l, `${path}.flipAt`, 'must be < latestAt') && margin) {
			// Continuous window: the graceful (and therefore the hard) deadline always falls with the flip already due.
			const drift = ((protectionMargin as number | undefined) ?? DEFAULT_SEQUENCER_MERIDIAN_FLIP.protectionMargin) * SIDEREAL_DRIFT_RATE
			v.check(f <= l - drift, `${path}.latestAt`, `must be >= flipAt + protectionMargin × sidereal rate (${f + drift} rad)`)
		}
	}

	return enabled === true
}

// Safety policy.
function validateSafety(v: ConfigurationValidator, safety: unknown, path: string) {
	if (!v.object(safety, path)) return
	v.member(UNSAFE_ACTIONS, safety.unsafeAction, `${path}.unsafeAction`)
	v.member(UNSAFE_AT_STARTUP_ACTIONS, safety.onUnsafeAtStartup, `${path}.onUnsafeAtStartup`)
	v.boolean(safety.unknownIsUnsafe, `${path}.unknownIsUnsafe`)
}
