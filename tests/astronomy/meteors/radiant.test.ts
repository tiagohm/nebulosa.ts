import { expect, test } from 'bun:test'
// oxfmt-ignore
import { meteorRadiantDegrees, meteorRadiantHorizontal, meteorRadiantJ2000, meteorRadiantMaximumAltitude, meteorRadiantOfDate, meteorRadiantPath, meteorRadiantPathBetween, meteorRadiantPathSegmentsBetween, meteorRadiantRiseTransitSet, meteorRadiantVector, meteorRadiantVisibility } from '../../../src/astronomy/meteors/radiant'
import { meteorSolarLongitude, timeAtMeteorSolarLongitude } from '../../../src/astronomy/meteors/solar'
import type { MeteorComputationContext, MeteorShowerSolution } from '../../../src/astronomy/meteors/types'
import { timeShift, timeSubtract, timeYMDHMS, Timescale, type Time } from '../../../src/astronomy/time/time'
import { deg, toDeg } from '../../../src/math/units/angle'
import { ASTROPY_HORIZONTAL, ASTROPY_RADIANT_OF_DATE, BASE_SOLUTION, DAILY_DRIFT_SOLUTION, MISSING_RADIANT_SOLUTION, OBSERVER, REFERENCE_UTC, SITE_EPOCH, SITE_EPOCH_END, SOLAR_DRIFT_SOLUTION, TOLERANCE } from './util'

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

test('radiant path applies drift across ordinary and wrapped longitude intervals', () => {
	const ordinary = meteorRadiantPath(SOLAR_DRIFT_SOLUTION, deg(99), deg(101), deg(1))
	expect(ordinary).toHaveLength(3)
	for (let index = 0; index < ordinary.length; index++) {
		expect(toDeg(ordinary[index].solarLongitude)).toBeCloseTo(99 + index, 12)
		expect(toDeg(ordinary[index].rightAscension)).toBeCloseTo([357, 359, 1][index], 12)
		expect(toDeg(ordinary[index].declination)).toBeCloseTo(9 + index, 12)
	}
	expect(ordinary.map((point) => point.extrapolated)).toEqual([true, false, true])

	const wrapped = meteorRadiantPath({ ...BASE_SOLUTION, radiantDrift: undefined }, deg(359), deg(1), deg(1))
	for (let index = 0; index < wrapped.length; index++) expect(toDeg(wrapped[index].solarLongitude)).toBeCloseTo([359, 0, 1][index], 12)
	expect(wrapped.every((point) => point.rightAscension === BASE_SOLUTION.rightAscension)).toBe(true)
	expect(wrapped.every((point) => point.extrapolated === false)).toBe(true)
	expect(() => meteorRadiantPath(BASE_SOLUTION, 0, 1, 0)).toThrow('finite and positive')
	expect(() => meteorRadiantPath(DAILY_DRIFT_SOLUTION, 0, 1, deg(1))).toThrow('absolute time')
})

test('absolute-time radiant paths sample fixed, solar and daily drift through the final endpoint', () => {
	const start = timeAtMeteorSolarLongitude(2024, DAILY_DRIFT_SOLUTION.referenceSolarLongitude, { step: 7, tolerance: TOLERANCE.time })
	const end = timeShift(start, 2.5)
	const daily = meteorRadiantPathBetween(DAILY_DRIFT_SOLUTION, start, end, { step: 1, solarLongitudeSearch: { step: 7, tolerance: TOLERANCE.time } })

	expect(daily).toHaveLength(4)
	expect(daily.at(-1)!.time).toBe(end)
	expect(daily.map((point) => point.extrapolated)).toEqual([false, true, true, true])
	expect(meteorRadiantPathBetween(DAILY_DRIFT_SOLUTION, timeShift(start, -1), start, { step: 1, solarLongitudeSearch: { step: 7, tolerance: TOLERANCE.time } }).map((point) => point.extrapolated)).toEqual([true, false])
	for (let index = 0; index < daily.length; index++) {
		expect(daily[index].solarLongitude).toBeCloseTo(meteorSolarLongitude(daily[index].time), 14)
		expect(toDeg(daily[index].rightAscension)).toBeCloseTo([359, 0, 1, 1.5][index], 5)
		expect(toDeg(daily[index].declination)).toBeCloseTo([10, 9.75, 9.5, 9.375][index], 5)
	}

	const fixed = meteorRadiantPathBetween(BASE_SOLUTION, start, end, { step: 1 })
	expect(fixed).toHaveLength(4)
	expect(fixed.every((point) => point.rightAscension === BASE_SOLUTION.rightAscension)).toBe(true)
	expect(fixed.every((point) => point.extrapolated === false)).toBe(true)
	const solarStart = timeAtMeteorSolarLongitude(2024, SOLAR_DRIFT_SOLUTION.referenceSolarLongitude, { step: 7, tolerance: TOLERANCE.time })
	const solar = meteorRadiantPathBetween(SOLAR_DRIFT_SOLUTION, solarStart, timeShift(solarStart, 2.5), { step: 1 })
	expect(solar).toHaveLength(4)
	for (const point of solar) {
		expect(point).toMatchObject(meteorRadiantJ2000(SOLAR_DRIFT_SOLUTION, context(point.time, point.solarLongitude))!.radiant)
		expect(point).toMatchObject(meteorRadiantPath(SOLAR_DRIFT_SOLUTION, point.solarLongitude, point.solarLongitude, deg(1))[0])
	}
})

