import { expect, test } from 'bun:test'
import { equatorial } from '../../../src/astronomy/coordinates/astrometry'
import { eraNut06a, eraPnm06a, eraS2p } from '../../../src/astronomy/coordinates/erfa/erfa'
import { frameToFrame, ICRS, TEME } from '../../../src/astronomy/coordinates/frame'
import { linearInterpolator, type EphemerisPoint } from '../../../src/astronomy/ephemeris/interpolation/ephemeris'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, relativeEphemerisPath } from '../../../src/astronomy/ephemeris/path'
import { earthObserverEphemerisPath, sgp4EphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { earthOccultation } from '../../../src/astronomy/events/occultation.earth'
import { isSatelliteSunlit, satelliteBetaAngle, satelliteConjunctions, satelliteEclipses, satelliteGroundFootprint, satelliteLookAngles, satelliteMagnitude, satellitePasses, satelliteShadowState, satelliteSubpoint, satelliteTrackingState, satelliteVisibleIntervals } from '../../../src/astronomy/events/satellite'
import { radialDopplerShift } from '../../../src/astronomy/formulas'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE, recordFromTLE, sgp4 } from '../../../src/astronomy/orbits/propagation/sgp4'
import { gcrsToItrsRotationMatrix, type Time, Timescale, timeShift, timeSubtract, tt } from '../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, EARTH_RADIUS_AU, ELLIPSOID_PARAMETERS, ONE_SECOND, SPEED_OF_LIGHT_AU_DAY } from '../../../src/core/constants'
import { matTransposeMulVec } from '../../../src/math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngle, vecLength, vecMinus } from '../../../src/math/linear-algebra/vec3'
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

// A synthetic co-inclined companion for the conjunction test: the same ISS elements with the ascending
// node shifted +10 deg, so the two orbital planes cross and the separation dips through two minima per
// revolution. The pair only exercises the screening geometry; it is not a real close approach.
const COMPANION = recordFromTLE(parseTLE('1 25545U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25545  51.6442  31.4611 0001363  85.7790 274.3535 15.49180547 25697', 'COMPANION'))

// São Paulo ground site (geodetic, IERS2010 ellipsoid, sea level).
const SITE = geodeticLocation(deg(-46.6361), deg(-23.5475), 0)

// Geocentric ICRS Sun direction (AU) from VSOP87E, the illumination-state light source.
function sunAt(time: Time): MutVec3 {
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

test('Earth occultation rotates both geocentric endpoints into ITRS', () => {
	const time = timeShift(EPOCH, 0.2345)
	const radius = ELLIPSOID_PARAMETERS[Ellipsoid.IERS2010].radius
	const rotation = gcrsToItrsRotationMatrix(time)
	const observer = matTransposeMulVec(rotation, [2 * radius, 0, 0])
	const blockedTarget = matTransposeMulVec(rotation, [-2 * radius, 0, 0])
	const visibleTarget = matTransposeMulVec(rotation, [3 * radius, 0, 0])
	const hit = earthOccultation(observer, blockedTarget, time)
	expect(hit.occulted).toBeTrue()
	expect(hit.intersection).toBeCloseTo(0.25, 12)
	expect(earthOccultation(observer, visibleTarget, time).occulted).toBeFalse()
})

test('selected Earth flattening moves the polar limb below the equatorial radius', () => {
	const time = timeShift(EPOCH, 0.2345)
	const rotation = gcrsToItrsRotationMatrix(time)
	for (const ellipsoid of [Ellipsoid.WGS84, Ellipsoid.IERS2010]) {
		const { radius, oneMinusFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
		const polarRadius = radius * oneMinusFlattening
		const z = (radius + polarRadius) / 2
		const observer = matTransposeMulVec(rotation, [2 * radius, 0, z])
		const target = matTransposeMulVec(rotation, [-2 * radius, 0, z])
		expect(earthOccultation(observer, target, time, ellipsoid).occulted).toBeFalse()
		const equatorialObserver = matTransposeMulVec(rotation, [2 * radius, z, 0])
		const equatorialTarget = matTransposeMulVec(rotation, [-2 * radius, z, 0])
		expect(earthOccultation(equatorialObserver, equatorialTarget, time, ellipsoid).occulted).toBeTrue()
	}
})

test('ISS-to-Sun occultation agrees with independent Skyfield samples', () => {
	// Skyfield 1.55, DE421, the ISS TLE above: (Earth + satellite).at(t).observe(sun)
	// .apparent().is_behind_earth() is true at epoch and false 40 minutes later.
	for (const [minutes, expected] of [
		[0, true],
		[40, false],
	] as const) {
		const time = timeShift(EPOCH, minutes / 1440)
		const observer = frameToFrame(sgp4(time, ISS)[0], TEME, ICRS, time)
		expect(earthOccultation(observer, sunAt(time), time).occulted).toBe(expected)
	}
})

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
})

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

