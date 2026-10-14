import { describe, expect, test } from 'bun:test'
import type { SequencerCameraCapture, SequencerConfiguration, SequencerDiscardCriteria, SequencerFilterFocusOffsets, SequencerFrameDiscardPolicy, SequencerFrameSlot, SequencerSessionState } from '../../../src/observation/sequencer/sequencer'
// oxfmt-ignore
import { applyCorrectiveIntents, applySequencerCheckpoint, bootstrapFocusBaseline, canTransitionSequencerState, classifySequencerFrame, createSequencerRuntimeState, decideFrameOutcome, exhaustedDiscardAction, focusBaselineAfterAutofocus, focusBaselineRequiresAutofocus, focusOffsetOf, focusPositionFor, isTerminalSequencerState, recordSequencerSafetyTransition, requestSequencerPause, requestSequencerResume, requestSequencerStop, type SequencerFrameEvidence, type SequencerSafetyHistory, type SequencerSafetyTransition, safetyUnsafeWithin, sequencerCheckpointOf, sequencerSnapshot, shouldHoldSequencer, transitionSequencerState } from '../../../src/observation/sequencer/state'

const LIGHT: SequencerCameraCapture = { exposureTime: 60, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 0, offset: 0, compressed: false }

const CONFIGURATION: SequencerConfiguration = {
	schemaVersion: 1,
	id: 'session',
	revision: 1,
	name: 'Session',
	capture: {
		order: 'roundRobin',
		groups: [
			{ kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count: 10 },
			{ kind: 'scheduled', id: 'R', enabled: false, capture: LIGHT, count: 5 },
			{ kind: 'triggered', id: 'dark', enabled: true, capture: { ...LIGHT, frameType: 'DARK' }, trigger: { kind: 'afterFrames', frames: 3 }, batchSize: 1, maxFrames: 4, inherit: 'triggeringFrame', opticalPath: { kind: 'cover' } },
		],
		retry: { maxAttempts: 2, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] },
		onFailure: 'fail',
		cameraRecovery: { onTimeout: 'stop' },
	},
	startup: { onFailure: 'stop' },
	shutdown: { stepTimeout: 30, totalTimeout: 300 },
	execution: { compensation: { timeout: 30 } },
}

const STARTED_AT = Date.UTC(2026, 9, 11, 22)

const STATES: readonly SequencerSessionState[] = ['starting', 'running', 'paused', 'stopping', 'shuttingDown', 'completed', 'stopped', 'failed']

describe('session state machine', () => {
	test('follows starting → running ⇄ paused → stopping → shuttingDown → terminal', () => {
		const allowed = new Set([
			'starting>running',
			'starting>stopping',
			'starting>shuttingDown',
			'starting>stopped',
			'starting>failed',
			'running>paused',
			'running>stopping',
			'running>shuttingDown',
			'paused>running',
			'paused>stopping',
			'paused>shuttingDown',
			'stopping>shuttingDown',
			'stopping>stopped',
			'stopping>failed',
			'shuttingDown>completed',
			'shuttingDown>stopped',
			'shuttingDown>failed',
		])

		for (const from of STATES) {
			for (const to of STATES) {
				expect(canTransitionSequencerState(from, to)).toBe(allowed.has(`${from}>${to}`))
			}
		}
	})

	test('terminal states are completed, stopped and failed', () => {
		expect(STATES.filter(isTerminalSequencerState)).toEqual(['completed', 'stopped', 'failed'])
	})

	test('never goes back from shuttingDown to running, nor reopens a terminal session', () => {
		expect(canTransitionSequencerState('shuttingDown', 'running')).toBe(false)
		expect(canTransitionSequencerState('stopping', 'running')).toBe(false)
		expect(canTransitionSequencerState('completed', 'running')).toBe(false)
		expect(canTransitionSequencerState('failed', 'shuttingDown')).toBe(false)
	})

	test('a transition stamps the wall instant and a terminal one clears phase and task', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		transitionSequencerState(runtime, 'running', STARTED_AT + 1000)
		runtime.phase = 'preCapture'
		runtime.task = 'autofocus'
		expect(runtime).toMatchObject({ state: 'running', updatedAt: STARTED_AT + 1000, phase: 'preCapture', task: 'autofocus' })

		transitionSequencerState(runtime, 'shuttingDown', STARTED_AT + 2000)
		transitionSequencerState(runtime, 'completed', STARTED_AT + 3000)
		expect(runtime.state).toBe('completed')
		expect(runtime.phase).toBeUndefined()
		expect(runtime.task).toBeUndefined()
		expect(runtime.updatedAt).toBe(STARTED_AT + 3000)
	})

	test('an illegal transition is a logic bug and leaves the state untouched', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		expect(() => transitionSequencerState(runtime, 'paused', STARTED_AT + 1)).toThrow(RangeError)
		expect(() => transitionSequencerState(runtime, 'starting', STARTED_AT + 1)).toThrow(RangeError)
		expect(runtime.state).toBe('starting')
		expect(runtime.updatedAt).toBe(STARTED_AT)
	})
})

