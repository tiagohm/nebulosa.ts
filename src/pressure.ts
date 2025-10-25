import { ONE_ATM } from './constants'
import { type Distance, toMeter } from './distance'
import { type Temperature, toKelvin } from './temperature'

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

// Converts the altitude to pressure at specific temperature.
// https://www.mide.com/air-pressure-at-altitude-calculator
export function pressureFrom(altitude: Distance, temperature: Temperature = 15): Pressure {
	const e = (9.80665 * 0.0289644) / (8.31432 * -0.0065)
	const k = toKelvin(temperature)
	const m = toMeter(altitude)

	if (m < 11000) {
		return ONE_ATM * (k / (k - 0.0065 * m)) ** e
	} else {
		const a = ONE_ATM * (k / (k + -0.0065 * 11000)) ** e
		const c = k + 11000 * -0.0065
		return a * Math.exp((-9.80665 * 0.0289644 * (m - 11000)) / (8.31432 * c))
	}
}
