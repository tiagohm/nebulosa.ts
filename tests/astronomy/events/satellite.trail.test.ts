import { expect, test } from 'bun:test'
import { angularDistance } from '../../../src/astronomy/coordinates/coordinate'
import { customEphemerisEndpoint, relativeEphemerisPath } from '../../../src/astronomy/ephemeris/path'
import { earthObserverEphemerisPath, sgp4EphemerisPath } from '../../../src/astronomy/ephemeris/path.adapter'
import { ephemerisAt, equatorialPosition } from '../../../src/astronomy/ephemeris/position'
import { predictSatelliteTrails, sensorTrails, type SatelliteTrailPredictionOptions, type SensorField } from '../../../src/astronomy/events/satellite.trail'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from '../../../src/astronomy/orbits/propagation/sgp4'
import { type Time, Timescale, timeShift, timeSubtract, tt, utc } from '../../../src/astronomy/time/time'
import { ARCSEC_PER_RADIAN, DAYSEC, DEG2RAD, PIOVERTWO, TAU } from '../../../src/core/constants'

// Fixed ISS fixture shared with satellite.test.ts; WGS84 site, longitude east-positive, sea level.
const TLE = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const ISS = recordFromTLE(TLE)
const SITE = geodeticLocation(-46.6361 * DEG2RAD, -23.5475 * DEG2RAD, 0, Ellipsoid.WGS84)
const EPOCH = tt(TLE.epoch)
const PATH = relativeEphemerisPath(sgp4EphemerisPath({ ...ISS }), earthObserverEphemerisPath(SITE, customEphemerisEndpoint('test-site')))
const FIELD: SensorField = { width: DEG2RAD / 10, height: DEG2RAD / 10, positionAngle: 0.7 }

function at(seconds: number) {
	return timeShift(EPOCH, seconds / DAYSEC)
}

function seconds(time: Time) {
	return timeSubtract(time, EPOCH, Timescale.TT) * DAYSEC
}

function coordinates(offset: number) {
	return equatorialPosition(ephemerisAt(PATH, at(offset)))
}

function predict(start: number, stop: number, field: SensorField = FIELD, center: number = 3332, options?: SatelliteTrailPredictionOptions) {
	const [ra, dec] = coordinates(center)
	return predictSatelliteTrails(ISS, SITE, ra, dec, field, at(start), at(stop), options)
}

test('a straight equatorial track enters and leaves a one-degree sensor on the east-west edges', () => {
	const trails = sensorTrails(
		0,
		0,
		{ width: DEG2RAD, height: DEG2RAD },
		[
			{ time: 0, rightAscension: -DEG2RAD, declination: 0 },
			{ time: 1, rightAscension: DEG2RAD, declination: 0 },
		],
		{ arcsecPerPixel: 2 },
	)
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.time).toBeCloseTo(0.25, 8)
	expect(trails[0].exit.time).toBeCloseTo(0.75, 8)
	expect(trails[0].entry.rightAscension).toBeCloseTo(TAU - 0.5 * DEG2RAD, 8)
	expect(trails[0].exit.rightAscension).toBeCloseTo(0.5 * DEG2RAD, 8)
	expect(trails[0].length).toBeCloseTo(DEG2RAD, 8)
	expect(trails[0].positionAngle).toBeCloseTo(PIOVERTWO, 8)
	expect(trails[0].lengthPixels).toBeCloseTo((DEG2RAD * ARCSEC_PER_RADIAN) / 2, 6)
	expect(
		sensorTrails(0, 0, { width: 0.1 * DEG2RAD, height: 0.1 * DEG2RAD }, [
			{ time: 0, rightAscension: DEG2RAD, declination: DEG2RAD },
			{ time: 1, rightAscension: 2 * DEG2RAD, declination: DEG2RAD },
		]),
	).toEqual([])
})

