import { describe, expect, test } from 'bun:test'
import { failedOperationResult, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay, awaitCooperativeJob, type CooperativeJobHealth, type CooperativeJobOutcome, settleWithSignal, settlesWithin, waitForDeviceState } from '../../../src/devices/orchestration/operation.wait'

function rejectUnknown(value: unknown): Promise<never> {
	const rejected = Promise.withResolvers<never>()
	rejected.reject(value)
	return rejected.promise
}

function trackAbortListeners(signal: AbortSignal) {
	const listeners = new Set<unknown>()
	const add = signal.addEventListener.bind(signal)
	const remove = signal.removeEventListener.bind(signal)

	signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
		if (type === 'abort') listeners.add(listener)
		add(type, listener, options)
	}) as typeof signal.addEventListener

	signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
		if (type === 'abort') listeners.delete(listener)
		remove(type, listener, options)
	}) as typeof signal.removeEventListener

	return listeners
}

function trackUnhandledRejections() {
	const reasons: unknown[] = []
	const listener = (reason: unknown) => reasons.push(reason)
	process.on('unhandledRejection', listener)
	return { reasons, dispose: () => process.off('unhandledRejection', listener) }
}

describe('operation waits', () => {
	test('reports whether a promise settles before the deadline', async () => {
		expect(await settlesWithin(Promise.resolve(), 1000)).toBeTrue()
		expect(await settlesWithin(Promise.reject(new Error('rejected')), 1000)).toBeTrue()
		expect(await settlesWithin(new Promise(() => {}), 0)).toBeFalse()
	})

	test('aborts a delay with the signal reason', async () => {
		const controller = new AbortController()
		const delayed = abortableDelay(1000, controller.signal)

		controller.abort('disconnected')

		expect(await delayed).toEqual(failedOperationResult('disconnected'))
	})

	test('does not subscribe or command when already aborted', async () => {
		const controller = new AbortController()
		let subscribed = false
		let commanded = false
		controller.abort('removed')

		const result = waitForDeviceState({
			signal: controller.signal,
			timeout: 1000,
			subscribe: () => {
				subscribed = true
				return () => {}
			},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: () => {
				commanded = true
			},
		})

		expect(await result).toEqual(failedOperationResult('removed'))
		expect(subscribed).toBeFalse()
		expect(commanded).toBeFalse()
	})

	test('subscribes before sending a command and resolves from observed state', async () => {
		const controller = new AbortController()
		const listeners = new Set<(state: string) => void>()
		let state = 'idle'
		const result = waitForDeviceState({
			signal: controller.signal,
			timeout: 1000,
			subscribe: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			current: () => state,
			evaluate: (update) => (update === 'ready' ? 'success' : 'pending'),
			command: () => {
				expect(listeners.size).toBe(1)
				state = 'ready'
				for (const listener of listeners) listener(state)
			},
		})

		expect(await result).toEqual(successfulOperationResult('ready'))
		expect(listeners.size).toBe(0)
	})

	test('lets command failure win over a synchronous terminal event', async () => {
		const listeners = new Set<(state: string) => void>()
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			current: () => 'ready',
			evaluate: (update) => (update === 'ready' ? 'success' : 'pending'),
			command: () => {
				for (const listener of listeners) listener('ready')
				throw new Error('send failed')
			},
		})

		expect(await result).toEqual(failedOperationResult('commandFailed', 'send failed'))
		expect(listeners.size).toBe(0)
	})

	test('normalizes a symbol rejected by the command', async () => {
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => () => {},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: () => rejectUnknown(Symbol('send failed')),
		})

		expect(await result).toEqual(failedOperationResult('commandFailed', 'send failed'))
	})

	test('runs physical abort after a command failure settles', async () => {
		const events: string[] = []
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => () => {},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: () => {
				events.push('command')
				throw new Error('send failed')
			},
			abort: () => {
				events.push('abort')
			},
		})

		expect(await result).toEqual(failedOperationResult('commandFailed', 'send failed'))
		expect(events).toEqual(['command', 'abort'])
	})

	test('falls back when a rejected value cannot be converted to text', async () => {
		const failure = {
			[Symbol.toPrimitive]: () => {
				throw new Error('conversion failed')
			},
		}
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => () => {},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: () => rejectUnknown(failure),
		})

		expect(await result).toEqual(failedOperationResult('commandFailed', 'Unknown error'))
	})

	test('cancels and awaits an asynchronous command before physical abort', async () => {
		const commandGate = Promise.withResolvers<void>()
		const commandStarted = Promise.withResolvers<AbortSignal>()
		const events: string[] = []
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 0,
			subscribe: () => () => {},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: async (signal) => {
				commandStarted.resolve(signal)
				await commandGate.promise
				if (!signal.aborted) events.push('dispatched')
				events.push('command:stopped')
			},
			abort: () => {
				events.push('abort')
			},
		})

		const commandSignal = await commandStarted.promise
		await Bun.sleep(1)

		expect(commandSignal.aborted).toBeTrue()
		expect(events).toEqual([])

		commandGate.resolve()

		expect(await result).toEqual(failedOperationResult('timeout'))
		expect(events).toEqual(['command:stopped', 'abort'])
	})

	test('forces physical abort when a canceled command does not stop', async () => {
		const commandStarted = Promise.withResolvers<AbortSignal>()
		let aborts = 0
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 0,
			commandAbortTimeout: 5,
			subscribe: () => () => {},
			current: () => 'busy',
			evaluate: () => 'pending',
			command: (signal) => {
				commandStarted.resolve(signal)
				return new Promise(() => {})
			},
			abort: () => {
				aborts++
			},
		})

		const commandSignal = await commandStarted.promise

		expect(await result).toEqual(failedOperationResult('timeout', 'command did not stop before abort cleanup'))
		expect(commandSignal.aborted).toBeTrue()
		expect(aborts).toBe(1)
	})

	test('runs abort cleanup on timeout and removes every listener', async () => {
		const controller = new AbortController()
		const listeners = new Set<(state: string) => void>()
		let aborts = 0
		const result = waitForDeviceState({
			signal: controller.signal,
			timeout: 5,
			subscribe: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			current: () => 'busy',
			evaluate: () => 'pending',
			command: () => {},
			abort: () => {
				aborts++
			},
		})

		expect(await result).toEqual(failedOperationResult('timeout'))
		expect(aborts).toBe(1)
		expect(listeners.size).toBe(0)
	})

	test('completes a delay that is never aborted', async () => {
		expect(await abortableDelay(1, new AbortController().signal)).toEqual(successfulOperationResult(undefined))
	})

	test('resolves from the state read after the command when no event follows', async () => {
		let reads = 0
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => () => {},
			// The device was already at the target, so the driver has no transition to report.
			current: () => {
				reads++
				return 'ready'
			},
			evaluate: (update) => (update === 'ready' ? 'success' : 'pending'),
			command: () => {},
		})

		expect(await result).toEqual(successfulOperationResult('ready'))
		expect(reads).toBe(1)
	})

	test('fails with the reason the evaluation reported for an observed state', async () => {
		const listeners = new Set<(state: string) => void>()
		let aborts = 0
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			current: () => 'slewing',
			evaluate: (update) => (update === 'alert' ? 'alert' : 'pending'),
			command: () => {
				for (const listener of listeners) listener('alert')
			},
			abort: () => {
				aborts++
			},
		})

		expect(await result).toEqual(failedOperationResult('alert'))
		expect(listeners.size).toBe(0)
		// The command failed while the device may still be working, so the physical stop runs before the
		// result settles: an Alert during a slew must not release a mount that is still moving.
		expect(aborts).toBe(1)
	})

	test('reports an evaluate that throws as an unexpected state', async () => {
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => () => {},
			current: () => 'ready',
			evaluate: () => {
				throw new Error('unreadable property')
			},
			command: () => {},
		})

		expect(await result).toEqual(failedOperationResult('unexpectedState', 'unreadable property'))
	})

	test('reports a current state that cannot be read as an unexpected state', async () => {
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => () => {},
			current: () => {
				throw new Error('device vanished')
			},
			evaluate: () => 'pending',
			command: () => {},
		})

		expect(await result).toEqual(failedOperationResult('unexpectedState', 'device vanished'))
	})

	test('never sends the command when the subscription fails', async () => {
		let commanded = false
		const result = waitForDeviceState({
			signal: new AbortController().signal,
			timeout: 1000,
			subscribe: () => {
				throw new Error('bus unavailable')
			},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: () => {
				commanded = true
			},
		})

		expect(await result).toEqual(failedOperationResult('commandFailed', 'bus unavailable'))
		expect(commanded).toBeFalse()
	})

	test('unsubscribes and skips the command when the signal aborts during setup', async () => {
		const controller = new AbortController()
		let commanded = false
		let unsubscribed = false
		const result = waitForDeviceState({
			signal: controller.signal,
			timeout: 1000,
			subscribe: () => {
				controller.abort('disconnected')
				return () => {
					unsubscribed = true
				}
			},
			current: () => 'idle',
			evaluate: () => 'pending',
			command: () => {
				commanded = true
			},
		})

		expect(await result).toEqual(failedOperationResult('disconnected'))
		expect(commanded).toBeFalse()
		expect(unsubscribed).toBeTrue()
	})

	test('reports a physical abort that fails while cancelling', async () => {
		const controller = new AbortController()
		const result = waitForDeviceState({
			signal: controller.signal,
			timeout: 1000,
			subscribe: () => () => {},
			current: () => 'busy',
			evaluate: () => 'pending',
			command: () => {},
			abort: () => {
				throw new Error('stop rejected')
			},
		})

		controller.abort('aborted')

		expect(await result).toEqual(failedOperationResult('aborted', 'abort failed: stop rejected'))
	})

	test('returns the same promise when no signal is given', () => {
		const promise = Promise.resolve(1)
		expect(settleWithSignal(promise)).toBe(promise)
	})

	test('resolves with the value and removes the abort listener when the signal never aborts', async () => {
		const controller = new AbortController()
		const listeners = trackAbortListeners(controller.signal)
		const settled = settleWithSignal(Promise.resolve(42), controller.signal)

		expect(listeners.size).toBe(1)
		expect(await settled).toBe(42)
		expect(listeners.size).toBe(0)
	})

	test('passes an Error rejection through unchanged and removes the abort listener', async () => {
		const controller = new AbortController()
		const listeners = trackAbortListeners(controller.signal)
		const error = new Error('command failed')

		expect(await settleWithSignal(Promise.reject(error), controller.signal).catch((e: unknown) => e)).toBe(error)
		expect(listeners.size).toBe(0)
	})

	test('normalizes a non-Error rejection without reporting an abort', async () => {
		const controller = new AbortController()
		const error = await settleWithSignal(rejectUnknown('boom'), controller.signal).catch((e: unknown) => e)

		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(DOMException)
		expect((error as Error).message).toBe('boom')
		expect((error as Error).cause).toBe('boom')
		expect(controller.signal.aborted).toBeFalse()
	})

	test('rejects with an Error reason when the signal aborts first and ignores the later settlement', async () => {
		const controller = new AbortController()
		const pending = Promise.withResolvers<number>()
		const reason = new Error('disconnected')
		const settled = settleWithSignal(pending.promise, controller.signal)

		controller.abort(reason)
		pending.resolve(1)

		expect(await settled.catch((e: unknown) => e)).toBe(reason)
	})

	test('keeps an operational string reason as the cause of an AbortError', async () => {
		const controller = new AbortController()
		const settled = settleWithSignal(new Promise<never>(() => {}), controller.signal)

		controller.abort('timeout')

		const error = await settled.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(DOMException)
		expect((error as DOMException).name).toBe('AbortError')
		expect((error as DOMException).cause).toBe('timeout')
	})

	test('rejects with the default AbortError reason of a bare abort', async () => {
		const controller = new AbortController()
		const settled = settleWithSignal(new Promise<never>(() => {}), controller.signal)

		controller.abort()

		expect(await settled.catch((e: unknown) => e)).toBe(controller.signal.reason)
		expect((controller.signal.reason as DOMException).name).toBe('AbortError')
	})

	test('rejects at once on an already aborted signal without leaving the promise unobserved', async () => {
		const controller = new AbortController()
		const listeners = trackAbortListeners(controller.signal)
		const pending = Promise.withResolvers<number>()
		const unhandled = trackUnhandledRejections()
		controller.abort('removed')

		try {
			const error = await settleWithSignal(pending.promise, controller.signal).catch((e: unknown) => e)
			expect((error as DOMException).name).toBe('AbortError')
			expect((error as DOMException).cause).toBe('removed')
			expect(listeners.size).toBe(0)

			pending.reject(new Error('late failure'))
			await Bun.sleep(10)
			expect(unhandled.reasons).toBeEmpty()
		} finally {
			unhandled.dispose()
		}
	})

	test('swallows a rejection that arrives after the signal aborted', async () => {
		const controller = new AbortController()
		const pending = Promise.withResolvers<number>()
		const unhandled = trackUnhandledRejections()

		try {
			const settled = settleWithSignal(pending.promise, controller.signal)
			controller.abort('aborted')
			expect(await settled.catch((e: unknown) => e)).toBeInstanceOf(DOMException)

			pending.reject(new Error('late failure'))
			await Bun.sleep(10)
			expect(unhandled.reasons).toBeEmpty()
		} finally {
			unhandled.dispose()
		}
	})
})

