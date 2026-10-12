import type { SequencerActionAnchor, SequencerRecenterConfiguration, SequencerTriggerAnchors } from './sequencer'
import type { SequencerRuntimeState } from './state'

// Pure trigger predicates of the Sequencer and the anchors they read. A periodic action is due by the light exposures
// completed since its last success (accepted or discarded lights; darks and biases never count) or by the time elapsed
// since it. Persisted anchors hold the wall instant of the last success (Unix ms); elapsed time is always measured in
// the monotonic domain of the process, from a runtime anchor derived once per process from the persisted wall one, so
// a wall-clock step never fires nor suppresses a trigger. An anchor advances only after its action succeeded.
// Durations of the configuration are seconds; runtime anchors and elapsed times are milliseconds. Nothing here touches
// devices or clocks: callers pass the instants.

// Periodic action with an anchor of its own.
export type SequencerAnchoredAction = 'autofocus' | 'dither' | 'recenter'

// Runtime-only monotonic instants (ms of the process) of the last success of each action, never persisted. Absent
// until the action succeeded in this process or was derived from a persisted anchor.
export type SequencerElapsedAnchors = Partial<Record<SequencerAnchoredAction, number>>

// A persisted anchor that lies in the future of the wall clock, by `deltaMs` > 0; its age is taken as 0.
export interface SequencerWallClockAnomaly {
	// Anchor of the anomaly.
	readonly anchor: SequencerAnchoredAction
	// How far in the future the persisted instant is, in ms.
	readonly deltaMs: number
}

// Actions whose persisted anchors are bootstrapped.
const ANCHORED_ACTIONS: readonly SequencerAnchoredAction[] = ['autofocus', 'dither', 'recenter']

// Derives, once per process, the monotonic anchor of every action that succeeded in an earlier process: its age is
// `max(0, wallNow − lastSuccessfulAt)` and its monotonic instant `monotonicNow − age`. Mutates `runtime.elapsedAnchors`
// in place; an action already anchored in this process is left as is. Returns the anchors found in the future of the
// wall clock (age 0), each once, for the `wallClockAnomaly` event.
export function bootstrapSequencerElapsedAnchors(runtime: Pick<SequencerRuntimeState, 'anchors' | 'elapsedAnchors'>, wallNow: number, monotonicNow: number) {
	const anomalies: SequencerWallClockAnomaly[] = []

	for (const action of ANCHORED_ACTIONS) {
		const { lastSuccessfulAt } = runtime.anchors[action]
		if (lastSuccessfulAt === undefined || runtime.elapsedAnchors[action] !== undefined) continue
		const age = wallNow - lastSuccessfulAt
		if (age < 0) anomalies.push({ anchor: action, deltaMs: -age })
		runtime.elapsedAnchors[action] = monotonicNow - Math.max(0, age)
	}

	return anomalies
}

// Time since the last success of `action`, in ms of the monotonic domain; undefined when it never succeeded.
export function sequencerElapsedSince(runtime: Pick<SequencerRuntimeState, 'elapsedAnchors'>, action: SequencerAnchoredAction, monotonicNow: number) {
	const anchor = runtime.elapsedAnchors[action]
	return anchor === undefined ? undefined : monotonicNow - anchor
}

// Light exposures completed since the last success of an action.
export function lightExposuresSince(anchors: Pick<SequencerTriggerAnchors, 'lightExposures'>, anchor: SequencerActionAnchor) {
	return anchors.lightExposures - anchor.lightExposures
}

// Whether the periodic recenter is due: `afterFrames` light exposures since the last successful recenter (exactly at
// N), or `interval` seconds elapsed since it (`elapsed`, in ms, at or past the interval). Without a configuration, or
// before any successful recenter for the interval, it is never due.
export function recenterDue(configuration: SequencerRecenterConfiguration | undefined, anchors: Pick<SequencerTriggerAnchors, 'lightExposures' | 'recenter'>, elapsed: number | undefined) {
	if (configuration === undefined) return false
	const { afterFrames, interval } = configuration
	if (afterFrames !== undefined && lightExposuresSince(anchors, anchors.recenter) >= afterFrames) return true
	return interval !== undefined && elapsed !== undefined && elapsed >= interval * 1000
}

// Advances the anchor of `action` after it succeeded, in place: its light exposures to the current count, its wall
// instant to `wallNow` (Unix ms, persisted) and its runtime monotonic instant to `monotonicNow` (ms), the same instant
// in both domains. The caller persists the checkpoint afterwards.
export function recordSequencerActionSuccess(runtime: Pick<SequencerRuntimeState, 'anchors' | 'elapsedAnchors'>, action: SequencerAnchoredAction, wallNow: number, monotonicNow: number) {
	const anchor = runtime.anchors[action]
	anchor.lightExposures = runtime.anchors.lightExposures
	anchor.lastSuccessfulAt = wallNow
	runtime.elapsedAnchors[action] = monotonicNow
}
