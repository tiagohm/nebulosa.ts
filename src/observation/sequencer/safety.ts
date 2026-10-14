import { failedOperationResult, type OperationResult, successfulOperationResult } from '../../devices/orchestration/operation'
import { abortReason } from '../../devices/orchestration/operation.wait'
import { taskResult } from './lifecycle'
import type { SequencerFailedTaskResult, SequencerTask, SequencerTaskResult } from './runner'
import type { SequencerConfiguration, SequencerConfigurationDiagnostic, SequencerSafetyConfiguration, SequencerSafetySnapshot, SequencerSafetySource, SequencerTaskId } from './sequencer'
import { isSequencerSafetyBlocking } from './state'

// Safety gates of the Sequencer (sections 18, 20.1 and 32) over the read-only safety source of the caller. A gate is a
// task that reads `current()` synchronously: safe goes on at once; blocking ('unsafe', or 'unknown' with
// `unknownIsUnsafe`) never lets what follows it run. The startup gate precedes each opening (dome or roof, cover, mount
// unpark) and runs only when its opening will: it stops the session with a 'safety' failure (`onUnsafeAtStartup:
// 'stop'`) or waits until safe ('wait'); cooling and the track mode are never gated. The pre-capture gate is the first
// task of every frame: under `pauseAfterFrame` it waits until safe, under the other actions it stops the session. The
// waits are event-driven on the subscription of the source, with no timer and no polling, and end with the root of the
// task (a stop, a protection, a pause of the pre-capture). Freshness of the data is the source's: stale data arrives as
// 'unknown'. The reaction to a change while running (`unsafeAction`, the critical protection of `shutdownImmediately`)
// and the refusal of every dispatch while blocking belong to the runner.

// Startup tasks a safety gate precedes, the openings of the observatory.
export const SEQUENCER_SAFETY_GATED_TASKS: ReadonlySet<SequencerTaskId> = new Set<SequencerTaskId>(['openDome', 'openCover', 'unparkMount'])

// Whether `task` is an opening a safety gate precedes.
export function isSequencerSafetyGated(task: SequencerTaskId | undefined) {
	return task !== undefined && SEQUENCER_SAFETY_GATED_TASKS.has(task)
}

// Waits, event-driven, until `source` reports a state that does not block: it subscribes first, then reads `current()`
// (`subscribe` never replays the current state, so a change in between is never missed). Resolves ok once safe, or the
// reason of `signal` when it aborts first. Leaves neither subscription nor listener behind; no timer.
export async function waitForSequencerSafety(source: SequencerSafetySource, unknownIsUnsafe: boolean, signal: AbortSignal): Promise<OperationResult<void>> {
	if (signal.aborted) return failedOperationResult(abortReason(signal))

	const done = Promise.withResolvers<OperationResult<void>>()
	const onAbort = () => done.resolve(failedOperationResult(abortReason(signal)))

	const onSnapshot = (snapshot: SequencerSafetySnapshot) => {
		if (!isSequencerSafetyBlocking(snapshot.state, unknownIsUnsafe)) done.resolve(successfulOperationResult(undefined))
	}

	signal.addEventListener('abort', onAbort, { once: true })
	const unsubscribe = source.subscribe(onSnapshot)

	try {
		onSnapshot(source.current())
		return await done.promise
	} finally {
		signal.removeEventListener('abort', onAbort)
		unsubscribe()
	}
}

// Startup task `safetyGate` right before `opening` (section 18), run only when the opening will run. Blocking: 'stop'
// fails it with a 'safety' failure, whose action stops the session gracefully (the shutdown closes what was already
// opened); 'wait' waits until safe, cancellable by its root, after which the opening runs.
export function startupSafetyGateTask(source: SequencerSafetySource, safety: SequencerSafetyConfiguration, opening: SequencerTask): SequencerTask {
	return {
		id: 'safetyGate',
		shouldRun: (view) => opening.shouldRun(view),
		run: async (context) => {
			const snapshot = source.current()
			if (!isSequencerSafetyBlocking(snapshot.state, safety.unknownIsUnsafe)) return DONE
			if (safety.onUnsafeAtStartup === 'stop') return safetyFailure(snapshot)
			return taskResult(await waitForSequencerSafety(source, safety.unknownIsUnsafe, context.signal))
		},
		policy: STOP_POLICY,
	}
}

// Pre-capture task `safetyGate`, the first of every frame (section 20.1): no preparation and no exposure while blocking.
// Under `pauseAfterFrame` it waits until safe, cancellable by its root (a stop, a protection, a pause request); under
// `stopAfterFrame` and `shutdownImmediately` it fails with a 'safety' failure, whose action stops the session gracefully
// (nothing is in flight at a safe point).
export function safetyGateTask(source: SequencerSafetySource, safety: SequencerSafetyConfiguration): SequencerTask {
	return {
		id: 'safetyGate',
		shouldRun: () => true,
		run: async (context) => {
			const snapshot = source.current()
			if (!isSequencerSafetyBlocking(snapshot.state, safety.unknownIsUnsafe)) return DONE
			if (safety.unsafeAction !== 'pauseAfterFrame') return safetyFailure(snapshot)
			return taskResult(await waitForSequencerSafety(source, safety.unknownIsUnsafe, context.signal))
		},
		policy: STOP_POLICY,
	}
}

// Startup tasks with a safety gate right before each opening, in their order (section 42); `tasks` as given without a
// safety policy or a source.
export function sequencerSafetyStartupTasks(tasks: readonly SequencerTask[], safety: SequencerSafetyConfiguration | undefined, source: SequencerSafetySource | undefined): SequencerTask[] {
	if (safety === undefined || source === undefined) return [...tasks]
	return tasks.flatMap((task) => (isSequencerSafetyGated(task.id) ? [startupSafetyGateTask(source, safety, task), task] : [task]))
}

// Safety tasks of the pre-capture, first in its list (section 42): the gate, with a safety policy and a source.
export function sequencerSafetyTasks(safety: SequencerSafetyConfiguration | undefined, source: SequencerSafetySource | undefined): SequencerTask[] {
	return safety === undefined || source === undefined ? [] : [safetyGateTask(source, safety)]
}

// Safety part of the runtime preflight (sections 13 and 41.2) against the services of the caller; it never commands. A
// safety policy needs a safety source, and so does a group that discards by `unsafeDuringExposure` (otherwise no window
// is covered and every light would be discarded). Every problem is a diagnostic of the configuration path it concerns.
export function preflightSequencerSafety(configuration: Pick<SequencerConfiguration, 'safety' | 'capture'>, services: { readonly safety?: SequencerSafetySource }): SequencerConfigurationDiagnostic[] {
	if (services.safety !== undefined) return []

	const diagnostics: SequencerConfigurationDiagnostic[] = []
	if (configuration.safety !== undefined) diagnostics.push({ path: 'safety', message: 'requires a safety source' })

	for (const [i, group] of configuration.capture.groups.entries()) {
		if (group.enabled && group.discard?.criteria.unsafeDuringExposure === true) diagnostics.push({ path: `capture.groups[${i}].discard.criteria.unsafeDuringExposure`, message: 'requires a safety source' })
	}

	return diagnostics
}

const DONE: SequencerTaskResult = { ok: true }

// A blocking gate stops the session, never retried (a 'safety' failure is not an operation failure).
const STOP_POLICY = { onFailure: 'stop' } as const

// 'safety' failure of a blocking gate.
function safetyFailure(snapshot: SequencerSafetySnapshot): SequencerFailedTaskResult {
	return { ok: false, failure: { kind: 'safety', detail: snapshot.detail ?? `safety is ${snapshot.state}` } }
}
