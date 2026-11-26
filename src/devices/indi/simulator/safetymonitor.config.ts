import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated safety monitor. A simulator is built from
// DEFAULT_SAFETY_MONITOR_SIMULATOR_CONFIG merged with the partial override its options carry; the
// defaults are never mutated.

// Condition the simulated monitor reports: SAFE maps to Ok, UNSAFE to Alert, WARNING to Busy and
// UNKNOWN to Idle.
export type SafetyCondition = 'SAFE' | 'UNSAFE' | 'WARNING' | 'UNKNOWN'

// Full configuration of a simulated safety monitor.
export interface SafetyMonitorSimulatorConfig {
	// Condition at power-up.
	readonly condition: SafetyCondition
}

// Partial override of a safety-monitor configuration.
export type SafetyMonitorSimulatorConfigOverride = DeepPartial<SafetyMonitorSimulatorConfig>

// Defaults of every simulated safety monitor: fail closed, the condition unknown until set.
export const DEFAULT_SAFETY_MONITOR_SIMULATOR_CONFIG: SafetyMonitorSimulatorConfig = {
	condition: 'UNKNOWN',
}

// Builds the configuration of a safety monitor from the defaults and an optional override.
export function safetyMonitorSimulatorConfig(override?: SafetyMonitorSimulatorConfigOverride, base: SafetyMonitorSimulatorConfig = DEFAULT_SAFETY_MONITOR_SIMULATOR_CONFIG): SafetyMonitorSimulatorConfig {
	return mergeConfig(base, override)
}
