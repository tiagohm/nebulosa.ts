import { expect, test } from 'bun:test'
import { meteorComputationContext, meteorShowerDates, meteorSolarLongitude, meteorSolarLongitudeDelta, meteorSolarLongitudeForwardDelta, meteorSolarRelativeState, timeAtMeteorSolarLongitude } from '../../../src/astronomy/meteors/solar'
import type { MeteorShowerSolution } from '../../../src/astronomy/meteors/types'
import { Timescale, timeSubtract, timeToDate } from '../../../src/astronomy/time/time'
import { deg, toDeg } from '../../../src/math/units/angle'
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
})

test('computation context caches the solar value and retains observer LST', () => {
	const context = meteorComputationContext(REFERENCE_UTC, deg(123))
	expect(context.time).toBe(REFERENCE_UTC)
	expect(context.localSiderealTime).toBe(deg(123))
	expect(context.solarLongitude).toBe(meteorSolarLongitude(REFERENCE_UTC))
})
