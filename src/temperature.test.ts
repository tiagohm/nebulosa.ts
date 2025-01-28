import { expect, test } from 'bun:test'
import { fahrenheit, kelvin, toFahrenheit, toKelvin } from './temperature'

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