test('segmented time paths preserve unavailable gaps without changing the flat path', () => {
	const start = timeAtMeteorSolarLongitude(2024, 0, { step: 7, tolerance: TOLERANCE.time })
	const gapSolution = {
		...BASE_SOLUTION,
		referenceSolarLongitude: 0,
		declination: 0,
		radiantDrift: { basis: 'solarLongitude', rightAscensionRate: 0, declinationRate: 1 },
	} satisfies MeteorShowerSolution
	const end = timeShift(start, 365)
	const segments = meteorRadiantPathSegmentsBetween(gapSolution, start, end, { step: 60 })
	const flat = meteorRadiantPathBetween(gapSolution, start, end, { step: 60 })

	expect(segments).toHaveLength(2)
	expect(segments.every((segment) => segment.length > 0)).toBe(true)
	expect(flat).toHaveLength(segments[0].length + segments[1].length)
	expect(flat[0].rightAscension).toBeCloseTo(segments[0][0].rightAscension, 14)
	expect(flat.at(-1)!.rightAscension).toBeCloseTo(segments[1].at(-1)!.rightAscension, 14)
	expect(meteorRadiantPathSegmentsBetween(BASE_SOLUTION, start, end, { step: 60 })).toEqual([meteorRadiantPathBetween(BASE_SOLUTION, start, end, { step: 60 })])
	expect(meteorRadiantPathSegmentsBetween(MISSING_RADIANT_SOLUTION, start, end, { step: 60 })).toEqual([])
	expect(meteorRadiantPathSegmentsBetween(gapSolution, start, timeShift(start, 730), { step: 60 })).toHaveLength(3)
})

test('segmented time paths preserve unavailable gaps at both interval edges', () => {
	const reference = timeAtMeteorSolarLongitude(2024, DAILY_DRIFT_SOLUTION.referenceSolarLongitude, { step: 7, tolerance: TOLERANCE.time })
	const options = { step: 1, maxExtrapolationDays: 0.1, solarLongitudeSearch: { step: 7, tolerance: TOLERANCE.time } } as const
	const gapAtStart = meteorRadiantPathSegmentsBetween(DAILY_DRIFT_SOLUTION, timeShift(reference, -2), reference, options)
	const gapAtEnd = meteorRadiantPathSegmentsBetween(DAILY_DRIFT_SOLUTION, reference, timeShift(reference, 2), options)

	expect(gapAtStart).toHaveLength(1)
	expect(gapAtStart[0]).toHaveLength(1)
	expect(gapAtStart[0][0].time).toBe(reference)
	expect(gapAtEnd).toHaveLength(1)
	expect(gapAtEnd[0]).toHaveLength(1)
	expect(timeSubtract(gapAtEnd[0][0].time, reference)).toBeCloseTo(0, 14)
})

