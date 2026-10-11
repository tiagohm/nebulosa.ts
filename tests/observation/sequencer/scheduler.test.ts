import { describe, expect, test } from 'bun:test'
import { mulberry32, type Random } from '../../../src/math/numerical/random'
import { completedSlotsOf, consumedSlotsOf, enqueueCalibrationBatch, type SequencerTriggerEvent, selectNextFrame, sequencerFrameSlotId } from '../../../src/observation/sequencer/scheduler'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCaptureConfiguration, SequencerCaptureOrder, SequencerConfiguration, SequencerFrameGroup, SequencerFrameGroupTrigger, SequencerFrameSlot, SequencerScheduledFrameGroup, SequencerSchedulerState, SequencerTriggeredFrameGroup } from '../../../src/observation/sequencer/sequencer'
import { createSequencerCaptureProgress, createSequencerSchedulerState, type SequencerCaptureProgress } from '../../../src/observation/sequencer/state'

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
