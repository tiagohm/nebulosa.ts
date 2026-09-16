import { expect, test } from 'bun:test'
import { meteorComputationContext, meteorShowerDates, meteorSolarLongitude, meteorSolarLongitudeDelta, meteorSolarLongitudeForwardDelta, meteorSolarLongitudeTimes, meteorSolarRelativeState, timeAtMeteorSolarLongitude } from '../../../src/astronomy/meteors/solar'
import type { MeteorShowerSolution } from '../../../src/astronomy/meteors/types'
import { Timescale, timeSubtract, timeToDate, timeYMDHMS } from '../../../src/astronomy/time/time'
import { deg, normalizeAngle, toDeg } from '../../../src/math/units/angle'
import { BASE_SOLUTION, HORIZONS_EARTH_STATE, REFERENCE_TDB, REFERENCE_UTC, TOLERANCE, WRAPPED_EXPONENTIAL_PROFILE, WRAPPED_INTERVAL, YEAR_SPECIFIC_SOLUTION } from './util'

test('solar longitude and geocentric state match the frozen Horizons DE441 state', () => {
	// Horizons DE441, 2024-01-04 00:00 TDB, geometric Earth relative to Sun,
	// ecliptic J2000, AU and AU/day. The source computes the opposite Sun-Earth vector.
	const expectedPosition = HORIZONS_EARTH_STATE.position.map((value) => -value)
	const expectedVelocity = HORIZONS_EARTH_STATE.velocity.map((value) => -value)
	const [position, velocity] = meteorSolarRelativeState(REFERENCE_TDB)

	for (let i = 0; i < 3; i++) {
		expect(position[i]).toBeCloseTo(expectedPosition[i], 6)
		expect(velocity[i]).toBeCloseTo(expectedVelocity[i], 6)
	}
	// The fixed longitude is atan2(Y, X) of the same Horizons vector; the small residual is
	// the documented VSOP87E-versus-DE441 ephemeris difference.
	expect(toDeg(meteorSolarLongitude(REFERENCE_TDB))).toBeCloseTo(282.7674525147974, 4)
})

test('signed and forward longitude deltas use their distinct wrap conventions', () => {
	expect(meteorSolarLongitudeDelta(deg(1), deg(359))).toBeCloseTo(deg(2), 14)
	expect(meteorSolarLongitudeDelta(deg(359), deg(1))).toBeCloseTo(deg(-2), 14)
	expect(meteorSolarLongitudeForwardDelta(deg(359), deg(1))).toBeCloseTo(deg(2), 14)
	expect(meteorSolarLongitudeForwardDelta(deg(1), deg(359))).toBeCloseTo(deg(358), 14)
})

test('solar-longitude inversion is stable at the annual seam and in a leap year', () => {
	const equinox = timeAtMeteorSolarLongitude(2024, 0, { step: 7, tolerance: TOLERANCE.time })
	const beforeEquinox = timeAtMeteorSolarLongitude(2024, deg(359), { step: 7, tolerance: TOLERANCE.time })
	const equinoxDate = timeToDate(equinox)
	const beforeDate = timeToDate(beforeEquinox)

	expect(equinoxDate.slice(0, 6)).toEqual([2024, 3, 20, 11, 6, 42])
	expect(beforeDate.slice(0, 6)).toEqual([2024, 3, 19, 10, 57, 22])
	expect(timeSubtract(equinox, beforeEquinox)).toBeCloseTo(1 + 9.3437 / 1440, 5)
	expect(toDeg(meteorSolarLongitude(equinox))).toBeCloseTo(0, 5)
})

test('cardinal solar longitudes agree with frozen ERFA epv00 references', () => {
	// Astropy 8.0.1 / ERFA epv00 heliocentric Earth states rotated to the mean J2000 ecliptic.
	const references = [
		[0, timeYMDHMS(2024, 3, 20, 11, 6, 44.561, Timescale.UTC)],
		[90, timeYMDHMS(2024, 6, 21, 5, 17, 4.777, Timescale.UTC)],
		[180, timeYMDHMS(2024, 9, 22, 21, 2, 47.196, Timescale.UTC)],
		[270, timeYMDHMS(2024, 12, 21, 17, 25, 33.791, Timescale.UTC)],
	] as const
	for (const [degrees, reference] of references) {
		expect(Math.abs(meteorSolarLongitudeDelta(meteorSolarLongitude(reference), deg(degrees)))).toBeLessThan(deg(0.001))
		const inverse = timeAtMeteorSolarLongitude(2024, deg(degrees), { step: 7, tolerance: TOLERANCE.time })
		expect(Math.abs(timeSubtract(inverse, reference))).toBeLessThan(2 / 1440)
	}
})

