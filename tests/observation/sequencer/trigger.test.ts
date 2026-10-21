import { describe, expect, test } from 'bun:test'
import type { SequencerAutofocusTriggers, SequencerConfiguration } from '../../../src/observation/sequencer/sequencer'
import { createSequencerRuntimeState } from '../../../src/observation/sequencer/state'
// oxfmt-ignore
import { autofocusDue, bootstrapSequencerElapsedAnchors, lightExposuresSince, recenterDue, recordSequencerActionSuccess, recordSequencerAutofocusSuccess, type SequencerAutofocusObservation, sequencerElapsedSince } from '../../../src/observation/sequencer/trigger'
import { ManualClock } from '../../util/rig'

// Pure trigger predicates and anchors: the periodic recenter by light exposures and by elapsed monotonic time, the
// autofocus triggers, the success that advances an anchor, and the bootstrap of the runtime anchors of a resumed session.

const CONFIGURATION: SequencerConfiguration = {
	schemaVersion: 1,
	id: 'triggers',
	revision: 1,
	name: 'Triggers',
	capture: { order: 'sequential', groups: [], retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
	startup: { onFailure: 'fail' },
	shutdown: { stepTimeout: 30, totalTimeout: 300 },
	execution: { compensation: { timeout: 30 } },
}

describe('recenter', () => {
	test('due exactly after afterFrames light exposures since the last success, not one before', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		runtime.anchors.lightExposures = 7
		runtime.anchors.recenter.lightExposures = 3

		expect(lightExposuresSince(runtime.anchors, runtime.anchors.recenter)).toBe(4)
		expect(recenterDue({ afterFrames: 4 }, runtime.anchors, undefined)).toBeTrue()
		expect(recenterDue({ afterFrames: 5 }, runtime.anchors, undefined)).toBeFalse()
		expect(recenterDue(undefined, runtime.anchors, 1e12)).toBeFalse()
	})

	test('due once interval seconds elapsed (at the limit), never before a first success', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		expect(recenterDue({ interval: 600 }, runtime.anchors, undefined)).toBeFalse()
		expect(recenterDue({ interval: 600 }, runtime.anchors, 599_999)).toBeFalse()
		expect(recenterDue({ interval: 600 }, runtime.anchors, 600_000)).toBeTrue()
	})

	test('a success advances the light exposures, the wall instant and the monotonic anchor together; elapsed ignores the wall clock', () => {
		const clock = new ManualClock(Date.UTC(2026, 0, 1), 5000)
		const runtime = createSequencerRuntimeState(CONFIGURATION, clock.wallNow())
		runtime.anchors.lightExposures = 12

		recordSequencerActionSuccess(runtime, 'recenter', clock.wallNow(), clock.monotonicNow())
		expect(runtime.anchors.recenter).toEqual({ lightExposures: 12, lastSuccessfulAt: Date.UTC(2026, 0, 1) })
		expect(runtime.elapsedAnchors.recenter).toBe(5000)
		expect(runtime.anchors.dither).toEqual({ lightExposures: 0 })

		clock.jumpWall(2 * 3_600_000)
		void clock.advance(30 * 60_000)
		clock.jumpWall(-5 * 3_600_000)
		expect(sequencerElapsedSince(runtime, 'recenter', clock.monotonicNow())).toBe(30 * 60_000)
		expect(sequencerElapsedSince(runtime, 'dither', clock.monotonicNow())).toBeUndefined()
		expect(recenterDue({ interval: 3600 }, runtime.anchors, sequencerElapsedSince(runtime, 'recenter', clock.monotonicNow()))).toBeFalse()
	})
})

// Every autofocus trigger disabled.
const NO_TRIGGERS: SequencerAutofocusTriggers = { onStart: false, afterResume: false, afterFlip: false, onFilterChange: false }
// Observation of a light on L at 10 °C, 1 s after the last autofocus, without resume or flip.
const OBSERVED: SequencerAutofocusObservation = { filter: 'L', temperature: 10, elapsed: 1000, resumed: false, flipped: false }

