import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { CoverCap } from './cover.cap'
import { type CoverSimulatorConfig, type CoverSimulatorConfigOverride, coverSimulatorConfig } from './cover.config'

// Simulated telescope dust cap: a board with the motorized cap.

// Options of a simulated dust cap.
export interface CoverSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_COVER_SIMULATOR_CONFIG.
	readonly config?: CoverSimulatorConfigOverride
}

// Simulated telescope cover that opens (unparks) and closes (parks) over a fixed time, with abort.
export class CoverSimulator extends BoardSimulator {
	readonly type = 'cover'

	// Configuration the cap was built with.
	readonly configuration: CoverSimulatorConfig

	readonly #cap: CoverCap

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: CoverSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.DUSTCAP, 'dustcap.simulator', options?.now)
		this.configuration = coverSimulatorConfig(options?.config)
		this.#cap = new CoverCap(this.bus, this.configuration, () => this.isConnected)
		this.install(this.#cap)
	}

	// Whether the cap is closed.
	get isParked() {
		return this.#cap.isParked
	}

	// Whether the cap is opening or closing.
	get isMoving() {
		return this.#cap.isMoving
	}

	// Starts closing the cap.
	park() {
		this.#cap.park()
	}

	// Starts opening the cap.
	unpark() {
		this.#cap.unpark()
	}

	// Stops a running transition, Alert when `alert`.
	stop(alert: boolean = true) {
		this.#cap.abort(alert)
	}
}
