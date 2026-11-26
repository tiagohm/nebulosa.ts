import { makeTextVector, type NewTextVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import { applyTextVectorValues } from './util'
import type { WheelSimulatorConfig } from './wheel.config'

// Names circuit of the simulated filter wheel: the label of the filter in each slot, kept across
// sessions as a driver keeps its configuration.

// The filter labels.
export class WheelNames extends SimulatorComponent {
	readonly #names: ReturnType<typeof makeTextVector>

	readonly properties: readonly ReturnType<typeof makeTextVector>[]

	// `config` gives one initial name per slot.
	constructor(bus: ComponentBus, config: WheelSimulatorConfig) {
		super(bus)
		this.#names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'rw', ...config.slots.map((name, i): [string, string, string] => [`FILTER_SLOT_NAME_${i + 1}`, `Slot ${i + 1}`, name]))
		this.properties = [this.#names]
	}

	// Name of every slot, in slot order.
	get names() {
		return Object.values(this.#names.elements).map((e) => e.value)
	}

	// Handles FILTER_NAME.
	handleText(vector: NewTextVector) {
		if (vector.name !== this.#names.name) return false
		if (applyTextVectorValues(this.#names, vector.elements)) this.bus.notify(this.#names)
		return true
	}
}
