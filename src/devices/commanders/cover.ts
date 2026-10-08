import type { Cover } from '../indi/device'
import type { CoverManager } from '../indi/manager/cover'
import type { DeviceHandler } from '../indi/manager/device'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationContext, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a dust cover or flip-flat.
// Parking closes the cover and unparking opens it, which is the INDI CAP_PARK convention the device model
// mirrors. Every duration is in milliseconds. Both motions acquire the cover; the emergency stop does not,
// so it still runs while the operation that owns the device is being canceled.

// Timing overrides for one cover command; every duration is in milliseconds.
export interface CoverCommandOptions {
	// Maximum time the commanded motion may take to complete.
	readonly timeout?: number
	// Maximum time a canceled or finished motion has to bring the cover to a standstill.
	readonly settleTimeout?: number
}

// One observed cover transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface CoverUpdate {
	// Device the update came from.
	readonly cover: Cover
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Cover & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a commanded motion has to complete. A motorized cover takes several seconds to
// travel and a servo flip-flat rather less, so this is generous for either.
const DEFAULT_MOVE_TIMEOUT = 60000

// Default milliseconds a motion that ended has to be reported as no longer parking.
const DEFAULT_SETTLE_TIMEOUT = 15000

// Properties whose Alert state means the commanded motion itself failed. An Alert on an unrelated vector,
// such as the dew heater, must not fail a motion that is otherwise progressing.
const MOTION_PROPERTIES = new Set<string>(['parking', 'parked'])

// Signal for physical stops issued while the owning operation is already being canceled. Only the
// emergency stop uses it: cleanup cannot inherit the operation signal, which is aborted by then, and would
// never send the command it exists for. The motion itself waits on the operation signal, so a stop never
// has to outlast a device that keeps reporting motion.
const UNCANCELABLE = new AbortController().signal

// Owns every mutation of a cover and turns the ones with a physical effect into awaitable operations.
// Each command opens its own nested scope holding the cover, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the cover it already owns.
export class CoverCommander implements DeviceHandler<Cover> {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Cover, Set<(update: CoverUpdate) => void>>()

	// Registers the commander as a cover observer so waits settle on device events instead of polling.
	constructor(readonly coverManager: CoverManager) {
		coverManager.addHandler(this)
	}

	// Required by the manager contract; discovery is published by CoverHandler.
	added() {}

	// Feeds every waiter observing the device, which is how a motion learns it finished or hit an Alert.
	updated(cover: Cover, property: keyof Cover & string, state?: PropertyState) {
		this.#emit({ cover, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(cover: Cover) {
		this.#emit({ cover })
	}

	// Closes the cover and resolves only after it reports standing closed.
	async park(scope: OperationScope, cover: Cover, options: CoverCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('coverPark', [{ key: resourceKey(cover), device: cover }], async (context) => {
			const usable = parkable(cover)
			if (usable !== undefined) return usable

			return await this.#move(context, cover, options, () => this.coverManager.park(cover), true)
		}).result
	}

	// Opens the cover and resolves only after it reports standing open.
	async unpark(scope: OperationScope, cover: Cover, options: CoverCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('coverUnpark', [{ key: resourceKey(cover), device: cover }], async (context) => {
			const usable = parkable(cover)
			if (usable !== undefined) return usable

			return await this.#move(context, cover, options, () => this.coverManager.unpark(cover), false)
		}).result
	}

	// Aborts any motion and waits for the cover to report a standstill.
	// This is the emergency stop of the commander: it does not acquire the device, precisely because it is
	// used while the owning operation is being canceled and by cleanup running after the executor returned.
	// A cover left half way is not an error state here: only the motion is undone, not the position.
	async stopMotion(cover: Cover, options: CoverCommandOptions = {}): Promise<OperationResult<void>> {
		if (!cover.connected) return failedOperationResult('disconnected')
		if (!cover.canAbort) return cover.parking ? failedOperationResult('unexpectedState', `cover ${cover.name} cannot abort motion`) : successfulOperationResult(undefined)

		return await this.#settle(cover, options, () => this.coverManager.stop(cover))
	}

	// Commands a motion and waits for the cover to stand still at the requested end, aborting it from the
	// scope's own cleanup so a canceled operation never releases a cover that is still travelling.
	async #move(context: OperationContext, cover: Cover, options: CoverCommandOptions, command: VoidFunction, parked: boolean): Promise<OperationResult<void>> {
		// Registered before the command so a cancel arriving during dispatch still finds the stop it needs.
		context.onCleanup(async () => {
			const stopped = await this.stopMotion(cover, options)

			// A device that went away is not travelling under our command any more, so only one that stays in
			// motion is reported as a cleanup failure.
			if (!stopped.ok && stopped.reason !== 'disconnected') throw new Error(`cover ${cover.name} did not stop moving: ${stopped.reason}`)
		})

		const observed = await waitForDeviceState<CoverUpdate>({
			signal: context.signal,
			timeout: options.timeout ?? DEFAULT_MOVE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(cover, listener),
			current: () => ({ cover }),
			evaluate: (update) => {
				if (!cover.connected) return 'disconnected'
				if (update.state === 'Alert' && update.property !== undefined && MOTION_PROPERTIES.has(update.property)) return 'alert'
				return !cover.parking && cover.parked === parked ? 'success' : 'pending'
			},
			command,
		})

		return observed.ok ? successfulOperationResult(undefined) : observed
	}

	// Waits for the cover to report no motion, on a signal of its own so it still runs while the operation
	// that owns the device is being canceled.
	async #settle(cover: Cover, options: CoverCommandOptions, command: VoidFunction): Promise<OperationResult<void>> {
		const settled = await waitForDeviceState<CoverUpdate>({
			signal: UNCANCELABLE,
			timeout: options.settleTimeout ?? DEFAULT_SETTLE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(cover, listener),
			current: () => ({ cover }),
			// A disconnected device is not travelling under our command any more, and nothing further will
			// ever be reported by a device that stopped talking.
			evaluate: () => (!cover.connected || !cover.parking ? 'success' : 'pending'),
			command,
		})

		return settled.ok ? successfulOperationResult(undefined) : settled
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(cover: Cover, listener: (update: CoverUpdate) => void) {
		let listeners = this.#listeners.get(cover)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(cover, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(cover)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(cover)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: CoverUpdate) {
		const listeners = this.#listeners.get(update.cover)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}

// Reports why a cover cannot be commanded to open or close, or `undefined` when it can. Capabilities are
// only published while the device is connected, so a disconnected cover would otherwise be reported as one
// that has no park control at all.
function parkable(cover: Cover): OperationResult<void> | undefined {
	if (!cover.connected) return failedOperationResult('disconnected')
	if (!cover.canPark) return failedOperationResult('unexpectedState', `cover ${cover.name} cannot park`)
	return undefined
}