describe('controls', () => {
	test('pause is pending until resumed and resume is accepted only for a pending pause', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		transitionSequencerState(runtime, 'running', STARTED_AT)

		expect(requestSequencerResume(runtime)).toBe(false)
		expect(requestSequencerPause(runtime)).toBe(true)
		expect(requestSequencerPause(runtime)).toBe(true)
		expect(shouldHoldSequencer(runtime)).toBe(true)

		transitionSequencerState(runtime, 'paused', STARTED_AT)
		expect(requestSequencerResume(runtime)).toBe(true)
		expect(runtime.desired).toBe('running')
		expect(shouldHoldSequencer(runtime)).toBe(false)
		expect(requestSequencerResume(runtime)).toBe(false)
	})

	test('a pause requested during the startup is held at the first safe point', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		expect(requestSequencerPause(runtime)).toBe(true)
		expect(shouldHoldSequencer(runtime)).toBe(true)
	})

	test('stop is idempotent, escalates from graceful to immediate and cancels a pending pause', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		transitionSequencerState(runtime, 'running', STARTED_AT)
		requestSequencerPause(runtime)

		expect(requestSequencerStop(runtime, 'graceful')).toBe(true)
		expect(runtime).toMatchObject({ stop: 'graceful', desired: 'running' })
		expect(shouldHoldSequencer(runtime)).toBe(false)
		expect(requestSequencerStop(runtime, 'graceful')).toBe(false)
		expect(requestSequencerStop(runtime, 'immediate')).toBe(true)
		expect(requestSequencerStop(runtime, 'graceful')).toBe(false)
		expect(requestSequencerStop(runtime, 'immediate')).toBe(false)
		expect(runtime.stop).toBe('immediate')

		// After a stop, pause and resume are refused.
		expect(requestSequencerPause(runtime)).toBe(false)
		expect(requestSequencerResume(runtime)).toBe(false)
	})

	test('stopping, shutting down and terminal sessions refuse pause and resume; terminal ones also stop', () => {
		for (const state of ['stopping', 'shuttingDown', 'completed', 'stopped', 'failed'] as const) {
			const runtime = { ...createSequencerRuntimeState(CONFIGURATION, STARTED_AT), state, desired: 'paused' as const }
			expect(requestSequencerPause(runtime)).toBe(false)
			expect(requestSequencerResume(runtime)).toBe(false)
			expect(requestSequencerStop(runtime, 'immediate')).toBe(!isTerminalSequencerState(state))
		}
	})
})

