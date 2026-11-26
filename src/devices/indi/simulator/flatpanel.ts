import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { type FlatPanelSimulatorConfig, type FlatPanelSimulatorConfigOverride, flatPanelSimulatorConfig } from './flatpanel.config'
import { FlatPanelLight } from './flatpanel.light'

// Simulated flat-field light panel: a board with the lamp and its dimmer.

// Options of a simulated flat panel.
export interface FlatPanelSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_FLAT_PANEL_SIMULATOR_CONFIG.
	readonly config?: FlatPanelSimulatorConfigOverride
}

// Simulated flat-field light panel with an on/off switch and adjustable brightness.
export class FlatPanelSimulator extends BoardSimulator {
	readonly type = 'flatPanel'

	// Configuration the panel was built with.
	readonly configuration: FlatPanelSimulatorConfig

	readonly #light: FlatPanelLight

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: FlatPanelSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.LIGHTBOX, 'lightbox.simulator', options?.now)
		this.configuration = flatPanelSimulatorConfig(options?.config)
		this.#light = new FlatPanelLight(this.bus, this.configuration)
		this.install(this.#light)
	}

	// Whether the lamp is on.
	get isOn() {
		return this.#light.isOn
	}

	// Brightness setting, in the controller's units.
	get intensity() {
		return this.#light.intensity
	}
}
