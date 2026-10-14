import { describe, expect, test } from 'bun:test'
import { mulberry32, type Random } from '../../../src/math/numerical/random'
// oxfmt-ignore
import { completedSlotsOf, consumedSlotsOf, enqueueCalibrationBatch, fireCalibrationTriggers, restoreSequencerFrameSlot, type SequencerTriggerEvent, selectNextFrame, selectNextFrameOnStop, sequencerFrameSlotId } from '../../../src/observation/sequencer/scheduler'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCaptureConfiguration, SequencerCaptureOrder, SequencerConfiguration, SequencerFrameDiscardPolicy, SequencerFrameGroup, SequencerFrameGroupTrigger, SequencerFrameSlot, SequencerScheduledFrameGroup, SequencerSchedulerState, SequencerTriggerAnchors, SequencerTriggeredFrameGroup } from '../../../src/observation/sequencer/sequencer'
import { createSequencerCaptureProgress, createSequencerSchedulerState, createSequencerTriggerAnchors, decideFrameOutcome, type SequencerCaptureProgress } from '../../../src/observation/sequencer/state'

const LIGHT: SequencerCameraCapture = { exposureTime: 120, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 100, offset: 10, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, exposureTime: 1, frameType: 'DARK' }
const BIAS: SequencerCameraCapture = { ...LIGHT, exposureTime: 1, exposureTimeUnit: 'millisecond', frameType: 'BIAS' }

const ORDERS: readonly SequencerCaptureOrder[] = ['sequential', 'roundRobin', 'weightedRoundRobin']

function scheduled(id: string, count: number, options: Partial<SequencerScheduledFrameGroup> = {}): SequencerScheduledFrameGroup {
	return { kind: 'scheduled', id, enabled: true, capture: LIGHT, count, weight: 1, ...options }
}

function triggered(id: string, trigger: SequencerFrameGroupTrigger, options: Partial<SequencerTriggeredFrameGroup> = {}): SequencerTriggeredFrameGroup {
	return { kind: 'triggered', id, enabled: true, capture: DARK, trigger, batchSize: 1, maxFrames: 10, inherit: 'none', opticalPath: { kind: 'none' }, ...options }
}

function captureOf(order: SequencerCaptureOrder, groups: readonly SequencerFrameGroup[]): SequencerCaptureConfiguration {
	return { order, groups, retry: { maxAttempts: 2, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } }
}

function configurationOf(capture: SequencerCaptureConfiguration): SequencerConfiguration {
	return { schemaVersion: 1, id: 'session', revision: 1, name: 'Session', capture, startup: { onFailure: 'stop' }, shutdown: { stepTimeout: 30, totalTimeout: 300 }, execution: { compensation: { timeout: 30 } } }
}

// Outcome of one attempt, applied the way the post-capture updates progress and the current slot.
type Outcome = 'accept' | 'force' | 'retake' | 'skip'

// Pure session of the scheduler alone: what the runner keeps between two selections.
interface Session {
	readonly capture: SequencerCaptureConfiguration
	readonly scheduler: SequencerSchedulerState
	readonly progress: SequencerCaptureProgress
	current?: SequencerFrameSlot
	readonly events: SequencerTriggerEvent[]
}

function sessionOf(capture: SequencerCaptureConfiguration): Session {
	return { capture, scheduler: createSequencerSchedulerState(), progress: createSequencerCaptureProgress(configurationOf(capture)), events: [] }
}

function select(session: Session) {
	return selectNextFrame(session.capture, session.scheduler, session.progress, session.current, session.events)
}

// Applies the outcome of the attempt of `slot`: accepted, forced and skipped slots are done; a retake keeps the slot
// current with one more discard.
function complete(session: Session, slot: SequencerFrameSlot, outcome: Outcome) {
	const counters = session.progress.get(slot.groupId)!
	session.current = undefined

	if (outcome === 'accept') counters.accepted++
	else if (outcome === 'force') counters.forced++
	else {
		counters.discarded++
		if (outcome === 'skip') counters.skipped++
		else session.current = { ...slot, discardedTotal: slot.discardedTotal + 1, discardBudgetUsed: slot.discardBudgetUsed + 1, captureFailures: 0 }
	}
}

// Selects and accepts until nothing is left; returns the selected slot ids.
function drain(session: Session) {
	const ids: string[] = []

	for (let slot = select(session); slot !== undefined; slot = select(session)) {
		ids.push(slot.id)
		complete(session, slot, 'accept')
		if (ids.length > 100000) throw new Error('the scheduler did not terminate')
	}

	return ids
}

// Persisted form of the scheduler, the progress and the current slot, as a checkpoint carries them.
function serialize(session: Session) {
	return JSON.stringify({ scheduler: session.scheduler, progress: [...session.progress], current: session.current })
}

function restore(capture: SequencerCaptureConfiguration, json: string): Session {
	const { scheduler, progress, current } = JSON.parse(json) as { scheduler: SequencerSchedulerState; progress: [string, { accepted: number; forced: number; discarded: number; skipped: number }][]; current?: SequencerFrameSlot }
	return { capture, scheduler, progress: new Map(progress), current, events: [] }
}

// Random configuration of 1–6 scheduled groups, counts 0–20, weights 0.1–100, some disabled.
function randomScheduledGroups(random: Random, disabled = true) {
	const n = 1 + Math.floor(random() * 6)
	return Array.from({ length: n }, (_, i) => scheduled(`g${i}`, Math.floor(random() * 21), { weight: 0.1 + random() * 99.9, enabled: !disabled || random() < 0.85 }))
}

function shuffle<T>(random: Random, items: readonly T[]) {
	const shuffled = [...items]

	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
	}

	return shuffled
}

