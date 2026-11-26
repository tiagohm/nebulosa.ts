import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { BoardSimulator, type BoardSimulatorOptions } from './board'
import type { ClientSimulator } from './client'
import { WeatherAlarms } from './weather.alarms'
import { type WeatherSimulatorConfig, type WeatherSimulatorConfigOverride, weatherSimulatorConfig } from './weather.config'
import { WeatherSensors } from './weather.sensors'

// Simulated INDI weather station: a board with the sensors and the status lights of the critical ones.
// The readings are deterministic: tests set every sensor by hand through SIMULATOR_WEATHER.

// Options of a simulated weather station.
export interface WeatherSimulatorOptions extends BoardSimulatorOptions {
	// Override of DEFAULT_WEATHER_SIMULATOR_CONFIG.
	readonly config?: WeatherSimulatorConfigOverride
}

// Simulated INDI weather driver whose read-only WEATHER_PARAMETERS mirror the writable simulator-only
// SIMULATOR_WEATHER, re-read every update period and judged against the safe ranges of the critical
// sensors in WEATHER_STATUS. It never defines SAFETY_STATUS.
export class WeatherSimulator extends BoardSimulator {
	readonly type = 'weather'

	// Configuration the station was built with.
	readonly configuration: WeatherSimulatorConfig

	readonly #sensors: WeatherSensors

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: WeatherSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.WEATHER, 'weather.simulator', options?.now)
		this.configuration = weatherSimulatorConfig(options?.config)
		const alarms = new WeatherAlarms(this.bus, this.configuration)
		this.#sensors = new WeatherSensors(this.bus, this.configuration, alarms)
		this.install(this.#sensors, alarms)
	}

	// Sets one sensor by its INDI element name (for example WEATHER_TEMPERATURE) and publishes it.
	setParameter(name: string, value: number) {
		return this.#sensors.setParameter(name, value)
	}

	// Re-publishes the current readings, as a driver does when asked to re-read its hardware.
	refresh() {
		this.#sensors.refresh()
	}
}
