import type { DomeDirection } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { DomeDriveConfig } from './dome.config'
import { advanceRotation, applyNumberVectorValues, shortestRotatorDelta, wrapRotatorAngle } from './util'

// Drive circuit of the simulated dome: the motor that turns the dome in azimuth, to an absolute azimuth
// the short way round, by a signed relative angle or continuously, at a speed in RPM, with the sync that
// rewrites the azimuth without moving. Azimuths are degrees north through east in [0, 360); times are
// milliseconds on the clock of the bus.

// Kind of a move of the dome: a goto, a relative move, the home and park commands, or turning until
// stopped.
export type DomeMove = 'slew' | 'relative' | 'home' | 'park' | 'continuous'

// What the drive is wired to on its dome.
export interface DomeDriveWiring {
	// Whether the dome accepts commands.
	readonly connected: () => boolean
	// Runs when a move of `kind` starts, after any previous one stopped.
	readonly started: (kind: DomeMove) => void
	// Runs when a move of `kind` arrived.
	readonly arrived: (kind: DomeMove) => void
	// Runs when a move of `kind` was stopped before arriving, Alert when `alert`.
	readonly stopped: (kind: DomeMove, alert: boolean) => void
	// Runs on DOME_ABORT_MOTION, which stops everything that moves on the dome.
	readonly abort: () => void
}

// Degrees per second of one RPM.
const DEGREES_PER_SECOND_PER_RPM = 6

