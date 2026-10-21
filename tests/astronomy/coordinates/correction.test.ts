import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { annualAberration, barycentricJulianDate, lightTravelTime, observerState, radialVelocityCorrection, receptionFromBarycentricJulianDate } from '../../../src/astronomy/coordinates/correction'
import { eraEpv00 } from '../../../src/astronomy/coordinates/erfa/earth'
import { eraAb, eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readSpk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../../../src/astronomy/ephemeris/path'
import { earthObserverEphemerisPath, spkEphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { exposureInterval } from '../../../src/astronomy/time/exposure'
import { type Time, tdb, Timescale, timeNormalize, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, PI, SCHWARZSCHILD_RADIUS_OF_THE_SUN, SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { vecAngle, vecClone, vecCross, vecDot, vecLength, vecMinus, vecMulScalar, vecNegate, vecNormalize, vecRotateByRodrigues, vecZero } from '../../../src/math/linear-algebra/vec3'
import { deg, hour, toArcsec, toDeg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { toKilometerPerSecond } from '../../../src/math/units/velocity'
import { downloadPerTag } from '../../download'

await downloadPerTag('spk')

// La Silla Observatory.
const LOCATION = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
const TIME = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC)
const TDB = tdb(TIME)
const EARTH = eraEpv00(TDB.day, TDB.fraction)
const [BARYCENTRIC, HELIOCENTRIC] = EARTH

// The radial-velocity correction is exactly the projection of the observer
// velocity onto the line of sight, so aiming at the velocity vector itself must
// return its full magnitude, and the opposite direction its negative.
test('radial velocity correction equals the observer speed along its own direction', () => {
	const [, vel] = observerState(TIME, BARYCENTRIC, LOCATION)
	const speed = vecLength(vel)
	const [ra, dec] = eraC2s(vel[0], vel[1], vel[2])

	expect(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION)).toBeCloseTo(speed, 12)
	expect(radialVelocityCorrection(ra + PI, -dec, TIME, BARYCENTRIC, LOCATION)).toBeCloseTo(-speed, 12)
})

// Without a location the geocenter is used, so observerState returns the copy of Earth
// state; adding a site shifts the position by about one Earth radius.
test('observerState falls back to the geocenter when no location is given', () => {
	const geocentric = observerState(TIME, BARYCENTRIC, undefined)
	expect(geocentric).toEqual(BARYCENTRIC)
	expect(geocentric).not.toBe(BARYCENTRIC)
	expect(geocentric[0]).not.toBe(BARYCENTRIC[0])
	expect(geocentric[1]).not.toBe(BARYCENTRIC[1])
	const initialPosition = BARYCENTRIC[0][0]
	const initialVelocity = BARYCENTRIC[1][0]
	geocentric[0][0] = 99
	geocentric[1][0] = 99
	expect(BARYCENTRIC[0][0]).toBe(initialPosition)
	expect(BARYCENTRIC[1][0]).toBe(initialVelocity)

	const topocentric = observerState(TIME, BARYCENTRIC, LOCATION)
	expect(topocentric[0]).not.toBe(BARYCENTRIC[0])
	expect(topocentric[1]).not.toBe(BARYCENTRIC[1])
	const offset = vecLength([topocentric[0][0] - BARYCENTRIC[0][0], topocentric[0][1] - BARYCENTRIC[0][1], topocentric[0][2] - BARYCENTRIC[0][2]])
	// La Silla sits ~6378 km from the geocenter, i.e. ~4.3e-5 AU.
	expect(offset).toBeGreaterThan(3e-5)
	expect(offset).toBeLessThan(5e-5)
})

// Same projection identity for the light-travel time using the observer
// position instead of its velocity.
test('light travel time equals the observer distance along its own direction', () => {
	const [pos] = observerState(TIME, BARYCENTRIC, LOCATION)
	const [ra, dec] = eraC2s(pos[0], pos[1], pos[2])
	const ltt = lightTravelTime(ra, dec, TIME, BARYCENTRIC, LOCATION)

	// |pos|/c in days; |pos| ~ 1 AU so ltt ~ 1 AU light time ~ 0.0058 days.
	expect(ltt).toBeGreaterThan(0)
	expect(ltt).toBeLessThan(0.006)
	expect(lightTravelTime(ra + PI, -dec, TIME, BARYCENTRIC, LOCATION)).toBeCloseTo(-ltt, 12)
})

// Physical magnitudes: the annual term dominates (Earth orbital speed ~29.8
// km/s), the diurnal term is at most ~0.46 km/s, and the barycentric light
// travel time never exceeds the ~8.3 min one-AU light time.
test('corrections stay within physical bounds', () => {
	const ra = hour(5.5)
	const dec = deg(-5)

	const rv = toKilometerPerSecond(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION))
	expect(Math.abs(rv)).toBeLessThan(30.5)

	const ltt = lightTravelTime(ra, dec, TIME, BARYCENTRIC, LOCATION)
	expect(Math.abs(ltt)).toBeLessThan(0.0058)
})

// Adding the observing site only introduces the diurnal rotation term, which is
// bounded by the equatorial ground speed (~0.465 km/s).
test('topocentric correction differs from geocentric only by the diurnal term', () => {
	const ra = hour(5.5)
	const dec = deg(-5)

	const geocentric = toKilometerPerSecond(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC))
	const topocentric = toKilometerPerSecond(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION))

	expect(Math.abs(topocentric - geocentric)).toBeLessThan(0.466)
})

