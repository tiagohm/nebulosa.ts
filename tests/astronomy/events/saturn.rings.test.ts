import { expect, test } from 'bun:test'
import { SATURN_ROTATION, orientation } from '../../../src/astronomy/bodies/orientation'
import { SaturnRing } from '../../../src/astronomy/ephemeris/meeus'
import { analyticalSaturnianEphemeris, interpolatedSaturnianRingEphemeris, type SaturnianBody, type SaturnianEphemeris } from '../../../src/astronomy/ephemeris/saturnian'
import { SATURN_RING_MODEL, saturnRingEvents, saturnRingGeometry, saturnRingIllumination, saturnRingOpenings } from '../../../src/astronomy/events/saturn.rings'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS, tt } from '../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, SATURN_EQUATORIAL_RADIUS_KM, SATURN_POLAR_RADIUS_KM, SPEED_OF_LIGHT_AU_DAY } from '../../../src/core/constants'
import { type Vec3, vecLength, vecMinus, vecMulScalar, vecNormalize, vecCross } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'

const RINGS = interpolatedSaturnianRingEphemeris(analyticalSaturnianEphemeris)

// Planetocentric latitude from a planetodetic one on Saturn's IAU 1-bar spheroid (radians).
function centric(detic: number) {
	return Math.atan((SATURN_POLAR_RADIUS_KM / SATURN_EQUATORIAL_RADIUS_KM) ** 2 * Math.tan(detic))
}

function utc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
	return timeYMDHMS(year, month, day, hour, minute, second, Timescale.UTC)
}

function seconds(a: Time, b: Time) {
	return timeSubtract(a, b) * DAYSEC
}

// JPL Horizons API 1.2, target 699 from 500@399, quantities 13/14/15/17 (ObsSub-LAT and SunSub-LAT are
// apparent planetodetic latitudes, NP.ang the true-of-date north pole position angle), Saturn ephemeris
// sat441l, retrieved 2026-11-07.
const HORIZONS = [
	{ time: utc(2025, 1, 1), obsLat: 5.227768, sunLat: 2.285629, poleAngle: 5.2305, diameter: 16.57746 },
	{ time: utc(2025, 4, 15), obsLat: -1.477528, sunLat: 0.395439, poleAngle: 4.4504, diameter: 15.88564 },
	{ time: utc(2025, 7, 1), obsLat: -4.41362, sunLat: -1.013329, poleAngle: 4.0175, diameter: 17.70436 },
	{ time: utc(2038, 6, 1), obsLat: -8.047015, sunLat: -4.478604, poleAngle: -5.5092, diameter: 17.81808 },
	{ time: utc(2039, 12, 31), obsLat: 9.5866, sunLat: 6.353168, poleAngle: -3.2489, diameter: 17.42958 },
	{ time: utc(2026, 11, 1), obsLat: -8.064595, sunLat: -9.931961, poleAngle: 3.4014, diameter: 19.44274 },
] as const

test('the Earth opening, pole angle and disk size match JPL Horizons', () => {
	for (const reference of HORIZONS) {
		const geometry = saturnRingGeometry(analyticalSaturnianEphemeris, reference.time)
		// VSOP87E differs from DE441 by well under an arcsecond at Saturn.
		expect(toDeg(geometry.earthOpening)).toBeCloseTo(toDeg(centric(deg(reference.obsLat))), 3)
		expect(toDeg(geometry.polePositionAngle)).toBeCloseTo(reference.poleAngle, 2)
		expect(toDeg(2 * geometry.equatorialRadius) * 3600).toBeCloseTo(reference.diameter, 2)
		// Horizons' SunSub-LAT retards Saturn by the Saturn-Sun light time instead; the difference stays
		// below B′'s change over ~80 minutes (< 0.002°).
		expect(Math.abs(toDeg(geometry.solarOpening) - toDeg(centric(deg(reference.sunLat))))).toBeLessThan(0.002)
	}
})

test('the ring geometry agrees with Meeus chapter 45 within the pole-model difference', () => {
	for (const reference of HORIZONS) {
		const geometry = saturnRingGeometry(analyticalSaturnianEphemeris, reference.time)
		const t = tt(reference.time)
		const [b, b2, , p, a, minor] = SaturnRing.ring(t.day + t.fraction)
		// Meeus uses the older ring-plane elements of Harper and Taylor and adds aberration and nutation;
		// the IAU 2015 pole differs from them by about 0.02°.
		expect(Math.abs(toDeg(geometry.earthOpening - b))).toBeLessThan(0.02)
		expect(Math.abs(toDeg(geometry.solarOpening - b2))).toBeLessThan(0.02)
		expect(Math.abs(toDeg(geometry.polePositionAngle - p))).toBeLessThan(0.03)
		// Meeus's 375.35″ outer-ring diameter at 1 AU corresponds to a 136,076 km radius, 0.5% below the
		// NSSDC A-ring edge.
		expect((2 * geometry.ringSemiMajor) / (a * (SATURN_RING_MODEL.outerRadius / 136076))).toBeCloseTo(1, 3)
		expect(geometry.ringSemiMinor / geometry.ringSemiMajor).toBeCloseTo(Math.abs(Math.sin(geometry.earthOpening)), 12)
		expect(minor).toBeGreaterThan(0)
	}
})

