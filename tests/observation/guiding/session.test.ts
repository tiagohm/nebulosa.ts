import { describe, expect, test } from 'bun:test'
import { OperationCoordinator, successfulOperationResult, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import type { DitherPhase } from '../../../src/observation/guiding/ditherer'
import { type GuidingInterruption, GuidingInterruptionHistory, GuidingSettleListeners, waitForGuidingSettle } from '../../../src/observation/guiding/session'
import { ManualSequencerClock } from '../sequencer/util'

function interruption(receivedMonotonic: number, kind: GuidingInterruption['kind'] = 'starLost'): GuidingInterruption {
	return { kind, receivedMonotonic, receivedAt: Date.UTC(2026, 0, 1) + receivedMonotonic }
}

describe('49.11 interruption history', () => {
	test('10: a window returns the interruptions inside it, both ends included', () => {
		const history = new GuidingInterruptionHistory(4)
		history.record(interruption(1000))

		expect(history.query(1000, 2000)).toEqual({ interruptions: [interruption(1000)], truncated: false })
		expect(history.query(500, 1000)).toEqual({ interruptions: [interruption(1000)], truncated: false })
		expect(history.query(1001, 2000)).toEqual({ interruptions: [], truncated: false })
		expect(history.query(0, 999)).toEqual({ interruptions: [], truncated: false })
	})

	test('11: an overflow that evicts an interruption of the window truncates it (2 variants)', () => {
		const history = new GuidingInterruptionHistory(4)
		for (const at of [100, 200, 300, 400, 500, 600]) history.record(interruption(at))

		// 100 and 200 were evicted: a window starting at or before 200 no longer proves anything.
		expect(history.evictedThrough).toBe(200)
		const window = history.query(150, 700)
		expect(window.truncated).toBeTrue()
		expect(window.interruptions.map((each) => each.receivedMonotonic)).toEqual([300, 400, 500, 600])

		// A plain bounded array would answer "nothing in [150, 250]" and call the window clean.
		const bounded = [300, 400, 500, 600]
		expect(bounded.filter((at) => at >= 150 && at <= 250)).toEqual([])
		expect(history.query(150, 250)).toEqual({ interruptions: [], truncated: true })
	})

	test('12: an overflow of interruptions before the window keeps it covered', () => {
		const history = new GuidingInterruptionHistory(4)
		for (const at of [100, 200, 300, 400, 500, 600]) history.record(interruption(at))
		expect(history.query(201, 1000)).toEqual({ interruptions: [300, 400, 500, 600].map((at) => interruption(at)), truncated: false })
	})

	test('13: evictedThrough is monotonic and the history never exceeds its capacity', () => {
		const history = new GuidingInterruptionHistory(4)
		let previous = history.evictedThrough

		for (let i = 0; i < 10000; i++) {
			history.record(interruption(i))
			expect(history.evictedThrough).toBeGreaterThanOrEqual(previous)
			previous = history.evictedThrough
		}

		expect(history.size).toBe(4)
		expect(history.evictedThrough).toBe(9995)
		expect(history.query(9996, 9999).interruptions).toHaveLength(4)
	})

	test('13: the history is in the monotonic domain only, so a wall jump changes no window', () => {
		const clock = new ManualSequencerClock()
		const history = new GuidingInterruptionHistory(4)
		const record = () => history.record({ kind: 'starLost', receivedMonotonic: clock.monotonicNow(), receivedAt: clock.wallNow() })

		record()
		clock.jumpWall(-3600_000)
		record()
		clock.jumpWall(7200_000)
		record()

		expect(history.query(0, 0).interruptions).toHaveLength(3)
	})
})

describe('settle wait', () => {
	const coordinator = new OperationCoordinator(new ResourceArbiter())

	test('only a settle end delivered after the dispatch began counts; its status decides', async () => {
		const clock = new ManualSequencerClock()
		const listeners = new GuidingSettleListeners()
		listeners.notify({ kind: 'done', status: 0 })

		const phases: DitherPhase[] = []
		const pending = waitForGuidingSettle(
			coordinator,
			'settle',
			listeners,
			1000,
			clock.delay,
			() => {
				// Events delivered before the reply of the command are correlated.
				listeners.notify({ kind: 'dithered', dx: 1, dy: -2 })
				listeners.notify({ kind: 'settling' })
				return Promise.resolve(successfulOperationResult(undefined))
			},
			(phase) => phases.push(phase),
		)

		listeners.notify({ kind: 'done', status: 0 })
		expect(await pending).toEqual(successfulOperationResult({ lockShift: [1, -2] }))
		expect(phases).toEqual(['dithered', 'settling', 'settled'])

		const failed = waitForGuidingSettle(coordinator, 'settle', listeners, 1000, clock.delay, () => successfulOperationResult(undefined))
		listeners.notify({ kind: 'done', status: 1, error: 'star lost' })
		expect(await failed).toMatchObject({ ok: false, reason: 'commandFailed' })
		expect(clock.pending).toBe(0)
	})

	test('a refused dispatch, a lost guider, the timeout and a cancellation end the wait', async () => {
		const clock = new ManualSequencerClock()
		const listeners = new GuidingSettleListeners()

		expect(await waitForGuidingSettle(coordinator, 'settle', listeners, 1000, clock.delay, () => failedOperationResult('unexpectedState'))).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(await waitForGuidingSettle(coordinator, 'settle', listeners, 1000, clock.delay, () => Promise.reject(new Error('boom')))).toMatchObject({ ok: false, reason: 'commandFailed' })

		const lost = waitForGuidingSettle(coordinator, 'settle', listeners, 1000, clock.delay, () => successfulOperationResult(undefined))
		listeners.notify({ kind: 'lost', reason: 'disconnected' })
		expect(await lost).toMatchObject({ ok: false, reason: 'disconnected' })

		const timed = waitForGuidingSettle(coordinator, 'settle', listeners, 1000, clock.delay, () => successfulOperationResult(undefined))
		await clock.advance(999)
		await clock.advance(1)
		expect(await timed).toMatchObject({ ok: false, reason: 'timeout' })

		const handle = coordinator.start('task', [], (scope) => waitForGuidingSettle(scope, 'settle', listeners, 1000, clock.delay, () => successfulOperationResult(undefined)))
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(clock.pending).toBe(0)
	})
})
