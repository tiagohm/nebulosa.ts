import { makeLightVector, type PropertyState } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { WeatherSensor, WeatherSimulatorConfig, WeatherThreshold } from './weather.config'

// Alarms circuit of the simulated weather station: the WEATHER_STATUS light of every critical sensor, Ok,
// Busy for a warning or Alert for an alarm, judged against the safe range the driver declares for it.
// Readings are in the sensors' own units.

// Severity order of the light states, from the calmest.
const SEVERITY: Readonly<Record<PropertyState, number>> = { Idle: 0, Ok: 1, Busy: 2, Alert: 3 }

// Light state of `value` against `threshold`: Alert outside the range, Busy closer than the margin to a
// declared limit, Ok otherwise.
export function weatherThresholdState(value: number, threshold: WeatherThreshold): PropertyState {
	const { minimum, maximum, margin } = threshold
	if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) return 'Alert'
	if ((minimum !== undefined && value - minimum < margin) || (maximum !== undefined && maximum - value < margin)) return 'Busy'
	return 'Ok'
}

// The status lights of the critical sensors.
export class WeatherAlarms extends SimulatorComponent {
	readonly #status: ReturnType<typeof makeLightVector>
	readonly #thresholds: readonly (readonly [WeatherSensor, WeatherThreshold])[]

	readonly properties: readonly ReturnType<typeof makeLightVector>[]
	// The lights are derived from the readings.
	readonly transient: readonly ReturnType<typeof makeLightVector>[]

	// `config` gives the safe ranges of the critical sensors and their readings at power-up.
	constructor(bus: ComponentBus, config: WeatherSimulatorConfig) {
		super(bus)
		this.#thresholds = Object.entries(config.thresholds).filter((e): e is [WeatherSensor, WeatherThreshold] => e[1] !== undefined)
		this.#status = makeLightVector('', 'WEATHER_STATUS', 'Status', MAIN_CONTROL, ...this.#thresholds.map(([name, threshold]): [string, string, PropertyState] => [name, name, weatherThresholdState(config.readings[name], threshold)]))
		this.properties = [this.#status]
		this.transient = this.properties
	}

	// Judges `readings`, publishing the lights when any changed, and returns the worst state among the
	// critical sensors, Ok when there is none.
	evaluate(readings: Readonly<Record<string, number>>): PropertyState {
		let worst: PropertyState = 'Ok'
		let changed = false

		for (const [name, threshold] of this.#thresholds) {
			const state = weatherThresholdState(readings[name], threshold)
			const light = this.#status.elements[name]
			if (light.value !== state) changed = true
			light.value = state
			if (SEVERITY[state] > SEVERITY[worst]) worst = state
		}

		if (changed || this.#status.state !== worst) {
			this.#status.state = worst
			this.bus.notify(this.#status)
		}

		return worst
	}
}
