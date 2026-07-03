import { expect, test } from 'bun:test'
import { icrs } from '../../../src/astronomy/coordinates/icrs'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { heliacalPhases } from '../../../src/astronomy/events/heliacal'
import { altitudeOf } from '../../../src/astronomy/events/horizon'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeSubtract, timeToDate, timeYMDHMS, utc } from '../../../src/astronomy/time/time'
import { type Vec3, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg, hms, toDeg } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'

// Sirius (ICRS J2000) and Cairo (~30N), the classic setting for the Sothic (heliacal) rising. The four
// phase instants are cross-checked against Skyfield (DE440, full IAU frames): at each computed instant the
// independent geometric altitude of the Sun and of Sirius agree with this model to ~0.02 deg, confirming the
// arc-of-vision geometry the events are built on.
const CAIRO = geodeticLocation(deg(31.2357), deg(30.0444), kilometer(0.023), Ellipsoid.WGS84)
const SIRIUS: Vec3 = icrs(hms(6, 45, 8.917), deg(-16.716116))

// A 4 h coarse step keeps the year-long day scan fast; it only sets the rise/set bracketing (Brent still
// refines each crossing to full precision), so the event instants are unchanged from the hourly default.
const STEP = 1 / 6

// Geocentric J2000 direction toward Sirius (fixed) and the Sun.
function siriusDirection(): Vec3 {
	return SIRIUS
}
function sunDirection(time: Time): Vec3 {
	return vecMinus(sun(time)[0], earth(time)[0])
}

// A year window bracketing all four phases, starting well after the July conjunction of Sirius.
const START = timeYMDHMS(2026, 6, 1, 0, 0, 0, Timescale.UTC)
const STOP = timeYMDHMS(2027, 6, 15, 0, 0, 0, Timescale.UTC)
// A shorter window around the August heliacal rising for the single-phase checks.
const RISING_START = timeYMDHMS(2026, 6, 1, 0, 0, 0, Timescale.UTC)
const RISING_STOP = timeYMDHMS(2026, 9, 15, 0, 0, 0, Timescale.UTC)

test('computes the four heliacal phases of Sirius in chronological order', () => {
	const phases = heliacalPhases(siriusDirection, sunDirection, CAIRO, START, STOP, { step: STEP })
	expect(phases.map((p) => p.kind)).toEqual(['heliacalRising', 'cosmicalSetting', 'acronychalRising', 'heliacalSetting'])
	// Each event sits at the object's horizon crossing with the Sun exactly the arc of vision below it.
	for (const phase of phases) {
		expect(toDeg(altitudeOf(SIRIUS, phase.time, CAIRO))).toBeCloseTo(-0.567, 1) // STANDARD_HORIZON
		expect(toDeg(altitudeOf(sunDirection(phase.time), phase.time, CAIRO))).toBeCloseTo(-toDeg(phase.arcusVisionis), 3)
	}
}, 10000)

test('matches the heliacal (Sothic) rising date of Sirius', () => {
	const rising = heliacalPhases(siriusDirection, sunDirection, CAIRO, RISING_START, RISING_STOP, { step: STEP }).find((p) => p.kind === 'heliacalRising')!
	// First morning Sirius clears the 11 deg arc of vision: 2026-08-05 UTC, the well-known early-August
	// Sothic rising. Skyfield puts the Sun at -11.19 deg and Sirius at -0.57 deg at this instant.
	const [year, month, day] = timeToDate(utc(rising.time))
	expect([year, month, day]).toEqual([2026, 8, 5])
	// On the transition day the arc of vision is just past the 11 deg threshold (within one day's ~0.9 deg).
	expect(toDeg(rising.arcusVisionis)).toBeGreaterThanOrEqual(11)
	expect(toDeg(rising.arcusVisionis)).toBeLessThan(11 + 1)
	// Independent Skyfield geometry at the same instant (baked literals).
	expect(toDeg(altitudeOf(sunDirection(rising.time), rising.time, CAIRO))).toBeCloseTo(-11.193, 1)
	expect(toDeg(altitudeOf(SIRIUS, rising.time, CAIRO))).toBeCloseTo(-0.574, 1)
}, 3000)

test('a larger arc of vision delays the heliacal rising', () => {
	const at11 = heliacalPhases(siriusDirection, sunDirection, CAIRO, RISING_START, RISING_STOP, { arcusVisionis: deg(11), step: STEP }).find((p) => p.kind === 'heliacalRising')!
	const at13 = heliacalPhases(siriusDirection, sunDirection, CAIRO, RISING_START, RISING_STOP, { arcusVisionis: deg(13), step: STEP }).find((p) => p.kind === 'heliacalRising')!
	// A fainter-object (deeper) arc of vision needs the Sun further down, reached later in the season.
	expect(timeToDate(utc(at13.time))[2]).toBeGreaterThan(timeToDate(utc(at11.time))[2])
}, 6000)

test('a circumpolar object has no heliacal phases', () => {
	// A star near the north celestial pole never sets from Cairo, so it has no rise/set crossings.
	const polar: Vec3 = icrs(hms(2, 0, 0), deg(85))
	expect(heliacalPhases(() => polar, sunDirection, CAIRO, RISING_START, RISING_STOP, { step: STEP }).length).toBe(0)
}, 3000)

test('does not report a phase whose crossing falls after stop', () => {
	// The heliacal rising crossing is 2026-08-05 02:24 UTC; a window ending 01:00 UTC that day must not report
	// it even though the last scanned day's rise/set window extends past stop.
	const stop = timeYMDHMS(2026, 8, 5, 1, 0, 0, Timescale.UTC)
	const phases = heliacalPhases(siriusDirection, sunDirection, CAIRO, RISING_START, stop, { step: STEP })
	expect(phases.some((p) => p.kind === 'heliacalRising')).toBe(false)
	// Every reported phase lies within the requested window.
	for (const phase of phases) {
		expect(timeSubtract(phase.time, RISING_START)).toBeGreaterThanOrEqual(0)
		expect(timeSubtract(stop, phase.time)).toBeGreaterThanOrEqual(0)
	}
}, 3000)

test('an empty window yields no phases', () => {
	expect(heliacalPhases(siriusDirection, sunDirection, CAIRO, STOP, START, { step: STEP }).length).toBe(0)
})
