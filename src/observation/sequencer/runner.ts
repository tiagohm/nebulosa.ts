import { errorMessage } from '../../core/util'
import type { Device } from '../../devices/indi/device'
import { type FailedOperationResult, failedOperationResult, type OperationContext, type OperationExecutor, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type ResourceConflict, type ResourceRequest, type ResourceReservation, type ResourceReservationOwner, resourceKey } from '../../devices/orchestration/resource'
import { createMeridianFlipState } from '../mount/meridian.flip'
import { restoreSequencerFrameSlot, selectNextFrame, selectNextFrameOnStop, type SequencerTriggerEvent } from './scheduler'
// oxfmt-ignore
import { type SequencerCheckpoint, type SequencerCheckpointSlot, type SequencerClock, type SequencerConfiguration, type SequencerDevices, type SequencerEventBody, type SequencerFailure, type SequencerFrameSlot, type SequencerHandle, type SequencerOptionalFailureAction, type SequencerPhase, type SequencerResult, type SequencerRetryPolicy, type SequencerRunnerServices, type SequencerSessionState, type SequencerShutdownStepPolicy, type SequencerSnapshot, type SequencerTaskId, type SequencerTerminalState, SYSTEM_SEQUENCER_CLOCK } from './sequencer'
// oxfmt-ignore
import { applySequencerCheckpoint, createSequencerRuntimeState, isTerminalSequencerState, requestSequencerHold, requestSequencerPause, requestSequencerResume, requestSequencerStop, type SequencerCompensation, type SequencerRuntimeState, type SequencerStopMode, sequencerCaptureProgressSnapshot, sequencerCheckpointOf, sequencerFrameSlotSnapshot, sequencerSnapshot, shouldHoldSequencer, transitionSequencerState } from './state'
import type { SequencerDeferReason, SequencerFrameDestination, SequencerStorage } from './storage'

// Runner of one Sequencer session: the only owner of its execution. It admits the session, holds one resource
// reservation for its whole lifetime, runs the startup, the frame loop (select → pre-capture → capture →
// post-capture) and the shutdown in a fixed order, honors pause, resume and stop only at safe points, drains
// interrupted work in two stages, runs the pending compensations as new roots of the same reservation, and
// terminalizes exactly once after the terminal drain and the release.
//
// Admission locks the session directory before anything else, then resumes: the checkpoint is loaded, bound to the
// configuration id and revision, reconciled with the journal and the disk, and restored (the slot in progress
// included), all before the reservation. Persistence follows section 34.2: a checkpoint is saved when a new slot is
// selected, after each capture failure (before its `abandoned` line), after a resume that renews a counter and
// after an intent changes; a captured frame is one logical transaction, computed before its file is touched,
// journaled with the promotion, applied and then saved. A prepared attempt that is not dispatched is closed by
// `deferred` before any wait or re-entry. The capture asks the session synchronously, right before dispatching,
// whether the exposure may go (a pending stop, pause or protection refuses it); only an approved exposure is a
// commanded attempt that may count as a capture failure. A persistence failure fails the session with a 'storage'
// failure: no new exposure starts and nothing advances in memory as if it had been saved. The lock is released after
// the reservation, right before the terminalization.
//
// Every physical task is a root `sequencer.{taskId}` opened through `startTask`, which refuses once the run was
// aborted; tasks pass the root context to commanders, so cancelling the root cancels everything they commanded.
// The run signal covers startup, pre-capture, capture and post-capture; the shutdown has a signal of its own that
// only `dispose()` aborts, so an immediate stop never cancels the steps that leave the observatory safe.
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
	// Emits a session event of the task synchronously; the session stamps and delivers it.
	readonly emit: (event: SequencerEventBody) => void
}

// Outcome of one task execution. A failure carries the session failure the phase policy applies to.
export type SequencerTaskResult = { readonly ok: true } | { readonly ok: false; readonly failure: SequencerFailure }

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