// Heliocentric and barycentric references differ by the Sun's barycentric
// motion, which is small but non-zero.
test('heliocentric and barycentric corrections differ', () => {
	const ra = hour(5.5)
	const dec = deg(-5)

	const bary = radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION)
	const helio = radialVelocityCorrection(ra, dec, TIME, HELIOCENTRIC, LOCATION)

	expect(bary).not.toBe(helio)
	expect(Number.isFinite(bary)).toBe(true)
	expect(Number.isFinite(helio)).toBe(true)
})

// annualAberration wraps eraAb, deriving v/c and the Lorentz factor from the
// physical velocity, and must reproduce a direct eraAb call exactly.
test('annual aberration matches a direct eraAb call and stays within ~20.5 arcsec', () => {
	const direction = vecNormalize([1, 0.5, 0.2])
	const velocity = BARYCENTRIC[1]
	const sunDistance = vecLength(HELIOCENTRIC[0])

	const proper = annualAberration(direction, velocity, sunDistance)

	const vOverC: [number, number, number] = [velocity[0] / SPEED_OF_LIGHT_AU_DAY, velocity[1] / SPEED_OF_LIGHT_AU_DAY, velocity[2] / SPEED_OF_LIGHT_AU_DAY]
	const bm1 = Math.sqrt(1 - (vOverC[0] * vOverC[0] + vOverC[1] * vOverC[1] + vOverC[2] * vOverC[2]))
	const expected = eraAb(direction, vOverC, sunDistance, bm1)

	expect(proper[0]).toBeCloseTo(expected[0], 15)
	expect(proper[1]).toBeCloseTo(expected[1], 15)
	expect(proper[2]).toBeCloseTo(expected[2], 15)

	// The annual aberration shift never exceeds the aberration constant ~20.5 arcsec.
	expect(toArcsec(vecAngle(direction, proper))).toBeLessThan(20.6)
})

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

// La Silla on WGS84, matching EarthLocation.from_geodetic in the Astropy reference.
const LA_SILLA = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84)
const LA_SILLA_PATH = composeEphemerisPaths(EPV00_EARTH, earthObserverEphemerisPath(LA_SILLA, customEphemerisEndpoint('la-silla')))
const SOURCE = eraS2c(hour(5.5), deg(-5))

// UTC instant observed from La Silla, carrying the site for the topocentric TDB-TT term.
function laSilla(second: number, year: number = 2020, month: number = 1, day: number = 1, hour: number = 0, minute: number = 0) {
	const time = timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
	time.location = LA_SILLA
	return time
}

// Seconds between two BJD_TDB instants.
function bjdSeconds(a: Time, b: Time) {
	return timeSubtract(b, a) * DAYSEC
}

