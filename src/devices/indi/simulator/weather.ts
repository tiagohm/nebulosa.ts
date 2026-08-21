import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType } from '../device'
import { makeLightVector, makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState } from '../types'
import type { ClientSimulator } from './client'
import { MAIN_CONTROL, SIMULATION, WEATHER_DEFAULT_UPDATE_PERIOD, WEATHER_MAX_UPDATE_PERIOD, WEATHER_MIN_UPDATE_PERIOD } from './constants'
import { DeviceSimulator } from './device'
import type { DeviceSimulatorOptions, SimulatorProperty } from './types'
import { applyNumberVectorValues } from './util'

// Deterministic INDI weather-station simulation: the public WEATHER_PARAMETERS readings are a copy of a
// simulator-only control vector, so tests drive every sensor by hand instead of relying on randomness.

// One simulated sensor as a makeNumberVector element tuple: INDI element name, label, initial reading,
// and the advertised min/max/step/format.
//
// The range is only the simulator's own idea of a plausible reading. It is neither an ASCOM limit nor an
// INDI alarm threshold, and WeatherManager deliberately never reads it. Wind direction is degrees here,
// as INDI publishes it; the manager converts it to radians.
//
// The initial readings are mutually consistent: 16.8 °C at 52 % RH gives a dew point of 6.9 °C by the
// Magnus relation, which is what the Alpaca server would derive if only one of the two were present.
const WEATHER_SIMULATOR_SENSORS: readonly [name: string, label: string, value: number, min: number, max: number, step: number, format: string][] = [
	['WEATHER_CLOUD_COVER', 'Cloud cover (%)', 15, 0, 100, 0.1, '%.1f'],
	['WEATHER_DEW_POINT', 'Dew point (C)', 6.9, -60, 60, 0.1, '%.1f'],
	['WEATHER_HUMIDITY', 'Humidity (%)', 52, 0, 100, 0.1, '%.1f'],
	['WEATHER_PRESSURE', 'Pressure (hPa)', 1013.2, 0, 2000, 0.1, '%.1f'],
	['WEATHER_RAIN_HOUR', 'Rain (mm/h)', 0, 0, 500, 0.1, '%.1f'],
	['WEATHER_SKY_BRIGHTNESS', 'Sky brightness (lux)', 0.002, 0, 200000, 0.001, '%.3f'],
	['WEATHER_SKY_QUALITY', 'Sky quality (mag/arcsec2)', 21.3, 0, 25, 0.01, '%.2f'],
	['WEATHER_SKY_TEMPERATURE', 'Sky temperature (C)', -22.4, -100, 60, 0.1, '%.1f'],
	['WEATHER_STAR_FWHM', 'Star FWHM (arcsec)', 2.4, 0, 60, 0.01, '%.2f'],
	['WEATHER_TEMPERATURE', 'Temperature (C)', 16.8, -60, 60, 0.1, '%.1f'],
	['WEATHER_WIND_DIRECTION', 'Wind direction (deg)', 135, 0, 360, 0.1, '%.1f'],
	['WEATHER_WIND_GUST', 'Wind gust (m/s)', 4.2, 0, 100, 0.1, '%.1f'],
	['WEATHER_WIND_SPEED', 'Wind speed (m/s)', 2.6, 0, 100, 0.1, '%.1f'],
]

// Builds the per-sensor light tuples for WEATHER_STATUS, all reported Ok.
function weatherStatusLights(): readonly [name: string, label: string, state: PropertyState][] {
	return WEATHER_SIMULATOR_SENSORS.map((e) => [e[0], e[1], 'Ok'])
}

// Simulates an INDI Weather driver. WEATHER_PARAMETERS is read-only, as a real driver publishes it, and
// mirrors the writable simulator-only SIMULATOR_WEATHER vector: writing a control propagates immediately,
// while WEATHER_REFRESH re-emits the parameters unchanged, which is the path that exercises a refresh
// that moves no value.
export class WeatherSimulator extends DeviceSimulator {
	readonly type = 'weather'

