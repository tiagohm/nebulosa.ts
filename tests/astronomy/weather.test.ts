import { expect, test } from 'bun:test'
import { weatherQualityScore } from '../../src/astronomy/weather'

test('weather score is one for calm clear air, zero in rain, and falls as a sensor worsens', () => {
	expect(weatherQualityScore({})).toBe(1)
	expect(weatherQualityScore({ cloudCoverPercent: 0, humidityPercent: 40, windSpeedMetersPerSecond: 2, dewMarginCelsius: 8 })).toBeCloseTo(1, 12)
	expect(weatherQualityScore({ rainRateMillimetersPerHour: 0.2, cloudCoverPercent: 0 })).toBe(0)
	expect(weatherQualityScore({ cloudCoverPercent: 100 })).toBe(0)
	expect(weatherQualityScore({ humidityPercent: 100 })).toBe(0)
	expect(weatherQualityScore({ windGustMetersPerSecond: 20 })).toBe(0)
	expect(weatherQualityScore({ dewMarginCelsius: 0 })).toBe(0)
	expect(weatherQualityScore({ cloudCoverPercent: 50 })).toBeCloseTo(0.5, 12)
	expect(weatherQualityScore({ windSpeedMetersPerSecond: 10 })).toBeCloseTo(0.5, 12)
})
