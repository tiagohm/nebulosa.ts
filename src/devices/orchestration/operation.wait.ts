import { errorMessage } from '../../core/util'
import { failedOperationResult, successfulOperationResult, type OperationFailureReason, type OperationResult } from './operation'

// Cancellable waiting primitives for device commands and for cooperative jobs. Waits subscribe before
// commanding, settle on the first decisive device state, a timeout, or an abort signal, and always remove their
// timers and listeners. Every non-successful outcome of a dispatched command runs a physical abort before it
// settles, so a caller never releases a device that may still be moving. A cooperative job (a caller-provided
// plate solver, HFD measurer or quality analyzer) is aborted by its timeout but always awaited to its end, so
// nothing it reads moves before it finished. Durations are milliseconds.

// Everything needed to command a device and wait for the physical state that proves the command took
// effect. The device itself is not a field: subscribe, current, and command already close over it.
export interface WaitForDeviceOptions<U> {
	// Operation signal that cancels the wait and its optional physical abort.
	readonly signal: AbortSignal
	// Maximum wait duration in milliseconds.
	readonly timeout: number
	// Installs the update observer and returns an idempotent unsubscriber.
	readonly subscribe: (listener: (update: U) => void) => VoidFunction
	// Reads current state after the command has been sent.
	readonly current: () => U
	// Classifies each state as pending, successful, or an expected failure.
	readonly evaluate: (update: U) => 'pending' | 'success' | OperationFailureReason
	// Sends the state-changing command after setup; the signal aborts before timeout or abort cleanup can settle.
	readonly command: (signal: AbortSignal) => void | Promise<void>
	// Maximum milliseconds to wait for a canceled command before forcing physical abort cleanup.
	readonly commandAbortTimeout?: number
	// Stops or quiesces physical work before any non-successful result settles, whether the cause was an
	// abort, a timeout, a failed command, or a failure verdict the device itself reported. Only a wait
	// whose command was never dispatched skips it.
	readonly abort?: () => void | Promise<void>
}

// Default grace period in milliseconds for a canceled command to stop before physical abort runs.
const DEFAULT_COMMAND_ABORT_TIMEOUT = 1000

// Reports whether a promise settles, either way, within the timeout in milliseconds (negative is zero).
// The promise is observed, never cancelled, and the timer is cleared as soon as either side wins.
export async function settlesWithin(promise: Promise<unknown>, timeout: number): Promise<boolean> {
	const elapsed = Promise.withResolvers<boolean>()
	const timer = setTimeout(() => elapsed.resolve(false), Math.max(0, timeout))

	void promise.then(
		() => elapsed.resolve(true),
		() => elapsed.resolve(true),
	)

	try {
		return await elapsed.promise
	} finally {
		clearTimeout(timer)
	}
}

// Settles like `promise` unless `signal` aborts first, in which case it rejects with the signal's abort
// error (see abortReasonOf). The promise is observed, never cancelled: a rejection arriving after the abort
// is swallowed instead of surfacing as an unhandled rejection. A non-Error rejection is normalized to an
// Error whose cause is the rejected value. Without a signal the promise is returned unchanged.
export function settleWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise

	if (signal.aborted) {
		void promise.catch(() => {})
		return Promise.reject(abortReasonOf(signal))
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortReasonOf(signal))

		signal.addEventListener('abort', onAbort, { once: true })

		void promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				reject(error instanceof Error ? error : new Error(errorMessage(error), { cause: error }))
			},
		)
	})
}

// Waits for a temporal delay in milliseconds and removes its timer/listener on abort.
export function abortableDelay(ms: number, signal: AbortSignal): Promise<OperationResult<void>> {
	if (signal.aborted) return Promise.resolve(aborted(signal))

	const delayed = Promise.withResolvers<OperationResult<void>>()
	let settled = false
	const finish = (result: OperationResult<void>) => {
		if (settled) return
		settled = true
		clearTimeout(timer)
		signal.removeEventListener('abort', onAbort)
		delayed.resolve(result)
	}

	const onAbort = () => {
		finish(aborted(signal))
	}

	const timer = setTimeout(() => finish(successfulOperationResult(undefined)), Math.max(0, ms))
	signal.addEventListener('abort', onAbort, { once: true })
	return delayed.promise
}

// Abortable wait in milliseconds with the contract of `abortableDelay`; injectable so a manual clock drives it.
export type AbortableDelay = (ms: number, signal: AbortSignal) => Promise<OperationResult<void>>