// Reference: Astropy 7.1.0 (pyerfa 2.0.1.5, bundled IERS-B, auto_download off), t = Time(iso,
// scale='utc', location=loc) with loc = EarthLocation.from_geodetic(-70.7313°, -29.2563°, 2400 m,
// 'WGS84'), source n = ICRS (82.5°, -5°):
//   topocentric: t.tdb + ((get_body_barycentric('earth', t.tdb) + loc.get_gcrs_posvel(t.tdb)[0]) · n) / c
//   geocentric: Time(iso, scale='utc').tdb + light_travel_time(n, 'barycentric', location=geocenter)
// Astropy's topocentric light_travel_time differs by +1.71 µs because its GCRS -> ICRS transform
// de-aberrates the 6400 km site vector as if it were an apparent direction; the geometric sum is used.
test('BJD_TDB matches Astropy for a topocentric observer', () => {
	const bjd = barycentricJulianDate(laSilla(0, 2024, 3, 10, 3, 0), SOURCE, LA_SILLA_PATH)

	expect(bjd.time.scale).toBe(Timescale.TDB)
	expect(bjd.time.day).toBe(2460380)
	expect(bjd.time.fraction).toBeCloseTo(-0.3740622750982998, 12)
	expect(bjd.romer).toBeCloseTo(11.833943070669527, 6)
	expect(bjd.reception.scale).toBe(Timescale.TDB)
	expect(bjd.reception.fraction).toBeCloseTo(-0.3741992420319881, 15)
	expect(bjd.shapiro).toBe(0)
	expect(bjd.correction).toBe(bjd.romer)
	expect(bjdSeconds(bjd.reception, bjd.time)).toBeCloseTo(bjd.correction, 6)
	expect(bjd.model).toEqual({ romer: 'planeWave', shapiro: false, tdb: 'topocentric' })
	expect(bjd.quality.earthOrientation).toBe('tabulated')
	expect(bjd.quality.occultedBySun).toBe(false)
	expect(bjd.errorBudget.earthOrientation).toBe(0)
	expect(bjd.errorBudget.tdb).toBe(0)
	// Near quadrature the omitted solar Shapiro term (Sun ≈ SSB) is sub-microsecond.
	expect(toDeg(bjd.quality.sunElongation)).toBeCloseTo(91.36, 1)
	expect(bjd.errorBudget.shapiro).toBeGreaterThan(0)
	expect(bjd.errorBudget.shapiro).toBeLessThan(1e-6)
	expect(bjd.errorBudget.total).toBe(bjd.errorBudget.shapiro)
})

test('BJD_TDB matches Astropy for a geocentric observer and differs from the site by its projected offset', () => {
	const time = timeYMDHMS(2024, 3, 10, 3, 0, 0, Timescale.UTC)
	const geocentric = barycentricJulianDate(time, SOURCE, EPV00_EARTH)

	expect(geocentric.time.day).toBe(2460380)
	expect(geocentric.time.fraction).toBeCloseTo(-0.37406239340938713, 12)
	expect(geocentric.romer).toBeCloseTo(11.823720654978127, 6)
	expect(geocentric.model.tdb).toBe('geocentric')
	expect(geocentric.quality.earthOrientation).toBe('notRequired')
	expect(geocentric.errorBudget.earthOrientation).toBe(0)
	expect(geocentric.errorBudget.tdb).toBe(0)

	const topocentric = barycentricJulianDate(laSilla(0, 2024, 3, 10, 3, 0), SOURCE, LA_SILLA_PATH)
	const [site] = observerState(topocentric.reception, [vecZero(), vecZero()], LA_SILLA)
	const projected = (vecDot(site, SOURCE) / SPEED_OF_LIGHT_AU_DAY) * DAYSEC

	// Astropy: 11.833943070669527 - 11.823720654978127 s.
	expect(topocentric.romer - geocentric.romer).toBeCloseTo(0.0102224156914, 9)
	expect(topocentric.romer - geocentric.romer).toBeCloseTo(projected, 6)
	// The BJD difference also carries the ~µs topocentric TDB-TT term.
	expect(Math.abs(bjdSeconds(geocentric.time, topocentric.time) - projected)).toBeLessThan(2.1e-6)

	// A site path without time.location omits the topocentric TDB term and budgets it.
	const omitted = barycentricJulianDate(time, SOURCE, LA_SILLA_PATH)
	expect(omitted.model.tdb).toBe('geocentric')
	expect(omitted.errorBudget.tdb).toBeCloseTo(2.026e-6, 9)
})

