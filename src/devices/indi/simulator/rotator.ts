import { clamp } from '../../../math/numerical/math'
import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { ClientSimulator } from './client'
import { MAIN_CONTROL, ROTATOR_MOVE_RATE, TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyExclusiveSwitchValues, shortestRotatorDelta, wrapRotatorAngle } from './util'

// Simulated field rotator movement, reversal, synchronization, and homing.

// Simulated field rotator; slews to a target angle at a fixed rate, with reverse, sync, and home.
export class RotatorSimulator extends DeviceSimulator {
	readonly type = 'rotator'

	readonly #angle = makeNumberVector('', 'ABS_ROTATOR_ANGLE', 'Goto', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])
	readonly #sync = makeNumberVector('', 'SYNC_ROTATOR_ANGLE', 'Sync', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])
	readonly #home = makeSwitchVector('', 'ROTATOR_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['HOME', 'Home', false])
	readonly #abort = makeSwitchVector('', 'ROTATOR_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #reverse = makeSwitchVector('', 'ROTATOR_REVERSE', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #backlash = makeSwitchVector('', 'ROTATOR_BACKLASH_TOGGLE', 'Backlash', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])

	protected readonly properties: readonly SimulatorProperty[] = [this.#angle, this.#sync, this.#home, this.#abort, this.#reverse, this.#backlash]
	protected propertiesToNotSave: readonly SimulatorProperty[] = [this.#sync, this.#home, this.#abort]

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#targetAngle?: number
	#homing = false

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.ROTATOR)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'rotator.simulator'
	}

	// Current mechanical angle (degrees).
	get angle() {
		return this.#angle.elements.ANGLE.value
	}

	// Whether a rotation is in progress.
	get isMoving() {
		return this.#angle.state === 'Busy'
	}

	// Handles rotator number commands: goto and sync to an angle (degrees).
	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (vector.elements.ANGLE !== undefined) this.moveTo(vector.elements.ANGLE)
				return
			case 'SYNC_ROTATOR_ANGLE':
				if (vector.elements.ANGLE !== undefined) this.syncTo(vector.elements.ANGLE)
		}
	}

	// Handles rotator switch commands: connection, home, abort, reverse, and backlash toggle.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'ROTATOR_HOME':
				if (vector.elements.HOME === true) this.home()
				return
			case 'ROTATOR_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'ROTATOR_REVERSE':
				if (applyExclusiveSwitchValues(this.#reverse, vector.elements)) this.notify(this.#reverse)
				return
			case 'ROTATOR_BACKLASH_TOGGLE':
				if (applyExclusiveSwitchValues(this.#backlash, vector.elements)) this.notify(this.#backlash)
		}
	}

	// Connects the simulated rotator and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated rotator and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.stop(false)

		super.disconnect()
	}

	// Disposes the rotator simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts a rotation to the requested angle.
	moveTo(angle: number) {
		if (!this.isConnected) return

		angle = clamp(angle, this.#angle.elements.ANGLE.min, this.#angle.elements.ANGLE.max)
		if (angle === this.angle) return

		this.#targetAngle = angle
		this.#homing = false
		this.#setMoving(true)
	}

	// Syncs the rotator immediately without moving.
	syncTo(angle: number) {
		if (!this.isConnected) return

		angle = clamp(angle, this.#angle.elements.ANGLE.min, this.#angle.elements.ANGLE.max)
		this.#sync.elements.ANGLE.value = angle
		this.#angle.elements.ANGLE.value = angle
		this.stop(false)
		this.notify(this.#sync)
		this.notify(this.#angle)
	}

	// Sends the rotator to the configured home angle.
	home() {
		if (!this.isConnected) return
		this.#targetAngle = 0
		this.#homing = true
		this.#setMoving(true)
	}

	// Aborts the active rotation.
	stop(alert: boolean = true) {
		const wasMoving = this.isMoving
		this.#targetAngle = undefined
		this.#homing = false
		this.#setMoving(false, alert)

		if (alert && wasMoving) {
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Advances the rotator toward the requested angle.
	#tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0 || this.#targetAngle === undefined) return

		const current = this.angle
		const delta = shortestRotatorDelta(this.#targetAngle, current)
		const step = ROTATOR_MOVE_RATE * dtSeconds

		if (Math.abs(delta) <= step) {
			this.#angle.elements.ANGLE.value = this.#targetAngle
			this.notify(this.#angle)
			this.#targetAngle = undefined
			this.#homing = false
			this.#setMoving(false)
			return
		}

		this.#angle.elements.ANGLE.value = wrapRotatorAngle(current + Math.sign(delta) * step)
		this.notify(this.#angle)
	}

	// Updates the busy state reflected by the rotator angle and home properties.
	#setMoving(moving: boolean, alert: boolean = false) {
		const angleState = alert ? 'Alert' : moving ? 'Busy' : 'Idle'
		let updated = false

		if (this.#angle.state !== angleState) {
			this.#angle.state = angleState
			updated = true
		}

		const homeState = alert ? 'Alert' : this.#homing && moving ? 'Busy' : 'Idle'
		if (this.#home.state !== homeState) {
			this.#home.state = homeState
			this.#home.elements.HOME.value = this.#homing && moving
			updated = true
		} else if (this.#home.elements.HOME.value !== (this.#homing && moving)) {
			this.#home.elements.HOME.value = this.#homing && moving
			updated = true
		}

		if (updated) {
			this.notify(this.#angle)
			this.notify(this.#home)
		}
	}
}
