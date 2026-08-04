import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType, type DomeDirection } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState } from '../types'
import type { ClientSimulator } from './client'
import { DOME_DEFAULT_HOME_AZIMUTH, DOME_DEFAULT_PARK_AZIMUTH, DOME_DEFAULT_SPEED_RPM, DOME_MAX_SPEED_RPM, DOME_MIN_SPEED_RPM, DOME_SHUTTER_MOVE_TIME_MS, MAIN_CONTROL, TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyExclusiveSwitchValues, applyNumberVectorValues, shortestRotatorDelta, wrapRotatorAngle } from './util'

// Simulated INDI dome with asynchronous azimuth, home/park, shutter, slaving, and persistence behavior.
// Angles are exposed in INDI degrees; DomeManager converts them to the shared radian model.

type DomeOperation = 'slew' | 'relative' | 'home' | 'park'
type DomeShutterTarget = 'OPEN' | 'CLOSED'

// Simulates a dome controller whose movement and shutter transitions are observable through INDI vectors.
export class DomeSimulator extends DeviceSimulator {
	readonly type = 'dome'

	readonly #speed = makeNumberVector('', 'DOME_SPEED', 'Speed', MAIN_CONTROL, 'rw', ['DOME_SPEED_VALUE', 'RPM', DOME_DEFAULT_SPEED_RPM, DOME_MIN_SPEED_RPM, DOME_MAX_SPEED_RPM, 0.1, '%.2f'])
	readonly #motion = makeSwitchVector('', 'DOME_MOTION', 'Motion', MAIN_CONTROL, 'OneOfMany', 'rw', ['DOME_CW', 'Clockwise', false], ['DOME_CCW', 'Counter-clockwise', false])
	readonly #relative = makeNumberVector('', 'REL_DOME_POSITION', 'Relative position', MAIN_CONTROL, 'rw', ['DOME_RELATIVE_POSITION', 'Degrees', 0, -360, 360, 0.1, '%.2f'])
	readonly #absolute = makeNumberVector('', 'ABS_DOME_POSITION', 'Absolute position', MAIN_CONTROL, 'rw', ['DOME_ABSOLUTE_POSITION', 'Degrees', 0, 0, 360, 0.1, '%.2f'])
	readonly #abort = makeSwitchVector('', 'DOME_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #shutter = makeSwitchVector('', 'DOME_SHUTTER', 'Shutter', MAIN_CONTROL, 'OneOfMany', 'rw', ['SHUTTER_OPEN', 'Open', false], ['SHUTTER_CLOSE', 'Close', true])
	readonly #goto = makeSwitchVector('', 'DOME_GOTO', 'Home/Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['DOME_HOME', 'Home', false], ['DOME_PARK', 'Park', false])
	// oxfmt-ignore
	readonly #params = makeNumberVector('', 'DOME_PARAMS', 'Parameters',MAIN_CONTROL, 'rw', ['HOME_POSITION', 'Home position', DOME_DEFAULT_HOME_AZIMUTH, 0, 360, 0.1, '%.2f'], ['PARK_POSITION', 'Park position', DOME_DEFAULT_PARK_AZIMUTH, 0, 360, 0.1, '%.2f'], ['AUTO_SYNC_THRESHOLD', 'Auto-sync threshold', 1, 0, 360, 0.1, '%.2f'])
	readonly #autoSync = makeSwitchVector('', 'DOME_AUTO_SYNC', 'Auto-sync', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #sync = makeNumberVector('', 'DOME_SYNC', 'Sync', MAIN_CONTROL, 'rw', ['DOME_SYNC_VALUE', 'Degrees', 0, 0, 360, 0.1, '%.2f'])
	readonly #park = makeSwitchVector('', 'DOME_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #parkPosition = makeNumberVector('', 'DOME_PARK_POSITION', 'Park position', MAIN_CONTROL, 'rw', ['PARK_AZ', 'Degrees', DOME_DEFAULT_PARK_AZIMUTH, 0, 360, 0.1, '%.2f'])
	readonly #parkOption = makeSwitchVector('', 'DOME_PARK_OPTION', 'Park option', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK_CURRENT', 'Park current position', false])
	readonly #backlashToggle = makeSwitchVector('', 'DOME_BACKLASH_TOGGLE', 'Backlash', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #backlashSteps = makeNumberVector('', 'DOME_BACKLASH_STEPS', 'Backlash steps', MAIN_CONTROL, 'rw', ['DOME_BACKLASH_VALUE', 'Steps', 0, 0, 1000, 1, '%.0f'])
	// oxfmt-ignore
	readonly #measurements = makeNumberVector('', 'DOME_MEASUREMENTS', 'Measurements', MAIN_CONTROL, 'ro', ['DOME_RADIUS', 'Radius', 3, 0, 100, 0.01, '%.2f'], ['DOME_SHUTTER_WIDTH', 'Shutter width', 1, 0, 100, 0.01, '%.2f'],		['DOME_NORTH_DISPLACEMENT', 'North displacement', 0, -100, 100, 0.01, '%.2f'],		['DOME_EAST_DISPLACEMENT', 'East displacement', 0, -100, 100, 0.01, '%.2f'],		['DOME_UP_DISPLACEMENT', 'Up displacement', 0, -100, 100, 0.01, '%.2f'],		['DOME_OTA_OFFSET', 'OTA offset', 0, -100, 100, 0.01, '%.2f']	)
	readonly #otaSide = makeSwitchVector('', 'DM_OTA_SIDE', 'OTA side', MAIN_CONTROL, 'OneOfMany', 'rw', ['DM_OTA_EAST', 'East', false], ['DM_OTA_WEST', 'West', false])

