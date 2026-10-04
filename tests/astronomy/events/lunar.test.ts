import { expect, test } from 'bun:test'
import { MOON_ROTATION, bodyFixedFrame } from '../../../src/astronomy/bodies/orientation'
import { frameToBase } from '../../../src/astronomy/coordinates/frame'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { lunarLibrationExtrema } from '../../../src/astronomy/events/lunar'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { TAU } from '../../../src/core/constants'
import { vecMulScalar } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'

const EPOCH = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)

test('signed libration extrema match independent SPICE/DE421 references over a lunation', () => {
	// Skyfield 1.55 DE421 geometric Moon->Earth vectors; spiceypy 8.0.0 with NAIF
	// pck00011.tpc IAU_MOON at epoch minus vector range/c, scipy 1.16.2 extrema.
	// TT days from 2020-01-01 00:00; degrees. ELP vs DE421 allows 0.002 day / 0.002 degree.
	const reference = [
		['latitude', 'maximum', 1.867052419, 6.866536612],
		['longitude', 'minimum', 7.235449276, -5.720919251],
		['latitude', 'minimum', 15.217957046, -6.772462603],
		['longitude', 'maximum', 20.300572423, 5.350296159],
		['latitude', 'maximum', 29.135485844, 6.77890309],
	] as const
	const events = lunarLibrationExtrema((time) => vecMulScalar(moon(time)[0], -1), EPOCH, timeShift(EPOCH, 32), { step: 0.5, tolerance: 1e-7 })
	expect(events).toHaveLength(reference.length)
	for (let i = 0; i < events.length; i++) {
		const [axis, kind, offset, angle] = reference[i]
		expect(events[i].axis).toBe(axis)
		expect(events[i].kind).toBe(kind)
		expect(Math.abs(timeSubtract(events[i].time, EPOCH) - offset)).toBeLessThan(0.002)
		expect(Math.abs(toDeg(events[i].angle) - angle)).toBeLessThan(0.002)
		if (i > 0) expect(timeSubtract(events[i].time, events[i - 1].time)).toBeGreaterThan(0)
	}
})

test('longitude through 0/360 degrees produces signed extrema without false seam events', () => {
	const frame = bodyFixedFrame(MOON_ROTATION)
	const direction = (time: Time) => {
		const longitude = deg(5) * Math.sin(TAU * timeSubtract(time, EPOCH))
		// Unit magnitude zero would be undefined; use a tiny positive AU range so the
		// physical sub-observer light delay is negligible for this analytic seam regression.
		return frameToBase([1e-12 * Math.cos(longitude), 1e-12 * Math.sin(longitude), 0], frame, time)
	}
	const events = lunarLibrationExtrema(direction, EPOCH, timeShift(EPOCH, 1), { step: 0.07 })
	const longitude = events.filter((event) => event.axis === 'longitude')
	expect(longitude).toHaveLength(2)
	expect(longitude.map((event) => event.kind)).toEqual(['maximum', 'minimum'])
	expect(timeSubtract(longitude[0].time, EPOCH)).toBeCloseTo(0.25, 5)
	expect(timeSubtract(longitude[1].time, EPOCH)).toBeCloseTo(0.75, 5)
	expect(toDeg(longitude[0].angle)).toBeCloseTo(5, 5)
	expect(toDeg(longitude[1].angle)).toBeCloseTo(-5, 5)
})
