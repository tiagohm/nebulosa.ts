import { G, ONE_ATM } from '../../core/constants'
import { type Distance, toMeter } from './distance'
import { type Temperature, toKelvin } from './temperature'

// Pressure type and conversions. The canonical `Pressure` is hPa (millibar); helpers convert to/from
// Pascal and ATM, plus a two-layer (troposphere/stratosphere) barometric altitude-to-pressure model.

// Represents a pressure quantity in (hPa = millibar).
export type Pressure = number

// Creates a new Pressure from Pascal.
export function pascal(value: number): Pressure {
	return value / 100
}

// Creates a new Pressure from ATM.
export function atm(value: number): Pressure {
	return value * ONE_ATM
}

// Converts the pressure to Pascal.
export function toPascal(value: Pressure): number {
	return value * 100
}

// Converts the pressure to ATM.
export function toAtm(value: Pressure): number {
	return value / ONE_ATM
}

// Molar mass of dry air (kg/mol).
const AIR_MOLAR_MASS = 0.0289644
// Universal gas constant (J/(mol·K)).
const GAS_CONSTANT = 8.31432
// Temperature lapse rate in the troposphere (K/m).
const LAPSE_RATE = -0.0065
// Altitude of the tropopause where the lapse-rate model gives way to the isothermal layer (m).
const TROPOPAUSE_ALTITUDE = 11000
// g·M product reused by both atmospheric layers (kg·m/(mol·s²)).
const G_TIMES_MOLAR_MASS = G * AIR_MOLAR_MASS
// Barometric exponent g·M/(R·L) for the troposphere power law.
const BAROMETRIC_EXPONENT = G_TIMES_MOLAR_MASS / (GAS_CONSTANT * LAPSE_RATE)

// Converts the altitude to pressure at specific temperature.
// `temperature` is the sea-level base temperature in Celsius (default 15 °C), not the temperature at altitude.
// https://www.mide.com/air-pressure-at-altitude-calculator
export function pressureFrom(altitude: Distance, temperature: Temperature = 15): Pressure {
	const k = toKelvin(temperature)
	const m = toMeter(altitude)

	if (m < TROPOPAUSE_ALTITUDE) {
		return ONE_ATM * (k / (k + LAPSE_RATE * m)) ** BAROMETRIC_EXPONENT
	} else {
		// Temperature at the tropopause; the stratosphere is modeled as an isothermal layer.
		const c = k + LAPSE_RATE * TROPOPAUSE_ALTITUDE
		const a = ONE_ATM * (k / c) ** BAROMETRIC_EXPONENT
		return a * Math.exp((-G_TIMES_MOLAR_MASS * (m - TROPOPAUSE_ALTITUDE)) / (GAS_CONSTANT * c))
	}
}
