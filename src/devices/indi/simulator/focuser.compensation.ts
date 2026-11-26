import { makeSwitchVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { FocuserCompensationConfig } from './focuser.config'
import type { FocuserDrive } from './focuser.drive'
import type { FocuserThermometer } from './focuser.thermometer'
import { applyExclusiveSwitchValues } from './util'

// Temperature-compensation circuit of the simulated focuser: while on, it moves the focuser by a fixed
// number of steps per °C as the probe's temperature drifts, once the drift exceeds a hysteresis, and
// only while the focuser is otherwise still.

// The controller's temperature compensation.
export class FocuserCompensation extends SimulatorComponent {
	readonly #enabled = makeSwitchVector('', 'FOCUS_TEMPERATURE_COMPENSATION', 'Temperature Compensation', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'On', false], ['INDI_DISABLED', 'Off', true])

	readonly properties = [this.#enabled]
	readonly transient = this.properties

	// Temperature the last compensation was made at, °C.
	#reference: number

	// `config` gives the steps per °C and the hysteresis; `thermometer` reads the temperature and
	// `drive` moves the focuser.
	constructor(
		bus: ComponentBus,
		readonly config: FocuserCompensationConfig,
		readonly thermometer: FocuserThermometer,
		readonly drive: FocuserDrive,
	) {
		super(bus)
		this.#reference = thermometer.temperature
	}

	// Whether the compensation is on.
	get enabled() {
		return this.#enabled.elements.INDI_ENABLED.value
	}

	// Moves the focuser for the drift since the last compensation, at `now`, milliseconds. A moving or
	// uncompensated focuser follows the temperature instead, so turning it on or ending a move does not
	// compensate a drift that happened meanwhile.
	tick(now: number) {
		const temperature = this.thermometer.temperature

		if (!this.enabled || this.drive.isMoving) {
			this.#reference = temperature
			return
		}

		const delta = temperature - this.#reference
		if (Math.abs(delta) < this.config.hysteresis) return

		this.#reference = temperature
		const steps = Math.trunc(delta * this.config.stepsPerDegree)
		if (steps !== 0) this.drive.moveTo(this.drive.position + steps)
	}

	// Handles FOCUS_TEMPERATURE_COMPENSATION.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#enabled.name) return false

		if (applyExclusiveSwitchValues(this.#enabled, vector.elements)) {
			this.#reference = this.thermometer.temperature
			this.bus.notify(this.#enabled)
		}

		return true
	}
}
