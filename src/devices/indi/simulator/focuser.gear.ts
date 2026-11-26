import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL, SIMULATION } from './constants'
import type { FocuserDriveConfig, FocuserGearConfig } from './focuser.config'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Gear circuit of the simulated focuser: the play of the gear train between the motor and the drawtube,
// and the driver's compensation of it. Positions and travel are motor steps.
//
// The play is a single gap, the same transmission model as the mount axes in mount.axis.ts without
// stiction. A reversal moves the open slack to the other flank, so it costs the full gap (or the
// complement of a partly closed one) in either direction, and the motor-to-optics offset only swings
// across one interval as wide as the play. Repeated IN/OUT cycles therefore never drift the optics.
//
// The compensation is what a real driver does with FOCUS_BACKLASH_STEPS: on every reversal it turns the
// motor that many steps further without counting them in the position it reports. Set to the play, it
// takes the slack up so the optics land where the position says.

// Direction the gear train is loaded in, zero for a train that has not yet engaged either flank.
export type FocuserGearDirection = -1 | 0 | 1

// The gear train.
export class FocuserGear extends SimulatorComponent {
	readonly #backlash: ReturnType<typeof makeNumberVector>
	readonly #compensation: ReturnType<typeof makeSwitchVector>
	readonly #compensationSteps: ReturnType<typeof makeNumberVector>

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]

	// Position of the optics, steps.
	#effectivePosition: number
	// Flank the train is loaded on, or zero when unloaded, initially and after a sync.
	#loadDirection: FocuserGearDirection = 0
	// Slack still to take up in the load direction before the optics move, steps within [0, backlash].
	#slackRemaining = 0

	// `config` gives the play and the compensation at power-up; `drive` the travel, whose initial
	// position is where the optics start.
	constructor(bus: ComponentBus, config: FocuserGearConfig, drive: FocuserDriveConfig) {
		super(bus)
		this.#backlash = makeNumberVector('', 'SIMULATOR_BACKLASH', 'Backlash', SIMULATION, 'rw', ['BACKLASH', 'Play (steps)', config.backlash, 0, drive.maxPosition, 1, '%.0f'])
		this.#compensation = makeSwitchVector('', 'FOCUS_BACKLASH_TOGGLE', 'Backlash', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', config.compensation], ['INDI_DISABLED', 'Disabled', !config.compensation])
		this.#compensationSteps = makeNumberVector('', 'FOCUS_BACKLASH_STEPS', 'Backlash steps', MAIN_CONTROL, 'rw', ['FOCUS_BACKLASH_VALUE', 'Steps', config.compensationSteps, 0, 10000, 1, '%.0f'])
		this.properties = [this.#backlash, this.#compensation, this.#compensationSteps]
		this.#effectivePosition = drive.position
	}

	// Play of the gear train, steps.
	get backlash() {
		return this.#backlash.elements.BACKLASH.value
	}

	// Position of the optics, steps. Since a sync it differs from the motor position by at most the play
	// while the play is unchanged, so it can lie that far outside the motor's travel at its limits.
	get effectivePosition() {
		return this.#effectivePosition
	}

	// Whether the driver compensates the play on reversals.
	get isCompensating() {
		return this.#compensation.elements.INDI_ENABLED.value
	}

	// Steps the driver compensates every reversal with.
	get compensationSteps() {
		return this.#compensationSteps.elements.FOCUS_BACKLASH_VALUE.value
	}

	// Uncounted steps the driver adds to a move in `direction` (1 outward, -1 inward): the compensation
	// when it is on and the move reverses the loaded flank, zero otherwise.
	compensationFor(direction: Exclude<FocuserGearDirection, 0>) {
		return this.isCompensating && this.#loadDirection !== 0 && this.#loadDirection !== direction ? this.compensationSteps : 0
	}

	// Applies signed motor travel, steps, to the optics through the play. An unloaded train engages at
	// once; a reversal leaves open the complement of the slack still open on the previous flank; the motor
	// then closes that slack before the rest of the travel reaches the optics. Splitting a travel into any
	// number of pieces gives the same result.
	drive(travel: number) {
		if (travel === 0) return

		const direction = Math.sign(travel) as Exclude<FocuserGearDirection, 0>

		if (this.#loadDirection !== direction) {
			this.#slackRemaining = this.#loadDirection === 0 ? 0 : this.backlash - this.#slackRemaining
			this.#loadDirection = direction
		}

		const distance = Math.abs(travel)
		const closed = Math.min(distance, this.#slackRemaining)
		this.#slackRemaining -= closed
		this.#effectivePosition += direction * (distance - closed)
	}

	// Puts the optics at `position`, steps, with the train unloaded, as a sync does.
	sync(position: number) {
		this.#effectivePosition = position
		this.#loadDirection = 0
		this.#slackRemaining = 0
	}

	// Handles SIMULATOR_BACKLASH and FOCUS_BACKLASH_STEPS.
	handleNumber(vector: NewNumberVector) {
		if (vector.name === this.#backlash.name) {
			if (applyNumberVectorValues(this.#backlash, vector.elements)) {
				// The open slack cannot exceed the gap the train now has, or a shrunk play would still be ground through.
				this.#slackRemaining = Math.min(this.#slackRemaining, this.backlash)
				this.bus.notify(this.#backlash)
			}

			return true
		}

		if (vector.name === this.#compensationSteps.name) {
			if (applyNumberVectorValues(this.#compensationSteps, vector.elements)) this.bus.notify(this.#compensationSteps)
			return true
		}

		return false
	}

	// Handles FOCUS_BACKLASH_TOGGLE.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#compensation.name) return false
		if (applyExclusiveSwitchValues(this.#compensation, vector.elements)) this.bus.notify(this.#compensation)
		return true
	}

	// Clamps a persisted slack to the persisted play.
	loaded() {
		this.#slackRemaining = Math.min(this.#slackRemaining, this.backlash)
	}
}
