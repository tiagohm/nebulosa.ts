import { describe, expect, test } from 'bun:test'
import { arcsec } from '../src/angle'
import { carringtonRotationNumber, nearestSolarEclipse, season, solarSaros, sunParallax, sunSemidiameter } from '../src/sun'
import { time, timeToDate, timeYMD, timeYMDHMS, toJulianDay, utc } from '../src/time'

test('parallax', () => {
	expect(sunParallax(1)).toBeCloseTo(arcsec(8.794), 7)
	expect(sunParallax(1.0167)).toBeCloseTo(arcsec(8.65), 7)
	expect(sunParallax(0.98329)).toBeCloseTo(arcsec(8.943), 7)
})

test('semi-diameter', () => {
	expect(sunSemidiameter(1)).toBeCloseTo(arcsec(959.63), 7)
	expect(sunSemidiameter(1.0167)).toBeCloseTo(arcsec(943.87), 7)
	expect(sunSemidiameter(0.98329)).toBeCloseTo(arcsec(975.94), 7)
})

test('carrington rotation number', () => {
	expect(carringtonRotationNumber(time(2442439, 0.5))).toBe(1624)
})

test('season', () => {
	expect(toJulianDay(season(1962, 'SUMMER'))).toBeCloseTo(2437837.39245, 5)
	expect(timeToDate(season(1991, 'SPRING'))).toEqual([1991, 3, 21, 3, 3, 9, 268713029])
	expect(timeToDate(season(1991, 'SUMMER'))).toEqual([1991, 6, 21, 21, 19, 36, 114155028])
	expect(timeToDate(season(1991, 'AUTUMN'))).toEqual([1991, 9, 23, 12, 48, 56, 140399989])
	expect(timeToDate(season(1991, 'WINTER'))).toEqual([1991, 12, 22, 8, 54, 53, 684271186])
})

test('saros', () => {
	expect(solarSaros(time(2451401))).toBe(145)
	expect(solarSaros(timeYMD(2013, 11, 3))).toBe(143)
	expect(solarSaros(timeYMD(2009, 7, 22))).toBe(136)
	expect(solarSaros(time(2270969.5))).toBe(108)
})

describe('nearest solar eclipse', () => {
	test('total', () => {
		// https://www.timeanddate.com/eclipse/solar/2024-april-8
		const eclipse = nearestSolarEclipse(timeYMD(2024, 3, 1), true)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 4, 8, 18, 17])
		expect(eclipse.type).toBe('TOTAL')
	})

	test('annular', () => {
		// https://www.timeanddate.com/eclipse/solar/2024-october-2
		const eclipse = nearestSolarEclipse(timeYMD(2024, 4, 9), true)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 10, 2, 18, 45])
		expect(eclipse.type).toBe('ANNULAR')
	})

	test('partial', () => {
		// https://www.timeanddate.com/eclipse/solar/2025-september-21
		const eclipse = nearestSolarEclipse(timeYMD(2025, 9, 21), true)
		expect(eclipse.lunation).toBe(318)
		expect(eclipse.type).toBe('PARTIAL')
		expect(eclipse.magnitude).toBeCloseTo(0.8557, 4)
		expect(eclipse.gamma).toBeCloseTo(-1.0643, 4)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2025, 9, 21, 19, 41])
	})

	test('previous', () => {
		const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 46), false)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 10, 2, 18, 45])
		expect(eclipse.type).toBe('ANNULAR')
		expect(timeToDate(utc(nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 44), false).maximalTime)).slice(0, 5)).toEqual([2024, 4, 8, 18, 17])
	})

	test('next', () => {
		const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 44), true)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 10, 2, 18, 45])
		expect(eclipse.type).toBe('ANNULAR')
		expect(timeToDate(utc(nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 46), true).maximalTime)).slice(0, 5)).toEqual([2025, 3, 29, 10, 48])
	})
})
