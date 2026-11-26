import { makeLightVector, makeSwitchVector, type NewSwitchVector, type PropertyState, selectOnSwitch } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { SafetyCondition, SafetyMonitorSimulatorConfig } from './safetymonitor.config'

// Condition circuit of the simulated safety monitor: the standard aggregate SAFETY_STATUS light, which
// only reads safe when Ok, driven by the simulator-only SIMULATOR_SAFETY selector.

// Light state each condition publishes.
const CONDITION_STATES: Readonly<Record<SafetyCondition, PropertyState>> = { SAFE: 'Ok', UNSAFE: 'Alert', WARNING: 'Busy', UNKNOWN: 'Idle' }

// Conditions in selector order.
const CONDITIONS = Object.keys(CONDITION_STATES) as readonly SafetyCondition[]

// The safety condition.
export class SafetyMonitorCondition extends SimulatorComponent {
	readonly #status = makeLightVector('', 'SAFETY_STATUS', 'Safety', MAIN_CONTROL, ['SAFETY', 'Safety', 'Idle'])
	readonly #condition = makeSwitchVector('', 'SIMULATOR_SAFETY', 'Safety Condition', MAIN_CONTROL, 'OneOfMany', 'rw', ['SAFE', 'Safe', false], ['UNSAFE', 'Unsafe', false], ['WARNING', 'Warning', false], ['UNKNOWN', 'Unknown', true])

	readonly properties = [this.#status, this.#condition]
	// The public status is rebuilt from the saved condition.
	readonly transient = [this.#status]

	// `config` gives the condition at power-up.
	constructor(bus: ComponentBus, config: SafetyMonitorSimulatorConfig) {
		super(bus)
		selectOnSwitch(this.#condition, config.condition)
		this.#publishStatus(CONDITION_STATES[config.condition], false)
	}

	// Selected condition.
	get condition(): SafetyCondition {
		return CONDITIONS.find((e) => this.#condition.elements[e].value) ?? 'UNKNOWN'
	}

	// Selects `condition` and publishes the status it maps to.
	setCondition(condition: SafetyCondition) {
		selectOnSwitch(this.#condition, condition)
		this.bus.notify(this.#condition)
		this.#publishStatus(CONDITION_STATES[condition], true)
	}

	// Rebuilds the status from the persisted condition.
	loaded() {
		this.#publishStatus(CONDITION_STATES[this.condition], true)
	}

	// Handles SIMULATOR_SAFETY.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#condition.name) return false
		const condition = CONDITIONS.find((e) => vector.elements[e] === true)
		if (condition !== undefined) this.setCondition(condition)
		return true
	}

	// Writes `state` into the status, publishing it when it changed and `notify`.
	#publishStatus(state: PropertyState, notify: boolean) {
		const element = this.#status.elements.SAFETY
		if (this.#status.state === state && element.value === state) return
		this.#status.state = state
		element.value = state
		if (notify) this.bus.notify(this.#status)
	}
}
