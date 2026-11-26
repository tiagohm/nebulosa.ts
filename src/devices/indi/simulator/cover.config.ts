import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated dust cap. A simulator is built from DEFAULT_COVER_SIMULATOR_CONFIG
// merged with the partial override its options carry; the defaults are never mutated.

// Full configuration of a simulated dust cap.
export interface CoverSimulatorConfig {
	// Time the cap takes to open or close, milliseconds, positive.
	readonly moveTime: number
	// Whether the cap powers up closed (parked).
	readonly parked: boolean
}

// Partial override of a dust-cap configuration.
export type CoverSimulatorConfigOverride = DeepPartial<CoverSimulatorConfig>

// Defaults of every simulated dust cap: a motorized cap that opens or closes in half a second, open.
export const DEFAULT_COVER_SIMULATOR_CONFIG: CoverSimulatorConfig = {
	moveTime: 500,
	parked: false,
}

// Builds the configuration of a dust cap from the defaults and an optional override.
export function coverSimulatorConfig(override?: CoverSimulatorConfigOverride, base: CoverSimulatorConfig = DEFAULT_COVER_SIMULATOR_CONFIG): CoverSimulatorConfig {
	return mergeConfig(base, override)
}
