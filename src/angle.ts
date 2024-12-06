import { PI } from './constants'

// Radians to degrees.
export const RAD2DEG: Angle = 180.0 / PI

// Degrees to radians.
export const DEG2RAD: Angle = PI / 180.0

// Arcminutes to radians.
export const AMIN2RAD: Angle = PI / 180.0 / 60.0

// Arcsecconds to radians.
export const ASEC2RAD: Angle = PI / 180.0 / 3600.0

// Milliarcsecconds to radians.
export const MILLIASEC2RAD: Angle = PI / 180.0 / 3600000.0

// Angular velocity in radians/s.
export const ANGULAR_VELOCITY = 7.292115e-5

// Arcseconds in a full circle.
export const TURNAS = 1296000.0

// Represents an angle in radians.
export type Angle = number

// Creates a new [Angle] from degrees.
export function deg(num: number): Angle {
	return num * DEG2RAD
}

// Creates a new [Angle] from hours.
export function hours(num: number): Angle {
	return num * (PI / 12)
}

// Creates a new [Angle] from arcmin.
export function arcmin(num: number): Angle {
	return num * AMIN2RAD
}

// Creates a new [Angle] from arcseconds.
export function arcsec(num: number): Angle {
	return num * ASEC2RAD
}

// Creates a new [Angle] from milliarcseconds.
export function mas(num: number): Angle {
	return num * MILLIASEC2RAD
}

// Converts the [Angle] to degrees.
export function toDeg(angle: Angle): number {
	return angle * RAD2DEG
}

// Converts the [Angle] to hours.
export function toHours(angle: Angle): number {
	return angle * (12 / PI)
}

// Converts the [Angle] to arcmin.
export function toArcmin(angle: Angle): number {
	return angle / AMIN2RAD
}

// Converts the [Angle] to arcseconds.
export function toArcsec(angle: Angle): number {
	return angle / ASEC2RAD
}

// Converts the [Angle] to milliarcseconds.
export function toMas(angle: Angle): number {
	return angle / MILLIASEC2RAD
}
