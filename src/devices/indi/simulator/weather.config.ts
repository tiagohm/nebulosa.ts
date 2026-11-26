import type { DeepPartial } from '../../../core/types'
import { mergeConfig } from './component'

// Configuration of the simulated weather station. A simulator is built from
// DEFAULT_WEATHER_SIMULATOR_CONFIG merged with the partial override its options carry; the defaults are
// never mutated. Readings are in the units INDI publishes: %, °C, hPa, mm/h, lux, mag/arcsec², arcsec,
// degrees and m/s.

// INDI element names of the simulated sensors, in publication order.
export const WEATHER_SENSORS = [
	'WEATHER_CLOUD_COVER',
	'WEATHER_DEW_POINT',
	'WEATHER_HUMIDITY',
	'WEATHER_PRESSURE',
	'WEATHER_RAIN_HOUR',
	'WEATHER_SKY_BRIGHTNESS',
	'WEATHER_SKY_QUALITY',
	'WEATHER_SKY_TEMPERATURE',
	'WEATHER_STAR_FWHM',
	'WEATHER_TEMPERATURE',
	'WEATHER_WIND_DIRECTION',
	'WEATHER_WIND_GUST',
	'WEATHER_WIND_SPEED',
] as const

// INDI element name of a simulated sensor.
export type WeatherSensor = (typeof WEATHER_SENSORS)[number]

// Safe range of a watched sensor, as a driver declares it for a critical parameter. A reading outside
// [minimum, maximum] is an alarm (Alert), one closer than `margin` to a declared limit a warning (Busy),
// anything else Ok. An absent limit is not watched.
export interface WeatherThreshold {
	readonly minimum?: number
	readonly maximum?: number
	// Distance to a limit within which a reading warns, in the sensor's unit, non-negative.
	readonly margin: number
}

// Full configuration of a simulated weather station.
export interface WeatherSimulatorConfig {
	// Reading of every sensor at power-up.
	readonly readings: Readonly<Record<WeatherSensor, number>>
	// Safe ranges of the critical sensors, the ones WEATHER_STATUS reports on.
	readonly thresholds: Readonly<Partial<Record<WeatherSensor, WeatherThreshold>>>
	// Period the driver re-reads its sensors at, seconds, within [minimumUpdatePeriod, maximumUpdatePeriod].
	readonly updatePeriod: number
	readonly minimumUpdatePeriod: number
	readonly maximumUpdatePeriod: number
}

// Partial override of a weather-station configuration, merged key by key into the defaults.
export type WeatherSimulatorConfigOverride = DeepPartial<WeatherSimulatorConfig>

// Defaults of every simulated weather station: a clear, calm, dry night. The readings are mutually
// consistent: 16.8 °C at 52 % RH gives a dew point of 6.9 °C by the Magnus relation, which is what the
// Alpaca server would derive if only one of the two were present. Clouds, humidity, rain and wind are
// watched with the limits an observatory typically closes at.
export const DEFAULT_WEATHER_SIMULATOR_CONFIG: WeatherSimulatorConfig = {
	readings: {
		WEATHER_CLOUD_COVER: 15,
		WEATHER_DEW_POINT: 6.9,
		WEATHER_HUMIDITY: 52,
		WEATHER_PRESSURE: 1013.2,
		WEATHER_RAIN_HOUR: 0,
		WEATHER_SKY_BRIGHTNESS: 0.002,
		WEATHER_SKY_QUALITY: 21.3,
		WEATHER_SKY_TEMPERATURE: -22.4,
		WEATHER_STAR_FWHM: 2.4,
		WEATHER_TEMPERATURE: 16.8,
		WEATHER_WIND_DIRECTION: 135,
		WEATHER_WIND_GUST: 4.2,
		WEATHER_WIND_SPEED: 2.6,
	},
	thresholds: {
		WEATHER_CLOUD_COVER: { maximum: 30, margin: 10 },
		WEATHER_HUMIDITY: { maximum: 90, margin: 5 },
		WEATHER_RAIN_HOUR: { maximum: 0, margin: 0 },
		WEATHER_WIND_GUST: { maximum: 15, margin: 3 },
		WEATHER_WIND_SPEED: { maximum: 10, margin: 2 },
	},
	updatePeriod: 60,
	minimumUpdatePeriod: 1,
	maximumUpdatePeriod: 3600,
}

// Builds the configuration of a weather station from the defaults and an optional override.
export function weatherSimulatorConfig(override?: WeatherSimulatorConfigOverride, base: WeatherSimulatorConfig = DEFAULT_WEATHER_SIMULATOR_CONFIG): WeatherSimulatorConfig {
	return mergeConfig(base, override)
}