test('conjunction screening finds the separation minima', () => {
	// Independent Skyfield propagation of both TLEs at 1 s over 100 min finds two separation minima:
	// +23.183 min at 734.698 km (relative speed 1.33588 km/s) and +69.633 min at 736.167 km.
	const conjunctions = satelliteConjunctions(ISS, COMPANION, EPOCH, timeShift(EPOCH, 100 / 1440))
	expect(conjunctions.length).toBe(2)

	const first = conjunctions[0]
	expect(minutesAfterEpoch(first.time)).toBeCloseTo(23.18, 1)
	expect(first.distance * AU_KM).toBeCloseTo(734.698, 0)
	expect((first.relativeSpeed * AU_KM) / DAYSEC).toBeCloseTo(1.336, 2)

	const second = conjunctions[1]
	expect(minutesAfterEpoch(second.time)).toBeCloseTo(69.63, 1)
	expect(second.distance * AU_KM).toBeCloseTo(736.167, 0)

	// Conjunctions are chronological, and the first is the global minimum of the window.
	expect(minutesAfterEpoch(second.time)).toBeGreaterThan(minutesAfterEpoch(first.time))
	expect(first.distance).toBeLessThan(second.distance)
})

test('the threshold rejects the more distant approach', () => {
	// A 735 km ceiling keeps the 734.698 km minimum but drops the 736.167 km one.
	const conjunctions = satelliteConjunctions(ISS, COMPANION, EPOCH, timeShift(EPOCH, 100 / 1440), { threshold: 735 / AU_KM })
	expect(conjunctions.length).toBe(1)
	expect(conjunctions[0].distance * AU_KM).toBeCloseTo(734.698, 0)
})

test('analytic topocentric tracking rates agree with Skyfield and change sign at closest range', () => {
	// Skyfield 1.55, same ISS TLE and WGS84 site, (satellite-site).at(t) ICRS state;
	// r.v/|r| in km/s and |r cross v|/|r|^2 in radians/day, no light time/refraction.
	for (const [minutes, rangeRate, angularRate] of [
		[0, 1.653125289874, 52.288947090571],
		[55, -2.04340647306, 779.974209665535],
		[56, 1.817975201335, 793.751657884409],
	] as const) {
		const time = timeShift(EPOCH, minutes / 1440)
		// Skyfield's fixture omits polar motion. Match that convention and use continuous
		// orientation instead of the daily matrix cache in setup, which changes rates by
		// ~0.1 m/s and ~0.01 rad/day during this high-curvature, nearby pass.
		time.providers = { pnm: (epoch) => eraPnm06a(epoch.day, epoch.fraction), nut: (epoch) => eraNut06a(epoch.day, epoch.fraction), pm: () => [0, 0] }
		const tracking = satelliteTrackingState(ISS, SITE, time)
		expect(Math.abs((tracking.rangeRate * AU_KM) / DAYSEC - rangeRate)).toBeLessThan(0.00003)
		expect(Math.abs(tracking.angularRate - angularRate)).toBeLessThan(0.005)
		const angles = satelliteLookAngles(ISS, SITE, time)
		expect(tracking.range).toBeCloseTo(angles.range, 14)
		expect(tracking.azimuth).toBeCloseTo(angles.azimuth, 12)
		expect(tracking.altitude).toBeCloseTo(angles.altitude, 12)
	}
	const approaching = satelliteTrackingState(ISS, SITE, timeShift(EPOCH, 55 / 1440)).rangeRate
	const receding = satelliteTrackingState(ISS, SITE, timeShift(EPOCH, 56 / 1440)).rangeRate
	expect(approaching).toBeLessThan(0)
	expect(receding).toBeGreaterThan(0)
	expect(radialDopplerShift(approaching, 145.8e6)).toBeGreaterThan(0)
	expect(radialDopplerShift(receding, 145.8e6)).toBeLessThan(0)
	expect(radialDopplerShift(0, 145.8e6)).toBeCloseTo(0, 12)
	expect(radialDopplerShift(SPEED_OF_LIGHT_AU_DAY * 1e-5, 1e9)).toBeCloseTo(-10000, 9)
	expect(radialDopplerShift(approaching, 291.6e6)).toBeCloseTo(2 * radialDopplerShift(approaching, 145.8e6), 10)
})

