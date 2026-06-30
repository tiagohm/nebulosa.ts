import { describe, expect, test } from 'bun:test'
import { carringtonRotationNumber, equationOfTime, nearestSolarEclipse, season, solarSaros, sunParallax, sunSemidiameter } from '../../../src/astronomy/bodies/sun'
import { equatorial } from '../../../src/astronomy/coordinates/astrometry'
import { equatorialFromJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { greenwichApparentSiderealTime, time, Timescale, timeToDate, timeYMD, timeYMDHMS, toJulianDay, ut1, utc } from '../../../src/astronomy/time/time'
import { TAU } from '../../../src/core/constants'
import { vecMinus } from '../../../src/math/linear-algebra/vec3'
import { arcsec, deg, normalizePI, toDeg } from '../../../src/math/units/angle'

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
	expect(toJulianDay(season(1962, 'summer'))).toBeCloseTo(2437837.39245, 5)
	expect(timeToDate(season(1991, 'spring')).slice(0, 6)).toEqual([1991, 3, 21, 3, 3, 9])
	expect(timeToDate(season(1991, 'summer')).slice(0, 6)).toEqual([1991, 6, 21, 21, 19, 36])
	expect(timeToDate(season(1991, 'autumn')).slice(0, 6)).toEqual([1991, 9, 23, 12, 48, 56])
	expect(timeToDate(season(1991, 'winter')).slice(0, 6)).toEqual([1991, 12, 22, 8, 54, 53])
})

test('season is reported in dynamical time (TT)', () => {
	const s = season(2024, 'spring')
	// Meeus' method yields the JDE, so the instant must be tagged TT, not UTC.
	expect(s.scale).toBe(Timescale.TT)
	// Converting to civil UTC must move the instant earlier by ΔT (~69 s in 2024), not be a no-op.
	expect(toJulianDay(s) - toJulianDay(utc(s))).toBeCloseTo(69 / 86400, 4)
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
		expect(eclipse.maximalTime.scale).toBe(Timescale.TT)
		expect(eclipse.type).toBe('total')
		expect(eclipse.u).toBeLessThan(0)
		// Central eclipse: magnitude is the topocentric Moon/Sun diameter ratio (> 1 for total).
		expect(eclipse.magnitude).toBeCloseTo(1.0566, 2)
	})

	test('annular', () => {
		// https://www.timeanddate.com/eclipse/solar/2024-october-2
		const eclipse = nearestSolarEclipse(timeYMD(2024, 4, 9), true)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 10, 2, 18, 45])
		expect(eclipse.type).toBe('annular')
		expect(eclipse.u).toBeGreaterThan(0)
		// Central eclipse: magnitude is the topocentric Moon/Sun diameter ratio (< 1 for annular).
		expect(eclipse.magnitude).toBeCloseTo(0.9326, 2)
	})

	test('partial', () => {
		// https://www.timeanddate.com/eclipse/solar/2025-september-21
		const eclipse = nearestSolarEclipse(timeYMD(2025, 9, 21), true)
		expect(eclipse.lunation).toBe(318)
		expect(eclipse.type).toBe('partial')
		expect(eclipse.magnitude).toBeCloseTo(0.8557, 4)
		expect(eclipse.gamma).toBeCloseTo(-1.0643, 4)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2025, 9, 21, 19, 41])
	})

	test('non-central annular', () => {
		// https://eclipse.gsfc.nasa.gov/SEsearch/SEdata.php?Ecl=20140429
		const eclipse = nearestSolarEclipse(timeYMD(2014, 1, 1), true)
		expect(eclipse.type).toBe('annular')
		expect(eclipse.u).toBeGreaterThan(0)
		expect(eclipse.magnitude).toBeCloseTo(0.9868, 2)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2014, 4, 29, 6, 3])
	})

	test('non-central total', () => {
		// https://eclipse.gsfc.nasa.gov/SEsearch/SEdata.php?Ecl=20430409
		const eclipse = nearestSolarEclipse(timeYMD(2043, 1, 1), true)
		expect(eclipse.type).toBe('total')
		expect(eclipse.u).toBeLessThan(0)
		expect(eclipse.magnitude).toBeCloseTo(1.0095, 2)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2043, 4, 9, 18, 56])
	})

	test('hybrid', () => {
		// https://www.timeanddate.com/eclipse/solar/2023-april-20
		const eclipse = nearestSolarEclipse(timeYMD(2023, 4, 1), true)
		expect(eclipse.type).toBe('hybrid')
		expect(eclipse.u).toBeGreaterThan(0)
		expect(eclipse.u).toBeLessThan(0.00464)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2023, 4, 20, 4, 16])
		expect(eclipse.magnitude).toBeCloseTo(1.013, 2)
	})

	test('previous', () => {
		const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 46), false)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 10, 2, 18, 45])
		expect(eclipse.type).toBe('annular')
		expect(timeToDate(utc(nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 44), false).maximalTime)).slice(0, 5)).toEqual([2024, 4, 8, 18, 17])
	})

	test('next', () => {
		const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 44), true)
		expect(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)).toEqual([2024, 10, 2, 18, 45])
		expect(eclipse.type).toBe('annular')
		expect(timeToDate(utc(nearestSolarEclipse(timeYMDHMS(2024, 10, 2, 18, 46), true).maximalTime)).slice(0, 5)).toEqual([2025, 3, 29, 10, 48])
	})
})

test('equation of time follows GAST minus apparent RA minus the mean Sun hour angle', () => {
	const t = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const apparentSunRightAscension = deg(98)
	expect(equationOfTime(t, apparentSunRightAscension)).toBeCloseTo(normalizePI(greenwichApparentSiderealTime(t) - apparentSunRightAscension - ut1(t).fraction * TAU), 14)
	// Setting the RA to the mean Sun's hour angle makes the equation of time vanish.
	const meanSunRightAscension = greenwichApparentSiderealTime(t) - ut1(t).fraction * TAU
	expect(equationOfTime(t, meanSunRightAscension)).toBeCloseTo(0, 12)
})

test('equation of time matches the analemma for the real Sun', () => {
	// Reference minutes from Astropy (true-equinox-of-date Sun RA + GAST), 12:00 UTC.
	const reference: readonly [number, number, number, number][] = [
		[2026, 2, 11, -14.17],
		[2026, 5, 14, 3.67],
		[2026, 7, 26, -6.57],
		[2026, 9, 1, -0.01],
		[2026, 11, 3, 16.45],
	]
	for (const [year, month, day, expectedMinutes] of reference) {
		const t = timeYMDHMS(year, month, day, 12, 0, 0, Timescale.UTC)
		// equationOfTime needs the apparent RA of date, so precess+nutate the ICRS Sun direction.
		const [ra, dec] = equatorial(vecMinus(sun(t)[0], earth(t)[0]))
		const [raOfDate] = equatorialFromJ2000(ra, dec, t)
		const minutes = toDeg(equationOfTime(t, raOfDate)) * 4
		expect(minutes).toBeCloseTo(expectedMinutes, 1)
	}
})
