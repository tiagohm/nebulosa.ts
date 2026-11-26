import { makeSwitchVector, type NewSwitchVector } from '../types'
import { SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import { applyExclusiveSwitchValues } from './util'

// Settings circuit of the simulated field rotator: the driver's reverse and backlash switches. Both are
// stored and published only. Reverse inverts the motor of a real controller, not the angle it reports,
// and the simulated rotator has no play for a backlash compensation to take up.

// Stored driver settings.
export class RotatorSettings extends SimulatorComponent {
	readonly #reverse = makeSwitchVector('', 'ROTATOR_REVERSE', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #backlash = makeSwitchVector('', 'ROTATOR_BACKLASH_TOGGLE', 'Backlash', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])

	readonly properties = [this.#reverse, this.#backlash]

	// Whether the motor is reversed.
	get isReversed() {
		return this.#reverse.elements.INDI_ENABLED.value
	}

	// Handles ROTATOR_REVERSE and ROTATOR_BACKLASH_TOGGLE.
	handleSwitch(vector: NewSwitchVector) {
		const property = vector.name === this.#reverse.name ? this.#reverse : vector.name === this.#backlash.name ? this.#backlash : undefined
		if (property === undefined) return false
		if (applyExclusiveSwitchValues(property, vector.elements)) this.bus.notify(property)
		return true
	}
}