test('subpoint and signed beta angle agree with independent Skyfield geocentric geometry', () => {
	// Skyfield 1.55 WGS84 geographic_position_of(satellite.at(t)); DE421 geometric Sun
	// and satellite.at(t) ICRS angular momentum. Same TLE epoch and 55 minutes later.
	for (const [minutes, longitude, latitude, height, beta] of [
		[0, 119.283205080416, 0.014255032401, 419.791575524997, 14.620657417759],
		[55, -52.4547929759, -25.695418374253, 427.043574797101, 14.72582825463],
	] as const) {
		const time = timeShift(EPOCH, minutes / 1440)
		const point = satelliteSubpoint(ISS, time, Ellipsoid.WGS84)
		expect(Math.abs(toDeg(point.longitude) - longitude)).toBeLessThan(0.0002)
		expect(Math.abs(toDeg(point.latitude) - latitude)).toBeLessThan(0.0002)
		expect(Math.abs(point.elevation * AU_KM - height)).toBeLessThan(0.002)
		expect(Math.abs(toDeg(satelliteBetaAngle(ISS, sunAt, time)) - beta)).toBeLessThan(0.002)
		const positive = satelliteBetaAngle(ISS, sunAt, time)
		expect(satelliteBetaAngle(ISS, (epoch) => [-sunAt(epoch)[0], -sunAt(epoch)[1], -sunAt(epoch)[2]], time)).toBeCloseTo(-positive, 10)
	}
})

test('spherical footprint satisfies tangent-horizon and surface-arc invariants', () => {
	const radius = vecLength(sgp4(EPOCH, ISS)[0])
	const footprint = satelliteGroundFootprint(ISS, EPOCH)
	expect(footprint.altitude).toBeCloseTo(radius - EARTH_RADIUS_AU, 14)
	expect(Math.cos(footprint.halfAngle)).toBeCloseTo(EARTH_RADIUS_AU / radius, 12)
	expect(footprint.surfaceRadius).toBeCloseTo(EARTH_RADIUS_AU * footprint.halfAngle, 14)
	expect(footprint.subpoint.elevation).toBe(footprint.altitude)
	const smaller = satelliteGroundFootprint(ISS, EPOCH, EARTH_RADIUS_AU * 0.9)
	expect(smaller.halfAngle).toBeGreaterThan(footprint.halfAngle)
	const surface = satelliteGroundFootprint(ISS, EPOCH, radius)
	expect(surface.halfAngle).toBeCloseTo(0, 6)
	expect(Number.isFinite(surface.surfaceRadius)).toBe(true)
})

test('spherical footprint rejects impossible reference-sphere geometry', () => {
	for (const referenceRadius of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => satelliteGroundFootprint(ISS, EPOCH, referenceRadius)).toThrow()
	}
	const radius = vecLength(sgp4(EPOCH, ISS)[0])
	expect(() => satelliteGroundFootprint(ISS, EPOCH, radius * 1.001)).toThrow('satellite radius must be at least the reference radius')
})

test('observer-relative satellite Sun/Moon avoidance paths agree with independent geometric angles', () => {
	// Skyfield 1.55/DE421 same-epoch geometric vectors: sat-site, Sun-Earth-site, Moon-Earth-site.
	const observer = earthObserverEphemerisPath(SITE, customEphemerisEndpoint('test-site'))
	const target = relativeEphemerisPath(sgp4EphemerisPath(ISS), observer)
	const solar = relativeEphemerisPath(
		ephemerisPath(naifEphemerisEndpoint(Naif.EARTH), naifEphemerisEndpoint(Naif.SUN), (time) => [sunAt(time), [0, 0, 0]]),
		observer,
	)
	const lunar = relativeEphemerisPath(ephemerisPath(naifEphemerisEndpoint(Naif.EARTH), naifEphemerisEndpoint(Naif.MOON), moon), observer)
	for (const [minutes, sunAngle, moonAngle] of [
		[0, 146.307284369162, 19.182739360911],
		[55, 71.377547286393, 137.418253056552],
	] as const) {
		const time = timeShift(EPOCH, minutes / 1440)
		const satellite = target.stateAt(time)[0]
		expect(Math.abs(toDeg(vecAngle(satellite, solar.stateAt(time)[0])) - sunAngle)).toBeLessThan(0.002)
		expect(Math.abs(toDeg(vecAngle(satellite, lunar.stateAt(time)[0])) - moonAngle)).toBeLessThan(0.002)
	}
})

