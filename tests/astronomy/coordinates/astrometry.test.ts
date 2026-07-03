import { expect, test } from 'bun:test'
// oxfmt-ignore
import { cirsToIcrs, cirsToObserved, distance, equatorial, icrsToCirs, icrsToObserved, lightTime, observedToCirs, parallacticAngle, phaseAngle, type PositionAndVelocity, refractedAltitude, relativePositionAndVelocity, separationFrom, topocentricDirection, unrefractedAltitude } from '../../../src/astronomy/coordinates/astrometry'
import { eraEpv00 } from '../../../src/astronomy/coordinates/erfa/earth'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { tdb, Timescale, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PIOVERTWO } from '../../../src/core/constants'
import { deg, toArcsec, toDeg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'

test('distance is the position vector length in AU', () => {
	expect(distance([3, 4, 0])).toBeCloseTo(5, 12)
	expect(distance([0, 0, 0])).toBe(0)
})

test('light time of one AU is about 499 seconds', () => {
	// One AU of light travel time is ~0.00577552 days (~499 s).
	expect(lightTime([1, 0, 0])).toBeCloseTo(0.00577552, 8)
})

test('equatorial recovers spherical coordinates from a cartesian position', () => {
	const [ra, dec, r] = equatorial([1, 0, 0])
	expect(toDeg(ra)).toBeCloseTo(0, 12)
	expect(toDeg(dec)).toBeCloseTo(0, 12)
	expect(r).toBeCloseTo(1, 12)

	const [ra2, dec2] = equatorial([0, 0, 1])
	expect(toDeg(dec2)).toBeCloseTo(90, 12)
	expect(Number.isFinite(ra2)).toBeTrue()
})

test('separationFrom returns the angle between two positions', () => {
	expect(toDeg(separationFrom([1, 0, 0], [0, 1, 0]))).toBeCloseTo(90, 12)
	expect(separationFrom([1, 0, 0], [2, 0, 0])).toBeCloseTo(0, 12)
	expect(toDeg(separationFrom([1, 0, 0], [-1, 0, 0]))).toBeCloseTo(180, 12)
})

test('parallactic angle is zero at the zenith and symmetric across the meridian', () => {
	const latitude = deg(40)
	// Object on the meridian at the observer latitude lies in the zenith.
	expect(parallacticAngle(0, latitude, latitude)).toBe(0)
	// Equal hour angles east and west give opposite-sign parallactic angles.
	const east = parallacticAngle(deg(-30), deg(10), latitude)
	const west = parallacticAngle(deg(30), deg(10), latitude)
	expect(west).toBeCloseTo(-east, 12)
	expect(Math.abs(west)).toBeLessThanOrEqual(PIOVERTWO * 2)
})

// https://bitbucket.org/Isbeorn/nina/src/master/NINA.Test/AstrometryTest/AstrometryTest.cs
test('refracted altitude', () => {
	const refraction = { pressure: 1005, temperature: 7, relativeHumidity: 0.8, wl: 0.574 }

	function refract(altitude: number, expected: number, tolerance: number) {
		const a = deg(altitude)
		const r = Math.abs(toArcsec(a - refractedAltitude(a, refraction)))
		expect(r).toBeCloseTo(expected, -Math.log10(2 * tolerance))
	}

	refract(10, 318.55, 4)
	refract(12, 267.29, 3)
	refract(14, 229.43, 2)
	refract(16, 200.38, 2)
	refract(18, 177.37, 2)
	refract(20, 158.68, 2)
	refract(25, 124.26, 2)
	refract(30, 100.54, 1)
	refract(35, 82.99, 1)
	refract(40, 69.3, 1)
	refract(45, 58.18, 1)
	refract(50, 48.83, 1)
	refract(60, 33.61, 1)
	refract(70, 21.2, 1)
	refract(80, 10.27, 1)
})

// Regression: the previous A*tan(z) + B*tan^3(z) brute-force inversion returned
// wildly wrong, non-monotonic values below ~5 deg and NaN below ~1.5 deg. The
// bounded ERFA model must stay finite and physical all the way to the horizon.
test('refracted altitude stays finite and lifts the object at low altitude', () => {
	for (const altitude of [5, 3, 2, 1, 0.5, 0.01]) {
		const a = deg(altitude)
		const refracted = refractedAltitude(a)

		expect(Number.isNaN(refracted)).toBe(false)
		// Refraction always lifts the object: apparent altitude > true altitude.
		expect(refracted).toBeGreaterThan(a)
	}

	// 2 deg previously collapsed to a spurious ~164"; the bounded model caps it near
	// the ~3 deg value instead (a few hundred arcsec), never NaN or sub-true.
	expect(toArcsec(refractedAltitude(deg(2)) - deg(2))).toBeGreaterThan(500)
})

test('no refraction model below the horizon', () => {
	expect(refractedAltitude(deg(-1))).toBe(deg(-1))
})

test('zero pressure disables atmospheric refraction', () => {
	const altitude = deg(35)
	expect(refractedAltitude(altitude, { pressure: 0 })).toBeCloseTo(altitude, 15)
})

test('relativePositionAndVelocity differences the two body states', () => {
	const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const target = () =>
		[
			[3, 4, 5],
			[6, 7, 8],
		] as PositionAndVelocity
	const origin = () =>
		[
			[1, 1, 1],
			[1, 1, 1],
		] as PositionAndVelocity
	const [position, velocity] = relativePositionAndVelocity(target, origin, time)
	expect(position).toEqual([2, 3, 4])
	expect(velocity).toEqual([5, 6, 7])
})

test('topocentricDirection retards the target by light time', () => {
	const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const observer = () =>
		[
			[0, 0, 0],
			[0, 0, 0],
		] as PositionAndVelocity
	const target = (t: typeof time) =>
		[
			[1 + t.fraction, 2, 3],
			[0, 0, 0],
		] as PositionAndVelocity

	const geometric = topocentricDirection(target, observer, time, 0)
	const retarded = topocentricDirection(target, observer, time, 1)
	const expectedEmission = timeShift(time, -lightTime(geometric))

	expect(geometric).toEqual([1 + time.fraction, 2, 3])
	expect(retarded[0]).toBeCloseTo(1 + expectedEmission.fraction, 15)
	expect(retarded[1]).toBe(2)
	expect(retarded[2]).toBe(3)
})

test('phaseAngle is the Sun-body-observer angle at the body', () => {
	// Sun and observer at right angles as seen from the body.
	expect(toDeg(phaseAngle([1, 0, 0], [2, 0, 0], [1, 1, 0]))).toBeCloseTo(90, 12)
	// Observer between the body and the Sun: fully illuminated ("full" phase).
	expect(phaseAngle([1, 0, 0], [3, 0, 0], [2, 0, 0])).toBeCloseTo(0, 12)
	// Observer opposite the Sun: "new" phase.
	expect(toDeg(phaseAngle([1, 0, 0], [2, 0, 0], [0, 0, 0]))).toBeCloseTo(180, 12)
})

test('ICRS and CIRS coordinate transforms round-trip', () => {
	const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const earth = eraEpv00(tdb(time).day, tdb(time).fraction)
	const icrs = [deg(120), deg(-30)] as const

	const cirs = icrsToCirs(icrs, time, earth[1], earth[0][0])
	const roundTrip = cirsToIcrs(cirs, time, earth[1], earth[0][0])
	const fromVector = icrsToCirs(eraS2c(...icrs), time, earth[1], earth[0][0])

	expect(roundTrip[0]).toBeCloseTo(icrs[0], 12)
	expect(roundTrip[1]).toBeCloseTo(icrs[1], 12)
	expect(fromVector[0]).toBeCloseTo(cirs[0], 15)
	expect(fromVector[1]).toBeCloseTo(cirs[1], 15)
})

test('observed and CIRS transforms round-trip without refraction', () => {
	const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84)
	const cirs = [deg(140), deg(-20)] as const

	const observed = cirsToObserved(cirs, time, false, location)
	const roundTrip = observedToCirs(observed.azimuth, observed.altitude, time, false, location)

	expect(roundTrip[0]).toBeCloseTo(cirs[0], 11)
	expect(roundTrip[1]).toBeCloseTo(cirs[1], 11)
	expect(observed.equationOfOrigins).toBeFinite()
})