describe('logical state', () => {
	test('a new session starts with nothing captured, pending or anchored', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)

		expect(runtime).toMatchObject({ state: 'starting', desired: 'running', focus: { kind: 'unset' }, meridianFlipAttempts: 0, consecutiveDiscards: 0, targetAcquired: false, trackingStoppedForMeridianProtection: false, opticalPathClosed: false, compensations: [], startedAt: STARTED_AT, updatedAt: STARTED_AT })
		expect(runtime.intents).toEqual({ autofocus: false, recenter: false, recoverGuiding: false })
		expect(runtime.anchors).toEqual({ lightExposures: 0, autofocus: { lightExposures: 0 }, dither: { lightExposures: 0 }, recenter: { lightExposures: 0 }, calibration: { dark: { lightExposures: 0, batches: 0 } } })
		expect(runtime.meridianFlip).toEqual({ phase: 'WAITING', attempts: 0, preparationCompleted: false })
		expect(runtime.scheduler).toEqual({ credits: {}, batches: [], sessionStartQueued: false, sessionEndQueued: false })
		expect([...runtime.capture.keys()]).toEqual(['L', 'R', 'dark'])
		expect(runtime.capture.get('L')).toEqual({ accepted: 0, forced: 0, discarded: 0, skipped: 0 })
	})

	test('calibration anchors keep any group id as an own key', () => {
		const configuration = { ...CONFIGURATION, capture: { ...CONFIGURATION.capture, groups: [{ ...CONFIGURATION.capture.groups[2], id: '__proto__' }] } }
		const { calibration } = createSequencerRuntimeState(configuration, STARTED_AT).anchors
		expect(Object.hasOwn(calibration, '__proto__')).toBe(true)
		expect(Object.getPrototypeOf(calibration)).toBe(Object.prototype)
	})

	test('a checkpoint copies the persisted state deeply and restores it into a new runtime without aliasing', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		runtime.capture.get('L')!.accepted = 4
		runtime.scheduler.cursor = 'L'
		runtime.scheduler.batches.push({ groupId: 'dark', firstOrdinal: 1, size: 1, capture: { ...LIGHT, frameType: 'DARK' }, triggeredBy: 'frame[L][4]' })
		runtime.anchors.lightExposures = 4
		runtime.intents.recenter = true
		runtime.focus = { kind: 'known', referencePosition: 40000 }
		runtime.meridianFlipAttempts = 1
		runtime.meridianTransitAt = STARTED_AT + 3600000
		runtime.consecutiveDiscards = 2
		runtime.targetAcquired = true
		const slot = { id: 'frame[L][5]', attempt: 2, discardedTotal: 1, discardBudgetUsed: 1, captureFailures: 0 }

		const checkpoint = sequencerCheckpointOf('session-1', CONFIGURATION, runtime, slot, 7, STARTED_AT + 1)
		expect(checkpoint).toEqual({
			version: 1,
			sessionId: 'session-1',
			configurationId: 'session',
			configurationRevision: 1,
			capture: { L: { accepted: 4, forced: 0, discarded: 0, skipped: 0 }, R: { accepted: 0, forced: 0, discarded: 0, skipped: 0 }, dark: { accepted: 0, forced: 0, discarded: 0, skipped: 0 } },
			scheduler: runtime.scheduler,
			anchors: runtime.anchors,
			intents: { autofocus: false, recenter: true, recoverGuiding: false },
			focus: { kind: 'known', referencePosition: 40000 },
			meridianFlipAttempts: 1,
			meridianTransitAt: STARTED_AT + 3600000,
			currentSlot: slot,
			consecutiveDiscards: 2,
			sequence: 7,
			updatedAt: STARTED_AT + 1,
		})
		expect(checkpoint).not.toHaveProperty('mountRiskObservation')
		expect(JSON.parse(JSON.stringify(checkpoint))).toEqual(checkpoint)

		// The runtime keeps changing while the checkpoint is written.
		Object.assign(runtime.scheduler.batches[0], { size: 9 })
		runtime.anchors.lightExposures = 5
		runtime.capture.get('L')!.accepted = 5
		expect(checkpoint).toMatchObject({ scheduler: { batches: [{ size: 1 }] }, anchors: { lightExposures: 4 }, capture: { L: { accepted: 4 } } })

		const restored = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		applySequencerCheckpoint(restored, CONFIGURATION, checkpoint)
		expect(restored).toMatchObject({ scheduler: checkpoint.scheduler, anchors: checkpoint.anchors, intents: checkpoint.intents, focus: checkpoint.focus, meridianFlipAttempts: 1, meridianTransitAt: STARTED_AT + 3600000, consecutiveDiscards: 2, targetAcquired: false })
		expect(restored.capture.get('L')).toEqual({ accepted: 4, forced: 0, discarded: 0, skipped: 0 })
		expect(restored.currentFrame).toBeUndefined()
		Object.assign(restored.scheduler.batches[0], { size: 3 })
		restored.intents.autofocus = true
		expect(checkpoint).toMatchObject({ scheduler: { batches: [{ size: 1 }] }, intents: { autofocus: false } })
	})

	test('a checkpoint missing a configured group restores it at zero and drops groups the configuration lacks', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		const checkpoint = sequencerCheckpointOf('session-1', CONFIGURATION, runtime, undefined, 1, STARTED_AT)
		const { L } = checkpoint.capture
		applySequencerCheckpoint(runtime, CONFIGURATION, { ...checkpoint, capture: { L: { ...L, skipped: 2 }, gone: { ...L, accepted: 3 } } })

		expect([...runtime.capture.keys()]).toEqual(['L', 'R', 'dark'])
		expect(runtime.capture.get('L')).toEqual({ accepted: 0, forced: 0, discarded: 0, skipped: 2 })
		expect(runtime.capture.get('dark')).toEqual({ accepted: 0, forced: 0, discarded: 0, skipped: 0 })
		expect(checkpoint).not.toHaveProperty('currentSlot')
	})

	test('corrective intents only set, never clear', () => {
		const intents = createSequencerRuntimeState(CONFIGURATION, STARTED_AT).intents
		applyCorrectiveIntents(intents, { recenter: true })
		expect(intents).toEqual({ autofocus: false, recenter: true, recoverGuiding: false })
		applyCorrectiveIntents(intents, { recenter: false, autofocus: true })
		expect(intents).toEqual({ autofocus: true, recenter: true, recoverGuiding: false })
	})
})

