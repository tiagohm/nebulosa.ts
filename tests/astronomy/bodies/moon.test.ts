import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { crescentWidth, lunarSaros, lunation, moonParallax, moonSemidiameter, nearestLunarApsis, nearestLunarEclipse, nearestLunarPhase, nearestLunarStandstill, nearestMaxDeclination, nearestMeanLunarApsis, nearestLunarNode, moonMeanAscendingNode, moonTopocentricSemidiameter, moonTopocentricSemidiameterApprox } from '../../../src/astronomy/bodies/moon'
import { Julian, MoonPosition } from '../../../src/astronomy/ephemeris/meeus'
import { type Time, time, timeToDate, timeYMD, timeYMDHMS, timeShift, Timescale, toJulianDay, utc } from '../../../src/astronomy/time/time'
import { PI } from '../../../src/core/constants'
import { deg, normalizeAngle, toArcsec, toDeg } from '../../../src/math/units/angle'
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

	const dates: { readonly hunt: readonly [number, number, number]; readonly exp: number[] }[] = [
		{ hunt: [1990, 10, 18], exp: [1990, 10, 18, 15, 37] },
		{ hunt: [1990, 11, 17], exp: [1990, 11, 17, 9, 5] },
		{ hunt: [1990, 12, 17], exp: [1990, 12, 17, 4, 22] },
		{ hunt: [1991, 1, 15], exp: [1991, 1, 15, 23, 50] },
		{ hunt: [1991, 2, 14], exp: [1991, 2, 14, 17, 32] },
	]

	for (const date of dates) {
		test(`new moon from ${date.hunt[0]}-${date.hunt[1]}-${date.hunt[2]}`, () => {
			const time = nearestLunarPhase(timeYMDHMS(...date.hunt), 'NEW', true)
			expect(timeToDate(time).slice(0, 5)).toEqual(date.exp)
		})
	}
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

	test('1973', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1973, 4, 1), true)

		expect(eclipse.type).toBe('PENUMBRAL')
		expect(eclipse.maximalTime.day).toBe(2441849)
		// Astronomia eclipse.lunar(1973.46), retrieved 2026-09-07: JDE 2441849.3686694875 TT.
		expect(eclipse.maximalTime.fraction).toBeCloseTo(0.3686694875, 9)
		expect(eclipse.sigma).toBeCloseTo(0.7206, 4) // u
		expect(eclipse.rho).toBeCloseTo(1.3045, 4) // p
		expect(eclipse.magnitude).toBeCloseTo(0.4625, 2)
		expect(eclipse.gamma).toBeCloseTo(-1.3249, 4) // distance
		expect(eclipse.sdPenumbra).toBeCloseTo(101.5 / 24 / 60, 4) // min
		expect(eclipse.sdPartial).toBeNaN()
		expect(eclipse.sdTotal).toBeNaN()
	})

	test('1997', () => {
		const eclipse = nearestLunarEclipse(timeYMDHMS(1997, 7, 1), true)

		expect(eclipse.type).toBe('TOTAL')
		expect(eclipse.maximalTime.day).toBe(2450708)
		expect(eclipse.maximalTime.fraction).toBeCloseTo(0.2835, 4)
		expect(eclipse.sigma).toBeCloseTo(0.7534, 4)
		expect(eclipse.rho).toBeCloseTo(1.2717, 4)
		expect(eclipse.magnitude).toBeCloseTo(1.1868, 4)
		expect(eclipse.gamma).toBeCloseTo(-0.3791, 4)
		expect(eclipse.sdPenumbra).toBeCloseTo(153.36 / 24 / 60, 4)
		expect(eclipse.sdPartial).toBeCloseTo(97.632 / 24 / 60, 4)
		expect(eclipse.sdTotal).toBeCloseTo(30.384 / 24 / 60, 4)
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

describe('lunar parallax and mean node examples', () => {
	test('parallax', () => {
		// Example 47.a, p. 342.
		const jde = Julian.calendarGregorianToJD(1992, 4, 12)
		const res = MoonPosition.position(jde)
		const px = moonParallax(res[2])
		// The book rounds to five decimals; moonParallax uses the repository's 6378.135 km Earth radius.
		expect(toDeg(px)).toBeCloseTo(0.99199, 5)
		expect(px).toBeCloseTo(Math.asin(kilometer(6378.135) / res[2]), 15)
	})

	test('parallax 2', () => {
		// test case from chapter 40, p. 280
		const px = moonParallax(0.37276)
		expect(Math.abs(toArcsec(px) - 23.592) < 0.001).toBeTrue()
	})

	describe('test node 0°', () => {
		// Test data p. 344.
		const n0 = [
			Julian.calendarGregorianToJD(1913, 5, 27),
			Julian.calendarGregorianToJD(1932, 1, 6),
			Julian.calendarGregorianToJD(1950, 8, 17),
			Julian.calendarGregorianToJD(1969, 3, 29),
			Julian.calendarGregorianToJD(1987, 11, 8),
			Julian.calendarGregorianToJD(2006, 6, 19),
			Julian.calendarGregorianToJD(2025, 1, 29),
			Julian.calendarGregorianToJD(2043, 9, 10),
			Julian.calendarGregorianToJD(2062, 4, 22),
			Julian.calendarGregorianToJD(2080, 12, 1),
			Julian.calendarGregorianToJD(2099, 7, 13),
		]

		for (const j of n0) {
			test(j.toFixed(0), () => {
				expect(Math.abs(normalizeAngle(moonMeanAscendingNode(time(j, 0, Timescale.TT)) + 1) - 1) < 1e-3).toBeTrue()
			})
		}
	})

	describe('test node 180°', () => {
		// Test data p. 344.
		const n180 = [
			Julian.calendarGregorianToJD(1922, 9, 16),
			Julian.calendarGregorianToJD(1941, 4, 27),
			Julian.calendarGregorianToJD(1959, 12, 7),
			Julian.calendarGregorianToJD(1978, 7, 19),
			Julian.calendarGregorianToJD(1997, 2, 27),
			Julian.calendarGregorianToJD(2015, 10, 10),
			Julian.calendarGregorianToJD(2034, 5, 21),
			Julian.calendarGregorianToJD(2052, 12, 30),
			Julian.calendarGregorianToJD(2071, 8, 12),
			Julian.calendarGregorianToJD(2090, 3, 23),
			Julian.calendarGregorianToJD(2108, 11, 3),
		]

		for (const j of n180) {
			test(j.toFixed(0), () => {
				expect(Math.abs(moonMeanAscendingNode(time(j, 0, Timescale.TT)) - PI) < 1e-3).toBeTrue()
			})
		}
	})
})

describe('lunar angular radius examples', () => {
	test('rigorous lunar semidiameter returns the angle rather than its sine', () => {
		const distance = kilometer(384400)
		const sineRadius = 0.272481 * Math.sin(moonParallax(distance))
		expect(moonTopocentricSemidiameter(distance, 0, 0, 0, 0)).toBeCloseTo(Math.asin(sineRadius), 15)
	})

	test('lunar semidiameter uses kilometer coefficient and AU distance', () => {
		// Meeus chapter 55: 358473400 arcseconds km / geocentric distance in km.
		const distance = kilometer(384400)
		const expected = 932.5530697190427
		expect(toArcsec(moonSemidiameter(distance))).toBeCloseTo(expected, 8)
		expect(toArcsec(moonTopocentricSemidiameterApprox(distance, 0))).toBeCloseTo(expected, 8)
		expect(Math.abs(moonTopocentricSemidiameterApprox(distance, 0) / moonTopocentricSemidiameter(distance, 0, 0, 0, 0) - 1)).toBeLessThan(3e-5)
	})
})

describe('Meeus lunar event examples', () => {
	test('mean and corrected apogee, example 50.a', () => {
		const start = time(2447440, 0, Timescale.TT)
		expect(toJulianDay(nearestMeanLunarApsis(start, 'APOGEE', true))).toBeCloseTo(2447442.8191, 4)
		const [t, distance, diameter] = nearestLunarApsis(start, 'APOGEE', true)
		expect(toJulianDay(t)).toBeCloseTo(2447442.3543, 4)
		expect(toArcsec(moonParallax(distance))).toBeCloseTo(3240.679, 3)
		expect(diameter).toBeCloseTo(2 * moonSemidiameter(distance), 15)
	})

	for (const [year, month, day] of [
		[1997, 12, 9 + 16.9 / 24],
		[1998, 1, 3 + 8.5 / 24],
		[1990, 12, 2 + 10.8 / 24],
		[1990, 12, 30 + 23.8 / 24],
	]) {
		test('perigee table 50: ' + year + '-' + month + '-' + Math.floor(day), () => {
			const expected = Julian.calendarGregorianToJD(year, month, day)
			const actual = nearestLunarApsis(time(expected - 1, 0, Timescale.TT), 'PERIGEE', true)
			expect(Math.abs(toJulianDay(actual[0]) - expected)).toBeLessThan(0.1)
		})
	}

	for (const [apsis, start, expectedDistance, expectedPositionDistance] of [
		['PERIGEE', 2450790, 368877, 368881],
		['APOGEE', 2450775, 404695, 404697],
	] as const) {
		test(apsis + ' distance and parallax agree with independent position series', () => {
			const [t, distance] = nearestLunarApsis(time(start, 0, Timescale.TT), apsis, true)
			expect(toKilometer(distance)).toBeCloseTo(expectedDistance, 0)
			const position = MoonPosition.position(toJulianDay(t))
			expect(toKilometer(position[2])).toBeCloseTo(expectedPositionDistance, 0)
			expect(toArcsec(Math.abs(moonParallax(distance) - moonParallax(position[2])))).toBeLessThan(0.1)
			if (apsis === 'PERIGEE') expect(toArcsec(moonParallax(distance))).toBeCloseTo(3566.637, 3)
		})
	}

	for (const [hemisphere, jde, declination] of [
		['NORTH', 2447518.3346, 28.1562],
		['SOUTH', 2469553.0834, -22.1384],
		['NORTH', 1719672.1412, 28.9739],
	] as const) {
		test('maximum declination example 52 ' + hemisphere + ' ' + jde, () => {
			const [t, angle] = nearestMaxDeclination(time(jde - 1, 0, Timescale.TT), hemisphere, true)
			expect(toJulianDay(t)).toBeCloseTo(jde, 4)
			expect(toDeg(angle)).toBeCloseTo(declination, 4)
		})
	}

	test('southern declination uses its own periodic coefficients', () => {
		// PyMeeus 0.5.12, Moon.moon_maximum_declination(Epoch(1800,4,15), 'southern'), TT,
		// correcting that release's solar-anomaly epoch typo 1.13951 to Meeus' 1.3951 (fixed upstream).
		const [t, dec] = nearestMaxDeclination(time(2378599, 0, Timescale.TT), 'SOUTH', true)
		expect(toJulianDay(t)).toBeCloseTo(2378600.2617890746, 8)
		expect(toDeg(dec)).toBeCloseTo(-28.25989030189065, 9)
	})

	test('previous perigee is not skipped when the index estimate is too early', () => {
		// Meeus chapter 50 series at k=-1288; independent legacy implementation before consolidation.
		const jde = 2416042.578635584
		expect(toJulianDay(nearestLunarApsis(time(jde + 1, 0, Timescale.TT), 'PERIGEE', false)[0])).toBeCloseTo(jde, 8)
	})
})

describe('lunar node passages', () => {
	// PyMeeus 0.5.12, Moon.moon_passage_nodes(Epoch(year,month,day), direction); geocentric, TT.
	for (const [direction, jde] of [
		['ASCENDING', 2446938.768029436],
		['DESCENDING', 2446953.316288361],
		['ASCENDING', 2378500.2883511516],
		['DESCENDING', 2378514.1430561217],
		['ASCENDING', 2524603.4126088284],
		['DESCENDING', 2524615.8115583123],
	] as const) {
		test(direction + ' ' + jde, () => {
			const next = nearestLunarNode(time(jde - 1, 0, Timescale.TT), direction, true)
			const previous = nearestLunarNode(time(jde + 1, 0, Timescale.TT), direction, false)
			expect(toJulianDay(next)).toBeCloseTo(jde, 8)
			expect(toJulianDay(previous)).toBeCloseTo(jde, 8)
			const before = MoonPosition.position(toJulianDay(next) - 0.02)[1]
			const after = MoonPosition.position(toJulianDay(next) + 0.02)[1]
			expect(direction === 'ASCENDING' ? before < 0 && after > 0 : before > 0 && after < 0).toBeTrue()
		})
	}
})

describe('lunar event selection boundaries', () => {
	const searches: readonly (readonly [string, (t: Time, next: boolean) => Time])[] = [
		...(['PERIGEE', 'APOGEE'] as const).flatMap(
			(apsis) =>
				[
					[apsis, (t: Time, next: boolean) => nearestLunarApsis(t, apsis, next)[0]],
					['mean ' + apsis, (t: Time, next: boolean) => nearestMeanLunarApsis(t, apsis, next)],
				] as const,
		),
		...(['NORTH', 'SOUTH'] as const).map((hemisphere) => [hemisphere, (t: Time, next: boolean) => nearestMaxDeclination(t, hemisphere, next)[0]] as const),
		...(['ASCENDING', 'DESCENDING'] as const).map((direction) => [direction, (t: Time, next: boolean) => nearestLunarNode(t, direction, next)] as const),
	]

	for (const [name, search] of searches) {
		test(name + ' brackets the immediately adjacent event and preserves TT precision', () => {
			for (const year of [1800, 1902, 2000, 2025, 2100, 2200]) {
				const start = timeYMDHMS(year, 1, 1, 0, 0, 0, Timescale.TT)
				const event = search(start, true)
				const jd = toJulianDay(event)
				for (const days of [-1, -1e-7]) expect(toJulianDay(search(timeShift(event, days), true))).toBe(jd)
				for (const days of [0, 1e-7, 1]) expect(toJulianDay(search(timeShift(event, days), false))).toBe(jd)
				const following = search(event, true)
				expect(toJulianDay(following) - jd).toBeGreaterThan(20)
				expect(toJulianDay(following) - jd).toBeLessThan(35)
				const earlier = search(timeShift(event, -1e-7), false)
				expect(jd - toJulianDay(earlier)).toBeGreaterThan(20)
				expect(jd - toJulianDay(earlier)).toBeLessThan(35)
				expect(toJulianDay(search(utc(start), true))).toBeCloseTo(jd, 8)
				expect(event.scale).toBe(Timescale.TT)
			}
		})
	}
})

test('lunar phases retain the secular powers centuries from J2000', () => {
	// PyMeeus 0.5.12, Moon.moon_phase(Epoch(year,1,1), target), TT. One-second tolerance.
	const fixtures = [
		['NEW', 2305462.7136972747],
		['FIRST_QUARTER', 2305469.502773242],
		['FULL', 2305476.7750151046],
		['LAST_QUARTER', 2305484.909741121],
		['NEW', 2597637.501662412],
		['FIRST_QUARTER', 2597645.6627082494],
		['FULL', 2597652.9765757015],
		['LAST_QUARTER', 2597659.6375507875],
	] as const

	for (const [phase, jde] of fixtures) {
		expect(Math.abs(toJulianDay(nearestLunarPhase(time(jde - 1, 0, Timescale.TT), phase, true)) - jde) * 86400).toBeLessThan(1)
		expect(Math.abs(toJulianDay(nearestLunarPhase(time(jde + 1, 0, Timescale.TT), phase, false)) - jde) * 86400).toBeLessThan(1)
	}
})

test('lunar eclipse retains the mean-phase secular powers', () => {
	// Astronomia eclipse.lunar(2400), retrieved 2026-09-07; geocentric JDE TT.
	const eclipse = nearestLunarEclipse(time(2597651, 0, Timescale.TT), true)
	expect(toJulianDay(eclipse.maximalTime)).toBeCloseTo(2597652.9864619565, 8)
	expect(eclipse.type).toBe('PENUMBRAL')
	expect(eclipse.magnitude).toBeCloseTo(0.21566569524024756, 9)
})

test('topocentric lunar angular radius follows observer distance', () => {
	const distance = kilometer(384400)
	const earthRadius = kilometer(6378.135)
	const radius = 0.272481 * earthRadius
	expect(moonTopocentricSemidiameter(distance, 0, 0, 0, 1)).toBeCloseTo(Math.asin(radius / (distance - earthRadius)), 15)
	expect(moonTopocentricSemidiameter(distance, 0, PI, 0, 1)).toBeCloseTo(Math.asin(radius / (distance + earthRadius)), 15)
	expect(moonTopocentricSemidiameter(distance, PI / 2, 0, 1, 0)).toBeCloseTo(Math.asin(radius / (distance - earthRadius)), 15)
})