test('ICRS to observed matches the explicit ICRS to CIRS to observed pipeline', () => {
	const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
	const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84)
	time.location = location
	const earth = eraEpv00(tdb(time).day, tdb(time).fraction)
	const icrs = [deg(120), deg(-30)] as const

	const direct = icrsToObserved(icrs, time, earth[1], earth[0][0], false, location)
	const viaCirs = cirsToObserved(icrsToCirs(icrs, time, earth[1], earth[0][0]), time, false, location)

	expect(direct.azimuth).toBeCloseTo(viaCirs.azimuth, 9)
	expect(direct.altitude).toBeCloseTo(viaCirs.altitude, 9)
	expect(direct.rightAscension).toBeCloseTo(viaCirs.rightAscension, 9)
	expect(direct.declination).toBeCloseTo(viaCirs.declination, 9)
})

test('unrefractedAltitude inverts refractedAltitude', () => {
	const refraction = { pressure: 1005, temperature: 7, relativeHumidity: 0.8, wl: 0.574 }
	for (const trueDeg of [5, 10, 20, 45, 70, 89]) {
		const trueAltitude = deg(trueDeg)
		const apparent = refractedAltitude(trueAltitude, refraction)
		expect(apparent).toBeGreaterThan(trueAltitude)
		// Recovering the true altitude from the apparent one must round-trip.
		expect(unrefractedAltitude(apparent, refraction)).toBeCloseTo(trueAltitude, 9)
	}
})

test('unrefractedAltitude leaves below-horizon altitudes unchanged', () => {
	expect(unrefractedAltitude(deg(-1))).toBe(deg(-1))
})
