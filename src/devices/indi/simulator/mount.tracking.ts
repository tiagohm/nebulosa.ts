import { clamp } from '../../../math/numerical/math'
import type { Random } from '../../../math/numerical/random'

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
