import { expect, test } from 'bun:test'
import { closeApproachBPlane } from '../../../src/astronomy/orbits/orbit.bplane'
import { AU_KM, DAYSEC } from '../../../src/core/constants'
import { type Vec3, vecDot, vecLength } from '../../../src/math/linear-algebra/vec3'

// Apophis (99942) geocentric state during its 2029-04-13 Earth flyby, from JPL Horizons (ICRF equatorial,
// AU and AU/day, geometric, 2029-Apr-13 20:00 TDB). The published close approach is 38012 km at a
// hyperbolic excess speed near 5.84 km/s.
const APOPHIS_POSITION: Vec3 = [-3.739382606686898e-4, 6.252835449470995e-5, -1.687341276876984e-5]
const APOPHIS_VELOCITY: Vec3 = [3.04338798147783e-3, 1.743343223811018e-3, 1.940149213856787e-3]

// Converts AU to km and AU/day to km/s.
function toKm(au: number): number {
	return au * AU_KM
}
function toKmPerSecond(auPerDay: number): number {
	return (auPerDay * AU_KM) / DAYSEC
}

test('the Apophis 2029 flyby reproduces the known close-approach geometry', () => {
	const bplane = closeApproachBPlane(APOPHIS_POSITION, APOPHIS_VELOCITY)

	// Closest approach 38012 km and excess speed 5.84 km/s, matching the published flyby.
	expect(toKm(bplane.periapsisDistance)).toBeCloseTo(38012, -1)
	expect(toKmPerSecond(bplane.vInfinity)).toBeCloseTo(5.841, 2)

	// Gravitational focusing makes the impact parameter larger than the closest-approach distance.
	expect(bplane.impactParameter).toBeGreaterThan(bplane.periapsisDistance)
	expect(toKm(bplane.impactParameter)).toBeCloseTo(48301, -1)
})

test('the B-vector lies in the B-plane and matches its T/R components', () => {
	const bplane = closeApproachBPlane(APOPHIS_POSITION, APOPHIS_VELOCITY)

	// The B-vector is perpendicular to the incoming asymptote.
	expect(vecDot(bplane.bVector, bplane.sHat)).toBeCloseTo(0, 12)
	// Its length equals the impact parameter and equals the quadrature of its T/R components.
	expect(vecLength(bplane.bVector)).toBeCloseTo(bplane.impactParameter, 12)
	expect(Math.hypot(bplane.bt, bplane.br)).toBeCloseTo(bplane.impactParameter, 12)
	// Regression on the Horizons-derived components (equatorial-pole T/R convention).
	expect(toKm(bplane.bt)).toBeCloseTo(-43489, -1)
	expect(toKm(bplane.br)).toBeCloseTo(-21015, -1)
})

test('the S, T, R axes form a right-handed orthonormal frame', () => {
	const { sHat, tHat, rHat } = closeApproachBPlane(APOPHIS_POSITION, APOPHIS_VELOCITY)

	for (const axis of [sHat, tHat, rHat]) expect(vecLength(axis)).toBeCloseTo(1, 12)
	expect(vecDot(sHat, tHat)).toBeCloseTo(0, 12)
	expect(vecDot(sHat, rHat)).toBeCloseTo(0, 12)
	expect(vecDot(tHat, rHat)).toBeCloseTo(0, 12)
})

test('a bound relative orbit has no incoming asymptote and throws', () => {
	// Speed well below escape at this range: the relative orbit is elliptical, so there is no flyby.
	const slow: Vec3 = [0, 1e-4, 0]
	expect(() => closeApproachBPlane([1e-3, 0, 0], slow)).toThrow()
})

test('a radial head-on hyperbolic encounter has a zero impact parameter', () => {
	// Position parallel to velocity above escape speed: zero angular momentum, so a direct hit with zero
	// impact parameter and zero closest-approach distance, and finite (non-NaN) axes.
	const bplane = closeApproachBPlane([1e-3, 0, 0], [3e-3, 0, 0])

	expect(bplane.impactParameter).toBe(0)
	expect(bplane.bt).toBe(0)
	expect(bplane.br).toBe(0)
	expect(bplane.periapsisDistance).toBe(0)
	expect(bplane.vInfinity).toBeGreaterThan(0)
	// The asymptote and target-plane axes are a finite right-handed orthonormal frame.
	for (const axis of [bplane.sHat, bplane.tHat, bplane.rHat]) {
		expect(axis.some(Number.isNaN)).toBe(false)
		expect(vecLength(axis)).toBeCloseTo(1, 12)
	}
	expect(vecDot(bplane.sHat, bplane.tHat)).toBeCloseTo(0, 12)
	expect(vecDot(bplane.sHat, bplane.rHat)).toBeCloseTo(0, 12)
})