describe('slot identity', () => {
	test('is frame[{groupId}][{ordinal}]', () => {
		expect(sequencerFrameSlotId('Ha', 12)).toBe('frame[Ha][12]')
	})

	test('a new slot starts at attempt 1 with clean counters and the group settings', () => {
		const group = scheduled('L', 2, { filter: { kind: 'name', name: 'L' } })
		const slot = select(sessionOf(captureOf('sequential', [group])))
		expect(slot).toEqual({ id: 'frame[L][1]', groupId: 'L', kind: 'scheduled', ordinal: 1, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture: LIGHT, filter: { kind: 'name', name: 'L' } })
	})

	test('never depends on the position of the group in the array', () => {
		const a = drain(sessionOf(captureOf('sequential', [scheduled('A', 2), scheduled('B', 2)])))
		const b = drain(sessionOf(captureOf('sequential', [scheduled('B', 2), scheduled('A', 2)])))
		expect(a).toEqual(['frame[A][1]', 'frame[A][2]', 'frame[B][1]', 'frame[B][2]'])
		expect(b).toEqual(['frame[B][1]', 'frame[B][2]', 'frame[A][1]', 'frame[A][2]'])
	})
})

describe('sequential', () => {
	test('exhausts a single group', () => {
		expect(drain(sessionOf(captureOf('sequential', [scheduled('L', 3)])))).toEqual(['frame[L][1]', 'frame[L][2]', 'frame[L][3]'])
	})

	test('exhausts each enabled group in declared order, skipping disabled and empty ones', () => {
		const groups = [scheduled('A', 2), scheduled('B', 2, { enabled: false }), scheduled('C', 0), scheduled('D', 1)]
		expect(drain(sessionOf(captureOf('sequential', groups)))).toEqual(['frame[A][1]', 'frame[A][2]', 'frame[D][1]'])
	})

	test('continues a partially done group from its progress', () => {
		const session = sessionOf(captureOf('sequential', [scheduled('A', 3), scheduled('B', 1)]))
		session.progress.get('A')!.accepted = 1
		session.progress.get('A')!.skipped = 1
		expect(drain(session)).toEqual(['frame[A][3]', 'frame[B][1]'])
	})
})

describe('round robin', () => {
	test('takes one slot per group in declared order with equal counts', () => {
		const groups = [scheduled('L', 2), scheduled('R', 2), scheduled('G', 2)]
		expect(drain(sessionOf(captureOf('roundRobin', groups)))).toEqual(['frame[L][1]', 'frame[R][1]', 'frame[G][1]', 'frame[L][2]', 'frame[R][2]', 'frame[G][2]'])
	})

	test('skips finished groups and wraps with unequal counts', () => {
		const groups = [scheduled('L', 3), scheduled('R', 1), scheduled('G', 2)]
		expect(drain(sessionOf(captureOf('roundRobin', groups)))).toEqual(['frame[L][1]', 'frame[R][1]', 'frame[G][1]', 'frame[L][2]', 'frame[G][2]', 'frame[L][3]'])
	})

	test('keeps the cursor across a restart', () => {
		const capture = captureOf('roundRobin', [scheduled('L', 3), scheduled('R', 1), scheduled('G', 2)])
		const session = sessionOf(capture)
		for (let i = 0; i < 4; i++) complete(session, select(session)!, 'accept')

		expect(session.scheduler.cursor).toBe('L')
		expect(drain(restore(capture, serialize(session)))).toEqual(['frame[G][2]', 'frame[L][3]'])
	})
})

describe('weighted round robin', () => {
	test('alternates equal weights', () => {
		const groups = [scheduled('A', 3), scheduled('B', 3)]
		expect(drain(sessionOf(captureOf('weightedRoundRobin', groups)))).toEqual(['frame[A][1]', 'frame[B][1]', 'frame[A][2]', 'frame[B][2]', 'frame[A][3]', 'frame[B][3]'])
	})

	test('selects in proportion 1:3 within half a selection', () => {
		const session = sessionOf(captureOf('weightedRoundRobin', [scheduled('A', 5, { weight: 1 }), scheduled('B', 15, { weight: 3 })]))
		const counts = { A: 0, B: 0 }

		for (let k = 1; k <= 20; k++) {
			const slot = select(session)!
			counts[slot.groupId as 'A' | 'B']++
			complete(session, slot, 'accept')
			expect(Math.abs(counts.A - k / 4)).toBeLessThanOrEqual(0.5)
			expect(Math.abs(counts.B - (3 * k) / 4)).toBeLessThanOrEqual(0.5)
		}

		expect(select(session)).toBeUndefined()
	})

	test('never starves weight 1 against weight 1000 and keeps credits bounded', () => {
		const session = sessionOf(captureOf('weightedRoundRobin', [scheduled('A', 3, { weight: 1 }), scheduled('B', 3000, { weight: 1000 })]))
		const selectedA: number[] = []

		for (let k = 1; k <= 3003; k++) {
			const slot = select(session)!
			if (slot.groupId === 'A') selectedA.push(k)
			complete(session, slot, 'accept')

			for (const credit of Object.values(session.scheduler.credits)) {
				expect(Number.isFinite(credit)).toBe(true)
				expect(Math.abs(credit)).toBeLessThanOrEqual(1001)
			}
		}

		// Ideal positions 1001·(n − ½) ± ½·1001: the weight-1 group is selected once per 1001 selections.
		expect(selectedA).toHaveLength(3)
		expect(selectedA[0]).toBeLessThanOrEqual(1 + 0.5 * 1001)
		expect(selectedA[1] - selectedA[0]).toBeLessThanOrEqual(1 + 1001)
		expect(selectedA[2] - selectedA[1]).toBeLessThanOrEqual(1 + 1001)
		expect(select(session)).toBeUndefined()
	})

	test('a finished group leaves the rotation and the credits restart for the remaining groups', () => {
		const session = sessionOf(captureOf('weightedRoundRobin', [scheduled('A', 1, { weight: 1 }), scheduled('B', 3, { weight: 1 }), scheduled('C', 0, { weight: 5 })]))
		expect(session.scheduler.credits).toEqual({})

		complete(session, select(session)!, 'accept')
		expect(Object.keys(session.scheduler.credits)).toEqual(['A', 'B'])

		expect(drain(session)).toEqual(['frame[B][1]', 'frame[B][2]', 'frame[B][3]'])
		expect(session.scheduler.credits).toEqual({ B: 0 })
	})

	test('keeps a group with any id as an own credit key', () => {
		const session = sessionOf(captureOf('weightedRoundRobin', [scheduled('__proto__', 2), scheduled('B', 2)]))
		expect(drain(session)).toEqual(['frame[__proto__][1]', 'frame[B][1]', 'frame[__proto__][2]', 'frame[B][2]'])
		expect(Object.getPrototypeOf(session.scheduler.credits)).toBe(Object.prototype)
	})
})

