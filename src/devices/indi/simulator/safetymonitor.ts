import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeLightVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
import { MAIN_CONTROL } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'

// Fail-closed INDI safety-monitor simulation with a passive status light and simulator-only controls.

// Simulates an AUXILIARY INDI Safety Monitor driver. Public status is read-only; the SIMULATOR_SAFETY
// switch selects safe, unsafe, warning, or unknown conditions for tests and interactive sessions.
export class SafetyMonitorSimulator extends DeviceSimulator {
	readonly type = 'safetyMonitor'

	// Standard aggregate INDI safety property; only Ok maps to a safe domain value.
	readonly #safetyStatus = makeLightVector('', 'SAFETY_STATUS', 'Safety', MAIN_CONTROL, ['SAFETY', 'Safety', 'Idle'])
	// Simulator-only condition selector used to drive the passive safety property.
	readonly #simulatorSafety = makeSwitchVector('', 'SIMULATOR_SAFETY', 'Safety Condition', MAIN_CONTROL, 'OneOfMany', 'rw', ['SAFE', 'Safe', false], ['UNSAFE', 'Unsafe', false], ['WARNING', 'Warning', false], ['UNKNOWN', 'Unknown', true])

	// Properties defined while the simulator is connected.
	protected readonly properties: readonly SimulatorProperty[] = [this.#safetyStatus, this.#simulatorSafety]
	// The derived public status is rebuilt from the saved simulator condition.
	protected readonly propertiesToNotSave: readonly SimulatorProperty[] = [this.#safetyStatus]

	// Creates a fail-closed safety simulator and advertises the INDI AUXILIARY interface bit.
	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.AUXILIARY)

		for (const property of this.properties) property.device = name
		this.driverInfo.elements.DRIVER_EXEC.value = 'safetymonitor.simulator'
	}

	// Updates the standard status and emits a LightVector only when the aggregate condition changes.
	#setState(state: PropertyState) {
		const element = this.#safetyStatus.elements.SAFETY
		if (this.#safetyStatus.state === state && element.value === state) return false

		this.#safetyStatus.state = state
		element.value = state
		this.notify(this.#safetyStatus)
		return true
	}

	// Selects the public safe/unsafe state. False represents a definite Alert condition.
	setSafe(safe: boolean) {
		selectOnSwitch(this.#simulatorSafety, safe ? 'SAFE' : 'UNSAFE')
		this.notify(this.#simulatorSafety)
		this.#setState(safe ? 'Ok' : 'Alert')
	}

	// SafetyMonitor has no numeric controls.
	sendNumber(vector: NewNumberVector) {}

	// Handles connection and simulator-only condition changes while preserving base CONFIG behavior.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'SIMULATOR_SAFETY':
				if (vector.elements.SAFE === true) this.setSafe(true)
				else if (vector.elements.UNSAFE === true) this.setSafe(false)
				else if (vector.elements.WARNING === true) {
					selectOnSwitch(this.#simulatorSafety, 'WARNING')
					this.notify(this.#simulatorSafety)
					this.#setState('Busy')
				} else if (vector.elements.UNKNOWN === true) {
					selectOnSwitch(this.#simulatorSafety, 'UNKNOWN')
					this.notify(this.#simulatorSafety)
					this.#setState('Idle')
				}
		}
	}

	// Rebuilds the derived passive status after persisted simulator controls are restored.
	protected onPropertiesLoaded() {
		const elements = this.#simulatorSafety.elements
		this.#setState(elements.SAFE.value ? 'Ok' : elements.UNSAFE.value ? 'Alert' : elements.WARNING.value ? 'Busy' : 'Idle')
	}

	// Disconnects and removes all simulator properties and client registration.
	dispose() {
		this.disconnect()
		super.dispose()
	}
}
