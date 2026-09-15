import { expect, test } from 'bun:test'
import { meteorRadiantDegrees, meteorRadiantHorizontal, meteorRadiantJ2000, meteorRadiantOfDate, meteorRadiantRiseTransitSet, meteorRadiantVector, meteorRadiantVisibility } from '../../../src/astronomy/meteors/radiant'
import type { MeteorComputationContext, MeteorShowerSolution } from '../../../src/astronomy/meteors/types'
import { timeYMDHMS, Timescale, type Time } from '../../../src/astronomy/time/time'
import { deg, toDeg } from '../../../src/math/units/angle'
import { ASTROPY_HORIZONTAL, ASTROPY_RADIANT_OF_DATE, BASE_SOLUTION, DAILY_DRIFT_SOLUTION, MISSING_RADIANT_SOLUTION, OBSERVER, REFERENCE_UTC, SOLAR_DRIFT_SOLUTION, TOLERANCE } from './util'

const ASTROPY_EPOCH = timeYMDHMS(2026, 6, 29, 21, 0, 0, Timescale.UTC)

function context(time: Time, solarLongitude: number): MeteorComputationContext {
	return { time, solarLongitude }
}

test('radiant evaluation handles absent coordinates and a fixed J2000 radiant', () => {
	const fixed = meteorRadiantJ2000(BASE_SOLUTION, context(REFERENCE_UTC, deg(100)))
	expect(fixed).toEqual({ radiant: { rightAscension: deg(180), declination: deg(-20) }, extrapolated: false })
	expect(meteorRadiantJ2000(MISSING_RADIANT_SOLUTION, context(REFERENCE_UTC, deg(100)))).toBeUndefined()

	const missingReference = { ...BASE_SOLUTION, radiantDrift: { basis: 'solarLongitude', rightAscensionRate: 1, declinationRate: 1 }, referenceSolarLongitude: undefined } satisfies MeteorShowerSolution
	expect(meteorRadiantJ2000(missingReference, context(REFERENCE_UTC, deg(100)))).toBeUndefined()
})

test('solar-longitude drift wraps RA, changes declination and obeys extrapolation limits', () => {
	const result = meteorRadiantJ2000(SOLAR_DRIFT_SOLUTION, context(REFERENCE_UTC, deg(101)))!
	expect(toDeg(result.radiant.rightAscension)).toBeCloseTo(1, 12)
	expect(toDeg(result.radiant.declination)).toBeCloseTo(11, 12)
	expect(result.extrapolated).toBe(true)
	expect(meteorRadiantJ2000(SOLAR_DRIFT_SOLUTION, context(REFERENCE_UTC, deg(101)), { extrapolate: false })).toBeUndefined()
	expect(meteorRadiantJ2000(SOLAR_DRIFT_SOLUTION, context(REFERENCE_UTC, deg(101)), { maxExtrapolationSolarLongitude: deg(0.5) })).toBeUndefined()
})

test('daily drift uses the reference longitude inversion and rejects pole crossing', () => {
	const oneDay = timeYMDHMS(2024, 1, 5, 0, 0, 0, Timescale.UTC)
	const result = meteorRadiantJ2000(DAILY_DRIFT_SOLUTION, context(oneDay, deg(1)), { solarLongitudeSearch: { step: 7, tolerance: TOLERANCE.time } })!
	expect(Math.min(result.radiant.rightAscension, 2 * Math.PI - result.radiant.rightAscension)).toBeCloseTo(0, 12)
	expect(toDeg(result.radiant.declination)).toBeCloseTo(9.75, 3)
	expect(result.extrapolated).toBe(true)
	expect(meteorRadiantJ2000(DAILY_DRIFT_SOLUTION, context(oneDay, deg(1)), { maxExtrapolationDays: 0.5, solarLongitudeSearch: { step: 7, tolerance: TOLERANCE.time } })).toBeUndefined()

	const polar = { ...SOLAR_DRIFT_SOLUTION, declination: deg(89), radiantDrift: { basis: 'solarLongitude', rightAscensionRate: 0, declinationRate: 2 } } satisfies MeteorShowerSolution
	expect(meteorRadiantJ2000(polar, context(REFERENCE_UTC, deg(101)))).toBeUndefined()
})

