import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL, SIMULATION } from './constants'
import { applyNumberVectorValues } from './util'
import type { WeatherAlarms } from './weather.alarms'
import { WEATHER_SENSORS, type WeatherSensor, type WeatherSimulatorConfig } from './weather.config'

// Sensors circuit of the simulated weather station: the public read-only readings, the simulator-only
// control every reading is copied from, so tests set each sensor by hand, the driver's re-read period
// and its momentary refresh. Like a real driver it re-reads its sensors every update period, which
// re-publishes the readings even when none moved. Readings are in the units INDI publishes; times are
// milliseconds on the clock of the bus.

// Label, plausible range, step and format of every sensor. The range is only the simulator's idea of a
// plausible reading, neither an ASCOM limit nor an alarm threshold, and WeatherManager never reads it.
// Wind direction is degrees, as INDI publishes it.
const SENSOR_RANGES: Readonly<Record<WeatherSensor, readonly [label: string, min: number, max: number, step: number, format: string]>> = {
	WEATHER_CLOUD_COVER: ['Cloud cover (%)', 0, 100, 0.1, '%.1f'],
	WEATHER_DEW_POINT: ['Dew point (C)', -60, 60, 0.1, '%.1f'],
	WEATHER_HUMIDITY: ['Humidity (%)', 0, 100, 0.1, '%.1f'],
	WEATHER_PRESSURE: ['Pressure (hPa)', 0, 2000, 0.1, '%.1f'],
	WEATHER_RAIN_HOUR: ['Rain (mm/h)', 0, 500, 0.1, '%.1f'],
	WEATHER_SKY_BRIGHTNESS: ['Sky brightness (lux)', 0, 200000, 0.001, '%.3f'],
	WEATHER_SKY_QUALITY: ['Sky quality (mag/arcsec2)', 0, 25, 0.01, '%.2f'],
	WEATHER_SKY_TEMPERATURE: ['Sky temperature (C)', -100, 60, 0.1, '%.1f'],
	WEATHER_STAR_FWHM: ['Star FWHM (arcsec)', 0, 60, 0.01, '%.2f'],
	WEATHER_TEMPERATURE: ['Temperature (C)', -60, 60, 0.1, '%.1f'],
	WEATHER_WIND_DIRECTION: ['Wind direction (deg)', 0, 360, 0.1, '%.1f'],
	WEATHER_WIND_GUST: ['Wind gust (m/s)', 0, 100, 0.1, '%.1f'],
	WEATHER_WIND_SPEED: ['Wind speed (m/s)', 0, 100, 0.1, '%.1f'],
}

// Element tuples of a vector holding every sensor at its configured reading.
function sensorElements(config: WeatherSimulatorConfig) {
	return WEATHER_SENSORS.map((name): [string, string, number, number, number, number, string] => {
		const [label, min, max, step, format] = SENSOR_RANGES[name]
		return [name, label, config.readings[name], min, max, step, format]
	})
}

// The station's sensors.
export class WeatherSensors extends SimulatorComponent {
	readonly #parameters: ReturnType<typeof makeNumberVector>
	readonly #update: ReturnType<typeof makeNumberVector>
	readonly #refresh = makeSwitchVector('', 'WEATHER_REFRESH', 'Refresh', MAIN_CONTROL, 'AtMostOne', 'rw', ['REFRESH', 'Refresh', false])
	readonly #simulator: ReturnType<typeof makeNumberVector>

	readonly properties: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]
	// The public readings are derived from the simulator control; the refresh is momentary.
	readonly transient: readonly (ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector>)[]

	// Instant the sensors were last read, milliseconds, or undefined before the first tick.
	#readAt?: number

	// `config` gives the readings and the update period at power-up; `alarms` judges every reading.
	constructor(
		bus: ComponentBus,
		config: WeatherSimulatorConfig,
		readonly alarms: WeatherAlarms,
	) {
		super(bus)
		this.#parameters = makeNumberVector('', 'WEATHER_PARAMETERS', 'Parameters', MAIN_CONTROL, 'ro', ...sensorElements(config))
		this.#update = makeNumberVector('', 'WEATHER_UPDATE', 'Update', MAIN_CONTROL, 'rw', ['PERIOD', 'Period (s)', config.updatePeriod, config.minimumUpdatePeriod, config.maximumUpdatePeriod, 1, '%.0f'])
		this.#simulator = makeNumberVector('', 'SIMULATOR_WEATHER', 'Weather', SIMULATION, 'rw', ...sensorElements(config))
		this.properties = [this.#parameters, this.#update, this.#refresh, this.#simulator]
		this.transient = [this.#parameters, this.#refresh]
	}

	// Period the sensors are re-read at, seconds.
	get updatePeriod() {
		return this.#update.elements.PERIOD.value
	}

	// Sets one sensor by its INDI element name and publishes it, returning whether it changed. Unknown
	// names and non-finite values are ignored; values are clamped to the plausible range.
	setParameter(name: string, value: number) {
		if (!(name in this.#simulator.elements)) return false
		if (!applyNumberVectorValues(this.#simulator, { [name]: value })) return false
		this.bus.notify(this.#simulator)
		this.#read(false)
		return true
	}

	// Re-reads the sensors and publishes the readings even when none moved, as a driver asked to re-read
	// its hardware does.
	refresh() {
		this.#read(true)
	}

	// Re-reads the sensors once every update period, at `now`, milliseconds.
	tick(now: number) {
		if (this.#readAt === undefined) {
			this.#readAt = now
		} else if (now - this.#readAt >= this.updatePeriod * 1000) {
			this.#readAt = now
			this.#read(true)
		}
	}

	// Restarts the re-read period when the device disconnects.
	reset() {
		this.#readAt = undefined
	}

	// Rebuilds the public readings from the persisted control.
	loaded() {
		this.#read(false)
	}

	// Handles SIMULATOR_WEATHER and WEATHER_UPDATE.
	handleNumber(vector: NewNumberVector) {
		if (vector.name === this.#simulator.name) {
			if (applyNumberVectorValues(this.#simulator, vector.elements)) {
				this.bus.notify(this.#simulator)
				this.#read(false)
			}

			return true
		}

		if (vector.name === this.#update.name) {
			if (applyNumberVectorValues(this.#update, vector.elements)) this.bus.notify(this.#update)
			return true
		}

		return false
	}

	// Handles WEATHER_REFRESH, which always settles back to Off.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== this.#refresh.name) return false

		if (vector.elements.REFRESH === true) {
			this.refresh()
			this.#refresh.elements.REFRESH.value = false
			this.#refresh.state = 'Ok'
			this.bus.notify(this.#refresh)
		}

		return true
	}

	// Copies the control into the public readings, judges them and publishes them when any moved, or
	// always when `force`. The readings take the worst state of the critical sensors, as a driver
	// publishes them. A forced read restarts the update period.
	#read(force: boolean) {
		let updated = false
		const readings: Record<string, number> = {}

		for (const name of WEATHER_SENSORS) {
			const value = this.#simulator.elements[name].value
			readings[name] = value

			if (this.#parameters.elements[name].value !== value) {
				this.#parameters.elements[name].value = value
				updated = true
			}
		}

		const state = this.alarms.evaluate(readings)
		if (force) this.#readAt = this.bus.now()

		if (updated || force || this.#parameters.state !== state) {
			this.#parameters.state = state
			this.bus.notify(this.#parameters)
		}
	}
}
