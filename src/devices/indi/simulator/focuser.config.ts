import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'
import { CAMERA_AMBIENT_TEMPERATURE } from './constants'

// Configuration of the simulated focuser, one section per circuit. A simulator is built from
// DEFAULT_FOCUSER_SIMULATOR_CONFIG merged with the partial override its options carry; the defaults are
// never mutated. Positions and travel are motor steps.

// Motor and travel.
export interface FocuserDriveConfig {
	// Last position of the travel, steps, positive; the first one is 0.
	readonly maxPosition: number
	// Position at power-up, steps within [0, maxPosition].
	readonly position: number
	// Motor speed, steps per second, positive.
	readonly rate: number
}

// Gear train between the motor and the drawtube.
export interface FocuserGearConfig {
	// Play of the gear train, steps, non-negative: a reversal turns the motor this far before the
	// optics move again.
	readonly backlash: number
	// Whether the driver compensates the play on reversals at power-up.
	readonly compensation: boolean
	// Steps the driver adds to the motor on every reversal when compensating, non-negative.
	readonly compensationSteps: number
}

// Ambient temperature the focuser's probe reads.
export interface FocuserThermometerConfig {
	// Mean temperature, °C.
	readonly ambient: number
	// Semi-amplitude of the sinusoidal swing, °C, non-negative.
	readonly amplitude: number
	// Period of the swing, seconds, positive.
	readonly period: number
}

// Temperature compensation of the controller.
export interface FocuserCompensationConfig {
	// Steps moved per °C of temperature change, signed: negative moves inwards as it warms.
	readonly stepsPerDegree: number
	// Temperature change, °C, below which no move is made, non-negative.
	readonly hysteresis: number
}

// Full configuration of a simulated focuser.
export interface FocuserSimulatorConfig {
	readonly drive: FocuserDriveConfig
	readonly gear: FocuserGearConfig
	readonly thermometer: FocuserThermometerConfig
	readonly compensation: FocuserCompensationConfig
}

// Partial override of a focuser configuration, merged section by section into the defaults.
export type FocuserSimulatorConfigOverride = DeepPartial<FocuserSimulatorConfig>

// Defaults of every simulated focuser: a 100000-step drawtube in the middle of its travel, without
// play, under a temperature swinging 4 °C every 40 seconds so compensation is visible quickly.
export const DEFAULT_FOCUSER_SIMULATOR_CONFIG: FocuserSimulatorConfig = {
	drive: { maxPosition: 100000, position: 50000, rate: 20000 },
	gear: { backlash: 0, compensation: false, compensationSteps: 0 },
	thermometer: { ambient: CAMERA_AMBIENT_TEMPERATURE, amplitude: 4, period: 40 },
	compensation: { stepsPerDegree: -250, hysteresis: 0.05 },
}

// Builds the configuration of a focuser from the defaults and an optional override.
export function focuserSimulatorConfig(override?: FocuserSimulatorConfigOverride, base: FocuserSimulatorConfig = DEFAULT_FOCUSER_SIMULATOR_CONFIG): FocuserSimulatorConfig {
	return mergeConfig(base, override)
}