test('samples that stay on the sensor join into one chord', () => {
	const trails = sensorTrails(0, 0, { width: 5 * DEG2RAD, height: 5 * DEG2RAD }, [
		{ time: 0, rightAscension: -DEG2RAD, declination: 0 },
		{ time: 1, rightAscension: 0, declination: 0 },
		{ time: 2, rightAscension: DEG2RAD, declination: 0 },
	])
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.time).toBeCloseTo(0, 12)
	expect(trails[0].exit.time).toBeCloseTo(2, 12)
	expect(trails[0].length).toBeCloseTo(2 * DEG2RAD, 8)
})

test('ISS crossing is geometric topocentric, rotated, time-valued, and repeatable', () => {
	const snapshot = { ...ISS }
	const trails = predict(3330, 3334, FIELD, 3332, { arcsecPerPixel: 2 })
	expect(trails).toHaveLength(1)
	const trail = trails[0]
	expect(seconds(trail.entry.time)).toBeCloseTo(3331.88343, 4)
	expect(seconds(trail.exit.time)).toBeCloseTo(3332.11656, 4)
	expect(trail.entry.time.scale).toBe(Timescale.TT)
	expect(trail.lengthPixels!).toBeCloseTo((trail.length * ARCSEC_PER_RADIAN) / 2, 10)
	expect(predict(3330, 3334, FIELD, 3332, { arcsecPerPixel: 2 })).toEqual(trails)
	for (const point of [trail.entry, trail.exit]) {
		const [ra, dec] = equatorialPosition(ephemerisAt(PATH, point.time))
		expect(angularDistance(ra, dec, point.rightAscension, point.declination) * ARCSEC_PER_RADIAN).toBeLessThan(0.1)
		expect(Math.abs(point.sensorX)).toBeLessThanOrEqual(Math.tan(FIELD.width / 2) + 1e-12)
		expect(Math.abs(point.sensorY)).toBeLessThanOrEqual(Math.tan(FIELD.height / 2) + 1e-12)
		expect(Number.isFinite(trail.positionAngle)).toBeTrue()
	}
	expect(ISS).toEqual(snapshot)
	expect(predict(3330, 3334)[0].lengthPixels).toBeUndefined()
	expect(predict(3330, 3334, { ...FIELD, positionAngle: 0 })[0].length).not.toBeCloseTo(trail.length, 5)
})

test('ISS topocentric direction agrees with a frozen Skyfield reference', () => {
	// Skyfield 1.55 / sgp4 2.25, builtin timescale, WGS72 SGP4, WGS84 site above.
	// (satellite - site).at(satellite.epoch + 3332 / 86400).radec(), ICRF axes, no corrections.
	// UTC 2020-11-25T14:04:32.000275Z. The 3 arcsec allowance includes differing Earth-orientation
	// data and tests/setup.ts's daily cached precession/nutation matrices.
	const trail = predict(3332, 3332.01)[0]
	expect(angularDistance(trail.entry.rightAscension, trail.entry.declination, 2.821619372202283, -0.8419514025782707) * ARCSEC_PER_RADIAN).toBeLessThan(3)
})

test('displaced field misses and empty or reversed intervals return no visits', () => {
	const [ra, dec] = coordinates(3332)
	expect(predictSatelliteTrails(ISS, SITE, ra + Math.PI, -dec, FIELD, at(3330), at(3334))).toEqual([])
	expect(predict(3332, 3332)).toEqual([])
	expect(predict(3334, 3330)).toEqual([])
})

test('exposure clips starts, ends, and fully contained visits to its bounds', () => {
	const full = predict(3330, 3334)[0]
	const beginning = predict(3332, 3334)[0]
	const ending = predict(3330, 3332)[0]
	const contained = predict(3332, 3332.01)[0]
	expect(seconds(beginning.entry.time)).toBeCloseTo(3332, 8)
	expect(seconds(beginning.exit.time)).toBeCloseTo(seconds(full.exit.time), 5)
	expect(seconds(ending.entry.time)).toBeCloseTo(seconds(full.entry.time), 5)
	expect(seconds(ending.exit.time)).toBeCloseTo(3332, 8)
	expect(seconds(contained.entry.time)).toBeCloseTo(3332, 8)
	expect(seconds(contained.exit.time)).toBeCloseTo(3332.01, 8)
})

