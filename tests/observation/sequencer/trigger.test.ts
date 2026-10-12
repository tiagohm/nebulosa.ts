import { describe, expect, test } from 'bun:test'
import type { SequencerConfiguration } from '../../../src/observation/sequencer/sequencer'
import { createSequencerRuntimeState } from '../../../src/observation/sequencer/state'
import { bootstrapSequencerElapsedAnchors, lightExposuresSince, recenterDue, recordSequencerActionSuccess, sequencerElapsedSince } from '../../../src/observation/sequencer/trigger'
import { ManualSequencerClock } from './util'

// Pure trigger predicates and anchors: the periodic recenter by light exposures and by elapsed monotonic time, the
// success that advances an anchor, and the bootstrap of the runtime anchors of a resumed session.

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
		const clock = new ManualSequencerClock(Date.UTC(2026, 0, 1), 5000)
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
