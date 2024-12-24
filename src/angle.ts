import { PI, TAU } from './constants'
import { pmod } from './math'

// Radians to degrees.
export const RAD2DEG: Angle = 180 / PI

// Degrees to radians.
export const DEG2RAD: Angle = PI / 180

// Arcminutes to radians.
export const AMIN2RAD: Angle = PI / 180 / 60

// Arcsecconds to radians.
export const ASEC2RAD: Angle = PI / 180 / 3600

// Milliarcsecconds to radians.
export const MILLIASEC2RAD: Angle = PI / 180 / 3600000

// Angular velocity in radians/s.
export const ANGULAR_VELOCITY = 7.292115e-5

// Arcseconds in a full circle.
export const TURNAS = 1296000

// Represents an angle in radians.
export type Angle = number

export function normalize(angle: Angle): Angle {
	return pmod(angle, TAU)
}

// Creates a new Angle from degrees.
export function deg(value: number): Angle {
	return value * DEG2RAD
}

// Creates a new Angle from hours.
export function hour(value: number): Angle {
	return value * (PI / 12)
}

// Creates a new Angle from arcmin.
export function arcmin(value: number): Angle {
	return value * AMIN2RAD
}

// Creates a new Angle from arcseconds.
export function arcsec(value: number): Angle {
	return value * ASEC2RAD
}

// Creates a new Angle from milliarcseconds.
export function mas(value: number): Angle {
	return value * MILLIASEC2RAD
}

// Creates a new Angle from degress, minutes and seconds.
export function dms(d: number, min: number = 0, sec: number = 0): Angle {
	const neg = d < 0
	const angle = deg(Math.abs(d) + Math.abs(min) / 60 + sec / 3600)
	return neg ? -angle : angle
}

// Creates a new Angle from hours, minutes and seconds.
export function hms(h: number, min: number = 0, sec: number = 0): Angle {
	const neg = h < 0
	const angle = hour(Math.abs(h) + Math.abs(min) / 60 + sec / 3600)
	return neg ? -angle : angle
}

// Converts the angle to degrees.
export function toDeg(angle: Angle): number {
	return angle * RAD2DEG
}

// Converts the angle to hours.
export function toHour(angle: Angle): number {
	return angle * (12 / PI)
}

// Converts the angle to arcmin.
export function toArcmin(angle: Angle): number {
	return angle / AMIN2RAD
}

// Converts the angle to arcseconds.
export function toArcsec(angle: Angle): number {
	return angle / ASEC2RAD
}

// Converts the angle to milliarcseconds.
export function toMas(angle: Angle): number {
	return angle / MILLIASEC2RAD
}

// Extracts the degrees, minutes and seconds from the angle.
export function toDms(angle: Angle): [number, number, number] {
	const d = Math.abs(toDeg(angle))
	const m = ((d - Math.trunc(d)) * 60) % 60
	const s = ((m - Math.trunc(m)) * 60) % 60
	return [Math.trunc(angle < 0 ? -d : d), Math.trunc(m), s]
}

// Extracts the hours, minutes and seconds from the angle.
export function toHms(angle: Angle): [number, number, number] {
	const h = toHour(normalize(angle))
	const m = ((h - Math.trunc(h)) * 60) % 60
	const s = ((m - Math.trunc(m)) * 60) % 60
	return [Math.trunc(h), Math.trunc(m), s]
}
