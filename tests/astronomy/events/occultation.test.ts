import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { occultationCandidates } from '../../../src/astronomy/events/occultation'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { KeplerOrbit } from '../../../src/astronomy/orbits/asteroid'
import { type Time, Timescale, time, timeShift, timeSubtract } from '../../../src/astronomy/time/time'
import { AU_M, DAYSEC, GM_SUN_PITJEVA_2005, ONE_SECOND, SPEED_OF_LIGHT } from '../../../src/core/constants'
import { matIdentity } from '../../../src/math/linear-algebra/mat3'
import type { Vec3 } from '../../../src/math/linear-algebra/vec3'
import { deg, toArcsec } from '../../../src/math/units/angle'
import { kilometer, toKilometer } from '../../../src/math/units/distance'

// Light travel time in days per AU (matches astrometry.lightTime).
const LIGHT_TIME_PER_AU = AU_M / SPEED_OF_LIGHT / DAYSEC

// A synthetic encounter validates the geometry exactly: a body at fixed range D drifts transversely at a
// constant rate past a star fixed on the +x axis, seen by an observer at the origin. The topocentric
// separation is a clean V whose minimum, chord duration and apparent speed have closed forms.
const CROSSING: Time = time(2461200.5, 0, Timescale.TDB)
const RANGE = 2 // topocentric distance, AU
const IMPACT = 1e-6 // transverse miss distance at closest approach, AU
const CROSS_RATE = 2e-4 // transverse drift, AU/day
const BODY_RADIUS = 3e-6 // physical radius (~449 km), AU

// Observer pinned at the shared origin (zero position and velocity).
function fixedObserver(): PositionAndVelocity {
	return [
		[0, 0, 0],
		[0, 0, 0],
	]
}

// Body at [RANGE, IMPACT, CROSS_RATE * dt]: on the +x line of sight at CROSSING, drifting in z.
function driftingBody(t: Time): PositionAndVelocity {
	const dt = timeSubtract(t, CROSSING)
	return [
		[RANGE, IMPACT, CROSS_RATE * dt],
		[0, 0, CROSS_RATE],
	]
}

const STAR: Vec3 = [1, 0, 0]

test('finds the appulse of a straight-line encounter with the analytic chord and speed', () => {
	const start = timeShift(CROSSING, -0.02)
	const stop = timeShift(CROSSING, 0.02)
	// Light time disabled so the geometry matches the closed-form values exactly.
	const candidates = occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { radius: BODY_RADIUS, lightTimeIterations: 0 })
	expect(candidates.length).toBe(1)

	const appulse = candidates[0]
	// Appulse at the crossing instant, minimum separation = impact / range (small angle).
	expect(timeSubtract(appulse.time, CROSSING) * DAYSEC).toBeCloseTo(0, 1)
	expect(appulse.separation).toBeCloseTo(IMPACT / RANGE, 9)
	expect(appulse.distance).toBeCloseTo(RANGE, 8)
	expect(appulse.angularRadius).toBeCloseTo(Math.asin(BODY_RADIUS / RANGE), 9)

	// The disk covers the star, and the apparent speed is the transverse rate over the range.
	expect(appulse.occultation).toBe(true)
	expect(appulse.relativeAngularSpeed).toBeCloseTo(CROSS_RATE / RANGE, 8)

	// Chord duration = 2*sqrt(R^2 - b^2) / crossRate (transverse length over transverse speed), in seconds.
	const expectedDuration = ((2 * Math.sqrt(BODY_RADIUS * BODY_RADIUS - IMPACT * IMPACT)) / CROSS_RATE) * DAYSEC
	expect(appulse.duration).toBeCloseTo(expectedDuration, 0)
})

test('a point body (zero radius) reports the appulse as a near-miss, not an occultation', () => {
	const start = timeShift(CROSSING, -0.02)
	const stop = timeShift(CROSSING, 0.02)
	const [appulse] = occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { lightTimeIterations: 0 })
	expect(appulse.occultation).toBe(false)
	expect(appulse.duration).toBeUndefined()
	// The appulse separation is unchanged; only the occultation test differs.
	expect(appulse.separation).toBeCloseTo(IMPACT / RANGE, 9)
})

test('maxSeparation filters appulses wider than the limit', () => {
	const start = timeShift(CROSSING, -0.02)
	const stop = timeShift(CROSSING, 0.02)
	// Below the minimum separation: nothing passes.
	expect(occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { lightTimeIterations: 0, maxSeparation: IMPACT / RANGE / 2 }).length).toBe(0)
	// Above it: the appulse is reported.
	expect(occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { lightTimeIterations: 0, maxSeparation: (IMPACT / RANGE) * 2 }).length).toBe(1)
})

