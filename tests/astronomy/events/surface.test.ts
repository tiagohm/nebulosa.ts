import { expect, test } from 'bun:test'
import { bodyFixedFrame, MOON_ROTATION } from '../../../src/astronomy/bodies/orientation'
import { frameToBase, ICRS, type Frame } from '../../../src/astronomy/coordinates/frame'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { bodySurfaceSolarAltitude, bodySurfaceSunEvents } from '../../../src/astronomy/events/surface'
import { bodyShape, bodySurfaceLocation, bodySurfaceNormal } from '../../../src/astronomy/observer/body'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PIOVERFOUR, PIOVERTWO, TAU } from '../../../src/core/constants'
import { matRotZ } from '../../../src/math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'

const EPOCH = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const SPHERE = bodyShape([1, 1, 1])
const SOLAR = (): Vec3 => [1, 0, 0]
const ROTATING: Frame = { rotationAt: (time) => matRotZ(TAU * timeSubtract(time, EPOCH)) }

test('sphere equator, poles, near poles and longitude wrap have analytic solar altitudes', () => {
	for (const longitude of [0, TAU, -TAU]) {
		const location = bodySurfaceLocation(longitude, 0, 0, SPHERE, ICRS)
		expect(bodySurfaceSolarAltitude(location, SOLAR, EPOCH)).toBeCloseTo(PIOVERTWO, 12)
	}
	for (const latitude of [PIOVERTWO, -PIOVERTWO, PIOVERTWO - 1e-7]) {
		const location = bodySurfaceLocation(0, latitude, 0, SPHERE, ICRS)
		expect(bodySurfaceSolarAltitude(location, SOLAR, EPOCH)).toBeCloseTo(PIOVERTWO - Math.abs(latitude), 12)
	}
	const equator = bodySurfaceLocation(PIOVERTWO, 0, 0, SPHERE, ICRS)
	expect(bodySurfaceSolarAltitude(equator, SOLAR, EPOCH)).toBeCloseTo(0, 12)
})

test('tri-axial local vertical follows the ellipsoid gradient rather than the radial direction', () => {
	const location = bodySurfaceLocation(PIOVERFOUR, 0, 10, bodyShape([2, 1, 0.5]), ICRS)
	const out: MutVec3 = [0, 0, 0]
	expect(bodySurfaceNormal(location, out)).toBe(out)
	expect(out[0]).toBeCloseTo(1 / Math.sqrt(17), 12)
	expect(out[1]).toBeCloseTo(4 / Math.sqrt(17), 12)
	expect(out[2]).toBeCloseTo(0, 12)
	expect(bodySurfaceSolarAltitude(location, SOLAR, EPOCH)).toBeCloseTo(Math.asin(1 / Math.sqrt(17)), 12)
	const small = bodySurfaceLocation(PIOVERFOUR, 0, 0, bodyShape([2e-150, 1e-150, 0.5e-150]), ICRS)
	expect(bodySurfaceNormal(small)[0]).toBeCloseTo(out[0], 12)
})

test('rotating surface produces chronological sunset and sunrise, including initial daylight', () => {
	const location = bodySurfaceLocation(0, 0, 0, SPHERE, ROTATING)
	const events = bodySurfaceSunEvents(location, SOLAR, EPOCH, timeShift(EPOCH, 1), { step: 0.1, tolerance: 1e-8 })
	expect(events.map((event) => event.kind)).toEqual(['sunset', 'sunrise'])
	expect(timeSubtract(events[0].time, EPOCH)).toBeCloseTo(0.25, 7)
	expect(timeSubtract(events[1].time, EPOCH)).toBeCloseTo(0.75, 7)
	for (const event of events) expect(event.altitude).toBeCloseTo(0, 7)
	expect(bodySurfaceSunEvents(location, SOLAR, EPOCH, timeShift(EPOCH, 0.1))).toEqual([])
	const raised = bodySurfaceSunEvents(location, SOLAR, EPOCH, timeShift(EPOCH, 1), { horizon: deg(30), step: 0.1 })
	expect(timeSubtract(raised[0].time, EPOCH)).toBeCloseTo(1 / 6, 6)
	expect(timeSubtract(raised[1].time, EPOCH)).toBeCloseTo(5 / 6, 6)
})

test('body frame orientation is evaluated at each epoch without mutating the provider', () => {
	const location = bodySurfaceLocation(0, 0, 0, SPHERE, ROTATING)
	const shared: MutVec3 = [1, 0, 0]
	const time = timeShift(EPOCH, 0.1)
	const solar = () => frameToBase([1, 0, 0], ROTATING, time, shared)
	const expected = solar()
	expect(bodySurfaceSolarAltitude(location, solar, time)).toBeCloseTo(PIOVERTWO, 7)
	expect(shared).toEqual(expected)
})

test('Copernicus sunrise/set agrees with independent SPICE reference-surface illumination', () => {
	// SPICE/spiceypy 8.0.0, NAIF pck00011.tpc IAU_MOON, Skyfield 1.55 DE421 geometric
	// body-center Sun directions; no light time, no solar disk/refraction/terrain. Offsets are TT
	// days from 2020-01-01. A 0.002-day tolerance covers VSOP/ELP vs DE421 and the omitted
	// quadratic prime-meridian term of MOON_ROTATION. Copernicus: 20.08 W, 9.62 N.
	const radius = kilometer(1737.4)
	const location = bodySurfaceLocation(deg(-20.08), deg(9.62), 0, bodyShape([radius, radius, radius]), bodyFixedFrame(MOON_ROTATION))
	const solar = (time: Time) => vecMinus(vecMinus(sun(time)[0], earth(time)[0]), moon(time)[0])
	const events = bodySurfaceSunEvents(location, solar, EPOCH, timeShift(EPOCH, 32), { step: 0.5 })
	expect(events.map((event) => event.kind)).toEqual(['sunrise', 'sunset'])
	expect(Math.abs(timeSubtract(events[0].time, EPOCH) - 3.673623231)).toBeLessThan(0.002)
	expect(Math.abs(timeSubtract(events[1].time, EPOCH) - 18.491828933)).toBeLessThan(0.002)
})
