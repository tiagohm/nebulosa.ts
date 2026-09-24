import { geometricMeanOf } from '../math/numerical/statistics'
import { dewRiskFromMargin } from './formulas'

// Driver-independent observing quality of a weather reading. Each supplied sensor contributes a
// factor on 0..1, and the score is their geometric mean. A sensor that is omitted is not punished
// and is not invented. Any positive rainfall returns zero on its own. The ramps are planning
// thresholds for imaging, not a forecast.

// Humidity at and below which the humidity factor stays 1, in percent.
const CLEAR_HUMIDITY_PERCENT = 70
// Humidity at and above which the humidity factor is 0, in percent.
const SATURATED_HUMIDITY_PERCENT = 100
// Wind speed at and below which the wind factor stays 1, in meters per second.
const CALM_WIND_METERS_PER_SECOND = 5
// Wind speed at and above which the wind factor is 0, in meters per second.
const LIMITING_WIND_METERS_PER_SECOND = 15

// Weather sensors that have already been read. Units are stated on each field.
export interface WeatherQualityInput {
	// Cloud cover in percent, 0 for clear and 100 for overcast.
	readonly cloudCoverPercent?: number
	// Relative humidity in percent.
	readonly humidityPercent?: number
	// Sustained wind speed in meters per second.
	readonly windSpeedMetersPerSecond?: number
	// Wind gust in meters per second. Scored together with the sustained wind by keeping the faster one.
	readonly windGustMetersPerSecond?: number
	// Ambient temperature minus dew point, in degrees Celsius.
	readonly dewMarginCelsius?: number
	// Rainfall rate in millimeters per hour. Any positive rate scores zero.
	readonly rainRateMillimetersPerHour?: number
}

// Observing quality of one weather reading, on 0..1.
// Parameters: input holds whichever sensors are available. Cloud cover falls linearly from 1 at a
// clear sky to 0 at 100%. Humidity stays 1 through 70% and reaches 0 at 100%. Wind, using the greater
// of the sustained speed and the gust, stays 1 through 5 m/s and reaches 0 at 15 m/s. The dew margin
// uses dewRiskFromMargin, so 5 °C of margin is no risk and a zero margin is full risk. A positive
// rain rate returns 0. With no sensors at all the score is 1, because there is nothing to penalize.
export function weatherQualityScore(input: WeatherQualityInput): number {
	if (input.rainRateMillimetersPerHour !== undefined && input.rainRateMillimetersPerHour > 0) return 0

	const factors: number[] = []

	if (input.cloudCoverPercent !== undefined) factors.push(Math.min(1, Math.max(0, 1 - input.cloudCoverPercent / 100)))
	if (input.humidityPercent !== undefined) factors.push(input.humidityPercent <= CLEAR_HUMIDITY_PERCENT ? 1 : input.humidityPercent >= SATURATED_HUMIDITY_PERCENT ? 0 : (SATURATED_HUMIDITY_PERCENT - input.humidityPercent) / (SATURATED_HUMIDITY_PERCENT - CLEAR_HUMIDITY_PERCENT))
	if (input.windSpeedMetersPerSecond !== undefined || input.windGustMetersPerSecond !== undefined) {
		const speed = Math.max(input.windSpeedMetersPerSecond ?? 0, input.windGustMetersPerSecond ?? 0)
		factors.push(speed <= CALM_WIND_METERS_PER_SECOND ? 1 : speed >= LIMITING_WIND_METERS_PER_SECOND ? 0 : (LIMITING_WIND_METERS_PER_SECOND - speed) / (LIMITING_WIND_METERS_PER_SECOND - CALM_WIND_METERS_PER_SECOND))
	}
	if (input.dewMarginCelsius !== undefined) factors.push(1 - dewRiskFromMargin(input.dewMarginCelsius))

	return factors.length === 0 ? 1 : geometricMeanOf(factors)
}