test('mixed input timescales describe the same physical exposure', () => {
	const [ra, dec] = coordinates(3332)
	const mixed = predictSatelliteTrails(ISS, SITE, ra, dec, FIELD, utc(at(3330)), at(3334))
	const baseline = predict(3330, 3334)
	expect(seconds(mixed[0].entry.time)).toBeCloseTo(seconds(baseline[0].entry.time), 7)
	expect(seconds(mixed[0].exit.time)).toBeCloseTo(seconds(baseline[0].exit.time), 7)
})

test('adaptive refinement finds a curved subsecond crossing missed by endpoint-only clipping', () => {
	const [ra, dec] = coordinates(3332)
	const endpoints = [3212, 3452].map((time) => {
		const [rightAscension, declination] = coordinates(time)
		return { time, rightAscension, declination }
	})
	expect(sensorTrails(ra, dec, FIELD, endpoints)).toEqual([])
	const trails = predict(3212, 3452, FIELD, 3332, { maxStep: 240 })
	expect(trails).toHaveLength(1)
	expect(seconds(trails[0].entry.time)).toBeLessThan(3332)
	expect(seconds(trails[0].exit.time)).toBeGreaterThan(3332)
	expect(timeSubtract(trails[0].exit.time, trails[0].entry.time) * DAYSEC).toBeLessThan(0.24)
})

test('entry and exit converge with tighter spherical interpolation tolerance', () => {
	const reference = predict(3331, 3333, FIELD, 3332, { maxStep: 0.01 })[0]
	const errors = [10, 0.1, 0.01].map((arcsec) => {
		const trail = predict(3212, 3452, FIELD, 3332, { maxStep: 240, maxInterpolationError: arcsec / ARCSEC_PER_RADIAN })[0]
		return Math.abs(timeSubtract(trail.entry.time, reference.entry.time)) + Math.abs(timeSubtract(trail.exit.time, reference.exit.time))
	})
	expect(errors[1]).toBeLessThan(errors[0])
	expect(errors[2]).toBeLessThan(errors[1])
	expect(errors[2] * DAYSEC).toBeLessThan(0.000002)
})

test('real ISS track crosses RA zero without a discontinuity', () => {
	const field = { width: DEG2RAD, height: DEG2RAD, positionAngle: 0.3 }
	const trails = predict(3800, 3880, field, 3840)
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.rightAscension).toBeGreaterThan(6)
	expect(trails[0].exit.rightAscension).toBeLessThan(0.1)
	expect(trails[0].length).toBeLessThan(2 * DEG2RAD)
})

test('near-polar field keeps its clipping and interpolation accuracy', () => {
	const field = { width: DEG2RAD, height: DEG2RAD / 2, positionAngle: 1.2 }
	const trails = predict(74550, 74610, field, 74580)
	expect(trails).toHaveLength(1)
	for (const point of [trails[0].entry, trails[0].exit]) {
		const [ra, dec] = equatorialPosition(ephemerisAt(PATH, point.time))
		expect(point.declination).toBeGreaterThan(88 * DEG2RAD)
		expect(angularDistance(ra, dec, point.rightAscension, point.declination) * ARCSEC_PER_RADIAN).toBeLessThan(0.1)
		expect(Number.isFinite(point.sensorX)).toBeTrue()
		expect(Number.isFinite(point.sensorY)).toBeTrue()
	}
})

test('multiple orbital visits remain separate and chronological', () => {
	const trails = predict(3200, 9200, { width: 30 * DEG2RAD, height: 30 * DEG2RAD }, 3332, { maxStep: 30, maxInterpolationError: 1 / ARCSEC_PER_RADIAN })
	expect(trails).toHaveLength(2)
	expect(seconds(trails[0].entry.time)).toBeCloseTo(3304.767, 2)
	expect(seconds(trails[1].exit.time)).toBeCloseTo(9134.012, 2)
	expect(timeSubtract(trails[1].entry.time, trails[0].exit.time)).toBeGreaterThan(0)
})