describe('persistence', () => {
	test('round-trips through JSON and selects the same next slot', () => {
		for (const order of ORDERS) {
			const capture = captureOf(order, [scheduled('L', 4, { weight: 2 }), scheduled('R', 3, { weight: 1 }), triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 2 })])
			const session = sessionOf(capture)
			const first = select(session)!
			complete(session, first, 'accept')
			enqueueCalibrationBatch(session.scheduler, session.progress, capture.groups[2] as SequencerTriggeredFrameGroup, first)
			complete(session, select(session)!, 'retake')

			const restored = restore(capture, serialize(session))
			expect(restored.scheduler).toEqual(session.scheduler)
			expect(select(restored)).toEqual(select(session))
		}
	})

	test('a pending current slot is selected again with one more attempt and the scheduler untouched', () => {
		for (const order of ORDERS) {
			const session = sessionOf(captureOf(order, [scheduled('L', 2), scheduled('R', 2), triggered('D', { kind: 'sessionStart' }, { batchSize: 1 })]))

			// The first selection runs the session-start dark; the second is a light.
			for (const groupId of ['D', 'L']) {
				const slot = select(session)!
				expect(slot.groupId).toBe(groupId)
				session.current = { ...slot, attempt: 3, discardedTotal: 2, discardBudgetUsed: 1, captureFailures: 1 }
				const scheduler = structuredClone(session.scheduler)

				expect(select(session)).toEqual({ ...session.current, attempt: 4 })
				expect(session.scheduler).toEqual(scheduler)
				complete(session, session.current, 'accept')
			}
		}
	})

	test('nothing enabled or requested selects nothing at once', () => {
		for (const order of ORDERS) {
			expect(select(sessionOf(captureOf(order, [])))).toBeUndefined()

			const session = sessionOf(captureOf(order, [scheduled('A', 0), scheduled('B', 5, { enabled: false }), triggered('D', { kind: 'sessionEnd', onStop: false }, { enabled: false })]))
			expect(select(session)).toBeUndefined()
			expect(select(session)).toBeUndefined()
			expect(session.events).toEqual([])
			expect(session.scheduler.batches).toEqual([])
		}
	})
})