test('solar-longitude inversion requires a root instead of comparing radians to day tolerance', () => {
	const start = timeYMDHMS(2023, 1, 1, 0, 0, 0, Timescale.UTC)
	const end = timeYMDHMS(2024, 1, 1, 0, 0, 0, Timescale.UTC)
	const finalLongitude = meteorSolarLongitude(end)
	const annualGap = meteorSolarLongitudeForwardDelta(finalLongitude, meteorSolarLongitude(start))
	const targetInGap = normalizeAngle(finalLongitude + annualGap * 0.5)

	// This midpoint is about 0.13 day beyond 2023, even though its angular residual is < 0.01 rad.
	expect(() => timeAtMeteorSolarLongitude(2023, targetInGap, { step: 7, tolerance: 0.01 })).toThrow('does not occur')
})

test('longitude inversion preserves the requested UTC, TT and TDB output scales', () => {
	const utc = timeAtMeteorSolarLongitude(2024, deg(20), { scale: Timescale.UTC, step: 7, tolerance: TOLERANCE.time })
	const tt = timeAtMeteorSolarLongitude(2024, deg(20), { scale: Timescale.TT, step: 7, tolerance: TOLERANCE.time })
	const tdb = timeAtMeteorSolarLongitude(2024, deg(20), { scale: Timescale.TDB, step: 7, tolerance: TOLERANCE.time })

	expect(utc.scale).toBe(Timescale.UTC)
	expect(tt.scale).toBe(Timescale.TT)
	expect(tdb.scale).toBe(Timescale.TDB)
	expect(timeSubtract(tt, utc, Timescale.UTC)).toBeCloseTo(0, 9)
	expect(timeSubtract(tdb, utc, Timescale.UTC)).toBeCloseTo(0, 9)
	expect(toDeg(meteorSolarLongitude(tt))).toBeCloseTo(20, 5)
}, 1500)

test('batch longitude inversion preserves order and agrees with scalar inversion around wrap', () => {
	expect(meteorSolarLongitudeTimes(2024, [])).toEqual([])
	const longitudes = [deg(180), deg(359.9), deg(0.1), deg(90), deg(270)]
	const batch = meteorSolarLongitudeTimes(2024, longitudes, { step: 7, tolerance: TOLERANCE.time })
	expect(batch).toHaveLength(longitudes.length)
	for (let index = 0; index < batch.length; index++) {
		const scalar = timeAtMeteorSolarLongitude(2024, longitudes[index], { step: 7, tolerance: TOLERANCE.time })
		expect(timeSubtract(batch[index], scalar)).toBeCloseTo(0, 10)
		expect(Math.abs(meteorSolarLongitudeDelta(meteorSolarLongitude(batch[index]), longitudes[index]))).toBeLessThan(deg(1e-5))
	}
})

test('shower dates cross the angular seam and honor year-specific policy', () => {
	const solution = { ...BASE_SOLUTION, activityInterval: WRAPPED_INTERVAL, referenceSolarLongitude: 0 } satisfies MeteorShowerSolution
	const dates = meteorShowerDates(solution, 2024, { profile: WRAPPED_EXPONENTIAL_PROFILE, step: 7, tolerance: TOLERANCE.time })

	expect(timeToDate(dates.start!).slice(0, 3)).toEqual([2024, 3, 10])
	expect(timeToDate(dates.reference!).slice(0, 3)).toEqual([2024, 3, 20])
	expect(timeToDate(dates.end!).slice(0, 3)).toEqual([2024, 4, 9])
	expect(timeToDate(dates.maximum!).slice(0, 3)).toEqual([2024, 3, 20])

	expect(meteorShowerDates(YEAR_SPECIFIC_SOLUTION, 2025)).toEqual({})
	const extrapolated = meteorShowerDates(YEAR_SPECIFIC_SOLUTION, 2025, { extrapolateYearSpecific: true, step: 7 })
	expect(extrapolated.start).toBeDefined()

	const fullYear = { ...BASE_SOLUTION, activityInterval: { start: 0, end: 0, fullCircle: true } } satisfies MeteorShowerSolution
	const fullYearDates = meteorShowerDates(fullYear, 2024, { step: 7, tolerance: TOLERANCE.time })
	expect(timeSubtract(fullYearDates.end!, fullYearDates.start!)).toBeGreaterThan(365)
})

test('computation context caches the solar value and retains observer LST', () => {
	const context = meteorComputationContext(REFERENCE_UTC, deg(123))
	expect(context.time).toBe(REFERENCE_UTC)
	expect(context.localSiderealTime).toBe(deg(123))
	expect(context.solarLongitude).toBe(meteorSolarLongitude(REFERENCE_UTC))
})