test('sample budget counts endpoints and probes and fails deterministically', () => {
	for (let repeat = 0; repeat < 2; repeat++) {
		expect(() => predict(3332, 3332.5, FIELD, 3332, { maxStep: 1, maxInterpolationError: 1, maxSamples: 2 })).toThrow('sample budget exhausted')
		expect(predict(3332, 3332.5, FIELD, 3332, { maxStep: 1, maxInterpolationError: 1, maxSamples: 3 })).toHaveLength(1)
		expect(() => predict(3332, 3332.5, FIELD, 3332, { maxStep: 0.13, maxInterpolationError: 1, maxSamples: 8 })).toThrow('sample budget exhausted')
		expect(predict(3332, 3332.5, FIELD, 3332, { maxStep: 0.13, maxInterpolationError: 1, maxSamples: 9 })).toHaveLength(1)
	}
})

test('a track along a sensor edge includes contact without non-finite geometry', () => {
	const trails = sensorTrails(0, 0, { width: DEG2RAD, height: DEG2RAD }, [
		{ time: 0, rightAscension: DEG2RAD / 2, declination: -DEG2RAD },
		{ time: 1, rightAscension: DEG2RAD / 2, declination: 0 },
		{ time: 2, rightAscension: DEG2RAD / 2, declination: DEG2RAD },
	])
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.sensorX).toBeCloseTo(Math.tan(DEG2RAD / 2), 12)
	expect(trails[0].exit.sensorX).toBeCloseTo(Math.tan(DEG2RAD / 2), 12)
	expect(trails[0].entry.sensorY).toBeCloseTo(-Math.tan(DEG2RAD / 2), 12)
	expect(trails[0].exit.sensorY).toBeCloseTo(Math.tan(DEG2RAD / 2), 12)
})

test('corner turnaround is a zero-length visit', () => {
	const cornerRA = DEG2RAD / 2
	const cornerDec = Math.atan(Math.tan(DEG2RAD / 2) * Math.cos(cornerRA))
	const trails = sensorTrails(0, 0, { width: DEG2RAD, height: DEG2RAD }, [
		{ time: 0, rightAscension: DEG2RAD, declination: cornerDec },
		{ time: 1, rightAscension: cornerRA, declination: cornerDec },
		{ time: 2, rightAscension: DEG2RAD, declination: cornerDec },
	])
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.time).toBeCloseTo(1, 10)
	expect(trails[0].exit.time).toBeCloseTo(1, 10)
	expect(trails[0].length).toBeCloseTo(0, 12)
})

test('near the forward-hemisphere limit the predictor returns finite sensor coordinates', () => {
	const [ra, dec] = coordinates(3332)
	// Put the satellite just within the east limb of a nearly 180-degree equatorial sensor.
	const center = ra - PIOVERTWO + 0.0001
	const trails = predictSatelliteTrails(ISS, SITE, center, 0, { width: Math.PI - 0.0001, height: Math.PI - 0.0001 }, at(3331.99), at(3332.01), { maxStep: 0.001 })
	expect(trails).toHaveLength(1)
	for (const point of [trails[0].entry, trails[0].exit]) {
		expect(Number.isFinite(point.sensorX)).toBeTrue()
		expect(Number.isFinite(point.sensorY)).toBeTrue()
		expect(angularDistance(ra, dec, point.rightAscension, point.declination)).toBeLessThan(0.001)
	}
})

test('a forward-hemisphere transition refines the sensor exit instead of dropping its segment', () => {
	const [ra] = coordinates(3840)
	const field = { width: Math.PI - 0.0001, height: Math.PI - 0.0001 }
	const run = (maxStep: number) => predictSatelliteTrails(ISS, SITE, ra - PIOVERTWO + 0.0001, 0, field, at(3839), at(3841), { maxStep })
	const reference = run(0.001)
	const trails = run(1)
	expect(trails).toHaveLength(1)
	expect(seconds(trails[0].entry.time)).toBeCloseTo(3839, 8)
	expect(seconds(trails[0].exit.time)).toBeCloseTo(seconds(reference[0].exit.time), 4)
	expect(Math.max(Math.abs(trails[0].exit.sensorX), Math.abs(trails[0].exit.sensorY))).toBeCloseTo(Math.tan(field.width / 2), 3)
})