// The 2016-12-31 leap second: three UTC labels one SI second apart, including 23:59:60.5.
// Astropy gives the BJD_TDB of each (the test EOP table starts in 2020, so UT1-UTC = 0 instead of
// -0.41 or +0.59 s costs up to 0.8 µs); their separations are 1 s plus a ~1e-4 s Rømer drift.
test('BJD_TDB stays continuous across a leap second', () => {
	const before = barycentricJulianDate(laSilla(59.5, 2016, 12, 31, 23, 59), SOURCE, LA_SILLA_PATH)
	const inside = barycentricJulianDate(laSilla(60.5, 2016, 12, 31, 23, 59), SOURCE, LA_SILLA_PATH)
	const after = barycentricJulianDate(laSilla(0.5, 2017, 1, 1, 0, 0), SOURCE, LA_SILLA_PATH)

	expect(before.time.day).toBe(2457755)
	expect(before.time.fraction).toBeCloseTo(-0.49446226023496775, 10)
	expect(inside.time.day).toBe(2457755)
	expect(inside.time.fraction).toBeCloseTo(-0.49445068648472656, 10)
	expect(after.time.day).toBe(2457755)
	expect(after.time.fraction).toBeCloseTo(-0.4944391127344864, 10)

	expect(bjdSeconds(before.time, inside.time)).toBeCloseTo(1, 3)
	expect(bjdSeconds(inside.time, after.time)).toBeCloseTo(1, 3)
	expect(bjdSeconds(before.reception, after.reception)).toBeCloseTo(2, 6)
})

// Reference: Astropy 7.1.0 (pyerfa 2.0.1.5, builtin ephemeris, auto_download off) iterating
// t.tdb + ((get_body_barycentric('earth', t.tdb) + loc.get_gcrs_posvel(t.tdb)[0]) · n) / c = B for La
// Silla, n = ICRS (97.636645°, 29.6722662°) of WASP-12, and B = cycle 3414 of T0 = 2457607.519305
// BJD_TDB, P = 1.091418901 d (Leonardi et al. 2024): UTC 2026-10-20T02:53:51.444.
test('BJD_TDB inverts to the UTC reception instant of Astropy', () => {
	const wasp12 = eraS2c(deg(97.636645), deg(29.6722662))
	const bjd = timeNormalize(2461334, -0.3765669860003982, 0, Timescale.TDB)
	const reception = receptionFromBarycentricJulianDate(bjd, wasp12, LA_SILLA_PATH, LA_SILLA)

	expect(reception.scale).toBe(Timescale.UTC)
	expect(reception.location).toBe(LA_SILLA)
	expect(bjdSeconds(timeNormalize(2461334, -0.3792656964579523, 0, Timescale.UTC), reception)).toBeCloseTo(0, 6)
	expect(bjdSeconds(bjd, barycentricJulianDate(reception, wasp12, LA_SILLA_PATH).time)).toBeCloseTo(0, 6)

	// The Shapiro term and a geocentric clock round-trip through the same options.
	const shapiro = receptionFromBarycentricJulianDate(bjd, wasp12, LA_SILLA_PATH, LA_SILLA, { sun: EPV00_SUN })
	expect(bjdSeconds(bjd, barycentricJulianDate(shapiro, wasp12, LA_SILLA_PATH, { sun: EPV00_SUN }).time)).toBeCloseTo(0, 6)
	const geocentric = receptionFromBarycentricJulianDate(bjd, wasp12, EPV00_EARTH)
	expect(geocentric.location).toBeUndefined()
	expect(bjdSeconds(bjd, barycentricJulianDate(geocentric, wasp12, EPV00_EARTH).time)).toBeCloseTo(0, 6)

	expect(() =>
		receptionFromBarycentricJulianDate(
			bjd,
			wasp12,
			ephemerisPath(naifEphemerisEndpoint(Naif.SUN), naifEphemerisEndpoint(Naif.EARTH), () => [vecZero(), vecZero()]),
		),
	).toThrow('SSB-centered')
})

