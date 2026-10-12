import type { FrameType } from '../../devices/indi/device'
import { createMeridianFlipState, type MeridianFlipState } from '../mount/meridian.flip'
// oxfmt-ignore
import type { SequencerCheckpoint, SequencerCheckpointSlot, SequencerConfiguration, SequencerCorrectiveIntents, SequencerFailure, SequencerFilterFocusOffsets, SequencerFocusBaseline, SequencerFrameSlot, SequencerFrameSlotSnapshot, SequencerIntents, SequencerMountRiskObservation, SequencerPhase, SequencerSafetyState, SequencerSchedulerState, SequencerSessionState, SequencerSnapshot, SequencerTaskId, SequencerTerminalState, SequencerTriggerAnchors } from './sequencer'

// Runtime state of one Sequencer session and its pure transitions: the lifecycle state machine, the control
// requests (pause, resume, stop) recorded as desired state, the logical counters persisted between processes and
// their checkpoint form, the projection into the public snapshot, the focus-offset baseline (bootstrap, absolute
// targets, update after autofocus) and the safety-window query over the runtime transition history. Nothing here
// touches devices, clocks or storage: callers pass wall instants (Unix ms) and monotonic instants (ms) explicitly.
// Helpers that update the runtime state mutate it in place and document it; the snapshot, the checkpoint and the
// other derivations allocate fresh objects and never alias mutable runtime fields.

// State the controls asked for; honored only at safe points.
export type SequencerDesiredState = 'running' | 'paused'

// How a stop was requested: 'graceful' lets the current exposure finish, 'immediate' cancels it.
export type SequencerStopMode = 'graceful' | 'immediate'

// Pending physical undo of a task interrupted by cancellation, registered before the mutation it undoes and run
// in LIFO order after the drain. Never persisted.
export type SequencerCompensation =
	// Moves the focuser back to `position`, in absolute steps.
	| { readonly kind: 'focuserPosition'; readonly task: SequencerTaskId; readonly position: number }
	// Moves the wheel back to `slot`, 0-based.
	| { readonly kind: 'wheelSlot'; readonly task: SequencerTaskId; readonly slot: number }

// Progress counters of one group; mutated in place by the post-capture.
export interface SequencerGroupProgress {
	// Frames accepted by their quality, excluding forced ones.
	accepted: number
	// Discarded frames promoted as accepted by `keepLast`.
	forced: number
	// Discarded frames.
	discarded: number
	// Slots ended without an accepted frame.
	skipped: number
}

// Progress of every configured group by group id, in declared order.
export type SequencerCaptureProgress = Map<string, SequencerGroupProgress>

// Private runtime state of a session. Physical device state (connection, park, tracking, wheel slot, focuser
// position, rotator angle, shutter, cover) is never duplicated here: the device models are the source of truth.
export interface SequencerRuntimeState {
	// Lifecycle state.
	state: SequencerSessionState
	// State the controls asked for.
	desired: SequencerDesiredState
	// Pending stop request; once set it only escalates from 'graceful' to 'immediate'.
	stop?: SequencerStopMode
	// Current phase; cleared when terminal.
	phase?: SequencerPhase
	// Current task; cleared when terminal.
	task?: SequencerTaskId
	// Slot being prepared, captured or classified; it stays current until the slot is done.
	currentFrame?: SequencerFrameSlot

	// Persisted logical state.
	// Progress per group.
	capture: SequencerCaptureProgress
	// Scheduler cursor, credits and pending calibration batches.
	scheduler: SequencerSchedulerState
	// Trigger anchors.
	anchors: SequencerTriggerAnchors
	// Pending corrective intents.
	intents: SequencerIntents
	// Logical baseline of the focus offsets.
	focus: SequencerFocusBaseline
	// FLIP_STARTED transitions accepted in the session, across processes; saved before each one.
	meridianFlipAttempts: number
	// Wall instant (Unix ms) of the upper transit anchoring the meridian cycle; absent without meridian flip.
	meridianTransitAt?: number
	// Last observation of the meridian supervisor, copied into every checkpoint.
	mountRiskObservation?: SequencerMountRiskObservation
	// Consecutive discarded frames across slots (circuit breaker).
	consecutiveDiscards: number

