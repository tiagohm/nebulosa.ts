import { describe, expect, test } from 'bun:test'
import { exoplanetArchiveTransitEphemeris } from '../../../src/adapters/catalogs/exoplanet.archive'
import { barycentricJulianDate } from '../../../src/astronomy/coordinates/correction'
import { eraEpv00 } from '../../../src/astronomy/coordinates/erfa/earth'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { earthObserverEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { exoplanetTransits, type TransitEphemeris, transitTimingUncertainty } from '../../../src/astronomy/events/exoplanet'
import { altitudeOf } from '../../../src/astronomy/events/horizon'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, tdb, timeNormalize, timeShift, timeSubtract, timeToDate, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, SPEED_OF_LIGHT_AU_DAY } from '../../../src/core/constants'
import { vecDot, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'

// Earth (geocenter) path from the ERFA epv00 barycentric state, the "builtin" ephemeris of Astropy.
const EPV00_EARTH = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.EARTH), (time) => {
	const t = tdb(time)
	return eraEpv00(t.day, t.fraction)[0]
})

// Sun path from the same theory: barycentric Earth minus heliocentric Earth.
const EPV00_SUN = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.SUN), (time) => {
	const t = tdb(time)
	const [bary, helio] = eraEpv00(t.day, t.fraction)
	return [vecMinus(bary[0], helio[0]), vecMinus(bary[1], helio[1])]
})

const LA_SILLA = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84)
const LA_SILLA_PATH = composeEphemerisPaths(EPV00_EARTH, earthObserverEphemerisPath(LA_SILLA, customEphemerisEndpoint('la-silla')))
const TEIDE = geodeticLocation(deg(-16.5097), deg(28.3), meter(2390), Ellipsoid.WGS84)
const TEIDE_PATH = composeEphemerisPaths(EPV00_EARTH, earthObserverEphemerisPath(TEIDE, customEphemerisEndpoint('teide')))

// NASA Exoplanet Archive `ps` row of WASP-12 b (default_flag = 1, Leonardi et al. 2024), queried 2026-10-15.
const WASP12_ROW = {
	pl_name: 'WASP-12 b',
	ra: 97.636645,
	dec: 29.6722662,
	pl_tranmid: 2457607.519305,
	pl_tranmiderr1: 0.000032,
	pl_tranmiderr2: -0.000032,
	pl_orbper: 1.091418901,
	pl_orbpererr1: 0.000000018,
	pl_orbpererr2: -0.000000018,
	pl_trandur: 3.001,
	pl_trandurerr1: 0.0043,
	pl_trandurerr2: -0.0043,
	pl_tsystemref: 'BJD-TDB',
}

const WASP12_DIRECTION = eraS2c(deg(97.636645), deg(29.6722662))

function wasp12() {
	const result = exoplanetArchiveTransitEphemeris(WASP12_ROW)
	if (!result.success) throw new Error(result.reason)
	return result.ephemeris
}

function sunAt(time: Time) {
	return vecMinus(sun(time)[0], earth(time)[0])
}

function moonAt(time: Time) {
	return moon(time)[0]
}

function seconds(a: Time, b: Time) {
	return timeSubtract(b, a) * DAYSEC
}