// JPL Horizons ring-plane crossings (ObsSub-LAT zeros at 5-minute steps, linearly interpolated), UTC.
const EARTH_CROSSINGS = [utc(2025, 3, 23, 17, 46, 48), utc(2038, 10, 15, 16, 43, 32), utc(2039, 4, 1, 18, 25, 37), utc(2039, 7, 9, 17, 11, 22)]

// JPL Horizons SunSub-LAT zeros, UTC. They retard Saturn by the Saturn-Sun light time; see saturnRingEvents.
const HORIZONS_SOLAR_CROSSINGS = [utc(2025, 5, 6, 15, 35, 5), utc(2039, 1, 22, 21, 5, 32)]

test('the 2025 Earth and solar crossings are distinct events six weeks apart', () => {
	const events = saturnRingEvents(RINGS, utc(2024, 6, 1), utc(2026, 6, 1))
	const earth = events.filter((e) => e.kind === 'earthPlaneCrossing')
	const sun = events.filter((e) => e.kind === 'solarPlaneCrossing')
	expect(earth.length).toBe(1)
	expect(sun.length).toBe(1)
	expect(Math.abs(seconds(earth[0].time, EARTH_CROSSINGS[0]))).toBeLessThan(120)
	expect(toDeg(earth[0].earthOpening)).toBeCloseTo(0, 6)
	expect(timeSubtract(sun[0].time, earth[0].time)).toBeCloseTo(43.9, 0)

	// The Earth leaves the north side: B falls through zero, and the Sun still lights the north face.
	expect(toDeg(earth[0].solarOpening)).toBeGreaterThan(0.5)
	expect(toDeg(sun[0].earthOpening)).toBeLessThan(-2)

	// The solar crossing is one Saturn-Sun light time before Horizons' sub-solar zero.
	const state = saturnRingOpenings(analyticalSaturnianEphemeris, sun[0].time).state
	const lightTime = (vecLength(vecMinus(state.sun, state.planet)) / SPEED_OF_LIGHT_AU_DAY) * DAYSEC
	expect(Math.abs(seconds(HORIZONS_SOLAR_CROSSINGS[0], sun[0].time) - lightTime)).toBeLessThan(120)

	// After the crossing the Earth approaches the plane again in late 2025 without crossing it.
	const approach = events.find((e) => e.kind === 'nearPlaneApproach')
	expect(approach).toBeDefined()
	expect(toDeg(approach!.earthOpening)).toBeLessThan(0)
	expect(toDeg(approach!.earthOpening)).toBeGreaterThan(-1)
	expect(seconds(approach!.time, utc(2025, 11, 1))).toBeGreaterThan(0)
	expect(seconds(approach!.time, utc(2025, 12, 31))).toBeLessThan(0)
})

test('the 2038-2039 season has three Earth crossings and one solar crossing', () => {
	const events = saturnRingEvents(RINGS, utc(2038, 1, 1), utc(2040, 1, 1))
	const earth = events.filter((e) => e.kind === 'earthPlaneCrossing')
	const sun = events.filter((e) => e.kind === 'solarPlaneCrossing')
	expect(earth.length).toBe(3)
	expect(sun.length).toBe(1)
	for (const [i, e] of earth.entries()) expect(Math.abs(seconds(e.time, EARTH_CROSSINGS[i + 1]))).toBeLessThan(180)
	// The signs alternate: south to north, north to south, south to north.
	expect(toDeg(saturnRingOpenings(RINGS, timeShift(earth[0].time, 1)).earthOpening)).toBeGreaterThan(0)
	expect(toDeg(saturnRingOpenings(RINGS, timeShift(earth[1].time, 1)).earthOpening)).toBeLessThan(0)
	expect(toDeg(saturnRingOpenings(RINGS, timeShift(earth[2].time, 1)).earthOpening)).toBeGreaterThan(0)
	expect(seconds(sun[0].time, earth[0].time)).toBeGreaterThan(0)
	expect(seconds(sun[0].time, earth[1].time)).toBeLessThan(0)

	// The extremum between the last two crossings is an opening extremum, not a near-plane approach.
	expect(events.some((e) => e.kind === 'nearPlaneApproach')).toBeFalse()
	const between = events.filter((e) => seconds(e.time, earth[1].time) > 0 && seconds(e.time, earth[2].time) < 0)
	expect(between.map((e) => e.kind)).toEqual(['openingMinimum'])
})