// Delay before the retry number `retry` (1-based), in ms: `delay × backoff^(retry − 1)` seconds, capped at
// `maximumDelay`.
export function sequencerRetryDelay(policy: SequencerRetryPolicy, retry: number) {
	return Math.min(policy.delay * policy.backoff ** (retry - 1), policy.maximumDelay) * 1000
}

// Policy of a task without one outside the startup: its failure fails the session.
const FAIL_POLICY: SequencerTaskPolicy = { onFailure: 'fail' }

// Outcome of one task after its retries.
// - done: it succeeded or did not need to run;
// - interrupted: the runner cancelled it (stop, protection, disposal); never retried;
// - failed: its retries are exhausted and `action` applies.
type TaskOutcome = { readonly kind: 'done' } | { readonly kind: 'interrupted' } | { readonly kind: 'failed'; readonly failure: SequencerFailure; readonly action: SequencerOptionalFailureAction }

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

// Why the session holds: a user pause, a failure action 'pause', or the capture failure policy (whose resume
// renews `captureFailures`).
type HoldCause = 'user' | 'policy' | 'capture'

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
	#stopCause?: 'user' | 'policy'
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

		try {
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

		const locked = await this.#storage.lock()
		if (!locked.ok) return this.#refuse(locked.failure)
		if (this.#runtime.stop !== undefined || this.#failing || !(await this.#resume())) return false
		if (this.#runtime.stop !== undefined || this.#failing) return false

		const reserved = this.#services.coordinator.arbiter.reserve(this.#owner, sequencerResourceRequests(this.#configuration, this.#devices))
		if (!reserved.ok) return this.#refuse({ kind: 'operation', reason: 'busy', detail: formatConflicts(reserved.conflicts) })

		this.#reservation = reserved.reservation
		this.#scope = this.#services.coordinator.reservedScope(reserved.reservation)
		return true
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

	// Startup tasks in order. A protection or a pause re-executes the interrupted step from its beginning; any stop
	// or failure ends the startup without frames. Returns whether the frame loop runs.
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

			const outcome = await this.#runTask(tasks[i], 'startup', tasks[i].policy ?? policy)

			if (outcome.kind === 'done') i++
			else if (outcome.kind === 'failed') {
				const next = await this.#applyFailure(outcome)
				if (next === 'end') return false
				if (next === 'skip') i++
			} else await this.#quiesce()
		}

		return !(this.#runtime.stop !== undefined || this.#failing)
	}

	// Frame loop: at each safe point serve a protection, wait a retry delay, hold a pause, then select the next slot
	// and run its pre-capture, capture and post-capture. A graceful stop keeps selecting only the session-end
	// groups with `onStop`; an immediate stop or a failure ends the loop.
	async #frames() {
		await this.#reapplyExhaustedCapture()

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
					await this.#defer(this.#protection !== undefined ? 'meridian' : 'stop')
					await this.#quiesce()
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
	// `beforeExposure` right before dispatching, which refuses while a stop, a pause or a protection is pending; only
	// an approved exposure counts as a commanded attempt. A stop lets an approved exposure finish unless immediate; a
	// protection cancels it.
	async #capture(frame: SequencerFrameSlot): Promise<CaptureOutcome> {
		if (this.#abandons(frame) || this.#run.signal.aborted) return { kind: 'deferred', reason: 'stop' }

		const destination = this.#storage.prepared

		if (destination === undefined || destination.slot !== frame.id || destination.attempt !== frame.attempt) {
			this.#fail({ kind: 'storage', detail: `no destination was prepared for ${frame.id}#${frame.attempt}` })
			return { kind: 'interrupted' }
		}

		this.#setPhase('capture')
		this.#dispatched = undefined
		let decision: 'approved' | 'refused' | undefined

		const beforeExposure = () => {
			if (decision !== undefined) return decision === 'approved' ? undefined : failedOperationResult('aborted', 'the exposure was already refused')
			const refusal = this.#exposureRefusal(frame)

			if (refusal === undefined) {
				decision = 'approved'
				this.#dispatched = destination
				return undefined
			}

			decision = 'refused'
			return failedOperationResult('aborted', refusal)
		}

		const exposureStarted = () => {
			if (decision === 'approved') this.#emit({ type: 'exposureStarted', slot: frame.id, attempt: frame.attempt })
		}

		const view = this.#view(frame)
		const handle = this.startTask('sequencer.captureFrame', (scope) => this.#phases.capture({ ...view, scope, signal: scope.signal, emit: this.#emitter, destination, beforeExposure, exposureStarted }))
		const current = this.#begin(handle, 'capture', 'captureFrame')
		const result = await handle.result
		this.#end()

		if (result.ok) {
			this.#emit({ type: 'taskCompleted', task: 'captureFrame', phase: 'capture' })
			return { kind: 'captured', frame: result.value }
		}

		const failure = operationFailure('captureFrame', result)
		this.#emit({ type: 'taskFailed', task: 'captureFrame', phase: 'capture', failure })
		if (decision === 'refused') return { kind: 'deferred', reason: 'beforeExposure' }

		const cancelled = current.interrupted || this.#run.signal.aborted
		const protection = current.interrupted && this.#protection !== undefined && !this.#run.signal.aborted

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
		if (this.#protection !== undefined) return 'a meridian protection is pending'
		if (shouldHoldSequencer(this.#runtime)) return 'a pause was requested'
		return undefined
	}

	// Post-capture: records the outcome of the attempt, never commands a device. A captured frame whose temporary
	// holds data is accepted and completes its slot in one transaction (section 26). A failed capture keeps the slot
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
				await this.#accept(frame, outcome.frame)
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

	// Accepts a captured frame as one logical transaction: the next checkpoint (slot done, group progress, light
	// exposures, consecutive discards reset) is computed without being applied, journaled with the promotion, the
	// temporary is promoted to its final, and only then the state is applied and the checkpoint saved.
	async #accept(frame: SequencerFrameSlot, captured: SequencerCapturedFrame) {
		const base = this.#checkpoint(this.#sequence + 1, undefined)
		const counters = base.capture[frame.groupId]
		const light = frame.capture.frameType === 'LIGHT'
		const next: SequencerCheckpoint = {
			...base,
			// A computed key defines an own property, so any group id (even `__proto__`) is a plain key.
			capture: counters === undefined ? base.capture : { ...base.capture, [frame.groupId]: { ...counters, accepted: counters.accepted + 1 } },
			anchors: light ? { ...base.anchors, lightExposures: base.anchors.lightExposures + 1 } : base.anchors,
			consecutiveDiscards: 0,
		}

		const promoted = await this.#storage.promote(next, false)

		if (!promoted.ok) {
			this.#fail(promoted.failure)
			return
		}

		applySequencerCheckpoint(this.#runtime, this.#configuration, next)
		this.#runtime.currentFrame = undefined
		// The transaction is durable in the journal even when this save fails; the recovery reapplies it.
		await this.#persist(next)
		const { exposureStartedAt, exposureFinishedAt } = captured
		this.#emit({ type: 'frameCaptured', slot: frame.id, attempt: frame.attempt, exposureStartedAt, exposureFinishedAt })
		this.#emit({ type: 'frameAccepted', slot: frame.id, attempt: frame.attempt, path: promoted.value, forced: false })
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
			await this.#services.coordinator.cancelByReservationOwner(this.#owner, 'aborted')
			this.#reservation?.release()
			await this.#storage.release()
			this.#terminate(this.#failing || this.#shutdownFailed ? 'failed' : this.#runtime.stop !== undefined ? 'stopped' : 'completed')
		}
	}

	// Shutdown steps in order with the shutdown signal, accumulating failures. Each step is bounded by
	// `stepTimeout` and by what is left of `totalTimeout`, except the pause-guiding → stop-tracking prefix, which
	// bounds itself and is never cut; an exhausted total is reported once and no later step starts.
	async #shutdownSteps() {
		const { stepTimeout, totalTimeout } = this.#configuration.shutdown
		const deadline = this.#clock.monotonicNow() + totalTimeout * 1000

		for (const step of this.#phases.shutdown) {
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

			const handle = this.#startRoot(this.#shutdown.signal, `sequencer.${step.id}`, (scope) => step.run({ ...this.#view(), scope, signal: scope.signal, emit: this.#emitter }).then(successfulOperationResult))
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
	// failure or an `aborted` reason, and wait `sequencerRetryDelay` on the run signal.
	async #runTask(task: SequencerTask, phase: SequencerPhase, policy: SequencerTaskPolicy, frame?: SequencerFrameSlot): Promise<TaskOutcome> {
		const view = this.#view(frame)
		const due = await shouldRun(task, view)

		if (due !== true) {
			if (due === false) return DONE
			this.#emit({ type: 'taskFailed', task: task.id, phase, failure: due })
			return { kind: 'failed', failure: due, action: policy.onFailure }
		}

		for (let attempt = 1; ; attempt++) {
			if (this.#run.signal.aborted) return INTERRUPTED
			const handle = this.startTask(`sequencer.${task.id}`, (scope) => task.run({ ...view, scope, signal: scope.signal, emit: this.#emitter }).then(successfulOperationResult))
			const current = this.#begin(handle, phase, task.id)
			const result = await handle.result
			this.#end()

			const failure = taskFailure(task.id, result)

			if (failure === undefined) {
				this.#emit({ type: 'taskCompleted', task: task.id, phase })
				return DONE
			}

			this.#emit({ type: 'taskFailed', task: task.id, phase, failure })

			if (current.interrupted || this.#run.signal.aborted) return INTERRUPTED

			const { retry } = policy

			if (retry === undefined || attempt >= retry.maxAttempts || failure.kind !== 'operation' || failure.reason === 'aborted' || !retry.retryOn.includes(failure.reason)) {
				return { kind: 'failed', failure, action: policy.onFailure }
			}

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

				if (cause === 'capture') {
					this.#capturePause = false
					const frame = this.#runtime.currentFrame
					if (frame !== undefined) this.#runtime.currentFrame = { ...frame, captureFailures: 0 }
					// The renewed budget is durable before the next exposure; a restart never renews it by itself.
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

	// Hold due at the loop safe point: a pending user pause, or the capture policy 'pause' (applied, or derived from
	// the persisted budget of the current slot).
	#pendingHold(): HoldCause | undefined {
		const frame = this.#runtime.currentFrame
		const { retry, onFailure } = this.#configuration.capture
		if (this.#capturePause || (onFailure === 'pause' && frame !== undefined && frame.captureFailures >= retry.maxAttempts)) return 'capture'
		return shouldHoldSequencer(this.#runtime) ? 'user' : undefined
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
	// result by the loop), then every pending compensation. The drain reopens the reservation tokens when it ends.
	async #quiesce() {
		if (this.#drainPending) {
			this.#drainPending = false
			await this.#services.coordinator.drainByReservationOwner(this.#owner, 'aborted')
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

	// Abortable wait of the run in the monotonic domain; false when interrupted.
	async #wait(ms: number) {
		if (!(ms > 0)) return true
		if (this.#run.signal.aborted) return false

		const controller = new AbortController()
		const abort = () => controller.abort()
		this.#run.signal.addEventListener('abort', abort, { once: true })
		this.#waiting = controller

		try {
			return (await this.#clock.delay(ms, controller.signal)).ok
		} finally {
			this.#run.signal.removeEventListener('abort', abort)
			this.#waiting = undefined
		}
	}

	// Opens a root of the reservation unless `signal` aborted or nothing is reserved.
	#startRoot<T>(signal: AbortSignal, kind: string, executor: OperationExecutor<T>): OperationHandle<T> {
		if (this.#scope === undefined || signal.aborted) return refusedHandle(kind)
		return this.#scope.start(kind, [], executor)
	}

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

	// Graceful stop requested by a failure action 'stop'.
	#policyStop(failure: SequencerFailure) {
		this.#runtime.failure ??= failure
		this.#stopCause ??= 'policy'
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