describe('timing uncertainty', () => {
	test('grows with the cycle count', () => {
		expect(transitTimingUncertainty(0, 3e-5, 2e-8)).toBe(3e-5)
		expect(transitTimingUncertainty(1000, 3e-5, 2e-8)).toBeCloseTo(Math.hypot(3e-5, 2e-5), 15)
		expect(transitTimingUncertainty(-1000, 3e-5, 2e-8)).toBeCloseTo(Math.hypot(3e-5, 2e-5), 15)
		// Long extrapolations are dominated by n·σ(P).
		expect(transitTimingUncertainty(1e6, 3e-5, 2e-8) / 2e-2).toBeCloseTo(1, 5)
		expect(transitTimingUncertainty(5)).toBe(0)
	})

	test('follows the covariance sign', () => {
		const independent = transitTimingUncertainty(100, 1e-4, 1e-6)
		const positive = 0.5 * 1e-4 * 1e-6
		expect(transitTimingUncertainty(100, 1e-4, 1e-6, positive)).toBeGreaterThan(independent)
		expect(transitTimingUncertainty(-100, 1e-4, 1e-6, positive)).toBeLessThan(independent)
		expect(transitTimingUncertainty(100, 1e-4, 1e-6, -positive)).toBeLessThan(independent)
		expect(transitTimingUncertainty(100, 1e-4, 1e-6, positive) ** 2).toBeCloseTo(1e-8 + 1e-8 + 200 * positive, 20)
	})

	test('a fully anti-correlated pair vanishes at n = σ(T0)/σ(P) without NaN', () => {
		expect(transitTimingUncertainty(100, 1e-4, 1e-6, -1e-10)).toBeCloseTo(0, 10)
		expect(transitTimingUncertainty(200, 1e-4, 1e-6, -1e-10)).toBeCloseTo(1e-4, 15)
	})
})