describe('autofocus', () => {
	test('first frame: due before the first light of the session, never once a light was exposed or an autofocus succeeded', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const triggers = { ...NO_TRIGGERS, onStart: true }
		const fresh = { ...OBSERVED, elapsed: undefined }

		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, fresh)).toBeTrue()
		expect(autofocusDue(NO_TRIGGERS, runtime.anchors, runtime.intents, fresh)).toBeFalse()

		runtime.anchors.lightExposures = 1
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, fresh)).toBeFalse()

		runtime.anchors.lightExposures = 0
		recordSequencerAutofocusSuccess(runtime, 'L', 10, 1000, 1000)
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, OBSERVED)).toBeFalse()
	})

	test('every N light exposures, accepted or discarded, exactly at N since the last success', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const triggers = { ...NO_TRIGGERS, afterFrames: 3 }
		runtime.anchors.autofocus.lightExposures = 4
		runtime.anchors.lightExposures = 6

		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, OBSERVED)).toBeFalse()
		runtime.anchors.lightExposures = 7
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, OBSERVED)).toBeTrue()
	})

	test('elapsed time at or past the interval, never before a first success', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const triggers = { ...NO_TRIGGERS, interval: 1800 }

		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, elapsed: undefined })).toBeFalse()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, elapsed: 1_799_999 })).toBeFalse()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, elapsed: 1_800_000 })).toBeTrue()
	})

	test('focuser temperature change at or past the delta, either way, only against a measured anchor', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const triggers = { ...NO_TRIGGERS, temperatureDelta: 1.5 }

		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, temperature: -40 })).toBeFalse()

		recordSequencerAutofocusSuccess(runtime, 'L', 10, 1000, 1000)
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, temperature: 11.4 })).toBeFalse()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, temperature: 8.5 })).toBeTrue()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, temperature: 11.5 })).toBeTrue()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, temperature: undefined })).toBeFalse()
	})

	test('filter change against the filter of the last autofocus, never before one', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const triggers = { ...NO_TRIGGERS, onFilterChange: true }

		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, filter: 'R' })).toBeFalse()

		recordSequencerAutofocusSuccess(runtime, 'L', undefined, 1000, 1000)
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, OBSERVED)).toBeFalse()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, filter: 'R' })).toBeTrue()
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, { ...OBSERVED, filter: undefined })).toBeTrue()
	})

	test('resume, flip and a pending intent', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		runtime.anchors.lightExposures = 5

		expect(autofocusDue({ ...NO_TRIGGERS, afterResume: true }, runtime.anchors, runtime.intents, { ...OBSERVED, resumed: true })).toBeTrue()
		expect(autofocusDue({ ...NO_TRIGGERS, afterResume: true }, runtime.anchors, runtime.intents, { ...OBSERVED, flipped: true })).toBeFalse()
		expect(autofocusDue({ ...NO_TRIGGERS, afterFlip: true }, runtime.anchors, runtime.intents, { ...OBSERVED, flipped: true })).toBeTrue()
		expect(autofocusDue(NO_TRIGGERS, runtime.anchors, runtime.intents, { ...OBSERVED, resumed: true, flipped: true })).toBeFalse()

		runtime.intents.autofocus = true
		expect(autofocusDue(NO_TRIGGERS, runtime.anchors, runtime.intents, OBSERVED)).toBeTrue()
	})

	test('one success satisfies every trigger at once: anchor, temperature, filter, intent, resume and flip', () => {
		const clock = new ManualClock(Date.UTC(2026, 0, 1), 7000)
		const runtime = createSequencerRuntimeState(CONFIGURATION, clock.wallNow())
		const triggers: SequencerAutofocusTriggers = { onStart: true, afterResume: true, afterFlip: true, onFilterChange: true, afterFrames: 2, interval: 600, temperatureDelta: 1 }
		runtime.anchors.lightExposures = 9
		runtime.anchors.autofocus = { lightExposures: 1, lastSuccessfulAt: 1, temperature: 2, filter: 'R' }
		runtime.intents.autofocus = true
		runtime.resumedSinceAutofocus = true
		runtime.flippedSinceAutofocus = true

		recordSequencerAutofocusSuccess(runtime, 'L', 10, clock.wallNow(), clock.monotonicNow())

		expect(runtime.anchors.autofocus).toEqual({ lightExposures: 9, lastSuccessfulAt: Date.UTC(2026, 0, 1), temperature: 10, filter: 'L' })
		expect(runtime.elapsedAnchors.autofocus).toBe(7000)
		expect(runtime).toMatchObject({ intents: { autofocus: false }, resumedSinceAutofocus: false, flippedSinceAutofocus: false })
		const observation = { ...OBSERVED, elapsed: sequencerElapsedSince(runtime, 'autofocus', clock.monotonicNow()) }
		expect(autofocusDue(triggers, runtime.anchors, runtime.intents, observation)).toBeFalse()

		// Without a temperature or a filter, the stale ones are removed rather than kept.
		recordSequencerAutofocusSuccess(runtime, undefined, undefined, clock.wallNow(), clock.monotonicNow())
		expect(runtime.anchors.autofocus).toEqual({ lightExposures: 9, lastSuccessfulAt: Date.UTC(2026, 0, 1) })
	})
})

describe('elapsed anchors', () => {
	test('a restart derives each monotonic anchor once from the age of its persisted wall instant', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const wallNow = Date.UTC(2026, 0, 1, 2)
		runtime.anchors.recenter.lastSuccessfulAt = wallNow - 3_600_000
		runtime.anchors.autofocus.lastSuccessfulAt = wallNow - 60_000
		runtime.elapsedAnchors.autofocus = 42

		expect(bootstrapSequencerElapsedAnchors(runtime, wallNow, 10_000_000)).toEqual([])
		expect(runtime.elapsedAnchors).toEqual({ recenter: 10_000_000 - 3_600_000, autofocus: 42 })
		expect(sequencerElapsedSince(runtime, 'recenter', 10_000_000)).toBe(3_600_000)
		// Once per process: a second bootstrap changes nothing.
		runtime.anchors.recenter.lastSuccessfulAt = wallNow
		expect(bootstrapSequencerElapsedAnchors(runtime, wallNow, 20_000_000)).toEqual([])
		expect(runtime.elapsedAnchors.recenter).toBe(10_000_000 - 3_600_000)
	})

	test('an anchor in the future of the wall clock has age 0 and is reported once', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, 0)
		const wallNow = Date.UTC(2026, 0, 1)
		runtime.anchors.dither.lastSuccessfulAt = wallNow + 3_600_000

		expect(bootstrapSequencerElapsedAnchors(runtime, wallNow, 500)).toEqual([{ anchor: 'dither', deltaMs: 3_600_000 }])
		expect(runtime.elapsedAnchors.dither).toBe(500)
		expect(bootstrapSequencerElapsedAnchors(runtime, wallNow, 600)).toEqual([])
	})
})