describe('triggered groups', () => {
	test('batches run in fire order and a batch in progress is never preempted', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 2 })
		const bias = triggered('B', { kind: 'afterFrames', frames: 1 }, { capture: BIAS })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 2), dark, bias]))

		const light = select(session)!
		complete(session, light, 'accept')
		enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)

		const first = select(session)!
		expect(first.id).toBe('frame[D][1]')
		complete(session, first, 'accept')
		enqueueCalibrationBatch(session.scheduler, session.progress, bias, light)

		expect(drain(session)).toEqual(['frame[D][2]', 'frame[B][1]', 'frame[L][2]'])
	})

	test('a batch keeps the triggering slot, frozen settings and the opaque filter of its optical path', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { opticalPath: { kind: 'filter', filter: { kind: 'slot', slot: 7 } }, filter: { kind: 'slot', slot: 1 } })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 1), dark]))
		const light = select(session)!
		complete(session, light, 'accept')

		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toEqual({ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][1]' })
		expect(select(session)).toEqual({ id: 'frame[D][1]', groupId: 'D', kind: 'triggered', ordinal: 1, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture: DARK, filter: { kind: 'slot', slot: 7 }, triggeredBy: 'frame[L][1]' })
	})

	test('a disabled group never enqueues', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { enabled: false })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 1), dark]))
		const light = select(session)!

		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toBeUndefined()
		expect(session.scheduler.batches).toEqual([])
	})

	test('maxFrames bounds the group and the excess is suppressed', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 2, maxFrames: 3 })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 3), dark]))
		const events: (SequencerTriggerEvent | undefined)[] = []
		const ids: string[] = []

		for (let slot = select(session); slot !== undefined; slot = select(session)) {
			ids.push(slot.id)
			complete(session, slot, 'accept')
			if (slot.kind === 'scheduled') events.push(enqueueCalibrationBatch(session.scheduler, session.progress, dark, slot))
		}

		expect(ids).toEqual(['frame[L][1]', 'frame[D][1]', 'frame[D][2]', 'frame[L][2]', 'frame[D][3]', 'frame[L][3]'])
		expect(events).toEqual([
			{ type: 'triggerFired', groupId: 'D', slots: 2, triggeredBy: 'frame[L][1]' },
			{ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][2]' },
			{ type: 'triggerSuppressed', groupId: 'D', triggeredBy: 'frame[L][3]' },
		])
	})

	test('session-start batches run before the first scheduled slot and session-end ones after the last', () => {
		const start = triggered('S', { kind: 'sessionStart' }, { capture: BIAS, batchSize: 2 })
		const end = triggered('E', { kind: 'sessionEnd', onStop: false })
		const session = sessionOf(captureOf('roundRobin', [start, scheduled('L', 2), end, scheduled('R', 1)]))

		expect(drain(session)).toEqual(['frame[S][1]', 'frame[S][2]', 'frame[L][1]', 'frame[R][1]', 'frame[L][2]', 'frame[E][1]'])
		expect(session.events).toEqual([
			{ type: 'triggerFired', groupId: 'S', slots: 2 },
			{ type: 'triggerFired', groupId: 'E', slots: 1 },
		])

		expect(select(session)).toBeUndefined()
		expect(session.events).toHaveLength(2)
	})

	test('inherited settings are frozen when the batch fires and ordinals keep growing across batches', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 2, inherit: 'triggeringFrame' })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 2), dark]))
		const capture = { ...LIGHT, exposureTime: 300, binX: 2, binY: 2, gain: 139, subframe: true, x: 8, y: 16, width: 800, height: 600 }
		const light: SequencerFrameSlot = { ...select(session)!, capture }
		complete(session, light, 'accept')

		enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)
		enqueueCalibrationBatch(session.scheduler, session.progress, triggered('D', dark.trigger, { batchSize: 2 }), light)
		capture.exposureTime = 1
		capture.binX = 4

		const slots = [select(session)!]
		for (let i = 0; i < 3; i++) {
			complete(session, slots[i], 'accept')
			slots.push(select(session)!)
		}

		expect(slots.map((slot) => slot.id)).toEqual(['frame[D][1]', 'frame[D][2]', 'frame[D][3]', 'frame[D][4]'])
		expect(slots[0].capture).toEqual({ ...LIGHT, exposureTime: 300, binX: 2, binY: 2, gain: 139, subframe: true, x: 8, y: 16, width: 800, height: 600, frameType: 'DARK' })
		expect(slots[1].capture).toEqual(slots[0].capture)
		expect(slots[2].capture).toEqual(DARK)
	})

	test('capacity is reserved at enqueue: a light retaken twice and skipped fires a single dark', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 1, maxFrames: 1 })
		const discard = { criteria: { quality: true, guidingInterruption: false, unsafeDuringExposure: false }, maxDiscardsPerSlot: 2, onExhausted: 'skipSlot', artifact: 'moveToRejected' } as const
		const session = sessionOf(captureOf('sequential', [scheduled('L', 1, { discard }), dark]))
		const ids: string[] = []
		const events: (SequencerTriggerEvent | undefined)[] = []

		// Three rejected exposures of the same light: two retakes, then the exhausted budget skips the slot.
		for (const outcome of ['retake', 'retake', 'skip'] as const) {
			const light = select(session)!
			ids.push(light.id)
			complete(session, light, outcome)
			events.push(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light))
		}

		for (let slot = select(session); slot !== undefined; slot = select(session)) {
			ids.push(slot.id)
			complete(session, slot, 'accept')
		}

		expect(ids).toEqual(['frame[L][1]', 'frame[L][1]', 'frame[L][1]', 'frame[D][1]'])
		expect(events.map((event) => event?.type)).toEqual(['triggerFired', 'triggerSuppressed', 'triggerSuppressed'])
	})

	test('a batch fired beyond the free capacity is truncated', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 3, maxFrames: 4 })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 3), dark]))
		const light = select(session)!

		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toMatchObject({ type: 'triggerFired', slots: 3 })
		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toMatchObject({ type: 'triggerFired', slots: 1 })
		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toMatchObject({ type: 'triggerSuppressed' })
		expect(session.scheduler.batches.map(({ firstOrdinal, size }) => [firstOrdinal, size])).toEqual([
			[1, 3],
			[4, 1],
		])
	})

	test('a skipped dark never gives its capacity back', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 1, maxFrames: 2 })
		const session = sessionOf(captureOf('sequential', [scheduled('L', 3), dark]))
		const light = select(session)!
		complete(session, light, 'accept')

		enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)
		complete(session, select(session)!, 'skip')
		expect(consumedSlotsOf(session.scheduler, session.progress, 'D')).toBe(1)

		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toMatchObject({ type: 'triggerFired', slots: 1 })
		complete(session, select(session)!, 'accept')
		expect(enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)).toMatchObject({ type: 'triggerSuppressed' })
		expect(completedSlotsOf(session.progress, 'D')).toBe(2)
	})

	test('consumed capacity is derived from progress and queue and survives a restart', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 2, maxFrames: 3 })
		const capture = captureOf('sequential', [scheduled('L', 3), dark])
		const session = sessionOf(capture)
		const light = select(session)!
		complete(session, light, 'accept')

		enqueueCalibrationBatch(session.scheduler, session.progress, dark, light)
		complete(session, select(session)!, 'accept')

		const restored = restore(capture, serialize(session))
		expect(consumedSlotsOf(restored.scheduler, restored.progress, 'D')).toBe(2)
		expect(enqueueCalibrationBatch(restored.scheduler, restored.progress, dark, light)).toMatchObject({ type: 'triggerFired', slots: 1 })
		expect(enqueueCalibrationBatch(restored.scheduler, restored.progress, dark, light)).toMatchObject({ type: 'triggerSuppressed' })
		expect(drain(restored)).toEqual(['frame[D][2]', 'frame[D][3]', 'frame[L][2]', 'frame[L][3]'])
	})
})