describe('exoplanet transits', () => {
	test('cycle centers stay on BJD_TDB and map to the Astropy reception instant', () => {
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const prediction = exoplanetTransits(wasp12(), WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1))

		expect(prediction.flags).toEqual(['missingCovariance'])
		expect(prediction.epoch.scale).toBe(Timescale.TDB)
		expect(prediction.events).toHaveLength(1)

		const [event] = prediction.events
		expect(event.cycle).toBe(3414)
		expect(event.center.scale).toBe(Timescale.TDB)
		expect(seconds(timeNormalize(2457607.519305 + 3414 * 1.091418901, 0, 0, Timescale.TDB), event.center)).toBeCloseTo(0, 4)
		expect(seconds(event.ingress, event.center)).toBeCloseTo((3.001 / 2) * 3600, 4)
		expect(seconds(event.center, event.egress)).toBeCloseTo((3.001 / 2) * 3600, 4)

		// Astropy 7.1.0 reception instants for the same ephemeris and site (see the correction tests). The
		// archive T0 as a double JD resolves only ≈ 20 µs, which Astropy avoided with a two-part date.
		expect(event.observedCenter.scale).toBe(Timescale.UTC)
		expect(seconds(timeNormalize(2461334, -0.3792656964579523, 0, Timescale.UTC), event.observedCenter)).toBeCloseTo(0, 4)
		expect(seconds(timeNormalize(2461334, -0.44178065951110057, 0, Timescale.UTC), event.observedIngress)).toBeCloseTo(0, 4)
		// The observed duration is shorter by the growth of the light-time correction over the transit (≈ 1 s).
		const delay = (time: Time) => barycentricJulianDate(time, WASP12_DIRECTION, LA_SILLA_PATH).correction
		expect(seconds(event.observedIngress, event.observedEgress)).toBeCloseTo(3.001 * 3600 - (delay(event.observedEgress) - delay(event.observedIngress)), 4)
		expect(seconds(barycentricJulianDate(event.observedEgress, WASP12_DIRECTION, LA_SILLA_PATH).time, event.egress)).toBeCloseTo(0, 6)

		// σ(T0) = 2.76 s and σ(P) = 1.6 ms grow to 6.0 s after 3414 cycles; contacts add σ(T14)/2.
		expect(event.centerUncertainty * DAYSEC).toBeCloseTo(Math.hypot(0.000032, 3414 * 0.000000018) * DAYSEC, 9)
		expect(event.contactUncertainty).toBeCloseTo(Math.hypot(event.centerUncertainty, 0.0043 / 48), 15)
		expect(seconds(event.start, event.observedIngress)).toBeCloseTo(event.contactUncertainty * DAYSEC, 2)
		expect(seconds(event.observedEgress, event.end)).toBeCloseTo(event.contactUncertainty * DAYSEC, 2)

		expect(event.visible).toHaveLength(1)
		expect(event.coverage).toBe(1)
		expect(event.transitCoverage).toBe(1)
		expect(event.feasible).toBe(true)
		expect(event.limitations).toEqual([])
	})

	test('a short-period chain returns consecutive cycles spaced by the period', () => {
		const ephemeris: TransitEphemeris = { epoch: timeNormalize(2461320.25, 0, 0, Timescale.TDB), reference: 'barycentric', period: 0.3, duration: 0.03, epochUncertainty: 1e-4, periodUncertainty: 1e-6, covariance: 0, durationUncertainty: 1e-4 }
		const start = timeYMDHMS(2026, 10, 10, 0, 0, 0)
		const { events, flags } = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 3))

		expect(flags).toEqual([])
		expect(events).toHaveLength(10)

		for (let i = 1; i < events.length; i++) {
			expect(events[i].cycle).toBe(events[i - 1].cycle + 1)
			expect(seconds(events[i - 1].center, events[i].center)).toBeCloseTo(0.3 * DAYSEC, 4)
			// The Rømer delay drifts by at most the Earth's orbital speed (≈ 1.0e-4 c) times the period.
			expect(Math.abs(seconds(events[i - 1].observedCenter, events[i].observedCenter) - 0.3 * DAYSEC)).toBeLessThan(0.3 * DAYSEC * 1.1e-4)
			expect(events[i].centerUncertainty).toBeGreaterThan(events[i - 1].centerUncertainty)
		}
	})

	test('growing uncertainty widens the span and trips the uncertainty limit', () => {
		const ephemeris = wasp12()
		const near = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const far = timeYMDHMS(2046, 10, 19, 12, 0, 0)
		const options = { maximumUncertainty: 10 / DAYSEC, timingSigma: 3 }

		const [early] = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, near, timeShift(near, 1), options).events
		const [late] = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, far, timeShift(far, 1), options).events

		expect(late.cycle).toBeGreaterThan(early.cycle)
		expect(late.centerUncertainty * DAYSEC).toBeGreaterThan(10)
		expect(seconds(late.start, late.observedIngress)).toBeCloseTo(3 * late.contactUncertainty * DAYSEC, 2)
		expect(seconds(late.start, late.end) - seconds(early.start, early.end)).toBeCloseTo(6 * (late.contactUncertainty - early.contactUncertainty) * DAYSEC, 1)
		expect(early.feasible).toBe(true)
		expect(late.coverage).toBe(1)
		expect(late.feasible).toBe(false)
		expect(late.limitations).toEqual(['timingUncertainty'])
	})

	test('a night spanning midnight is cut by altitude while twilight and the Moon stay clear', () => {
		const start = timeYMDHMS(2026, 10, 18, 19, 0, 0)
		const end = timeYMDHMS(2026, 10, 20, 7, 0, 0)
		const limit = deg(30)
		const constraints = { minimumAltitude: limit, maximumSunAltitude: deg(-18), minimumMoonSeparation: deg(20) }
		const options = { constraints, sunAt, moonAt, baselineBefore: 1 / 24, baselineAfter: 1 / 24 }
		const { events } = exoplanetTransits(wasp12(), WASP12_DIRECTION, TEIDE_PATH, TEIDE, start, end, options)

		expect(events.map((e) => e.cycle)).toEqual([3413, 3414])
		const [first, second] = events

		// Cycle 3413 runs from 22:12 to 03:12 UTC across midnight, and WASP-12 rises through 30° at 01:09.
		expect(timeToDate(first.start).slice(1, 4)).toEqual([10, 18, 22])
		expect(timeToDate(first.end).slice(1, 4)).toEqual([10, 19, 3])
		expect(first.visible).toHaveLength(1)
		expect(altitudeOf(WASP12_DIRECTION, first.visible[0].start, TEIDE)).toBeCloseTo(limit, 5)
		expect(seconds(first.visible[0].end, first.end)).toBeCloseTo(0, 3)
		expect(first.coverage).toBeCloseTo(seconds(first.visible[0].start, first.end) / seconds(first.start, first.end), 12)
		expect(first.coverage).toBeCloseTo(0.41, 2)
		expect(first.transitCoverage).toBeCloseTo(seconds(first.visible[0].start, first.observedEgress) / seconds(first.observedIngress, first.observedEgress), 12)
		expect(first.feasible).toBe(false)
		expect(first.limitations).toEqual(['targetAltitude'])

		// Cycle 3414 loses only the start of its pre-ingress baseline.
		expect(second.transitCoverage).toBe(1)
		expect(second.coverage).toBeCloseTo(0.861, 3)
		expect(second.feasible).toBe(false)
		expect(second.limitations).toEqual(['targetAltitude'])

		const relaxed = exoplanetTransits(wasp12(), WASP12_DIRECTION, TEIDE_PATH, TEIDE, start, end, { ...options, minimumCoverage: 0.8 }).events
		expect(relaxed.map((e) => e.feasible)).toEqual([false, true])
		expect(relaxed[1].limitations).toEqual(['targetAltitude'])
	})

	test('daylight and the horizon exclude whole events', () => {
		const start = timeYMDHMS(2026, 10, 15, 0, 0, 0)
		const constraints = { minimumAltitude: deg(20), maximumSunAltitude: deg(-12) }
		const { events } = exoplanetTransits(wasp12(), WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 2), { constraints, sunAt })

		// Cycles 3410 and 3411 fall in the La Silla afternoon and evening, before WASP-12 rises.
		expect(events.map((e) => e.cycle)).toEqual([3410, 3411])

		for (const event of events) {
			expect(event.visible).toEqual([])
			expect(event.coverage).toBe(0)
			expect(event.transitCoverage).toBe(0)
			expect(event.feasible).toBe(false)
			expect(event.limitations).toEqual(['targetAltitude', 'sunAltitude'])
		}
	})

	test('the Moon on the line of sight excludes the event', () => {
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const prediction = exoplanetTransits(wasp12(), WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1), { constraints: { minimumMoonSeparation: deg(10) }, moonAt: () => WASP12_DIRECTION })
		const [event] = prediction.events

		expect(event.visible).toEqual([])
		expect(event.coverage).toBe(0)
		expect(event.feasible).toBe(false)
		expect(event.limitations).toEqual(['moonSeparation'])
	})

	test('a span crossing the search window boundary is clipped and flagged', () => {
		const ephemeris = wasp12()
		const day = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const [event] = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, day, timeShift(day, 1)).events

		// The window opens ten minutes after ingress.
		const late = timeShift(event.observedIngress, 600 / DAYSEC)
		const [clipped] = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, late, timeShift(late, 1)).events
		expect(clipped.cycle).toBe(event.cycle)
		expect(clipped.limitations).toEqual(['searchWindow'])
		expect(seconds(late, clipped.visible[0].start)).toBeCloseTo(0, 6)
		expect(clipped.transitCoverage).toBeCloseTo(1 - 600 / seconds(clipped.observedIngress, clipped.observedEgress), 9)
		expect(clipped.coverage).toBeCloseTo(seconds(late, clipped.end) / seconds(clipped.start, clipped.end), 9)
		expect(clipped.feasible).toBe(false)
		expect(exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, late, timeShift(late, 1), { minimumCoverage: 0.9 }).events[0].feasible).toBe(true)

		// A window ending one second before the required span misses the event; one second after catches its edge.
		const before = timeShift(event.start, -1 / DAYSEC)
		const after = timeShift(event.start, 1 / DAYSEC)
		expect(exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, timeShift(before, -0.2), before).events).toEqual([])
		const [edge] = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, timeShift(after, -0.2), after).events
		expect(edge.cycle).toBe(event.cycle)
		expect(edge.coverage * seconds(edge.start, edge.end)).toBeCloseTo(1, 3)
		expect(edge.transitCoverage).toBe(0)
		expect(edge.limitations).toEqual(['searchWindow'])
	})

	test('a heliocentric epoch is shifted by the Sun-barycenter light time', () => {
		const barycentric = wasp12()
		const heliocentric: TransitEphemeris = { ...barycentric, reference: 'heliocentric' }
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const a = exoplanetTransits(barycentric, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1), { sun: EPV00_SUN })
		const b = exoplanetTransits(heliocentric, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1), { sun: EPV00_SUN })
		const shift = (vecDot(EPV00_SUN.stateAt(a.epoch)[0], WASP12_DIRECTION) / SPEED_OF_LIGHT_AU_DAY) * DAYSEC

		expect(Math.abs(shift)).toBeGreaterThan(0.1)
		expect(seconds(a.epoch, b.epoch)).toBeCloseTo(shift, 6)
		expect(seconds(a.events[0].center, b.events[0].center)).toBeCloseTo(shift, 6)
		expect(seconds(a.events[0].observedCenter, b.events[0].observedCenter)).toBeCloseTo(shift, 2)
		expect(() => exoplanetTransits(heliocentric, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1))).toThrow('sun path is required')
	})

	test('a UTC-stamped barycentric epoch is moved to TDB before cycles are counted', () => {
		const ephemeris = wasp12()
		const utcEpoch: TransitEphemeris = { ...ephemeris, epoch: timeNormalize(ephemeris.epoch.day, ephemeris.epoch.fraction, 0, Timescale.UTC) }
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const tdbPrediction = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1))
		const utcPrediction = exoplanetTransits(utcEpoch, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 1))

		// TDB - UTC was 32.184 s + 36 leap seconds in August 2016, plus the periodic TDB - TT term of ~1.6 ms.
		expect(seconds(tdbPrediction.epoch, utcPrediction.epoch)).toBeCloseTo(68.184, 2)
		expect(seconds(tdbPrediction.events[0].center, utcPrediction.events[0].center)).toBeCloseTo(seconds(tdbPrediction.epoch, utcPrediction.epoch), 6)
	})

	test('an empty window returns no events and every uncertainty flag', () => {
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const ephemeris: TransitEphemeris = { epoch: timeNormalize(2457607.519305, 0, 0, Timescale.TDB), reference: 'barycentric', period: 1.091418901, duration: 0.125 }
		const prediction = exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, start)

		expect(prediction.events).toEqual([])
		expect(prediction.flags).toEqual(['missingEpochUncertainty', 'missingPeriodUncertainty', 'missingDurationUncertainty'])
		expect(exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, timeShift(start, 1), start).events).toEqual([])
	})

	test('rejects ephemerides and options that would hang or mislead', () => {
		const ephemeris = wasp12()
		const start = timeYMDHMS(2026, 10, 19, 12, 0, 0)
		const end = timeShift(start, 1)
		const predict = (patch: Partial<TransitEphemeris>, options = {}) => exoplanetTransits({ ...ephemeris, ...patch }, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, end, options)

		expect(() => predict({ period: 0 })).toThrow('period must be positive')
		expect(() => predict({ period: Number.NaN })).toThrow('period must be positive')
		expect(() => predict({ period: Number.POSITIVE_INFINITY })).toThrow('period must be positive')
		expect(() => predict({ duration: 0 })).toThrow('duration must be within')
		expect(() => predict({ duration: ephemeris.period })).toThrow('duration must be within')
		expect(() => predict({ covariance: 2 * 0.000032 * 0.000000018 })).toThrow('covariance exceeds')
		expect(() => predict({ periodUncertainty: 2 })).toThrow('timing margin')
		expect(() => predict({}, { constraints: { maximumSunAltitude: 0 } })).toThrow('sun direction is required')
		expect(() => predict({}, { constraints: { minimumMoonSeparation: 0 } })).toThrow('moon direction is required')
		expect(() => predict({}, { sun: ephemerisPath(naifEphemerisEndpoint(Naif.EARTH), naifEphemerisEndpoint(Naif.SUN), EPV00_SUN.stateAt) })).toThrow('SSB-centered')
		expect(() => exoplanetTransits(ephemeris, WASP12_DIRECTION, LA_SILLA_PATH, LA_SILLA, start, timeShift(start, 30), { maximumEvents: 5 })).toThrow('too many transit events')
		// A huge stale-epoch uncertainty cannot step the cycle scan without bound.
		expect(() => predict({ epochUncertainty: 1e6 })).toThrow('too many transit events')
	})
})
