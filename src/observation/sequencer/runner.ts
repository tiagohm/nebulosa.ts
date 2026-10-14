import { errorMessage } from '../../core/util'
import type { Device } from '../../devices/indi/device'
import { type FailedOperationResult, failedOperationResult, type OperationContext, type OperationCoordinator, type OperationExecutor, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { awaitCooperativeJob } from '../../devices/orchestration/operation.wait'
import { type ResourceConflict, type ResourceKey, type ResourceRequest, type ResourceReservation, type ResourceReservationOwner, resourceKey } from '../../devices/orchestration/resource'
import { MountDitherer } from '../guiding/ditherer'
import { createMeridianFlipState } from '../mount/meridian.flip'
import { isSequencerSafetyGated } from './safety'
import { fireCalibrationTriggers, restoreSequencerFrameSlot, selectNextFrame, selectNextFrameOnStop, type SequencerTriggerEvent } from './scheduler'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE, type SequencerCheckpoint, type SequencerCheckpointSlot, type SequencerClock, type SequencerConfiguration, type SequencerCorrectiveIntents, type SequencerDevices, type SequencerEventBody, type SequencerFailure, type SequencerFailureAction, type SequencerFrameDecision, type SequencerFrameDiscardPolicy, type SequencerFrameGroup, type SequencerFrameSlot, type SequencerHandle, type SequencerMeridianProtectionFailure, type SequencerOptionalFailureAction, type SequencerPhase, type SequencerQualityOutcome, type SequencerQualityResult, type SequencerResult, type SequencerRetryPolicy, type SequencerRunnerServices, type SequencerSafetySnapshot, type SequencerSessionState, type SequencerShutdownStepPolicy, type SequencerSnapshot, type SequencerTaskId, type SequencerTerminalState, SYSTEM_SEQUENCER_CLOCK } from './sequencer'
// oxfmt-ignore
import { applyCorrectiveIntents, applySequencerCheckpoint, classifySequencerFrame, createSequencerRuntimeState, decideFrameOutcome, exhaustedDiscardAction, isSequencerSafetyBlocking, isTerminalSequencerState, recordSequencerSafetyTransition, requestSequencerHold, requestSequencerPause, requestSequencerResume, requestSequencerStop, type SequencerCompensation, type SequencerFrameClassification, type SequencerFrameEvidence, type SequencerRuntimeState, type SequencerSafetyTransition, type SequencerStopMode, safetyUnsafeWithin, sequencerCaptureProgressSnapshot, sequencerCheckpointOf, sequencerFrameSlotSnapshot, sequencerSnapshot, shouldHoldSequencer, transitionSequencerState } from './state'
import type { SequencerDeferReason, SequencerFrameDestination, SequencerStorage } from './storage'
import { bootstrapSequencerElapsedAnchors } from './trigger'

// Runner of one Sequencer session: the only owner of its execution. It admits the session, holds one resource
// reservation for its whole lifetime, runs the startup, the frame loop (select → pre-capture → capture →
// post-capture) and the shutdown in a fixed order, honors pause, resume and stop only at safe points, drains
// interrupted work in two stages, runs the pending compensations as new roots of the same reservation, and
// terminalizes exactly once after the terminal drain and the release.
//
// Admission locks the session directory before anything else, then resumes: the checkpoint is loaded, bound to the
// configuration id and revision, reconciled with the journal and the disk, and restored (the slot in progress
// included), all before the reservation. Persistence follows section 34.2: a checkpoint is saved when a new slot is
// selected, after each capture failure (before its `abandoned` line), after a resume that renews a counter, after an
// intent changes and when a task advanced an anchor or cleared an intent (`saveCheckpoint`); a captured frame is one
// logical transaction, computed before its file is touched, journaled with the promotion, applied and then saved.
// A prepared attempt that is not dispatched is closed by `deferred` before any wait or re-entry. The capture asks the
// session synchronously, right before dispatching, whether the exposure may go (a pending stop, pause or protection
// refuses it); only an approved exposure is a commanded attempt that may count as a capture failure. A persistence
// failure fails the session with a 'storage' failure: no new exposure starts and nothing advances in memory as if it
// had been saved. The lock is released after the reservation, right before the terminalization.
//
// The post-capture never commands a device. It awaits the caller's quality analyzer on the durable temporary with a
// strictly cooperative timeout (the file never moves before the analysis settled), classifies the frame from that
// outcome, the guiding interruptions and the recorded safety transitions of its monotonic window [dispatch, end],
// decides it (accepted, forced, retake, skipSlot, pause, stop, fail, discardFinal) before touching the file, and
// journals the complete next checkpoint (progress, light exposures, discard counters, corrective intents, calibration
// batches its light triggers enqueued) with the promotion or the disposition. A pause or a stop owed to an exhausted discard counter is derived from the persisted
// counters, so a restart applies it again before exposing; only `resume()` renews the counter that paused.
//
// Every physical task is a root `sequencer.{taskId}` opened through `startTask`, which refuses once the run was
// aborted; tasks pass the root context to commanders, so cancelling the root cancels everything they commanded.
// The run signal covers startup, pre-capture, capture and post-capture; the shutdown has a signal of its own that
// only `dispose()` aborts, so an immediate stop never cancels the steps that leave the observatory safe.
//
// A supervisor (the meridian limit) is armed right after the reservation and the guiding run admission, before any
// command, and only asks for protections: a graceful one runs as a task at the next safe point; a critical one
// (`protectCritically`) cancels the current task at once and runs as a single-flight critical root while that task
// still quiesces, and no task, drain, compensation or shutdown step starts before its outcome. The final guard may ask
// the pre-capture to re-enter instead of exposing; past `SEQUENCER_REENTRY_LIMIT` re-entries without an exposure the
// session fails instead of looping.
//
// The task lists are explicit arrays the session builds in its fixed physical order; there is no registry and no
// instruction pointer. Durations of the configuration are seconds and become milliseconds only at the clock; every
// wait is `clock.delay` in the monotonic domain, every persisted or reported instant is `clock.wallNow()`.

// Read-only view of a session given to a task predicate. `state` is the live runtime state: a predicate reads it
// and never mutates it.
export interface SequencerTaskView {
	// Session id.
	readonly sessionId: string
	// Configuration of the session.
	readonly configuration: SequencerConfiguration
	// Devices of the session.
	readonly devices: SequencerDevices
	// Operational clock of the session.
	readonly clock: SequencerClock
	// Live runtime state.
	readonly state: SequencerRuntimeState
	// Slot being prepared or captured; absent in the startup and the shutdown.
	readonly frame?: SequencerFrameSlot
}

// Execution context of one task: the view plus the root operation of the task. `scope` is passed to commanders and
// runners, which nest their operations under it; `signal` is the signal of that root.
export interface SequencerContext extends SequencerTaskView {
	// Root operation of the task, opened under the session reservation.
	readonly scope: OperationContext
	// Cancellation signal of the root.
	readonly signal: AbortSignal
	// Opens roots of the session reservation, for a collaborator whose operation outlives the task (the root `guiding`
	// of a guiding session). It refuses with 'aborted', like the task roots, once the signal of the phase aborted.
	readonly reservation: OperationScope
	// Emits a session event of the task synchronously; the session stamps and delivers it.
	readonly emit: (event: SequencerEventBody) => void
	// Persists the current logical state (anchors, intents, baseline the task just updated) as the next checkpoint. A
	// failed save fails the session with its 'storage' failure, which is also returned for the task to end with.
	readonly saveCheckpoint: () => Promise<SequencerTaskResult>
}

// Outcome of one task execution. A failure carries the session failure the phase policy applies to; a success may ask
// the pre-capture to re-enter instead of exposing (`reenter`, the refusal of the final exposure guard).
export type SequencerTaskResult = { readonly ok: true; readonly reenter?: SequencerReentry } | SequencerFailedTaskResult

// Re-entry of the pre-capture asked by a task that succeeded without letting the frame be exposed now. It counts
// against the limit of re-entries without progress (`SEQUENCER_REENTRY_LIMIT`) and consumes no attempt.
export interface SequencerReentry {
	// Why the frame may not be exposed now; diagnostic.
	readonly reason: string
	// Wait before the re-entry, in ms of the monotonic clock; a safe point for pause, stop and protections.
	readonly wait?: number
}

// Re-entries of the pre-capture of one slot without an exposure in between (guard and `beforeExposure` refusals) above
// which the session fails as a logic bug instead of looping (section 43). Re-entries of a meridian protection never count.
export const SEQUENCER_REENTRY_LIMIT = 3

// Root of the run that may move the mount: its task and the resource keys whose lease can move it (section 24.5).
export interface SequencerMotionOwner {
	// Task of the root.
	readonly task: SequencerTaskId
	// Mount or movement keys the root may lease.
	readonly keys: readonly ResourceKey[]
}

// Outcome of a critical protection: success, or the failure with the session action to apply.
export type SequencerProtectionOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: SequencerFailure; readonly action: SequencerFailureAction }

// What the runner offers a supervisor (the meridian limit supervision) while it is armed.
export interface SequencerSupervisorHost {
	// Live view of the session, with the slot in progress.
	readonly view: () => SequencerTaskView
	// Emits a session event synchronously.
	readonly emit: (event: SequencerEventBody) => void
	// Asks for a graceful protection run as a task at the next safe point (`SequencerRunner.requestProtection`).
	readonly requestProtection: (action: SequencerTask) => boolean
	// Runs `protect` at once as the critical root `kind`, single-flight (see `SequencerRunner.protectCritically`).
	readonly protectCritically: (kind: string, protect: OperationExecutor<SequencerProtectionOutcome>) => Promise<SequencerProtectionOutcome>
	// Fails the session with `failure` (a configuration failure such as `meridianCycleExceeded`).
	readonly fail: (failure: SequencerFailure) => void
	// Living roots of the run that may move the mount, by root id; a root being started, whose first synchronous stretch
	// runs before its id is known, is listed under a provisional key.
	readonly motionOwners: ReadonlyMap<string, SequencerMotionOwner>
	// Orchestration core of the session.
	readonly coordinator: OperationCoordinator
}

// Continuous supervision of a session (the meridian limit), armed synchronously right after the reservation and the
// guiding run admission (step 0b), before any command, and disarmed by the terminalization at the latest.
export interface SequencerSupervisor {
	// Arms the supervision; never awaits.
	readonly arm: (host: SequencerSupervisorHost) => void
	// Motion keys of the roots of `task` (`mountKeyHolders`); empty when it moves nothing.
	readonly motionKeys: (task: SequencerTaskId) => readonly ResourceKey[]
	// A safe point passed: re-evaluate.
	readonly safePoint: VoidFunction
	// Ends the supervision; idempotent.
	readonly disarm: VoidFunction
}

// Failed outcome of one task execution.
export interface SequencerFailedTaskResult {
	readonly ok: false
	// Session failure the phase policy applies to.
	readonly failure: SequencerFailure
	// Whether no exposure of this safe point may start after the failure (a failed restore of the filter or of the
	// focuser, a light whose focus baseline stays unknown): once the retries are exhausted, a 'skip' action applies
	// 'fail' instead.
	readonly fatal?: boolean
}

// Retry and failure action of a startup or pre-capture task, from the configuration of its feature.
export interface SequencerTaskPolicy {
	// Bounded retry of a failed execution; absent runs it once.
	readonly retry?: SequencerRetryPolicy
	// Session action once the retries are exhausted.
	readonly onFailure: SequencerOptionalFailureAction
}

// Built-in task of a phase list. Internal contract: tasks are composed by the session in a fixed order, never
// registered or resolved by name; the id is telemetry only.
export interface SequencerTask {
	// Telemetry identity, also the root kind `sequencer.{id}`.
	readonly id: SequencerTaskId
	// Whether the task runs for this view; it reads configuration, physical state and slot, never commands.
	readonly shouldRun: (view: SequencerTaskView) => boolean | Promise<boolean>
	// Runs the task inside its root. Expected failures are values; a throw becomes `operation/commandFailed`.
	readonly run: (context: SequencerContext) => Promise<SequencerTaskResult>
	// Retry and failure action; absent uses the phase default (startup: `configuration.startup`; otherwise fail).
	readonly policy?: SequencerTaskPolicy
}

// Shutdown step: a task whose failure is accumulated and never stops the following steps.
export interface SequencerShutdownTask extends Omit<SequencerTask, 'policy'> {
	// Whether a failure of the step makes the session 'failed' or is only reported.
	readonly policy: SequencerShutdownStepPolicy
	// Device the step commands; a safety critical protection defers the step while a living root of the run leases it.
	readonly device?: (devices: SequencerDevices) => Device | undefined
	// Earlier steps the enclosure interlocks this one with: a safety critical protection that deferred one of them
	// defers this one too, so both run, in order, in the full shutdown.
	readonly interlock?: readonly SequencerTaskId[]
}

// Tracking protection prefix of a session (`protectMountTracking`, section 24.5: guiding pause, release of the mount
// motion, tracking off), run first by the safety critical protection (section 32.4) and by the hard meridian path.
export interface SequencerTrackingProtection {
	// Runs the prefix inside `context` for the session `host` describes; resolves its first failure, absent when clean.
	readonly protect: (context: OperationContext, host: SequencerSupervisorHost) => Promise<{ readonly failure?: SequencerMeridianProtectionFailure }>
}

