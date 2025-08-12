import { expect, test } from 'bun:test'
import { dateFromTime } from '../src/datetime'
import { parseTLE, sgp4 } from '../src/sgp4'
import { Timescale, timeYMDHMS, utc } from '../src/time'

const ISS_1 = '1 25544U 98067A   25222.48428578  .00007827  00000+0  14282-3 0  9992'
const ISS_2 = '2 25544  51.6367  37.9417 0001853 175.3844 230.1801 15.50428464523587'

test('parse TLE', () => {
	const tle = parseTLE(ISS_1, ISS_2)

	expect(tle.id).toBe('25544')
	expect(tle.meanMotion).toBe(0.067650203783595933566489)
	expect(tle.meanMotionFirstDerivative).toBe(0.00007827)
	expect(tle.meanMotionSecondDerivative).toBe(0)
	expect(tle.inclination).toBe(0.9012304298645559)
	expect(tle.eccentricity).toBe(0.0001853)
	expect(tle.bstar).toBe(0.00014282)
	expect(tle.argumentOfPerigee).toBe(3.061035236634743)
	expect(tle.meanAnomaly).toBe(4.0174006175698)
	expect(tle.longitudeOfAscendingNode).toBe(0.6622075888039325)
	expect(tle.epoch.day + tle.epoch.fraction).toBe(2460897.98428578)
})

test('sgp4', () => {
	const time = timeYMDHMS(2025, 8, 10, 18, 0, 0, Timescale.TDB)
	console.info(dateFromTime(utc(time)).format('YYYY-MM-DD HH:mm:ss.SSS'))
	const tle = parseTLE(ISS_1, ISS_2)
	const [p, v] = sgp4(tle, time)!

	expect(p[0]).toBeCloseTo(-2038.5577537713107, 12)
	expect(p[1]).toBeCloseTo(3715.9986629599784, 12)
	expect(p[2]).toBeCloseTo(5300.277230414942, 12)
	expect(v[0]).toBeCloseTo(-6.370750103571325, 16)
	expect(v[1]).toBeCloseTo(-4.230700926820335, 16)
	expect(v[2]).toBeCloseTo(0.5128156416984835, 16)
})
