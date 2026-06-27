import { expect, test } from 'bun:test'
import { kilometerPerSecond, meterPerSecond, toKilometerPerSecond, toMeterPerSecond } from '../../../src/math/units/velocity'

test('kilometerPerSecond', () => {
	expect(kilometerPerSecond(100.5)).toBeCloseTo(0.05804360690008099, 15)
})

test('meterPerSecond', () => {
	expect(meterPerSecond(100000.5)).toBeCloseTo(0.05775512151056268, 15)
})

test('toKilometerPerSecond', () => {
	expect(toKilometerPerSecond(0.00045)).toBeCloseTo(0.77915557656249, 13)
})

test('toMeterPerSecond', () => {
	expect(toMeterPerSecond(0.00045)).toBe(779.1555765625)
})

test('conversions round-trip and stay mutually consistent', () => {
	expect(toKilometerPerSecond(kilometerPerSecond(29.78))).toBeCloseTo(29.78, 12)
	expect(toMeterPerSecond(meterPerSecond(343))).toBeCloseTo(343, 9)
	// One km/s is a thousand m/s.
	expect(kilometerPerSecond(1)).toBeCloseTo(meterPerSecond(1000), 15)
})
