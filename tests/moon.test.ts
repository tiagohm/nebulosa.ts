import { describe, expect, test } from 'bun:test'
import { deg, toArcsec } from '../src/angle'
import { kilometer, toKilometer } from '../src/distance'
import { lunarSaros, lunation, moonParallax, moonSemidiameter, nearestLunarApsis, nearestLunarEclipse, nearestLunarPhase } from '../src/moon'
import { time, timeToDate, timeYMD, timeYMDHMS, utc } from '../src/time'

test('parallax', () => {
	expect(moonParallax(kilometer(368409.7))).toBeCloseTo(deg(0.99199), 7)
})

test('semi-diameter', () => {
	expect(toArcsec(moonSemidiameter(kilometer(368409.7)))).toBeCloseTo(973.029, 3)
})

test('lunation', () => {
	expect(lunation(timeYMDHMS(2000, 1, 6), 'MEEUS')).toBe(0)
	expect(lunation(timeYMDHMS(2000, 1, 6, 18, 15), 'MEEUS')).toBe(0)
	expect(lunation(timeYMDHMS(2001, 1, 24, 13, 6))).toBe(966)
	expect(lunation(timeYMDHMS(2001, 1, 24, 23, 7))).toBe(966)
	expect(lunation(timeYMDHMS(2001, 2, 23, 8, 21))).toBe(967)
	expect(lunation(timeYMDHMS(2021, 5, 11, 23))).toBe(1217)
	expect(lunation(timeYMDHMS(1900, 2, 17))).toBe(-283)
	expect(lunation(timeYMDHMS(2025, 6, 26))).toBe(1268)
})

test('saros', () => {
	expect(lunarSaros(timeYMD(2016, 8, 18))).toBe(109)
	expect(lunarSaros(timeYMD(2016, 9, 16))).toBe(147)
	expect(lunarSaros(timeYMD(2031, 10, 30))).toBe(117)
	expect(lunarSaros(time(2276890.5))).toBe(138)
})

describe('nearest lunar phase', () => {
	// https://www.timeanddate.com/moon/phases/?year=1977
	test('new moon', () => {
		const time = nearestLunarPhase(timeYMDHMS(1977, 2, 15), 'NEW', true)
		expect(timeToDate(utc(time)).slice(0, 5)).toEqual([1977, 2, 18, 3, 36])
	})

	// https://www.timeanddate.com/moon/phases/?year=2044
	test('last quarter', () => {
		const time = nearestLunarPhase(timeYMDHMS(2044, 2, 1), 'LAST_QUARTER', true)
		expect(timeToDate(utc(time)).slice(0, 5)).toEqual([2044, 2, 20, 20, 20])
	})

	// https://www.timeanddate.com/moon/phases/?year=2025
	test('full', () => {
		const time = nearestLunarPhase(timeYMDHMS(2025, 9, 17), 'FULL', true)
		expect(timeToDate(utc(time)).slice(0, 5)).toEqual([2025, 10, 7, 3, 47])
	})

	// https://www.timeanddate.com/moon/phases/?year=1994
	test('first quarter', () => {
		const time = nearestLunarPhase(timeYMDHMS(1994, 1, 1), 'FIRST_QUARTER', true)
		expect(timeToDate(utc(time)).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
	})

	test('prev', () => {
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 28), 'FIRST_QUARTER', false))).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 26), 'FIRST_QUARTER', false))).slice(0, 5)).toEqual([1993, 12, 20, 22, 26])
	})

	test('next', () => {
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 26), 'FIRST_QUARTER', true))).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 28), 'FIRST_QUARTER', true))).slice(0, 5)).toEqual([1994, 2, 18, 17, 47])
	})
})

