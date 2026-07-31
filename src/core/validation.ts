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

// Throws TypeError unless `value` is a non-null, non-array object. `name` names the field in the
// message so a failure points at the offending property of a deserialized structure. Returns `value`
// narrowed to an indexable record.
export function validateObject(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
	return value as Record<string, unknown>
}

// Throws TypeError unless `value` is one of `allowed`. Intended for string-literal unions arriving from
// serialized data. `name` names the field in the message. Returns `value` narrowed to the union.
export function validateOneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
	if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${name} must be one of ${allowed.join(', ')}`)
	return value as T
}

// Throws TypeError unless `value` is an array or typed array of the expected `length` whose elements
// are all finite numbers. Pass `length` as `undefined` to accept any length. `name` names the field in
// the message. Returns `value` as an indexable numeric sequence.
export function validateNumberArray(value: unknown, length: number | undefined, name: string): ArrayLike<number> {
	if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(`${name} must be an array of numbers`)

	const values = value as ArrayLike<number>

	if (length !== undefined && values.length !== length) throw new TypeError(`${name} must have ${length} element(s), got ${values.length}`)

	for (let i = 0; i < values.length; i++) {
		if (!Number.isFinite(values[i])) throw new TypeError(`${name}[${i}] must be finite`)
	}

	return values
}

// Validates an observer location: latitude, longitude, and a finite elevation (meters). Returns `location`.
export function validateLocation(location: Required<GeographicCoordinate>) {
	validateLatitude(location.latitude)
	validateLongitude(location.longitude)
	validateFinite(location.elevation)
	return location
}
