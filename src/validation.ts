import type { Angle } from './angle'
import { PI, PIOVERTWO } from './constants'
import type { GeographicCoordinate } from './location'
import type { Time } from './time'
import type { Vec3 } from './vec3'

export const GEOMETRY_EPSILON = 1e-12

export function validateFinite(value: number) {
	if (!Number.isFinite(value)) throw new TypeError('value must be finite')
	return value
}

export function validateTime(time: Time) {
	validateFinite(time.day)
	validateFinite(time.fraction)
	if (!Number.isInteger(time.scale) || time.scale < 0 || time.scale > 6) throw new TypeError('time must have a valid scale')
	return time
}

export function validateVector(vector: Vec3) {
	if (vector.length < 3) throw new TypeError('vector must have 3 components')
	validateFinite(vector[0])
	validateFinite(vector[1])
	validateFinite(vector[2])
	return vector
}

export function validatePositiveFinite(value: number) {
	validateFinite(value)
	if (value <= 0) throw new RangeError('value must be positive')
	return value
}

export function validateNonNegativeFinite(value: number) {
	validateFinite(value)
	if (value < 0) throw new RangeError('value must be non-negative')
	return value
}

export function validatePositiveInteger(value: number) {
	if (!Number.isInteger(value) || value < 1) throw new TypeError('value must be a positive integer')
	return value
}

export function validateNonNegativeInteger(value: number) {
	if (!Number.isInteger(value) || value < 0) throw new TypeError('value must be a non-negative integer')
	return value
}

export function validateInRange(value: number, min: number, max: number) {
	validateFinite(value)
	if (value < min || value > max) throw new RangeError(`value must be within [${min}, ${max}]`)
	return value
}

export function validateInRangeExclusive(value: number, min: number, max: number) {
	validateFinite(value)
	if (value <= min || value >= max) throw new RangeError(`value must be within (${min}, ${max})`)
	return value
}

export function validateLatitude(value: Angle) {
	return validateInRange(value, -PIOVERTWO - GEOMETRY_EPSILON, PIOVERTWO + GEOMETRY_EPSILON)
}

export function validateLongitude(value: Angle) {
	return validateInRange(value, -PI - GEOMETRY_EPSILON, PI + GEOMETRY_EPSILON)
}

export function validateLocation(location: Required<GeographicCoordinate>) {
	validateLatitude(location.latitude)
	validateLongitude(location.longitude)
	validateFinite(location.elevation)
	return location
}
