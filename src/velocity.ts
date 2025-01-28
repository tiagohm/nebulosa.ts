import { AU_KM, AU_M, DAYSEC } from './constants'

// Represents a velocity quantity in AU/day.
export type Velocity = number

// Creates a new Distance from kilometer/second.
export function kilometerPerSecond(value: number): Velocity {
	return value * (DAYSEC / AU_KM)
}

// Creates a new Distance from meter/second.
export function meterPerSecond(value: number): Velocity {
	return value * (DAYSEC / AU_M)
}

// Converts the distance to kilometer/second.
export function toKilometerPerSecond(value: Velocity): number {
	return value * (AU_KM / DAYSEC)
}

// Converts the distance to meter/second.
export function toMeterPerSecond(value: Velocity): number {
	return value * (AU_M / DAYSEC)
}