test('absolute-time radiant paths handle year boundaries, unavailable samples and limits', () => {
	const decemberReference = {
		...BASE_SOLUTION,
		referenceSolarLongitude: deg(270),
		rightAscension: deg(359),
		declination: deg(80),
		radiantDrift: { basis: 'day', rightAscensionRate: deg(1), declinationRate: deg(1) },
	} satisfies MeteorShowerSolution
	const start = timeYMDHMS(2023, 12, 31, 0, 0, 0, Timescale.UTC)
	const end = timeYMDHMS(2024, 1, 2, 0, 0, 0, Timescale.UTC)
	const path = meteorRadiantPathBetween(decemberReference, start, end, { step: 0.5, maxExtrapolationDays: 20 })

	expect(path.length).toBeLessThan(5)
	expect(path.every((point) => point.declination <= Math.PI / 2)).toBe(true)
	expect(path.some((point) => point.rightAscension < deg(20))).toBe(true)
	expect(meteorRadiantPathBetween(decemberReference, start, end, { step: 0.5, maxExtrapolationDays: 0.1 })).toEqual([])
	expect(meteorRadiantPathBetween(BASE_SOLUTION, end, start)).toEqual([])
	expect(() => meteorRadiantPathBetween(BASE_SOLUTION, start, end, { step: 0 })).toThrow('finite and positive')
	expect(() => meteorRadiantPathBetween(BASE_SOLUTION, start, end, { step: 1e-7 })).toThrow('too many points')
})

test('published Perseid and Geminid drift directions retain their signs and scales', () => {
	// IMO 2024 calendar mean radiants and daily drifts, converted with 0.9856 solar degree/day.
	const showers = [
		{ reference: 140, rightAscension: 48, declination: 58, rightAscensionDaily: 1.4, declinationDaily: 0.25 },
		{ reference: 262, rightAscension: 112, declination: 33, rightAscensionDaily: 1, declinationDaily: -0.1 },
	] as const
	for (const shower of showers) {
		const solution = {
			...BASE_SOLUTION,
			referenceSolarLongitude: deg(shower.reference),
			rightAscension: deg(shower.rightAscension),
			declination: deg(shower.declination),
			radiantDrift: {
				basis: 'solarLongitude',
				rightAscensionRate: shower.rightAscensionDaily / 0.9856,
				declinationRate: shower.declinationDaily / 0.9856,
			},
		} satisfies MeteorShowerSolution
		const before = meteorRadiantJ2000(solution, context(REFERENCE_UTC, deg(shower.reference - 2)))!.radiant
		const after = meteorRadiantJ2000(solution, context(REFERENCE_UTC, deg(shower.reference + 2)))!.radiant
		expect(toDeg(after.rightAscension - before.rightAscension)).toBeCloseTo((4 * shower.rightAscensionDaily) / 0.9856, 10)
		expect(toDeg(after.declination - before.declination)).toBeCloseTo((4 * shower.declinationDaily) / 0.9856, 10)
	}
})

test('radiant maximum altitude refines a visible interval and rejects an always-down radiant', () => {
	const maximum = meteorRadiantMaximumAltitude(BASE_SOLUTION, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { step: 1 / 48 })
	expect(maximum).toBeDefined()
	let bruteAltitude = Number.NEGATIVE_INFINITY
	for (let index = 0; index <= 240; index++) {
		const time = timeShift(SITE_EPOCH, (index * 2) / (24 * 240))
		const horizontal = meteorRadiantHorizontal(BASE_SOLUTION, OBSERVER, time)
		bruteAltitude = Math.max(bruteAltitude, horizontal.altitude)
	}
	expect(Math.abs(maximum!.altitude - bruteAltitude)).toBeLessThan(deg(0.01))
	expect(maximum!.azimuth).toBeGreaterThanOrEqual(0)
	expect(meteorRadiantMaximumAltitude({ ...BASE_SOLUTION, declination: deg(85) }, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { step: 1 / 48 })).toBeUndefined()
	expect(() => meteorRadiantMaximumAltitude(BASE_SOLUTION, OBSERVER, SITE_EPOCH, SITE_EPOCH_END, { step: 0 })).toThrow('finite and positive')
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

test('daily drift caches the annual reference across sampled contexts', () => {
	for (let hour = 0; hour < 10; hour++) {
		const time = timeShift(REFERENCE_UTC, hour / 24)
		expect(meteorRadiantJ2000(DAILY_DRIFT_SOLUTION, context(time, deg(283)))).toBeDefined()
	}
	const december = timeYMDHMS(2024, 12, 30, 0, 0, 0, Timescale.UTC)
	expect(meteorRadiantJ2000(DAILY_DRIFT_SOLUTION, context(december, deg(279)))).toBeDefined()
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