// Health of one collaborator across its calls, owned by the caller (one per service and session) and mutated in
// place by `awaitCooperativeJob`.
export interface CooperativeJobHealth {
	// Set once a job outlived its abort grace and then ended; a faulted collaborator is never called again.
	faulted: boolean
	// Called once per job when it is still running `abortGrace` after its abort.
	readonly onUnresponsive?: VoidFunction
	// Called once, when such a job finally ended and the collaborator became faulted.
	readonly onFaulted?: VoidFunction
}

// Bounds of one cooperative job.
export interface CooperativeJobOptions {
	// Cancellation of the caller; its abort aborts the job and ends as 'aborted'.
	readonly signal: AbortSignal
	// Time after which the job is aborted and ends as 'timeout', in ms (monotonic, through `delay`).
	readonly timeout: number
	// Watchdog after the abort before the job is reported unresponsive, in ms; it never shortens the wait.
	readonly abortGrace: number
	// Wait of the timeout and of the watchdog. Default `abortableDelay`.
	readonly delay?: AbortableDelay
	// Health of the collaborator; absent treats this call alone.
	readonly health?: CooperativeJobHealth
}

// Outcome of a cooperative job.
// - resolved / rejected: the job settled before any abort (a synchronous throw is a rejection);
// - timeout / aborted: the job was aborted by its timeout or by the caller and then awaited to its end; whatever it
//   produced is discarded. `unresponsive` reports that it outlived the abort grace (the collaborator is now faulted);
// - faulted: the collaborator was already faulted and was not called.
// A job whose caller was already aborted is not called either and ends as 'aborted'.
export type CooperativeJobOutcome<T> = { readonly kind: 'resolved'; readonly value: T } | { readonly kind: 'rejected'; readonly error: unknown } | { readonly kind: 'timeout' | 'aborted'; readonly unresponsive: boolean } | { readonly kind: 'faulted' }

// Runs a cooperative job with its own abort signal and a strictly cooperative timeout: the timeout or the caller
// aborts the signal, and the job is then awaited without limit, so a file it reads is never moved or removed while
// it still runs. `abortGrace` is only a watchdog: still running then, the job is reported once through
// `health.onUnresponsive`, and when it finally ends the collaborator is marked faulted (`health.onFaulted`, once).
// Exactly one outcome, decided by whichever of the settlement and the abort was observed first. Leaves no pending
// delay or listener behind. Never rejects.
export async function awaitCooperativeJob<T>(job: (signal: AbortSignal) => Promise<T>, options: CooperativeJobOptions): Promise<CooperativeJobOutcome<T>> {
	const { signal, timeout, abortGrace, delay = abortableDelay, health } = options
	if (health?.faulted === true) return { kind: 'faulted' }
	if (signal.aborted) return { kind: 'aborted', unresponsive: false }

	const controller = new AbortController()
	const timer = new AbortController()
	const aborted = Promise.withResolvers<undefined>()
	let cause: 'timeout' | 'aborted' | undefined
	// Set by the settlement itself, so neither a later abort nor the watchdog can contradict it.
	let finished = false

	const abort = (reason: 'timeout' | 'aborted') => {
		if (cause !== undefined || finished) return
		cause = reason
		controller.abort(reason)
		aborted.resolve(undefined)
	}

	const onAbort = () => abort('aborted')

	signal.addEventListener('abort', onAbort, { once: true })

	void delay(timeout, timer.signal).then((elapsed) => {
		if (elapsed.ok) abort('timeout')
	})

	// Called synchronously; a synchronous throw becomes a rejection.
	const running = new Promise<T>((resolve) => {
		resolve(job(controller.signal))
	})

	const settled = running.then(
		(value): CooperativeJobOutcome<T> => {
			finished = true
			return { kind: 'resolved', value }
		},
		(error: unknown): CooperativeJobOutcome<T> => {
			finished = true
			return { kind: 'rejected', error }
		},
	)

	try {
		const first = await Promise.race([settled, aborted.promise])
		if (cause === undefined && first !== undefined) return first

		// Aborted: the job is awaited to its end; the watchdog only reports it.
		const watchdog = new AbortController()
		let unresponsive = false

		void delay(abortGrace, watchdog.signal).then((elapsed) => {
			if (!elapsed.ok || finished) return
			unresponsive = true
			health?.onUnresponsive?.()
		})

		await settled
		watchdog.abort()

		if (unresponsive && health !== undefined) {
			health.faulted = true
			health.onFaulted?.()
		}

		return { kind: cause ?? 'aborted', unresponsive }
	} finally {
		timer.abort()
		signal.removeEventListener('abort', onAbort)
	}
}