// Delays that only resolve when the test advances time, in deadline order.
function manualDelays() {
	let now = 0
	const pending: { deadline: number; resolve: (result: OperationResult<void>) => void; signal: AbortSignal; abort: VoidFunction }[] = []

	const delay = (ms: number, signal: AbortSignal) => {
		if (signal.aborted) return Promise.resolve<OperationResult<void>>(failedOperationResult('aborted'))
		const { promise, resolve } = Promise.withResolvers<OperationResult<void>>()
		const entry = {
			deadline: now + ms,
			resolve,
			signal,
			abort: () => {
				pending.splice(pending.indexOf(entry), 1)
				resolve(failedOperationResult('aborted'))
			},
		}
		signal.addEventListener('abort', entry.abort, { once: true })
		pending.push(entry)
		pending.sort((a, b) => a.deadline - b.deadline)
		return promise
	}

	const advance = async (ms: number) => {
		const target = now + ms
		while (pending.length > 0 && pending[0].deadline <= target) {
			const entry = pending.shift()!
			now = entry.deadline
			entry.signal.removeEventListener('abort', entry.abort)
			entry.resolve(successfulOperationResult(undefined))
			await flush()
		}
		now = target
		await flush()
	}

	return { delay, advance, pending: () => pending.length }
}

async function flush() {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

// Job that never looks at its signal and ends only when the test releases it.
function stubbornJob<T>() {
	const { promise, resolve } = Promise.withResolvers<T>()
	let calls = 0
	let signal: AbortSignal | undefined
	const job = (received: AbortSignal) => {
		calls++
		signal = received
		return promise
	}
	return { job, release: resolve, calls: () => calls, signal: () => signal }
}

describe('cooperative jobs', () => {
	test('a job that settles first ends with its value or its rejection; a synchronous throw is a rejection', async () => {
		const { delay, pending } = manualDelays()
		const options = { signal: new AbortController().signal, timeout: 1000, abortGrace: 500, delay }

		expect(await awaitCooperativeJob(() => Promise.resolve(42), options)).toEqual({ kind: 'resolved', value: 42 })
		expect(await awaitCooperativeJob(() => Promise.reject(new Error('no stars')), options)).toMatchObject({ kind: 'rejected', error: new Error('no stars') })
		expect(
			await awaitCooperativeJob(() => {
				throw new Error('sync')
			}, options),
		).toMatchObject({ kind: 'rejected', error: new Error('sync') })
		expect(pending()).toBe(0)
	})

	test('the timeout aborts the signal and the job is awaited to its end; its late value is discarded', async () => {
		const { delay, advance, pending } = manualDelays()
		const stubborn = stubbornJob<number>()
		let outcome: CooperativeJobOutcome<number> | undefined
		void awaitCooperativeJob(stubborn.job, { signal: new AbortController().signal, timeout: 1000, abortGrace: 5000, delay }).then((value) => (outcome = value))

		await advance(999)
		expect(stubborn.signal()!.aborted).toBeFalse()
		await advance(1)
		expect(stubborn.signal()!.aborted).toBeTrue()
		expect(stubborn.signal()!.reason).toBe('timeout')
		// The job ignores the abort and ends 2 s later, within the grace: no report, no fault.
		await advance(2000)
		expect(outcome).toBeUndefined()
		stubborn.release(7)
		await flush()
		expect(outcome).toEqual({ kind: 'timeout', unresponsive: false })
		expect(pending()).toBe(0)
	})

	test('a job still running abortGrace after the abort is reported once, then faults the collaborator when it ends', async () => {
		const { delay, advance, pending } = manualDelays()
		const stubborn = stubbornJob<number>()
		const reports: string[] = []
		const health: CooperativeJobHealth = { faulted: false, onUnresponsive: () => reports.push('unresponsive'), onFaulted: () => reports.push('faulted') }
		let outcome: CooperativeJobOutcome<number> | undefined
		void awaitCooperativeJob(stubborn.job, { signal: new AbortController().signal, timeout: 1000, abortGrace: 5000, delay, health }).then((value) => (outcome = value))

		await advance(1000 + 4999)
		expect(reports).toEqual([])
		await advance(1)
		expect(reports).toEqual(['unresponsive'])
		expect(health.faulted).toBeFalse()
		// No limit: an hour later it still waits.
		await advance(3_600_000)
		expect(outcome).toBeUndefined()
		expect(reports).toEqual(['unresponsive'])

		stubborn.release(1)
		await flush()
		expect(outcome).toEqual({ kind: 'timeout', unresponsive: true })
		expect(health.faulted).toBeTrue()
		expect(reports).toEqual(['unresponsive', 'faulted'])
		expect(pending()).toBe(0)

		// A faulted collaborator is never called again.
		const next = stubbornJob<number>()
		expect(await awaitCooperativeJob(next.job, { signal: new AbortController().signal, timeout: 1000, abortGrace: 5000, delay, health })).toEqual({ kind: 'faulted' })
		expect(next.calls()).toBe(0)
	})

	test('the caller abort ends as aborted after the job; an already aborted caller never calls the job', async () => {
		const { delay, advance, pending } = manualDelays()
		const controller = new AbortController()
		let aborted: AbortSignal | undefined
		let outcome: CooperativeJobOutcome<string> | undefined
		void awaitCooperativeJob(
			(signal) => {
				aborted = signal
				return new Promise<string>((_, reject) => {
					signal.addEventListener('abort', () => reject(new Error('killed')), { once: true })
				})
			},
			{ signal: controller.signal, timeout: 1000, abortGrace: 500, delay },
		).then((value) => (outcome = value))

		await advance(100)
		controller.abort()
		await flush()
		expect(aborted!.reason).toBe('aborted')
		expect(outcome).toEqual({ kind: 'aborted', unresponsive: false })
		expect(pending()).toBe(0)

		const never = stubbornJob<string>()
		expect(await awaitCooperativeJob(never.job, { signal: controller.signal, timeout: 1000, abortGrace: 500, delay })).toEqual({ kind: 'aborted', unresponsive: false })
		expect(never.calls()).toBe(0)
	})

	test('a job that settles in the same tick as its timeout has exactly one outcome', async () => {
		const { delay, advance } = manualDelays()
		const outcomes: CooperativeJobOutcome<number>[] = []
		const job = (signal: AbortSignal) =>
			new Promise<number>((resolve) => {
				void delay(1000, new AbortController().signal).then(() => resolve(signal.aborted ? -1 : 1))
			})
		void awaitCooperativeJob(job, { signal: new AbortController().signal, timeout: 1000, abortGrace: 500, delay }).then((value) => outcomes.push(value))

		await advance(1000)
		await advance(1000)
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]).toEqual(outcomes[0].kind === 'resolved' ? { kind: 'resolved', value: 1 } : { kind: 'timeout', unresponsive: false })
	})
})
