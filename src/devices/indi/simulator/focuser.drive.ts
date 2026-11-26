import { clamp } from '../../../math/numerical/math'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { FocuserDriveConfig } from './focuser.config'
import type { FocuserGear } from './focuser.gear'
import { applyExclusiveSwitchValues } from './util'

// Drive circuit of the simulated focuser: the motor, its absolute and relative moves, the direction of
// a relative move, the sync and the abort. Positions are motor steps within [0, maxPosition]; times are
// milliseconds on the clock of the bus. The motor's travel goes through the gear to the optics, and the
// uncounted steps of a backlash compensation are turned first, before the position starts counting.
//
// The reverse switch is stored only: on a real controller it inverts the motor so that inward still
// decreases the position, which is what the INDI focuser interface assumes when it bounds a relative
// move against the absolute range, so nothing a client sees changes with it.

// The focuser motor.
export class FocuserDrive extends SimulatorComponent {
	readonly #position: ReturnType<typeof makeNumberVector>
	readonly #relative: ReturnType<typeof makeNumberVector>
	readonly #motion = makeSwitchVector('', 'FOCUS_MOTION', 'Motion', MAIN_CONTROL, 'OneOfMany', 'rw', ['FOCUS_INWARD', 'Inward', false], ['FOCUS_OUTWARD', 'Outward', true])
	readonly #abort = makeSwitchVector('', 'FOCUS_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #reverse = makeSwitchVector('', 'FOCUS_REVERSE_MOTION', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #sync: ReturnType<typeof makeNumberVector>

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]
	// The direction of a relative move and the reverse switch are kept across sessions.
	readonly transient: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]

	// Counted position the running move goes to, steps.
	#target?: number
	// Uncounted compensation steps still to turn before the position counts, non-negative.
	#uncounted = 0
	// Instant the motion was last advanced to, milliseconds.
	#lastTime = 0

	// `config` gives the travel, the initial position and the rate; `gear` receives the motor's travel;
	// `connected` says whether the device accepts commands.
	constructor(
		bus: ComponentBus,
		readonly config: FocuserDriveConfig,
		readonly gear: FocuserGear,
		readonly connected: () => boolean,
	) {
		super(bus)
		this.#position = makeNumberVector('', 'ABS_FOCUS_POSITION', 'Position', MAIN_CONTROL, 'rw', ['FOCUS_ABSOLUTE_POSITION', 'Position', config.position, 0, config.maxPosition, 1, '%.0f'])
		this.#relative = makeNumberVector('', 'REL_FOCUS_POSITION', 'Relative', MAIN_CONTROL, 'rw', ['FOCUS_RELATIVE_POSITION', 'Steps', 0, 0, config.maxPosition, 1, '%.0f'])
		this.#sync = makeNumberVector('', 'FOCUS_SYNC', 'Sync', MAIN_CONTROL, 'rw', ['FOCUS_SYNC_VALUE', 'Position', config.position, 0, config.maxPosition, 1, '%.0f'])
		this.properties = [this.#position, this.#relative, this.#motion, this.#abort, this.#reverse, this.#sync]
		this.transient = [this.#position, this.#relative, this.#abort, this.#sync]
	}

	// Counted position of the motor, steps.
	get position() {
		return this.#position.elements.FOCUS_ABSOLUTE_POSITION.value
	}

	// Whether the motor is turning.
	get isMoving() {
		return this.#target !== undefined
	}

	// Starts a move to `position`, steps, clamped to the travel; a move to the current position stops.
	moveTo(position: number) {
		if (!this.connected()) return
		position = clamp(position, 0, this.config.maxPosition)
		if (position === this.position) this.abort(false)
		else this.#start(position)
	}

	// Starts a move of `steps`, positive, in the selected direction, clamped to the travel.
	moveRelative(steps: number) {
		if (!this.connected() || steps <= 0) return
		const direction = this.#motion.elements.FOCUS_INWARD.value ? -1 : 1
		const target = clamp(this.position + steps * direction, 0, this.config.maxPosition)
		if (target !== this.position) this.#start(target)
	}

	// Rewrites the position to `position`, steps, without moving, with the optics there and the gear
	// unloaded, stopping any move.
	syncTo(position: number) {
		if (!this.connected()) return
		position = clamp(position, 0, this.config.maxPosition)
		this.abort(false)
		this.gear.sync(position)
		this.#sync.elements.FOCUS_SYNC_VALUE.value = position
		this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = position
		this.bus.notify(this.#sync)
		this.bus.notify(this.#position)
	}

	// Stops the motor where it is, reporting Alert and a momentary abort when it was moving and `alert`.
	abort(alert: boolean = true) {
		const moving = this.isMoving
		this.#target = undefined
		this.#uncounted = 0
		this.#relative.elements.FOCUS_RELATIVE_POSITION.value = 0
		this.#publish(alert && moving ? 'Alert' : 'Idle', false)

		if (alert && moving) {
			this.#abort.elements.ABORT.value = true
			this.bus.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Turns the motor at its rate up to `now`, milliseconds: first the uncounted compensation, then the
	// counted travel.
	tick(now: number) {
		const dtSeconds = Math.max(0, (now - this.#lastTime) / 1000)
		this.#lastTime = now
		const target = this.#target
		if (target === undefined || dtSeconds <= 0) return

		const direction = Math.sign(target - this.position)
		let budget = this.config.rate * dtSeconds

		if (this.#uncounted > 0) {
			const used = Math.min(budget, this.#uncounted)
			this.gear.drive(direction * used)
			this.#uncounted -= used
			budget -= used
		}

		const remaining = target - this.position
		const travel = Math.sign(remaining) * Math.min(budget, Math.abs(remaining))
		this.gear.drive(travel)
		this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = Math.abs(remaining) <= budget ? target : this.position + travel

		if (this.position === target && this.#uncounted === 0) {
			this.#target = undefined
			this.#relative.elements.FOCUS_RELATIVE_POSITION.value = 0
			this.#publish('Idle', true)
		} else {
			this.#relative.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(target - this.position)
			this.bus.notify(this.#position)
			this.bus.notify(this.#relative)
		}
	}

	// Stops the motor when the device disconnects.
	reset() {
		this.abort(false)
	}

	// Handles ABS_FOCUS_POSITION, REL_FOCUS_POSITION and FOCUS_SYNC.
	handleNumber(vector: NewNumberVector) {
		const { elements } = vector

		switch (vector.name) {
			case this.#position.name:
				if (elements.FOCUS_ABSOLUTE_POSITION !== undefined) this.moveTo(elements.FOCUS_ABSOLUTE_POSITION)
				return true
			case this.#relative.name:
				if (elements.FOCUS_RELATIVE_POSITION !== undefined) this.moveRelative(elements.FOCUS_RELATIVE_POSITION)
				return true
			case this.#sync.name:
				if (elements.FOCUS_SYNC_VALUE !== undefined) this.syncTo(elements.FOCUS_SYNC_VALUE)
				return true
		}

		return false
	}

	// Handles FOCUS_MOTION, FOCUS_ABORT_MOTION and FOCUS_REVERSE_MOTION.
	handleSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case this.#motion.name:
			case this.#reverse.name: {
				const property = vector.name === this.#motion.name ? this.#motion : this.#reverse
				if (applyExclusiveSwitchValues(property, vector.elements)) this.bus.notify(property)
				return true
			}
			case this.#abort.name:
				if (vector.elements.ABORT === true) this.abort()
				return true
		}

		return false
	}

	// Starts a move to the counted `target`, steps, with the compensation a reversal needs.
	#start(target: number) {
		const direction = target > this.position ? 1 : -1
		this.#target = target
		this.#uncounted = this.gear.compensationFor(direction)
		this.#lastTime = this.bus.now()
		this.#relative.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(target - this.position)
		this.#publish('Busy', false)
	}

	// Publishes both position properties in `state`, always when `force`, otherwise when it changed.
	#publish(state: PropertyState, force: boolean) {
		if (!force && this.#position.state === state && this.#relative.state === state) return
		this.#position.state = state
		this.#relative.state = state
		this.bus.notify(this.#position)
		this.bus.notify(this.#relative)
	}
}