	// Runtime-only state, rebuilt on every process.
	// Whether the target was acquired in this process.
	targetAcquired: boolean
	// Meridian flip phase, recreated from `meridianFlipAttempts` in each process and never reset in the session.
	meridianFlip: MeridianFlipState
	// Whether the meridian protection turned tracking off; after a restart `mount.tracking` replaces it.
	trackingStoppedForMeridianProtection: boolean
	// Whether the session closed the optical path for calibration; after a restart the cover and wheel replace it.
	opticalPathClosed: boolean
	// Pending compensations, in registration order (run in reverse).
	compensations: SequencerCompensation[]
	// Pending meridian protection: a graceful request of the supervisor, its execution, or the hard path.
	meridianProtection?: 'requested' | 'running' | 'hard'
	// Unresponsive collaborator being waited for.
	waitingFor?: SequencerSnapshot['waitingFor']

	// Wall instant the session started, in Unix ms.
	startedAt: number
	// Wall instant of the last state change, in Unix ms.
	updatedAt: number
	// Primary failure.
	failure?: SequencerFailure
}

// Allowed lifecycle transitions. A session that never reserved its devices (refused admission, stop during
// admission) terminates from 'starting' or 'stopping' without a shutdown; every other path shuts down first.
const SESSION_TRANSITIONS: Readonly<Record<SequencerSessionState, readonly SequencerSessionState[]>> = {
	starting: ['running', 'stopping', 'shuttingDown', 'stopped', 'failed'],
	running: ['paused', 'stopping', 'shuttingDown'],
	paused: ['running', 'stopping', 'shuttingDown'],
	stopping: ['shuttingDown', 'stopped', 'failed'],
	shuttingDown: ['completed', 'stopped', 'failed'],
	completed: [],
	stopped: [],
	failed: [],
}

// Whether a lifecycle state is terminal.
export function isTerminalSequencerState(state: SequencerSessionState): state is SequencerTerminalState {
	return state === 'completed' || state === 'stopped' || state === 'failed'
}

// Whether the lifecycle allows going from `from` to `to`. Staying in the same state is not a transition.
export function canTransitionSequencerState(from: SequencerSessionState, to: SequencerSessionState) {
	return SESSION_TRANSITIONS[from].includes(to)
}

// Moves the runtime state to `to` at the wall instant `at` (Unix ms), in place. Entering a terminal state clears
// the phase and the task. An illegal transition is a logic bug of the runner and throws RangeError.
export function transitionSequencerState(runtime: SequencerRuntimeState, to: SequencerSessionState, at: number) {
	if (!canTransitionSequencerState(runtime.state, to)) throw new RangeError(`invalid sequencer transition: ${runtime.state} → ${to}`)

	runtime.state = to
	runtime.updatedAt = at

	if (isTerminalSequencerState(to)) {
		runtime.phase = undefined
		runtime.task = undefined
	}
}

// Whether a session in `state` still honors pause, resume and graceful stop requests. Stopping, shutting down and
// terminal sessions never go back to running.
function isControllable(state: SequencerSessionState) {
	return state === 'starting' || state === 'running' || state === 'paused'
}

// Records a pause request, in place. Returns true when the pause is pending or already held after the call;
// false when the session no longer pauses (stop requested, stopping, shutting down or terminal).
export function requestSequencerPause(runtime: SequencerRuntimeState) {
	if (runtime.stop !== undefined || !isControllable(runtime.state)) return false
	runtime.desired = 'paused'
	return true
}

