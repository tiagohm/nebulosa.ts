import { clamp } from '../../math/numerical/math'
import type { Power, PowerChannel, PowerChannelType } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { PowerManager } from '../indi/manager/power'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a power distribution box.
// Nothing here moves, but the outputs feed other equipment, so every command resolves only once the driver
// reports the channel in the commanded state: switching an output on (or off), the voltage of a variable
// output in volts, and the duty cycle of a dew output in the driver's own PWM units. Values are clamped to
// the range the driver published for the channel, and every duration is in milliseconds. The box is acquired
// all the same, so two features cannot fight over its outputs. Switching off an output can power down a
// device that another operation holds; that device then disconnects, and DeviceLifecycle cancels the
// operations holding it like on any other disconnect.

// Timing overrides for one power command; every duration is in milliseconds.
export interface PowerCommandOptions {
	// Maximum time the driver may take to report the commanded channel state or value.
	readonly timeout?: number
}

// One observed power transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface PowerUpdate {
	// Device the update came from.
	readonly power: Power
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof Power & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a channel change has to be reported. Boxes switch their outputs at once, so this only
// leaves room for a slow serial link or a driver that polls its hardware.
const DEFAULT_COMMAND_TIMEOUT = 10000

// Relative tolerance absorbing the float rounding of a value echoed through the INDI text protocol.
const VALUE_EPSILON = 1e-9

// Owns every mutation of a power box and resolves each one only after the driver confirmed it.
// Each command opens its own nested scope holding the box, so a direct endpoint runs it as a whole operation
// tree while a composite feature, passing its own context, inherits the box it already owns. Channels are
// matched by type and name against the list the driver currently publishes, so a channel object kept from
// before a redefinition still addresses the same output.
export class PowerCommander implements DeviceHandler<Power>, Disposable {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<Power, Set<(update: PowerUpdate) => void>>()

	// Registers the commander as a power observer so confirmations settle on device events instead of polling.
	constructor(readonly powerManager: PowerManager) {
		powerManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.powerManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by the power handler.
	added() {}

	// Feeds every waiter observing the device, which is how a command learns it took effect or hit an Alert.
	updated(power: Power, property: keyof Power & string, state?: PropertyState) {
		this.#emit({ power, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(power: Power) {
		this.#emit({ power })
	}

	// Switches one output of any type on or off and resolves once the driver reports it in that state. A
	// channel the box does not publish is refused as `unexpectedState`, and an Alert on the channel list of
	// its type fails the command as `alert`.
	async toggle(scope: OperationScope, power: Power, channel: PowerChannel, enabled: boolean, options: PowerCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('powerToggle', [{ key: resourceKey(power), device: power }], async (context) => {
			if (!power.connected) return failedOperationResult('disconnected')

			const live = powerChannel(power, channel)
			if (live === undefined) return missing(power, channel)

			return await this.#wait(
				context.signal,
				power,
				channel,
				(current) => current.enabled === enabled,
				() => this.powerManager.toggle(power, live, enabled),
				options,
			)
		}).result
	}

	// Sets the output voltage of a variable-voltage channel, in volts, clamped to the range the driver
	// published for it, and resolves once the driver reports it within half its step. Any other channel type
	// is refused as `unexpectedState`.
	async voltage(scope: OperationScope, power: Power, channel: PowerChannel, value: number, options: PowerCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#value(scope, 'powerVoltage', power, channel, 'variableVoltage', value, (live, target) => this.powerManager.voltage(power, live, target), options)
	}

	// Sets the duty cycle of a dew channel, in the driver's own PWM units, clamped to the range the driver
	// published for it, and resolves once the driver reports it within half its step. Any other channel type
	// is refused as `unexpectedState`.
	async dutyCycle(scope: OperationScope, power: Power, channel: PowerChannel, value: number, options: PowerCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#value(scope, 'powerDutyCycle', power, channel, 'dew', value, (live, target) => this.powerManager.dutyCycle(power, live, target), options)
	}

	// Acquires the box, checks the channel is of the only type the numeric command applies to, clamps the
	// value to the channel range, and waits for the driver to report it. A driver quantizing to its published
	// step is accepted within half a step of the clamped value.
	async #value(scope: OperationScope, kind: string, power: Power, channel: PowerChannel, type: PowerChannelType, value: number, command: (live: PowerChannel, target: number) => void, options: PowerCommandOptions): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(power), device: power }], async (context) => {
			if (!power.connected) return failedOperationResult('disconnected')
			if (channel.type !== type) return failedOperationResult('unexpectedState', `power ${power.name} channel ${channel.name} is not a ${type} channel`)

			const live = powerChannel(power, channel)
			if (live === undefined) return missing(power, channel)

			const target = clamp(value, live.min, live.max)
			const tolerance = (live.step > 0 ? live.step / 2 : 0) + VALUE_EPSILON * Math.max(1, Math.abs(target))

			return await this.#wait(
				context.signal,
				power,
				channel,
				(current) => Math.abs(current.value - target) <= tolerance,
				() => command(live, target),
				options,
			)
		}).result
	}

	// Commands a channel and waits until `reached` holds for the channel the driver currently publishes. A
	// channel that disappears while waiting is reported as `unexpectedState`.
	async #wait(signal: AbortSignal, power: Power, channel: PowerChannel, reached: (current: PowerChannel) => boolean, command: VoidFunction, options: PowerCommandOptions): Promise<OperationResult<void>> {
		const observed = await waitForDeviceState<PowerUpdate>({
			signal,
			timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
			subscribe: (listener) => this.#subscribe(power, listener),
			current: () => ({ power }),
			evaluate: (update) => {
				if (!power.connected) return 'disconnected'
				if (update.state === 'Alert' && update.property === channel.type) return 'alert'
				const current = powerChannel(power, channel)
				if (current === undefined) return 'unexpectedState'
				return reached(current) ? 'success' : 'pending'
			},
			command,
		})

		return observed.ok ? successfulOperationResult(undefined) : observed
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(power: Power, listener: (update: PowerUpdate) => void) {
		let listeners = this.#listeners.get(power)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(power, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(power)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(power)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: PowerUpdate) {
		const listeners = this.#listeners.get(update.power)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}

// Returns the channel of the same type and name the box currently publishes, or `undefined` when it has none.
function powerChannel(power: Power, channel: PowerChannel) {
	return power[channel.type].find((e) => e.name === channel.name)
}

// Failure for a channel the box does not publish.
function missing(power: Power, channel: PowerChannel) {
	return failedOperationResult('unexpectedState', `power ${power.name} has no ${channel.type} channel ${channel.name}`)
}