// What the exposure of one frame produced, with its physical instants read from the session clock. The frame itself
// is the temporary of the destination. Wall instants (`...At`, Unix ms) stamp the journal and the events and give
// the astronomical midpoint; monotonic instants (`...Monotonic`, ms) bound the exposure window [dispatch, end] of
// the safety and guiding criteria. The two domains are never compared with each other.
export interface SequencerCapturedFrame {
	// Wall instant read immediately before the exposure command; a lower bound of the physical start.
	readonly exposureDispatchedAt?: number
	// Monotonic counterpart of `exposureDispatchedAt`, where the exposure window starts.
	readonly exposureDispatchedMonotonic?: number
	// Wall instant of the first Busy of the exposure, in Unix ms; an upper bound of the physical start.
	readonly exposureStartedAt: number
	// Monotonic counterpart of `exposureStartedAt`.
	readonly exposureStartedMonotonic: number
	// Wall instant of the Ok of the exposure, in Unix ms.
	readonly exposureFinishedAt: number
	// Monotonic counterpart of `exposureFinishedAt`, where the exposure window ends.
	readonly exposureFinishedMonotonic: number
	// Sensor temperature the camera reported when the frame arrived, in °C; absent without a thermometer. It drives the
	// 'temperatureChange' calibration triggers and is journaled with the frame transaction.
	readonly sensorTemperature?: number
}

// Execution context of the capture: the task context plus the prepared destination of the attempt and the two
// callbacks that tie the exposure to the session.
export interface SequencerCaptureContext extends SequencerContext {
	// Destination of the attempt; the frame is written durably to its temporary, never to its final.
	readonly destination: SequencerFrameDestination
	// Last decision of the session, called synchronously right before the exposure is dispatched (the
	// `beforeExposure` hook of the capturer): undefined approves it, a failure refuses it (a stop, a pause or a
	// protection is pending) and the capture must end with that failure without dispatching. It reads only the
	// session state, never awaits and never commands. Only an approved exposure is a commanded attempt: a capture
	// that fails before the approval consumes no attempt and counts no capture failure.
	readonly beforeExposure: () => FailedOperationResult | undefined
	// Reports that the approved exposure was dispatched (the `exposureStarted` of the capturer); emits the
	// `exposureStarted` event of the session.
	readonly exposureStarted: VoidFunction
}

// Exposure of exactly one frame, inside its root `sequencer.captureFrame`.
export type SequencerCaptureStep = (context: SequencerCaptureContext) => Promise<OperationResult<SequencerCapturedFrame>>

// Task lists of a session, in their fixed physical order.
export interface SequencerRunnerPhases {
	// Equipment startup, before the first frame.
	readonly startup: readonly SequencerTask[]
	// Safe-point barrier of every frame, run again from the first task on every re-entry.
	readonly preCapture: readonly SequencerTask[]
	// Exposure of one frame.
	readonly capture: SequencerCaptureStep
	// Equipment shutdown, always run once the reservation was taken.
	readonly shutdown: readonly SequencerShutdownTask[]
	// Continuous supervision (the meridian limit) armed at step 0b; absent supervises nothing.
	readonly supervisor?: SequencerSupervisor
	// Tracking protection prefix of the safety critical protection, the very one of the supervisor when there is one;
	// absent pauses no guiding and stops no tracking before the free shutdown steps.
	readonly trackingProtection?: SequencerTrackingProtection
	// Last synchronous check of the session right before an exposure is dispatched (the final exposure guard repeated by
	// `beforeExposure`): why the exposure of the frame of `view` must not go now, or undefined. It reads the devices and
	// the session state only; it never awaits nor commands.
	readonly exposureRefusal?: (view: SequencerTaskView) => string | undefined
}

// Input of one session runner.
export interface SequencerRunnerOptions {
	// Validated configuration.
	readonly configuration: SequencerConfiguration
	// Resolved devices.
	readonly devices: SequencerDevices
	// Orchestration core, storage, checkpoint store, commanders, clock and listener; the session id is the one of the
	// storage.
	readonly services: SequencerRunnerServices
	// Task lists of the session; the pre-capture prepares the frame destination (`prepareFrameDestinationTask`).
	readonly phases: SequencerRunnerPhases
	// Forced disposal (process shutdown): aborts everything, including the shutdown, and releases.
	readonly disposeSignal?: AbortSignal
}

// Resources the session reserves: the primary camera always, and each other device only when an enabled feature
// of the configuration commands it (section 14.3). Absent devices are skipped; duplicated keys (co-resident
// interfaces such as a cover and its flat panel) are collapsed by the arbiter. Disabled groups never count.
export function sequencerResourceRequests(configuration: SequencerConfiguration, devices: SequencerDevices): ResourceRequest[] {
	const { target, capture, startup, shutdown, pointing, rotator, autofocus, meridianFlip } = configuration
	const groups = capture.groups.filter((group) => group.enabled)
	const requests: ResourceRequest[] = []

	const add = (device: Device | undefined, used: boolean) => {
		if (device !== undefined && used) requests.push({ key: resourceKey(device), device })
	}

	add(devices.camera, true)
	add(devices.mount, target !== undefined || pointing !== undefined || meridianFlip?.enabled === true || startup.mount !== undefined || shutdown.stopTracking !== undefined || shutdown.parkMount !== undefined)
	add(devices.wheel, autofocus?.filter !== undefined || groups.some((group) => group.filter !== undefined || (group.kind === 'triggered' && group.opticalPath.kind === 'filter')))
	add(devices.focuser, autofocus !== undefined || capture.focusOffsets !== undefined)
	add(devices.rotator, rotator !== undefined)
	add(devices.cover, startup.cover !== undefined || shutdown.closeCover !== undefined || groups.some((group) => group.kind === 'triggered' && group.opticalPath.kind === 'cover'))
	add(devices.dome, startup.dome !== undefined || shutdown.closeOrParkDome !== undefined)
	add(devices.flatPanel, shutdown.turnOffFlatPanel !== undefined)

	return requests
}

// Resources of the guiding session and of the ditherer of the enabled guiding and dither features: `reserve` joins the
// reservation of the session; `hold` is what they lease by themselves, which must never be a device the session
// commands (section 14.1). A ditherer that is the guiding session is counted once.
export function sequencerAdapterResources(configuration: Pick<SequencerConfiguration, 'guiding' | 'dither'>, services: Pick<SequencerRunnerServices, 'guiding' | 'ditherer'>) {
	const reserve: ResourceRequest[] = []
	const hold: ResourceRequest[] = []

	const add = (resources: { readonly reserve: readonly ResourceRequest[]; readonly hold: readonly ResourceRequest[] } | undefined) => {
		if (resources === undefined) return
		reserve.push(...resources.reserve)
		hold.push(...resources.hold)
	}

	const guiding = configuration.guiding === undefined ? undefined : services.guiding
	if (guiding !== undefined) add(guiding.resources())
	if (configuration.dither !== undefined && services.ditherer !== undefined && (services.ditherer as unknown) !== guiding) add(services.ditherer.resources())

	return { reserve, hold }
}

// Delay before the retry number `retry` (1-based), in ms: `delay × backoff^(retry − 1)` seconds, capped at
// `maximumDelay`.
export function sequencerRetryDelay(policy: SequencerRetryPolicy, retry: number) {
	return Math.min(policy.delay * policy.backoff ** (retry - 1), policy.maximumDelay) * 1000
}

// Policy of a task without one outside the startup: its failure fails the session.
const FAIL_POLICY: SequencerTaskPolicy = { onFailure: 'fail' }

// Outcome of one task after its retries.
// - done: it succeeded or did not need to run; `reenter` when it asked the pre-capture to re-enter;
// - interrupted: the runner cancelled it (stop, protection, disposal); never retried;
// - failed: its retries are exhausted and `action` applies.
type TaskOutcome = { readonly kind: 'done'; readonly reenter?: SequencerReentry } | { readonly kind: 'interrupted' } | { readonly kind: 'failed'; readonly failure: SequencerFailure; readonly action: SequencerOptionalFailureAction }

// Outcome of the capture of one frame. Only an exposure `beforeExposure` approved was commanded and may count.
// - captured: the exposure produced a frame;
// - failed: the commanded exposure produced no frame; `protection` when the runner cancelled it for a protection;
// - interrupted: the commanded exposure was cancelled by a stop or a disposal; nothing is counted;
// - deferred: nothing was commanded (a refusal of `beforeExposure`, or a stop or a protection before it); the
//   attempt is closed by `deferred` with `reason` and prepared again by the next pre-capture;
// - undispatched: the capture failed before anything was commanded (camera unavailable or disconnected); the
//   capture policy applies at once without consuming the attempt, since nothing bounds a retry of it.
type CaptureOutcome =
	| { readonly kind: 'captured'; readonly frame: SequencerCapturedFrame }
	| { readonly kind: 'failed'; readonly failure: SequencerFailure; readonly protection: boolean }
	| { readonly kind: 'interrupted' }
	| { readonly kind: 'deferred'; readonly reason: SequencerDeferReason }
	| { readonly kind: 'undispatched'; readonly failure: SequencerFailure }

// What follows an applied failure action: the next task ('skip'), the same step again after a resume ('retry'),
// or the end of the phase ('end').
type FailureContinuation = 'skip' | 'retry' | 'end'

// Why the session holds: a user pause, a failure action 'pause', the capture failure policy (whose resume renews
// `captureFailures`), the exhausted discard budget of the slot (renews `discardBudgetUsed`) or the circuit breaker
// (renews `consecutiveDiscards`).
type HoldCause = 'user' | 'policy' | 'capture' | 'discard' | 'circuit'

// Outcome of an absent analyzer.
const SKIPPED_QUALITY: SequencerQualityOutcome = { kind: 'skipped' }

// Classifications a quality analyzer may resolve.
const QUALITY_CLASSIFICATIONS = new Set<unknown>(['accepted', 'rejected', 'unknown'] satisfies SequencerQualityResult['classification'][])

// Root of a run task the runner is waiting for.
interface CurrentTask {
	// Handle of the root.
	readonly handle: OperationHandle<unknown>
	// Phase the task runs in.
	readonly phase: SequencerPhase
	// Whether the runner cancelled it.
	interrupted: boolean
}

const DONE: TaskOutcome = { kind: 'done' }
const INTERRUPTED: TaskOutcome = { kind: 'interrupted' }

// Starts a session runner. Admission happens on the next microtask, so a stop issued right after the start is
// honored before anything is reserved.
export function startSequencerRunner(options: SequencerRunnerOptions) {
	return new SequencerRunner(options)
}

// One session. The handle is the public control; the other members are for the session modules (protection
// requests, critical tasks) and for the process (disposal).
export class SequencerRunner {
	// Session id.
	readonly id: string
	// Public control of the session; no method rejects.
	readonly handle: SequencerHandle

	readonly #configuration: SequencerConfiguration
	readonly #devices: SequencerDevices
	readonly #services: SequencerRunnerServices
	readonly #phases: SequencerRunnerPhases
	readonly #clock: SequencerClock
	readonly #runtime: SequencerRuntimeState
	// Reservation owner; object identity is what the arbiter and the coordinator key on.
	readonly #owner: ResourceReservationOwner
	// Signal of startup, pre-capture, capture and post-capture.
	readonly #run = new AbortController()
	// Signal of the shutdown; aborted only by disposal.
	readonly #shutdown = new AbortController()
	// Forced disposal.
	readonly #dispose = new AbortController()
	readonly #result = Promise.withResolvers<SequencerResult>()
	readonly #shutdownFailures: SequencerFailure[] = []
	readonly #compensationFailures: SequencerFailure[] = []
	readonly #disposeSignal?: AbortSignal
	#reservation?: ResourceReservation
	#scope?: OperationScope
	#current?: CurrentTask
	// Abortable wait of the run (a retry delay), interrupted like a task.
	#waiting?: AbortController
	// Wakes the hold.
	#wake?: VoidFunction
	// Shared promise of a pending pause.
	#pause?: PromiseWithResolvers<SequencerSessionState>
	// Pending protection action, single-flight.
	#protection?: SequencerTask
	// Whether a run task was cancelled, so the reservation must be drained before anything else starts.
	#drainPending = false
	// Whether the session fails (failure action, unexpected error, disposal).
	#failing = false
	// Whether a required shutdown step failed or the shutdown ran out of time.
	#shutdownFailed = false
	// Why a stopped session stopped.
	#stopCause?: SequencerResult['stopCause']
	// Whether the terminal pipeline began: from then on safety transitions are only recorded.
	#finishing = false
	// Capture failure policy 'pause' applied to a failure that is not retried.
	#capturePause = false
	// Delay before the next pre-capture of a retried capture, in ms.
	#retryDelay = 0
	// Whether no further frame runs, although the session only stops gracefully.
	#framesEnded = false
	// Artifact protocol of the session.
	readonly #storage: SequencerStorage
	// Sequence of the last checkpoint saved (or journaled by a frame transaction).
	#sequence = 0
	// Whether the attempt of the current slot was consumed (failed or discarded), so its next selection is a retake
	// with `attempt + 1`; false for a slot just selected or restored, whose attempt is still to run.
	#consumed = false
	// Attempt whose exposure `beforeExposure` approved last; while it is the open attempt of the storage it is never
	// deferred.
	#dispatched?: SequencerFrameDestination
	// End of the guiding run, registered once `beginRun` succeeded and called exactly once by the terminalization.
	#endRun?: VoidFunction
	// Critical protection in flight (single-flight); every task, drain and shutdown step waits for it.
	#critical?: Promise<SequencerProtectionOutcome>
	// Living roots of the run that may move the mount, by root id (a provisional key while the root starts).
	readonly #motionOwners = new Map<string, SequencerMotionOwner>()
	// Provisional keys of the motion owners being started.
	#startingMotion = 0
	// Re-entries of the pre-capture of the current slot without an exposure (guard and `beforeExposure` refusals).
	#reentries = 0
	// Wait of a guard re-entry, also interrupted by a pause request.
	#pausableWait?: AbortController
	// Whether a failed critical protection asked to hold at the next safe point, the startup included.
	#policyHold = false
	// What the supervisor of the session may use while armed.
	readonly #host: SequencerSupervisorHost
	// Whether the quality analyzer outlived the abort grace of an analysis; it is never called again in the session.
	#qualityFaulted = false
	// Safety transitions received since the startup, in the monotonic domain (section 32.3); runtime only.
	readonly #safetyHistory: SequencerSafetyTransition[] = []
	// Ends the subscription of the safety source.
	#unsubscribeSafety?: VoidFunction
	// Whether safety already shut the session down immediately (section 32.1); it happens once per session.
	#safetyShutdown = false
	// Safety critical protection in flight (section 32.4): the tracking prefix, then the free shutdown steps. Every task,
	// drain, compensation and shutdown step waits for it, like for `#critical`.
	#safetyProtection?: Promise<void>