describe('light triggers', () => {
	// Session with the trigger anchors the post-capture keeps.
	function triggerSessionOf(capture: SequencerCaptureConfiguration) {
		return { ...sessionOf(capture), anchors: createSequencerTriggerAnchors(configurationOf(capture)) }
	}

	// Exposes the next slot with `outcome` and fires the light triggers of a scheduled light at `temperature`; returns
	// the slot and the trigger events of its post-capture.
	function expose(session: Session & { readonly anchors: SequencerTriggerAnchors }, outcome: Outcome = 'accept', temperature?: number) {
		const slot = select(session)!
		complete(session, slot, outcome)
		const events: SequencerTriggerEvent[] = []
		if (slot.kind === 'scheduled' && slot.capture.frameType === 'LIGHT') fireCalibrationTriggers(session.capture, session.scheduler, session.progress, session.anchors, slot, temperature, events)
		return { slot, events }
	}

	test('afterFrames fires exactly at N completed lights, discarded ones included, and restarts its count', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 3 })
		const session = triggerSessionOf(captureOf('sequential', [scheduled('L', 6), dark]))

		expect(expose(session).events).toEqual([])
		expect(expose(session, 'retake').events).toEqual([])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 2, batches: 0 })
		expect(expose(session).events).toEqual([{ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][2]' }])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 0, batches: 1 })

		expect(expose(session).slot.id).toBe('frame[D][1]')
		expect(session.anchors.calibration.D.lightExposures).toBe(0)
		expect(expose(session).events).toEqual([])
		expect(expose(session).events).toEqual([])
		expect(expose(session).events).toEqual([{ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][5]' }])
	})

	test('a suppressed afterFrames trigger restarts its count too', () => {
		const dark = triggered('D', { kind: 'afterFrames', frames: 2 }, { maxFrames: 1 })
		const session = triggerSessionOf(captureOf('sequential', [scheduled('L', 6), dark]))
		const events = Array.from({ length: 7 }, () => expose(session).events).flat()

		expect(events).toEqual([
			{ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][2]' },
			{ type: 'triggerSuppressed', groupId: 'D', triggeredBy: 'frame[L][4]' },
			{ type: 'triggerSuppressed', groupId: 'D', triggeredBy: 'frame[L][6]' },
		])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 0, batches: 1 })
	})

	test('sourceGroups ignores the lights of other groups; without them every scheduled light counts', () => {
		const onlyR = triggered('DR', { kind: 'afterFrames', frames: 1, sourceGroups: ['R'] })
		const every = triggered('DA', { kind: 'afterFrames', frames: 2 })
		const session = triggerSessionOf(captureOf('roundRobin', [scheduled('L', 2), scheduled('R', 2), onlyR, every]))

		expect(expose(session).events).toEqual([])
		expect(expose(session).events).toEqual([
			{ type: 'triggerFired', groupId: 'DR', slots: 1, triggeredBy: 'frame[R][1]' },
			{ type: 'triggerFired', groupId: 'DA', slots: 1, triggeredBy: 'frame[R][1]' },
		])
		expect(session.anchors.calibration).toEqual({ DR: { lightExposures: 0, batches: 1 }, DA: { lightExposures: 0, batches: 1 } })
	})

	test('temperatureChange: the first light anchors, a change of delta either way fires, only an enqueued batch moves the anchor', () => {
		const dark = triggered('D', { kind: 'temperatureChange', delta: 0.5 }, { maxFrames: 2 })
		const session = triggerSessionOf(captureOf('sequential', [scheduled('L', 8), dark]))

		expect(expose(session, 'accept', -10).events).toEqual([])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 0, sensorTemperature: -10, batches: 0 })
		expect(expose(session, 'accept', -10.25).events).toEqual([])
		expect(expose(session, 'retake', -9.5).events).toEqual([{ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][3]' }])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 0, sensorTemperature: -9.5, batches: 1 })

		// The retake comes first, then the dark.
		expect(expose(session, 'accept', -9.5).slot.id).toBe('frame[L][3]')
		expect(expose(session).slot.id).toBe('frame[D][1]')
		expect(expose(session, 'accept', -10).events).toEqual([{ type: 'triggerFired', groupId: 'D', slots: 1, triggeredBy: 'frame[L][4]' }])
		expect(expose(session).slot.id).toBe('frame[D][2]')

		// The group is full: the suppressed trigger leaves the anchor at -10, so every later change fires again.
		expect(expose(session, 'accept', -11).events).toEqual([{ type: 'triggerSuppressed', groupId: 'D', triggeredBy: 'frame[L][5]' }])
		expect(expose(session, 'accept', -11).events).toEqual([{ type: 'triggerSuppressed', groupId: 'D', triggeredBy: 'frame[L][6]' }])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 0, sensorTemperature: -10, batches: 2 })
	})

	test('an unavailable sensor temperature never fires nor anchors, without throwing', () => {
		const dark = triggered('D', { kind: 'temperatureChange', delta: 0.1 })
		const session = triggerSessionOf(captureOf('sequential', [scheduled('L', 4), dark]))

		for (const temperature of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(expose(session, 'accept', temperature).events).toEqual([])
		expect(session.anchors.calibration.D).toEqual({ lightExposures: 0, batches: 0 })
		expect(expose(session, 'accept', 5).events).toEqual([])
		expect(session.anchors.calibration.D.sensorTemperature).toBe(5)
	})

	test('disabled groups and session-boundary triggers never fire after a light; batches inherit the light, frozen', () => {
		const disabled = triggered('X', { kind: 'afterFrames', frames: 1 }, { enabled: false })
		const start = triggered('S', { kind: 'sessionStart' }, { capture: BIAS })
		const end = triggered('E', { kind: 'sessionEnd', onStop: false }, { capture: BIAS })
		const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { inherit: 'triggeringFrame', batchSize: 2 })
		const session = triggerSessionOf(captureOf('sequential', [disabled, start, scheduled('L', 1, { capture: { ...LIGHT, exposureTime: 300, gain: 139 } }), end, dark]))

		expect(expose(session).slot.id).toBe('frame[S][1]')
		const { slot, events } = expose(session)
		expect(slot.id).toBe('frame[L][1]')
		expect(events).toEqual([{ type: 'triggerFired', groupId: 'D', slots: 2, triggeredBy: 'frame[L][1]' }])
		expect(session.scheduler.batches).toEqual([{ groupId: 'D', firstOrdinal: 1, size: 2, capture: { ...LIGHT, exposureTime: 300, gain: 139, frameType: 'DARK' }, triggeredBy: 'frame[L][1]' }])
		expect(session.anchors.calibration.X).toEqual({ lightExposures: 0, batches: 0 })
		expect(drain(session)).toEqual(['frame[D][1]', 'frame[D][2]', 'frame[E][1]'])
	})

	test('an anchor missing for a group is created as a fresh own key', () => {
		const dark = triggered('__proto__', { kind: 'afterFrames', frames: 1 })
		const capture = captureOf('sequential', [scheduled('L', 1), dark])
		const session = { ...sessionOf(capture), anchors: { calibration: {} } }
		const light = select(session)!
		const events: SequencerTriggerEvent[] = []

		fireCalibrationTriggers(capture, session.scheduler, session.progress, session.anchors, light, undefined, events)
		expect(Object.hasOwn(session.anchors.calibration, '__proto__')).toBeTrue()
		expect(JSON.stringify(session.anchors.calibration)).toBe('{"__proto__":{"lightExposures":0,"batches":1}}')
		expect(events).toEqual([{ type: 'triggerFired', groupId: '__proto__', slots: 1, triggeredBy: 'frame[L][1]' }])
	})
})