test('daily drift selects the preceding December reference for a January radiant', () => {
	const decemberReference = {
		...BASE_SOLUTION,
		referenceSolarLongitude: deg(270),
		rightAscension: deg(100),
		declination: 0,
		radiantDrift: { basis: 'day', rightAscensionRate: deg(1), declinationRate: 0 },
	} satisfies MeteorShowerSolution
	const january = timeYMDHMS(2024, 1, 5, 0, 0, 0, Timescale.UTC)
	const result = meteorRadiantJ2000(decemberReference, context(january, deg(284)), {
		maxExtrapolationDays: 20,
		solarLongitudeSearch: { step: 7, tolerance: TOLERANCE.time },
	})

	expect(result).toBeDefined()
	expect(toDeg(result!.radiant.rightAscension)).toBeGreaterThan(110)
	expect(toDeg(result!.radiant.rightAscension)).toBeLessThan(120)
})

test('J2000 radiant reduction agrees with frozen Astropy geometric coordinates', () => {
	const radiant = { rightAscension: deg(100), declination: deg(-20) }
	const ofDate = meteorRadiantOfDate(radiant, ASTROPY_EPOCH)
	const horizontal = meteorRadiantHorizontal(radiant, OBSERVER, ASTROPY_EPOCH)

	// Astropy 8.0.1 with FK5(J2000) -> FK5(date), then geometric AltAz, pressure=0 hPa.
	expect(toDeg(ofDate.rightAscension)).toBeCloseTo(toDeg(ASTROPY_RADIANT_OF_DATE.rightAscension), 2)
	expect(toDeg(ofDate.declination)).toBeCloseTo(toDeg(ASTROPY_RADIANT_OF_DATE.declination), 2)
	expect(Math.abs(horizontal.azimuth - ASTROPY_HORIZONTAL.azimuth)).toBeLessThan(TOLERANCE.externalAngle)
	expect(Math.abs(horizontal.altitude - ASTROPY_HORIZONTAL.altitude)).toBeLessThan(TOLERANCE.externalAngle)
	expect(horizontal.time).toBe(ASTROPY_EPOCH)

	const suppliedContext = meteorRadiantHorizontal(radiant, OBSERVER, ASTROPY_EPOCH, { time: ASTROPY_EPOCH, solarLongitude: 0, localSiderealTime: deg(123) })
	expect(suppliedContext.altitude).not.toBeCloseTo(horizontal.altitude, 8)
})

test('radiant vectors are unit vectors and degree construction normalizes RA', () => {
	const radiant = meteorRadiantDegrees(721, -20)
	const vector = meteorRadiantVector(radiant)
	expect(toDeg(radiant.rightAscension)).toBeCloseTo(1, 12)
	expect(Math.hypot(...vector)).toBeCloseTo(1, 14)
	expect(vector[2]).toBeCloseTo(Math.sin(deg(-20)), 14)
})

test('rise/transit/set classification reports a normal rising and setting radiant', () => {
	const day = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const ordinary = { ...BASE_SOLUTION, rightAscension: deg(100) } satisfies MeteorShowerSolution
	const risesAndSets = meteorRadiantRiseTransitSet(ordinary, OBSERVER, day, { step: 1 / 48 })
	expect(meteorRadiantVisibility(risesAndSets)).toBe('risesAndSets')
})

test('rise/transit/set classification distinguishes one-sided crossings', () => {
	const ordinary = { ...BASE_SOLUTION, rightAscension: deg(100) } satisfies MeteorShowerSolution
	const risesOnly = meteorRadiantRiseTransitSet(ordinary, OBSERVER, timeYMDHMS(2026, 6, 29, 8, 0, 0, Timescale.UTC), { window: 0.5, step: 1 / 48 })
	const setsOnly = meteorRadiantRiseTransitSet(ordinary, OBSERVER, timeYMDHMS(2026, 6, 29, 12, 0, 0, Timescale.UTC), { window: 0.5, step: 1 / 48 })
	expect(meteorRadiantVisibility(risesOnly)).toBe('risesOnly')
	expect(meteorRadiantVisibility(setsOnly)).toBe('setsOnly')
})

test('rise/transit/set classification reports circumpolar and unknown states', () => {
	const day = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const ordinary = { ...BASE_SOLUTION, rightAscension: deg(100) } satisfies MeteorShowerSolution
	const alwaysUp = meteorRadiantRiseTransitSet({ ...ordinary, declination: deg(-85) }, OBSERVER, day, { step: 1 / 48 })
	const alwaysDown = meteorRadiantRiseTransitSet({ ...ordinary, declination: deg(85) }, OBSERVER, day, { step: 1 / 48 })
	expect(meteorRadiantVisibility(alwaysUp)).toBe('alwaysUp')
	expect(meteorRadiantVisibility(alwaysDown)).toBe('alwaysDown')
	expect(meteorRadiantVisibility(undefined)).toBe('unknown')
}, 2000)
