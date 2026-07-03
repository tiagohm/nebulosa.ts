import { describe, expect, test } from 'bun:test'
import { crescentWidth, lunarSaros, lunation, moonParallax, moonSemidiameter, nearestLunarApsis, nearestLunarEclipse, nearestLunarPhase, nearestLunarStandstill, nearestMaxDeclination } from '../../../src/astronomy/bodies/moon'
import { time, timeToDate, timeYMD, timeYMDHMS, utc } from '../../../src/astronomy/time/time'
import { deg, toArcsec, toDeg } from '../../../src/math/units/angle'
import { kilometer, toKilometer } from '../../../src/math/units/distance'

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

test('lunation systems apply their calendar offsets relative to MEEUS', () => {
	const t = timeYMDHMS(2001, 1, 24, 13, 6)
	const meeus = lunation(t, 'MEEUS')
	expect(lunation(t, 'BROWN')).toBe(meeus + 953)
	expect(lunation(t)).toBe(meeus + 953) // BROWN is the default
	expect(lunation(t, 'GOLDSTINE')).toBe(meeus + 37105)
	expect(lunation(t, 'HEBREW')).toBe(meeus + 71234)
	expect(lunation(t, 'ISLAMIC')).toBe(meeus + 17038)
	expect(lunation(t, 'THAI')).toBe(meeus + 16843)
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
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 28, 3), 'FIRST_QUARTER', false))).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 26, 3), 'FIRST_QUARTER', false))).slice(0, 5)).toEqual([1993, 12, 20, 22, 26])
	})

	test('next', () => {
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 26, 3), 'FIRST_QUARTER', true))).slice(0, 5)).toEqual([1994, 1, 19, 20, 26])
		expect(timeToDate(utc(nearestLunarPhase(timeYMDHMS(1994, 1, 19, 20, 28, 3), 'FIRST_QUARTER', true))).slice(0, 5)).toEqual([1994, 2, 18, 17, 47])
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
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 48, 3), false).maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 46, 3), false).maximalTime)).slice(0, 5)).toEqual([1997, 3, 24, 4, 39])
	})

	test('next', () => {
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 46, 3), true).maximalTime)).slice(0, 5)).toEqual([1997, 9, 16, 18, 47])
		expect(timeToDate(utc(nearestLunarEclipse(timeYMDHMS(1997, 9, 16, 18, 48, 3), true).maximalTime)).slice(0, 5)).toEqual([1998, 3, 13, 4, 20])
	})
})

describe('nearest lunar apsis', () => {
	test('apogee', () => {
		const a = nearestLunarApsis(timeYMDHMS(2026, 1, 1), 'APOGEE', true)
		expect(timeToDate(a[0]).slice(0, 5)).toEqual([2026, 1, 13, 20, 48])
		expect(toKilometer(a[1])).toBeCloseTo(405436, 0)
		expect(toArcsec(a[2])).toBeCloseTo(1768.337, 3)

		const b = nearestLunarApsis(timeYMDHMS(2026, 1, 13, 20, 50, 0, 3), 'APOGEE', false)
		expect(timeToDate(b[0]).slice(0, 5)).toEqual([2026, 1, 13, 20, 48])
		expect(toKilometer(b[1])).toBeCloseTo(405436, 0)

		const c = nearestLunarApsis(timeYMDHMS(2026, 1, 13, 20, 50, 0, 3), 'APOGEE', true)
		expect(timeToDate(c[0]).slice(0, 5)).toEqual([2026, 2, 10, 16, 53])
		expect(toKilometer(c[1])).toBeCloseTo(404575, 0)
	})

	test('perigee', () => {
		const a = nearestLunarApsis(timeYMDHMS(2026, 1, 1), 'PERIGEE', true)
		expect(timeToDate(a[0]).slice(0, 5)).toEqual([2026, 1, 1, 21, 44])
		expect(toKilometer(a[1])).toBeCloseTo(360347, 0)
		expect(toArcsec(a[2])).toBeCloseTo(1989.603, 3)

		const b = nearestLunarApsis(timeYMDHMS(2026, 1, 1, 21, 46, 0, 3), 'PERIGEE', false)
		expect(timeToDate(b[0]).slice(0, 5)).toEqual([2026, 1, 1, 21, 44])
		expect(toKilometer(b[1])).toBeCloseTo(360347, 0)

		const c = nearestLunarApsis(timeYMDHMS(2026, 1, 1, 21, 46, 0, 3), 'PERIGEE', true)
		expect(timeToDate(c[0]).slice(0, 5)).toEqual([2026, 1, 29, 21, 53])
		expect(toKilometer(c[1])).toBeCloseTo(365876.6, 0)
	})
})

