import { AU_KM, AU_M, DAYSEC } from '../../core/constants'

// Represents a velocity quantity in AU/day.
export type Velocity = number

// Creates a new Velocity from kilometer/second.
export function kilometerPerSecond(value: number): Velocity {
	return value * (DAYSEC / AU_KM)
}

// Creates a new Velocity from meter/second.
export function meterPerSecond(value: number): Velocity {
	return value * (DAYSEC / AU_M)
}

// Converts the velocity to kilometer/second.
export function toKilometerPerSecond(value: Velocity) {
	return value * (AU_KM / DAYSEC)
}

// Converts the velocity to meter/second.
export function toMeterPerSecond(value: Velocity) {
	return value * (AU_M / DAYSEC)
}