describe('graceful stop', () => {
	const groups = () => [scheduled('L', 3), triggered('after', { kind: 'afterFrames', frames: 1 }), triggered('darks', { kind: 'sessionEnd', onStop: true }, { batchSize: 2, maxFrames: 2 }), triggered('biases', { kind: 'sessionEnd', onStop: false }, { capture: BIAS })]

	test('selects only the session-end groups with onStop, enqueued once, and keeps the other batches queued', () => {
		const session = sessionOf(captureOf('sequential', groups()))
		const light = select(session)!
		expect(enqueueCalibrationBatch(session.scheduler, session.progress, session.capture.groups[1] as SequencerTriggeredFrameGroup, light)?.type).toBe('triggerFired')
		complete(session, light, 'accept')

		const ids: string[] = []

		for (let slot = selectNextFrameOnStop(session.capture, session.scheduler, session.progress, session.current, session.events); slot !== undefined; slot = selectNextFrameOnStop(session.capture, session.scheduler, session.progress, session.current, session.events)) {
			ids.push(slot.id)
			complete(session, slot, 'accept')
		}

		expect(ids).toEqual(['frame[darks][1]', 'frame[darks][2]'])
		expect(session.events.map((event) => event.groupId)).toEqual(['darks'])
		expect(session.scheduler.batches.map((batch) => batch.groupId)).toEqual(['after'])
		expect(session.scheduler.sessionEndQueued).toBeTrue()
	})

	test('retries a pending onStop slot with a new attempt, never a scheduled one', () => {
		const session = sessionOf(captureOf('sequential', groups()))
		const light = select(session)!
		expect(selectNextFrameOnStop(session.capture, session.scheduler, session.progress, { ...light, captureFailures: 1 })?.id).toBe('frame[darks][1]')

		const dark = selectNextFrameOnStop(session.capture, session.scheduler, session.progress)!
		expect(selectNextFrameOnStop(session.capture, session.scheduler, session.progress, { ...dark, captureFailures: 1 })).toMatchObject({ id: 'frame[darks][1]', attempt: 2, captureFailures: 1 })
	})

	test('after the natural end, a stop keeps only the onStop batches already enqueued', () => {
		const session = sessionOf(captureOf('sequential', [scheduled('L', 0), triggered('darks', { kind: 'sessionEnd', onStop: true }), triggered('biases', { kind: 'sessionEnd', onStop: false }, { capture: BIAS })]))
		expect(select(session)?.id).toBe('frame[darks][1]')
		expect(selectNextFrameOnStop(session.capture, session.scheduler, session.progress)?.id).toBe('frame[darks][1]')
		complete(session, selectNextFrameOnStop(session.capture, session.scheduler, session.progress)!, 'accept')
		expect(selectNextFrameOnStop(session.capture, session.scheduler, session.progress)).toBeUndefined()
		expect(session.events.map((event) => event.groupId)).toEqual(['darks', 'biases'])
	})
})

describe('restored slot', () => {
	const counters = { attempt: 3, discardedTotal: 1, discardBudgetUsed: 1, captureFailures: 1 }

	test('a scheduled slot takes its group settings and the persisted counters, unchanged by a selection', () => {
		const capture = captureOf('roundRobin', [scheduled('L', 3, { filter: { kind: 'name', name: 'Red' } }), scheduled('R', 2)])
		const scheduler = createSequencerSchedulerState()
		const slot = restoreSequencerFrameSlot(capture, scheduler, { id: 'frame[L][2]', ...counters })

		expect(slot).toEqual({ id: 'frame[L][2]', groupId: 'L', kind: 'scheduled', ordinal: 2, ...counters, capture: LIGHT, filter: { kind: 'name', name: 'Red' } })
		expect(scheduler).toEqual(createSequencerSchedulerState())
		// The restored slot is the pending slot of a retake: the next selection is its next attempt.
		expect(selectNextFrame(capture, scheduler, createSequencerCaptureProgress(configurationOf(capture)), slot)).toMatchObject({ id: 'frame[L][2]', attempt: 4 })
	})

	test('a triggered slot takes the settings frozen in the pending batch holding its ordinal', () => {
		const capture = captureOf('sequential', [scheduled('L', 1), triggered('dark', { kind: 'afterFrames', frames: 1 }, { inherit: 'triggeringFrame', batchSize: 2 })])
		const scheduler = createSequencerSchedulerState()
		const progress = createSequencerCaptureProgress(configurationOf(capture))
		const light: SequencerFrameSlot = { id: 'frame[L][1]', groupId: 'L', kind: 'scheduled', ordinal: 1, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture: { ...LIGHT, gain: 250 } }
		enqueueCalibrationBatch(scheduler, progress, capture.groups[1] as SequencerTriggeredFrameGroup, light)

		expect(restoreSequencerFrameSlot(capture, scheduler, { id: 'frame[dark][2]', ...counters })).toEqual({ id: 'frame[dark][2]', groupId: 'dark', kind: 'triggered', ordinal: 2, ...counters, capture: { ...LIGHT, gain: 250, frameType: 'DARK' }, triggeredBy: 'frame[L][1]' })
		expect(restoreSequencerFrameSlot(capture, scheduler, { id: 'frame[dark][3]', ...counters })).toBeUndefined()
	})

	test('a group id with brackets parses by its last ordinal; an unknown, disabled or malformed id restores nothing', () => {
		const capture = captureOf('sequential', [scheduled('a][1', 2), scheduled('off', 1, { enabled: false })])
		const scheduler = createSequencerSchedulerState()

		expect(restoreSequencerFrameSlot(capture, scheduler, { id: sequencerFrameSlotId('a][1', 2), ...counters })).toMatchObject({ groupId: 'a][1', ordinal: 2 })
		for (const id of ['frame[x][1]', 'frame[off][1]', 'frame[a][1][0]', 'frame[a][1]x', 'slot[a][1]']) expect(restoreSequencerFrameSlot(capture, scheduler, { id, ...counters })).toBeUndefined()
	})
})

