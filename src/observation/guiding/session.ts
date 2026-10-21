import { errorMessage } from '../../core/util'
import { failedOperationResult, type OperationFailureReason, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortReason } from '../../devices/orchestration/operation.wait'
import type { ResourceRequest } from '../../devices/orchestration/resource'
import type { CameraCaptureClock } from '../capture/types'
import type { DitherPhase } from './ditherer'

// Guiding boundary of observation sessions: the `GuidingSession` contract implemented by the PHD2 and the local
// GuiderClient adapters, the bounded history of guiding interruptions they keep, and the settle wait they share.
//
// A session owns one long-lived root `guiding`, opened by `start` under the reservation of its caller, which leases the
// `hold` resources for the life of the guiding and is cancelled by the device lifecycle when a device it guides with is
// lost. Every other command runs as a child of the scope of its caller, without resources. Interruptions are stamped
// with the clock of the caller that started the guiding, at their reception: the monotonic instant for windows, the
// wall instant (Unix ms) for diagnostics. Settle tolerances are guide-camera pixels, settle times seconds, and every
// bound, timeout and instant milliseconds.

// State of a guiding session. 'paused' is a pause of the corrections (by the session or by someone else); 'lost' is a
// guiding that lost its star, its lock or a device, recovered only by a new `start`.
export type GuidingSessionState = 'stopped' | 'calibrating' | 'guiding' | 'settling' | 'paused' | 'lost'

// Settle condition of guiding, in the shape of a PHD2 settle.
export interface GuidingSettle {
	// Accepted guide error, in guide-camera pixels; finite > 0.
	readonly pixels: number
	// Time the error must stay within `pixels`, in seconds; finite ≥ 0.
	readonly time: number
	// Longest settle, in seconds; finite > 0.
	readonly timeout: number
}

// How a guiding starts.
export interface GuidingStartOptions {
	// Recalibrates before guiding.
	readonly recalibrate: boolean
	// Settle the start waits for.
	readonly settle: GuidingSettle
	// Clock that stamps the interruptions from this start on; default `DEFAULT_GUIDING_CLOCK`. The Sequencer passes its
	// session clock.
	readonly clock?: CameraCaptureClock
}

// Resources of a guiding session: `reserve` becomes unavailable to third parties for the whole observation session;
// `hold` is the subset leased by the root `guiding` for the life of the guiding, never a resource the session commands
// through its own tasks.
export interface GuidingSessionResources {
	// Resources reserved by the observation session.
	readonly reserve: readonly ResourceRequest[]
	// Subset leased by the root `guiding`.
	readonly hold: readonly ResourceRequest[]
}

// What interrupted guiding: a lost star or lock position, a pause or a stop nobody of the session asked for, or the
// loss of a device (or of the connection to the guider).
export type GuidingInterruptionKind = 'starLost' | 'lockPositionLost' | 'paused' | 'stopped' | 'disconnected' | 'removed'

// One guiding interruption, stamped at its reception.
export interface GuidingInterruption {
	// What happened.
	readonly kind: GuidingInterruptionKind
	// Monotonic instant of the reception, in ms of the clock of the start; never a guider timestamp.
	readonly receivedMonotonic: number
	// Wall instant of the reception, in Unix ms; diagnostics only.
	readonly receivedAt: number
	// Human-readable detail.
	readonly detail?: string
}

// Interruptions of a monotonic window.
export interface GuidingInterruptionQuery {
	// Interruptions received in the window, in reception order.
	readonly interruptions: readonly GuidingInterruption[]
	// Whether an interruption received at or after the start of the window was already evicted from the bounded
	// history: then the absence of interruptions proves nothing, and the window counts as interrupted.
	readonly truncated: boolean
}

// Guiding of an observation session. Every method resolves; none rejects.
export interface GuidingSession {
	// Resources reserved by the observation session and the subset leased by the root `guiding`.
	readonly resources: () => GuidingSessionResources

	// Current state, read synchronously.
	readonly state: () => GuidingSessionState

	// Reports every problem found as a diagnostic.
	readonly preflight: (report: (message: string) => void) => void

	// Delimit one run of an observation session. `beginRun` is synchronous and acquisition only: it installs what makes
	// `pulseQuiescenceBound()` true for every pulse of the run (the closed pulse admission of the local guider) and
	// never commands a device nor waits. It fails 'busy' when another owner holds what it installs, and with any other
	// reason when the configuration refuses it; nothing survives a failure. After a success `endRun` is called exactly
	// once when the run ends, whatever the outcome; it is idempotent.
	readonly beginRun: () => OperationResult<void>
	readonly endRun: () => void

