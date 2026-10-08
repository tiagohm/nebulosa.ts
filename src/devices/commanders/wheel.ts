import { clamp } from '../../math/numerical/math'
import type { Wheel } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { WheelManager } from '../indi/manager/wheel'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a filter wheel.
// A wheel has no abort vector, so a move is only ever waited for, never interrupted: the commands here
// turn the driver's slot change into an awaitable operation and leave the physical motion to finish on its
// own. Slots are 0-based, the same convention the device model publishes, and the INDI vector's 1-based
// numbering stays inside the manager. Every duration is in milliseconds.

// Timing overrides for one wheel command; every duration is in milliseconds.
export interface WheelCommandOptions {
	// Maximum time the commanded slot may take to be reached.
	readonly timeout?: number
}

// One observed wheel transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface WheelUpdate {
	// Device the update came from.
	readonly wheel: Wheel
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Wheel & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a commanded slot change has to complete. A filter wheel crosses its whole carousel
// in a few seconds, so this is generous even for the longest move a large wheel can be asked for.
const DEFAULT_MOVE_TIMEOUT = 30000

// Signal for the quarantine of a canceled move. The wait cannot inherit the operation signal, which is
// aborted by the time cleanup runs, and would release the wheel on the very cancel it exists to outlast.
const UNCANCELABLE = new AbortController().signal

// Properties whose Alert state means the commanded move itself failed. An Alert on an unrelated vector,
// such as the filter names, must not fail a move that is otherwise progressing.
const MOTION_PROPERTIES = new Set<string>(['position', 'moving'])

// Owns every mutation of a filter wheel and turns the ones with a physical effect into awaitable
// operations.
// Each command opens its own nested scope holding the wheel, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the wheel it already owns.
export class WheelCommander implements DeviceHandler<Wheel> {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Wheel, Set<(update: WheelUpdate) => void>>()

	// Registers the commander as a wheel observer so waits settle on device events instead of polling.
	constructor(readonly wheelManager: WheelManager) {
		wheelManager.addHandler(this)
	}

	// Required by the manager contract; discovery is published by WheelHandler.
	added() {}

	// Feeds every waiter observing the device, which is how a move learns it arrived or hit an Alert.
	updated(wheel: Wheel, property: keyof Wheel & string, state?: PropertyState) {
		this.#emit({ wheel, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(wheel: Wheel) {
		this.#emit({ wheel })
	}

	// Selects a filter slot and resolves only after the wheel reports standing at it.
	// The slot is 0-based and resolved against the carousel, so a target the driver would never echo
	// cannot leave the wait pending until it times out. Nothing is stopped when the move fails: the wheel
	// exposes no abort, so a canceled move is held instead of interrupted, and the device is only released
	// once it is observed standing at the commanded slot.
	async moveTo(scope: OperationScope, wheel: Wheel, slot: number, options: WheelCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('wheelMoveTo', [{ key: resourceKey(wheel), device: wheel }], async (context) => {
			// Capabilities are only published while the device is connected, so a disconnected wheel would
			// otherwise be reported as one with a single slot.
			if (!wheel.connected) return failedOperationResult('disconnected')

			const target = wheelSlot(wheel, slot)

			// Whether the slot was actually written, so a move canceled before dispatch is not quarantined
			// over a carousel that never received a command.
			let commanded = false

			// The wheel keeps turning through a cancel, and the driver echoes the motion after acknowledging
			// the write: releasing the lease on the state read at that moment would hand a wheel that is about
			// to move to the next operation, which would command a competing slot before DeviceLifecycle ever
			// saw the delayed Busy. Cleanup therefore holds the device until the commanded move is over.
			context.onCleanup(async () => {
				if (!commanded) return

				const settled = await this.#settle(wheel, target)

				// A device that went away is not turning under our command any more, so only one that never
				// reaches the slot is reported as a cleanup failure.
				if (!settled.ok && settled.reason !== 'disconnected') throw new Error(`wheel ${wheel.name} did not finish moving: ${settled.reason}`)
			})

			const observed = await waitForDeviceState<WheelUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_MOVE_TIMEOUT,
				subscribe: (listener) => this.#subscribe(wheel, listener),
				current: () => ({ wheel }),
				evaluate: (update) => {
					if (!wheel.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property !== undefined && MOTION_PROPERTIES.has(update.property)) return 'alert'
					return !wheel.moving && wheel.position === target ? 'success' : 'pending'
				},
				command: () => {
					commanded = true
					this.wheelManager.moveTo(wheel, target)
				},
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Renames the filter slots, which the driver applies without any movement.
	// This acquires the wheel like a move: the names are what every later capture stamps into its frames,
	// and rewriting them under a running sequence would relabel filters it has already used.
	async setNames(scope: OperationScope, wheel: Wheel, names: readonly string[]): Promise<OperationResult<void>> {
		return await scope.start<void>('wheelNames', [{ key: resourceKey(wheel), device: wheel }], () => {
			if (!wheel.connected) return failedOperationResult('disconnected')
			if (!wheel.canSetNames) return failedOperationResult('unexpectedState', `wheel ${wheel.name} cannot rename its slots`)

			this.wheelManager.slots(wheel, names)

			return successfulOperationResult(undefined)
		}).result
	}

	// Waits for the wheel to stand at the slot it was commanded to, on a signal of its own so it still runs
	// while the operation that owns the device is being canceled. The target is the 1-based INDI position.
	// Nothing is commanded here: there is no abort to send, so the wait only outlasts the travel the driver
	// is already performing, bounded by the same allowance a move itself gets.
	async #settle(wheel: Wheel, target: number): Promise<OperationResult<void>> {
		const settled = await waitForDeviceState<WheelUpdate>({
			signal: UNCANCELABLE,
			timeout: DEFAULT_MOVE_TIMEOUT,
			subscribe: (listener) => this.#subscribe(wheel, listener),
			current: () => ({ wheel }),
			// A disconnected device is not turning under our command any more, and nothing further will ever
			// be reported by a device that stopped talking.
			evaluate: () => (!wheel.connected || (!wheel.moving && wheel.position === target) ? 'success' : 'pending'),
			command: () => {},
		})

		return settled.ok ? successfulOperationResult(undefined) : settled
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(wheel: Wheel, listener: (update: WheelUpdate) => void) {
		let listeners = this.#listeners.get(wheel)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(wheel, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(wheel)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(wheel)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: WheelUpdate) {
		const listeners = this.#listeners.get(update.wheel)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}

// Resolves a requested slot to one the wheel can be commanded to and will report back, 0-based. A slot
// outside the carousel is never echoed by the driver, and waiting for it would only end in a timeout.
export function wheelSlot(wheel: Wheel, slot: number) {
	return Math.round(clamp(slot, 0, Math.max(0, wheel.count - 1)))
}
