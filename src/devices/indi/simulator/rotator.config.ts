import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated field rotator. A simulator is built from
// DEFAULT_ROTATOR_SIMULATOR_CONFIG merged with the partial override its options carry; the defaults are
// never mutated.

// Full configuration of a simulated rotator.
export interface RotatorSimulatorConfig {
	// Rotation rate, degrees per second, positive.
	readonly rate: number
	// Mechanical angle at power-up, degrees in [0, 360).
	readonly angle: number
	// Angle the home command goes to, degrees in [0, 360).
	readonly homeAngle: number
}

// Partial override of a rotator configuration.
export type RotatorSimulatorConfigOverride = DeepPartial<RotatorSimulatorConfig>

// Defaults of every simulated rotator: 90° per second, at and homing to 0°.
export const DEFAULT_ROTATOR_SIMULATOR_CONFIG: RotatorSimulatorConfig = {
	rate: 90,
	angle: 0,
	homeAngle: 0,
}

// Builds the configuration of a rotator from the defaults and an optional override.
export function rotatorSimulatorConfig(override?: RotatorSimulatorConfigOverride, base: RotatorSimulatorConfig = DEFAULT_ROTATOR_SIMULATOR_CONFIG): RotatorSimulatorConfig {
	return mergeConfig(base, override)
}