// Records, in place, that the session holds at a safe point, whether a pause was requested or a policy (a failure
// action 'pause', an exhausted capture budget) paused it, so `resume()` is accepted for both.
export function requestSequencerHold(runtime: SequencerRuntimeState) {
	runtime.desired = 'paused'
}

// Records a resume request, in place. Accepted only while a pause is pending or held and no stop was requested;
// the runner then leaves the hold (or skips it) and moves a paused session back to running.
export function requestSequencerResume(runtime: SequencerRuntimeState) {
	if (runtime.desired !== 'paused' || runtime.stop !== undefined || !isControllable(runtime.state)) return false
	runtime.desired = 'running'
	return true
}

// Records a stop request, in place. The first request is taken as is; 'immediate' after 'graceful' escalates;
// 'graceful' after 'immediate' and any request on a terminal session change nothing. Returns whether the pending
// stop changed. A stop also cancels a pending pause.
export function requestSequencerStop(runtime: SequencerRuntimeState, mode: SequencerStopMode) {
	if (isTerminalSequencerState(runtime.state) || runtime.stop === 'immediate' || runtime.stop === mode) return false
	runtime.stop = mode
	runtime.desired = 'running'
	return true
}

// Whether the next safe point must hold: a pause is desired and no stop is pending.
export function shouldHoldSequencer(runtime: SequencerRuntimeState) {
	return runtime.desired === 'paused' && runtime.stop === undefined
}

// Registers a pending compensation at the top of the stack, in place, before the mutation it undoes. Returns the
// function the task calls once the compensation is no longer due (the task succeeded, or a failure that was not
// a cancellation restored the device by itself); it removes exactly this entry and is idempotent. An entry left
// behind is run by the runner after the drain, in LIFO order.
export function pushSequencerCompensation(runtime: SequencerRuntimeState, compensation: SequencerCompensation): VoidFunction {
	runtime.compensations.push(compensation)
	let registered = true

	return () => {
		if (!registered) return
		registered = false
		const index = runtime.compensations.lastIndexOf(compensation)
		if (index >= 0) runtime.compensations.splice(index, 1)
	}
}

// Fresh intents with nothing pending.
export function createSequencerIntents(): SequencerIntents {
	return { autofocus: false, recenter: false, recoverGuiding: false }
}

// Sets the intents a quality analyzer attached, in place; an intent is never cleared here (only the successful
// task clears it).
export function applyCorrectiveIntents(intents: SequencerIntents, corrective: SequencerCorrectiveIntents) {
	if (corrective.autofocus === true) intents.autofocus = true
	if (corrective.recenter === true) intents.recenter = true
	if (corrective.recoverGuiding === true) intents.recoverGuiding = true
}

// Fresh anchors of a session that exposed nothing: zero light exposures and one calibration anchor per
// triggered group of the configuration.
export function createSequencerTriggerAnchors(configuration: SequencerConfiguration): SequencerTriggerAnchors {
	// `Object.fromEntries` defines own properties, so any group id (even `__proto__`) is a plain key.
	const calibration = Object.fromEntries(configuration.capture.groups.filter((group) => group.kind === 'triggered').map((group) => [group.id, { lightExposures: 0, batches: 0 }]))
	return { lightExposures: 0, autofocus: { lightExposures: 0 }, dither: { lightExposures: 0 }, recenter: { lightExposures: 0 }, calibration }
}

// Zeroed progress of every configured group, in declared order.
export function createSequencerCaptureProgress(configuration: SequencerConfiguration): SequencerCaptureProgress {
	const progress: SequencerCaptureProgress = new Map()
	for (const group of configuration.capture.groups) progress.set(group.id, { accepted: 0, forced: 0, discarded: 0, skipped: 0 })
	return progress
}

// Fresh scheduler state: no scheduled selection yet (no cursor, no weighted rotation), no batch pending and no
// session-boundary batch enqueued.
export function createSequencerSchedulerState(): SequencerSchedulerState {
	return { credits: {}, batches: [], sessionStartQueued: false, sessionEndQueued: false }
}

