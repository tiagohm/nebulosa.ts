import { clamp } from '../../../math/numerical/math'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { RotatorSimulatorConfig } from './rotator.config'
import { advanceRotation, shortestRotatorDelta, wrapRotatorAngle } from './util'

// Drive circuit of the simulated field rotator: the motor that turns the camera to an angle the short
// way round, the sync that rewrites the angle without moving, the home command and the abort. Angles
// are degrees in [0, 360); times are milliseconds on the clock of the bus.

// The rotator motor.
export class RotatorDrive extends SimulatorComponent {
	readonly #angle: ReturnType<typeof makeNumberVector>
	readonly #sync = makeNumberVector('', 'SYNC_ROTATOR_ANGLE', 'Sync', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])
	readonly #home = makeSwitchVector('', 'ROTATOR_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['HOME', 'Home', false])
	readonly #abort = makeSwitchVector('', 'ROTATOR_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]
	// The angle is kept across sessions, as a rotator with an absolute encoder does; the commands are not.
	readonly transient = [this.#sync, this.#home, this.#abort]

	// Signed travel still to turn, degrees, while a move runs.
	#remaining?: number
	// Whether the running move is the home command.
	#homing = false
	// Instant the motion was last advanced to, milliseconds.
	#lastTime = 0

	// `config` gives the rate, the initial angle and the home angle; `connected` says whether the device
	// accepts commands.
	constructor(
		bus: ComponentBus,
		readonly config: RotatorSimulatorConfig,
		readonly connected: () => boolean,
	) {
		super(bus)
		this.#angle = makeNumberVector('', 'ABS_ROTATOR_ANGLE', 'Goto', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', wrapRotatorAngle(config.angle), 0, 360, 0.01, '%.2f'])
		this.properties = [this.#angle, this.#sync, this.#home, this.#abort]
	}

	// Mechanical angle, degrees.
	get angle() {
		return this.#angle.elements.ANGLE.value
	}

	// Whether the rotator is turning.
	get isMoving() {
		return this.#remaining !== undefined
	}

	// Starts turning to `angle`, degrees, the short way round; a move to the current angle stops it.
	moveTo(angle: number) {
		if (!this.connected()) return
		angle = wrapRotatorAngle(clamp(angle, 0, 360))
		if (angle === this.angle) this.abort(false)
		else this.#start(shortestRotatorDelta(angle, this.angle), false)
	}

	// Rewrites the angle to `angle`, degrees, without moving, stopping any move.
	syncTo(angle: number) {
		if (!this.connected()) return
		angle = wrapRotatorAngle(clamp(angle, 0, 360))
		this.abort(false)
		this.#sync.elements.ANGLE.value = angle
		this.#angle.elements.ANGLE.value = angle
		this.bus.notify(this.#sync)
		this.bus.notify(this.#angle)
	}

	// Starts turning to the home angle.
	home() {
		if (!this.connected()) return
		this.#start(shortestRotatorDelta(wrapRotatorAngle(this.config.homeAngle), this.angle), true)
	}

	// Stops the motor where it is, reporting Alert and a momentary abort when it was moving and `alert`.
	abort(alert: boolean = true) {
		const moving = this.isMoving
		this.#remaining = undefined
		this.#homing = false
		this.#publish(alert && moving ? 'Alert' : 'Idle')

		if (alert && moving) {
			this.#abort.elements.ABORT.value = true
			this.bus.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Turns the rotator at its rate up to `now`, milliseconds.
	tick(now: number) {
		const dtSeconds = Math.max(0, (now - this.#lastTime) / 1000)
		this.#lastTime = now
		if (this.#remaining === undefined || dtSeconds <= 0) return

		const [angle, remaining] = advanceRotation(this.angle, this.#remaining, this.config.rate * dtSeconds)
		this.#angle.elements.ANGLE.value = angle

		if (remaining === 0) {
			this.#remaining = undefined
			this.#homing = false
			this.#publish('Idle')
		} else {
			this.#remaining = remaining
			this.bus.notify(this.#angle)
		}
	}

	// Stops the motor when the device disconnects.
	reset() {
		this.abort(false)
	}

	// Handles ABS_ROTATOR_ANGLE and SYNC_ROTATOR_ANGLE.
	handleNumber(vector: NewNumberVector) {
		if (vector.name === this.#angle.name) {
			if (vector.elements.ANGLE !== undefined) this.moveTo(vector.elements.ANGLE)
			return true
		}

		if (vector.name === this.#sync.name) {
			if (vector.elements.ANGLE !== undefined) this.syncTo(vector.elements.ANGLE)
			return true
		}

		return false
	}

	// Handles ROTATOR_HOME and ROTATOR_ABORT_MOTION.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name === this.#home.name) {
			if (vector.elements.HOME === true) this.home()
			return true
		}

		if (vector.name === this.#abort.name) {
			if (vector.elements.ABORT === true) this.abort()
			return true
		}

		return false
	}

	// Starts a move of `travel` degrees, signed, as the home command when `homing`; no travel settles
	// at once.
	#start(travel: number, homing: boolean) {
		this.#remaining = travel === 0 ? undefined : travel
		this.#homing = homing && travel !== 0
		this.#lastTime = this.bus.now()
		this.#publish(travel === 0 ? 'Idle' : 'Busy')
	}

	// Publishes the angle and the home command in `state`; the home command is Busy only while homing.
	#publish(state: PropertyState) {
		const homing = state === 'Busy' && this.#homing
		this.#angle.state = state
		this.#home.state = homing ? 'Busy' : state === 'Alert' ? 'Alert' : 'Idle'
		this.#home.elements.HOME.value = homing
		this.bus.notify(this.#angle)
		this.bus.notify(this.#home)
	}
}