test('consecutive windows partition the events without loss or duplication', () => {
	const whole = saturnRingEvents(RINGS, utc(2038, 1, 1), utc(2040, 1, 1))
	// Split exactly at the first Earth crossing, so the split falls on an event.
	const split = whole.find((e) => e.kind === 'earthPlaneCrossing')!.time
	const parts = [...saturnRingEvents(RINGS, utc(2038, 1, 1), split), ...saturnRingEvents(RINGS, split, utc(2040, 1, 1))]
	expect(parts.map((e) => e.kind)).toEqual(whole.map((e) => e.kind))
	for (const [i, e] of parts.entries()) expect(Math.abs(seconds(e.time, whole[i].time))).toBeLessThan(1)
})

test('the ring interpolator stays within 25 km of the source for the ring bodies', () => {
	const start = utc(2025, 1, 1)

	for (let i = 0; i < 200; i++) {
		const time = timeShift(start, i * 1.37)

		for (const body of ['sun', 'earth', 'saturn'] as const) {
			const exact = analyticalSaturnianEphemeris.position(body, time)
			const interpolated = RINGS.position(body, time)
			expect(vecLength(vecMinus(exact, interpolated)) * AU_KM).toBeLessThan(25)
		}
	}
})

// Saturn's IAU pole at a time (unit, ICRF).
function pole(time: Time): Vec3 {
	const { poleRa, poleDec } = orientation(SATURN_ROTATION, time)
	return [Math.cos(poleDec) * Math.cos(poleRa), Math.cos(poleDec) * Math.sin(poleRa), Math.sin(poleDec)]
}

// A Saturnian ephemeris of fixed positions around a Saturn 9 AU from the Earth.
function fixed(toEarth: Vec3, toSun: Vec3): SaturnianEphemeris {
	const saturn: Vec3 = [9, 0, 0]
	const positions: Partial<Record<SaturnianBody, Vec3>> = { saturn, earth: vecMinus(saturn, vecMulScalar(toEarth, -9)), sun: vecMinus(saturn, vecMulScalar(toSun, -9.5)) }
	return { source: { kind: 'analytical', planetary: 'VSOP87E', satellites: 'TASS1.7' }, position: (body) => [...positions[body]!] }
}

test('an edge-on ring plane gives finite geometry and a zero minor axis', () => {
	const time = utc(2025, 3, 23)
	const n = pole(time)
	const inPlane = vecNormalize(vecCross(n, [0, 0, 1]))
	const geometry = saturnRingGeometry(fixed(inPlane, inPlane), time)
	expect(toDeg(geometry.earthOpening)).toBeCloseTo(0, 6)
	expect(geometry.ringSemiMinor).toBeCloseTo(0, 12)
	expect(geometry.illumination).toBe('edgeOn')
	expect([geometry.polePositionAngle, geometry.polarRadius, geometry.ringSemiMajor].every(Number.isFinite)).toBeTrue()
	expect(geometry.polarRadius / geometry.equatorialRadius).toBeCloseTo(SATURN_POLAR_RADIUS_KM / SATURN_EQUATORIAL_RADIUS_KM, 6)

	// Pole-on, the outline is a circle and the rings are a full ellipse.
	const poleOn = saturnRingGeometry(fixed(n, n), time)
	expect(toDeg(poleOn.earthOpening)).toBeCloseTo(90, 4)
	expect(poleOn.polarRadius / poleOn.equatorialRadius).toBeCloseTo(1, 6)
	expect(poleOn.ringSemiMinor / poleOn.ringSemiMajor).toBeCloseTo(1, 6)
	expect(Number.isFinite(poleOn.polePositionAngle)).toBeTrue()
})

test('the illumination classifies same, opposite and edge-on faces', () => {
	expect(saturnRingIllumination(deg(5), deg(3))).toBe('sameFace')
	expect(saturnRingIllumination(deg(-1.2), deg(0.3))).toBe('oppositeFaces')
	expect(saturnRingIllumination(deg(0.05), deg(3))).toBe('edgeOn')
	expect(saturnRingIllumination(deg(-4), deg(-0.01))).toBe('edgeOn')
})