describe('properties', () => {
	test('P1: exactly the requested slots, with ordinals 1..count per group', () => {
		const random = mulberry32(0x5eed01)

		for (let i = 0; i < 500; i++) {
			const groups = randomScheduledGroups(random)
			const order = ORDERS[i % ORDERS.length]
			const ids = drain(sessionOf(captureOf(order, groups)))
			const expected = groups.flatMap((group) => (group.enabled ? Array.from({ length: group.count }, (_, k) => sequencerFrameSlotId(group.id, k + 1)) : []))

			expect(ids.toSorted()).toEqual(expected.toSorted())

			// Within a group, ordinals are selected in increasing order.
			for (const group of groups) {
				const ordinals = ids.filter((id) => id.startsWith(`frame[${group.id}]`))
				expect(ordinals).toEqual(expected.filter((id) => id.startsWith(`frame[${group.id}]`)))
			}
		}
	})

	test('P2: round robin selects every other pending group at most once between two selections of a group', () => {
		const random = mulberry32(0x5eed02)

		for (let i = 0; i < 500; i++) {
			const session = sessionOf(captureOf('roundRobin', randomScheduledGroups(random)))
			const groups = drain(session).map((id) => id.slice(6, id.indexOf(']')))
			const last = new Map<string, number>()

			for (const [k, group] of groups.entries()) {
				const previous = last.get(group)

				if (previous !== undefined) {
					const between = groups.slice(previous + 1, k)
					expect(new Set(between).size).toBe(between.length)
				}

				last.set(group, k)
			}
		}
	})

	test('P3: weighted selection stays within Tijdeman bound of the proportional share and never starves', () => {
		const random = mulberry32(0x5eed03)
		let rotations = 0

		for (let i = 0; i < 500; i++) {
			const groups = randomScheduledGroups(random, false)
			const session = sessionOf(captureOf('weightedRoundRobin', groups))
			let rotation = ''
			let k = 0
			const selected = new Map<string, number>()
			const lastSelection = new Map<string, number>()

			while (true) {
				const pending = groups.filter((group) => completedSlotsOf(session.progress, group.id) < group.count)
				if (pending.length === 0) break

				// A new rotation restarts the prefix whenever the pending set changes.
				const key = pending.map((group) => group.id).join()

				if (key !== rotation) {
					rotation = key
					rotations++
					k = 0
					selected.clear()
					lastSelection.clear()
				}

				const slot = select(session)!
				complete(session, slot, 'accept')
				k++
				selected.set(slot.groupId, (selected.get(slot.groupId) ?? 0) + 1)

				const m = pending.length
				const total = pending.reduce((sum, group) => sum + group.weight!, 0)
				const bound = m === 1 ? 0 : 1 - 1 / (2 * m - 2)

				for (const group of pending) {
					const share = (k * group.weight!) / total
					expect(Math.abs((selected.get(group.id) ?? 0) - share)).toBeLessThanOrEqual(bound + 1e-9)
				}

				const gap = k - (lastSelection.get(slot.groupId) ?? 0)
				const weight = pending.find((group) => group.id === slot.groupId)!.weight!
				expect(gap).toBeLessThanOrEqual(1 + (2 * bound * total) / weight + 1e-9)
				lastSelection.set(slot.groupId, k)

				for (const credit of Object.values(session.scheduler.credits)) expect(Math.abs(credit)).toBeLessThanOrEqual(total)
			}
		}

		expect(rotations).toBeGreaterThan(1000)
	})

	test('P4: a checkpoint at any point continues with the same tail, also with batches and retakes pending', () => {
		const random = mulberry32(0x5eed04)

		for (let i = 0; i < 100; i++) {
			const order = ORDERS[i % ORDERS.length]
			const dark = triggered('D', { kind: 'afterFrames', frames: 1 }, { batchSize: 1 + Math.floor(random() * 3), maxFrames: Math.floor(random() * 8) + 1, inherit: 'triggeringFrame' })
			const bias = triggered('B', { kind: 'sessionEnd', onStop: false }, { capture: BIAS, batchSize: 2, maxFrames: 2 })
			const start = triggered('S', { kind: 'sessionStart' }, { capture: BIAS, batchSize: 1, maxFrames: 1 })
			const capture = captureOf(order, [...randomScheduledGroups(random), dark, bias, start])

			// Outcome and trigger of the n-th selection, fixed in advance so every run makes the same decisions.
			const outcomes = Array.from({ length: 400 }, (): Outcome => (random() < 0.2 ? 'retake' : random() < 0.1 ? 'skip' : random() < 0.1 ? 'force' : 'accept'))
			const fires = Array.from({ length: 400 }, () => random() < 0.3)

			function advance(session: Session, n: number) {
				const slot = select(session)
				if (slot === undefined) return undefined
				complete(session, slot, outcomes[n] ?? 'accept')
				if (slot.kind === 'scheduled' && fires[n]) enqueueCalibrationBatch(session.scheduler, session.progress, dark, slot)
				return `${slot.id}#${slot.attempt}`
			}

			const reference = sessionOf(capture)
			const trace: string[] = []
			for (let entry = advance(reference, 0); entry !== undefined; entry = advance(reference, trace.length)) trace.push(entry)

			for (let k = 0; k <= trace.length; k++) {
				const session = sessionOf(capture)
				for (let n = 0; n < k; n++) advance(session, n)

				const restored = restore(capture, serialize(session))
				const tail: string[] = []
				for (let entry = advance(restored, k); entry !== undefined; entry = advance(restored, k + tail.length)) tail.push(entry)

				expect(tail).toEqual(trace.slice(k))
			}
		}
	})

	test('P6: synthetic sessions never exceed maxFrames per triggered group nor the exposure bound of section 8.4', () => {
		const random = mulberry32(0x5eed06)
		const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
		const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]

		for (let i = 0; i < 500; i++) {
			const policyOf = (): SequencerFrameDiscardPolicy | undefined => (random() < 0.25 ? undefined : { criteria: { quality: true, guidingInterruption: false, unsafeDuringExposure: false }, maxDiscardsPerSlot: integer(0, 2), onExhausted: pick(['keepLast', 'skipSlot'] as const), artifact: 'moveToRejected' })
			const lights = Array.from({ length: integer(1, 4) }, (_, k) => scheduled(`L${k}`, integer(0, 8), { discard: policyOf(), weight: 0.5 + random() * 4 }))
			const darks = Array.from({ length: integer(1, 3) }, (_, k): SequencerTriggeredFrameGroup => {
				const trigger = pick<SequencerFrameGroupTrigger>([{ kind: 'afterFrames', frames: integer(1, 3), ...(random() < 0.3 && { sourceGroups: [lights[0].id] }) }, { kind: 'temperatureChange', delta: 0.2 + random() }, { kind: 'sessionStart' }, { kind: 'sessionEnd', onStop: false }])
				const batchSize = integer(1, 3)
				return triggered(`D${k}`, trigger, { batchSize, maxFrames: integer(batchSize, 6), inherit: trigger.kind === 'sessionStart' || random() < 0.5 ? 'none' : 'triggeringFrame', enabled: random() < 0.9, discard: policyOf() })
			})
			const capture: SequencerCaptureConfiguration = { ...captureOf(pick(ORDERS), [...lights, ...darks]), retry: { maxAttempts: integer(1, 3), delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure: 'skipFrame' }
			const session = { ...sessionOf(capture), anchors: createSequencerTriggerAnchors(configurationOf(capture)) }
			const slots = new Map<string, Set<string>>()
			let exposures = 0
			let consecutive = 0
			let temperature = -10

			for (let slot = select(session); slot !== undefined; slot = select(session)) {
				const group = capture.groups.find((group) => group.id === slot.groupId)!
				const counters = session.progress.get(slot.groupId)!
				if (!slots.has(slot.groupId)) slots.set(slot.groupId, new Set())
				slots.get(slot.groupId)!.add(slot.id)
				exposures++
				session.current = undefined

				// A capture failure without frame: retried while the budget lasts, then the slot is skipped.
				if (random() < 0.15) {
					const captureFailures = slot.captureFailures + 1
					if (captureFailures < capture.retry.maxAttempts) session.current = { ...slot, captureFailures }
					else counters.skipped++
					continue
				}

				temperature += (random() - 0.5) * 0.6
				const policy = group.discard
				const decision = policy === undefined || random() < 0.6 ? 'accepted' : decideFrameOutcome(policy, slot, consecutive, false)

				if (decision === 'accepted') counters.accepted++
				else if (decision === 'forced') counters.forced++
				else {
					counters.discarded++
					if (decision === 'skipSlot') counters.skipped++
					else session.current = { ...slot, discardedTotal: slot.discardedTotal + 1, discardBudgetUsed: slot.discardBudgetUsed + 1, captureFailures: 0 }
				}

				consecutive = decision === 'accepted' || decision === 'forced' ? 0 : consecutive + 1
				if (slot.kind === 'scheduled') fireCalibrationTriggers(capture, session.scheduler, session.progress, session.anchors, slot, random() < 0.1 ? undefined : temperature, session.events)
				if (exposures > 10000) throw new Error('the session did not terminate')
			}

			let bound = 0

			for (const group of capture.groups) {
				const attempts = (1 + (group.discard?.maxDiscardsPerSlot ?? 0)) * capture.retry.maxAttempts
				if (group.kind === 'scheduled') bound += group.count * attempts
				else {
					bound += group.maxFrames * attempts
					expect(slots.get(group.id)?.size ?? 0).toBeLessThanOrEqual(group.maxFrames)
					expect(consumedSlotsOf(session.scheduler, session.progress, group.id)).toBeLessThanOrEqual(group.maxFrames)
				}
			}

			expect(exposures).toBeLessThanOrEqual(bound)
		}
	})

	test('P5: reordering the groups preserves the slot ids', () => {
		const random = mulberry32(0x5eed05)

		for (let i = 0; i < 500; i++) {
			const groups = randomScheduledGroups(random)
			const order = ORDERS[i % ORDERS.length]
			const ids = drain(sessionOf(captureOf(order, groups)))
			const reordered = drain(sessionOf(captureOf(order, shuffle(random, groups))))
			expect(reordered.toSorted()).toEqual(ids.toSorted())
		}
	})
})