// Runtime state of a new session at the wall instant `at` (Unix ms): starting, nothing captured, nothing
// pending, focus baseline unset and no meridian flip started. Restoring a checkpoint replaces the persisted
// fields afterwards.
export function createSequencerRuntimeState(configuration: SequencerConfiguration, at: number): SequencerRuntimeState {
	return {
		state: 'starting',
		desired: 'running',
		capture: createSequencerCaptureProgress(configuration),
		scheduler: createSequencerSchedulerState(),
		anchors: createSequencerTriggerAnchors(configuration),
		intents: createSequencerIntents(),
		focus: { kind: 'unset' },
		meridianFlipAttempts: 0,
		consecutiveDiscards: 0,
		targetAcquired: false,
		meridianFlip: createMeridianFlipState(0),
		trackingStoppedForMeridianProtection: false,
		opticalPathClosed: false,
		compensations: [],
		startedAt: at,
		updatedAt: at,
	}
}

// Lightweight projection of a slot, without its camera settings.
export function sequencerFrameSlotSnapshot(slot: SequencerFrameSlot): SequencerFrameSlotSnapshot {
	const { id, groupId, kind, ordinal, attempt, discardedTotal, discardBudgetUsed, captureFailures, triggeredBy } = slot
	const snapshot = { id, groupId, kind, ordinal, attempt, discardedTotal, discardBudgetUsed, captureFailures, frameType: slot.capture.frameType }
	return triggeredBy === undefined ? snapshot : { ...snapshot, triggeredBy }
}

// Capture progress of every configured group, in declared order. A group missing from the runtime progress
// (never the case for a state built from the same configuration) reports zeros.
export function sequencerCaptureProgressSnapshot(configuration: SequencerConfiguration, progress: SequencerCaptureProgress): SequencerSnapshot['capture'] {
	const groups = configuration.capture.groups.map((group) => {
		const counters = progress.get(group.id)
		const requested = group.kind === 'scheduled' ? group.count : group.maxFrames
		return { groupId: group.id, kind: group.kind, enabled: group.enabled, requested, accepted: counters?.accepted ?? 0, forced: counters?.forced ?? 0, discarded: counters?.discarded ?? 0, skipped: counters?.skipped ?? 0 }
	})

	return { groups }
}

// Public snapshot of a session. It allocates a fresh, immutable-by-contract object and never aliases mutable
// runtime fields; optional fields are absent rather than undefined.
export function sequencerSnapshot(sessionId: string, configuration: SequencerConfiguration, runtime: SequencerRuntimeState): SequencerSnapshot {
	const { state, phase, task, currentFrame, intents, waitingFor, startedAt, updatedAt, failure } = runtime

	return {
		sessionId,
		state,
		...(phase !== undefined && { phase }),
		...(task !== undefined && { task }),
		...(currentFrame !== undefined && { currentFrame: sequencerFrameSlotSnapshot(currentFrame) }),
		capture: sequencerCaptureProgressSnapshot(configuration, runtime.capture),
		intents: { autofocus: intents.autofocus, recenter: intents.recenter, recoverGuiding: intents.recoverGuiding },
		...(waitingFor !== undefined && { waitingFor }),
		startedAt,
		updatedAt,
		...(failure !== undefined && { failure }),
	}
}

