import { expect, test } from 'bun:test'
import { lightTravelTime, observerState, radialVelocityCorrection } from '../../../src/astronomy/coordinates/correction'
import { eraEpv00 } from '../../../src/astronomy/coordinates/erfa/earth'
import { eraC2s } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { tdb, Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI } from '../../../src/core/constants'
import { vecLength } from '../../../src/math/linear-algebra/vec3'
import { deg, hour } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { toKilometerPerSecond } from '../../../src/math/units/velocity'

// La Silla Observatory.
const LOCATION = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
const TIME = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC)
const TDB = tdb(TIME)
const EARTH = eraEpv00(TDB.day, TDB.fraction)
const [HELIOCENTRIC, BARYCENTRIC] = EARTH

// The radial-velocity correction is exactly the projection of the observer
// velocity onto the line of sight, so aiming at the velocity vector itself must
// return its full magnitude, and the opposite direction its negative.
test('radial velocity correction equals the observer speed along its own direction', () => {
	const [, vel] = observerState(TIME, BARYCENTRIC, LOCATION)
	const speed = vecLength(vel)
	const [ra, dec] = eraC2s(vel[0], vel[1], vel[2])

	expect(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION)).toBeCloseTo(speed, 12)
	expect(radialVelocityCorrection(ra + PI, -dec, TIME, BARYCENTRIC, LOCATION)).toBeCloseTo(-speed, 12)
})

// Same projection identity for the light-travel time using the observer
// position instead of its velocity.
test('light travel time equals the observer distance along its own direction', () => {
	const [pos] = observerState(TIME, BARYCENTRIC, LOCATION)
	const [ra, dec] = eraC2s(pos[0], pos[1], pos[2])
	const ltt = lightTravelTime(ra, dec, TIME, BARYCENTRIC, LOCATION)

	// |pos|/c in days; |pos| ~ 1 AU so ltt ~ 1 AU light time ~ 0.0058 days.
	expect(ltt).toBeGreaterThan(0)
	expect(ltt).toBeLessThan(0.006)
	expect(lightTravelTime(ra + PI, -dec, TIME, BARYCENTRIC, LOCATION)).toBeCloseTo(-ltt, 12)
})

// Physical magnitudes: the annual term dominates (Earth orbital speed ~29.8
// km/s), the diurnal term is at most ~0.46 km/s, and the barycentric light
// travel time never exceeds the ~8.3 min one-AU light time.
test('corrections stay within physical bounds', () => {
	const ra = hour(5.5)
	const dec = deg(-5)

	const rv = toKilometerPerSecond(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION))
	expect(Math.abs(rv)).toBeLessThan(30.5)

	const ltt = lightTravelTime(ra, dec, TIME, BARYCENTRIC, LOCATION)
	expect(Math.abs(ltt)).toBeLessThan(0.0058)
})

// Adding the observing site only introduces the diurnal rotation term, which is
// bounded by the equatorial ground speed (~0.465 km/s).
test('topocentric correction differs from geocentric only by the diurnal term', () => {
	const ra = hour(5.5)
	const dec = deg(-5)

	const geocentric = toKilometerPerSecond(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC))
	const topocentric = toKilometerPerSecond(radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION))

	expect(Math.abs(topocentric - geocentric)).toBeLessThan(0.466)
})

// Heliocentric and barycentric references differ by the Sun's barycentric
// motion, which is small but non-zero.
test('heliocentric and barycentric corrections differ', () => {
	const ra = hour(5.5)
	const dec = deg(-5)

	const bary = radialVelocityCorrection(ra, dec, TIME, BARYCENTRIC, LOCATION)
	const helio = radialVelocityCorrection(ra, dec, TIME, HELIOCENTRIC, LOCATION)

	expect(bary).not.toBe(helio)
	expect(Number.isFinite(bary)).toBe(true)
	expect(Number.isFinite(helio)).toBe(true)
})