	protected readonly properties: readonly SimulatorProperty[] = [
		this.#speed,
		this.#motion,
		this.#relative,
		this.#absolute,
		this.#abort,
		this.#shutter,
		this.#goto,
		this.#params,
		this.#autoSync,
		this.#sync,
		this.#park,
		this.#parkPosition,
		this.#parkOption,
		this.#backlashToggle,
		this.#backlashSteps,
		this.#measurements,
		this.#otaSide,
	]

	protected propertiesToNotSave: readonly SimulatorProperty[] = [this.#motion, this.#relative, this.#absolute, this.#abort, this.#shutter, this.#goto, this.#sync, this.#park, this.#parkOption]

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#targetAzimuth?: number
	#operation?: DomeOperation
	#relativeRemaining = 0
	#continuousDirection?: DomeDirection
	#shutterTarget?: DomeShutterTarget
	#shutterStartedAt = 0

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.DOME)

		for (const property of this.properties) property.device = name

		this.driverInfo.elements.DRIVER_EXEC.value = 'dome.simulator'
	}

	// Current dome azimuth in degrees, normalized to [0, 360).
	get azimuth() {
		return this.#absolute.elements.DOME_ABSOLUTE_POSITION.value
	}

	// Current shutter target, if an asynchronous transition is active.
	get shutterTarget() {
		return this.#shutterTarget
	}

	// Whether azimuth or shutter motion is active.
	get isMoving() {
		return this.#absolute.state === 'Busy' || this.#shutter.state === 'Busy'
	}

	// Handles number commands for position, speed, sync, parameters, backlash, and measurements.
	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'DOME_SPEED':
				if (applyNumberVectorValues(this.#speed, vector.elements)) this.notify(this.#speed)
				return
			case 'REL_DOME_POSITION':
				if (vector.elements.DOME_RELATIVE_POSITION !== undefined) this.moveBy(vector.elements.DOME_RELATIVE_POSITION)
				return
			case 'ABS_DOME_POSITION':
				if (vector.elements.DOME_ABSOLUTE_POSITION !== undefined) this.moveTo(vector.elements.DOME_ABSOLUTE_POSITION)
				return
			case 'DOME_SYNC':
				if (vector.elements.DOME_SYNC_VALUE !== undefined) this.syncTo(vector.elements.DOME_SYNC_VALUE)
				return
			case 'DOME_PARAMS':
				if (applyNumberVectorValues(this.#params, vector.elements)) {
					this.#parkPosition.elements.PARK_AZ.value = this.#params.elements.PARK_POSITION.value
					this.notify(this.#params)
					this.notify(this.#parkPosition)
				}
				return
			case 'DOME_PARK_POSITION':
				if (applyNumberVectorValues(this.#parkPosition, vector.elements)) {
					this.#params.elements.PARK_POSITION.value = this.#parkPosition.elements.PARK_AZ.value
					this.notify(this.#parkPosition)
					this.notify(this.#params)
				}
				return
			case 'DOME_BACKLASH_STEPS':
				if (applyNumberVectorValues(this.#backlashSteps, vector.elements)) this.notify(this.#backlashSteps)
				return
			case 'DOME_MEASUREMENTS':
				if (applyNumberVectorValues(this.#measurements, vector.elements)) this.notify(this.#measurements)
		}
	}

	// Handles connection, motion, shutter, home/park, slaving, park-option, backlash, and OTA commands.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'DOME_MOTION':
				if (vector.elements.DOME_CW === true) this.startContinuous('CLOCKWISE')
				else if (vector.elements.DOME_CCW === true) this.startContinuous('COUNTER_CLOCKWISE')
				else this.stopMotion(false)
				return
			case 'DOME_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'DOME_SHUTTER':
				if (vector.elements.SHUTTER_OPEN === true) this.openShutter()
				else if (vector.elements.SHUTTER_CLOSE === true) this.closeShutter()
				return
			case 'DOME_GOTO':
				if (vector.elements.DOME_HOME === true) this.home()
				else if (vector.elements.DOME_PARK === true) this.park()
				return
			case 'DOME_PARK':
				if (vector.elements.PARK === true) this.park()
				else if (vector.elements.UNPARK === true) this.unpark()
				return
			case 'DOME_AUTO_SYNC':
				if (applyExclusiveSwitchValues(this.#autoSync, vector.elements)) this.notify(this.#autoSync)
				return
			case 'DOME_PARK_OPTION':
				if (vector.elements.PARK_CURRENT === true) this.setPark()
				return
			case 'DOME_BACKLASH_TOGGLE':
				if (applyExclusiveSwitchValues(this.#backlashToggle, vector.elements)) this.notify(this.#backlashToggle)
				return
			case 'DM_OTA_SIDE':
				if (applyExclusiveSwitchValues(this.#otaSide, vector.elements)) this.notify(this.#otaSide)
		}
	}

	// Connects the simulator and starts its periodic motion/shutter clock.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.#timer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
	}

	// Disconnects the simulator after cancelling transient operations and deleting its properties.
	disconnect() {
		if (!this.isConnected) return

		if (this.#timer) clearInterval(this.#timer)
		this.#timer = undefined
		this.stop(false)
		super.disconnect()
	}

	// Disposes the dome simulator and unregisters it from the in-process client.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts the shortest-path absolute slew to an azimuth in degrees.
	moveTo(azimuth: number) {
		if (!this.isConnected) return
		this.startTarget(wrapRotatorAngle(azimuth), 'slew')
	}

	// Starts a signed relative slew in degrees, preserving the requested direction across zero.
	moveBy(delta: number) {
		if (!this.isConnected || delta === 0) return

		this.startTarget(wrapRotatorAngle(this.azimuth + delta), 'relative', delta)
	}

	// Immediately synchronizes the reported azimuth without starting a movement.
	syncTo(azimuth: number) {
		if (!this.isConnected) return

		this.stopMotion(false)
		this.clearPositionFlags()
		const value = wrapRotatorAngle(azimuth)
		this.#sync.elements.DOME_SYNC_VALUE.value = value
		this.#sync.state = 'Ok'
		this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = value
		this.#absolute.state = 'Ok'
		this.notify(this.#sync)
		this.notify(this.#absolute)
	}

	// Starts a slew to the configured home azimuth.
	home() {
		if (!this.isConnected) return
		this.startTarget(this.#params.elements.HOME_POSITION.value, 'home')
	}

	// Starts a slew to the configured park azimuth.
	park() {
		if (!this.isConnected) return
		this.startTarget(this.#parkPosition.elements.PARK_AZ.value, 'park')
	}

	// Marks the dome unparked without moving it.
	unpark() {
		if (!this.isConnected) return

		this.clearParkState('Ok')
		this.clearHomeState('Ok')
	}

	// Stores the current azimuth as the park position in both supported number vectors.
	setPark() {
		if (!this.isConnected) return

		this.#parkPosition.elements.PARK_AZ.value = this.azimuth
		this.#params.elements.PARK_POSITION.value = this.azimuth
		this.#parkOption.state = 'Ok'
		this.#parkOption.elements.PARK_CURRENT.value = false
		this.notify(this.#parkPosition)
		this.notify(this.#params)
		this.notify(this.#parkOption)
	}

	// Starts an asynchronous shutter opening transition.
	openShutter() {
		this.startShutterTransition('OPEN')
	}

	// Starts an asynchronous shutter closing transition.
	closeShutter() {
		this.startShutterTransition('CLOSED')
	}

	// Aborts all active motion and shutter work, and disables autosync.
	stop(alert = true) {
		const moving = this.stopMotion(alert)
		const shutterMoving = this.stopShutter(alert)
		const slaved = this.#autoSync.elements.INDI_ENABLED.value

		if (slaved && applyExclusiveSwitchValues(this.#autoSync, { INDI_DISABLED: true })) this.notify(this.#autoSync)

		if (moving || shutterMoving) {
			this.#abort.state = alert ? 'Ok' : 'Idle'
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Advances azimuth and shutter transitions using elapsed wall-clock time.
	private tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		this.tickShutter(now)
		if (dtSeconds <= 0) return

		if (this.#continuousDirection !== undefined) {
			const sign = this.#continuousDirection === 'CLOCKWISE' ? 1 : -1
			this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = wrapRotatorAngle(this.azimuth + sign * this.speedDegreesPerSecond * dtSeconds)
			this.notify(this.#absolute)
			return
		}

		if (this.#targetAzimuth === undefined || this.#operation === undefined) return

		let delta: number
		if (this.#operation === 'relative') {
			delta = this.#relativeRemaining
		} else {
			delta = shortestRotatorDelta(this.#targetAzimuth, this.azimuth)
		}

		const step = this.speedDegreesPerSecond * dtSeconds
		if (Math.abs(delta) <= step) {
			this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = this.#targetAzimuth
			this.notify(this.#absolute)
			this.finishTarget()
			return
		}

		const signedStep = Math.sign(delta) * step
		this.#absolute.elements.DOME_ABSOLUTE_POSITION.value = wrapRotatorAngle(this.azimuth + signedStep)
		if (this.#operation === 'relative') this.#relativeRemaining -= signedStep
		this.notify(this.#absolute)
	}

	// Current rotation speed converted from RPM to degrees per second (one RPM is six degrees/s).
	private get speedDegreesPerSecond() {
		return this.#speed.elements.DOME_SPEED_VALUE.value * 6
	}

	// Starts an absolute, relative, home, or park operation and publishes all affected Busy vectors.
	private startTarget(target: number, operation: DomeOperation, relativeDelta = 0) {
		this.stopMotion(false)
		this.clearPositionFlags()
		this.#targetAzimuth = wrapRotatorAngle(target)
		this.#operation = operation
		this.#relativeRemaining = operation === 'relative' ? relativeDelta : 0
		if (operation === 'relative') this.#relative.elements.DOME_RELATIVE_POSITION.value = relativeDelta

		this.#absolute.state = 'Busy'
		this.notify(this.#absolute)

		if (operation === 'relative') {
			this.#relative.state = 'Busy'
			this.notify(this.#relative)
		} else if (operation === 'home') {
			this.#goto.state = 'Busy'
			this.#goto.elements.DOME_HOME.value = true
			this.notify(this.#goto)
		} else if (operation === 'park') {
			this.#goto.state = 'Busy'
			this.#goto.elements.DOME_PARK.value = true
			this.#park.state = 'Busy'
			this.#park.elements.PARK.value = true
			this.#park.elements.UNPARK.value = false
			this.notify(this.#goto)
			this.notify(this.#park)
		}

		if (this.#targetAzimuth === this.azimuth) this.finishTarget()
	}

	// Starts continuous clockwise or counter-clockwise motion.
	private startContinuous(direction: DomeDirection) {
		this.stopMotion(false)
		this.clearPositionFlags()
		this.#continuousDirection = direction
		this.#absolute.state = 'Busy'
		this.#motion.state = 'Busy'
		this.#motion.elements.DOME_CW.value = direction === 'CLOCKWISE'
		this.#motion.elements.DOME_CCW.value = direction === 'COUNTER_CLOCKWISE'
		this.notify(this.#motion)
		this.notify(this.#absolute)
	}

	// Stops target or continuous azimuth motion and clears every associated Busy state.
	private stopMotion(alert: boolean) {
		const operation = this.#operation
		const moving = this.#targetAzimuth !== undefined || this.#operation !== undefined || this.#continuousDirection !== undefined || this.#absolute.state === 'Busy'
		if (!moving) return false

		this.#targetAzimuth = undefined
		this.#operation = undefined
		this.#relativeRemaining = 0
		this.#continuousDirection = undefined
		this.#absolute.state = alert ? 'Alert' : 'Idle'
		this.notify(this.#absolute)

		if (this.#relative.state === 'Busy') {
			this.#relative.state = alert ? 'Alert' : 'Idle'
			this.notify(this.#relative)
		}

		if (this.#motion.state === 'Busy') {
			this.#motion.state = alert ? 'Alert' : 'Idle'
			this.#motion.elements.DOME_CW.value = false
			this.#motion.elements.DOME_CCW.value = false
			this.notify(this.#motion)
		}

		if (operation === 'home' || this.#goto.state === 'Busy') this.clearHomeState(alert ? 'Alert' : 'Idle')
		if (operation === 'park' || this.#park.state === 'Busy') this.clearParkState(alert ? 'Alert' : 'Idle')
		return true
	}

	// Finishes the current target operation and marks home/park state when appropriate.
	private finishTarget() {
		const operation = this.#operation
		this.#targetAzimuth = undefined
		this.#operation = undefined
		this.#relativeRemaining = 0
		this.#absolute.state = 'Idle'
		this.notify(this.#absolute)

		if (operation === 'relative') {
			this.#relative.state = 'Idle'
			this.notify(this.#relative)
		} else if (operation === 'home') {
			this.clearParkState('Idle')
			this.#goto.state = 'Ok'
			this.#goto.elements.DOME_HOME.value = true
			this.#goto.elements.DOME_PARK.value = false
			this.notify(this.#goto)
		} else if (operation === 'park') {
			this.#goto.state = 'Ok'
			this.#goto.elements.DOME_HOME.value = false
			this.#goto.elements.DOME_PARK.value = true
			this.#park.state = 'Ok'
			this.#park.elements.PARK.value = true
			this.#park.elements.UNPARK.value = false
			this.notify(this.#goto)
			this.notify(this.#park)
		}
	}

	// Clears the home and park action selections when a manual operation moves away.
	private clearPositionFlags() {
		this.clearHomeState('Idle')
		this.clearParkState('Idle')
	}

	// Clears home selection and reports the requested terminal state.
	private clearHomeState(state: PropertyState) {
		if (this.#goto.elements.DOME_HOME.value || this.#goto.state !== state) {
			this.#goto.elements.DOME_HOME.value = false
			this.#goto.state = state
			this.notify(this.#goto)
		}
	}

	// Clears park selection and reports the requested terminal state.
	private clearParkState(state: PropertyState) {
		if (this.#park.elements.PARK.value || this.#park.state !== state) {
			this.#park.elements.PARK.value = false
			this.#park.elements.UNPARK.value = true
			this.#park.state = state
			this.notify(this.#park)
		}
	}

	// Starts a shutter transition, treating repeated commands as successful no-ops.
	private startShutterTransition(target: DomeShutterTarget) {
		if (!this.isConnected) return

		const alreadyOpen = this.#shutter.elements.SHUTTER_OPEN.value
		const alreadyClosed = this.#shutter.elements.SHUTTER_CLOSE.value
		if ((target === 'OPEN' && alreadyOpen && this.#shutterTarget === undefined) || (target === 'CLOSED' && alreadyClosed && this.#shutterTarget === undefined)) {
			this.#shutter.state = 'Ok'
			this.notify(this.#shutter)
			return
		}

		this.#shutterTarget = target
		this.#shutterStartedAt = Date.now()
		this.#shutter.elements.SHUTTER_OPEN.value = target === 'OPEN'
		this.#shutter.elements.SHUTTER_CLOSE.value = target === 'CLOSED'
		this.#shutter.state = 'Busy'
		this.notify(this.#shutter)
	}

	// Completes a shutter transition after the configured duration.
	private tickShutter(now: number) {
		if (this.#shutterTarget === undefined || now - this.#shutterStartedAt < DOME_SHUTTER_MOVE_TIME_MS) return

		const target = this.#shutterTarget
		this.#shutterTarget = undefined
		this.#shutter.elements.SHUTTER_OPEN.value = target === 'OPEN'
		this.#shutter.elements.SHUTTER_CLOSE.value = target === 'CLOSED'
		this.#shutter.state = 'Ok'
		this.notify(this.#shutter)
	}

	// Cancels a shutter transition and guarantees that its vector no longer reports Busy.
	private stopShutter(alert: boolean) {
		const moving = this.#shutterTarget !== undefined || this.#shutter.state === 'Busy'
		if (!moving) return false

		this.#shutterTarget = undefined
		this.#shutter.state = alert ? 'Alert' : 'Idle'
		this.notify(this.#shutter)
		return true
	}
}
