import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated flat-field light panel. A simulator is built from
// DEFAULT_FLAT_PANEL_SIMULATOR_CONFIG merged with the partial override its options carry; the defaults
// are never mutated.

// Full configuration of a simulated flat panel.
export interface FlatPanelSimulatorConfig {
	// Highest brightness the controller accepts, in its own units, positive.
	readonly maxIntensity: number
	// Brightness set at power-up, within [0, maxIntensity].
	readonly intensity: number
}

// Partial override of a flat-panel configuration.
export type FlatPanelSimulatorConfigOverride = DeepPartial<FlatPanelSimulatorConfig>

// Defaults of every simulated flat panel: an 8-bit dimmer set to zero.
export const DEFAULT_FLAT_PANEL_SIMULATOR_CONFIG: FlatPanelSimulatorConfig = {
	maxIntensity: 255,
	intensity: 0,
}

// Builds the configuration of a flat panel from the defaults and an optional override.
export function flatPanelSimulatorConfig(override?: FlatPanelSimulatorConfigOverride, base: FlatPanelSimulatorConfig = DEFAULT_FLAT_PANEL_SIMULATOR_CONFIG): FlatPanelSimulatorConfig {
	return mergeConfig(base, override)
}
