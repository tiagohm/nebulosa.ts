import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { FlatPanelSimulatorConfig } from './flatpanel.config'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Light circuit of the simulated flat panel: the lamp switch and its dimmer, in the controller's own
// brightness units.

// The lamp and its dimmer.
export class FlatPanelLight extends SimulatorComponent {
	readonly #light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	readonly #intensity: ReturnType<typeof makeNumberVector>

	readonly properties: readonly (ReturnType<typeof makeSwitchVector> | ReturnType<typeof makeNumberVector>)[]
	// The dimmer setting is kept across sessions; the lamp is not, since a power cycle turns it off.
	readonly transient = [this.#light]

	// `config` gives the brightness range and the initial brightness.
	constructor(bus: ComponentBus, config: FlatPanelSimulatorConfig) {
		super(bus)
		this.#intensity = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', config.intensity, 0, config.maxIntensity, 1, '%.0f'])
		this.properties = [this.#light, this.#intensity]
	}

	// Whether the lamp is on.
	get isOn() {
		return this.#light.elements.FLAT_LIGHT_ON.value
	}

	// Brightness setting, in the controller's units.
	get intensity() {
		return this.#intensity.elements.FLAT_LIGHT_INTENSITY_VALUE.value
	}

	// Turns the lamp off when the device disconnects.
	reset() {
		applyExclusiveSwitchValues(this.#light, { FLAT_LIGHT_OFF: true })
	}

	// Handles FLAT_LIGHT_INTENSITY.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#intensity.name) return false
		if (applyNumberVectorValues(this.#intensity, vector.elements)) this.bus.notify(this.#intensity)
		return true
	}

	// Handles FLAT_LIGHT_CONTROL.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#light.name) return false
		if (applyExclusiveSwitchValues(this.#light, vector.elements)) this.bus.notify(this.#light)
		return true
	}
}
