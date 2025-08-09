import { AU_KM, AU_M, ONE_ATM, ONE_PARSEC, SPEED_OF_LIGHT } from './constants'
import type { Pressure } from './pressure'
import { type Temperature, toKelvin } from './temperature'

// Represents a distance value in AU.
export type Distance = number

// Creates a new Distance from meters.
export function meter(value: number): Distance {
	return value / AU_M
}

// Creates a new Distance from kilometers.
export function kilometer(value: number): Distance {
	return value / AU_KM
}

// Creates a new Distance from light years.
export function lightYear(value: number): Distance {
	return value * ((SPEED_OF_LIGHT * 31557600) / AU_M)
}

// Creates a new Distance from parsecs.
export function parsec(value: number): Distance {
	return value * ONE_PARSEC
}

// Converts the distance to meters.
export function toMeter(distance: Distance): number {
	return distance * AU_M
}

// Converts the distance to kilometers.
export function toKilometer(distance: Distance): number {
	return distance * AU_KM
}

// Converts the distance to light years.
export function toLightYear(distance: Distance): number {
	return distance / ((SPEED_OF_LIGHT * 31557600) / AU_M)
}

// Converts the distance to parsecs.
export function toParsec(distance: Distance): number {
	return distance / ONE_PARSEC
}

// Computes the altitude given the pressure and temperature.
export function fromPressure(pressure: Pressure, temperature: Temperature = 15): Distance {
	const k = toKelvin(temperature) / 0.0065
	const e = (8.31447 * 0.0065) / (9.80665 * 0.0289644) // R * L / (g * M)
	return meter(k * (1 - (pressure / ONE_ATM) ** e))
}