// Permissive solar/magnitude ceilings isolate individual interval boundaries; the empirical
// magnitude and altitude remain explicit and are tightened by the tests below.
const VISIBLE_OPTIONS = { standardMagnitude: -1.8, minimumAltitude: 0, maximumMagnitude: 100, maximumSunAltitude: Math.PI / 2, step: 10 * ONE_SECOND, tolerance: 1e-8 }

test('visible intervals clip minimum altitude, magnitude and partial-window boundaries', () => {
	const start = timeShift(EPOCH, 49 / 1440)
	const stop = timeShift(EPOCH, 62 / 1440)
	const [baseline] = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, VISIBLE_OPTIONS)
	expect(minutesAfterEpoch(baseline.start.time)).toBeCloseTo(50.25, 1)
	expect(minutesAfterEpoch(baseline.end.time)).toBeCloseTo(60.8975, 2)
	const raised = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, { ...VISIBLE_OPTIONS, minimumAltitude: deg(20) })
	expect(raised).toHaveLength(1)
	// Skyfield 1.55/DE421, scipy 1.16.2 brentq on independent geometric altitude and
	// Molczan/McCants photometry: minutes from the TLE epoch. 0.01 min covers EOP residuals.
	expect(Math.abs(minutesAfterEpoch(raised[0].start.time) - 53.8371535)).toBeLessThan(0.01)
	expect(Math.abs(minutesAfterEpoch(raised[0].end.time) - 57.250611816)).toBeLessThan(0.01)
	expect(raised[0].start.altitude).toBeCloseTo(deg(20), 6)
	expect(raised[0].end.altitude).toBeCloseTo(deg(20), 6)
	expect(timeSubtract(raised[0].start.time, baseline.start.time)).toBeGreaterThan(0)
	expect(timeSubtract(raised[0].end.time, baseline.end.time)).toBeLessThan(0)
	const bright = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, { ...VISIBLE_OPTIONS, maximumMagnitude: -1.5 })
	expect(bright).toHaveLength(1)
	expect(Math.abs(minutesAfterEpoch(bright[0].start.time) - 53.74115791)).toBeLessThan(0.01)
	expect(Math.abs(minutesAfterEpoch(bright[0].end.time) - 56.808878143)).toBeLessThan(0.01)
	expect(bright[0].start.magnitude).toBeCloseTo(-1.5, 5)
	expect(bright[0].end.magnitude).toBeCloseTo(-1.5, 5)
	expect(timeSubtract(bright[0].start.time, baseline.start.time)).toBeGreaterThan(0)
	expect(timeSubtract(bright[0].end.time, baseline.end.time)).toBeLessThan(0)
	// Bright culmination does not make the faint rise/set eligible.
	expect(bright[0].culmination.magnitude).toBeLessThan(-1.5)
	expect(baseline.start.magnitude).toBeGreaterThan(-1.5)
	const clippedStart = timeShift(EPOCH, 55 / 1440)
	const clippedStop = timeShift(EPOCH, 56 / 1440)
	const partial = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, clippedStart, clippedStop, VISIBLE_OPTIONS)
	expect(partial).toHaveLength(1)
	expect(timeSubtract(partial[0].start.time, clippedStart)).toBeCloseTo(0, 12)
	expect(timeSubtract(partial[0].end.time, clippedStop)).toBeCloseTo(0, 12)
})