	// Starts or recovers the guiding and resolves only after its settle (SettleDone with status 0) or with the failure.
	// `task` is the scope of the caller: the commands of the start and the wait of the settle run as its children
	// without resources, so cancelling it cancels the wait, never the guiding. `reservation` opens roots under the
	// reservation of the observation session: the root `guiding` is opened there, leases `hold` and lives until `stop`
	// or until the device lifecycle cancels it.
	readonly start: (task: OperationScope, reservation: OperationScope, options: GuidingStartOptions) => Promise<OperationResult<void>>
	// Ends the guiding and the root `guiding`; `scope` is the one of the calling shutdown step.
	readonly stop: (scope: OperationScope) => Promise<OperationResult<void>>

	// Pauses the corrections before the mount moves. Resolves ok only once no new pulse can be emitted and the pulses
	// already sent ended physically, within `pulseQuiescenceBound()`. Accepted in every state after `beginRun`
	// (stopped or lost: then only the emission gate and the physical quiescence). Reentrant: every call waits by
	// itself. A cancelled call resolves with the cancellation reason at once and leaves the gate closed; only `start`
	// and `resume` open it.
	readonly pause: (scope: OperationScope) => Promise<OperationResult<void>>
	// Upper bound, in ms, between asking for a pause and the physical end of every pulse already dispatched; constant
	// during a run. A pause timeout of the caller must be at least this.
	readonly pulseQuiescenceBound: () => number
	// Resumes the corrections and resolves after the settle.
	readonly resume: (scope: OperationScope, settle: GuidingSettle) => Promise<OperationResult<void>>

	// Adapts the calibration after a meridian flip, when the guider supports it.
	readonly flipCalibration?: (scope: OperationScope) => Promise<OperationResult<void>>

	// Interruptions received in [fromMonotonic, toMonotonic] (closed), in the monotonic domain of the clock of the start.
	readonly interruptions: (fromMonotonic: number, toMonotonic: number) => GuidingInterruptionQuery

	// Id of the root `guiding` while it lives, which a drain of the observation session must preserve.
	readonly operationId?: () => string | undefined
}

// Default capacity of the interruption history of an adapter.
export const DEFAULT_GUIDING_INTERRUPTION_CAPACITY = 256

// Time added to the settle timeout of a guider before the local wait gives up, in ms: the guider reports a settle
// timeout by itself, and the margin covers its latency.
export const GUIDING_SETTLE_TIMEOUT_MARGIN = 5000

// Clock of a guiding started without one: `Date.now` and `performance.now`.
export const DEFAULT_GUIDING_CLOCK: CameraCaptureClock = {
	wallNow: () => Date.now(),
	monotonicNow: () => performance.now(),
}

// Bounded history of guiding interruptions: a ring buffer of fixed capacity, evicting the oldest first, that remembers
// the latest reception instant it evicted so a window it no longer covers is reported `truncated`. Reception instants
// are assumed non-decreasing (one monotonic clock). Recording is O(1); a query is O(capacity) and allocates its result.
export class GuidingInterruptionHistory {
	readonly #entries: (GuidingInterruption | undefined)[]
	// Index of the oldest entry.
	#head = 0
	#size = 0
	// Latest reception instant evicted so far, or −∞.
	#evictedThrough = Number.NEGATIVE_INFINITY

	// Creates an empty history of `capacity` interruptions (a safe integer ≥ 1).
	constructor(readonly capacity: number = DEFAULT_GUIDING_INTERRUPTION_CAPACITY) {
		this.#entries = new Array(Math.max(1, capacity)).fill(undefined)
	}

	// Latest reception instant evicted so far, in ms of the monotonic domain; −∞ before the first eviction.
	get evictedThrough() {
		return this.#evictedThrough
	}

	// Number of interruptions kept.
	get size() {
		return this.#size
	}

	// Records one interruption, evicting the oldest when full.
	record(interruption: GuidingInterruption) {
		const capacity = this.#entries.length

		if (this.#size === capacity) {
			const evicted = this.#entries[this.#head]!
			this.#evictedThrough = Math.max(this.#evictedThrough, evicted.receivedMonotonic)
			this.#entries[this.#head] = interruption
			this.#head = (this.#head + 1) % capacity
		} else {
			this.#entries[(this.#head + this.#size) % capacity] = interruption
			this.#size++
		}
	}

