import { makeSwitchVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { DomeShutterConfig } from './dome.config'

// Shutter circuit of the simulated dome: the motor that opens and closes the slit over a fixed time.
// Times are milliseconds on the clock of the bus.

// Position a shutter transition goes to.
type DomeShutterTarget = 'OPEN' | 'CLOSED'

// The shutter motor.
export class DomeShutter extends SimulatorComponent {
	readonly #shutter = makeSwitchVector('', 'DOME_SHUTTER', 'Shutter', MAIN_CONTROL, 'OneOfMany', 'rw', ['SHUTTER_OPEN', 'Open', false], ['SHUTTER_CLOSE', 'Close', true])

	readonly properties = [this.#shutter]
	readonly transient = this.properties

	// Position the running transition goes to.
	#target?: DomeShutterTarget
	// Instant the running transition ends, milliseconds.
	#endsAt = 0

	// `config` gives the transition time; `connected` says whether the dome accepts commands.
	constructor(
		bus: ComponentBus,
		readonly config: DomeShutterConfig,
		readonly connected: () => boolean,
	) {
		super(bus)
	}

	// Position the running transition goes to, or undefined while the shutter stands still.
	get target() {
		return this.#target
	}

	// Whether the shutter stands open.
	get isOpen() {
		return this.#target === undefined && this.#shutter.elements.SHUTTER_OPEN.value
	}

	// Starts opening the shutter.
	open() {
		this.#start('OPEN')
	}

	// Starts closing the shutter.
	close() {
		this.#start('CLOSED')
	}

	// Stops a running transition where it is, Alert when `alert`, returning whether one was running.
	stop(alert: boolean) {
		if (this.#target === undefined && this.#shutter.state !== 'Busy') return false
		this.#target = undefined
		this.#shutter.state = alert ? 'Alert' : 'Idle'
		this.bus.notify(this.#shutter)
		return true
	}

	// Ends the running transition once its time has passed, at `now`, milliseconds.
	tick(now: number) {
		const target = this.#target
		if (target === undefined || now < this.#endsAt) return
		this.#target = undefined
		this.#shutter.elements.SHUTTER_OPEN.value = target === 'OPEN'
		this.#shutter.elements.SHUTTER_CLOSE.value = target === 'CLOSED'
		this.#shutter.state = 'Ok'
		this.bus.notify(this.#shutter)
	}

	// Stops the motor when the device disconnects.
	reset() {
		this.stop(false)
	}

	// Handles DOME_SHUTTER.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#shutter.name) return false
		if (vector.elements.SHUTTER_OPEN === true) this.open()
		else if (vector.elements.SHUTTER_CLOSE === true) this.close()
		return true
	}

	// Starts a transition to `target`; a shutter already standing there answers Ok without moving.
	#start(target: DomeShutterTarget) {
		if (!this.connected()) return

		const there = target === 'OPEN' ? this.#shutter.elements.SHUTTER_OPEN.value : this.#shutter.elements.SHUTTER_CLOSE.value

		if (this.#target === undefined && this.#shutter.state === 'Ok' && there) {
			this.bus.notify(this.#shutter)
			return
		}

		this.#target = target
		this.#endsAt = this.bus.now() + this.config.moveTime
		this.#shutter.elements.SHUTTER_OPEN.value = target === 'OPEN'
		this.#shutter.elements.SHUTTER_CLOSE.value = target === 'CLOSED'
		this.#shutter.state = 'Busy'
		this.bus.notify(this.#shutter)
	}
}
