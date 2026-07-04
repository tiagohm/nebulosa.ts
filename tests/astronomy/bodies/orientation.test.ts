import { expect, test } from 'bun:test'
import { bodyFixedMatrix, JUPITER_ROTATION, MARS_ROTATION, MOON_ROTATION, orientation, positionAngleOfPole, SATURN_ROTATION, subObserverPoint, subSolarPoint, SUN_ROTATION, VENUS_ROTATION } from '../../../src/astronomy/bodies/orientation'
import { moon } from '../../../src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, jupiter, mars, saturn, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, type Time, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { matMulVec } from '../../../src/math/linear-algebra/mat3'
import { vecMinus, vecMulScalar, type Vec3 } from '../../../src/math/linear-algebra/vec3'
import { normalizeAngle, toDeg } from '../../../src/math/units/angle'

// J2000.0 epoch (TT) and a shared observation instant.
const J2000_TT = timeYMDHMS(2000, 1, 1, 12, 0, 0, Timescale.TT)
const NOW = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

// Vector from a body centre to the Earth (ICRF, AU) at NOW.
function toEarth(body: (time: Time) => readonly [Vec3, Vec3]) {
	return vecMinus(earth(NOW)[0], body(NOW)[0])
}

// Vector from a body centre to the Sun (ICRF, AU) at NOW.
function toSun(body: (time: Time) => readonly [Vec3, Vec3]) {
	return vecMinus(sun(NOW)[0], body(NOW)[0])
}

test('orientation evaluates the IAU constants at J2000', () => {
	const m = orientation(MARS_ROTATION, J2000_TT)
	expect(toDeg(m.poleRa)).toBeCloseTo(317.68143, 4)
	expect(toDeg(m.poleDec)).toBeCloseTo(52.8865, 4)
	expect(toDeg(m.primeMeridian)).toBeCloseTo(176.63, 3)

	const s = orientation(SUN_ROTATION, J2000_TT)
	expect(toDeg(s.poleRa)).toBeCloseTo(286.13, 5)
	expect(toDeg(s.poleDec)).toBeCloseTo(63.87, 5)
})

test('the prime meridian advances at the rotation rate', () => {
	// Mars: W(d+1) - W(d) = 350.89198226 deg.
	const w0 = orientation(MARS_ROTATION, J2000_TT).primeMeridian
	const w1 = orientation(MARS_ROTATION, timeShift(J2000_TT, 1)).primeMeridian
	expect(toDeg(normalizeAngle(w1 - w0))).toBeCloseTo(350.89198226, 4)

	// Venus rotates retrograde, so W decreases.
	const v0 = orientation(VENUS_ROTATION, J2000_TT).primeMeridian
	const v1 = orientation(VENUS_ROTATION, timeShift(J2000_TT, 1)).primeMeridian
	expect(v1).toBeLessThan(v0)
})

test('the body-fixed matrix maps the pole direction to +Z', () => {
	const { poleRa, poleDec } = orientation(JUPITER_ROTATION, NOW)
	const pole: Vec3 = [Math.cos(poleDec) * Math.cos(poleRa), Math.cos(poleDec) * Math.sin(poleRa), Math.sin(poleDec)]
	const [x, y, z] = matMulVec(bodyFixedMatrix(JUPITER_ROTATION, NOW), pole)
	expect(x).toBeCloseTo(0, 12)
	expect(y).toBeCloseTo(0, 12)
	expect(z).toBeCloseTo(1, 12)
})

test("the Sun's sub-Earth latitude is the heliographic B0", () => {
	// B0 on 2026-06-29 is about +2.6 deg (B0 crosses zero on ~June 5 and peaks +7.25 deg in early Sept).
	const b0 = subObserverPoint(SUN_ROTATION, NOW, toEarth(sun))
	expect(toDeg(b0.latitude)).toBeCloseTo(2.6155, 3)
})

test("the Sun's pole position angle matches the solar P angle", () => {
	// SunPy (P, B0, L0) for 2026-06-29 00:00 UTC gives P = -3.6151 deg; the ~0.002 deg residual is the
	// neglected aberration of the disk-centre direction.
	const p = positionAngleOfPole(SUN_ROTATION, NOW, toEarth(sun))
	expect(toDeg(p)).toBeCloseTo(-3.615, 2)
})

test("Saturn's sub-Earth latitude is the ring opening angle", () => {
	// One year after the 2025 ring-plane crossing the south face is tilted toward Earth: B is negative.
	const b = subObserverPoint(SATURN_ROTATION, NOW, toEarth(saturn))
	expect(toDeg(b.latitude)).toBeCloseTo(-8.9786, 3)
	expect(toDeg(b.longitude)).toBeCloseTo(351.3335, 3)
})

test('sub-observer and sub-solar points for Mars and Jupiter', () => {
	const marsObs = subObserverPoint(MARS_ROTATION, NOW, toEarth(mars))
	const marsSun = subSolarPoint(MARS_ROTATION, NOW, toEarth(mars), toSun(mars))
	expect(toDeg(marsObs.longitude)).toBeCloseTo(131.8478, 3)
	expect(toDeg(marsObs.latitude)).toBeCloseTo(-9.8574, 3)
	expect(toDeg(marsSun.longitude)).toBeCloseTo(107.5694, 3)
	expect(toDeg(marsSun.latitude)).toBeCloseTo(-19.1716, 3)

	const jupiterObs = subObserverPoint(JUPITER_ROTATION, NOW, toEarth(jupiter))
	expect(toDeg(jupiterObs.longitude)).toBeCloseTo(95.6065, 3)
	expect(toDeg(jupiterObs.latitude)).toBeCloseTo(0.9432, 3)
})

test('Moon libration, sub-solar point and pole angle match JPL Horizons', () => {
	// Geocentric vectors at NOW: Moon -> Earth and Moon -> Sun.
	const moonGeocentric = moon(NOW)[0]
	const toEarth = vecMulScalar(moonGeocentric, -1)
	const toSun = vecMinus(vecMinus(sun(NOW)[0], earth(NOW)[0]), moonGeocentric)

	// JPL Horizons (geocentric, 2026-06-29 00:00 UTC): ObsSub 359.874/6.049, SunSub 10.718/1.318,
	// north-pole position angle 2.256 deg. The ~0.003 deg residual is the ELP/MPP02 vs DE440 ephemeris
	// difference plus the neglected aberration.
	const obs = subObserverPoint(MOON_ROTATION, NOW, toEarth)
	expect(toDeg(obs.longitude)).toBeCloseTo(359.874, 2)
	expect(toDeg(obs.latitude)).toBeCloseTo(6.049, 2)

	const sub = subSolarPoint(MOON_ROTATION, NOW, toEarth, toSun)
	expect(toDeg(sub.longitude)).toBeCloseTo(10.718, 2)
	expect(toDeg(sub.latitude)).toBeCloseTo(1.318, 2)

	expect(toDeg(positionAngleOfPole(MOON_ROTATION, NOW, toEarth))).toBeCloseTo(2.256, 2)
})

test('light-time retards the central meridian of a fast rotator', () => {
	// Jupiter turns 870.536 deg/day; over the ~51.6 min light time the central meridian shifts ~31 deg.
	const observer = toEarth(jupiter)
	const withLightTime = subObserverPoint(JUPITER_ROTATION, NOW, observer)
	const [x, y] = matMulVec(bodyFixedMatrix(JUPITER_ROTATION, NOW), observer)
	const withoutLightTime = normalizeAngle(Math.atan2(y, x))
	expect(toDeg(normalizeAngle(withLightTime.longitude - withoutLightTime))).toBeCloseTo(31.176, 1)
})