// Subscribes before commanding a device and settles only after any canceled command has stopped.
export function waitForDeviceState<U>(options: WaitForDeviceOptions<U>): Promise<OperationResult<U>> {
	const { signal } = options

	if (signal.aborted) return Promise.resolve(aborted(signal))

	return new Promise((resolve) => {
		const commandController = new AbortController()
		const commandCompletion = Promise.withResolvers<void>()
		let settled = false
		let commandStarted = false
		let commandCompleted = false
		let pendingResult: OperationResult<U> | undefined
		let unsubscribe: VoidFunction = () => {}

		const cleanup = () => {
			clearTimeout(timer)
			unsubscribe()
			signal.removeEventListener('abort', onAbort)
		}

		const finish = (result: OperationResult<U>) => {
			if (settled) return
			settled = true
			cleanup()
			resolve(result)
		}

		const finishAfterAbort = async (reason: OperationFailureReason, error?: string) => {
			if (settled) return
			settled = true
			cleanup()
			commandController.abort(reason)

			if (commandStarted && !commandCompleted) {
				const stopped = await settlesWithin(commandCompletion.promise, options.commandAbortTimeout ?? DEFAULT_COMMAND_ABORT_TIMEOUT)

				if (!stopped) {
					const detail = 'command did not stop before abort cleanup'
					error = error ? `${error}; ${detail}` : detail
				}
			}

			try {
				await options.abort?.()
			} catch (abortError) {
				const detail = errorMessage(abortError)
				error = error ? `${error}; abort failed: ${detail}` : `abort failed: ${detail}`
			}

			resolve(failedOperationResult(reason, error))
		}

		// Concludes through the physical abort path whenever the device did not reach the intended state.
		// A verdict such as Alert in the middle of a slew means the command failed while the device may
		// still be moving, so resolving without stopping it would release the resource on a live axis.
		const settle = (result: OperationResult<U>) => {
			if (result.ok) finish(result)
			else void finishAfterAbort(result.reason, result.error)
		}

		const evaluate = (update: U): OperationResult<U> | undefined => {
			let evaluation: ReturnType<typeof options.evaluate>

			try {
				evaluation = options.evaluate(update)
			} catch (error) {
				return failedOperationResult('unexpectedState', errorMessage(error))
			}

			if (evaluation === 'success') {
				return successfulOperationResult(update)
			} else if (evaluation !== 'pending') {
				return failedOperationResult(evaluation)
			}
		}

		const listener = (update: U) => {
			const result = evaluate(update)

			if (result !== undefined) {
				if (commandCompleted) settle(result)
				else pendingResult ??= result
			}
		}

		const onAbort = () => void finishAfterAbort(abortReason(signal))
		const timer = setTimeout(() => void finishAfterAbort('timeout'), Math.max(0, options.timeout))

		signal.addEventListener('abort', onAbort, { once: true })

		try {
			unsubscribe = options.subscribe(listener)
		} catch (error) {
			finish(failedOperationResult('commandFailed', errorMessage(error)))
			return
		}

		if (settled) {
			unsubscribe()
			return
		}

		commandStarted = true

		void (async () => {
			try {
				await options.command(commandController.signal)
			} catch (error) {
				// The device may have accepted part of the command before failing, so this settles through the
				// abort path too; the completion promise it awaits resolves in the finally block below.
				settle(failedOperationResult('commandFailed', errorMessage(error)))
				return
			} finally {
				commandCompletion.resolve()
			}

			if (settled) return
			commandCompleted = true

			if (pendingResult !== undefined) {
				settle(pendingResult)
				return
			}

			try {
				const result = evaluate(options.current())
				if (result !== undefined) settle(result)
			} catch (error) {
				settle(failedOperationResult('unexpectedState', errorMessage(error)))
			}
		})()
	})
}

// Maps AbortSignal reasons into the finite operational failure contract.
export function abortReason(signal: AbortSignal): OperationFailureReason {
	const reason = signal.reason

	switch (reason) {
		case 'busy':
		case 'aborted':
		case 'disconnected':
		case 'removed':
		case 'timeout':
		case 'alert':
		case 'commandFailed':
		case 'unexpectedState':
			return reason
		default:
			return 'aborted'
	}
}

// Builds an aborted result using the signal's normalized operational reason.
function aborted<T>(signal: AbortSignal): OperationResult<T> {
	return failedOperationResult(abortReason(signal))
}

// Error reason stored on `signal`, or an AbortError DOMException whose cause keeps a non-Error reason
// such as the operational strings ('timeout', 'disconnected', ...) accepted by abortReason.
function abortReasonOf(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason
	const error = new DOMException('The operation was aborted.', 'AbortError')
	error.cause = signal.reason
	return error
}
