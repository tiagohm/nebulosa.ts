import { SIDEREAL_DRIFT_RATE } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import { mulberry32, normal, type Random } from '../../../math/numerical/random'
import type { Angle } from '../../../math/units/angle'
import type { TrackMode } from '../device'
import { makeSwitchVector, type NewNumberVector, type NewSwitchVector, selectOnSwitch } from '../types'
import { type ChoiceBinding, type ComponentBus, makeBoundNumberVector, makeChoiceVector, type NumberBinding, readBoundNumberVector, readChoiceVector, SimulatorComponent } from './component'
import { KING_DRIFT_RATE, LUNAR_DRIFT_RATE, MAIN_CONTROL, SIMULATION, SOLAR_DRIFT_RATE } from './constants'
import type { MountDriveConfig, MountTrackingRateConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

// Rate error of a mount's tracking drive: the drive never turns at exactly the commanded speed, so a
// mount left tracking slowly walks away from the star it was pointed at even with perfect polar
// alignment and no periodic error. Expressed in parts per million of the commanded rate, which is how
// crystal tolerances and gear ratio errors are specified.
//
// The error is deliberately not observable from the encoders: it is the drive delivering more or less
// travel than it is told to, so the controller keeps reporting the position it believes it commanded.
// That is what makes this error insidious in practice and what unguided imaging actually suffers from.

// Temperature at which the drive is taken to be calibrated, degrees Celsius. The temperature
// coefficient acts on the departure from this value, so a mount at its calibration temperature shows
// only its bias.
export const TRACKING_RATE_CALIBRATION_TEMPERATURE = 20

// Largest accumulated random-walk excursion, parts per million. A random walk is unbounded by
// construction and a long session would eventually wander into rates that are not a rate error but a
// broken mount; this rail keeps a very long run physically meaningful. One percent is already far
// worse than any usable drive.
const MAX_RANDOM_WALK_PPM = 10000

// Rate error characteristics of a drive.
export interface TrackingRateErrorConfig {
	// Constant relative error of the drive, parts per million. Positive means it runs fast.
	readonly bias: number
	// Change of the rate error per degree Celsius away from the calibration temperature, ppm/°C.
	readonly temperatureCoefficient: number
	// Ambient temperature seen by the drive, degrees Celsius.
	readonly temperature: number
	// Standard deviation of the random walk of the rate error, ppm per square root of a second. Zero
	// makes the error deterministic.
	readonly randomWalk: number
}

// A perfect drive, turning at exactly the commanded rate at any temperature.
export const IDENTITY_TRACKING_RATE_ERROR_CONFIG: TrackingRateErrorConfig = {
	bias: 0,
	temperatureCoefficient: 0,
	temperature: TRACKING_RATE_CALIBRATION_TEMPERATURE,
	randomWalk: 0,
}

// Live state of the drive: the wandering component of its rate error, parts per million.
export interface TrackingRateErrorState {
	walk: number
}

// Creates the state of a drive whose rate error has not wandered yet.
export function trackingRateErrorState(): TrackingRateErrorState {
	return { walk: 0 }
}

// Discards the accumulated wander, as on a power cycle.
export function resetTrackingRateError(state: TrackingRateErrorState) {
	state.walk = 0
}

// Advances the random-walk component by `dtSeconds` and returns the total rate error in parts per
// million, the sum of the bias, the temperature term and the wander.
//
// `normal` must be a standard normal source: the increment is scaled by the square root of the
// interval, which is what makes the walk invariant to the integration step. Sampling a fixed
// increment per tick instead would make the drift depend on the tick rate rather than on elapsed time.
export function advanceTrackingRateError(state: TrackingRateErrorState, dtSeconds: number, config: TrackingRateErrorConfig, normal: Random) {
	if (dtSeconds > 0 && config.randomWalk > 0) {
		state.walk = clamp(state.walk + normal() * config.randomWalk * Math.sqrt(dtSeconds), -MAX_RANDOM_WALK_PPM, MAX_RANDOM_WALK_PPM)
	}

	return config.bias + config.temperatureCoefficient * (config.temperature - TRACKING_RATE_CALIBRATION_TEMPERATURE) + state.walk
}

// Modes of TELESCOPE_TRACK_MODE.
const TRACK_MODES: readonly ChoiceBinding<TrackMode>[] = [
	['TRACK_SIDEREAL', 'Sidereal', 'SIDEREAL'],
	['TRACK_SOLAR', 'Solar', 'SOLAR'],
	['TRACK_LUNAR', 'Lunar', 'LUNAR'],
	['TRACK_KING', 'King', 'KING'],
]

// Terms of MOUNT_TRACKING_RATE: bias in ppm, temperature coefficient in ppm/°C, drive temperature in °C
// and random walk in ppm/√s.
const TRACKING_RATE: readonly NumberBinding<keyof MountTrackingRateConfig>[] = [
	['BIAS', 'Rate Bias (ppm)', 'bias', -10000, 10000, 1, '%.2f'],
	['TEMPERATURE_COEFFICIENT', 'Temperature Coefficient (ppm/C)', 'temperatureCoefficient', -1000, 1000, 0.1, '%.3f'],
	['TEMPERATURE', 'Temperature (C)', 'temperature', -60, 60, 0.1, '%.1f'],
	['RANDOM_WALK', 'Random Walk (ppm/sqrt(s))', 'randomWalk', 0, 1000, 0.1, '%.3f'],
]

// Drift of a tracking mode relative to the sky, radians per second: zero for sidereal.
function trackingDriftRate(mode: TrackMode) {
	return mode === 'SOLAR' ? SOLAR_DRIFT_RATE : mode === 'LUNAR' ? LUNAR_DRIFT_RATE : mode === 'KING' ? KING_DRIFT_RATE : 0
}

// The tracking drive: whether it runs, at which rate, and how far its rate error has walked away from
// what the encoders counted.
export class MountTracking extends SimulatorComponent {
	readonly #mode: ReturnType<typeof makeChoiceVector>
	readonly #state = makeSwitchVector('', 'TELESCOPE_TRACK_STATE', 'Tracking', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_ON', 'On', false], ['TRACK_OFF', 'Off', true])
	readonly #rate: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly (ReturnType<typeof makeChoiceVector> | ReturnType<typeof makeBoundNumberVector>)[]
	readonly transient: readonly ReturnType<typeof makeSwitchVector>[]

	// Whether the tracking-rate family is simulated; set through `refresh`.
	#rateErrorEnabled = false
	// Rate-error configuration in effect, the identity while the family is off.
	#config: TrackingRateErrorConfig = IDENTITY_TRACKING_RATE_ERROR_CONFIG
	// Wandering component of the rate error.
	readonly #walk = trackingRateErrorState()
	// Rate error of the step being simulated, ppm, sampled once per step.
	#error = 0
	// Right ascension the drive has delivered beyond what the encoders counted, radians. Unbounded on
	// purpose: an uncorrected rate error walks away without limit.
	offset: Angle = 0
	// Standard normal source of the walk.
	readonly #normal: Random

	// `drive` gives the initial mode, `config` the rate error and `seed` its generator; `parked` says
	// whether the mount is parked, which keeps the drive off.
	constructor(
		bus: ComponentBus,
		drive: MountDriveConfig,
		config: MountTrackingRateConfig,
		seed: number,
		readonly parked: () => boolean,
	) {
		super(bus)
		this.#mode = makeChoiceVector('TELESCOPE_TRACK_MODE', 'Track Mode', MAIN_CONTROL, TRACK_MODES, drive.trackMode)
		this.#rate = makeBoundNumberVector('MOUNT_TRACKING_RATE', 'Tracking Rate', SIMULATION, TRACKING_RATE, config)
		this.properties = [this.#mode, this.#state, this.#rate]
		this.transient = [this.#state]
		this.#normal = normal(mulberry32(seed))
	}

	// Whether the drive tracks.
	get enabled() {
		return this.#state.elements.TRACK_ON.value
	}

	// Selected tracking mode.
	get mode(): TrackMode {
		return readChoiceVector(this.#mode, TRACK_MODES)
	}

	// Rate error of the step being simulated, ppm.
	get error() {
		return this.#error
	}

	// Rate of the right-ascension motor tracking asks for, radians per second: the westward turn of the
	// sky cancelled, plus the drift of the mode; zero while not tracking.
	get motorRate() {
		return this.enabled ? trackingDriftRate(this.mode) - SIDEREAL_DRIFT_RATE : 0
	}

	// Starts or stops tracking; a parked mount never tracks.
	setEnabled(enabled: boolean) {
		if (this.parked()) enabled = false
		if (this.enabled === enabled) return
		if (selectOnSwitch(this.#state, enabled ? 'TRACK_ON' : 'TRACK_OFF')) this.bus.notify(this.#state)
	}

	// Selects a tracking mode.
	setMode(mode: TrackMode) {
		const choice = TRACK_MODES.find((e) => e[2] === mode)
		if (choice === undefined || this.mode === mode) return
		if (selectOnSwitch(this.#mode, choice[0])) this.bus.notify(this.#mode)
	}

	// Rebuilds the rate-error configuration for the family being `enabled` or not; switching it off
	// forgets the walk and the drift it had accumulated.
	refresh(enabled: boolean) {
		this.#rateErrorEnabled = enabled

		if (!enabled) {
			this.#config = IDENTITY_TRACKING_RATE_ERROR_CONFIG
			this.forgetWalk()
			this.offset = 0
			return
		}

		this.#config = readBoundNumberVector(this.#rate, TRACKING_RATE)
	}

	// Samples the rate error of a step of `dtSeconds`.
	advance(dtSeconds: number) {
		this.#error = advanceTrackingRateError(this.#walk, dtSeconds, this.#config, this.#normal)
	}

	// Accrues the excess travel of a right-ascension `step` the transmission delivered, radians: the
	// drive moves the step times one plus its rate error while the encoders count only the step. A stuck
	// axis delivers nothing and so runs fast by nothing.
	accrue(step: Angle) {
		if (this.#error !== 0 && step !== 0) this.offset += step * this.#error * 1e-6
	}

	// Forgets how far the rate had wandered, as a power cycle does; the drift already accrued stays.
	forgetWalk() {
		resetTrackingRateError(this.#walk)
		this.#error = 0
	}

	// Handles MOUNT_TRACKING_RATE.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#rate.name) return false

		if (applyNumberVectorValues(this.#rate, vector.elements)) {
			if (this.#rateErrorEnabled) this.#config = readBoundNumberVector(this.#rate, TRACKING_RATE)
			this.bus.notify(this.#rate)
		}

		return true
	}

	// Handles TELESCOPE_TRACK_MODE and TELESCOPE_TRACK_STATE.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name === this.#mode.name) {
			const choice = TRACK_MODES.find((e) => vector.elements[e[0]] === true)
			if (choice !== undefined) this.setMode(choice[2])
			return true
		}

		if (vector.name === this.#state.name) {
			if (vector.elements.TRACK_ON === true) this.setEnabled(true)
			else if (vector.elements.TRACK_OFF === true) this.setEnabled(false)
			return true
		}

		return false
	}
}
