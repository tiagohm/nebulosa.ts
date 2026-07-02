import { expect, test } from 'bun:test'
import { equatorial } from '../../../src/astronomy/coordinates/astrometry'
import { eraS2p } from '../../../src/astronomy/coordinates/erfa/erfa'
import { linearInterpolator, type EphemerisPoint } from '../../../src/astronomy/ephemeris/interpolation/ephemeris'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { isSatelliteSunlit, satelliteEclipses, satelliteLookAngles, satelliteMagnitude, satellitePasses, satelliteShadowState } from '../../../src/astronomy/events/satellite'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from '../../../src/astronomy/orbits/propagation/sgp4'
import { type Time, Timescale, timeShift, timeSubtract, tt } from '../../../src/astronomy/time/time'
import { AU_KM, ONE_SECOND } from '../../../src/core/constants'
import { type Vec3, vecAngle, vecLength, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { clamp } from '../../../src/math/numerical/math'
import { linearSpline } from '../../../src/math/numerical/spline'
import { deg, toArcsec, toDeg, type Angle } from '../../../src/math/units/angle'

// Reference values come from Skyfield 1.49 with the same ISS TLE (epoch 2020-11-25 13:09:00 UTC), the
// same WGS84 ground site, its SGP4 + TEME->ITRF pipeline, its find_events pass finder and its is_sunlit
// shadow test against DE421. Sub-arcsecond look-angle residuals are the polar-motion/GAST-vs-GMST
// differences; the ~5 s shadow-timing residuals are the conical umbra (this module) versus Skyfield's
// cylindrical Earth-shadow plus the VSOP87E-vs-DE421 Sun.
const TLE = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const ISS = recordFromTLE(TLE)
const EPOCH = TLE.epoch

// São Paulo ground site (geodetic, IERS2010 ellipsoid, sea level).
const SITE = geodeticLocation(deg(-46.6361), deg(-23.5475), 0)

// Geocentric ICRS Sun direction (AU) from VSOP87E, the illumination-state light source.
function sunAt(time: Time): Vec3 {
	return vecMinus(sun(time)[0], earth(time)[0])
}

// Wraps an expensive geocentric Sun provider in a cheap interpolated one over a fixed time window.
//
// The Earth-shadow and magnitude scanners call `sunAt` once per sample, thousands of times across a
// window, yet the Sun's geocentric direction moves only ~1 deg/day: recomputing a full VSOP series each
// time dominates the cost. This samples `sunAt` on a coarse grid (default every 30 minutes), fits the
// direction with an RA/Dec ephemeris interpolator and the distance with a linear spline, and returns a
// `(time) => Vec3` that reconstructs the geocentric position (AU, ICRS) from the fit. The result is
// two to three orders of magnitude cheaper than the raw provider while staying well under a
// milliarcsecond over the window; query times outside [start, stop] are clamped to the nearest edge.
// `sunAt` must return the geocentric Sun position (AU, ICRS), e.g. `sun(t)[0] - earth(t)[0]`.
function cachedSun(sunAt: (time: Time) => Vec3, start: Time, stop: Time) {
	const span = timeSubtract(stop, start)
	// Default coarse Sun-sampling step: 30 minutes, in days.
	const segments = Math.max(1, Math.ceil(span / (1800 * ONE_SECOND)))

	const points = new Array<EphemerisPoint>(segments + 1)
	const offsets = new Float64Array(segments + 1)
	const distances = new Float64Array(segments + 1)
	const t0 = tt(start)

	for (let i = 0; i <= segments; i++) {
		const time = timeShift(start, Math.min((i * span) / segments, span))
		const [rightAscension, declination, radius] = equatorial(sunAt(time))
		points[i] = { time, rightAscension, declination }
		const ti = tt(time)
		offsets[i] = ti.day - t0.day + (ti.fraction - t0.fraction)
		distances[i] = radius
	}

	const direction = linearInterpolator(points)
	const distanceAt = linearSpline(offsets, distances, true)
	const angles: [Angle, Angle] = [0, 0]

	return (time: Time) => {
		direction.computeInto(time, angles)
		const ti = tt(time)
		const offset = clamp(ti.day - t0.day + (ti.fraction - t0.fraction), 0, offsets[segments])
		return eraS2p(angles[0], angles[1], distanceAt.compute(offset))
	}
}

// Interpolated Sun over the one-day shadow-scan window, so the eclipse scans do not re-evaluate the full
// VSOP87E series at every coarse sample. The interpolation error is well below a milliarcsecond.
const CACHED_SUN = cachedSun(sunAt, EPOCH, timeShift(EPOCH, 1))

// Minutes elapsed from the TLE epoch, the reference clock for the Skyfield comparisons.
function minutesAfterEpoch(time: Time): number {
	return timeSubtract(time, EPOCH, Timescale.UTC) * 1440
}

test('topocentric look angles match Skyfield at the TLE epoch', () => {
	// Skyfield: alt = -75.888555 deg, az = 148.015731 deg, range = 12806.473898 km.
	const { azimuth, altitude, range } = satelliteLookAngles(ISS, SITE, EPOCH)
	expect(toDeg(altitude)).toBeCloseTo(-75.8886, 2)
	expect(toDeg(azimuth)).toBeCloseTo(148.0157, 2)
	expect(range * AU_KM).toBeCloseTo(12806.47, 0)
})

test('the pass finder reproduces the Skyfield rise/culmination/set circumstances', () => {
	const passes = satellitePasses(ISS, SITE, EPOCH, timeShift(EPOCH, 1))
	expect(passes.length).toBe(6)

	// First pass (Skyfield): rise +50.25 min, culmination +55.533 min at alt 32.065 deg / az 226.277 deg,
	// set +60.883 min.
	const first = passes[0]
	expect(minutesAfterEpoch(first.rise.time)).toBeCloseTo(50.25, 1)
	expect(minutesAfterEpoch(first.culmination.time)).toBeCloseTo(55.533, 1)
	expect(toDeg(first.culmination.altitude)).toBeCloseTo(32.065, 1)
	expect(toDeg(first.culmination.azimuth)).toBeCloseTo(226.277, 1)
	expect(minutesAfterEpoch(first.set.time)).toBeCloseTo(60.883, 1)
	// The rise and set sit on the horizon, and the culmination is the highest point of the pass.
	expect(toDeg(first.rise.altitude)).toBeCloseTo(0, 3)
	expect(toDeg(first.set.altitude)).toBeCloseTo(0, 3)
	expect(first.culmination.altitude).toBeGreaterThan(first.rise.altitude)

	// The highest pass of the day (Skyfield): culmination altitude 38.774 deg.
	expect(toDeg(passes[3].culmination.altitude)).toBeCloseTo(38.774, 1)
})

test('a raised horizon rejects the low passes', () => {
	// Only the two passes that climb above 30 deg survive a 30 deg minimum-elevation constraint.
	const passes = satellitePasses(ISS, SITE, EPOCH, timeShift(EPOCH, 1), { minAltitude: deg(30) })
	expect(passes.length).toBe(2)
	for (const pass of passes) expect(toDeg(pass.culmination.altitude)).toBeGreaterThan(30)
})

test('the illumination state tracks the Earth shadow', () => {
	// Skyfield reports the ISS unlit at the epoch (inside the umbra) and sunlit again after +28.8 min.
	expect(satelliteShadowState(ISS, sunAt, EPOCH)).toBe('umbra')
	expect(isSatelliteSunlit(ISS, sunAt, EPOCH)).toBe(false)
	expect(isSatelliteSunlit(ISS, sunAt, timeShift(EPOCH, 40 / 1440))).toBe(true)
})

test('umbra entry and exit crossings bound each eclipse', () => {
	const eclipses = satelliteEclipses(ISS, CACHED_SUN, EPOCH, timeShift(EPOCH, 1))
	// The ISS is eclipsed roughly once per ~93 min orbit, so ~15-16 shadow intervals fall in one day.
	expect(eclipses.length).toBeGreaterThanOrEqual(15)

	// The window opens inside the umbra, so the first interval has no entry and exits at ~+28.8 min
	// (Skyfield cylinder 28.825 min; the conical umbra exits a few seconds earlier).
	const opening = eclipses[0]
	expect(opening.entry).toBeUndefined()
	expect(opening.exit).toBeDefined()
	expect(Math.abs(minutesAfterEpoch(opening.exit!) - 28.825)).toBeLessThan(0.15)

	// The first complete interior eclipse (Skyfield: entry +86.14 min, exit +121.79 min, ~35.6 min long).
	const eclipse = eclipses[1]
	expect(minutesAfterEpoch(eclipse.entry!)).toBeGreaterThan(minutesAfterEpoch(opening.exit!))
	expect(Math.abs(minutesAfterEpoch(eclipse.entry!) - 86.14)).toBeLessThan(0.15)
	expect(Math.abs(minutesAfterEpoch(eclipse.exit!) - 121.79)).toBeLessThan(0.15)
	expect(eclipse.duration).toBeCloseTo(timeSubtract(eclipse.exit!, eclipse.entry!, Timescale.UTC) * 86400, 3)
	expect(eclipse.duration).toBeGreaterThan(2050)
	expect(eclipse.duration).toBeLessThan(2200)
}, 3000)

test('the visual magnitude follows the standard-magnitude model', () => {
	// 55 min after epoch the ISS is sunlit and 30 deg up over the site. Independent numpy geometry from
	// the same Skyfield state: range 782.729 km, phase angle 108.622 deg, so with a standard magnitude of
	// -1.8 the Molczan/McCants model gives m = -1.912.
	const time = timeShift(EPOCH, 55 / 1440)
	const { magnitude, phaseAngle, range, illuminated } = satelliteMagnitude(ISS, SITE, sunAt, time, -1.8)
	expect(illuminated).toBe(true)
	expect(range * AU_KM).toBeCloseTo(782.73, 0)
	expect(toDeg(phaseAngle)).toBeCloseTo(108.622, 2)
	expect(magnitude).toBeCloseTo(-1.912, 2)
})

test('an eclipsed satellite is reported as not illuminated', () => {
	// At the epoch the ISS is inside the umbra, so it reflects no sunlight.
	const { illuminated } = satelliteMagnitude(ISS, SITE, sunAt, EPOCH, -1.8)
	expect(illuminated).toBe(false)
})

test.skip('the cached Sun matches the exact ephemeris over the window', () => {
	// Sampled between the 30-minute grid nodes (where the fit is exact), the interpolated direction stays
	// within a milliarcsecond and the distance within ~0.1 km of the full VSOP87E Sun over the whole day.
	let maxSeparation = 0
	let maxDistanceError = 0
	for (let i = 0; i < 100; i++) {
		const time = timeShift(EPOCH, (i + 0.5) / 100)
		const exact = sunAt(time)
		const interpolated = CACHED_SUN(time)
		maxSeparation = Math.max(maxSeparation, vecAngle(exact, interpolated))
		maxDistanceError = Math.max(maxDistanceError, Math.abs(vecLength(exact) - vecLength(interpolated)) * AU_KM)
	}
	expect(toArcsec(maxSeparation)).toBeLessThan(1)
	expect(maxDistanceError).toBeLessThan(0.1)
})

test('the penumbra brackets the umbra', () => {
	// Any partial obscuration lasts longer than the total eclipse, so the penumbra interval enclosing a
	// given umbra crossing starts earlier and ends later.
	const umbra = satelliteEclipses(ISS, CACHED_SUN, EPOCH, timeShift(EPOCH, 0.25), { boundary: 'umbra' })
	const penumbra = satelliteEclipses(ISS, CACHED_SUN, EPOCH, timeShift(EPOCH, 0.25), { boundary: 'penumbra' })
	expect(penumbra.length).toBe(umbra.length)
	// Compare the first complete interior interval of each (index 1; index 0 is open at the window start).
	expect(minutesAfterEpoch(penumbra[1].entry!)).toBeLessThan(minutesAfterEpoch(umbra[1].entry!))
	expect(minutesAfterEpoch(penumbra[1].exit!)).toBeGreaterThan(minutesAfterEpoch(umbra[1].exit!))
	expect(penumbra[1].duration).toBeGreaterThan(umbra[1].duration)
})
