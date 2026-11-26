import type { NewSwitchVector } from '../types'
import { type ComponentBus, type FlagBinding, makeFlagVector, readFlagVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { MountErrorFeaturesConfig } from './mount.config'
import { applyMultiSwitchValues } from './util'

// Error-feature circuit of the simulated mount: which families of imperfection are simulated. Each
// family is off when its switch says so, not when one of its numbers happens to be zero.

// Families of SIMULATOR_ERROR_FEATURES.
const FEATURES: readonly FlagBinding<keyof MountErrorFeaturesConfig>[] = [
	['ALIGNMENT', 'Alignment', 'alignment'],
	['PERIODIC_ERROR', 'Periodic Error', 'periodicError'],
	['MECHANICS', 'Mechanics', 'mechanics'],
	['GUIDING', 'Guiding', 'guiding'],
	['SETTLING', 'Settling', 'settling'],
	['FLEXURE', 'Flexure', 'flexure'],
	['WIND', 'Wind', 'wind'],
	['TRACKING_RATE', 'Tracking Rate', 'trackingRate'],
]

// Switches of the error families.
export class MountErrorFeatures extends SimulatorComponent {
	readonly #features: ReturnType<typeof makeFlagVector>

	readonly properties: readonly ReturnType<typeof makeFlagVector>[]

	// `config` gives the families switched on initially; `changed` runs after a command switched any,
	// so the device can rebuild what the switches gate.
	constructor(
		bus: ComponentBus,
		config: MountErrorFeaturesConfig,
		readonly changed: () => void,
	) {
		super(bus)
		this.#features = makeFlagVector('SIMULATOR_ERROR_FEATURES', 'Error Features', SIMULATION, FEATURES, config)
		this.properties = [this.#features]
	}

	// Families currently simulated.
	get enabled(): Readonly<MountErrorFeaturesConfig> {
		return readFlagVector(this.#features, FEATURES)
	}

	get alignment() {
		return this.#features.elements.ALIGNMENT.value
	}

	get periodicError() {
		return this.#features.elements.PERIODIC_ERROR.value
	}

	get mechanics() {
		return this.#features.elements.MECHANICS.value
	}

	get guiding() {
		return this.#features.elements.GUIDING.value
	}

	get settling() {
		return this.#features.elements.SETTLING.value
	}

	get flexure() {
		return this.#features.elements.FLEXURE.value
	}

	get wind() {
		return this.#features.elements.WIND.value
	}

	get trackingRate() {
		return this.#features.elements.TRACKING_RATE.value
	}

	// Handles SIMULATOR_ERROR_FEATURES.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#features.name) return false

		if (applyMultiSwitchValues(this.#features, vector.elements)) {
			this.changed()
			this.bus.notify(this.#features)
		}

		return true
	}
}