test('shutter latency and timestamp uncertainty flow from the exposure midpoint into BJD_TDB', () => {
	const time = laSilla(0, 2020, 1, 1, 0, 0)
	const nominal = exposureInterval({ time, reference: 'start', duration: 300 })
	const delayed = exposureInterval({ time, reference: 'start', duration: 300, openLatency: 0.2, closeLatency: 0.05, uncertainty: 0.01 })

	const a = barycentricJulianDate(nominal.midpoint, SOURCE, LA_SILLA_PATH)
	const b = barycentricJulianDate(delayed.midpoint, SOURCE, LA_SILLA_PATH, { timestampUncertainty: delayed.uncertainty })

	// The latency moves the midpoint by (0.2 + 0.05) / 2 s; the Rømer drift is ~1e-4 s per second.
	expect(bjdSeconds(a.time, b.time)).toBeCloseTo(0.125, 4)
	expect(b.errorBudget.timestamp).toBe(0.01)
	expect(b.errorBudget.total).toBeCloseTo(Math.hypot(0.01, b.errorBudget.earthOrientation, b.errorBudget.tdb, b.errorBudget.shapiro), 15)
	expect(bjdSeconds(barycentricJulianDate(time, SOURCE, LA_SILLA_PATH).time, a.time)).toBeCloseTo(150, 1)
})

// Shapiro correction = 2GM/c³ · ln(|s| + s · n), s = Sun -> observer in AU, 2GM/c³ ≈ 9.851 µs.
test('solar Shapiro delay follows the logarithmic elongation law and is clamped behind the Sun', () => {
	const time = laSilla(0)
	const reference = barycentricJulianDate(time, SOURCE, LA_SILLA_PATH)
	const observer = vecClone(LA_SILLA_PATH.stateAt(reference.reception)[0])
	const s = vecMinus(observer, EPV00_SUN.stateAt(reference.reception)[0])
	const toSun = vecNormalize(vecNegate(s))
	const scale = (SCHWARZSCHILD_RADIUS_OF_THE_SUN / SPEED_OF_LIGHT_AU_DAY) * DAYSEC
	const distance = vecLength(s)

	expect(scale * 1e6).toBeCloseTo(9.851, 4)

	// Perpendicular to the Sun direction: |s| + s · n = |s|.
	const perpendicular = vecNormalize(vecCross(toSun, [0, 0, 1]))
	const side = barycentricJulianDate(time, perpendicular, LA_SILLA_PATH, { sun: EPV00_SUN })
	expect(side.model.shapiro).toBe(true)
	expect(toDeg(side.quality.sunElongation)).toBeCloseTo(90, 9)
	expect(side.shapiro).toBeCloseTo(scale * Math.log(distance), 15)
	expect(side.correction).toBeCloseTo(side.romer + side.shapiro, 12)
	expect(side.errorBudget.shapiro).toBe(0)

	// Anti-Sun direction: the smallest delay, +6.7 µs correction at ~0.983 AU.
	const opposite = barycentricJulianDate(time, vecNegate(toSun), LA_SILLA_PATH, { sun: EPV00_SUN })
	expect(opposite.shapiro).toBeCloseTo(scale * Math.log(2 * distance), 15)

	// 1° from the Sun center: ≈ -87 µs.
	const near = barycentricJulianDate(time, vecRotateByRodrigues(toSun, perpendicular, deg(1)), LA_SILLA_PATH, { sun: EPV00_SUN })
	expect(toDeg(near.quality.sunElongation)).toBeCloseTo(1, 9)
	expect(near.shapiro).toBeCloseTo(scale * Math.log(distance * (1 - Math.cos(deg(1)))), 12)
	expect(near.shapiro * 1e6).toBeCloseTo(-86.75, 1)
	expect(near.quality.occultedBySun).toBe(false)

	// Without the Sun path the same geometry is only budgeted, by a bound covering the applied term.
	const unmodeled = barycentricJulianDate(time, vecRotateByRodrigues(toSun, perpendicular, deg(1)), LA_SILLA_PATH)
	expect(unmodeled.shapiro).toBe(0)
	expect(unmodeled.errorBudget.shapiro).toBeGreaterThan(Math.abs(near.shapiro))

	// Straight through the Sun center: finite, flagged, and clamped at the limb (≈ -112 µs).
	const behind = barycentricJulianDate(time, toSun, LA_SILLA_PATH, { sun: EPV00_SUN })
	const limb = Math.asin(SUN_RADIUS_AU / distance)
	expect(behind.quality.occultedBySun).toBe(true)
	expect(behind.quality.sunElongation).toBeCloseTo(0, 12)
	expect(behind.shapiro).toBeCloseTo(scale * Math.log(distance * (1 - Math.cos(limb))), 12)
	expect(behind.shapiro * 1e6).toBeCloseTo(-112.48, 1)
	expect(Number.isFinite(behind.time.fraction)).toBe(true)
})