describe('snapshot', () => {
	const slot: SequencerFrameSlot = { id: 'frame[dark][2]', groupId: 'dark', kind: 'triggered', ordinal: 2, attempt: 3, discardedTotal: 1, discardBudgetUsed: 1, captureFailures: 1, capture: { ...LIGHT, frameType: 'DARK' }, triggeredBy: 'frame[L][4]' }

	test('projects state, current frame, progress and intents without aliasing the runtime', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		transitionSequencerState(runtime, 'running', STARTED_AT + 10)
		runtime.phase = 'capture'
		runtime.task = 'captureFrame'
		runtime.currentFrame = slot
		runtime.capture.get('L')!.accepted = 4
		runtime.capture.get('L')!.forced = 1
		runtime.capture.get('L')!.discarded = 2
		runtime.capture.get('dark')!.skipped = 1
		runtime.intents.autofocus = true

		const snapshot = sequencerSnapshot('session-1', CONFIGURATION, runtime)

		expect(snapshot).toEqual({
			sessionId: 'session-1',
			state: 'running',
			phase: 'capture',
			task: 'captureFrame',
			currentFrame: { id: 'frame[dark][2]', groupId: 'dark', kind: 'triggered', ordinal: 2, attempt: 3, discardedTotal: 1, discardBudgetUsed: 1, captureFailures: 1, frameType: 'DARK', triggeredBy: 'frame[L][4]' },
			capture: {
				groups: [
					{ groupId: 'L', kind: 'scheduled', enabled: true, requested: 10, accepted: 4, forced: 1, discarded: 2, skipped: 0 },
					{ groupId: 'R', kind: 'scheduled', enabled: false, requested: 5, accepted: 0, forced: 0, discarded: 0, skipped: 0 },
					{ groupId: 'dark', kind: 'triggered', enabled: true, requested: 4, accepted: 0, forced: 0, discarded: 0, skipped: 1 },
				],
			},
			intents: { autofocus: true, recenter: false, recoverGuiding: false },
			startedAt: STARTED_AT,
			updatedAt: STARTED_AT + 10,
		})

		runtime.intents.autofocus = false
		runtime.capture.get('L')!.accepted = 5
		expect(snapshot.intents.autofocus).toBe(true)
		expect(snapshot.capture.groups[0].accepted).toBe(4)
	})

	test('omits absent optional fields and carries the failure of a terminal session', () => {
		const runtime = createSequencerRuntimeState(CONFIGURATION, STARTED_AT)
		runtime.failure = { kind: 'operation', reason: 'busy', detail: 'camera leased' }
		transitionSequencerState(runtime, 'failed', STARTED_AT + 5)

		const snapshot = sequencerSnapshot('session-2', CONFIGURATION, runtime)

		expect(Object.keys(snapshot).sort()).toEqual(['capture', 'failure', 'intents', 'sessionId', 'startedAt', 'state', 'updatedAt'])
		expect(snapshot.failure).toEqual({ kind: 'operation', reason: 'busy', detail: 'camera leased' })
		expect(snapshot.state).toBe('failed')
	})
})

