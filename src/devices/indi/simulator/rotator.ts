import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { type RotatorSimulatorConfig, type RotatorSimulatorConfigOverride, rotatorSimulatorConfig } from './rotator.config'
import { RotatorDrive } from './rotator.drive'
import { RotatorSettings } from './rotator.settings'

// Simulated field rotator: a board with the motor and the stored driver settings. Angles are degrees.

// Options of a simulated rotator.
export interface RotatorSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_ROTATOR_SIMULATOR_CONFIG.
	readonly config?: RotatorSimulatorConfigOverride
}

// Simulated field rotator that turns to an angle at a fixed rate, with sync, home and abort.
export class RotatorSimulator extends BoardSimulator {
	readonly type = 'rotator'

	// Configuration the rotator was built with.
	readonly configuration: RotatorSimulatorConfig

	readonly #drive: RotatorDrive

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: RotatorSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.ROTATOR, 'rotator.simulator', options?.now)
		this.configuration = rotatorSimulatorConfig(options?.config)
		this.#drive = new RotatorDrive(this.bus, this.configuration, () => this.isConnected)
		this.install(this.#drive, new RotatorSettings(this.bus))
	}

	// Mechanical angle, degrees.
	get angle() {
		return this.#drive.angle
	}

	// Whether the rotator is turning.
	get isMoving() {
		return this.#drive.isMoving
	}

	// Starts turning to `angle`, degrees.
	moveTo(angle: number) {
		this.#drive.moveTo(angle)
	}

	// Rewrites the angle without moving.
	syncTo(angle: number) {
		this.#drive.syncTo(angle)
	}

	// Starts turning to the home angle.
	home() {
		this.#drive.home()
	}

	// Stops the motor, Alert when `alert`.
	stop(alert: boolean = true) {
		this.#drive.abort(alert)
	}
}