	constructor(options: SequencerRunnerOptions) {
		const { configuration, devices, services, phases, disposeSignal } = options
		this.id = services.storage.sessionId
		this.#storage = services.storage
		this.#configuration = configuration
		this.#devices = devices
		this.#services = services
		this.#phases = phases
		this.#clock = services.clock ?? SYSTEM_SEQUENCER_CLOCK
		this.#runtime = createSequencerRuntimeState(configuration, this.#clock.wallNow())
		this.#owner = { id: this.id, kind: 'sequencer' }
		this.#disposeSignal = disposeSignal
		this.#host = Object.freeze({
			view: () => this.#view(this.#runtime.currentFrame),
			emit: this.#emitter,
			requestProtection: (action: SequencerTask) => this.requestProtection(action),
			protectCritically: (kind: string, protect: OperationExecutor<SequencerProtectionOutcome>) => this.protectCritically(kind, protect),
			fail: (failure: SequencerFailure) => this.#fail(failure),
			motionOwners: this.#motionOwners,
			coordinator: services.coordinator,
		})

		this.handle = Object.freeze({
			id: this.id,
			result: this.#result.promise,
			snapshot: () => this.snapshot(),
			pause: () => this.#requestPause(),
			resume: () => this.#requestResume(),
			stop: (mode: SequencerStopMode = 'graceful') => this.#requestStop(mode),
		})

		if (disposeSignal?.aborted) this.dispose()
		else disposeSignal?.addEventListener('abort', this.#onDispose, { once: true })

		queueMicrotask(() => void this.#start())
	}

	// Current observable projection; a fresh object on every call.
	snapshot(): SequencerSnapshot {
		return sequencerSnapshot(this.id, this.#configuration, this.#runtime)
	}

	// Opens a run task root `kind` under the reservation. Refuses with `aborted`, without running the executor,
	// once the run was aborted or before the reservation exists: the drain reopens the reservation tokens when it
	// ends, and without this gate a task started after a stop would be accepted.
	startTask<T>(kind: string, executor: OperationExecutor<T>): OperationHandle<T> {
		return this.#startRoot(this.#run.signal, kind, executor)
	}

	// Opens a critical protection root `kind` under the reservation, gated only by the disposal: it may start while
	// a cancelled task still quiesces (stage 1 of the drain), never during the core drain, which closes the tokens.
	startCriticalTask<T>(kind: string, executor: OperationExecutor<T>): OperationHandle<T> {
		return this.#startRoot(this.#dispose.signal, kind, executor)
	}

	// Asks the runner to run `action` at once as a protection (graceful meridian protection): the current startup,
	// pre-capture or capture task is cancelled, the reservation drained and the compensations run, then `action`
	// runs as a run task; afterwards the startup re-executes the interrupted step, the pre-capture re-enters from
	// its first task, a cancelled capture counts as a failure of the slot retried through the pre-capture, and a
	// held session goes back to its hold without changing the desired state. Single-flight: refused (false) while
	// another is pending or running, once a stop was requested, during the shutdown and before the reservation.
	requestProtection(action: SequencerTask) {
		const { state } = this.#runtime

		if (this.#reservation === undefined || this.#protection !== undefined || this.#failing || this.#runtime.stop !== undefined) return false
		if (state !== 'starting' && state !== 'running' && state !== 'paused') return false

		this.#protection = action
		this.#runtime.meridianProtection = 'requested'
		this.#interrupt(true)
		this.#wake?.()

		return true
	}

	// Critical protection (the hard meridian path of section 24.5, the safety one of section 32.4): stage 1 of the drain
	// at once (the current task, a capture included, is cancelled without waiting for it, and a wait of the run is
	// interrupted), then `protect` runs as the critical root `kind`, gated only by the disposal, while the cancelled task
	// still quiesces. Single-flight: a call arriving with one in flight gets its outcome and starts nothing. Until it
	// ends no task, compensation, drain or shutdown step starts; afterwards the interrupted flow goes on (stage 2 of the
	// drain, compensations, re-entry or re-execution of the startup step). A failed outcome applies its action: 'fail',
	// 'stop' (graceful) or 'pause' (a hold at the next safe point, the startup included). Never rejects.
	protectCritically(kind: string, protect: OperationExecutor<SequencerProtectionOutcome>): Promise<SequencerProtectionOutcome> {
		return this.#protectCritically(kind, protect, true)
	}

	// Single-flight critical root of `protectCritically`. A meridian one marks the meridian protection of the runtime
	// and applies the action of a failed outcome; a safety one (the tracking prefix of a session already stopping
	// immediately) only resolves its outcome for the shutdown failures.
	#protectCritically(kind: string, protect: OperationExecutor<SequencerProtectionOutcome>, meridian: boolean): Promise<SequencerProtectionOutcome> {
		if (this.#critical !== undefined) return this.#critical

		// Nothing to protect without the reservation (before the admission, after the release): refused, nothing applied.
		if (this.#reservation === undefined || isTerminalSequencerState(this.#runtime.state)) {
			return Promise.resolve({ ok: false, failure: { kind: 'operation', reason: 'aborted', detail: 'the session holds no reservation' }, action: 'fail' })
		}

		const run = async (): Promise<SequencerProtectionOutcome> => {
			if (meridian) this.#runtime.meridianProtection = 'hard'
			this.#interrupt(true)

			const result = await this.startCriticalTask(kind, protect).result
			const outcome: SequencerProtectionOutcome = result.ok ? result.value : { ok: false, failure: result.error === undefined ? { kind: 'operation', reason: result.reason } : { kind: 'operation', reason: result.reason, detail: result.error }, action: 'fail' }

			if (meridian) {
				this.#runtime.meridianProtection = this.#protection !== undefined ? 'requested' : undefined
				if (!outcome.ok) this.#applyProtectionFailure(outcome)
			}

			return outcome
		}

		const critical = run().finally(() => {
			this.#critical = undefined
		})

		this.#critical = critical
		return critical
	}

	// Persists one more started meridian flip before FLIP_STARTED is applied and the flip commanded (section 34.2): the
	// budget of the flip is durable across processes. When the save fails nothing changes in memory and the failure is
	// returned for the policy of the calling task, which must not command the flip.
	async recordMeridianFlipStart(): Promise<SequencerTaskResult> {
		this.#runtime.meridianFlipAttempts++
		const failure = await this.#saveCheckpoint()
		if (failure === undefined) return { ok: true }
		this.#runtime.meridianFlipAttempts--
		return { ok: false, failure }
	}

	// Forced disposal: aborts the run, the shutdown and the compensations, cancels every root of the reservation and
	// lets the session terminate 'failed' after the release. Idempotent.
	dispose() {
		if (this.#dispose.signal.aborted) return

		this.#disposeSignal?.removeEventListener('abort', this.#onDispose)
		this.#fail({ kind: 'operation', reason: 'aborted', detail: 'disposed' })
		this.#dispose.abort()
		this.#shutdown.abort()
		this.#wake?.()

		if (this.#reservation !== undefined) void this.#services.coordinator.cancelByReservationOwner(this.#owner, 'aborted')
	}

	readonly #onDispose = () => this.dispose()

	// Admission, startup, frame loop, then the terminal pipeline. Never rejects: an unexpected error of the runner
	// itself fails the session like one of a task.
	async #start() {
		if (!(await this.#admit())) {
			await this.#storage.release()
			this.#terminate(this.#failing ? 'failed' : 'stopped')
			return
		}

		this.#emit({ type: 'sessionStarted', configurationId: this.#configuration.id, configurationRevision: this.#configuration.revision })

		// Elapsed-time triggers of a resumed session restart from the persisted wall anchors, once per process.
		for (const { anchor, deltaMs } of bootstrapSequencerElapsedAnchors(this.#runtime, this.#clock.wallNow(), this.#clock.monotonicNow())) {
			this.#emit({ type: 'wallClockAnomaly', anchor, deltaMs })
		}

		try {
			this.#subscribeSafety()

			if (await this.#startup()) {
				if (this.#runtime.state === 'starting') this.#transition('running')
				await this.#frames()
			}
		} catch (error) {
			this.#fail({ kind: 'operation', reason: 'commandFailed', detail: errorMessage(error) })
		}

		await this.#finish()
	}

	// Admission before any physical effect: the lock of the session directory, the resume, then the reservation. A
	// stop or a disposal is honored between the steps. Returns whether the session was reserved; otherwise it ends
	// without shutdown, 'stopped' after a stop and 'failed' with the refusal as its failure.
	async #admit() {
		if (this.#runtime.stop !== undefined || this.#failing) return false

		// The cooperative limits of an analyzer are not optional: an analysis without them could never be aborted.
		if (this.#services.qualityAnalyzer !== undefined && this.#configuration.capture.quality === undefined) return this.#refuse({ kind: 'configuration', detail: 'a quality analyzer requires capture.quality' })

		const locked = await this.#storage.lock()
		if (!locked.ok) return this.#refuse(locked.failure)
		if (this.#runtime.stop !== undefined || this.#failing || !(await this.#resume())) return false
		if (this.#runtime.stop !== undefined || this.#failing) return false

		// What a guiding session or a ditherer leases by itself is never a device the session commands.
		const commanded = sequencerResourceRequests(this.#configuration, this.#devices)
		const adapters = sequencerAdapterResources(this.#configuration, this.#services)
		const keys = new Set(commanded.map((request) => request.key))
		const held = adapters.hold.find((request) => keys.has(request.key))
		if (held !== undefined) return this.#refuse({ kind: 'configuration', detail: `the guiding or the ditherer holds ${held.device?.name ?? held.key}, a device the session commands` })

		const reserved = this.#services.coordinator.arbiter.reserve(this.#owner, [...commanded, ...adapters.reserve])
		if (!reserved.ok) return this.#refuse({ kind: 'operation', reason: 'busy', detail: formatConflicts(reserved.conflicts) })

		this.#reservation = reserved.reservation
		this.#scope = this.#services.coordinator.reservedScope(reserved.reservation)

		// Synchronously after the reservation and before any command: the run admission of the guiding, then the barrier of
		// the pulses a previous process may have dispatched through a pulse mount ditherer.
		if (!this.#beginRun()) {
			await this.#services.coordinator.cancelByReservationOwner(this.#owner, 'aborted')
			this.#reservation.release()
			this.#reservation = undefined
			this.#scope = undefined
			return false
		}

		const { ditherer } = this.#services
		if (this.#configuration.dither !== undefined && ditherer instanceof MountDitherer) ditherer.assumeDispatchedPulses()

		// Step 0b, still without any await since the reservation: the supervision is armed before the first command.
		this.#phases.supervisor?.arm(this.#host)

		return true
	}

	// Begins the guiding run of section 18 step 0a, synchronously and without commanding anything; on success `endRun`
	// is registered for the terminalization. A refusal fails the session ('busy' when another owner holds the pulse
	// admission, 'configuration' otherwise) without any command. Returns whether the run may go on.
	#beginRun() {
		const { guiding } = this.#services
		if (this.#configuration.guiding === undefined || guiding?.beginRun === undefined) return true

		const begun = guiding.beginRun()

		if (!begun.ok) {
			const detail = `the guiding run could not begin${begun.error === undefined ? '' : `: ${begun.error}`}`
			return this.#refuse(begun.reason === 'busy' ? { kind: 'operation', reason: 'busy', detail } : { kind: 'configuration', detail })
		}

		this.#endRun = () => guiding.endRun?.()
		return true
	}

	// Subscribes to the safety source before the first startup task, then records its current state: `subscribe` never
	// replays it, and a change between the two is recorded by the listener first. Active until the terminalization.
	#subscribeSafety() {
		const safety = this.#services.safety
		if (safety === undefined) return
		this.#unsubscribeSafety = safety.subscribe(this.#onSafety)
		recordSequencerSafetyTransition(this.#safetyHistory, this.#clock.monotonicNow(), safety.current().state)
	}

	// Records a safety change at its reception instant, in the monotonic domain, reports it and applies the safety policy.
	readonly #onSafety = (snapshot: SequencerSafetySnapshot) => {
		if (!recordSequencerSafetyTransition(this.#safetyHistory, this.#clock.monotonicNow(), snapshot.state)) return
		this.#emit({ type: 'safetyChanged', snapshot })
		this.#applySafety(snapshot)
	}

	// Policy of a change to a blocking safety state (sections 18 and 32.1), synchronously in the callback of the source.
	// Only recorded before the reservation, once the terminal pipeline began and without a safety policy. Otherwise
	// `shutdownImmediately` stops at once with the critical protection, in any phase; in the startup `onUnsafeAtStartup`
	// 'stop' stops gracefully (the shutdown closes what was opened) and 'wait' cancels an opening in progress, which runs
	// again after its gate; afterwards `stopAfterFrame` stops gracefully (the exposure in flight finishes) and
	// `pauseAfterFrame` needs nothing more: `beforeExposure` refuses every dispatch while blocking and the gate of the
	// next safe point waits until safe.
	#applySafety(snapshot: SequencerSafetySnapshot) {
		const safety = this.#configuration.safety
		if (safety === undefined || !isSequencerSafetyBlocking(snapshot.state, safety.unknownIsUnsafe)) return
		if (this.#reservation === undefined || this.#finishing || this.#runtime.phase === 'shutdown' || isTerminalSequencerState(this.#runtime.state)) return

		const failure: SequencerFailure = { kind: 'safety', detail: snapshot.detail ?? `safety is ${snapshot.state}` }

		if (safety.unsafeAction === 'shutdownImmediately') {
			this.#shutdownForSafety(failure)
		} else if (this.#runtime.phase === 'startup' || this.#runtime.phase === undefined) {
			if (safety.onUnsafeAtStartup === 'stop') this.#safetyStop(failure, 'graceful')
			else if (this.#current?.phase === 'startup' && isSequencerSafetyGated(this.#runtime.task)) this.#interrupt(false)
		} else if (safety.unsafeAction === 'stopAfterFrame') {
			this.#safetyStop(failure, 'graceful')
		}
	}

	// Whether the safety policy forbids an exposure now: the current state of the source is blocking.
	#safetyBlocks() {
		const safety = this.#configuration.safety
		const source = this.#services.safety
		return safety !== undefined && source !== undefined && isSequencerSafetyBlocking(source.current().state, safety.unknownIsUnsafe)
	}

	// Stop forced by safety, with its failure and the cause 'safety' unless another cause came first.
	#safetyStop(failure: SequencerFailure, mode: SequencerStopMode) {
		this.#runtime.failure ??= failure
		this.#stopCause ??= 'safety'
		void this.#requestStop(mode)
	}

	// `shutdownImmediately` (section 32.1), once per session: an immediate stop aborts the run and cancels the current task
	// without waiting for it (stage 1), then the critical protection runs at once while that task still quiesces. Stage 2
	// of the drain, the compensations and the full shutdown wait for the protection.
	#shutdownForSafety(failure: SequencerFailure) {
		if (this.#safetyShutdown) return
		this.#safetyShutdown = true
		this.#safetyStop(failure, 'immediate')

		const protection = this.#protectForSafety().finally(() => {
			if (this.#safetyProtection === protection) this.#safetyProtection = undefined
		})

		this.#safetyProtection = protection
	}

	// Critical protection of safety (section 32.4), with the reservation, the coordinator and the steps of the shutdown:
	// the tracking prefix as the single-flight critical root `sequencer.protect.mountTracking` (absorbed by a hard meridian
	// path in flight), whose failure is a failure of the shutdown, then the free steps.
	async #protectForSafety() {
		const protection = this.#phases.trackingProtection

		if (protection !== undefined) {
			const outcome = await this.#protectCritically(
				'sequencer.protect.mountTracking',
				async (context) => {
					const { failure } = await protection.protect(context, this.#host)
					return successfulOperationResult<SequencerProtectionOutcome>(failure === undefined ? { ok: true } : { ok: false, failure: { kind: 'operation', reason: 'unexpectedState', task: 'stopTracking', detail: `tracking protection failed: ${failure}` }, action: 'stop' })
				},
				false,
			)

			if (!outcome.ok) {
				this.#shutdownFailures.push(outcome.failure)
				this.#shutdownFailed = true
			}
		}

		await this.#protectFreeSteps()
	}

	// The configured shutdown steps after the tracking prefix, in their order, each as the root `sequencer.protect.{step}`
	// with the shutdown signal and `shutdown.stepTimeout`, sequential and best-effort. Right before each step the arbiter
	// is asked whether a living root of the run other than the guiding root leases its device: such a step is deferred,
	// with every later step its interlock ties to it, and nothing is ever acquired from a living root. A step already
	// satisfied is skipped by its predicate; a failure is only reported, since the full shutdown runs every step again
	// after the drain, where satisfied steps are no-ops.
	async #protectFreeSteps() {
		const timeout = this.#configuration.shutdown.stepTimeout * 1000
		const deferred = new Set<SequencerTaskId>()

		for (const step of this.#phases.shutdown) {
			if (step.id === 'pauseGuiding' || step.id === 'stopTracking') continue
			if (this.#shutdown.signal.aborted) return

			if (step.interlock?.some((id) => deferred.has(id)) === true) {
				deferred.add(step.id)
				continue
			}

			if ((await shouldRun(step, this.#view())) !== true) continue

			if (this.#leasedByRun(step)) {
				deferred.add(step.id)
				continue
			}

			const handle = this.#startRoot(this.#shutdown.signal, `sequencer.protect.${step.id}`, (scope) => step.run({ ...this.#view(), scope, signal: scope.signal, reservation: this.#shutdownReservation, emit: this.#emitter, saveCheckpoint: this.#saver }).then(successfulOperationResult))
			const failure = taskFailure(step.id, await this.#bounded(handle, timeout, this.#shutdown.signal))
			if (failure !== undefined) this.#emit({ type: 'taskFailed', task: step.id, phase: 'shutdown', failure })
		}
	}

	// Whether a living root of the run other than the guiding root leases the device of a shutdown step.
	#leasedByRun(step: SequencerShutdownTask) {
		const device = step.device?.(this.#devices)
		if (device === undefined) return false
		const guiding = this.#services.guiding?.operationId?.()
		return this.#services.coordinator.arbiter.ownersOf(resourceKey(device)).some((owner) => owner.id !== guiding)
	}

	// Ends the safety subscription once; a throwing unsubscription is reported and never breaks the terminalization.
	#endSafetySubscription() {
		const unsubscribe = this.#unsubscribeSafety
		this.#unsubscribeSafety = undefined

		try {
			unsubscribe?.()
		} catch (error) {
			console.error('safety unsubscription failed:', this.id, error)
		}
	}

	// Resume of section 34.1: loads the checkpoint of the session, refuses one of another configuration id or revision,
	// reconciles the journal with the disk (reapplying its transactions through the store) and restores the logical
	// state, the slot in progress included. A new session has neither checkpoint nor journal and restores nothing.
	// The physical state is never restored: the first pre-capture reconciles it. Returns whether the session goes on.
	async #resume() {
		const store = this.#services.checkpointStore
		let persisted: SequencerCheckpoint | undefined

		try {
			persisted = await store?.load(this.id)
		} catch (error) {
			return this.#refuse({ kind: 'storage', detail: `checkpoint: ${errorMessage(error)}` })
		}

		const refusal = persisted === undefined ? undefined : this.#incompatibility(persisted)
		if (refusal !== undefined) return this.#refuse(refusal)

		const recovered = await this.#storage.recover(persisted, async (checkpoint) => {
			await store?.save(checkpoint)
		})

		if (!recovered.ok) return this.#refuse(recovered.failure)
		for (const warning of recovered.value.warnings) console.warn('sequencer storage recovery:', this.id, warning)

		const { checkpoint } = recovered.value
		if (checkpoint === undefined) return true

		const incompatible = this.#incompatibility(checkpoint)
		if (incompatible !== undefined) return this.#refuse(incompatible)

		applySequencerCheckpoint(this.#runtime, this.#configuration, checkpoint)
		this.#runtime.meridianFlip = createMeridianFlipState(checkpoint.meridianFlipAttempts)
		// A restart is a resume for the autofocus trigger of that name.
		this.#runtime.resumedSinceAutofocus = true
		this.#sequence = checkpoint.sequence

		const slot = checkpoint.currentSlot
		if (slot === undefined) return true

		const frame = restoreSequencerFrameSlot(this.#configuration.capture, this.#runtime.scheduler, slot)
		if (frame === undefined) return this.#refuse({ kind: 'configuration', detail: `slot ${slot.id} of the checkpoint is not in the configuration` })

		this.#runtime.currentFrame = frame
		this.#consumed = false
		return true
	}

	// Why a checkpoint cannot resume this session: another session, or another configuration id or revision.
	#incompatibility(checkpoint: SequencerCheckpoint): SequencerFailure | undefined {
		const { id, revision } = this.#configuration
		if (checkpoint.sessionId !== this.id) return { kind: 'storage', detail: `checkpoint of session ${checkpoint.sessionId} in session ${this.id}` }
		if (checkpoint.configurationId === id && checkpoint.configurationRevision === revision) return undefined
		return { kind: 'configuration', detail: `checkpoint of configuration ${checkpoint.configurationId} revision ${checkpoint.configurationRevision} cannot resume configuration ${id} revision ${revision}` }
	}

	// Records a refused admission as the failure of the session; always false.
	#refuse(failure: SequencerFailure) {
		this.#fail(failure)
		return false
	}

	// Startup tasks in order. A protection, a pause or an unsafe change re-executes the interrupted step from its beginning,
	// an opening from its safety gate; any stop or failure ends the startup without frames. Returns whether the frame loop
	// runs.
	async #startup() {
		this.#setPhase('startup')
		const { retry, onFailure } = this.#configuration.startup
		const policy: SequencerTaskPolicy = retry === undefined ? { onFailure } : { retry, onFailure }
		const tasks = this.#phases.startup

		for (let i = 0; i < tasks.length;) {
			if (this.#runtime.stop !== undefined || this.#failing) return false

			if (this.#protection !== undefined) {
				await this.#serveProtection('startup', false)
				continue
			}

			if (this.#policyHold) {
				if (!(await this.#hold('policy'))) return false
				continue
			}

			const outcome = await this.#runTask(tasks[i], 'startup', tasks[i].policy ?? policy)

			if (outcome.kind === 'done') i++
			else if (outcome.kind === 'failed') {
				const next = await this.#applyFailure(outcome)
				if (next === 'end') return false
				if (next === 'skip') i++
			} else {
				// An interrupted opening runs again from its safety gate, never past it.
				if (i > 0 && tasks[i - 1].id === 'safetyGate') i--
				await this.#quiesce()
			}
		}

		return !(this.#runtime.stop !== undefined || this.#failing)
	}

	// Frame loop: at each safe point serve a protection, wait a retry delay, hold a pause, then select the next slot
	// and run its pre-capture, capture and post-capture. A graceful stop keeps selecting only the session-end
	// groups with `onStop`; an immediate stop or a failure ends the loop.
	async #frames() {
		await this.#reapplyExhaustedCapture()
		this.#reapplyExhaustedDiscards()

		while (true) {
			if (this.#runtime.stop === 'immediate' || this.#failing || this.#framesEnded) return

			if (this.#protection !== undefined) {
				await this.#serveProtection('preCapture', false)
				continue
			}

			const delay = this.#retryDelay
			this.#retryDelay = 0

			// A slot is never retried after a stop, so its delay is not waited either.
			if (delay > 0 && this.#runtime.stop === undefined) {
				await this.#wait(delay)
				continue
			}

			const cause = this.#pendingHold()

			if (cause !== undefined) {
				// A stopping session never pauses: a slot held by its capture policy ends the frames instead.
				if (this.#runtime.stop !== undefined) return
				await this.#hold(cause)
				continue
			}

			const previous = this.#runtime.currentFrame
			const frame = this.#select()
			if (frame === undefined) return

			this.#runtime.currentFrame = frame
			this.#consumed = false
			if (frame.id !== previous?.id) this.#reentries = 0

			// A new slot changed the scheduler state: it is persisted, with the slot in progress, before anything is
			// prepared for it, so a restart selects exactly the same slot.
			if (frame.id !== previous?.id && !(await this.#persist())) return

			this.#emit({ type: 'frameSelected', frame: sequencerFrameSlotSnapshot(frame) })

			if (await this.#preCapture(frame)) {
				await this.#postCapture(frame, await this.#capture(frame))
			} else if (this.#runtime.stop !== undefined && this.#isOnStopFrame(frame)) {
				// A stop never abandons a session-end frame it still selects, so only a failure action ended it, and
				// selecting it again would repeat that failure without bound.
				this.#framesEnded = true
			}
		}
	}

	// Safe-point barrier of one frame: its tasks in order, re-entered from the first one after a protection, an
	// interruption or a pause, without consuming an attempt. An attempt prepared by the storage and not dispatched is
	// closed by `deferred` before any wait, re-entry or exit. Returns whether the frame may be exposed.
	async #preCapture(frame: SequencerFrameSlot) {
		const tasks = this.#phases.preCapture

		reentry: while (true) {
			this.#setPhase('preCapture')
			this.#phases.supervisor?.safePoint()

			for (let i = 0; i <= tasks.length; i++) {
				if (this.#abandons(frame)) {
					await this.#defer('stop')
					return false
				}

				if (this.#protection !== undefined) {
					await this.#defer('meridian')
					await this.#serveProtection('preCapture', false)
					continue reentry
				}

				if (shouldHoldSequencer(this.#runtime)) {
					await this.#defer('pause')
					await this.#hold('user')
					continue reentry
				}

				if (i === tasks.length) return true

				const outcome = await this.#runTask(tasks[i], 'preCapture', tasks[i].policy ?? FAIL_POLICY, frame)

				if (outcome.kind === 'interrupted') {
					await this.#defer(this.#protecting() ? 'meridian' : 'stop')
					await this.#quiesce()
					continue reentry
				}

				if (outcome.kind === 'done' && outcome.reenter !== undefined) {
					// The guard refused the frame: the attempt is closed before waiting, and the safe point starts over.
					await this.#defer('guard')
					if (this.#failing || !this.#countReentry(tasks[i].id, outcome.reenter.reason)) return false
					const { wait } = outcome.reenter
					if (wait !== undefined && !this.#abandons(frame)) await this.#wait(wait, true)
					continue reentry
				}

				if (outcome.kind === 'failed') {
					// Skipping goes on to the next task; every other action leaves the safe point.
					if (outcome.action !== 'skip') await this.#defer(outcome.action === 'pause' ? 'pause' : 'stop')
					const next = await this.#applyFailure(outcome)
					if (next === 'end') return false
					if (next === 'retry') continue reentry
				}
			}
		}
	}

	// Exposure of the frame in its root, into the temporary of the attempt the pre-capture prepared. The capture asks
	// `beforeExposure` right before dispatching, which refuses while a stop, a pause or a protection is pending or safety
	// blocks (deferred 'safety'); only an approved exposure counts as a commanded attempt. A stop lets an approved exposure
	// finish unless immediate; a protection cancels it.
	async #capture(frame: SequencerFrameSlot): Promise<CaptureOutcome> {
		await this.#awaitCritical()
		if (this.#abandons(frame) || this.#run.signal.aborted) return { kind: 'deferred', reason: 'stop' }

		const destination = this.#storage.prepared

		if (destination === undefined || destination.slot !== frame.id || destination.attempt !== frame.attempt) {
			this.#fail({ kind: 'storage', detail: `no destination was prepared for ${frame.id}#${frame.attempt}` })
			return { kind: 'interrupted' }
		}

		this.#setPhase('capture')
		this.#dispatched = undefined
		let decision: 'approved' | 'refused' | undefined
		// Whether the refusal came from the exposure guard, which counts as a re-entry without progress.
		let guarded = false
		// Why a refused attempt is deferred: safety, or any other refusal of `beforeExposure`.
		let deferral: SequencerDeferReason = 'beforeExposure'

		const beforeExposure = () => {
			if (decision !== undefined) return decision === 'approved' ? undefined : failedOperationResult('aborted', 'the exposure was already refused')
			const refusal = this.#exposureRefusal(frame)

			if (refusal === undefined) {
				// Never exposed while blocking: the pre-capture re-enters and its safety gate waits until safe.
				if (this.#safetyBlocks()) {
					decision = 'refused'
					deferral = 'safety'
					return failedOperationResult('aborted', 'safety forbids the exposure')
				}

				const guard = this.#phases.exposureRefusal?.(this.#view(frame))

				if (guard === undefined) {
					decision = 'approved'
					this.#dispatched = destination
					this.#reentries = 0
					return undefined
				}

				guarded = true
				decision = 'refused'
				return failedOperationResult('aborted', guard)
			}

			decision = 'refused'
			return failedOperationResult('aborted', refusal)
		}

		const exposureStarted = () => {
			if (decision === 'approved') this.#emit({ type: 'exposureStarted', slot: frame.id, attempt: frame.attempt })
		}

		const view = this.#view(frame)
		const handle = this.#startTracked('captureFrame', () => this.startTask('sequencer.captureFrame', (scope) => this.#phases.capture({ ...view, scope, signal: scope.signal, reservation: this.#runReservation, emit: this.#emitter, saveCheckpoint: this.#saver, destination, beforeExposure, exposureStarted })))
		const current = this.#begin(handle, 'capture', 'captureFrame')
		const result = await handle.result
		this.#end()

		if (result.ok) {
			this.#emit({ type: 'taskCompleted', task: 'captureFrame', phase: 'capture' })
			return { kind: 'captured', frame: result.value }
		}

		const failure = operationFailure('captureFrame', result)
		this.#emit({ type: 'taskFailed', task: 'captureFrame', phase: 'capture', failure })

		if (decision === 'refused') {
			// A refusal of the guard is a re-entry without progress; past the limit the session fails.
			if (guarded) this.#countReentry('finalExposureGuard', failure.kind === 'operation' ? (failure.detail ?? failure.reason) : failure.kind)
			return { kind: 'deferred', reason: deferral }
		}

		const cancelled = current.interrupted || this.#run.signal.aborted
		const protection = current.interrupted && this.#protecting() && !this.#run.signal.aborted

		if (decision === undefined) {
			if (protection) return { kind: 'deferred', reason: 'meridian' }
			if (cancelled) return { kind: 'deferred', reason: 'stop' }
			return { kind: 'undispatched', failure }
		}

		if (cancelled && !protection) return { kind: 'interrupted' }
		return { kind: 'failed', failure, protection }
	}

	// Why the exposure of `frame` must not be dispatched now, or undefined when it may: a stop that abandons it, a
	// pending protection or a pending pause. Synchronous: it reads only the session state.
	#exposureRefusal(frame: SequencerFrameSlot) {
		if (this.#abandons(frame) || this.#run.signal.aborted) return 'a stop was requested'
		if (this.#protecting()) return 'a meridian protection is pending'
		if (this.#policyHold) return 'a protection failure holds the session'
		if (shouldHoldSequencer(this.#runtime)) return 'a pause was requested'
		return undefined
	}

	// Post-capture: records the outcome of the attempt, never commands a device. A captured frame whose temporary
	// holds data is analyzed, classified and decided in one transaction (section 26). A failed capture keeps the slot
	// current with one more failure, persisted before its `abandoned` line: retried through the pre-capture while its
	// reason is retryable (a protection always is) and the budget lasts, otherwise the capture failure policy applies.
	// An interrupted capture is closed without counting anything; one that commanded nothing is deferred, and when it
	// failed by itself (camera unavailable) the capture policy applies without consuming the attempt.
	async #postCapture(frame: SequencerFrameSlot, outcome: CaptureOutcome) {
		if (outcome.kind === 'interrupted') {
			const abandoned = await this.#storage.abandon('interrupted')
			if (!abandoned.ok) this.#fail(abandoned.failure)
			return
		}

		if (outcome.kind === 'deferred') {
			await this.#defer(outcome.reason)
			return
		}

		if (outcome.kind === 'undispatched') {
			await this.#undispatched(frame, outcome.failure)
			return
		}

		this.#setPhase('postCapture')

		if (outcome.kind === 'captured') {
			const written = await this.#storage.verify()

			if (written.ok) {
				await this.#complete(frame, outcome.frame)
				return
			}

			outcome = { kind: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'captureFrame', detail: written.failure.detail }, protection: false }
		}

		const runtime = this.#runtime
		const { retry, onFailure } = this.#configuration.capture
		const { failure } = outcome
		const captureFailures = frame.captureFailures + 1
		runtime.currentFrame = { ...frame, captureFailures }
		this.#consumed = true

		const retryable = outcome.protection || (failure.kind === 'operation' && failure.reason !== 'aborted' && retry.retryOn.includes(failure.reason))
		const retried = retryable && captureFailures < retry.maxAttempts

		if (!retried && onFailure === 'skipFrame') {
			const progress = runtime.capture.get(frame.groupId)
			if (progress !== undefined) progress.skipped++
			runtime.currentFrame = undefined
		}

		// The failure is durable before the attempt is closed: a crash in between is counted once by the recovery.
		if (!(await this.#persist())) return

		const abandoned = await this.#storage.abandon('failed')

		if (!abandoned.ok) {
			this.#fail(abandoned.failure)
			return
		}

		if (retried) {
			if (!outcome.protection) this.#retryDelay = sequencerRetryDelay(retry, captureFailures)
			return
		}

		switch (onFailure) {
			case 'fail':
				this.#fail(failure)
				return
			case 'stop':
				this.#policyStop(failure)
				return
			case 'pause':
				this.#capturePause = true
				return
			case 'skipFrame':
				this.#emit({ type: 'slotSkipped', slot: frame.id, reason: 'captureFailures' })
		}
	}

	// A capture that failed before anything was commanded (camera unavailable, disconnected or removed): the attempt
	// is closed by `deferred` and the capture policy applies at once, consuming neither the attempt nor a capture
	// failure, since only commanded exposures count (section 25.2) and nothing would bound a retry of it. 'pause'
	// holds and, after `resume()`, prepares the same attempt again, which re-evaluates the availability.
	async #undispatched(frame: SequencerFrameSlot, failure: SequencerFailure) {
		const { onFailure } = this.#configuration.capture
		await this.#defer(onFailure === 'pause' ? 'pause' : 'stop')
		if (this.#failing) return

		switch (onFailure) {
			case 'fail':
				this.#fail(failure)
				return
			case 'stop':
				this.#policyStop(failure)
				return
			case 'pause':
				await this.#hold('policy')
				return
			case 'skipFrame': {
				const progress = this.#runtime.capture.get(frame.groupId)
				if (progress !== undefined) progress.skipped++
				this.#runtime.currentFrame = undefined
				if (await this.#persist()) this.#emit({ type: 'slotSkipped', slot: frame.id, reason: 'captureFailures' })
			}
		}
	}

	// Completes a captured frame as one logical transaction (sections 8.3 and 26): the quality analysis of its durable
	// temporary, the classification, then the definitive decision, before the file is touched. The next checkpoint
	// (progress of the group, light exposures, discard counters of a slot that stays current with its attempt consumed,
	// consecutive discards, corrective intents, and the calibration batches the light triggers of a scheduled light
	// enqueued, accepted or discarded alike, section 8A.2) is computed without being applied and journaled, with the
	// measured sensor temperature, with the promotion ('accepted', 'forced') or the disposition (every other decision);
	// only then the state is applied, the checkpoint saved, the events emitted and the session action of the decision
	// applied. A stopping session fires no trigger: its batches would never run. A pause is not applied here: it is
	// derived from the exhausted counter at the next safe point.
	async #complete(frame: SequencerFrameSlot, captured: SequencerCapturedFrame) {
		const quality = await this.#analyze(frame, captured)
		const policy = this.#groupOf(frame)?.discard
		const classification = classifySequencerFrame(policy?.criteria, this.#evidence(frame, captured, quality))
		const decision: SequencerFrameDecision = policy === undefined || classification.reasons.length === 0 ? 'accepted' : decideFrameOutcome(policy, frame, this.#runtime.consecutiveDiscards, this.#abandons(frame))
		const promoted = decision === 'accepted' || decision === 'forced'
		// A discarded frame keeps its slot current, except a skipped one; its attempt is consumed by the retake.
		const slot: SequencerFrameSlot | undefined = promoted || decision === 'skipSlot' ? undefined : { ...frame, discardedTotal: frame.discardedTotal + 1, discardBudgetUsed: frame.discardBudgetUsed + 1, captureFailures: 0 }

		const base = this.#checkpoint(this.#sequence + 1, undefined)
		const counters = base.capture[frame.groupId]
		const intents = { ...base.intents }
		if (quality.kind === 'analyzed' && quality.result.intents !== undefined) applyCorrectiveIntents(intents, quality.result.intents)

		const light = frame.capture.frameType === 'LIGHT'
		// Discarded lights count too: drift, focus and dither depend on time and motion, not on quality.
		const anchors = light ? { ...base.anchors, lightExposures: base.anchors.lightExposures + 1 } : base.anchors
		const triggers: SequencerTriggerEvent[] = []
		// The checkpoint holds deep copies, so the triggers mutate only the transaction.
		if (light && frame.kind === 'scheduled' && this.#runtime.stop === undefined) fireCalibrationTriggers(this.#configuration.capture, base.scheduler, this.#runtime.capture, anchors, frame, captured.sensorTemperature, triggers)

		const next: SequencerCheckpoint = {
			...base,
			// A computed key defines an own property, so any group id (even `__proto__`) is a plain key.
			capture:
				counters === undefined
					? base.capture
					: { ...base.capture, [frame.groupId]: { accepted: counters.accepted + (decision === 'accepted' ? 1 : 0), forced: counters.forced + (decision === 'forced' ? 1 : 0), discarded: counters.discarded + (promoted ? 0 : 1), skipped: counters.skipped + (decision === 'skipSlot' ? 1 : 0) } },
			anchors,
			intents,
			consecutiveDiscards: promoted ? 0 : base.consecutiveDiscards + 1,
			...(slot !== undefined && { currentSlot: { id: slot.id, attempt: slot.attempt + 1, discardedTotal: slot.discardedTotal, discardBudgetUsed: slot.discardBudgetUsed, captureFailures: 0 } }),
		}

		if (decision === 'accepted' || decision === 'forced' || policy === undefined) {
			const promotion = await this.#storage.promote(next, decision === 'forced', captured.sensorTemperature)

			if (!promotion.ok) {
				this.#fail(promotion.failure)
				return
			}

			await this.#commit(frame, captured, quality, next, slot, triggers)
			this.#emit({ type: 'frameAccepted', slot: frame.id, attempt: frame.attempt, path: promotion.value, forced: decision === 'forced' })
			return
		}

		const disposition = await this.#storage.dispose(policy.artifact, next, captured.sensorTemperature)

		if (!disposition.ok) {
			this.#fail(disposition.failure)
			return
		}

		await this.#commit(frame, captured, quality, next, slot, triggers)
		this.#discarded(frame, policy, classification, decision, next.consecutiveDiscards)
	}

	// Applies a frame transaction whose file was already promoted or disposed of, saves its checkpoint and reports the
	// captured frame, then the trigger events of the batches the transaction enqueued. `slot` is the slot that stays
	// current, its attempt consumed, or undefined when the slot is done.
	async #commit(frame: SequencerFrameSlot, captured: SequencerCapturedFrame, quality: SequencerQualityOutcome, next: SequencerCheckpoint, slot: SequencerFrameSlot | undefined, triggers: readonly SequencerTriggerEvent[]) {
		applySequencerCheckpoint(this.#runtime, this.#configuration, next)
		this.#runtime.currentFrame = slot
		this.#consumed = slot !== undefined
		// The transaction is durable in the journal even when this save fails; the recovery reapplies it.
		await this.#persist(next)
		const { exposureStartedAt, exposureFinishedAt } = captured
		this.#emit({ type: 'frameCaptured', slot: frame.id, attempt: frame.attempt, exposureStartedAt, exposureFinishedAt, quality })
		for (const event of triggers) this.#emit(event)
	}

	// Reports a discarded frame and applies the session action of its decision: a skipped slot is reported, 'stop' and
	// 'fail' end the session with a 'quality' failure; 'retake', 'pause' (derived at the next safe point) and
	// 'discardFinal' need nothing more. `consecutiveDiscards` is the count after this discard.
	#discarded(frame: SequencerFrameSlot, policy: SequencerFrameDiscardPolicy, classification: SequencerFrameClassification, decision: Exclude<SequencerFrameDecision, 'accepted' | 'forced'>, consecutiveDiscards: number) {
		const { reasons, truncated, detail } = classification
		const remainingDiscards = Math.max(0, policy.maxDiscardsPerSlot - (frame.discardBudgetUsed + 1))
		this.#emit({ type: 'frameDiscarded', slot: frame.id, attempt: frame.attempt, reasons, truncated, decision, remainingDiscards, ...(detail !== undefined && { detail }) })

		const circuit = policy.maxConsecutiveDiscards !== undefined && consecutiveDiscards > policy.maxConsecutiveDiscards
		const failure: SequencerFailure = { kind: 'quality', detail: `${frame.id}#${frame.attempt} was discarded (${reasons.join(', ')}) past ${circuit ? 'the consecutive discards' : 'the discards of its slot'} allowed` }

		switch (decision) {
			case 'skipSlot':
				this.#emit({ type: 'slotSkipped', slot: frame.id, reason: 'discardBudget' })
				return
			case 'stop':
				this.#policyStop(failure)
				return
			case 'fail':
				this.#fail(failure)
		}
	}

	// Quality analysis of the durable temporary of the attempt (section 33): the caller's analyzer receives only its path,
	// after the durable writer resolved and the capture produced its result, outside any lease of the camera, with a
	// signal aborted by `capture.quality.timeout` or by the run (an immediate stop, a failure). The analysis is awaited to
	// its end in every case, so the file never moves while it may still be read; `abortGrace` only reports an analyzer
	// still running then (`collaboratorUnresponsive`, the snapshot `waitingFor`), which is faulted and never called again
	// once that late analysis ended. Without analyzer the outcome is 'skipped', without any wait. Never rejects.
	async #analyze(frame: SequencerFrameSlot, captured: SequencerCapturedFrame): Promise<SequencerQualityOutcome> {
		const analyzer = this.#services.qualityAnalyzer
		const limits = this.#configuration.capture.quality
		const path = this.#storage.prepared?.temporary
		if (analyzer === undefined || limits === undefined || path === undefined) return SKIPPED_QUALITY

		const { exposureStartedAt, exposureFinishedAt } = captured
		const qualityFrame = { slot: frame, path, exposureStartedAt, exposureFinishedAt }
		const health = {
			faulted: this.#qualityFaulted,
			onUnresponsive: () => {
				this.#runtime.waitingFor = 'qualityAnalyzer'
				this.#emit({ type: 'collaboratorUnresponsive', service: 'quality', slot: frame.id, attempt: frame.attempt })
			},
			onFaulted: () => {
				this.#qualityFaulted = true
				if (this.#runtime.waitingFor === 'qualityAnalyzer') this.#runtime.waitingFor = undefined
				this.#emit({ type: 'qualityAnalyzerFaulted' })
			},
		}

		const abortGrace = (limits.abortGrace ?? DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE) * 1000
		const job = await awaitCooperativeJob((signal) => analyzer(qualityFrame, signal), { signal: this.#run.signal, timeout: limits.timeout * 1000, abortGrace, delay: this.#clock.delay, health })

		switch (job.kind) {
			case 'resolved':
				return qualityOutcomeOf(job.value)
			case 'rejected':
				return { kind: 'error', detail: errorMessage(job.error) }
			case 'timeout':
				this.#emit({ type: 'qualityTimeout', slot: frame.id, attempt: frame.attempt })
				return { kind: 'timeout' }
			case 'aborted':
				return { kind: 'aborted' }
			case 'faulted':
				return { kind: 'error', detail: 'the quality analyzer is faulted' }
		}
	}

	// Evidence the classification of a completed exposure reads: the quality classification, and for a light the guiding
	// interruptions and the safety verdict of its monotonic window [dispatch, end], each queried only when its criterion
	// is enabled. A frame is guided when it is a light of a session with guiding.
	#evidence(frame: SequencerFrameSlot, captured: SequencerCapturedFrame, quality: SequencerQualityOutcome): SequencerFrameEvidence {
		const { frameType } = frame.capture
		const guiding = this.#configuration.guiding === undefined ? undefined : this.#services.guiding
		const from = captured.exposureDispatchedMonotonic
		const evidence: SequencerFrameEvidence = { frameType, quality: quality.kind === 'analyzed' ? quality.result.classification : 'unknown', dispatched: from !== undefined, guided: guiding !== undefined && frameType === 'LIGHT' }
		const criteria = this.#groupOf(frame)?.discard?.criteria
		if (criteria === undefined || from === undefined || frameType !== 'LIGHT') return evidence

		const to = captured.exposureFinishedMonotonic
		const interruptions = criteria.guidingInterruption && guiding !== undefined ? guiding.interruptions(from, to) : undefined
		const safety = criteria.unsafeDuringExposure ? safetyUnsafeWithin({ transitions: this.#safetyHistory }, from, to, this.#configuration.safety?.unknownIsUnsafe ?? false) : undefined
		return { ...evidence, ...(interruptions !== undefined && { guiding: { interrupted: interruptions.interruptions.length > 0, truncated: interruptions.truncated } }), ...(safety !== undefined && { safety }) }
	}

	// Configured group of a slot.
	#groupOf(frame: SequencerFrameSlot): SequencerFrameGroup | undefined {
		return this.#configuration.capture.groups.find((group) => group.id === frame.groupId)
	}

	// Closes the open attempt of the storage as not dispatched, before a wait, a re-entry or an exit of the
	// pre-capture; nothing to do when no attempt is open or it was dispatched. A journal failure fails the session.
	async #defer(reason: SequencerDeferReason) {
		const prepared = this.#storage.prepared
		if (prepared === undefined || prepared === this.#dispatched) return
		const deferred = await this.#storage.defer(reason)
		if (!deferred.ok) this.#fail(deferred.failure)
	}

	// Checkpoint of the current state with `sequence`: the current slot persists the attempt it has not consumed yet.
	#checkpoint(sequence: number, slot: SequencerFrameSlot | undefined): SequencerCheckpoint {
		const current: SequencerCheckpointSlot | undefined = slot === undefined ? undefined : { id: slot.id, attempt: this.#consumed ? slot.attempt + 1 : slot.attempt, discardedTotal: slot.discardedTotal, discardBudgetUsed: slot.discardBudgetUsed, captureFailures: slot.captureFailures }
		return sequencerCheckpointOf(this.id, this.#configuration, this.#runtime, current, sequence, this.#clock.wallNow())
	}

	// Saves `checkpoint` (default the current state with the next sequence) and returns the failure, if any. The
	// sequence advances even without a store, so journal transactions stay ordered.
	async #saveCheckpoint(checkpoint: SequencerCheckpoint = this.#checkpoint(this.#sequence + 1, this.#runtime.currentFrame)): Promise<SequencerFailure | undefined> {
		const store = this.#services.checkpointStore

		if (store !== undefined) {
			try {
				await store.save(checkpoint)
			} catch (error) {
				return { kind: 'storage', detail: `checkpoint ${checkpoint.sequence}: ${errorMessage(error)}` }
			}
		}

		this.#sequence = checkpoint.sequence
		if (store !== undefined) this.#emit({ type: 'checkpointSaved', sequence: checkpoint.sequence })
		return undefined
	}

	// Saves a checkpoint and fails the session when it could not; returns whether it was saved.
	async #persist(checkpoint?: SequencerCheckpoint) {
		const failure = await this.#saveCheckpoint(checkpoint)
		if (failure === undefined) return true
		this.#fail(failure)
		return false
	}

	// Terminal pipeline: quiesce what is left of the run, close an attempt still prepared, shut down with the shutdown
	// signal, cancel every root of the reservation and await its cleanups, release the reservation and the lock, then
	// terminalize. Always releases.
	async #finish() {
		this.#finishing = true

		try {
			await this.#quiesce()
			await this.#defer('stop')
			this.#protection = undefined
			this.#runtime.meridianProtection = undefined
			this.#transition('shuttingDown')
			this.#setPhase('shutdown')
			this.#emit({ type: 'shutdownStarted' })
			await this.#shutdownSteps()
		} catch (error) {
			this.#shutdownFailures.push({ kind: 'operation', reason: 'commandFailed', detail: errorMessage(error) })
			this.#shutdownFailed = true
		} finally {
			this.#phases.supervisor?.disarm()
			await this.#services.coordinator.cancelByReservationOwner(this.#owner, 'aborted')
			this.#endGuidingRun()
			this.#endSafetySubscription()
			this.#reservation?.release()
			await this.#storage.release()
			this.#terminate(this.#failing || this.#shutdownFailed ? 'failed' : this.#runtime.stop !== undefined ? 'stopped' : 'completed')
		}
	}

	// Ends the guiding run exactly once, after the shutdown and the terminal drain and before the release.
	#endGuidingRun() {
		const endRun = this.#endRun
		this.#endRun = undefined

		try {
			endRun?.()
		} catch (error) {
			console.error('guiding endRun failed:', this.id, error)
		}
	}

	// Shutdown steps in order with the shutdown signal, accumulating failures. Each step is bounded by
	// `stepTimeout` and by what is left of `totalTimeout`, except the pause-guiding → stop-tracking prefix, which
	// bounds itself and is never cut; an exhausted total is reported once and no later step starts.
	async #shutdownSteps() {
		const { stepTimeout, totalTimeout } = this.#configuration.shutdown
		const deadline = this.#clock.monotonicNow() + totalTimeout * 1000

		for (const step of this.#phases.shutdown) {
			// A critical protection in flight is the tracking prefix already running: it is awaited, never duplicated.
			await this.#awaitCritical()

			if (this.#shutdown.signal.aborted) {
				this.#shutdownFailures.push({ kind: 'operation', reason: 'aborted', task: step.id, detail: 'disposed' })
				this.#shutdownFailed = true
				return
			}

			const prefix = step.id === 'pauseGuiding' || step.id === 'stopTracking'
			const remaining = deadline - this.#clock.monotonicNow()

			if (!prefix && !(remaining > 0)) {
				this.#shutdownFailures.push({ kind: 'operation', reason: 'timeout', detail: 'shutdown total timeout' })
				this.#shutdownFailed = true
				return
			}

			const due = await shouldRun(step, this.#view())

			if (due !== true) {
				if (due === false) continue
				this.#emit({ type: 'taskFailed', task: step.id, phase: 'shutdown', failure: due })
				this.#shutdownFailures.push(due)
				if (step.policy === 'required') this.#shutdownFailed = true
				continue
			}

			const handle = this.#startTracked(step.id, () => this.#startRoot(this.#shutdown.signal, `sequencer.${step.id}`, (scope) => step.run({ ...this.#view(), scope, signal: scope.signal, reservation: this.#shutdownReservation, emit: this.#emitter, saveCheckpoint: this.#saver }).then(successfulOperationResult)))
			this.#runtime.task = step.id
			this.#emit({ type: 'taskStarted', task: step.id, phase: 'shutdown' })
			const result = await this.#bounded(handle, prefix ? undefined : Math.min(stepTimeout * 1000, remaining), this.#shutdown.signal)
			this.#runtime.task = undefined
			const failure = taskFailure(step.id, result)

			if (failure === undefined) {
				this.#emit({ type: 'taskCompleted', task: step.id, phase: 'shutdown' })
				continue
			}

			this.#emit({ type: 'taskFailed', task: step.id, phase: 'shutdown', failure })
			this.#shutdownFailures.push(failure)
			if (step.policy === 'required') this.#shutdownFailed = true
		}
	}

	// Runs one startup or pre-capture task with its retries. Retries never follow an interruption, a non-operation
	// failure or an `aborted` reason; they run the compensations the failed execution left pending, then wait
	// `sequencerRetryDelay` on the run signal.
	async #runTask(task: SequencerTask, phase: SequencerPhase, policy: SequencerTaskPolicy, frame?: SequencerFrameSlot): Promise<TaskOutcome> {
		const view = this.#view(frame)
		const due = await shouldRun(task, view)

		if (due !== true) {
			if (due === false) return DONE
			this.#emit({ type: 'taskFailed', task: task.id, phase, failure: due })
			return { kind: 'failed', failure: due, action: policy.onFailure }
		}

		for (let attempt = 1; ; attempt++) {
			// No task starts while a critical protection runs: nothing else may command before its tracking off. A
			// protection whose failure action decided the flow meanwhile (a stop, a failure, a hold) leaves the task
			// unstarted, so the phase honours that action first.
			const critical = this.#critical !== undefined
			const stop = this.#runtime.stop
			const holding = shouldHoldSequencer(this.#runtime)
			await this.#awaitCritical()
			if (this.#run.signal.aborted) return INTERRUPTED
			if (critical && (this.#runtime.stop !== stop || this.#failing || (!holding && shouldHoldSequencer(this.#runtime)))) return INTERRUPTED
			const handle = this.#startTracked(task.id, () => this.startTask(`sequencer.${task.id}`, (scope) => task.run({ ...view, scope, signal: scope.signal, reservation: this.#runReservation, emit: this.#emitter, saveCheckpoint: this.#saver }).then(successfulOperationResult)))
			const current = this.#begin(handle, phase, task.id)
			const result = await handle.result
			this.#end()

			const failure = taskFailure(task.id, result)

			if (failure === undefined) {
				this.#emit({ type: 'taskCompleted', task: task.id, phase })
				const reenter = result.ok && result.value.ok ? result.value.reenter : undefined
				return reenter === undefined ? DONE : { kind: 'done', reenter }
			}

			this.#emit({ type: 'taskFailed', task: task.id, phase, failure })

			if (current.interrupted || this.#run.signal.aborted) return INTERRUPTED

			const { retry, onFailure } = policy

			if (retry === undefined || attempt >= retry.maxAttempts || failure.kind !== 'operation' || failure.reason === 'aborted' || !retry.retryOn.includes(failure.reason)) {
				// A fatal failure is never skipped: the safe point cannot expose from the state it left.
				const fatal = result.ok && !result.value.ok && result.value.fatal === true
				return { kind: 'failed', failure, action: fatal && onFailure === 'skip' ? 'fail' : onFailure }
			}

			// What the failed execution left to undo is undone before the retry starts from a known state.
			await this.#quiesce()
			if (!(await this.#wait(sequencerRetryDelay(retry, attempt)))) return INTERRUPTED
		}
	}

	// Applies the action of a failed task after quiescing what it left behind.
	async #applyFailure(outcome: Extract<TaskOutcome, { readonly kind: 'failed' }>): Promise<FailureContinuation> {
		await this.#quiesce()

		switch (outcome.action) {
			case 'skip':
				return 'skip'
			case 'fail':
				this.#fail(outcome.failure)
				return 'end'
			case 'stop':
				this.#policyStop(outcome.failure)
				return 'end'
			case 'pause':
				return (await this.#hold('policy')) ? 'retry' : 'end'
		}
	}

	// Runs the pending protection action after quiescing the interrupted work. In the hold, a failure action 'pause'
	// keeps holding. Clears the request whatever the outcome.
	async #serveProtection(phase: Extract<SequencerPhase, 'startup' | 'preCapture'>, holding: boolean) {
		await this.#quiesce()
		const action = this.#protection
		if (action === undefined) return

		this.#runtime.meridianProtection = 'running'
		this.#setPhase(phase)
		const outcome = await this.#runTask(action, phase, action.policy ?? FAIL_POLICY, phase === 'startup' ? undefined : this.#runtime.currentFrame)
		this.#protection = undefined
		this.#runtime.meridianProtection = undefined

		if (outcome.kind === 'interrupted') await this.#quiesce()
		else if (outcome.kind === 'failed' && !(holding && outcome.action === 'pause')) await this.#applyFailure(outcome)
	}

	// Holds the session in 'paused' after quiescing and compensating, until a resume, a stop, a failure or a
	// protection request; a protection runs as a task and the hold continues. The reservation stays. Returns whether
	// the session resumed (then 'running', with the capture budget renewed after a capture-policy pause).
	async #hold(cause: HoldCause) {
		this.#policyHold = false
		await this.#quiesce()
		if (this.#runtime.stop !== undefined || this.#failing) return false

		requestSequencerHold(this.#runtime)
		if (this.#runtime.state === 'starting') this.#transition('running')
		this.#transition('paused')
		this.#settlePause('paused')

		while (true) {
			if (this.#runtime.stop !== undefined || this.#failing) return false

			if (this.#protection !== undefined) {
				await this.#serveProtection(this.#runtime.phase === 'startup' ? 'startup' : 'preCapture', true)
				continue
			}

			if (this.#runtime.desired === 'running') {
				this.#transition('running')
				this.#runtime.resumedSinceAutofocus = true

				// Each policy pause renews only the counter that caused it, durably before the next exposure; a restart never
				// renews it by itself.
				const frame = this.#runtime.currentFrame

				switch (cause) {
					case 'capture':
						this.#capturePause = false
						if (frame !== undefined) this.#runtime.currentFrame = { ...frame, captureFailures: 0 }
						return await this.#persist()
					case 'discard':
						if (frame !== undefined) this.#runtime.currentFrame = { ...frame, discardBudgetUsed: 0 }
						return await this.#persist()
					case 'circuit':
						this.#runtime.consecutiveDiscards = 0
						return await this.#persist()
				}

				return true
			}

			await new Promise<void>((resolve) => {
				this.#wake = resolve
			})

			this.#wake = undefined
		}
	}

	// A restored slot whose capture budget is exhausted (the recovery counted an exposure in flight) never exposes
	// again: the capture policy applies before the first frame, as right after the failure. 'pause' is derived at the
	// safe point instead; the reason of the last failure died with its process.
	async #reapplyExhaustedCapture() {
		const frame = this.#runtime.currentFrame
		const { retry, onFailure } = this.#configuration.capture
		if (frame === undefined || frame.captureFailures < retry.maxAttempts || onFailure === 'pause') return

		const failure: SequencerFailure = { kind: 'operation', reason: 'commandFailed', task: 'captureFrame', detail: `capture budget of ${frame.id} exhausted` }

		switch (onFailure) {
			case 'fail':
				this.#fail(failure)
				return
			case 'stop':
				this.#policyStop(failure)
				return
			case 'skipFrame': {
				const progress = this.#runtime.capture.get(frame.groupId)
				if (progress !== undefined) progress.skipped++
				this.#runtime.currentFrame = undefined
				if (await this.#persist()) this.#emit({ type: 'slotSkipped', slot: frame.id, reason: 'captureFailures' })
			}
		}
	}

	// Hold due at the loop safe point: the capture policy 'pause' (applied, or derived from the persisted budget of the
	// current slot), a discard policy 'pause' derived from an exhausted discard counter (the circuit breaker, then the
	// slot budget), or a pending user pause.
	#pendingHold(): HoldCause | undefined {
		const frame = this.#runtime.currentFrame
		const { retry, onFailure } = this.#configuration.capture
		if (this.#capturePause || (onFailure === 'pause' && frame !== undefined && frame.captureFailures >= retry.maxAttempts)) return 'capture'

		if (frame !== undefined) {
			const exhausted = exhaustedDiscardAction(this.#groupOf(frame)?.discard, frame, this.#runtime.consecutiveDiscards)
			if (exhausted?.action === 'pause') return exhausted.counter === 'consecutive' ? 'circuit' : 'discard'
		}

		return shouldHoldSequencer(this.#runtime) ? 'user' : undefined
	}

	// A restored slot that still owes a stop or a failure to an exhausted discard counter (the circuit breaker, or a slot
	// budget whose action is 'fail') never exposes again: the action applies before the first frame, as right after the
	// discard. A restart is not a `resume()` and renews no counter; 'pause' is derived at the safe point instead.
	#reapplyExhaustedDiscards() {
		const frame = this.#runtime.currentFrame
		if (frame === undefined) return

		const exhausted = exhaustedDiscardAction(this.#groupOf(frame)?.discard, frame, this.#runtime.consecutiveDiscards)
		if (exhausted === undefined || exhausted.action === 'pause') return

		const failure: SequencerFailure = { kind: 'quality', detail: `${frame.id} already exhausted ${exhausted.counter === 'consecutive' ? 'the consecutive discards' : 'the discards of its slot'} allowed` }
		if (exhausted.action === 'fail') this.#fail(failure)
		else this.#policyStop(failure)
	}

	// Next slot: a restored slot whose attempt is still to run as is, otherwise the scheduler order, or only the
	// `onStop` session-end groups after a graceful stop.
	#select() {
		const { capture } = this.#configuration
		const { scheduler, currentFrame, stop } = this.#runtime
		if (currentFrame !== undefined && !this.#consumed && (stop === undefined || this.#isOnStopFrame(currentFrame))) return currentFrame
		const events: SequencerTriggerEvent[] = []
		const select = this.#runtime.stop === 'graceful' ? selectNextFrameOnStop : selectNextFrame
		const frame = select(capture, scheduler, this.#runtime.capture, currentFrame, events)
		for (const event of events) this.#emit(event)
		return frame
	}

	// Whether the pre-capture of `frame` must be abandoned: a failure, an immediate stop, or a graceful stop of a
	// frame the stop no longer selects.
	#abandons(frame: SequencerFrameSlot) {
		const { stop } = this.#runtime
		return this.#failing || this.#framesEnded || stop === 'immediate' || (stop === 'graceful' && !this.#isOnStopFrame(frame))
	}

	// Whether a slot belongs to a session-end group that also runs on a graceful stop.
	#isOnStopFrame(frame: SequencerFrameSlot) {
		const group = this.#configuration.capture.groups.find((group) => group.id === frame.groupId)
		return group?.kind === 'triggered' && group.trigger.kind === 'sessionEnd' && group.trigger.onStop
	}

	// Stage 2 of the drain after an interruption (the cancelled root already finished: stage 1 is the await of its
	// result by the loop), then every pending compensation. The drain reopens the reservation tokens when it ends and
	// preserves the root of the guiding session, whose lifetime is the session's (section 16.4).
	async #quiesce() {
		// Stage 2 and the compensations never start before a critical protection reached its outcome.
		await this.#awaitCritical()

		if (this.#drainPending) {
			this.#drainPending = false
			await this.#services.coordinator.drainByReservationOwner(this.#owner, 'aborted', this.#services.guiding?.operationId?.())
		}

		while (this.#runtime.compensations.length > 0) {
			await this.#compensate(this.#runtime.compensations.pop()!)
		}
	}

	// Runs one compensation as a new root `sequencer.compensate.{kind}` of the reservation, with its own signal: the
	// compensation timeout and the disposal, never the run. A failure is reported, never stops the next ones, and a
	// focuser left at an unknown position requests an autofocus.
	async #compensate(compensation: SequencerCompensation) {
		const { focuser, wheel } = this.#devices
		const { focuserCommander, wheelCommander } = this.#services

		const executor: OperationExecutor<void> | undefined =
			compensation.kind === 'focuserPosition'
				? focuser !== undefined && focuserCommander !== undefined
					? (scope) => focuserCommander.moveTo(scope, focuser, compensation.position)
					: undefined
				: wheel !== undefined && wheelCommander !== undefined
					? (scope) => wheelCommander.moveTo(scope, wheel, compensation.slot)
					: undefined

		const result =
			executor === undefined
				? failedOperationResult('commandFailed', `no ${compensation.kind === 'focuserPosition' ? 'focuser' : 'wheel'} to compensate`)
				: await this.#bounded(this.#startRoot(this.#dispose.signal, `sequencer.compensate.${compensation.kind}`, executor), this.#configuration.execution.compensation.timeout * 1000, this.#dispose.signal)

		if (result.ok) return

		this.#compensationFailures.push({ kind: 'operation', reason: result.reason, task: compensation.task, detail: `compensation ${compensation.kind}${result.error === undefined ? '' : `: ${result.error}`}` })

		// The focuser is somewhere unknown: the autofocus intent is persisted so a restart still focuses first.
		if (compensation.kind === 'focuserPosition' && !this.#runtime.intents.autofocus) {
			this.#runtime.intents.autofocus = true
			await this.#persist()
		}
	}

	// Awaits a root, cancelling it with 'timeout' after `timeout` ms of the monotonic clock and with 'aborted' when
	// `signal` aborts. Leaves no pending delay or listener behind.
	async #bounded<T>(handle: OperationHandle<T>, timeout: number | undefined, signal: AbortSignal) {
		const local = new AbortController()
		const abort = () => void handle.cancel('aborted')

		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })

		if (timeout !== undefined) {
			void this.#clock.delay(timeout, local.signal).then((elapsed) => {
				if (elapsed.ok) void handle.cancel('timeout')
			})
		}

		try {
			return await handle.result
		} finally {
			local.abort()
			signal.removeEventListener('abort', abort)
		}
	}

	// Abortable wait of the run in the monotonic domain, also interrupted by a protection and, when `pausable`, by a
	// pause request; false when interrupted.
	async #wait(ms: number, pausable = false) {
		if (!(ms > 0)) return true
		if (this.#run.signal.aborted) return false

		const controller = new AbortController()
		const abort = () => controller.abort()
		this.#run.signal.addEventListener('abort', abort, { once: true })
		this.#waiting = controller
		if (pausable) this.#pausableWait = controller

		try {
			return (await this.#clock.delay(ms, controller.signal)).ok
		} finally {
			this.#run.signal.removeEventListener('abort', abort)
			this.#waiting = undefined
			if (this.#pausableWait === controller) this.#pausableWait = undefined
		}
	}

	// Counts one re-entry of the pre-capture without progress; past `SEQUENCER_REENTRY_LIMIT` the session fails with a
	// logic failure of `task` instead of looping. Returns whether the pre-capture may re-enter.
	#countReentry(task: SequencerTaskId, reason: string) {
		if (++this.#reentries <= SEQUENCER_REENTRY_LIMIT) return true
		this.#fail({ kind: 'operation', reason: 'unexpectedState', task, detail: `the pre-capture re-entered ${this.#reentries} times without exposing: ${reason}` })
		return false
	}

	// Opens a root of the reservation, leasing `resources`, unless `signal` aborted or nothing is reserved.
	#startRoot<T>(signal: AbortSignal, kind: string, executor: OperationExecutor<T>, resources: readonly ResourceRequest[] = []): OperationHandle<T> {
		if (this.#scope === undefined || signal.aborted) return refusedHandle(kind)
		return this.#scope.start(kind, resources, executor)
	}

	// Reservation scope of the run tasks, refused once the run aborted.
	readonly #runReservation: OperationScope = { start: (kind, resources, executor) => this.#startRoot(this.#run.signal, kind, executor, resources) }

	// Reservation scope of the shutdown steps, refused once the shutdown aborted.
	readonly #shutdownReservation: OperationScope = { start: (kind, resources, executor) => this.#startRoot(this.#shutdown.signal, kind, executor, resources) }

	// Records the root the run waits for and announces its task.
	#begin(handle: OperationHandle<unknown>, phase: SequencerPhase, task: SequencerTaskId) {
		const current: CurrentTask = { handle, phase, interrupted: false }
		this.#current = current
		this.#runtime.task = task
		this.#emit({ type: 'taskStarted', task, phase })
		return current
	}

	#end() {
		this.#current = undefined
		this.#runtime.task = undefined
	}

	// Cancels the current run task (stage 1 of the drain; the loop awaits its result) and aborts the wait of the run.
	// A capture is cancelled only when `capture` is true.
	#interrupt(capture: boolean) {
		const current = this.#current

		if (current !== undefined && !current.interrupted && (capture || current.phase !== 'capture')) {
			current.interrupted = true
			this.#drainPending = true
			void current.handle.cancel('aborted')
		}

		this.#waiting?.abort()
	}

	#requestPause(): Promise<SequencerSessionState> {
		const { state } = this.#runtime
		if (isTerminalSequencerState(state)) return Promise.resolve(state)
		if (this.#pause !== undefined) return this.#pause.promise
		if (!requestSequencerPause(this.#runtime)) return this.#result.promise.then((result) => result.state)
		if (state === 'paused') return Promise.resolve<SequencerSessionState>('paused')

		// The wait of a guard re-entry and the wait of a safety gate of the pre-capture are safe points: the pause is honored
		// without waiting them out.
		this.#pausableWait?.abort()
		if (this.#current?.phase === 'preCapture' && this.#runtime.task === 'safetyGate') this.#interrupt(false)

		this.#pause = Promise.withResolvers()
		return this.#pause.promise
	}

	#requestResume() {
		if (!requestSequencerResume(this.#runtime)) return false
		if (this.#runtime.state === 'paused') this.#wake?.()
		else this.#settlePause('running')
		return true
	}

	#requestStop(mode: SequencerStopMode) {
		// The shutdown is never cancelled by a stop and its outcome is already decided, so a late stop changes nothing.
		if (this.#runtime.state === 'shuttingDown' || isTerminalSequencerState(this.#runtime.state)) return this.#result.promise

		if (requestSequencerStop(this.#runtime, mode)) {
			this.#stopCause ??= 'user'
			this.#stopping()

			// An immediate stop aborts the run and cancels whatever runs; a graceful one lets an exposure finish and
			// keeps the session-end frames that also run on a stop.
			if (mode === 'immediate') {
				this.#run.abort()
				this.#interrupt(true)
			} else {
				const frame = this.#runtime.currentFrame
				if (frame === undefined || this.#current?.phase === 'startup' || !this.#isOnStopFrame(frame)) this.#interrupt(false)
			}

			this.#wake?.()
		}

		return this.#result.promise
	}

	// Applies the action of a failed critical protection: fail, stop gracefully, or hold at the next safe point.
	#applyProtectionFailure(outcome: Extract<SequencerProtectionOutcome, { readonly ok: false }>) {
		switch (outcome.action) {
			case 'fail':
				this.#fail(outcome.failure)
				return
			case 'stop':
				this.#policyStop(outcome.failure)
				return
			case 'pause':
				if (this.#runtime.stop !== undefined || this.#failing) return
				requestSequencerHold(this.#runtime)
				this.#policyHold = true
		}
	}

	// Waits until no critical protection, meridian or safety, is in flight.
	async #awaitCritical() {
		while (this.#critical !== undefined || this.#safetyProtection !== undefined) {
			await this.#critical
			await this.#safetyProtection
		}
	}

	// Whether the run is interrupted for a protection: a graceful request pending or running, or a critical one in flight.
	#protecting() {
		return this.#protection !== undefined || this.#critical !== undefined
	}

	// Opens the root of a run or shutdown task through `start` and records it as a motion owner while it lives when its
	// task may move the mount. The owner is recorded before the root starts, under a provisional key until its id is
	// known: the first synchronous stretch of the task runs inside `start` and may already command the mount.
	#startTracked<T>(task: SequencerTaskId, start: () => OperationHandle<T>): OperationHandle<T> {
		const keys = this.#phases.supervisor?.motionKeys(task) ?? []
		if (keys.length === 0) return start()

		const owner: SequencerMotionOwner = { task, keys }
		const provisional = `starting#${++this.#startingMotion}`
		this.#motionOwners.set(provisional, owner)
		let handle: OperationHandle<T>

		try {
			handle = start()
		} finally {
			this.#motionOwners.delete(provisional)
		}

		this.#motionOwners.set(handle.id, owner)
		void handle.result.then(() => this.#motionOwners.delete(handle.id))
		return handle
	}

	// Graceful stop requested by a failure action 'stop'; a safety failure (a safety gate) stops with the cause 'safety'.
	#policyStop(failure: SequencerFailure) {
		this.#runtime.failure ??= failure
		this.#stopCause ??= failure.kind === 'safety' ? 'safety' : 'policy'
		if (requestSequencerStop(this.#runtime, 'graceful')) this.#stopping()
	}

	// Fails the session: the first failure stays primary, the run is aborted and the current task cancelled.
	#fail(failure: SequencerFailure) {
		this.#runtime.failure ??= failure
		this.#failing = true
		this.#run.abort()
		this.#interrupt(true)
		this.#stopping()
		this.#wake?.()
	}

	// Moves an admitted session that is still running towards the shutdown.
	#stopping() {
		const { state } = this.#runtime
		if (this.#reservation !== undefined && (state === 'starting' || state === 'running' || state === 'paused')) this.#transition('stopping')
	}

	#transition(to: SequencerSessionState) {
		const previous = this.#runtime.state
		if (previous === to) return
		transitionSequencerState(this.#runtime, to, this.#clock.wallNow())
		this.#emit({ type: 'stateChanged', state: to, previous })
	}

	#setPhase(phase: SequencerPhase) {
		if (this.#runtime.phase === phase) return
		this.#runtime.phase = phase
		this.#emit({ type: 'phaseChanged', phase })
	}

	// Resolves a pending pause promise with the state it ended in.
	#settlePause(state: SequencerSessionState) {
		const pause = this.#pause
		this.#pause = undefined
		pause?.resolve(state)
	}

	// Terminalizes once: terminal state, pending pause settled, terminal event, then the result.
	#terminate(state: SequencerTerminalState) {
		if (isTerminalSequencerState(this.#runtime.state)) return

		this.#disposeSignal?.removeEventListener('abort', this.#onDispose)
		this.#runtime.currentFrame = undefined
		this.#transition(state)

		const runtime = this.#runtime
		const result: SequencerResult = {
			state,
			sessionId: this.id,
			startedAt: runtime.startedAt,
			finishedAt: runtime.updatedAt,
			capture: sequencerCaptureProgressSnapshot(this.#configuration, runtime.capture),
			...(state === 'stopped' && { stopCause: this.#stopCause ?? 'user' }),
			...(runtime.failure !== undefined && { failure: runtime.failure }),
			shutdownFailures: [...this.#shutdownFailures],
			compensationFailures: [...this.#compensationFailures],
		}

		this.#settlePause(state)
		this.#emit({ type: state === 'completed' ? 'sessionCompleted' : state === 'stopped' ? 'sessionStopped' : 'sessionFailed', result })
		this.#result.resolve(result)
	}

	#view(frame?: SequencerFrameSlot): SequencerTaskView {
		const view = { sessionId: this.id, configuration: this.#configuration, devices: this.#devices, clock: this.#clock, state: this.#runtime }
		return frame === undefined ? view : { ...view, frame }
	}

	// Event emission handed to the task contexts.
	readonly #emitter = (body: SequencerEventBody) => this.#emit(body)

	// Checkpoint save handed to the task contexts.
	readonly #saver = async (): Promise<SequencerTaskResult> => {
		const failure = await this.#saveCheckpoint()
		if (failure === undefined) return { ok: true }
		this.#fail(failure)
		return { ok: false, failure }
	}

	// Stamps and delivers an event. A throwing listener is reported and never breaks the session.
	#emit(body: SequencerEventBody) {
		const listener = this.#services.listener
		if (listener === undefined) return

		try {
			listener({ ...body, sessionId: this.id, at: this.#clock.wallNow() })
		} catch (error) {
			console.error('sequencer listener failed:', this.id, body.type, error)
		}
	}
}

// Evaluates the predicate of a task; a throw is a failure of the task (`operation/commandFailed`).
async function shouldRun(task: Pick<SequencerTask, 'id' | 'shouldRun'>, view: SequencerTaskView): Promise<boolean | SequencerFailure> {
	try {
		return await task.shouldRun(view)
	} catch (error) {
		return { kind: 'operation', reason: 'commandFailed', task: task.id, detail: errorMessage(error) }
	}
}

// Session failure of a root result: undefined on success, the failure the task returned, or the operation failure
// of the root (cancellation, exception as `commandFailed`).
function taskFailure(task: SequencerTaskId, result: OperationResult<SequencerTaskResult>): SequencerFailure | undefined {
	if (!result.ok) return operationFailure(task, result)
	if (result.value.ok) return undefined
	const { failure } = result.value
	return failure.kind === 'operation' && failure.task === undefined ? { ...failure, task } : failure
}

// Operation failure of a task root.
function operationFailure(task: SequencerTaskId, result: Extract<OperationResult<unknown>, { readonly ok: false }>): SequencerFailure {
	return result.error === undefined ? { kind: 'operation', reason: result.reason, task } : { kind: 'operation', reason: result.reason, task, detail: result.error }
}

// Outcome of what a quality analyzer resolved, validated at that caller boundary: 'analyzed' with a fresh copy of a
// well-formed result (a known classification, finite metrics, boolean intents), 'error' otherwise.
function qualityOutcomeOf(value: unknown): SequencerQualityOutcome {
	if (typeof value !== 'object' || value === null) return { kind: 'error', detail: 'the quality analyzer resolved no result' }

	const { classification, metrics, intents } = value as Record<string, unknown>
	if (!QUALITY_CLASSIFICATIONS.has(classification)) return { kind: 'error', detail: `unknown quality classification ${String(classification)}` }

	let copiedMetrics: Record<string, number> | undefined

	if (metrics !== undefined) {
		if (typeof metrics !== 'object' || metrics === null) return { kind: 'error', detail: 'malformed quality metrics' }
		copiedMetrics = {}

		for (const [name, metric] of Object.entries(metrics)) {
			if (typeof metric !== 'number' || !Number.isFinite(metric)) return { kind: 'error', detail: `malformed quality metric ${name}` }
			// `Object.defineProperty` keeps any metric name (even `__proto__`) a plain key.
			Object.defineProperty(copiedMetrics, name, { value: metric, enumerable: true, writable: true, configurable: true })
		}
	}

	let copiedIntents: SequencerCorrectiveIntents | undefined

	if (intents !== undefined) {
		if (typeof intents !== 'object' || intents === null) return { kind: 'error', detail: 'malformed corrective intents' }
		const { autofocus, recenter, recoverGuiding } = intents as Record<string, unknown>
		if (!isOptionalBoolean(autofocus) || !isOptionalBoolean(recenter) || !isOptionalBoolean(recoverGuiding)) return { kind: 'error', detail: 'malformed corrective intents' }
		copiedIntents = { ...(autofocus !== undefined && { autofocus }), ...(recenter !== undefined && { recenter }), ...(recoverGuiding !== undefined && { recoverGuiding }) }
	}

	const result: SequencerQualityResult = { classification: classification as SequencerQualityResult['classification'], ...(copiedMetrics !== undefined && { metrics: copiedMetrics }), ...(copiedIntents !== undefined && { intents: copiedIntents }) }
	return { kind: 'analyzed', result }
}

// Whether a value is a boolean or absent.
function isOptionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === 'boolean'
}

// Settled handle of a root that was never opened.
function refusedHandle<T>(kind: string): OperationHandle<T> {
	const controller = new AbortController()
	controller.abort('aborted')
	return Object.freeze({ id: Bun.randomUUIDv7(), kind, signal: controller.signal, result: Promise.resolve(failedOperationResult('aborted', 'the sequencer run has been aborted')), cancel: () => Promise.resolve() })
}

// Compact diagnostic of a refused reservation.
function formatConflicts(conflicts: readonly ResourceConflict[]) {
	return conflicts.map((conflict) => `${conflict.key} is ${conflict.by === 'unavailable' ? 'unavailable' : `held by ${conflict.ownerKind} ${conflict.ownerId}`}`).join(', ')
}
