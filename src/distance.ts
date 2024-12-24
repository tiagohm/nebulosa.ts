import { AU_KM, AU_M, SPEED_OF_LIGHT } from './constants'

// 1 parsec in AU.
export const ONE_PARSEC: Distance = 206264.806245480309552772371736702884

// 1000000000 parsecs in AU.
export const ONE_GIGAPARSEC: Distance = 1000000000 * ONE_PARSEC

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
export function toKm(distance: Distance): number {
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