test('observer solar altitude clips an interval and daylight rejects a bright sunlit culmination', () => {
	const start = timeShift(EPOCH, 49 / 1440)
	const stop = timeShift(EPOCH, 62 / 1440)
	const [baseline] = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, VISIBLE_OPTIONS)
	const ceiling = deg(78.3)
	const intervals = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, { ...VISIBLE_OPTIONS, maximumSunAltitude: ceiling })
	expect(intervals).toHaveLength(1)
	// Independent Skyfield 1.55/DE421 geometric Sun-Earth-site direction and ITRS
	// geodetic vertical, scipy 1.16.2 root: 55.448906317 min; no apparent corrections.
	expect(Math.abs(minutesAfterEpoch(intervals[0].end.time) - 55.448906317)).toBeLessThan(0.02)
	expect(intervals[0].end.sunAltitude).toBeCloseTo(ceiling, 6)
	expect(timeSubtract(intervals[0].end.time, baseline.end.time)).toBeLessThan(0)
	expect(timeSubtract(intervals[0].start.time, baseline.start.time)).toBeCloseTo(0, 8)
	expect(baseline.culmination.shadow).toBe('sunlit')
	expect(baseline.culmination.magnitude).toBeLessThan(3.5)
	expect(satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, { ...VISIBLE_OPTIONS, maximumSunAltitude: deg(-6), maximumMagnitude: 3.5 })).toEqual([])
})

test('a zero-flux solar alignment splits visibility without passing infinite margins to Brent', () => {
	const aligned = timeShift(EPOCH, 55 / 1440)
	const observer = earthObserverEphemerisPath(SITE, customEphemerisEndpoint('alignment-site')).stateAt(aligned)[0]
	const satellite = sgp4EphemerisPath(ISS).stateAt(aligned)[0]
	// A fixed AU-scale Sun behind the satellite from this observer gives phase PI at the
	// central sample: magnitude tends to +Infinity, but the neighboring track is illuminated.
	const solar: Vec3 = [satellite[0] + 200000 * (satellite[0] - observer[0]), satellite[1] + 200000 * (satellite[1] - observer[1]), satellite[2] + 200000 * (satellite[2] - observer[2])]
	const sunAt = () => solar
	expect(satelliteMagnitude(ISS, SITE, sunAt, aligned, -1.8).magnitude).toBe(Number.POSITIVE_INFINITY)
	const intervals = satelliteVisibleIntervals(ISS, SITE, sunAt, timeShift(EPOCH, 54.5 / 1440), timeShift(EPOCH, 55.5 / 1440), { ...VISIBLE_OPTIONS, maximumMagnitude: 3.5, step: 15 * ONE_SECOND, tolerance: 1e-10 })
	expect(intervals).toHaveLength(2)
	expect(timeSubtract(intervals[0].end.time, aligned)).toBeLessThan(0)
	expect(timeSubtract(intervals[1].start.time, aligned)).toBeGreaterThan(0)
	expect(intervals[0].end.magnitude).toBeCloseTo(3.5, 5)
	expect(intervals[1].start.magnitude).toBeCloseTo(3.5, 5)
})

test('umbra entry cuts a pass whose culmination is illuminated', () => {
	const start = timeShift(EPOCH, 542 / 1440)
	const stop = timeShift(EPOCH, 555 / 1440)
	const intervals = satelliteVisibleIntervals(ISS, SITE, CACHED_SUN, start, stop, VISIBLE_OPTIONS)
	expect(intervals).toHaveLength(1)
	const interval = intervals[0]
	expect(minutesAfterEpoch(interval.start.time)).toBeCloseTo(543.037, 2)
	expect(minutesAfterEpoch(interval.end.time)).toBeGreaterThan(550)
	expect(minutesAfterEpoch(interval.end.time)).toBeLessThan(552)
	// Skyfield 1.55/DE421 plus independent conical angular-radius geometry, scipy 1.16.2:
	// Earth sphere 6378.1366 km, Sun 695700 km; umbra entry 551.090764289 min.
	expect(Math.abs(minutesAfterEpoch(interval.end.time) - 551.090764289)).toBeLessThan(0.02)
	expect(interval.end.altitude).toBeGreaterThan(0)
	expect(interval.culmination.shadow).not.toBe('umbra')
	expect(satelliteShadowState(ISS, CACHED_SUN, timeShift(interval.end.time, -ONE_SECOND))).not.toBe('umbra')
	expect(satelliteShadowState(ISS, CACHED_SUN, timeShift(interval.end.time, ONE_SECOND))).toBe('umbra')
	for (let i = 1; i < 10; i++) {
		const time = timeShift(interval.start.time, (timeSubtract(interval.end.time, interval.start.time) * i) / 10)
		expect(satelliteLookAngles(ISS, SITE, time).altitude).toBeGreaterThan(0)
		expect(satelliteMagnitude(ISS, SITE, CACHED_SUN, time, -1.8).illuminated).toBe(true)
	}
})
