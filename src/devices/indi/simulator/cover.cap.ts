import { makeSwitchVector, type NewSwitchVector, selectOnSwitch } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { CoverSimulatorConfig } from './cover.config'

// Cap circuit of the simulated dust cap: the motor that closes (parks) and opens (unparks) it over a
// fixed time, and the abort that stops it halfway. Times are milliseconds on the clock of the bus.

// The motorized cap.
export class CoverCap extends SimulatorComponent {
	readonly #park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	// The position of a cap is physical: a power cycle leaves it where it was, without persisting it.
	readonly properties = [this.#park, this.#abort]
	readonly transient = this.properties

	// Position the cap is moving to, true for closed, while a transition runs.
	#target?: boolean
	// Instant the running transition ends, milliseconds.
	#endsAt = 0

	// `config` gives the transition time and the initial position; `connected` says whether the device
	// accepts commands.
	constructor(
		bus: ComponentBus,
		readonly config: CoverSimulatorConfig,
		readonly connected: () => boolean,
	) {
		super(bus)
		if (config.parked) selectOnSwitch(this.#park, 'PARK')
	}

	// Whether the cap is closed.
	get isParked() {
		return this.#park.elements.PARK.value
	}

	// Whether the cap is opening or closing.
	get isMoving() {
		return this.#target !== undefined
	}

	// Starts closing the cap; ignored while it moves or when it is closed.
	park() {
		this.#start(true)
	}

	// Starts opening the cap; ignored while it moves or when it is open.
	unpark() {
		this.#start(false)
	}

	// Stops a running transition where it is, reporting Alert and a momentary abort when `alert`.
	abort(alert: boolean = true) {
		if (this.#target === undefined) return
		this.#target = undefined
		this.#park.state = alert ? 'Alert' : 'Idle'
		this.bus.notify(this.#park)

		if (alert) {
			this.#abort.elements.ABORT.value = true
			this.bus.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Ends the running transition once its time has passed, at `now`, milliseconds.
	tick(now: number) {
		if (this.#target === undefined || now < this.#endsAt) return
		selectOnSwitch(this.#park, this.#target ? 'PARK' : 'UNPARK')
		this.#target = undefined
		this.#park.state = 'Idle'
		this.bus.notify(this.#park)
	}

	// Stops the motor when the device disconnects.
	reset() {
		this.abort(false)
	}

	// Handles CAP_PARK and CAP_ABORT.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name === this.#park.name) {
			if (vector.elements.PARK === true) this.park()
			else if (vector.elements.UNPARK === true) this.unpark()
			return true
		}

		if (vector.name === this.#abort.name) {
			if (vector.elements.ABORT === true) this.abort()
			return true
		}

		return false
	}

	// Starts a transition towards closed when `parked`, unless the device is off, the cap moves or is
	// already there.
	#start(parked: boolean) {
		if (!this.connected() || this.#target !== undefined || this.isParked === parked) return
		this.#target = parked
		this.#endsAt = this.bus.now() + this.config.moveTime
		this.#park.state = 'Busy'
		this.bus.notify(this.#park)
	}
}