// d - |d·n - r| converges to r · n for a distant source; at 1 pc the wavefront curvature reaches
// (1 AU)² / (2 c · 1 pc) ≈ 1.2 ms, here 0.36 ms. Its second-order form misses a ~1e-9 s cubic term.
// Observer at SSB -> [1, 0, 0] AU and the Sun at SSB -> [0, 0.01, 0] AU. Reference: PINT 1.1.8 (astropy
// 8.0.1) SolarSystemShapiro.ss_obj_shapiro_delay(observer -> Sun, n, GM☉/c³), whose delay is the
// negated correction. With the SSB as the Sun proxy the quadrature term would read exactly 0 and the
// 1° term -86.6 µs, so the omitted term is budgeted by a bound over every Sun within 0.011 AU of the SSB.
test('solar Shapiro correction matches PINT and its omission is bounded for a Sun off the barycenter', () => {
	const time = timeYMDHMS(2024, 3, 10, 0, 0, 0, Timescale.TDB)
	const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, customEphemerisEndpoint('probe'), () => [
		[1, 0, 0],
		[0, 0, 0],
	])
	const sun = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.SUN), () => [
		[0, 0.01, 0],
		[0, 0, 0],
	])
	const cases = [
		// Quadrature to the SSB, 90.57° from the Sun: bound 2GM☉/c³ · -ln(1 - 0.022).
		[[0, 1, 0], 9.850817719638852e-8, 2.1914e-7],
		// 1° from the SSB toward the Sun side, 1.57° from the Sun: bound floored at the limb of a Sun at 1.011 AU.
		[[-Math.cos(deg(1)), Math.sin(deg(1)), 0], 1.0334873124294841e-4, 1.12751e-4],
		// Opposition: bound 2GM☉/c³ · ln(2 + 0.022).
		[[1, 0, 0], -6.828426591774754e-6, 6.936e-6],
	] as const

	for (const [n, pintDelay, bound] of cases) {
		const modeled = barycentricJulianDate(time, n, observer, { sun })
		const omitted = barycentricJulianDate(time, n, observer)

		expect(modeled.shapiro).toBeCloseTo(-pintDelay, 12)
		expect(modeled.errorBudget.shapiro).toBe(0)
		expect(modeled.errorBudget.total).toBe(0)
		expect(modeled.romer).toBe(omitted.romer)
		expect(modeled.correction).toBe(modeled.romer + modeled.shapiro)

		expect(omitted.shapiro).toBe(0)
		expect(omitted.model.shapiro).toBe(false)
		expect(omitted.errorBudget.shapiro).toBeGreaterThan(Math.abs(modeled.shapiro))
		expect(omitted.errorBudget.shapiro).toBeCloseTo(bound, 9)
		expect(omitted.errorBudget.total).toBe(omitted.errorBudget.shapiro)
	}
})

test('a finite source distance applies the exact spherical-wavefront Rømer delay', () => {
	const time = laSilla(0)
	const plane = barycentricJulianDate(time, SOURCE, LA_SILLA_PATH)
	const r = vecClone(LA_SILLA_PATH.stateAt(plane.reception)[0])
	const parsec = 206264.80624709636

	const near = barycentricJulianDate(time, SOURCE, LA_SILLA_PATH, { distance: parsec })
	const exact = ((parsec - vecLength(vecMinus(vecMulScalar(SOURCE, parsec), r))) / SPEED_OF_LIGHT_AU_DAY) * DAYSEC
	const curvature = ((vecDot(r, r) - vecDot(r, SOURCE) ** 2) / (2 * parsec * SPEED_OF_LIGHT_AU_DAY)) * DAYSEC

	expect(near.model.romer).toBe('sphericalWave')
	expect(near.romer).toBeCloseTo(exact, 6)
	expect(plane.romer - near.romer).toBeCloseTo(curvature, 8)
	expect(curvature * 1e3).toBeGreaterThan(0.3)

	const far = barycentricJulianDate(time, SOURCE, LA_SILLA_PATH, { distance: 1e15 })
	expect(far.romer).toBeCloseTo(plane.romer, 9)
})

