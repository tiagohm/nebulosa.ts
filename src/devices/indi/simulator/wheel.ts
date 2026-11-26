import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { WheelCarousel } from './wheel.carousel'
import { type WheelSimulatorConfig, type WheelSimulatorConfigOverride, wheelSimulatorConfig } from './wheel.config'
import { WheelNames } from './wheel.names'

// Simulated filter wheel: a board with the turning carousel and the filter names.

// Options of a simulated filter wheel.
export interface WheelSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_WHEEL_SIMULATOR_CONFIG.
	readonly config?: WheelSimulatorConfigOverride
}

// Simulated filter wheel whose carousel turns between slots the short way round.
export class WheelSimulator extends BoardSimulator {
	readonly type = 'wheel'

	// Configuration the wheel was built with.
	readonly configuration: WheelSimulatorConfig

	readonly #carousel: WheelCarousel
	readonly #names: WheelNames

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: WheelSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.FILTER, 'filterwheel.simulator', options?.now)
		this.configuration = wheelSimulatorConfig(options?.config)
		this.#carousel = new WheelCarousel(this.bus, this.configuration, () => this.isConnected)
		this.#names = new WheelNames(this.bus, this.configuration)
		this.install(this.#carousel, this.#names)
	}

	// Slot in the light path, from 1.
	get slot() {
		return this.#carousel.slot
	}

	// Whether the carousel is turning.
	get isMoving() {
		return this.#carousel.isMoving
	}

	// Name of every slot, in slot order.
	get names() {
		return this.#names.names
	}

	// Starts turning to `slot`.
	moveTo(slot: number) {
		this.#carousel.moveTo(slot)
	}
}
