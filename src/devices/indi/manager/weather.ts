import type { Writable } from '../../../core/types'
import { deg, normalizeAngle } from '../../../math/units/angle'
import { CLIENT, type Client, DEFAULT_MIN_MAX_VALUE_PROPERTY, DEFAULT_WEATHER, type Device, DeviceInterfaceType, type Thermometer, type Weather, type WeatherSensor } from '../device'
import type { DefNumber, DefNumberVector, DefSwitchVector, DefTextVector, DelProperty, OneNumber, PropertyState, SetNumberVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indiweatherinterface.cpp

// One ObservingConditions sensor with its canonical name in each backend. `indi` is the element name the
// Alpaca client emits inside WEATHER_PARAMETERS; `aliases` are extra element names accepted when reading,
// because the INDI Weather interface does not standardize parameter names - every driver declares its own
// through addParameter(). `degrees` marks a value that arrives in degrees and is stored as radians.
export interface WeatherSensorMapping {
	readonly field: WeatherSensor
	readonly ascom: string
	readonly indi: string
	readonly aliases: readonly string[]
	readonly degrees: boolean
	// Neutral presentation range and format used when a vector has to be synthesized for this sensor,
	// as the Alpaca client does. These are the physically plausible bounds of the quantity, never alarm
	// thresholds, and WeatherManager never reads them back.
	readonly min: number
	readonly max: number
	readonly step: number
	readonly format: string
}

// The thirteen ObservingConditions sensors, shared by WeatherManager, the Alpaca client and the Alpaca
// server so the three name mappings cannot drift apart. Aliases cover the widespread drivers
// (OpenWeatherMap, weatherradio, AAG CloudWatcher, Weather Meta). WEATHER_RAIN_HOUR is precipitation over
// the last hour, which is numerically mm/h and is therefore published as RainRate.
export const WEATHER_SENSORS: readonly WeatherSensorMapping[] = [
	{ field: 'cloudCover', ascom: 'CloudCover', indi: 'WEATHER_CLOUD_COVER', aliases: ['WEATHER_CLOUD'], degrees: false, min: 0, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'dewPoint', ascom: 'DewPoint', indi: 'WEATHER_DEW_POINT', aliases: ['WEATHER_DEWPOINT'], degrees: false, min: -100, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'humidity', ascom: 'Humidity', indi: 'WEATHER_HUMIDITY', aliases: ['WEATHER_RELATIVE_HUMIDITY'], degrees: false, min: 0, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'pressure', ascom: 'Pressure', indi: 'WEATHER_PRESSURE', aliases: ['WEATHER_BAROMETER'], degrees: false, min: 0, max: 2000, step: 0.1, format: '%.1f' },
	{ field: 'rainRate', ascom: 'RainRate', indi: 'WEATHER_RAIN_HOUR', aliases: ['WEATHER_RAIN_RATE', 'WEATHER_RAIN'], degrees: false, min: 0, max: 1000, step: 0.1, format: '%.1f' },
	{ field: 'skyBrightness', ascom: 'SkyBrightness', indi: 'WEATHER_SKY_BRIGHTNESS', aliases: ['WEATHER_BRIGHTNESS'], degrees: false, min: 0, max: 200000, step: 0.001, format: '%.3f' },
	{ field: 'skyQuality', ascom: 'SkyQuality', indi: 'WEATHER_SKY_QUALITY', aliases: ['WEATHER_SQM'], degrees: false, min: 0, max: 30, step: 0.01, format: '%.2f' },
	{ field: 'skyTemperature', ascom: 'SkyTemperature', indi: 'WEATHER_SKY_TEMPERATURE', aliases: ['WEATHER_IR_SKY_TEMPERATURE'], degrees: false, min: -300, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'starFWHM', ascom: 'StarFWHM', indi: 'WEATHER_STAR_FWHM', aliases: ['WEATHER_SEEING'], degrees: false, min: 0, max: 100, step: 0.01, format: '%.2f' },
	{ field: 'temperature', ascom: 'Temperature', indi: 'WEATHER_TEMPERATURE', aliases: [], degrees: false, min: -100, max: 100, step: 0.1, format: '%.1f' },
	{ field: 'windDirection', ascom: 'WindDirection', indi: 'WEATHER_WIND_DIRECTION', aliases: [], degrees: true, min: 0, max: 360, step: 0.1, format: '%.1f' },
	{ field: 'windGust', ascom: 'WindGust', indi: 'WEATHER_WIND_GUST', aliases: [], degrees: false, min: 0, max: 200, step: 0.1, format: '%.1f' },
	{ field: 'windSpeed', ascom: 'WindSpeed', indi: 'WEATHER_WIND_SPEED', aliases: [], degrees: false, min: 0, max: 200, step: 0.1, format: '%.1f' },
]

// Lookup by INDI element name (preferred name and every alias), built once so parsing a vector never
// scans the table.
const WEATHER_SENSORS_BY_INDI_NAME = new Map<string, WeatherSensorMapping>()

for (const sensor of WEATHER_SENSORS) {
	WEATHER_SENSORS_BY_INDI_NAME.set(sensor.indi, sensor)
	for (const alias of sensor.aliases) WEATHER_SENSORS_BY_INDI_NAME.set(alias, sensor)
}

// Freshness bookkeeping for one device, on the two clocks it needs.
//
// `at` is the epoch millisecond of the last report of each sensor, which is what a wall-clock timestamp
// such as Alpaca's DeviceState.TimeStamp has to carry. Zero means never reported, which is unambiguous
// because the Unix epoch cannot be a real observation time.
//
// `elapsed` is the performance.now() millisecond of the same report, and every age is measured from it:
// a system clock corrected backward would otherwise make a sensor look updated in the future, and a
// forward correction would make a fresh one look arbitrarily stale. It is only meaningful where the
// matching `at` is non-zero, because performance.now() may legitimately read 0 in the first millisecond
// of the process.
//
// Every key of both records is present so the objects keep a stable shape.
interface WeatherUpdatedAt {
	readonly at: Record<WeatherSensor, number>
	readonly elapsed: Record<WeatherSensor, number>
}

// Manager for weather stations (INDI Weather interface / ASCOM ObservingConditions). Reflects
// WEATHER_PARAMETERS onto the typed sensor fields, tracks per-sensor freshness, and drives the driver's
// update period, average period and refresh controls. Ambient temperature also feeds the Thermometer
// capability. Angles are radians; see Weather for the remaining units.
export class WeatherManager extends DeviceManager<Weather> {
	// Per-device freshness stamps. A WeakMap keeps them out of the device object, which is serialized.
	readonly #updatedAt = new WeakMap<Weather, WeatherUpdatedAt>()

	// Epoch milliseconds of the last report of `sensor`, or undefined when it was never reported. A
	// repeated identical reading still advances this, unlike the `updated` event. Use elapsedSince for a
	// duration: this stamp is wall-clock and moves with the system clock.
	updatedAt(device: Weather, sensor: WeatherSensor) {
		const at = this.#updatedAt.get(device)?.at[sensor]
		return at ? at : undefined
	}

	// Epoch milliseconds of the most recent report of any sensor, or undefined when none was reported.
	//
	// Which report is the most recent is decided on the monotonic clock and only its wall-clock stamp is
	// returned: after the system clock is corrected backward, a sensor reported before the correction
	// carries the numerically larger epoch, and picking that one would answer an instant older than the
	// reading that just arrived - possibly one still in the future.
	lastUpdatedAt(device: Weather) {
		const stamps = this.#updatedAt.get(device)

		if (stamps === undefined) return undefined

		let last: number | undefined
		let at: number | undefined

		for (const sensor of WEATHER_SENSORS) {
			const { field } = sensor
			const elapsed = stamps.elapsed[field]

			if (stamps.at[field] && (last === undefined || elapsed > last)) {
				last = elapsed
				at = stamps.at[field]
			}
		}

		return at
	}

	// Milliseconds since the last report of `sensor`, or undefined when it was never reported. Measured
	// on the monotonic clock, so a system clock adjustment cannot make the age negative or stale.
	elapsedSince(device: Weather, sensor: WeatherSensor) {
		const stamps = this.#updatedAt.get(device)

		if (stamps === undefined || !stamps.at[sensor]) return undefined

		return performance.now() - stamps.elapsed[sensor]
	}

	// Milliseconds since the most recent report of any sensor, or undefined when none was reported. Also
	// monotonic; see elapsedSince.
	lastElapsedSince(device: Weather) {
		const stamps = this.#updatedAt.get(device)

		if (stamps === undefined) return undefined

		// A zero `at` marks a sensor that was never reported, and only those are skipped: a real
		// performance.now() stamp can be 0 and still be a genuine reading.
		let last: number | undefined

		for (const sensor of WEATHER_SENSORS) {
			const { field } = sensor
			const elapsed = stamps.elapsed[field]
			if (stamps.at[field] && (last === undefined || elapsed > last)) last = elapsed
		}

		return last === undefined ? undefined : performance.now() - last
	}

	// Sets the driver's hardware re-read period, in seconds. Returns false when the driver has no
	// writable WEATHER_UPDATE. The value is sent as-is; the driver enforces its own range.
	setUpdatePeriod(device: Weather, period: number, client = device[CLIENT]!) {
		if (!this.hasWritableProperty(device, 'WEATHER_UPDATE')) return false
		client.sendNumber({ device: device.name, name: 'WEATHER_UPDATE', elements: { PERIOD: period } })
		return true
	}

	// Sets the averaging window, in hours; 0 means an instantaneous reading. Returns false when the
	// backend cannot configure averaging (no writable WEATHER_AVERAGE_PERIOD).
	setAveragePeriod(device: Weather, hours: number, client = device[CLIENT]!) {
		if (!this.hasWritableProperty(device, 'WEATHER_AVERAGE_PERIOD')) return false
		client.sendNumber({ device: device.name, name: 'WEATHER_AVERAGE_PERIOD', elements: { AVERAGE_PERIOD: hours } })
		return true
	}

	// Triggers an immediate re-read. Returns false when the driver offers no explicit refresh, which the
	// Alpaca server maps to MethodOrPropertyNotImplemented.
	refresh(device: Weather, client = device[CLIENT]!) {
		if (!this.hasWritableProperty(device, 'WEATHER_REFRESH')) return false
		client.sendSwitch({ device: device.name, name: 'WEATHER_REFRESH', elements: { REFRESH: true } })
		return true
	}

	// Returns the device's freshness stamps, creating them on first use.
	#stamps(device: Weather) {
		let stamps = this.#updatedAt.get(device)

		if (stamps === undefined) {
			stamps = { at: {}, elapsed: {} } as WeatherUpdatedAt
			for (const sensor of WEATHER_SENSORS) stamps.at[sensor.field] = stamps.elapsed[sensor.field] = 0
			this.#updatedAt.set(device, stamps)
		}

		return stamps
	}

	// Applies one sensor reading. Notifies only on a real change, but refreshes the freshness stamp on
	// every report, so TimeSinceLastUpdate advances even when the driver repeats a value. `stamps` is
	// undefined for a report that is not an observation, which applies the value without dating it.
	//
	// Deliberately does not use handleMinMaxValue: the min/max of a WEATHER_PARAMETERS element are the
	// driver's alarm thresholds from addParameter(name, label, min, max, percentWarning), not a display
	// range, and clamping to them would truncate exactly the out-of-range reading that matters.
	#handleSensor(device: Weather, mapping: WeatherSensorMapping, element: DefNumber | OneNumber | undefined, state: PropertyState | undefined, stamps: WeatherUpdatedAt | undefined, now: number, elapsed: number) {
		if (element === undefined) return

		const { field } = mapping

		if (field === 'temperature' && handleSwitchValue<Device & Thermometer>(device, 'hasThermometer', true)) {
			this.updated(device, 'hasThermometer', state)
		}

		if (handleWeatherNumber(device, field, mapping.degrees ? weatherAngle(element.value) : element.value, state)) {
			this.updated(device, field, state)
		}

		if (stamps !== undefined) {
			stamps.at[field] = now
			stamps.elapsed[field] = elapsed
		}
	}

	// Applies every mapped element of a WEATHER_PARAMETERS vector. Unmapped elements stay reachable
	// through the raw property view but never reach the typed interface.
	//
	// `definition` marks a defNumberVector. A definition published Busy carries the driver's declared
	// defaults rather than a reading: the Firmata adapter defines every measurement Busy with zero
	// placeholders and settles it to Idle on the first hardware sample. Storing those would announce
	// 0 °C, 0 % and 0 hPa as freshly observed and start TimeSinceLastUpdate on values no sensor ever
	// produced, so a Busy definition declares the property and nothing else.
	#handleParameters(device: Weather, message: DefNumberVector | SetNumberVector, definition: boolean) {
		const { elements } = message

		// A definition replaces the whole element set, as the raw property manager does with the vector
		// itself, so a sensor the driver no longer declares has to leave the typed view as well. Without
		// this the field and its freshness stamp would survive indefinitely and advertise a parameter the
		// current definition does not provide. A set vector is a partial update and never removes
		// anything: drivers legitimately report a subset of their parameters.
		if (definition) {
			const declared = new Set<WeatherSensor>()

			for (const key in elements) {
				const mapping = WEATHER_SENSORS_BY_INDI_NAME.get(key)
				if (mapping !== undefined) declared.add(mapping.field)
			}

			for (const sensor of WEATHER_SENSORS) {
				if (!declared.has(sensor.field)) this.#resetSensor(device, sensor.field)
			}

			if (message.state === 'Busy') return
		}

		// An Alert vector is the driver reporting that its hardware read failed. The INDI Weather
		// interface applies WEATHER_PARAMETERS unchanged in that case and retries every five seconds, so
		// its elements are the previous readings restated rather than new observations - the alarm status
		// of a reading lives in WEATHER_STATUS, not in this state. The values are still applied, because a
		// driver that sampled part of them before failing did observe those, but their freshness must not
		// advance: a station whose sensor died would otherwise keep reporting a near-zero
		// TimeSinceLastUpdate for the whole outage and hide it from every safety check.
		const stamps = message.state === 'Alert' ? undefined : this.#stamps(device)
		// Both clocks are read once per vector: the wall-clock stamp is what a timestamp reports, the
		// monotonic one is what every age is measured from.
		const now = Date.now()
		const elapsed = performance.now()

		for (const key in elements) {
			const mapping = WEATHER_SENSORS_BY_INDI_NAME.get(key)
			if (mapping !== undefined) this.#handleSensor(device, mapping, elements[key], message.state, stamps, now, elapsed)
		}
	}

	// Clears one sensor back to "not reported" and forgets its freshness.
	#resetSensor(device: Weather, field: WeatherSensor) {
		if (field === 'temperature') {
			resetDeviceValue(this, device, 'hasThermometer', DEFAULT_WEATHER.hasThermometer)
			resetDeviceValue(this, device, 'temperature', DEFAULT_WEATHER.temperature)
		} else {
			resetDeviceValue(this, device, field, undefined)
		}

		const stamps = this.#updatedAt.get(device)

		if (stamps !== undefined) {
			stamps.at[field] = 0
			stamps.elapsed[field] = 0
		}
	}

	// Creates/updates the weather device from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.WEATHER)
		}
	}

	// Tracks writability of the refresh control on top of the common CONNECTION handling.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		if (tag[0] === 'd') {
			if ((message as DefSwitchVector).permission !== 'ro') this.addWritableProperty(device, message.name)
			else this.removeWritableProperty(device, message.name)
		}
	}

	// Applies the weather number vectors: the sensor parameters, the driver update period, the averaging
	// window.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const definition = tag[0] === 'd' ? (message as DefNumberVector) : undefined

		if (definition) {
			if (definition.permission !== 'ro') this.addWritableProperty(device, message.name)
			else this.removeWritableProperty(device, message.name)
		}

		switch (message.name) {
			case 'WEATHER_PARAMETERS':
				this.#handleParameters(device, message, definition !== undefined)
				return
			case 'WEATHER_UPDATE': {
				// The property is absent until the driver defines it, so `updatePeriod` doubles as the
				// "driver has an update period" flag and is created on first sight.
				const updatePeriod = device.updatePeriod ?? structuredClone(DEFAULT_MIN_MAX_VALUE_PROPERTY)

				if (handleMinMaxValue(updatePeriod, message.elements.PERIOD, tag) || device.updatePeriod === undefined) {
					;(device as Writable<Weather>).updatePeriod = updatePeriod
					this.updated(device, 'updatePeriod', message.state)
				}

				return
			}
			case 'WEATHER_AVERAGE_PERIOD': {
				const hours = message.elements.AVERAGE_PERIOD?.value

				if (hours !== undefined && handleWeatherNumber(device, 'averagePeriod', hours, message.state)) {
					this.updated(device, 'averagePeriod', message.state)
				}
			}
		}
	}

	// Resets the fields backed by a deleted property. The device itself survives a named deletion: it is
	// identified by DRIVER_INTERFACE, not by its properties. Only an unnamed delProperty removes it.
	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full) this.clearWritableProperty(device)
		else this.removeWritableProperty(device, name)

		if (full || name === 'WEATHER_PARAMETERS') {
			for (const sensor of WEATHER_SENSORS) this.#resetSensor(device, sensor.field)
		}

		if (full || name === 'WEATHER_UPDATE') resetDeviceValue(this, device, 'updatePeriod', DEFAULT_WEATHER.updatePeriod)
		if (full || name === 'WEATHER_AVERAGE_PERIOD') resetDeviceValue(this, device, 'averagePeriod', DEFAULT_WEATHER.averagePeriod)

		super.delProperty(client, message)
	}
}

// Converts an INDI wind direction from degrees to radians normalized to [0, TAU).
function weatherAngle(value: number) {
	return normalizeAngle(deg(value))
}

// Assigns an optional numeric weather field when the reading differs, returning whether the caller
// should notify (also true on Alert, so error states are re-emitted without a value change).
//
// handleNumberValue cannot be used here: PickByValue keeps a key only when `T[K] extends number`, and an
// optional sensor is typed `number | undefined`, so every sensor except the mandatory `temperature` is
// filtered out of its property parameter.
function handleWeatherNumber(device: Weather, field: WeatherSensor | 'averagePeriod', value: number, state?: PropertyState) {
	if (device[field] !== value) {
		device[field] = value
		return true
	}

	return state === 'Alert'
}
