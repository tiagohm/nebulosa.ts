import { expect, test } from 'bun:test'
import { fahrenheit, kelvin, toFahrenheit, toKelvin } from '../../../src/math/units/temperature'

test('fahrenheit', () => {
	expect(fahrenheit(81.5)).toBe(27.5)
})

test('kelvin', () => {
	expect(kelvin(81.5)).toBeCloseTo(-191.65, 2)
})

test('toFahrenheit', () => {
	expect(toFahrenheit(81.5)).toBeCloseTo(178.7, 2)
})

test('toKelvin', () => {
	expect(toKelvin(81.5)).toBe(354.65)
})

test('known reference points', () => {
	// 0 °C is 32 °F and 273.15 K; -40 °C equals -40 °F.
	expect(toFahrenheit(0)).toBeCloseTo(32, 12)
	expect(toKelvin(0)).toBeCloseTo(273.15, 12)
	expect(toFahrenheit(-40)).toBeCloseTo(-40, 12)
})

test('conversions round-trip', () => {
	expect(fahrenheit(toFahrenheit(21.3))).toBeCloseTo(21.3, 12)
	expect(kelvin(toKelvin(21.3))).toBeCloseTo(21.3, 12)
})
