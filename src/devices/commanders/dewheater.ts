import { clamp } from '../../math/numerical/math'
import type { DewHeater } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { DewHeaterManager } from '../indi/manager/dewheater'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a dew heater.
// Nothing here moves: the driver applies the PWM level at once, and the command resolves once the driver
// reports the level it was asked for. It acquires the heater all the same, and a heater provided by a camera
// or a cover is arbitrated under the key of that device, so raising the duty cycle competes with the exposure
// or the cover motion it would otherwise disturb. Every duration is in milliseconds.

// Timing overrides for one dew heater command; every duration is in milliseconds.
export interface DewHeaterCommandOptions {
	// Maximum time the driver may take to report the commanded duty cycle.
	readonly timeout?: number
}

// One observed dew heater transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface DewHeaterUpdate {
	// Device the update came from: the heater proxy or the camera or cover behind it.
	readonly heater: DewHeater
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof DewHeater & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a duty cycle change has to be reported.
const DEFAULT_COMMAND_TIMEOUT = 10000

// Relative tolerance absorbing the float rounding of a level echoed through the INDI text protocol.
const DUTY_CYCLE_EPSILON = 1e-9

// Owns every mutation of a dew heater and resolves each one only after the driver confirmed it.
// The command opens its own nested scope holding the device behind the heater, so a direct endpoint runs it
// as a whole operation tree while a composite feature, passing its own context, inherits what it owns. The
// manager reports a change both for the heater proxy and for the device behind it, so either can be passed.
export class DewHeaterCommander implements DeviceHandler<DewHeater>, Disposable {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<DewHeater, Set<(update: DewHeaterUpdate) => void>>()

	// Registers the commander as a dew heater observer so confirmations settle on device events instead of polling.
	constructor(readonly dewHeaterManager: DewHeaterManager) {
		dewHeaterManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.dewHeaterManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by the dew heater handler.
	added() {}

	// Feeds every waiter observing the device, which is how a command learns it took effect or hit an Alert.
	updated(heater: DewHeater, property: keyof DewHeater & string, state?: PropertyState) {
		this.#emit({ heater, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(heater: DewHeater) {
		this.#emit({ heater })
	}

	// Sets the heating duty cycle, in the driver's own PWM units, resolved against the limits it published, and
	// resolves once the driver reports it. A driver quantizing to its published step is accepted within half
	// a step of the requested value.
	async dutyCycle(scope: OperationScope, heater: DewHeater, value: number, options: DewHeaterCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('dewHeaterDutyCycle', [{ key: resourceKey(heater), device: heater }], async (context) => {
			if (!heater.connected) return failedOperationResult('disconnected')
			if (!heater.hasDewHeater) return failedOperationResult('unexpectedState', `device ${heater.name} has no dew heater`)

			const { dutyCycle } = heater
			const target = clamp(value, dutyCycle.min, dutyCycle.max)
			const tolerance = (dutyCycle.step > 0 ? dutyCycle.step / 2 : 0) + DUTY_CYCLE_EPSILON * Math.max(1, Math.abs(target))

			const observed = await waitForDeviceState<DewHeaterUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(heater, listener),
				current: () => ({ heater }),
				evaluate: (update) => {
					if (!heater.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'dutyCycle') return 'alert'
					return Math.abs(heater.dutyCycle.value - target) <= tolerance ? 'success' : 'pending'
				},
				command: () => this.dewHeaterManager.dutyCycle(heater, target),
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(heater: DewHeater, listener: (update: DewHeaterUpdate) => void) {
		let listeners = this.#listeners.get(heater)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(heater, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(heater)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(heater)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: DewHeaterUpdate) {
		const listeners = this.#listeners.get(update.heater)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}