describe('focus baseline', () => {
	// L is the reference; R and G are calibrated; Dark is an opaque slot without offset.
	const OFFSETS: SequencerFilterFocusOffsets = { reference: 'L', offsets: { R: 100, G: -40 } }

	test('known offsets: 0 for the reference, the entry otherwise, none for a filter without entry', () => {
		expect(focusOffsetOf(OFFSETS, 'L')).toBe(0)
		expect(focusOffsetOf(OFFSETS, 'R')).toBe(100)
		expect(focusOffsetOf(OFFSETS, 'G')).toBe(-40)
		expect(focusOffsetOf(OFFSETS, 'Dark')).toBeUndefined()
		expect(focusOffsetOf(OFFSETS, undefined)).toBeUndefined()
		expect(focusOffsetOf(OFFSETS, 'toString')).toBeUndefined()
	})

	test('49.8 5: calibrated bootstrap from R at 10100 gives known{10000} and the first L at 10000', () => {
		const baseline = bootstrapFocusBaseline({ kind: 'unset' }, OFFSETS, 'R', 10100)
		expect(baseline).toEqual({ kind: 'known', referencePosition: 10000 })
		expect(focusPositionFor(baseline, OFFSETS, 'L')).toBe(10000)
		expect(focusBaselineRequiresAutofocus(baseline, 'LIGHT')).toBe(false)
	})

	test('49.8 6: bootstrap from Dark is unknown; L moves no focuser, needs autofocus, and autofocus makes it known', () => {
		const baseline = bootstrapFocusBaseline({ kind: 'unset' }, OFFSETS, 'Dark', 10100)
		expect(baseline).toEqual({ kind: 'unknown' })

		// Going to L commands no focuser move; a light needs the autofocus, darks and biases do not.
		expect(focusPositionFor(baseline, OFFSETS, 'L')).toBeUndefined()
		expect(focusBaselineRequiresAutofocus(baseline, 'LIGHT')).toBe(true)
		expect(focusBaselineRequiresAutofocus(baseline, 'DARK')).toBe(false)
		expect(focusBaselineRequiresAutofocus(baseline, 'BIAS')).toBe(false)

		const focused = focusBaselineAfterAutofocus(OFFSETS, 'L', 10010)
		expect(focused).toEqual({ kind: 'known', referencePosition: 10010 })
		expect(focusPositionFor(focused!, OFFSETS, 'L')).toBe(10010)
	})

	test('49.8 6 (incorrect variant): treating a filter without entry as offset 0 would start L at 10100', () => {
		const assumeZero = (filter: string) => focusOffsetOf(OFFSETS, filter) ?? 0
		const wrong = { kind: 'known' as const, referencePosition: 10100 - assumeZero('Dark') }
		expect(focusPositionFor(wrong, OFFSETS, 'L')).toBe(10100)
		expect(bootstrapFocusBaseline({ kind: 'unset' }, OFFSETS, 'Dark', 10100)).not.toEqual(wrong)
	})

	test('bootstrap never re-derives a known or unknown baseline', () => {
		expect(bootstrapFocusBaseline({ kind: 'unknown' }, OFFSETS, 'R', 10100)).toEqual({ kind: 'unknown' })
		expect(bootstrapFocusBaseline({ kind: 'known', referencePosition: 9000 }, OFFSETS, 'R', 10100)).toEqual({ kind: 'known', referencePosition: 9000 })
		expect(bootstrapFocusBaseline({ kind: 'unset' }, OFFSETS, undefined, 10100)).toEqual({ kind: 'unknown' })
	})

	test('absolute targets: A→B→A returns exactly and an L/R/G/B/L cycle ends where it began', () => {
		const baseline = { kind: 'known' as const, referencePosition: 10000 }
		expect(focusPositionFor(baseline, OFFSETS, 'R')).toBe(10100)
		expect(focusPositionFor(baseline, OFFSETS, 'G')).toBe(9960)
		expect(focusPositionFor(baseline, OFFSETS, 'L')).toBe(10000)
		// B has no entry: the focuser is not commanded there, and L after it is still absolute.
		expect(['L', 'R', 'G', 'B', 'L'].map((filter) => focusPositionFor(baseline, OFFSETS, filter))).toEqual([10000, 10100, 9960, undefined, 10000])
	})

	test('autofocus through a calibrated filter sets the reference by subtracting its offset', () => {
		expect(focusBaselineAfterAutofocus(OFFSETS, 'R', 10250)).toEqual({ kind: 'known', referencePosition: 10150 })
		expect(focusBaselineAfterAutofocus(OFFSETS, 'G', 9900)).toEqual({ kind: 'known', referencePosition: 9940 })
		expect(focusBaselineAfterAutofocus(OFFSETS, 'Dark', 9900)).toBeUndefined()
	})
})

