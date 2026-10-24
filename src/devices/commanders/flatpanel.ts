import { clamp } from '../../math/numerical/math'
import type { FlatPanel } from '../indi/device'
import type { DeviceHandler } from '../indi/manager/device'
import type { FlatPanelManager } from '../indi/manager/flatpanel'
import type { PropertyState } from '../indi/types'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { waitForDeviceState } from '../orchestration/operation.wait'
import { resourceKey } from '../orchestration/resource'

// Coordinated mutations of a flat panel.
// Nothing here moves, but a flat sequence exposing against a commanded brightness needs to know the light is
// really in that state before it exposes, so every command resolves only once the driver reports the light
// switch or the intensity it was asked for. The panel is acquired all the same, because anyone changing the
// brightness underneath would silently invalidate such a sequence. Every duration is in milliseconds.

// Timing overrides for one flat panel command; every duration is in milliseconds.
export interface FlatPanelCommandOptions {
	// Maximum time the driver may take to report the commanded light state or intensity.
	readonly timeout?: number
}

// One observed flat panel transition. The device is passed live rather than snapshotted because evaluation
// always reads the newest values, and the property/state pair is what carries an INDI Alert.
interface FlatPanelUpdate {
	// Device the update came from.
	readonly panel: FlatPanel
	// Field that changed, absent when the update is a poll of the current state.
	readonly property?: keyof FlatPanel & string
	// INDI state published with the change, absent when the update is a poll of the current state.
	readonly state?: PropertyState
}

// Default milliseconds a light switch or intensity change has to be reported. Panels apply both at once, so
// this only leaves room for a slow serial link or a driver that polls its hardware.
const DEFAULT_COMMAND_TIMEOUT = 10000

// Relative tolerance absorbing the float rounding of an intensity echoed through the INDI text protocol.
const INTENSITY_EPSILON = 1e-9

// Owns every mutation of a flat panel and resolves each one only after the driver confirmed it.
// Each command opens its own nested scope holding the panel, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the panel it already owns.
export class FlatPanelCommander implements DeviceHandler<FlatPanel>, Disposable {
	// Waiters per device, fed by the manager callbacks.
	readonly #listeners = new Map<FlatPanel, Set<(update: FlatPanelUpdate) => void>>()

	// Registers the commander as a flat panel observer so confirmations settle on device events instead of polling.
	constructor(readonly flatPanelManager: FlatPanelManager) {
		flatPanelManager.addHandler(this)
	}

	// Stops observing the manager. Call it once the operations that use this commander have settled: a wait
	// still pending, or started later, no longer sees device events and settles only by its timeout or its
	// signal. Running operations and the devices themselves are left untouched. Idempotent.
	dispose() {
		this.flatPanelManager.removeHandler(this)
	}

	// Same as dispose, so the commander can be scoped with `using`.
	[Symbol.dispose]() {
		this.dispose()
	}

	// Required by the manager contract; discovery is published by the panel handler.
	added() {}

	// Feeds every waiter observing the device, which is how a command learns it took effect or hit an Alert.
	updated(panel: FlatPanel, property: keyof FlatPanel & string, state?: PropertyState) {
		this.#emit({ panel, property, state })
	}

	// Wakes every waiter so it reevaluates; removal is reported as a disconnected device by evaluation,
	// and the operation itself is canceled independently by DeviceLifecycle.
	removed(panel: FlatPanel) {
		this.#emit({ panel })
	}

	// Turns the light on and resolves once the driver reports it on.
	async enable(scope: OperationScope, panel: FlatPanel, options: FlatPanelCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#light(scope, 'flatPanelEnable', panel, () => true, options)
	}

	// Turns the light off and resolves once the driver reports it off.
	async disable(scope: OperationScope, panel: FlatPanel, options: FlatPanelCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#light(scope, 'flatPanelDisable', panel, () => false, options)
	}

	// Turns the light on when it is off and off when it is on, as last reported by the driver when the panel
	// is acquired, and resolves once the driver reports the opposite state.
	async toggle(scope: OperationScope, panel: FlatPanel, options: FlatPanelCommandOptions = {}): Promise<OperationResult<void>> {
		return await this.#light(scope, 'flatPanelToggle', panel, () => !panel.enabled, options)
	}

	// Sets the brightness, in the driver's own intensity units, resolved against the limits it published, and
	// resolves once the driver reports it. A driver quantizing to its published step is accepted within half
	// a step of the requested value.
	async intensity(scope: OperationScope, panel: FlatPanel, value: number, options: FlatPanelCommandOptions = {}): Promise<OperationResult<void>> {
		return await scope.start<void>('flatPanelIntensity', [{ key: resourceKey(panel), device: panel }], async (context) => {
			if (!panel.connected) return failedOperationResult('disconnected')

			const target = clamp(value, panel.intensity.min, panel.intensity.max)
			const tolerance = (panel.intensity.step > 0 ? panel.intensity.step / 2 : 0) + INTENSITY_EPSILON * Math.max(1, Math.abs(target))

			const observed = await waitForDeviceState<FlatPanelUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(panel, listener),
				current: () => ({ panel }),
				evaluate: (update) => {
					if (!panel.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'intensity') return 'alert'
					return Math.abs(panel.intensity.value - target) <= tolerance ? 'success' : 'pending'
				},
				command: () => this.flatPanelManager.intensity(panel, target),
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Acquires the panel, commands the light switch to the state `target` resolves once the panel is held,
	// and waits for the driver to report it.
	async #light(scope: OperationScope, kind: string, panel: FlatPanel, target: () => boolean, options: FlatPanelCommandOptions): Promise<OperationResult<void>> {
		return await scope.start<void>(kind, [{ key: resourceKey(panel), device: panel }], async (context) => {
			if (!panel.connected) return failedOperationResult('disconnected')

			const enabled = target()

			const observed = await waitForDeviceState<FlatPanelUpdate>({
				signal: context.signal,
				timeout: options.timeout ?? DEFAULT_COMMAND_TIMEOUT,
				subscribe: (listener) => this.#subscribe(panel, listener),
				current: () => ({ panel }),
				evaluate: (update) => {
					if (!panel.connected) return 'disconnected'
					if (update.state === 'Alert' && update.property === 'enabled') return 'alert'
					return panel.enabled === enabled ? 'success' : 'pending'
				},
				command: () => (enabled ? this.flatPanelManager.enable(panel) : this.flatPanelManager.disable(panel)),
			})

			return observed.ok ? successfulOperationResult(undefined) : observed
		}).result
	}

	// Registers a waiter for one device and returns its idempotent unsubscriber.
	#subscribe(panel: FlatPanel, listener: (update: FlatPanelUpdate) => void) {
		let listeners = this.#listeners.get(panel)

		if (listeners === undefined) {
			listeners = new Set()
			this.#listeners.set(panel, listeners)
		}

		listeners.add(listener)

		return () => {
			const current = this.#listeners.get(panel)

			if (current?.delete(listener) && current.size === 0) this.#listeners.delete(panel)
		}
	}

	// Notifies the waiters of one device.
	#emit(update: FlatPanelUpdate) {
		const listeners = this.#listeners.get(update.panel)
		if (listeners === undefined) return
		for (const listener of listeners) listener(update)
	}
}
