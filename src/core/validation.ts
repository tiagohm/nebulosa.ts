import type { GeographicCoordinate } from '../astronomy/observer/location'
import type { Time } from '../astronomy/time/time'
import type { Vec3 } from '../math/linear-algebra/vec3'
import type { Angle } from '../math/units/angle'
import { PI, PIOVERTWO } from './constants'

// Shared runtime validators for public entry points. Each validator throws TypeError/RangeError on
// invalid input and otherwise returns its argument unchanged so it can be used inline. Angular limits
// are in radians. Keep these for boundaries where bad input would otherwise produce non-finite
// geometry or hard-to-debug results, not for revalidating already-trusted internal values.

// Small angular tolerance (radians) added to latitude/longitude bounds so values landing exactly on a
// pole or the antimeridian survive floating-point rounding instead of being rejected.
export const GEOMETRY_EPSILON = 1e-12

// Throws TypeError unless `value` is a finite number. Returns `value`.
export function validateFinite(value: number) {
	if (!Number.isFinite(value)) throw new TypeError('value must be finite')
	return value
}

// Validates a Time: finite day and fraction, and an integer scale within the supported [0, 6] range. Returns `time`.
export function validateTime(time: Time) {
	validateFinite(time.day)
	validateFinite(time.fraction)
	if (!Number.isInteger(time.scale) || time.scale < 0 || time.scale > 6) throw new TypeError('time must have a valid scale')
	return time
}

// Validates a 3-component vector: at least 3 elements, all finite. Returns `vector`.
export function validateVector(vector: Vec3) {
	if (vector.length < 3) throw new TypeError('vector must have 3 components')
	validateFinite(vector[0])
	validateFinite(vector[1])
	validateFinite(vector[2])
	return vector
}

// Throws unless `value` is finite and strictly greater than 0. Returns `value`.
export function validatePositiveFinite(value: number) {
	validateFinite(value)
	if (value <= 0) throw new RangeError('value must be positive')
	return value
}

// Throws unless `value` is finite and greater than or equal to 0. Returns `value`.
export function validateNonNegativeFinite(value: number) {
	validateFinite(value)
	if (value < 0) throw new RangeError('value must be non-negative')
	return value
}

// Throws unless `value` is an integer >= 1. Returns `value`.
export function validatePositiveInteger(value: number) {
	if (!Number.isInteger(value) || value < 1) throw new TypeError('value must be a positive integer')
	return value
}

// Throws unless `value` is an integer >= 0. Returns `value`.
export function validateNonNegativeInteger(value: number) {
	if (!Number.isInteger(value) || value < 0) throw new TypeError('value must be a non-negative integer')
	return value
}

// Throws unless `value` is finite and within the inclusive range [min, max]. Returns `value`.
export function validateInRange(value: number, min: number, max: number) {
	validateFinite(value)
	if (value < min || value > max) throw new RangeError(`value must be within [${min}, ${max}]`)
	return value
}

// Throws unless `value` is finite and within the exclusive range (min, max). Returns `value`.
export function validateInRangeExclusive(value: number, min: number, max: number) {
	validateFinite(value)
	if (value <= min || value >= max) throw new RangeError(`value must be within (${min}, ${max})`)
	return value
}

// Validates a geographic latitude (radians) within [-π/2, π/2], allowing GEOMETRY_EPSILON slack at the poles. Returns `value`.
export function validateLatitude(value: Angle) {
	return validateInRange(value, -PIOVERTWO - GEOMETRY_EPSILON, PIOVERTWO + GEOMETRY_EPSILON)
}

// Validates a geographic longitude (radians) within [-π, π], allowing GEOMETRY_EPSILON slack at the antimeridian. Returns `value`.
export function validateLongitude(value: Angle) {
	return validateInRange(value, -PI - GEOMETRY_EPSILON, PI + GEOMETRY_EPSILON)
}

// Validates a declination (radians) within the inclusive range [-π/2, π/2]. Returns `value`.
export function validateDeclination(value: number) {
	return validateInRange(value, -PIOVERTWO, PIOVERTWO)
}

// Validates an altitude (radians) strictly above the horizon and up to the zenith, i.e. within (0, π/2]. Returns `value`.
export function validatePositiveAltitude(value: number) {
	validateFinite(value)
	if (value <= 0 || value > PIOVERTWO) throw new RangeError(`value must be within (0, ${PIOVERTWO}]`)
	return value
}

// Validates an observer location: latitude, longitude, and a finite elevation (meters). Returns `location`.
export function validateLocation(location: Required<GeographicCoordinate>) {
	validateLatitude(location.latitude)
	validateLongitude(location.longitude)
	validateFinite(location.elevation)
	return location
}
