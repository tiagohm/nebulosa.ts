import type { SequencerActionAnchor, SequencerAutofocusTriggers, SequencerDitherConfiguration, SequencerIntents, SequencerRecenterConfiguration, SequencerTriggerAnchors } from './sequencer'
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

// Whether the periodic dither is due before a LIGHT frame: `afterFrames` light exposures (accepted or discarded) since
// the last successful dither, exactly at N. Never before the first light of the session (no light exposed), nor before a
// light was exposed after the last motion of the mount for the target (`heldAt`, the light exposures at that motion):
// the first light after an acquisition, a recenter or a flip is never dithered, and the due dither runs before the next
// one. Pure.
export function ditherDue(configuration: Pick<SequencerDitherConfiguration, 'afterFrames'>, anchors: Pick<SequencerTriggerAnchors, 'lightExposures' | 'dither'>, heldAt: number | undefined) {
	if (anchors.lightExposures === 0) return false
	if (heldAt !== undefined && anchors.lightExposures <= heldAt) return false
	return lightExposuresSince(anchors, anchors.dither) >= configuration.afterFrames
}

// Records, in place, that the mount just moved for the target (acquisition, recenter, meridian flip), so no dither runs
// before the next light was exposed.
export function holdSequencerDither(runtime: Pick<SequencerRuntimeState, 'anchors' | 'ditherHeldAt'>) {
	runtime.ditherHeldAt = runtime.anchors.lightExposures
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

// Physical and runtime facts the autofocus triggers of one LIGHT frame read, gathered once by the caller.
export interface SequencerAutofocusObservation {
	// Name of the filter in place for the light; undefined without a wheel or an unnamed slot.
	readonly filter?: string
	// Focuser temperature, in °C; undefined when the focuser publishes none.
	readonly temperature?: number
	// Time since the last successful autofocus, in ms of the monotonic domain; undefined before the first one.
	readonly elapsed?: number
	// Whether the session resumed (`resume()` or a restart) since the last successful autofocus.
	readonly resumed: boolean
	// Whether the session completed a meridian flip since the last successful autofocus.
	readonly flipped: boolean
}

// Whether an autofocus is due before a LIGHT frame (section 20.6) by any enabled trigger: a pending autofocus intent;
// `onStart` before the first light of the session (no light exposed and no autofocus yet); `afterResume` and `afterFlip`
// after a resume or a completed flip; `onFilterChange` when the filter in place differs from the one of the last
// autofocus; `afterFrames` light exposures (accepted or discarded) since it, exactly at N; `interval` seconds elapsed
// since it (`elapsed` in ms, at or past the interval); `temperatureDelta` °C of focuser temperature change since it, at
// or past the delta. The filter, interval and temperature triggers are never due before a first success. The unknown
// focus baseline (`focusBaselineUnknown`) is not a trigger of this predicate: no anchor suppresses it. Pure.
export function autofocusDue(triggers: SequencerAutofocusTriggers, anchors: Pick<SequencerTriggerAnchors, 'lightExposures' | 'autofocus'>, intents: Pick<SequencerIntents, 'autofocus'>, observation: SequencerAutofocusObservation) {
	if (intents.autofocus) return true

	const anchor = anchors.autofocus
	const { onStart, afterResume, afterFlip, onFilterChange, afterFrames, interval, temperatureDelta } = triggers

	if (onStart && anchor.lastSuccessfulAt === undefined && anchors.lightExposures === 0) return true
	if (afterResume && observation.resumed) return true
	if (afterFlip && observation.flipped) return true
	if (onFilterChange && anchor.filter !== undefined && observation.filter !== anchor.filter) return true
	if (afterFrames !== undefined && lightExposuresSince(anchors, anchor) >= afterFrames) return true
	if (interval !== undefined && observation.elapsed !== undefined && observation.elapsed >= interval * 1000) return true
	return temperatureDelta !== undefined && anchor.temperature !== undefined && observation.temperature !== undefined && Math.abs(observation.temperature - anchor.temperature) >= temperatureDelta
}

// Advances every autofocus trigger after a successful autofocus, in place: the anchor (light exposures, wall instant
// `wallNow` in Unix ms, monotonic instant `monotonicNow` in ms), the focuser `temperature` (°C) and the light `filter` it
// ran for (removed when undefined), the cleared autofocus intent and the resume and flip facts. The caller persists the
// checkpoint afterwards, with the focus baseline the same autofocus produced.
export function recordSequencerAutofocusSuccess(runtime: Pick<SequencerRuntimeState, 'anchors' | 'elapsedAnchors' | 'intents' | 'resumedSinceAutofocus' | 'flippedSinceAutofocus'>, filter: string | undefined, temperature: number | undefined, wallNow: number, monotonicNow: number) {
	recordSequencerActionSuccess(runtime, 'autofocus', wallNow, monotonicNow)
	const anchor = runtime.anchors.autofocus

	if (filter === undefined) delete anchor.filter
	else anchor.filter = filter

	if (temperature === undefined) delete anchor.temperature
	else anchor.temperature = temperature

	runtime.intents.autofocus = false
	runtime.resumedSinceAutofocus = false
	runtime.flippedSinceAutofocus = false
}
