import { describe, expect, test } from 'bun:test'
import type { SequencerCameraCapture, SequencerConfiguration, SequencerFilterFocusOffsets, SequencerFrameSlot, SequencerSessionState } from '../../../src/observation/sequencer/sequencer'
// oxfmt-ignore
import { applyCorrectiveIntents, bootstrapFocusBaseline, canTransitionSequencerState, createSequencerRuntimeState, focusBaselineAfterAutofocus, focusBaselineRequiresAutofocus, focusOffsetOf, focusPositionFor, isTerminalSequencerState, requestSequencerPause, requestSequencerResume, requestSequencerStop, type SequencerSafetyHistory, type SequencerSafetyTransition, safetyUnsafeWithin, sequencerSnapshot, shouldHoldSequencer, transitionSequencerState } from '../../../src/observation/sequencer/state'

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