	// Public read-only readings, as an INDI Weather driver publishes them.
	readonly #parameters = makeNumberVector('', 'WEATHER_PARAMETERS', 'Parameters', MAIN_CONTROL, 'ro', ...WEATHER_SIMULATOR_SENSORS)
	// Driver re-read period. Stored and reported only: the simulator schedules no timer from it, so it
	// cannot leak between tests.
	readonly #update = makeNumberVector('', 'WEATHER_UPDATE', 'Update', MAIN_CONTROL, 'rw', ['PERIOD', 'Period (s)', WEATHER_DEFAULT_UPDATE_PERIOD, WEATHER_MIN_UPDATE_PERIOD, WEATHER_MAX_UPDATE_PERIOD, 1, '%.0f'])
	// Momentary refresh command.
	readonly #refresh = makeSwitchVector('', 'WEATHER_REFRESH', 'Refresh', MAIN_CONTROL, 'AtMostOne', 'rw', ['REFRESH', 'Refresh', false])
	// Per-parameter INDI status lights. The simulator declares no alarm thresholds, so every light stays
	// Ok; the vector exists so consumers can prove it is not mistaken for SAFETY_STATUS.
	readonly #status = makeLightVector('', 'WEATHER_STATUS', 'Status', MAIN_CONTROL, ...weatherStatusLights())
	// Simulator-only source of every reading, so tests set each sensor deterministically.
	readonly #simulator = makeNumberVector('', 'SIMULATOR_WEATHER', 'Weather', SIMULATION, 'rw', ...WEATHER_SIMULATOR_SENSORS)

	protected readonly properties: readonly SimulatorProperty[] = [this.#parameters, this.#update, this.#refresh, this.#status, this.#simulator]
	// The public readings and the status lights are derived from the simulator controls.
	protected readonly propertiesToNotSave: readonly SimulatorProperty[] = [this.#parameters, this.#status]

	// Creates a weather simulator advertising the INDI WEATHER interface bit.
	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.WEATHER)

		for (const property of this.properties) property.device = name
		this.driverInfo.elements.DRIVER_EXEC.value = 'weather.simulator'
	}

	// Drops every emission while the device is disconnected.
	//
	// disconnect() deletes the simulated properties, but setParameter, refresh and the writable controls
	// stay callable, and a weather consumer applies a set vector whether or not it ever saw the matching
	// definition: WeatherManager would repopulate every typed sensor, and restart its freshness, for a
	// station reporting itself disconnected, on properties that no longer exist. The controls keep
	// accepting values, so the next connect defines the vectors carrying the current readings.
	protected notify(message: SimulatorProperty) {
		if (this.isConnected) super.notify(message)
	}

	// Copies the simulator controls into the public readings and notifies. `force` re-emits the vector
	// even when no value changed, which is what a refresh does.
	#publish(force: boolean) {
		let updated = false

		for (const key in this.#simulator.elements) {
			const source = this.#simulator.elements[key]
			const target = this.#parameters.elements[key]

			if (target.value !== source.value) {
				target.value = source.value
				updated = true
			}
		}

		if (updated || force) {
			this.#parameters.state = 'Ok'
			this.notify(this.#parameters)
		}

		return updated
	}

	// Sets one sensor by its INDI element name (for example WEATHER_TEMPERATURE) and publishes it.
	// Unknown names and non-finite values are ignored. Values are clamped to the advertised range.
	setParameter(name: string, value: number) {
		if (!(name in this.#simulator.elements)) return false
		if (!applyNumberVectorValues(this.#simulator, { [name]: value })) return false
		this.notify(this.#simulator)
		this.#publish(false)
		return true
	}

	// Re-publishes the current readings, as a driver does when asked to re-read its hardware.
	refresh() {
		this.#publish(true)
	}

	// Handles the writable number commands: the simulator controls and the driver update period.
	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'SIMULATOR_WEATHER':
				if (applyNumberVectorValues(this.#simulator, vector.elements)) {
					this.notify(this.#simulator)
					this.#publish(false)
				}

				return
			case 'WEATHER_UPDATE':
				if (applyNumberVectorValues(this.#update, vector.elements)) this.notify(this.#update)
		}
	}

	// Handles connection and the momentary refresh switch, preserving the base CONFIG behavior.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'WEATHER_REFRESH':
				if (vector.elements.REFRESH === true) {
					this.refresh()

					// Momentary: the switch always settles back to Off.
					this.#refresh.elements.REFRESH.value = false
					this.#refresh.state = 'Ok'
					this.notify(this.#refresh)
				}
		}
	}

	// Rebuilds the public readings from the restored simulator controls.
	protected onPropertiesLoaded() {
		this.#publish(false)
	}

	// Disconnects and removes all simulator properties and client registration.
	dispose() {
		this.disconnect()
		super.dispose()
	}
}