describe('nearest maximum declination', () => {
	// Cross-checked against Skyfield (DE440, apparent declination of date). The Meeus Chapter 52 series
	// reproduces the extremum to a few arcminutes in declination and about 20 minutes in time; the returned
	// times are TT.
	test('northern', () => {
		// Skyfield: 2025-03-07 15:44 TT, declination +28.7167 deg.
		const [t, dec] = nearestMaxDeclination(timeYMDHMS(2025, 3, 1), 'NORTH', true)
		expect(timeToDate(t).slice(0, 3)).toEqual([2025, 3, 7])
		expect(toDeg(dec)).toBeCloseTo(28.7167, 1)
		expect(dec).toBeGreaterThan(0)
	})

	test('southern maxima are reported as a negative declination', () => {
		// Skyfield: 2025-03-22 06:38 TT, declination -28.7257 deg.
		const [t, dec] = nearestMaxDeclination(timeYMDHMS(2025, 3, 1), 'SOUTH', true)
		expect(timeToDate(t).slice(0, 3)).toEqual([2025, 3, 22])
		expect(toDeg(dec)).toBeCloseTo(-28.7257, 1)
		expect(dec).toBeLessThan(0)
	})

	test('prev and next select the surrounding events', () => {
		// The northern maximum of 2025-03-07 is the previous one and 2025-04-03 the next, seen from 03-10.
		expect(timeToDate(nearestMaxDeclination(timeYMDHMS(2025, 3, 7, 15, 57, 22, 3), 'NORTH', false)[0]).slice(0, 6)).toEqual([2025, 2, 8, 10, 41, 35])
		expect(timeToDate(nearestMaxDeclination(timeYMDHMS(2025, 3, 7, 15, 57, 22, 3), 'NORTH', true)[0]).slice(0, 6)).toEqual([2025, 3, 7, 15, 57, 22])
		expect(timeToDate(nearestMaxDeclination(timeYMDHMS(2025, 3, 7, 15, 57, 23, 3), 'NORTH', false)[0]).slice(0, 6)).toEqual([2025, 3, 7, 15, 57, 22])
		expect(timeToDate(nearestMaxDeclination(timeYMDHMS(2025, 3, 7, 15, 57, 23, 3), 'NORTH', true)[0]).slice(0, 6)).toEqual([2025, 4, 3, 22, 16, 9])
	})

	test('reproduces a major-standstill amplitude far from the seed epoch (1988)', () => {
		// Skyfield: 1988-03-24 17:12 TT, +28.6964 deg (major standstill following 1987).
		const [t, dec] = nearestMaxDeclination(timeYMDHMS(1988, 3, 1), 'NORTH', true)
		expect(timeToDate(t).slice(0, 3)).toEqual([1988, 3, 24])
		expect(toDeg(dec)).toBeCloseTo(28.6964, 2)
	})

	test('minor standstill has a small, near-symmetric amplitude (2015)', () => {
		// Near the 2015 minor standstill the extreme declination shrinks to about 18.1 deg on both sides.
		const north = nearestMaxDeclination(timeYMDHMS(2015, 9, 1), 'NORTH', true)[1]
		const south = nearestMaxDeclination(timeYMDHMS(2015, 9, 1), 'SOUTH', true)[1]
		expect(toDeg(north)).toBeCloseTo(18.16, 1)
		expect(toDeg(south)).toBeCloseTo(-18.15, 1)
	})
})