describe('nearest lunar eclipse', () => {
	// https://www.timeanddate.com/eclipse/lunar/1973-june-15
	test('penumbral', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1973, 6, 1), true)
		expect(timeToDate(utc(eclipse.firstContactPenumbraTime)).slice(0, 5)).toEqual([1973, 6, 15, 19, 8])
		expect(eclipse.firstContactUmbraTime.day).toBe(0)
		expect(eclipse.totalBeginTime.day).toBe(0)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([1973, 6, 15, 20, 50])
		expect(eclipse.totalEndTime.day).toBe(0)
		expect(eclipse.lastContactUmbraTime.day).toBe(0)
		expect(timeToDate(utc(eclipse.lastContactPenumbraTime)).slice(0, 5)).toEqual([1973, 6, 15, 22, 31])
		expect(eclipse.type).toBe('PENUMBRAL')
	})

	// https://www.timeanddate.com/eclipse/lunar/1997-september-16
	test('total', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1997, 7, 1), true)
		expect(timeToDate(utc(eclipse.firstContactPenumbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 16, 13])
		expect(timeToDate(utc(eclipse.firstContactUmbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 17, 9])
		expect(timeToDate(utc(eclipse.totalBeginTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 16])
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(timeToDate(utc(eclipse.totalEndTime)).slice(0, 5)).toEqual([1997, 9, 16, 19, 17])
		expect(timeToDate(utc(eclipse.lastContactUmbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 20, 24])
		expect(timeToDate(utc(eclipse.lastContactPenumbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 21, 20])
		expect(eclipse.type).toBe('TOTAL')
	})

	// https://www.timeanddate.com/eclipse/lunar/1994-may-25
	test('partial', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1994, 5, 25), true)
		expect(timeToDate(utc(eclipse.firstContactPenumbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 1, 20])
		expect(timeToDate(utc(eclipse.firstContactUmbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 2, 39])
		expect(eclipse.totalBeginTime.day).toBe(0)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([1994, 5, 25, 3, 30])
		expect(eclipse.totalEndTime.day).toBe(0)
		expect(timeToDate(utc(eclipse.lastContactUmbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 4, 22])
		expect(timeToDate(utc(eclipse.lastContactPenumbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 5, 40])
		expect(eclipse.type).toBe('PARTIAL')
	})

	test('prev', () => {
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 48), false).maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 46), false).maximalTime)).slice(0, 5)).toEqual([1997, 3, 24, 4, 39])
	})

	test('next', () => {
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 46), true).maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 48), true).maximalTime)).slice(0, 5)).toEqual([1998, 3, 13, 4, 20])
	})
})

describe('nearest lunar apsis', () => {
	test('apogee', () => {
		const a = nearestLunarApsis(timeYMDHMS(2026, 1, 1), 'APOGEE', true)
		expect(timeToDate(a[0]).slice(0, 5)).toEqual([2026, 1, 13, 20, 48])
		expect(toKilometer(a[1])).toBeCloseTo(405436, 0)

		const b = nearestLunarApsis(timeYMDHMS(2026, 1, 13, 20, 50), 'APOGEE', false)
		expect(timeToDate(b[0]).slice(0, 5)).toEqual([2026, 1, 13, 20, 48])
		expect(toKilometer(b[1])).toBeCloseTo(405436, 0)

		const c = nearestLunarApsis(timeYMDHMS(2026, 1, 13, 20, 50), 'APOGEE', true)
		expect(timeToDate(c[0]).slice(0, 5)).toEqual([2026, 2, 10, 16, 53])
		expect(toKilometer(c[1])).toBeCloseTo(404576, 0)
	})

	test('perigee', () => {
		const a = nearestLunarApsis(timeYMDHMS(2026, 1, 1), 'PERIGEE', true)
		expect(timeToDate(a[0]).slice(0, 5)).toEqual([2026, 1, 1, 21, 44])
		expect(toKilometer(a[1])).toBeCloseTo(360347, 0)

		const b = nearestLunarApsis(timeYMDHMS(2026, 1, 1, 21, 46), 'PERIGEE', false)
		expect(timeToDate(b[0]).slice(0, 5)).toEqual([2026, 1, 1, 21, 44])
		expect(toKilometer(b[1])).toBeCloseTo(360347, 0)

		const c = nearestLunarApsis(timeYMDHMS(2026, 1, 1, 21, 46), 'PERIGEE', true)
		expect(timeToDate(c[0]).slice(0, 5)).toEqual([2026, 1, 29, 21, 53])
		expect(toKilometer(c[1])).toBeCloseTo(365876.6, 0)
	})
})