test('finds an appulse anywhere in a window shorter than the default step', () => {
	// A 20 s window is far shorter than the 60 s default step, so the effective step must be capped and the
	// window padded, otherwise searchExtrema returns nothing. The appulse is caught whether it sits at the
	// centre or hard against either boundary (the first/last coarse interval an endpoint scan cannot bracket).
	for (const offset of [-10, -9, 0, 9, 10]) {
		const start = timeShift(CROSSING, (offset - 10) * ONE_SECOND)
		const stop = timeShift(CROSSING, (offset + 10) * ONE_SECOND)
		const candidates = occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { radius: BODY_RADIUS, lightTimeIterations: 0 })
		expect(candidates.length).toBe(1)
		expect(candidates[0].occultation).toBe(true)
		expect(timeSubtract(candidates[0].time, CROSSING) * DAYSEC).toBeCloseTo(0, 1)
	}
})

test('does not report an appulse whose minimum lies outside the window', () => {
	// The crossing is 2 s before the window opens, inside the one-step padding, so it gets bracketed and
	// refined; the in-window filter must then drop it.
	const start = timeShift(CROSSING, 2 * ONE_SECOND)
	const stop = timeShift(CROSSING, 22 * ONE_SECOND)
	const candidates = occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { radius: BODY_RADIUS, lightTimeIterations: 0 })
	expect(candidates.length).toBe(0)
})

test('the light-time correction retards the body and shifts the appulse later by the travel time', () => {
	const start = timeShift(CROSSING, -0.02)
	const stop = timeShift(CROSSING, 0.03)
	const geometric = occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { radius: BODY_RADIUS, lightTimeIterations: 0 })[0]
	const corrected = occultationCandidates(driftingBody, STAR, fixedObserver, start, stop, { radius: BODY_RADIUS, lightTimeIterations: 2 })[0]
	// The body is seen where it was tau = RANGE * lightTime/AU earlier, so the crossing is observed later.
	const shift = timeSubtract(corrected.time, geometric.time)
	expect(shift).toBeCloseTo(RANGE * LIGHT_TIME_PER_AU, 5)
})

test('finds a real topocentric appulse of Ceres against its own line of sight', () => {
	// Heliocentric Ceres state (ICRF equatorial, AU/day) at JD 2461200.5 TDB from JPL Horizons.
	const EPOCH: Time = time(2461200.5, 0, Timescale.TDB)
	const orbit = new KeplerOrbit([1.414905393343522, 2.2479053286939, 7.722476360317566e-1], [-9.08092698547858e-3, 3.499459682146027e-3, 3.499457832664595e-3], EPOCH, GM_SUN_PITJEVA_2005, matIdentity())
	const site = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84)

	// Barycentric samplers sharing one origin: Ceres = Sun + heliocentric state; observer = topocentric.
	const target = (t: Time): PositionAndVelocity => {
		const [sp, sv] = sun(t)
		const [hp, hv] = orbit.at(t)
		return [
			[sp[0] + hp[0], sp[1] + hp[1], sp[2] + hp[2]],
			[sv[0] + hv[0], sv[1] + hv[1], sv[2] + hv[2]],
		]
	}
	const observer = (t: Time): PositionAndVelocity => observerState(t, earth(t), site) as PositionAndVelocity

	// Anchor a star exactly on Ceres's geometric topocentric direction at a chosen instant, so an appulse of
	// separation ~0 must exist there. Building the star and screening both without light time keeps them
	// consistent, which exercises the ephemeris and observer-parallax wiring end to end.
	const anchor = timeShift(EPOCH, 0.3)
	const [tp] = target(anchor)
	const [op] = observer(anchor)
	const star: Vec3 = [tp[0] - op[0], tp[1] - op[1], tp[2] - op[2]]

	const candidates = occultationCandidates(target, star, observer, timeShift(anchor, -0.05), timeShift(anchor, 0.05), { radius: 469 / (AU_M / 1000), lightTimeIterations: 0, step: 300 / DAYSEC })
	const appulse = candidates.find((c) => Math.abs(timeSubtract(c.time, anchor)) < 0.01)
	expect(appulse).toBeDefined()
	// The star sits on the line of sight, so the separation collapses to the Brent tolerance.
	expect(toArcsec(appulse!.separation)).toBeLessThan(0.5)
	// Ceres is a few AU away and the topocentric geometry is finite and sensible.
	expect(toKilometer(appulse!.distance)).toBeGreaterThan(1.5 * (AU_M / 1000))
	expect(appulse!.relativeAngularSpeed).toBeGreaterThan(0)
})
