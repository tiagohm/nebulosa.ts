import { expect, test } from 'bun:test'
import type { GeographicCoordinate } from '../../src/astronomy/observer/location'
import { type Time, Timescale } from '../../src/astronomy/time/time'
import { PI, PIOVERTWO } from '../../src/core/constants'
import { GEOMETRY_EPSILON, validateFinite, validateInRange, validateInRangeExclusive, validateLatitude, validateLocation, validateLongitude, validateNonNegativeFinite, validateNonNegativeInteger, validatePositiveFinite, validatePositiveInteger, validateTime, validateVector } from '../../src/core/validation'
import type { Vec3 } from '../../src/math/linear-algebra/vec3'

test('validateFinite accepts only finite numbers', () => {
	expect(validateFinite(0)).toBe(0)
	expect(validateFinite(-12.5)).toBe(-12.5)

	expect(() => validateFinite(Number.NaN)).toThrow('value must be finite')
	expect(() => validateFinite(Number.POSITIVE_INFINITY)).toThrow('value must be finite')
	expect(() => validateFinite(Number.NEGATIVE_INFINITY)).toThrow('value must be finite')
})

test('finite sign validators enforce their bounds', () => {
	expect(validatePositiveFinite(Number.MIN_VALUE)).toBe(Number.MIN_VALUE)
	expect(validateNonNegativeFinite(0)).toBe(0)
	expect(validateNonNegativeFinite(2.5)).toBe(2.5)

	expect(() => validatePositiveFinite(0)).toThrow('value must be positive')
	expect(() => validatePositiveFinite(-1)).toThrow('value must be positive')
	expect(() => validatePositiveFinite(Number.POSITIVE_INFINITY)).toThrow('value must be finite')
	expect(() => validateNonNegativeFinite(-Number.MIN_VALUE)).toThrow('value must be non-negative')
	expect(() => validateNonNegativeFinite(Number.NaN)).toThrow('value must be finite')
})

test('integer validators enforce integer domains', () => {
	expect(validatePositiveInteger(1)).toBe(1)
	expect(validatePositiveInteger(42)).toBe(42)
	expect(validateNonNegativeInteger(0)).toBe(0)
	expect(validateNonNegativeInteger(42)).toBe(42)

	expect(() => validatePositiveInteger(0)).toThrow('value must be a positive integer')
	expect(() => validatePositiveInteger(1.5)).toThrow('value must be a positive integer')
	expect(() => validatePositiveInteger(Number.POSITIVE_INFINITY)).toThrow('value must be a positive integer')
	expect(() => validateNonNegativeInteger(-1)).toThrow('value must be a non-negative integer')
	expect(() => validateNonNegativeInteger(1.5)).toThrow('value must be a non-negative integer')
	expect(() => validateNonNegativeInteger(Number.NaN)).toThrow('value must be a non-negative integer')
})

test('range validators include and exclude endpoints correctly', () => {
	expect(validateInRange(1, 1, 2)).toBe(1)
	expect(validateInRange(2, 1, 2)).toBe(2)
	expect(validateInRangeExclusive(1.5, 1, 2)).toBe(1.5)

	expect(() => validateInRange(0, 1, 2)).toThrow('value must be within [1, 2]')
	expect(() => validateInRange(3, 1, 2)).toThrow('value must be within [1, 2]')
	expect(() => validateInRange(Number.NaN, 1, 2)).toThrow('value must be finite')
	expect(() => validateInRangeExclusive(1, 1, 2)).toThrow('value must be within (1, 2)')
	expect(() => validateInRangeExclusive(2, 1, 2)).toThrow('value must be within (1, 2)')
	expect(() => validateInRangeExclusive(Number.POSITIVE_INFINITY, 1, 2)).toThrow('value must be finite')
})

test('angle validators allow geometry tolerance at geographic limits', () => {
	expect(validateLatitude(PIOVERTWO + GEOMETRY_EPSILON)).toBe(PIOVERTWO + GEOMETRY_EPSILON)
	expect(validateLatitude(-PIOVERTWO - GEOMETRY_EPSILON)).toBe(-PIOVERTWO - GEOMETRY_EPSILON)
	expect(validateLongitude(PI + GEOMETRY_EPSILON)).toBe(PI + GEOMETRY_EPSILON)
	expect(validateLongitude(-PI - GEOMETRY_EPSILON)).toBe(-PI - GEOMETRY_EPSILON)

	expect(() => validateLatitude(PIOVERTWO + GEOMETRY_EPSILON * 2)).toThrow('value must be within')
	expect(() => validateLatitude(-PIOVERTWO - GEOMETRY_EPSILON * 2)).toThrow('value must be within')
	expect(() => validateLongitude(PI + GEOMETRY_EPSILON * 2)).toThrow('value must be within')
	expect(() => validateLongitude(-PI - GEOMETRY_EPSILON * 2)).toThrow('value must be within')
	expect(() => validateLatitude(Number.NaN)).toThrow('value must be finite')
	expect(() => validateLongitude(Number.POSITIVE_INFINITY)).toThrow('value must be finite')
})

test('validateTime checks finite components and valid timescale values', () => {
	const value: Time = { day: 2451545, fraction: 0.25, scale: Timescale.UTC }

	expect(validateTime(value)).toBe(value)

	expect(() => validateTime({ ...value, day: Number.NaN })).toThrow('value must be finite')
	expect(() => validateTime({ ...value, fraction: Number.POSITIVE_INFINITY })).toThrow('value must be finite')
	expect(() => validateTime({ ...value, scale: -1 as Timescale })).toThrow('time must have a valid scale')
	expect(() => validateTime({ ...value, scale: 1.5 as Timescale })).toThrow('time must have a valid scale')
	expect(() => validateTime({ ...value, scale: 99 as Timescale })).toThrow('time must have a valid scale')
})

test('validateVector checks exact length and finite components', () => {
	const value: Vec3 = [1, -2, 3]

	expect(validateVector(value)).toBe(value)

	expect(() => validateVector([1, 2] as unknown as Vec3)).toThrow('vector must have 3 components')
	expect(() => validateVector([1, Number.NaN, 3])).toThrow('value must be finite')
	expect(() => validateVector([1, 2, Number.NEGATIVE_INFINITY])).toThrow('value must be finite')
})

test('validateLocation checks latitude, longitude, and elevation', () => {
	const value: GeographicCoordinate = { latitude: 0.25, longitude: -0.5, elevation: 1 }

	expect(validateLocation(value)).toBe(value)

	expect(() => validateLocation({ ...value, latitude: PIOVERTWO + GEOMETRY_EPSILON * 2 })).toThrow('value must be within')
	expect(() => validateLocation({ ...value, longitude: -PI - GEOMETRY_EPSILON * 2 })).toThrow('value must be within')
	expect(() => validateLocation({ ...value, elevation: Number.POSITIVE_INFINITY })).toThrow('value must be finite')
})