// The azimuth motor.
export class DomeDrive extends SimulatorComponent {
	readonly #speed: ReturnType<typeof makeNumberVector>
	readonly #motion = makeSwitchVector('', 'DOME_MOTION', 'Motion', MAIN_CONTROL, 'OneOfMany', 'rw', ['DOME_CW', 'Clockwise', false], ['DOME_CCW', 'Counter-clockwise', false])
	readonly #relative = makeNumberVector('', 'REL_DOME_POSITION', 'Relative position', MAIN_CONTROL, 'rw', ['DOME_RELATIVE_POSITION', 'Degrees', 0, -360, 360, 0.1, '%.2f'])
	readonly #absolute: ReturnType<typeof makeNumberVector>
	readonly #sync = makeNumberVector('', 'DOME_SYNC', 'Sync', MAIN_CONTROL, 'rw', ['DOME_SYNC_VALUE', 'Degrees', 0, 0, 360, 0.1, '%.2f'])
	readonly #abort = makeSwitchVector('', 'DOME_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]
	// Only the speed is a setting kept across sessions.
	readonly transient: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]

	// Kind of the running move.
	#move?: DomeMove
	// Azimuth a targeted move arrives at, degrees.
	#target = 0
	// Signed travel still to turn by a targeted move, degrees.
	#remaining = 0
	// Direction of a continuous move.
	#direction?: DomeDirection
	// Instant the motion was last advanced to, milliseconds.
	#lastTime = 0

	// `config` gives the speed range, the speed and the azimuth at power-up.
	constructor(
		bus: ComponentBus,
		config: DomeDriveConfig,
		readonly wiring: DomeDriveWiring,
	) {
		super(bus)
		this.#speed = makeNumberVector('', 'DOME_SPEED', 'Speed', MAIN_CONTROL, 'rw', ['DOME_SPEED_VALUE', 'RPM', config.speed, config.minimumSpeed, config.maximumSpeed, 0.1, '%.2f'])
		this.#absolute = makeNumberVector('', 'ABS_DOME_POSITION', 'Absolute position', MAIN_CONTROL, 'rw', ['DOME_ABSOLUTE_POSITION', 'Degrees', wrapRotatorAngle(config.azimuth), 0, 360, 0.1, '%.2f'])
		this.properties = [this.#speed, this.#motion, this.#relative, this.#absolute, this.#abort, this.#sync]
		this.transient = [this.#motion, this.#relative, this.#absolute, this.#abort, this.#sync]
	}

	// Azimuth, degrees.
	get azimuth() {
		return this.#absolute.elements.DOME_ABSOLUTE_POSITION.value
	}

	// Kind of the running move, or undefined when the dome stands still.
	get move() {
		return this.#move
	}

	// Azimuth the running targeted move arrives at, degrees, or undefined for none.
	get target() {
		return this.#move !== undefined && this.#move !== 'continuous' ? this.#target : undefined
	}

	// Speed, degrees per second.
	get speed() {
		return this.#speed.elements.DOME_SPEED_VALUE.value * DEGREES_PER_SECOND_PER_RPM
	}

	// Starts turning to `azimuth`, degrees, the short way round, as a move of `kind`.
	turnTo(azimuth: number, kind: Exclude<DomeMove, 'relative' | 'continuous'> = 'slew') {
		if (!this.wiring.connected()) return
		azimuth = wrapRotatorAngle(azimuth)
		this.#start(shortestRotatorDelta(azimuth, this.azimuth), azimuth, kind)
	}

	// Starts turning by `delta`, degrees, signed, keeping its direction across north.
	turnBy(delta: number) {
		if (!this.wiring.connected() || delta === 0) return
		this.#start(delta, wrapRotatorAngle(this.azimuth + delta), 'relative')
	}

	// Starts turning towards `direction` until stopped.
	turn(direction: DomeDirection) {
		if (!this.wiring.connected()) return
		this.stop(false)
		this.wiring.started('continuous')
		this.#move = 'continuous'
		this.#direction = direction
		this.#lastTime = this.bus.now()
		this.#absolute.state = 'Busy'
		this.#motion.state = 'Busy'
		this.#motion.elements.DOME_CW.value = direction === 'CLOCKWISE'
		this.#motion.elements.DOME_CCW.value = direction === 'COUNTER_CLOCKWISE'
		this.bus.notify(this.#motion)
		this.bus.notify(this.#absolute)
	}

	// Stops any move where the dome is, Alert when `alert`, returning whether one was running.
	stop(alert: boolean) {
		const move = this.#move
		if (move === undefined) return false

		const state = alert ? 'Alert' : 'Idle'
		this.#move = undefined
		this.#remaining = 0
		this.#direction = undefined
		this.#absolute.state = state
		this.bus.notify(this.#absolute)

		if (this.#relative.state === 'Busy') {
			this.#relative.state = state
			this.bus.notify(this.#relative)
		}

		if (this.#motion.state === 'Busy') {
			this.#motion.state = state
			this.#motion.elements.DOME_CW.value = false
			this.#motion.elements.DOME_CCW.value = false
			this.bus.notify(this.#motion)
		}

		this.wiring.stopped(move, alert)
		return true
	}

	// Rewrites the azimuth to `azimuth`, degrees, without moving, stopping any move.
	syncTo(azimuth: number) {
		if (!this.wiring.connected()) return
		this.stop(false)
		azimuth = wrapRotatorAngle(azimuth)
		this.#sync.elements.DOME_SYNC_VALUE.value = azimuth
		this.#sync.state = 'Ok'
		this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = azimuth
		this.#absolute.state = 'Ok'
		this.bus.notify(this.#sync)
		this.bus.notify(this.#absolute)
	}

	// Publishes the momentary abort, Ok when the stop was an operator's abort (`alert`), Idle otherwise.
	publishAbort(alert: boolean) {
		this.#abort.state = alert ? 'Ok' : 'Idle'
		this.#abort.elements.ABORT.value = true
		this.bus.notify(this.#abort)
		this.#abort.elements.ABORT.value = false
	}

	// Turns the dome at its speed up to `now`, milliseconds.
	tick(now: number) {
		const dtSeconds = Math.max(0, (now - this.#lastTime) / 1000)
		this.#lastTime = now
		if (this.#move === undefined || dtSeconds <= 0) return

		const step = this.speed * dtSeconds

		if (this.#direction !== undefined) {
			this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = wrapRotatorAngle(this.azimuth + (this.#direction === 'CLOCKWISE' ? step : -step))
			this.bus.notify(this.#absolute)
			return
		}

		const [azimuth, remaining] = advanceRotation(this.azimuth, this.#remaining, step)
		this.#remaining = remaining

		if (remaining === 0) {
			this.#finish()
		} else {
			this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = azimuth
			this.bus.notify(this.#absolute)
		}
	}

	// Stops the motor when the device disconnects.
	reset() {
		this.stop(false)
	}

	// Handles DOME_SPEED, REL_DOME_POSITION, ABS_DOME_POSITION and DOME_SYNC.
	handleNumber(vector: NewNumberVector) {
		const { elements } = vector

		switch (vector.name) {
			case this.#speed.name:
				if (applyNumberVectorValues(this.#speed, elements)) this.bus.notify(this.#speed)
				return true
			case this.#relative.name:
				if (elements.DOME_RELATIVE_POSITION !== undefined) this.turnBy(elements.DOME_RELATIVE_POSITION)
				return true
			case this.#absolute.name:
				if (elements.DOME_ABSOLUTE_POSITION !== undefined) this.turnTo(elements.DOME_ABSOLUTE_POSITION)
				return true
			case this.#sync.name:
				if (elements.DOME_SYNC_VALUE !== undefined) this.syncTo(elements.DOME_SYNC_VALUE)
				return true
		}

		return false
	}

	// Handles DOME_MOTION and DOME_ABORT_MOTION.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name === this.#motion.name) {
			if (vector.elements.DOME_CW === true) this.turn('CLOCKWISE')
			else if (vector.elements.DOME_CCW === true) this.turn('COUNTER_CLOCKWISE')
			else this.stop(false)
			return true
		}

		if (vector.name === this.#abort.name) {
			if (vector.elements.ABORT === true) this.wiring.abort()
			return true
		}

		return false
	}

	// Starts a targeted move of `travel` degrees, signed, to `target`, degrees, as a move of `kind`; no
	// travel arrives at once.
	#start(travel: number, target: number, kind: Exclude<DomeMove, 'continuous'>) {
		this.stop(false)
		this.wiring.started(kind)
		this.#move = kind
		this.#target = target
		this.#remaining = travel
		this.#lastTime = this.bus.now()
		this.#absolute.state = 'Busy'
		this.bus.notify(this.#absolute)

		if (kind === 'relative') {
			this.#relative.elements.DOME_RELATIVE_POSITION.value = travel
			this.#relative.state = 'Busy'
			this.bus.notify(this.#relative)
		}

		if (travel === 0) this.#finish()
	}

	// Settles a targeted move exactly at its target and reports the arrival.
	#finish() {
		const move = this.#move
		if (move === undefined) return

		this.#move = undefined
		this.#remaining = 0
		this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = this.#target
		this.#absolute.state = 'Idle'
		this.bus.notify(this.#absolute)

		if (move === 'relative') {
			this.#relative.state = 'Idle'
			this.bus.notify(this.#relative)
		}

		this.wiring.arrived(move)
	}
}