describe('safety window', () => {
	// Received at monotonic instants; the wall clock never enters the history.
	function history(...entries: readonly (readonly [number, SequencerSafetyTransition['state']])[]): SequencerSafetyHistory {
		return { transitions: entries.map(([receivedMonotonic, state]) => ({ receivedMonotonic, state })) }
	}

	// Exposure dispatched at 1000 and finished at 2000.
	const FROM = 1000
	const TO = 2000

	const CASES: readonly (readonly [string, SequencerSafetyHistory, boolean, ReturnType<typeof safetyUnsafeWithin>])[] = [
		['safe all along', history([0, 'safe']), false, 'safe'],
		['unsafe all along', history([0, 'unsafe']), false, 'unsafe'],
		['unsafe in force before the window, without events inside', history([0, 'safe'], [500, 'unsafe']), false, 'unsafe'],
		['safe → unsafe → safe inside the window', history([0, 'safe'], [1200, 'unsafe'], [1300, 'safe']), false, 'unsafe'],
		['unsafe exactly at the dispatch', history([0, 'safe'], [1000, 'unsafe'], [1001, 'safe']), false, 'unsafe'],
		['unsafe exactly at the end', history([0, 'safe'], [2000, 'unsafe']), false, 'unsafe'],
		['unsafe ending 1 ms before the dispatch', history([0, 'unsafe'], [999, 'safe']), false, 'safe'],
		['safe again exactly at the dispatch', history([0, 'unsafe'], [1000, 'safe']), false, 'safe'],
		['unsafe starting 1 ms after the end', history([0, 'safe'], [2001, 'unsafe']), false, 'safe'],
		['unknown with unknownIsUnsafe', history([0, 'safe'], [1500, 'unknown'], [1600, 'safe']), true, 'unsafe'],
		['unknown without unknownIsUnsafe', history([0, 'safe'], [1500, 'unknown'], [1600, 'safe']), false, 'safe'],
		['unknown in force at the dispatch with unknownIsUnsafe', history([0, 'unknown']), true, 'unsafe'],
		['equal instants: the later entry is in force', history([0, 'unsafe'], [1000, 'unsafe'], [1000, 'safe']), false, 'safe'],
		['state at the dispatch evicted', history([1500, 'safe']), false, 'truncated'],
		['window before the subscription', history([5000, 'safe']), false, 'truncated'],
		['empty history', history(), false, 'truncated'],
	]

	test.each(CASES)('49.15 10: %s', (_, safetyHistory, unknownIsUnsafe, verdict) => {
		expect(safetyUnsafeWithin(safetyHistory, FROM, TO, unknownIsUnsafe)).toBe(verdict)
	})

	test('only the closed window matters, whatever lies after it', () => {
		const safetyHistory = history([0, 'safe'], [3000, 'unsafe'], [4000, 'safe'])
		expect(safetyUnsafeWithin(safetyHistory, FROM, TO, true)).toBe('safe')
		expect(safetyUnsafeWithin(safetyHistory, FROM, 3000, true)).toBe('unsafe')
		expect(safetyUnsafeWithin(safetyHistory, 4000, 5000, true)).toBe('safe')
	})
})

describe('safety history', () => {
	test('records the first state and every change, never a repetition, and evicts the oldest beyond the capacity', () => {
		const transitions: SequencerSafetyTransition[] = []
		expect(recordSequencerSafetyTransition(transitions, 0, 'safe', 3)).toBeTrue()
		expect(recordSequencerSafetyTransition(transitions, 10, 'safe', 3)).toBeFalse()
		expect(recordSequencerSafetyTransition(transitions, 20, 'unsafe', 3)).toBeTrue()
		expect(recordSequencerSafetyTransition(transitions, 30, 'unknown', 3)).toBeTrue()
		expect(transitions).toEqual([
			{ receivedMonotonic: 0, state: 'safe' },
			{ receivedMonotonic: 20, state: 'unsafe' },
			{ receivedMonotonic: 30, state: 'unknown' },
		])

		expect(recordSequencerSafetyTransition(transitions, 40, 'safe', 3)).toBeTrue()
		expect(transitions.map((transition) => transition.receivedMonotonic)).toEqual([20, 30, 40])
	})

	test('a window whose initial state was evicted by the changes inside it is truncated (fail-closed)', () => {
		const transitions: SequencerSafetyTransition[] = []
		recordSequencerSafetyTransition(transitions, 0, 'safe', 4)
		// The exposure starts at 100; five changes inside it overflow a history of four.
		for (let i = 1; i <= 5; i++) recordSequencerSafetyTransition(transitions, 100 + i, i % 2 === 0 ? 'safe' : 'unknown', 4)
		expect(safetyUnsafeWithin({ transitions }, 100, 200, false)).toBe('truncated')
		// A window starting after the oldest retained change is still covered.
		expect(safetyUnsafeWithin({ transitions }, 103, 200, false)).toBe('safe')
	})
})

