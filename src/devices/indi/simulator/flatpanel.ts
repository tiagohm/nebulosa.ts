import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { ClientSimulator } from './client'
import { MAIN_CONTROL, PANEL_MAX_INTENSITY } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Simulated flat-field light panel state and intensity.

// Simulated flat-field light panel with an enable switch and adjustable intensity.
export class FlatPanelSimulator extends DeviceSimulator {
	readonly type = 'flatPanel'

	readonly #light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	readonly #intensity = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', 0, 0, PANEL_MAX_INTENSITY, 1, '%.0f'])

	protected readonly properties: readonly SimulatorProperty[] = [this.#light, this.#intensity]
	protected propertiesToNotSave: readonly SimulatorProperty[] = []

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.LIGHTBOX)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'lightbox.simulator'
	}

	// Handles the panel brightness/intensity number command.
	sendNumber(vector: NewNumberVector) {
		if (vector.name === 'FLAT_LIGHT_INTENSITY' && applyNumberVectorValues(this.#intensity, vector.elements)) {
			this.notify(this.#intensity)
		}
	}

	// Handles flat-panel switch commands: connection and light on/off.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'FLAT_LIGHT_CONTROL':
				if (applyExclusiveSwitchValues(this.#light, vector.elements)) this.notify(this.#light)
		}
	}

	// Disposes the flat-panel simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}
}