// Checkpoint of the persisted part of a runtime state: `currentSlot` is the slot in progress (undefined between
// slots), `sequence` its order and `updatedAt` the wall instant of the save (Unix ms). A deep copy that never aliases
// the runtime, so the runtime may keep changing while it is written; optional fields are absent rather than undefined.
export function sequencerCheckpointOf(sessionId: string, configuration: SequencerConfiguration, runtime: SequencerRuntimeState, currentSlot: SequencerCheckpointSlot | undefined, sequence: number, updatedAt: number): SequencerCheckpoint {
	const { meridianTransitAt, mountRiskObservation } = runtime
	// `Object.fromEntries` defines own properties, so any group id (even `__proto__`) is a plain key.
	const capture = Object.fromEntries(Array.from(runtime.capture, ([groupId, counters]) => [groupId, { ...counters }]))

	return {
		version: 1,
		sessionId,
		configurationId: configuration.id,
		configurationRevision: configuration.revision,
		capture,
		scheduler: structuredClone(runtime.scheduler),
		anchors: structuredClone(runtime.anchors),
		intents: { ...runtime.intents },
		focus: { ...runtime.focus },
		meridianFlipAttempts: runtime.meridianFlipAttempts,
		...(meridianTransitAt !== undefined && { meridianTransitAt }),
		...(mountRiskObservation !== undefined && { mountRiskObservation: { ...mountRiskObservation } }),
		...(currentSlot !== undefined && { currentSlot: { ...currentSlot } }),
		consecutiveDiscards: runtime.consecutiveDiscards,
		sequence,
		updatedAt,
	}
}

// Replaces the persisted part of a runtime state with a checkpoint of the same configuration, in place, as a deep
// copy that never aliases the checkpoint: progress (a configured group missing from it counts zero, a group the
// configuration lacks is dropped), scheduler, anchors, intents, focus baseline, meridian counters and consecutive
// discards. The current slot and the runtime-only state (meridian flip phase, acquired target) are left to the
// caller, which resolves the slot against the configuration and rebuilds the rest on a restart.
export function applySequencerCheckpoint(runtime: SequencerRuntimeState, configuration: SequencerConfiguration, checkpoint: SequencerCheckpoint) {
	runtime.capture = createSequencerCaptureProgress(configuration)

	for (const [groupId, counters] of runtime.capture) {
		if (!Object.hasOwn(checkpoint.capture, groupId)) continue
		const { accepted, forced, discarded, skipped } = checkpoint.capture[groupId]
		Object.assign(counters, { accepted, forced, discarded, skipped })
	}

	runtime.scheduler = structuredClone(checkpoint.scheduler)
	runtime.anchors = structuredClone(checkpoint.anchors)
	runtime.intents = { ...checkpoint.intents }
	runtime.focus = { ...checkpoint.focus }
	runtime.meridianFlipAttempts = checkpoint.meridianFlipAttempts
	runtime.meridianTransitAt = checkpoint.meridianTransitAt
	runtime.mountRiskObservation = checkpoint.mountRiskObservation === undefined ? undefined : { ...checkpoint.mountRiskObservation }
	runtime.consecutiveDiscards = checkpoint.consecutiveDiscards
}

// Known focus offset of a filter, in steps: 0 for the reference, the configured entry otherwise. A filter without
// an entry (an opaque slot, an uncalibrated filter) or an absent name has no known offset and returns undefined,
// never 0.
export function focusOffsetOf(offsets: SequencerFilterFocusOffsets, filter: string | undefined) {
	if (filter === undefined) return undefined
	if (filter === offsets.reference) return 0
	return Object.hasOwn(offsets.offsets, filter) ? offsets.offsets[filter] : undefined
}

// Derives the focus baseline once, from the physical state read before anything moved: the name of the filter
// the wheel is on (undefined when unnamed or without wheel) and the focuser position in steps. A filter with a
// known offset gives `known` under the documented premise that the focuser was left in focus for it; any other
// filter gives `unknown`. Only `unset` is derived; `known` and `unknown` are returned unchanged, so a restart
// never re-derives.
export function bootstrapFocusBaseline(baseline: SequencerFocusBaseline, offsets: SequencerFilterFocusOffsets, filter: string | undefined, focuserPosition: number): SequencerFocusBaseline {
	if (baseline.kind !== 'unset') return baseline
	const offset = focusOffsetOf(offsets, filter)
	return offset === undefined ? { kind: 'unknown' } : { kind: 'known', referencePosition: focuserPosition - offset }
}

