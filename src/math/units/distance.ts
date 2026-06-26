import { AU_KM, AU_M, ONE_ATM, ONE_PARSEC, SPEED_OF_LIGHT } from '../../core/constants'
import type { Pressure } from './pressure'
import { type Temperature, toKelvin } from './temperature'

// Represents a distance value in AU.
export type Distance = number

const JULIAN_YEAR_SECONDS = 31557600
const LIGHT_YEAR_AU = (SPEED_OF_LIGHT * JULIAN_YEAR_SECONDS) / AU_M

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
	return value * LIGHT_YEAR_AU
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
	return distance / LIGHT_YEAR_AU
}

// Converts the distance to parsecs.
export function toParsec(distance: Distance): number {
	return distance / ONE_PARSEC
}

// Gas constant of the 1976 US Standard Atmosphere (J/(mol·K)). Must match the value used by
// pressureFrom in pressure.ts so fromPressure stays an exact inverse; the modern CODATA value
// (8.314462618) would break the round-trip by ~0.1 m per several km of altitude.
const GAS_CONSTANT = 8.31432
const STANDARD_LAPSE_RATE = 0.0065
const STANDARD_GRAVITY = 9.80665
const DRY_AIR_MOLAR_MASS = 0.0289644

const PRESSURE_ALTITUDE_EXPONENT = (GAS_CONSTANT * STANDARD_LAPSE_RATE) / (STANDARD_GRAVITY * DRY_AIR_MOLAR_MASS)

// Computes approximate pressure altitude using the barometric formula with a constant tropospheric lapse rate.
export function fromPressure(pressure: Pressure, temperature: Temperature = 15): Distance {
	return meter((toKelvin(temperature) / STANDARD_LAPSE_RATE) * (1 - (pressure / ONE_ATM) ** PRESSURE_ALTITUDE_EXPONENT))
}
