import { expect, test } from 'bun:test'
import { arcmin, arcsec, deg, hour, mas, toArcmin, toArcsec, toDeg, toHour, toMas } from './angle'

test('mas', () => {
	const radians = mas(37000)
	expect(radians).toBeCloseTo(0.000179381, 8)
	expect(toArcsec(radians)).toBeCloseTo(37, 1)
	expect(toArcmin(radians)).toBeCloseTo(0.616666667, 8)
	expect(toDeg(radians)).toBeCloseTo(0.01027778, 8)
	expect(toHour(radians)).toBeCloseTo(0.000685185, 8)
})

test('arcsec', () => {
	const radians = arcsec(37)
	expect(radians).toBeCloseTo(0.000179381, 8)
	expect(toMas(radians)).toBeCloseTo(37000.0, 1)
	expect(toArcmin(radians)).toBeCloseTo(0.616666667, 8)
	expect(toDeg(radians)).toBeCloseTo(0.01027778, 8)
	expect(toHour(radians)).toBeCloseTo(0.000685185, 8)
})

test('arcmin', () => {
	const radians = arcmin(45)
	expect(radians).toBeCloseTo(0.01308997, 8)
	expect(toMas(radians)).toBeCloseTo(2700000.0, 1)
	expect(toArcsec(radians)).toBeCloseTo(2700.0, 1)
	expect(toDeg(radians)).toBeCloseTo(0.75, 8)
	expect(toHour(radians)).toBeCloseTo(0.05, 8)
})

test('deg', () => {
	const radians = deg(6)
	expect(radians).toBeCloseTo(0.104719755, 8)
	expect(toMas(radians)).toBeCloseTo(21600000.0, 1)
	expect(toArcsec(radians)).toBeCloseTo(21600.0, 1)
	expect(toArcmin(radians)).toBeCloseTo(360.0, 1)
	expect(toHour(radians)).toBeCloseTo(0.4, 8)
})

test('hour', () => {
	const radians = hour(4)
	expect(radians).toBeCloseTo(1.04719755, 8)
	expect(toMas(radians)).toBeCloseTo(216000000.0, 1)
	expect(toArcsec(radians)).toBeCloseTo(216000.0, 1)
	expect(toArcmin(radians)).toBeCloseTo(3600.0, 1)
	expect(toDeg(radians)).toBeCloseTo(60.0, 1)
})