// Absolute focuser position (steps) of a filter: `referencePosition + offset[filter]`. Undefined when the
// baseline is not known or the filter has no known offset, in which case the focuser is not commanded. The same
// call is correct before a crash, after it and repeated, unlike a relative delta.
export function focusPositionFor(baseline: SequencerFocusBaseline, offsets: SequencerFilterFocusOffsets, filter: string | undefined) {
	if (baseline.kind !== 'known') return undefined
	const offset = focusOffsetOf(offsets, filter)
	return offset === undefined ? undefined : baseline.referencePosition + offset
}

// Baseline after a successful autofocus that found `bestPosition` (steps) through `filter`, also leaving
// `unknown`. Undefined when the filter has no known offset, which the preflight forbids for light and dedicated
// autofocus filters.
export function focusBaselineAfterAutofocus(offsets: SequencerFilterFocusOffsets, filter: string | undefined, bestPosition: number): SequencerFocusBaseline | undefined {
	const offset = focusOffsetOf(offsets, filter)
	return offset === undefined ? undefined : { kind: 'known', referencePosition: bestPosition - offset }
}

// Whether a frame requires an autofocus because the focus baseline is unknown (`focusBaselineUnknown`): only
// LIGHT frames do; darks and biases proceed. No anchor suppresses it.
export function focusBaselineRequiresAutofocus(baseline: SequencerFocusBaseline, frameType: FrameType) {
	return baseline.kind === 'unknown' && frameType === 'LIGHT'
}

// One recorded safety change. Runtime-only, never persisted.
export interface SequencerSafetyTransition {
	// `clock.monotonicNow()` when the snapshot was received, in ms; never a wall instant.
	readonly receivedMonotonic: number
	// State from that instant on.
	readonly state: SequencerSafetyState
}

// Read-only view of the bounded safety history: the initial state recorded at subscription, then one entry per
// state change, in non-decreasing `receivedMonotonic` order. Older entries are evicted first.
export interface SequencerSafetyHistory {
	// Retained transitions, oldest first.
	readonly transitions: readonly SequencerSafetyTransition[]
}

// Classification of an exposure window against the safety history.
// - safe: the window is covered and never unsafe;
// - unsafe: the window is covered and unsafe (or unknown with `unknownIsUnsafe`) at some instant;
// - truncated: the history no longer holds the state in force at the start of the window, so the window counts
//   as unsafe (fail-closed).
export type SequencerSafetyVerdict = 'safe' | 'unsafe' | 'truncated'

// Classifies the closed monotonic window [from, to] (ms, normally exposure dispatch to exposure end) against the
// safety history: the state in force at `from` (the last transition received at or before it) and every
// transition in (from, to]. A transition exactly at `to` counts. When no retained transition is at or before
// `from` (evicted, or the window starts before the subscription) the coverage is incomplete and the verdict is
// 'truncated'. O(log n + k) for n retained transitions and k inside the window; allocates nothing.
export function safetyUnsafeWithin(history: SequencerSafetyHistory, from: number, to: number, unknownIsUnsafe: boolean): SequencerSafetyVerdict {
	const { transitions } = history

	// Last index whose receivedMonotonic ≤ from; equal instants resolve to the later entry, the one in force.
	let low = 0
	let high = transitions.length

	while (low < high) {
		const middle = (low + high) >>> 1
		if (transitions[middle].receivedMonotonic <= from) low = middle + 1
		else high = middle
	}

	if (low === 0) return 'truncated'

	for (let i = low - 1; i < transitions.length && (i === low - 1 || transitions[i].receivedMonotonic <= to); i++) {
		const { state } = transitions[i]
		if (state === 'unsafe' || (state === 'unknown' && unknownIsUnsafe)) return 'unsafe'
	}

	return 'safe'
}
