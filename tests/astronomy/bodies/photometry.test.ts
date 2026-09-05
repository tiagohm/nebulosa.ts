import { expect, test } from 'bun:test'
import { planetMagnitude } from '../../../src/astronomy/bodies/photometry'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { earth, jupiter, mars, mercury, neptune, saturn, sun, uranus, venus } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, type Time, timeYMDHMS, toJulianEpoch } from '../../../src/astronomy/time/time'
import { type Vec3, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'

// Shared instant and the corresponding Julian year (Neptune's secular term).
const NOW = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
const YEAR = toJulianEpoch(NOW)

// Sun -> planet vector at NOW.
function sunToPlanet(body: (time: Time) => PositionAndVelocity) {
	return vecMinus(body(NOW)[0], sun(NOW)[0])
}

// Earth -> planet vector at NOW.
function earthToPlanet(body: (time: Time) => PositionAndVelocity) {
	return vecMinus(body(NOW)[0], earth(NOW)[0])
}

test('planetary visual magnitudes match the Mallama & Hilton 2018 reference', () => {
	// Cross-checked against Skyfield's planetary_magnitude (same r, delta, phase angle) to 1e-5 mag.
	expect(planetMagnitude('mercury', sunToPlanet(mercury), earthToPlanet(mercury))).toBeCloseTo(1.8312, 3)
	expect(planetMagnitude('venus', sunToPlanet(venus), earthToPlanet(venus))).toBeCloseTo(-4.0593, 3)
	expect(planetMagnitude('mars', sunToPlanet(mars), earthToPlanet(mars))).toBeCloseTo(1.3039, 3)
	expect(planetMagnitude('jupiter', sunToPlanet(jupiter), earthToPlanet(jupiter))).toBeCloseTo(-1.8121, 3)
	expect(planetMagnitude('saturn', sunToPlanet(saturn), earthToPlanet(saturn))).toBeCloseTo(0.7828, 3)
	expect(planetMagnitude('uranus', sunToPlanet(uranus), earthToPlanet(uranus))).toBeCloseTo(5.8112, 3)
	expect(planetMagnitude('neptune', sunToPlanet(neptune), earthToPlanet(neptune), { year: YEAR })).toBeCloseTo(7.7647, 3)
})

test('the magnitude reduces to the distance modulus at zero phase', () => {
	// Sun, planet and observer collinear (full phase) so the phase term vanishes.
	const sunToBody: Vec3 = [5, 0, 0]
	const observerToBody: Vec3 = [4, 0, 0]
	// Jupiter base -9.395 plus 5*log10(5*4).
	expect(planetMagnitude('jupiter', sunToBody, observerToBody)).toBeCloseTo(-9.395 + 5 * Math.log10(20), 10)
	// Earth has its own phase polynomial and the same distance modulus.
	expect(planetMagnitude('earth', sunToBody, observerToBody)).toBeCloseTo(-3.99 + 5 * Math.log10(20), 10)
})

test('Jupiter uses the large-phase photometric branch', () => {
	const phase = deg(30)
	const sunToBody: Vec3 = [5, 0, 0]
	const observerToBody: Vec3 = [4 * Math.cos(phase), 4 * Math.sin(phase), 0]
	const p = 30 / 180
	const phaseTerm = -2.5 * Math.log10(((((-1.876 * p + 2.809) * p - 0.062) * p - 0.363) * p - 1.507) * p + 1)

	expect(planetMagnitude('jupiter', sunToBody, observerToBody)).toBeCloseTo(-9.428 + 5 * Math.log10(20) + phaseTerm, 12)
})

test("Saturn's ringed model is undefined beyond a 6.5 deg phase angle", () => {
	// Phase angle ~10 deg with the rings included: outside the model's domain.
	const sunToBody: Vec3 = [10, 0, 0]
	const observerToBody: Vec3 = [10 * Math.cos(0.17), 10 * Math.sin(0.17), 0]
	expect(planetMagnitude('saturn', sunToBody, observerToBody)).toBeNaN()
	// The globe-alone variant stays defined.
	expect(Number.isNaN(planetMagnitude('saturn', sunToBody, observerToBody, { rings: false }))).toBeFalse()
})

test('Neptune has no phase term before the year 2000', () => {
	const s = sunToPlanet(neptune)
	const e = earthToPlanet(neptune)
	// The 2026 geometry has a phase angle near 1.95 deg, above the 1.9 deg limit.
	expect(planetMagnitude('neptune', s, e, { year: 1995 })).toBeNaN()
	expect(Number.isNaN(planetMagnitude('neptune', s, e, { year: 2026 }))).toBeFalse()
})