	// Interruptions received in [fromMonotonic, toMonotonic], in reception order, and whether the window lost some.
	query(fromMonotonic: number, toMonotonic: number): GuidingInterruptionQuery {
		const interruptions: GuidingInterruption[] = []
		const capacity = this.#entries.length

		for (let i = 0; i < this.#size; i++) {
			const interruption = this.#entries[(this.#head + i) % capacity]!
			const at = interruption.receivedMonotonic
			if (at >= fromMonotonic && at <= toMonotonic) interruptions.push(interruption)
		}

		return { interruptions, truncated: this.#evictedThrough >= fromMonotonic }
	}
}

// Settle event of a guider, as an adapter observes it.
export type GuidingSettleEvent =
	// The lock position moved by a dither, by (dx, dy) guide-camera pixels.
	| { readonly kind: 'dithered'; readonly dx: number; readonly dy: number }
	// A settle began or progresses.
	| { readonly kind: 'settling' }
	// The settle ended; status 0 is success.
	| { readonly kind: 'done'; readonly status: number; readonly error?: string }
	// The guider can no longer report the settle (connection or device lost).
	| { readonly kind: 'lost'; readonly reason: OperationFailureReason; readonly detail?: string }

// Listeners of the settle events of one adapter.
export class GuidingSettleListeners {
	readonly #listeners = new Set<(event: GuidingSettleEvent) => void>()

	// Registers a listener and returns its idempotent removal.
	add(listener: (event: GuidingSettleEvent) => void) {
		this.#listeners.add(listener)
		return () => void this.#listeners.delete(listener)
	}

	// Delivers an event to every listener.
	notify(event: GuidingSettleEvent) {
		for (const listener of this.#listeners) listener(event)
	}
}

// What a settle wait observed: the last lock shift reported after the dispatch.
export interface GuidingSettleObservation {
	// Lock shift of a dither, in guide-camera pixels along the image x and y axes.
	readonly lockShift?: readonly [number, number]
}

// Dispatches a guider command and waits, as the child `kind` of `scope` without resources, for the first settle end
// delivered after the dispatch began: status 0 succeeds, another status fails 'commandFailed', a lost guider fails
// with its reason, `timeout` ms (on `delay`) fail 'timeout' and the cancellation of the child fails with its reason.
// A dispatch that fails ends the wait with its failure; one that throws fails 'commandFailed'. Events delivered while
// the dispatch runs count, so a guider that reports the settle before acknowledging the command is still correlated.
// `onPhase` receives 'dithered', 'settling' and 'settled' as they are observed. Leaves no listener or timer behind.
export async function waitForGuidingSettle(scope: OperationScope, kind: string, listeners: GuidingSettleListeners, timeout: number, delay: AbortableDelay, dispatch: () => OperationResult<void> | Promise<OperationResult<void>>, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<GuidingSettleObservation>> {
	return await scope.start<GuidingSettleObservation>(
		kind,
		[],
		(context) =>
			new Promise((resolve) => {
				const timer = new AbortController()
				let lockShift: readonly [number, number] | undefined
				let settled = false

				const finish = (result: OperationResult<GuidingSettleObservation>) => {
					if (settled) return
					settled = true
					remove()
					timer.abort()
					context.signal.removeEventListener('abort', onAbort)
					resolve(result)
				}

				const remove = listeners.add((event) => {
					switch (event.kind) {
						case 'dithered':
							lockShift = [event.dx, event.dy]
							onPhase?.('dithered')
							return
						case 'settling':
							onPhase?.('settling')
							return
						case 'done':
							if (event.status === 0) {
								onPhase?.('settled')
								finish(successfulOperationResult(lockShift === undefined ? {} : { lockShift }))
							} else {
								finish(failedOperationResult('commandFailed', `settle failed with status ${event.status}${event.error === undefined ? '' : `: ${event.error}`}`))
							}
							return
						case 'lost':
							finish(failedOperationResult(event.reason, event.detail))
					}
				})

				const onAbort = () => finish(failedOperationResult(abortReason(context.signal)))
				context.signal.addEventListener('abort', onAbort, { once: true })

				if (context.signal.aborted) {
					onAbort()
					return
				}

				void delay(timeout, timer.signal).then((elapsed) => {
					if (elapsed.ok) finish(failedOperationResult('timeout', `no settle within ${timeout} ms`))
				})

				try {
					void Promise.resolve(dispatch()).then(
						(dispatched) => {
							if (!dispatched.ok) finish(dispatched)
						},
						(error: unknown) => finish(failedOperationResult('commandFailed', errorMessage(error))),
					)
				} catch (error) {
					finish(failedOperationResult('commandFailed', errorMessage(error)))
				}
			}),
	).result
}

// Settle timeout of a local wait for `settle`, in ms: the guider timeout plus `GUIDING_SETTLE_TIMEOUT_MARGIN`.
export function guidingSettleWaitTimeout(settle: Pick<GuidingSettle, 'timeout'>) {
	return settle.timeout * 1000 + GUIDING_SETTLE_TIMEOUT_MARGIN
}
