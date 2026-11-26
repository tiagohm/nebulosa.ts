import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { SafetyMonitorCondition } from './safetymonitor.condition'
import { type SafetyCondition, type SafetyMonitorSimulatorConfig, type SafetyMonitorSimulatorConfigOverride, safetyMonitorSimulatorConfig } from './safetymonitor.config'

// Fail-closed INDI safety-monitor simulation: a board with the condition the simulator-only selector
// sets and the passive status light it drives.

// Options of a simulated safety monitor.
export interface SafetyMonitorSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_SAFETY_MONITOR_SIMULATOR_CONFIG.
	readonly config?: SafetyMonitorSimulatorConfigOverride
}

// Simulates an AUXILIARY INDI Safety Monitor driver. The public status is read-only; the
// SIMULATOR_SAFETY switch selects safe, unsafe, warning or unknown conditions.
export class SafetyMonitorSimulator extends BoardSimulator {
	readonly type = 'safetyMonitor'

	// Configuration the monitor was built with.
	readonly configuration: SafetyMonitorSimulatorConfig

	readonly #condition: SafetyMonitorCondition

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: SafetyMonitorSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.AUXILIARY, 'safetymonitor.simulator', options?.now)
		this.configuration = safetyMonitorSimulatorConfig(options?.config)
		this.#condition = new SafetyMonitorCondition(this.bus, this.configuration)
		this.install(this.#condition)
	}

	// Selected condition.
	get condition() {
		return this.#condition.condition
	}

	// Selects the safe or unsafe condition: false is a definite Alert.
	setSafe(safe: boolean) {
		this.#condition.setCondition(safe ? 'SAFE' : 'UNSAFE')
	}

	// Selects any condition.
	setCondition(condition: SafetyCondition) {
		this.#condition.setCondition(condition)
	}
}