describe('49.3 discard decision', () => {
	const CRITERIA = { quality: true, guidingInterruption: false, unsafeDuringExposure: false } as const

	function policyOf(onExhausted: SequencerFrameDiscardPolicy['onExhausted'], maxDiscardsPerSlot: number, consecutive?: { readonly max: number; readonly action: 'pause' | 'stop' | 'fail' }, artifact: SequencerFrameDiscardPolicy['artifact'] = 'moveToRejected'): SequencerFrameDiscardPolicy {
		return { criteria: CRITERIA, maxDiscardsPerSlot, onExhausted, artifact, ...(consecutive !== undefined && { maxConsecutiveDiscards: consecutive.max, onConsecutiveExhausted: consecutive.action }) }
	}

	test('1: maxDiscardsPerSlot = 0 never retakes: the first discard applies onExhausted', () => {
		expect(decideFrameOutcome(policyOf('skipSlot', 0), { discardBudgetUsed: 0 }, 0, false)).toBe('skipSlot')
		expect(decideFrameOutcome(policyOf('keepLast', 0), { discardBudgetUsed: 0 }, 0, false)).toBe('forced')
	})

	test('2: N discards retake, the N+1th applies onExhausted', () => {
		const policy = policyOf('fail', 2)
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 0 }, 0, false)).toBe('retake')
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 1 }, 1, false)).toBe('retake')
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 2 }, 2, false)).toBe('fail')
	})

	test('3: each onExhausted maps to its decision', () => {
		expect(decideFrameOutcome(policyOf('keepLast', 1), { discardBudgetUsed: 1 }, 0, false)).toBe('forced')
		expect(decideFrameOutcome(policyOf('skipSlot', 1), { discardBudgetUsed: 1 }, 0, false)).toBe('skipSlot')
		expect(decideFrameOutcome(policyOf('pause', 1), { discardBudgetUsed: 1 }, 0, false)).toBe('pause')
		expect(decideFrameOutcome(policyOf('fail', 1), { discardBudgetUsed: 1 }, 0, false)).toBe('fail')
	})

	test('4: a renewed budget needs maxDiscardsPerSlot + 1 discards to exhaust again', () => {
		const policy = policyOf('pause', 2)
		// After resume() the slot budget is 0 again, whatever the total.
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 0 }, 0, false)).toBe('retake')
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 1 }, 0, false)).toBe('retake')
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 2 }, 0, false)).toBe('pause')
	})

	test('6: the circuit breaker is evaluated before the slot budget', () => {
		const policy = policyOf('keepLast', 0, { max: 2, action: 'stop' })
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 0 }, 1, false)).toBe('forced')
		expect(decideFrameOutcome(policy, { discardBudgetUsed: 0 }, 2, false)).toBe('stop')
		expect(decideFrameOutcome(policyOf('skipSlot', 5, { max: 0, action: 'pause' }), { discardBudgetUsed: 0 }, 0, false)).toBe('pause')
	})

	test('8: total over onExhausted × artifact × maxDiscardsPerSlot × circuit breaker × stop; forced only with keepLast and an exhausted budget', () => {
		const decisions = new Set<string>(['forced', 'retake', 'skipSlot', 'pause', 'stop', 'fail', 'discardFinal'])

		for (const onExhausted of ['keepLast', 'skipSlot', 'pause', 'fail'] as const) {
			for (const artifact of ['moveToRejected', 'keepInPlace', 'delete'] as const) {
				for (const max of [0, 1, 2]) {
					for (const consecutive of [undefined, { max: 1, action: 'pause' as const }, { max: 1, action: 'stop' as const }, { max: 1, action: 'fail' as const }]) {
						for (const tripped of [false, true]) {
							for (const stop of [false, true]) {
								for (let used = 0; used <= max; used++) {
									const policy = policyOf(onExhausted, max, consecutive, artifact)
									const decision = decideFrameOutcome(policy, { discardBudgetUsed: used }, tripped ? 1 : 0, stop)
									expect(decisions.has(decision)).toBeTrue()

									const circuit = consecutive !== undefined && tripped
									const exhausted = used + 1 > max
									let expected: string = circuit ? consecutive.action : exhausted ? (onExhausted === 'keepLast' ? 'forced' : onExhausted) : 'retake'
									if (stop && (expected === 'retake' || expected === 'pause' || expected === 'stop')) expected = 'discardFinal'
									expect(decision as string).toBe(expected)
									if (decision === 'forced') expect(onExhausted === 'keepLast' && exhausted && !circuit).toBeTrue()
								}
							}
						}
					}
				}
			}
		}
	})

	test('5: the exhausted counter a held or restored slot still owes; renewing one counter never touches the other', () => {
		const policy = policyOf('pause', 1, { max: 2, action: 'stop' })
		expect(exhaustedDiscardAction(undefined, { discardBudgetUsed: 9 }, 9)).toBeUndefined()
		expect(exhaustedDiscardAction(policy, { discardBudgetUsed: 1 }, 2)).toBeUndefined()
		expect(exhaustedDiscardAction(policy, { discardBudgetUsed: 2 }, 2)).toEqual({ counter: 'slot', action: 'pause' })
		expect(exhaustedDiscardAction(policy, { discardBudgetUsed: 2 }, 3)).toEqual({ counter: 'consecutive', action: 'stop' })
		// resume() after the circuit breaker zeroes consecutiveDiscards only: the slot budget still holds the session.
		expect(exhaustedDiscardAction(policy, { discardBudgetUsed: 2 }, 0)).toEqual({ counter: 'slot', action: 'pause' })
		// resume() after the slot budget zeroes discardBudgetUsed only.
		expect(exhaustedDiscardAction(policy, { discardBudgetUsed: 0 }, 2)).toBeUndefined()
		expect(exhaustedDiscardAction(policyOf('fail', 0), { discardBudgetUsed: 1 }, 0)).toEqual({ counter: 'slot', action: 'fail' })
		// keepLast and skipSlot end the slot when they apply, so a current slot never owes them.
		expect(exhaustedDiscardAction(policyOf('skipSlot', 0), { discardBudgetUsed: 3 }, 0)).toBeUndefined()
		expect(exhaustedDiscardAction(policyOf('keepLast', 0), { discardBudgetUsed: 3 }, 0)).toBeUndefined()
	})
})

