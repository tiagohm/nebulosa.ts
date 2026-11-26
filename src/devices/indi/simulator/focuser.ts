import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { FocuserCompensation } from './focuser.compensation'
import { type FocuserSimulatorConfig, type FocuserSimulatorConfigOverride, focuserSimulatorConfig } from './focuser.config'
import { FocuserDrive } from './focuser.drive'
import { FocuserGear } from './focuser.gear'
import { FocuserThermometer } from './focuser.thermometer'

// Simulated focuser: a board with the motor, the gear train and its compensation, the temperature probe
// and the temperature compensation. Positions are motor steps and temperatures °C.

// Options of a simulated focuser.
export interface FocuserSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_FOCUSER_SIMULATOR_CONFIG.
	readonly config?: FocuserSimulatorConfigOverride
}

// Simulated focuser with absolute and relative moves at a fixed rate, gear play the driver can
// compensate, a swinging ambient temperature and temperature compensation.
export class FocuserSimulator extends BoardSimulator {
	readonly type = 'focuser'

	// Configuration the focuser was built with.
	readonly configuration: FocuserSimulatorConfig

	readonly #drive: FocuserDrive
	readonly #gear: FocuserGear
	readonly #thermometer: FocuserThermometer
	readonly #compensation: FocuserCompensation

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: FocuserSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.FOCUSER, 'focuser.simulator', options?.now)
		const config = focuserSimulatorConfig(options?.config)
		this.configuration = config
		this.#gear = new FocuserGear(this.bus, config.gear, config.drive)
		this.#drive = new FocuserDrive(this.bus, config.drive, this.#gear, () => this.isConnected)
		this.#thermometer = new FocuserThermometer(this.bus, config.thermometer)
		this.#compensation = new FocuserCompensation(this.bus, config.compensation, this.#thermometer, this.#drive)
		// The temperature is read before it is compensated, and both before the motor turns.
		this.install(this.#thermometer, this.#compensation, this.#drive, this.#gear)
	}

	// Counted position of the motor, steps.
	get position() {
		return this.#drive.position
	}

	// Position of the optics after the gear play, steps.
	get effectivePosition() {
		return this.#gear.effectivePosition
	}

	// Play of the gear train, steps.
	get backlash() {
		return this.#gear.backlash
	}

	// Whether a move is in progress.
	get isMoving() {
		return this.#drive.isMoving
	}

	// Whether temperature compensation is on.
	get isTemperatureCompensationEnabled() {
		return this.#compensation.enabled
	}

	// Temperature of the probe, °C.
	get temperature() {
		return this.#thermometer.temperature
	}

	// Starts a move to `position`, steps.
	moveTo(position: number) {
		this.#drive.moveTo(position)
	}

	// Starts a move of `steps` in the selected direction.
	moveRelative(steps: number) {
		this.#drive.moveRelative(steps)
	}

	// Rewrites the position without moving.
	syncTo(position: number) {
		this.#drive.syncTo(position)
	}

	// Stops the motor, Alert when `alert`.
	stop(alert: boolean = true) {
		this.#drive.abort(alert)
	}
}
