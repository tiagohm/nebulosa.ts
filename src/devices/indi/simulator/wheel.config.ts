import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated filter wheel. A simulator is built from
// DEFAULT_WHEEL_SIMULATOR_CONFIG merged with the partial override its options carry; the defaults are
// never mutated. An override replaces the slot list as a whole.

// Full configuration of a simulated filter wheel.
export interface WheelSimulatorConfig {
	// Initial name of every slot, in slot order; its length is the number of slots, at least one.
	readonly slots: readonly string[]
	// Time the carousel takes to turn by one slot, milliseconds, non-negative.
	readonly slotTime: number
	// Shortest time of any slot change, milliseconds, non-negative: settling and latching the detent.
	readonly minimumMoveTime: number
}

// Partial override of a filter-wheel configuration.
export type WheelSimulatorConfigOverride = DeepPartial<WheelSimulatorConfig>

// Defaults of every simulated filter wheel: eight slots of LRGB and narrowband filters plus a dark.
export const DEFAULT_WHEEL_SIMULATOR_CONFIG: WheelSimulatorConfig = {
	slots: ['L', 'R', 'G', 'B', 'Ha', 'SII', 'OIII', 'Dark'],
	slotTime: 250,
	minimumMoveTime: 150,
}

// Builds the configuration of a filter wheel from the defaults and an optional override.
export function wheelSimulatorConfig(override?: WheelSimulatorConfigOverride, base: WheelSimulatorConfig = DEFAULT_WHEEL_SIMULATOR_CONFIG): WheelSimulatorConfig {
	return mergeConfig(base, override)
}