describe('49.3 classification', () => {
	const ALL: SequencerDiscardCriteria = { quality: true, guidingInterruption: true, unsafeDuringExposure: true }
	const CLEAN: SequencerFrameEvidence = { frameType: 'LIGHT', quality: 'accepted', dispatched: true, guided: true, guiding: { interrupted: false, truncated: false }, safety: 'safe' }

	test('without criteria every completed frame is accepted', () => {
		expect(classifySequencerFrame(undefined, { ...CLEAN, quality: 'rejected', safety: 'unsafe' })).toEqual({ reasons: [], truncated: false })
	})

	test('7: unknown never discards; a disabled criterion never discards', () => {
		expect(classifySequencerFrame(ALL, { ...CLEAN, quality: 'unknown' }).reasons).toEqual([])
		expect(classifySequencerFrame({ ...ALL, quality: false }, { ...CLEAN, quality: 'rejected' }).reasons).toEqual([])
		expect(classifySequencerFrame({ ...ALL, guidingInterruption: false }, { ...CLEAN, guiding: { interrupted: true, truncated: true } }).reasons).toEqual([])
		expect(classifySequencerFrame({ ...ALL, unsafeDuringExposure: false }, { ...CLEAN, safety: 'unsafe' }).reasons).toEqual([])
	})

	test('every reason in criterion order; a truncated window is reported', () => {
		expect(classifySequencerFrame(ALL, { ...CLEAN, quality: 'rejected', guiding: { interrupted: true, truncated: false }, safety: 'unsafe' })).toEqual({ reasons: ['quality', 'guidingInterruption', 'unsafeDuringExposure'], truncated: false })
		expect(classifySequencerFrame(ALL, { ...CLEAN, guiding: { interrupted: false, truncated: true } })).toEqual({ reasons: ['guidingInterruption'], truncated: true })
		expect(classifySequencerFrame(ALL, { ...CLEAN, safety: 'truncated' })).toEqual({ reasons: ['unsafeDuringExposure'], truncated: true })
	})

	test('7: darks and biases only by quality', () => {
		for (const frameType of ['DARK', 'BIAS'] as const) {
			expect(classifySequencerFrame(ALL, { ...CLEAN, frameType, dispatched: false, guiding: { interrupted: true, truncated: true }, safety: 'unsafe' }).reasons).toEqual([])
			expect(classifySequencerFrame(ALL, { ...CLEAN, frameType, quality: 'rejected' }).reasons).toEqual(['quality'])
		}
	})

	test('an unguided light has nothing to interrupt; a guided one without coverage is truncated', () => {
		expect(classifySequencerFrame(ALL, { frameType: 'LIGHT', quality: 'accepted', dispatched: true, guided: false, safety: 'safe' }).reasons).toEqual([])
		expect(classifySequencerFrame(ALL, { frameType: 'LIGHT', quality: 'accepted', dispatched: true, guided: true, safety: 'safe' })).toEqual({ reasons: ['guidingInterruption'], truncated: true })
	})

	test('no safety history covering the window counts as truncated', () => {
		expect(classifySequencerFrame(ALL, { frameType: 'LIGHT', quality: 'accepted', dispatched: true, guided: false })).toEqual({ reasons: ['unsafeDuringExposure'], truncated: true })
	})

	test('a missing dispatch fails every enabled window criterion closed', () => {
		expect(classifySequencerFrame(ALL, { ...CLEAN, dispatched: false })).toEqual({ reasons: ['guidingInterruption', 'unsafeDuringExposure'], truncated: false, detail: 'missingDispatch' })
		expect(classifySequencerFrame({ ...ALL, unsafeDuringExposure: false }, { ...CLEAN, dispatched: false, guided: false })).toEqual({ reasons: [], truncated: false })
	})
})
