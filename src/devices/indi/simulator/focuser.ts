import { TAU } from '../../../core/constants'
import { validateInRange } from '../../../core/validation'
import { clamp } from '../../../math/numerical/math'
import { normalizeAngle } from '../../../math/units/angle'
import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { ClientSimulator } from './client'
import { CAMERA_AMBIENT_TEMPERATURE, FOCUSER_INITIAL_POSITION, FOCUSER_MAX_POSITION, FOCUSER_MOVE_RATE, FOCUSER_TEMPERATURE_AMPLITUDE, FOCUSER_TEMPERATURE_COMPENSATION_HYSTERESIS, FOCUSER_TEMPERATURE_COMPENSATION_STEPS, FOCUSER_TEMPERATURE_PERIOD_SECONDS, MAIN_CONTROL, SIMULATION, TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Simulated focuser motion, mechanical backlash, ambient temperature, and temperature compensation.

// Direction of motor travel, with zero denoting a mechanism that has not yet engaged either side.
type FocuserAxisDirection = -1 | 0 | 1

// Configures persistence and direction-dependent lost motion for a simulated focuser.
export interface FocuserSimulatorOptions extends DeviceSimulatorOptions {
	// Motor travel in steps consumed before effective motion resumes in the inward/decreasing direction.
	readonly backlashIn?: number
	// Motor travel in steps consumed before effective motion resumes in the outward/increasing direction.
	readonly backlashOut?: number
}

// Simulated focuser. Models absolute/relative moves at a fixed rate, reverse, a sinusoidal temperature,
// direction-dependent backlash, and temperature compensation, advancing the position each tick.
export class FocuserSimulator extends DeviceSimulator {
	readonly type = 'focuser'

	readonly #position = makeNumberVector('', 'ABS_FOCUS_POSITION', 'Position', MAIN_CONTROL, 'rw', ['FOCUS_ABSOLUTE_POSITION', 'Position', FOCUSER_INITIAL_POSITION, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])
	readonly #relativePosition = makeNumberVector('', 'REL_FOCUS_POSITION', 'Relative', MAIN_CONTROL, 'rw', ['FOCUS_RELATIVE_POSITION', 'Steps', 0, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])
	readonly #motion = makeSwitchVector('', 'FOCUS_MOTION', 'Motion', MAIN_CONTROL, 'OneOfMany', 'rw', ['FOCUS_INWARD', 'Inward', false], ['FOCUS_OUTWARD', 'Outward', true])
	readonly #abort = makeSwitchVector('', 'FOCUS_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #reverse = makeSwitchVector('', 'FOCUS_REVERSE_MOTION', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #sync = makeNumberVector('', 'FOCUS_SYNC', 'Sync', MAIN_CONTROL, 'rw', ['FOCUS_SYNC_VALUE', 'Position', FOCUSER_INITIAL_POSITION, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])
	readonly #temperature = makeNumberVector('', 'FOCUS_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['TEMPERATURE', 'Temperature', CAMERA_AMBIENT_TEMPERATURE, -50, 70, 0.1, '%6.2f'])
	readonly #temperatureCompensation = makeSwitchVector('', 'FOCUS_TEMPERATURE_COMPENSATION', 'Temperature Compensation', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'On', false], ['INDI_DISABLED', 'Off', true])
	readonly #backlash = makeNumberVector('', 'SIMULATOR_BACKLASH', 'Backlash', SIMULATION, 'rw', ['BACKLASH_IN', 'In (steps)', 0, 0, FOCUSER_MAX_POSITION, 1, '%.0f'], ['BACKLASH_OUT', 'Out (steps)', 0, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])

	protected readonly properties: readonly SimulatorProperty[] = [this.#position, this.#relativePosition, this.#motion, this.#abort, this.#reverse, this.#sync, this.#temperature, this.#temperatureCompensation, this.#backlash]
	protected propertiesToNotSave: readonly SimulatorProperty[] = this.properties.filter((e) => e !== this.#reverse && e !== this.#motion && e !== this.#backlash)

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#targetPosition?: number
	#effectivePosition = FOCUSER_INITIAL_POSITION
	#engagedDirection: FocuserAxisDirection = 0
	#slackTravel = 0
	#temperaturePhase = 0
	#lastCompensationTemperature = CAMERA_AMBIENT_TEMPERATURE

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: FocuserSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.FOCUSER)
		this.#backlash.elements.BACKLASH_IN.value = validateInRange(options?.backlashIn ?? 0, 0, FOCUSER_MAX_POSITION)
		this.#backlash.elements.BACKLASH_OUT.value = validateInRange(options?.backlashOut ?? 0, 0, FOCUSER_MAX_POSITION)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'focuser.simulator'
	}

	// Current absolute position (steps).
	get position() {
		return this.#position.elements.FOCUS_ABSOLUTE_POSITION.value
	}

	// Current effective optical position after mechanical backlash is applied, in steps.
	get effectivePosition() {
		return this.#effectivePosition
	}

	// Configured lost motion before effective inward/decreasing travel resumes, in steps.
	get backlashIn() {
		return this.#backlash.elements.BACKLASH_IN.value
	}

	// Configured lost motion before effective outward/increasing travel resumes, in steps.
	get backlashOut() {
		return this.#backlash.elements.BACKLASH_OUT.value
	}

	// Whether a move is in progress.
	get isMoving() {
		return this.#position.state === 'Busy'
	}

	// Whether temperature compensation is enabled.
	get isTemperatureCompensationEnabled() {
		return this.#temperatureCompensation.elements.INDI_ENABLED.value
	}

	// Current temperature (degrees Celsius).
	get temperature() {
		return this.#temperature.elements.TEMPERATURE.value
	}

	// Handles focuser number commands: absolute/relative move and sync to a position.
	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'ABS_FOCUS_POSITION':
				if (vector.elements.FOCUS_ABSOLUTE_POSITION !== undefined) this.moveTo(vector.elements.FOCUS_ABSOLUTE_POSITION)
				return
			case 'REL_FOCUS_POSITION':
				if (vector.elements.FOCUS_RELATIVE_POSITION !== undefined) this.moveRelative(vector.elements.FOCUS_RELATIVE_POSITION)
				return
			case 'FOCUS_SYNC':
				if (vector.elements.FOCUS_SYNC_VALUE !== undefined) this.syncTo(vector.elements.FOCUS_SYNC_VALUE)
				return
			case 'SIMULATOR_BACKLASH':
				if (applyNumberVectorValues(this.#backlash, vector.elements)) {
					this.#engagedDirection = 0
					this.#slackTravel = 0
					this.notify(this.#backlash)
				}
		}
	}

	// Handles focuser switch commands: connection, motion direction, abort, reverse, and temperature
	// compensation toggle.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'FOCUS_MOTION':
				if (applyExclusiveSwitchValues(this.#motion, vector.elements)) this.notify(this.#motion)
				return
			case 'FOCUS_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'FOCUS_REVERSE_MOTION':
				if (applyExclusiveSwitchValues(this.#reverse, vector.elements)) this.notify(this.#reverse)
				return
			case 'FOCUS_TEMPERATURE_COMPENSATION':
				if (applyExclusiveSwitchValues(this.#temperatureCompensation, vector.elements)) {
					this.#lastCompensationTemperature = this.temperature
					this.notify(this.#temperatureCompensation)
				}
		}
	}

	// Connects the simulated focuser and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.#lastCompensationTemperature = this.temperature
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated focuser and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.stop(false)

		super.disconnect()
	}

	// Disposes the focuser simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts an absolute focuser move.
	moveTo(position: number) {
		if (!this.isConnected) return

		position = clamp(position, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		if (position === this.position) return

		this.#targetPosition = position
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(position - this.position)
		this.#setMoving(true)
	}

	// Starts a relative move using the selected motion direction.
	moveRelative(steps: number) {
		if (!this.isConnected || steps <= 0) return

		const direction = this.#relativeDirection()
		const target = clamp(this.position + steps * direction, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		if (target === this.position) return

		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(target - this.position)
		this.#targetPosition = target
		this.#setMoving(true)
	}

	// Applies a sync immediately without any slew time.
	syncTo(position: number) {
		if (!this.isConnected) return

		position = clamp(position, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		this.#sync.elements.FOCUS_SYNC_VALUE.value = position
		this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = position
		this.#effectivePosition = position
		this.#engagedDirection = 0
		this.#slackTravel = 0
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = 0
		this.stop(false)
		this.notify(this.#sync)
		this.notify(this.#position)
	}

	// Aborts the active move and leaves the focuser at its current position.
	stop(alert: boolean = true) {
		const wasMoving = this.isMoving
		this.#targetPosition = undefined
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = 0
		this.#setMoving(false, alert)

		if (alert && wasMoving) {
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Advances the focuser position toward the requested target.
	#tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0) return

		this.#advanceTemperature(dtSeconds)
		this.#applyTemperatureCompensation()

		if (this.#targetPosition === undefined) return

		const current = this.position
		const delta = this.#targetPosition - current
		const step = FOCUSER_MOVE_RATE * dtSeconds

		if (Math.abs(delta) <= step) {
			this.#advanceEffectivePosition(delta)
			this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = this.#targetPosition
			this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = 0
			this.#targetPosition = undefined
			this.#setMoving(false)
			this.notify(this.#position)
			this.notify(this.#relativePosition)
			return
		}

		const next = current + Math.sign(delta) * step
		this.#advanceEffectivePosition(next - current)
		this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = next
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(this.#targetPosition - next)
		this.notify(this.#position)
		this.notify(this.#relativePosition)
	}

	// Applies signed motor travel to the effective position while preserving partially consumed slack.
	#advanceEffectivePosition(travel: number) {
		if (travel === 0) return

		const direction = Math.sign(travel) as Exclude<FocuserAxisDirection, 0>
		let remaining = Math.abs(travel)

		if (this.#engagedDirection === 0) {
			this.#engagedDirection = direction
			this.#effectivePosition = clamp(this.#effectivePosition + travel, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
			return
		}

		if (direction === this.#engagedDirection) {
			const recovered = Math.min(remaining, this.#slackTravel)
			this.#slackTravel -= recovered
			remaining -= recovered
			if (remaining > 0) this.#effectivePosition += direction * remaining
		} else {
			const backlash = direction < 0 ? this.backlashIn : this.backlashOut
			const consumed = Math.min(remaining, Math.max(0, backlash - this.#slackTravel))
			this.#slackTravel += consumed
			remaining -= consumed

			if (this.#slackTravel >= backlash) {
				this.#engagedDirection = direction
				this.#slackTravel = 0
				if (remaining > 0) this.#effectivePosition += direction * remaining
			}
		}

		this.#effectivePosition = clamp(this.#effectivePosition, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
	}

	// Updates the moving state reflected by both focuser motion vectors.
	#setMoving(moving: boolean, alert: boolean = false) {
		const state = alert ? 'Alert' : moving ? 'Busy' : 'Idle'
		let updated = false

		if (this.#position.state !== state) {
			this.#position.state = state
			updated = true
		}

		if (this.#relativePosition.state !== state) {
			this.#relativePosition.state = state
			updated = true
		}

		if (updated) {
			this.notify(this.#position)
			this.notify(this.#relativePosition)
		}
	}

	// Resolves the current relative-motion direction after reverse mode is applied.
	#relativeDirection() {
		const direction = this.#motion.elements.FOCUS_INWARD.value ? -1 : 1
		return this.#reverse.elements.INDI_ENABLED.value ? -direction : direction
	}

	// Advances the simulated ambient temperature with a smooth periodic waveform.
	#advanceTemperature(dtSeconds: number) {
		this.#temperaturePhase = normalizeAngle(this.#temperaturePhase + (dtSeconds * TAU) / FOCUSER_TEMPERATURE_PERIOD_SECONDS)
		const next = CAMERA_AMBIENT_TEMPERATURE + Math.sin(this.#temperaturePhase) * FOCUSER_TEMPERATURE_AMPLITUDE

		if (Math.abs(next - this.temperature) >= 0.1) {
			this.#temperature.elements.TEMPERATURE.value = next
			this.notify(this.#temperature)
		}
	}

	// Applies a simple temperature-compensation model by nudging focus position as ambient temperature drifts.
	#applyTemperatureCompensation() {
		if (!this.isTemperatureCompensationEnabled || this.isMoving) {
			this.#lastCompensationTemperature = this.temperature
			return
		}

		const delta = this.temperature - this.#lastCompensationTemperature
		if (Math.abs(delta) < FOCUSER_TEMPERATURE_COMPENSATION_HYSTERESIS) return

		const steps = Math.trunc(delta * FOCUSER_TEMPERATURE_COMPENSATION_STEPS)
		this.#lastCompensationTemperature = this.temperature
		if (steps === 0) return

		const target = clamp(this.position + steps, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		if (target === this.position) return

		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(target - this.position)
		this.#targetPosition = target
		this.#setMoving(true)
	}
}