test('BJD_TDB rejects origins that would mislabel HJD or other dates as BJD', () => {
	const time = laSilla(0)
	const heliocentric = ephemerisPath(naifEphemerisEndpoint(Naif.SUN), naifEphemerisEndpoint(Naif.EARTH), (t) => {
		const tt = tdb(t)
		return eraEpv00(tt.day, tt.fraction)[1]
	})

	expect(() => barycentricJulianDate(time, SOURCE, heliocentric)).toThrow('observer ephemeris path must be SSB-centered')
	expect(() => barycentricJulianDate(time, SOURCE, LA_SILLA_PATH, { sun: heliocentric })).toThrow('sun ephemeris path must be SSB-centered')
})

test('TDB input is used as the reception instant without a clock conversion', () => {
	const fromUtc = barycentricJulianDate(laSilla(0), SOURCE, LA_SILLA_PATH)
	const time = tdb(laSilla(0))
	const fromTdb = barycentricJulianDate(time, SOURCE, LA_SILLA_PATH)

	expect(fromTdb.model.tdb).toBe('input')
	expect(fromTdb.errorBudget.tdb).toBe(0)
	expect(fromTdb.reception).toBe(time)
	expect(fromTdb.time).toEqual(fromUtc.time)
})

// eopc04 (loaded by tests/setup.ts) ends in the present; 2120 has no tabulated EOP.
test('missing or overridden Earth-orientation data is diagnosed', () => {
	const future = laSilla(0, 2120)
	const missing = barycentricJulianDate(future, SOURCE, LA_SILLA_PATH)
	expect(missing.quality.earthOrientation).toBe('missing')
	expect(missing.errorBudget.earthOrientation).toBeCloseTo(1.396e-6, 9)

	const custom = laSilla(0)
	custom.providers = { dut1: () => 0.1 }
	const overridden = barycentricJulianDate(custom, SOURCE, LA_SILLA_PATH)
	expect(overridden.quality.earthOrientation).toBe('custom')
	expect(overridden.errorBudget.earthOrientation).toBe(0)

	// A geocentric observer never needs Earth orientation, even far outside the EOP table.
	expect(barycentricJulianDate(timeYMDHMS(2120, 1, 1, 0, 0, 0, Timescale.UTC), SOURCE, EPV00_EARTH).quality.earthOrientation).toBe('notRequired')
})

// DE421 covers 1900-2050: inside it BJD_TDB agrees with the analytical epv00 Earth to tens of µs,
// and outside it the SPK path throws instead of returning a low-precision date.
test('JPL DE421 observer paths give BJD_TDB within coverage and fail outside it', async () => {
	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(source))
	const emb = (await spkEphemerisPath(spk, Naif.SSB, Naif.EMB))!
	const earth = (await spkEphemerisPath(spk, Naif.EMB, Naif.EARTH))!
	const sun = (await spkEphemerisPath(spk, Naif.SSB, Naif.SUN))!
	const observer = composeEphemerisPaths(composeEphemerisPaths(emb, earth), earthObserverEphemerisPath(LA_SILLA, customEphemerisEndpoint('la-silla')))

	const jpl = barycentricJulianDate(laSilla(0), SOURCE, observer, { sun })
	const analytical = barycentricJulianDate(laSilla(0), SOURCE, LA_SILLA_PATH, { sun: EPV00_SUN })

	expect(Math.abs(jpl.romer - analytical.romer)).toBeLessThan(5e-5)
	expect(jpl.shapiro).toBeCloseTo(analytical.shapiro, 9)

	expect(() => barycentricJulianDate(laSilla(0, 2060), SOURCE, observer, { sun })).toThrow('cannot find a segment that covers the date')
})