describe('nearest lunar standstill', () => {
	// Cross-checked against Skyfield (DE440, apparent declination of date): the standstill is the extreme of the
	// 18.6-year envelope, i.e. the largest (major) or smallest (minor) monthly declination maximum of the cycle.
	// The node-anchored search recovers it despite the ~206-day wobble; times are TT, within ~20 minutes and
	// declinations within ~0.02 deg of Skyfield.
	test('major standstill has the largest monthly maxima on both sides', () => {
		// Skyfield: north 2025-03-07 15:46 TT +28.7167 deg, south 2025-03-22 06:39 TT -28.7257 deg.
		const north = nearestLunarStandstill(timeYMDHMS(2024, 1, 1), 'MAJOR', 'NORTH', true)
		expect(timeToDate(north[0]).slice(0, 3)).toEqual([2025, 3, 7])
		expect(toDeg(north[1])).toBeCloseTo(28.7167, 1)
		expect(north[1]).toBeGreaterThan(0)

		const south = nearestLunarStandstill(timeYMDHMS(2024, 1, 1), 'MAJOR', 'SOUTH', true)
		expect(timeToDate(south[0]).slice(0, 3)).toEqual([2025, 3, 22])
		expect(toDeg(south[1])).toBeCloseTo(-28.7257, 1)
		expect(south[1]).toBeLessThan(0)
	})

	test('minor standstill has the smallest monthly maxima on both sides', () => {
		// Skyfield: north 2015-10-03 23:56 TT +18.1399 deg, south 2015-09-21 12:03 TT -18.1332 deg.
		const north = nearestLunarStandstill(timeYMDHMS(2014, 1, 1), 'MINOR', 'NORTH', true)
		expect(timeToDate(north[0]).slice(0, 3)).toEqual([2015, 10, 3])
		expect(toDeg(north[1])).toBeCloseTo(18.1399, 1)

		const south = nearestLunarStandstill(timeYMDHMS(2014, 1, 1), 'MINOR', 'SOUTH', true)
		expect(timeToDate(south[0]).slice(0, 3)).toEqual([2015, 9, 21])
		expect(toDeg(south[1])).toBeCloseTo(-18.1332, 1)
	})

	test('previous selects the standstill of the current cycle', () => {
		// Skyfield: previous major standstill 2006-09-15 01:30 TT, +28.7227 deg.
		const [t, dec] = nearestLunarStandstill(timeYMDHMS(2010, 1, 1), 'MAJOR', 'NORTH', false)
		expect(timeToDate(t).slice(0, 3)).toEqual([2006, 9, 15])
		expect(toDeg(dec)).toBeCloseTo(28.7227, 1)
	})

	test('next and previous select adjacent nodal cycles across a standstill', () => {
		// From just after the 2025-03-07 major standstill, previous returns it and next jumps a full nodal
		// period to 2043-09-25 (Skyfield 14:13 TT, +28.7195 deg).
		const previous = nearestLunarStandstill(timeYMDHMS(2025, 4, 1), 'MAJOR', 'NORTH', false)
		expect(timeToDate(previous[0]).slice(0, 3)).toEqual([2025, 3, 7])

		const next = nearestLunarStandstill(timeYMDHMS(2025, 4, 1), 'MAJOR', 'NORTH', true)
		expect(timeToDate(next[0]).slice(0, 3)).toEqual([2043, 9, 25])
		expect(toDeg(next[1])).toBeCloseTo(28.7195, 1)
	})
})

test('crescent width scales with semidiameter and illuminated fraction', () => {
	// Full disk: width equals the full diameter.
	expect(crescentWidth(deg(0.25), 1)).toBeCloseTo(deg(0.5), 15)
	// New moon: zero width.
	expect(crescentWidth(deg(0.25), 0)).toBe(0)
	// Half illuminated: width is the semidiameter.
	expect(crescentWidth(deg(0.25), 0.5)).toBeCloseTo(deg(0.25), 15)
})
