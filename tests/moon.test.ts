import { describe, expect, test } from 'bun:test'
import { deg, toArcsec } from '../src/angle'
import { kilometer } from '../src/distance'
import { LunarPhase, LunationSystem, lunarSaros, lunation, moonParallax, moonSemidiameter, nearestLunarEclipse, nearestLunarPhase } from '../src/moon'
import { time, timeYMD, timeYMDHMS, toDate, utc } from '../src/time'

test('parallax', () => {
	expect(moonParallax(kilometer(368409.7))).toBeCloseTo(deg(0.99199), 7)
})

test('semi-diameter', () => {
	expect(toArcsec(moonSemidiameter(kilometer(368409.7)))).toBeCloseTo(973.029, 3)
})

test('lunation', () => {
	expect(lunation(timeYMDHMS(2000, 1, 6), LunationSystem.MEEUS)).toBe(0)
	expect(lunation(timeYMDHMS(2000, 1, 6, 18, 15), LunationSystem.MEEUS)).toBe(0)
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
		const time = nearestLunarPhase(timeYMDHMS(1977, 2, 15), LunarPhase.NEW, true)
		expect(toDate(utc(time)).slice(0, 5)).toEqual([1977, 2, 18, 3, 36])
	})

	// https://www.timeanddate.com/moon/phases/?year=2044
	test('last quarter', () => {
		const time = nearestLunarPhase(timeYMDHMS(2044, 2, 1), LunarPhase.LAST_QUARTER, true)
		expect(toDate(utc(time)).slice(0, 5)).toEqual([2044, 2, 20, 20, 20])
	})

	// https://www.timeanddate.com/moon/phases/?year=2025
	test('full', () => {
		const time = nearestLunarPhase(timeYMDHMS(2025, 9, 17), LunarPhase.FULL, true)
		expect(toDate(utc(time)).slice(0, 5)).toEqual([2025, 10, 7, 3, 47])
	})

	// https://www.timeanddate.com/moon/phases/?year=1994
	test('first quarter', () => {
		const time = nearestLunarPhase(timeYMDHMS(1994, 1, 1), LunarPhase.FIRST_QUARTER, true)
		expect(toDate(utc(time)).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
	})

	test('prev', () => {
		expect(toDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 28), LunarPhase.FIRST_QUARTER, false))).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
		expect(toDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 26), LunarPhase.FIRST_QUARTER, false))).slice(0, 5)).toEqual([1993, 12, 20, 22, 26])
	})

	test('next', () => {
		expect(toDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 26), LunarPhase.FIRST_QUARTER, true))).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
		expect(toDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 28), LunarPhase.FIRST_QUARTER, true))).slice(0, 5)).toEqual([1994, 2, 18, 17, 47])
	})
})

describe('nearest lunar eclipse', () => {
	// https://www.timeanddate.com/eclipse/lunar/1973-june-15
	test('penumbral', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1973, 6, 1), true)
		expect(toDate(utc(eclipse.firstContactPenumbraTime)).slice(0, 5)).toEqual([1973, 6, 15, 19, 8])
		expect(eclipse.firstContactUmbraTime.day).toBe(0)
		expect(eclipse.totalBeginTime.day).toBe(0)
		expect(toDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([1973, 6, 15, 20, 50])
		expect(eclipse.totalEndTime.day).toBe(0)
		expect(eclipse.lastContactUmbraTime.day).toBe(0)
		expect(toDate(utc(eclipse.lastContactPenumbraTime)).slice(0, 5)).toEqual([1973, 6, 15, 22, 31])
		expect(eclipse.type).toBe('PENUMBRAL')
	})

	// https://www.timeanddate.com/eclipse/lunar/1997-september-16
	test('total', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1997, 7, 1), true)
		expect(toDate(utc(eclipse.firstContactPenumbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 16, 13])
		expect(toDate(utc(eclipse.firstContactUmbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 17, 9])
		expect(toDate(utc(eclipse.totalBeginTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 16])
		expect(toDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(toDate(utc(eclipse.totalEndTime)).slice(0, 5)).toEqual([1997, 9, 16, 19, 17])
		expect(toDate(utc(eclipse.lastContactUmbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 20, 24])
		expect(toDate(utc(eclipse.lastContactPenumbraTime)).slice(0, 5)).toEqual([1997, 9, 16, 21, 20])
		expect(eclipse.type).toBe('TOTAL')
	})

	// https://www.timeanddate.com/eclipse/lunar/1994-may-25
	test('partial', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1994, 5, 25), true)
		expect(toDate(utc(eclipse.firstContactPenumbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 1, 20])
		expect(toDate(utc(eclipse.firstContactUmbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 2, 39])
		expect(eclipse.totalBeginTime.day).toBe(0)
		expect(toDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([1994, 5, 25, 3, 30])
		expect(eclipse.totalEndTime.day).toBe(0)
		expect(toDate(utc(eclipse.lastContactUmbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 4, 22])
		expect(toDate(utc(eclipse.lastContactPenumbraTime)).slice(0, 5)).toEqual([1994, 5, 25, 5, 40])
		expect(eclipse.type).toBe('PARTIAL')
	})

	test('prev', () => {
		expect(toDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 48), false).maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(toDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 46), false).maximalTime)).slice(0, 5)).toEqual([1997, 3, 24, 4, 39])
	})

	test('next', () => {
		expect(toDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 46), true).maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(toDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 48), true).maximalTime)).slice(0, 5)).toEqual([1998, 3, 13, 4, 20])
	})
})
