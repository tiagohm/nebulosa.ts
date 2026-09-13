import { expect, test } from 'bun:test'
import { KeplerOrbit } from '../../../src/astronomy/orbits/asteroid'
import { moid } from '../../../src/astronomy/orbits/moid'
import { Timescale, time } from '../../../src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from '../../../src/core/constants'
import { matIdentity } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecDot } from '../../../src/math/linear-algebra/vec3'
import { normalizePI } from '../../../src/math/units/angle'

// Heliocentric states (Sun-centred, ICRF equatorial, AU and AU/day, geometric) at JD 2461200.5 TDB from
// JPL Horizons, with the Earth MOID published by the JPL Small-Body Database at the same solution epoch.
const IDENTITY = matIdentity()
const EPOCH = time(2461200.5, 0, Timescale.TDB)

// Builds a heliocentric KeplerOrbit in the ICRF equatorial frame.
function heliocentricOrbit(position: Vec3, velocity: Vec3): KeplerOrbit {
	return new KeplerOrbit(position, velocity, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
}

// Orbit tangent dr/dν (AU/rad) by the same central difference the refiner uses, for stationarity checks.
function orbitTangent(orbit: KeplerOrbit, nu: number): Vec3 {
	const h = 1e-5
	const plus = orbit.positionAtTrueAnomaly(nu + h)
	const minus = orbit.positionAtTrueAnomaly(nu - h)
	return [(plus[0] - minus[0]) / (2 * h), (plus[1] - minus[1]) / (2 * h), (plus[2] - minus[2]) / (2 * h)]
}

const EARTH = heliocentricOrbit([-2.139643995461386e-1, -9.10369590875501e-1, -3.946284477233859e-1], [1.653870730744617e-2, -3.392349872193463e-3, -1.471244370548932e-3])
const CERES = heliocentricOrbit([1.414905393343522, 2.2479053286939, 7.722476360317566e-1], [-9.08092698547858e-3, 3.499459682146027e-3, 3.499457832664595e-3])
const EROS = heliocentricOrbit([-1.158993982497945, -5.306759952015061e-1, -5.107638781319018e-1], [4.824359618549828e-3, -1.280096500658081e-2, -6.396039805884967e-3])
const APOPHIS = heliocentricOrbit([-9.239966398806005e-1, 5.636773710014709e-1, 1.861766030828077e-1], [-8.138789687781776e-3, -1.148145591898846e-2, -4.471286309082429e-3])

test('the Earth MOID of Ceres matches the Small-Body Database', () => {
	// SBDB Earth MOID of 1 Ceres: 1.58 AU.
	expect(moid(CERES, EARTH).distance).toBeCloseTo(1.58, 2)
})

test('the Earth MOID of Eros matches the Small-Body Database', () => {
	// SBDB Earth MOID of 433 Eros: 0.149 AU.
	expect(moid(EROS, EARTH).distance).toBeCloseTo(0.149, 3)
})

test('the Earth MOID of Apophis matches the Small-Body Database', () => {
	// SBDB Earth MOID of 99942 Apophis: 0.000108 AU. This near-tangent (potentially hazardous) case has a
	// narrow distance valley, which the Gauss-Newton refinement resolves even from the coarse grid.
	const result = moid(APOPHIS, EARTH)
	expect(result.distance).toBeCloseTo(0.000108, 5)
	// The order of the arguments does not change the minimum distance.
	expect(moid(EARTH, APOPHIS).distance).toBeCloseTo(result.distance, 8)
})

test('the MOID of concentric coplanar circular orbits is the radius difference', () => {
	// Two coplanar circles of radii 1 and 1.5 AU are everywhere 0.5 AU apart at their closest.
	const inner = KeplerOrbit.meanAnomaly(1, 0, 0, 0, 0, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	const outer = KeplerOrbit.meanAnomaly(1.5, 0, 0, 0, 0, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	expect(moid(inner, outer).distance).toBeCloseTo(0.5, 6)
})

test('the MOID of inclined concentric circular orbits is the radius difference at the node', () => {
	// Confocal circles of 1 and 1.5 AU, relative inclination 0.5 rad, node at Ω = 1 rad. The closest
	// points are the nodes: distance 0.5 AU at (ν1, ν2) = (Ω, 0). Undamped Gauss-Newton oscillates
	// around that minimum because the residual curvature is comparable to JtJ, and used to stop ~0.014
	// rad short with a non-stationary pair.
	const inner = KeplerOrbit.meanAnomaly(1, 0, 0, 0, 0, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	const outer = KeplerOrbit.meanAnomaly(1.5, 0, 0.5, 1, 0, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	const result = moid(inner, outer)
	expect(result.distance).toBeCloseTo(0.5, 10)
	expect(normalizePI(result.trueAnomaly1 - 1)).toBeCloseTo(0, 8)
	expect(normalizePI(result.trueAnomaly2)).toBeCloseTo(0, 8)

	const p1 = inner.positionAtTrueAnomaly(result.trueAnomaly1)
	const p2 = outer.positionAtTrueAnomaly(result.trueAnomaly2)
	const separation: Vec3 = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]]
	expect(Math.abs(vecDot(orbitTangent(inner, result.trueAnomaly1), separation))).toBeLessThan(1e-10)
	expect(Math.abs(vecDot(orbitTangent(outer, result.trueAnomaly2), separation))).toBeLessThan(1e-10)
})

test('the MOID of nested coplanar ellipses is the apsidal gap when periapsis is off the grid', () => {
	// Inner a = 1, e = 0.1; outer periapsis 1.2 AU, e = 0.1, ω = π + 1°. The 1° offset puts the closest
	// apsides off the 2 deg grid, where coplanar parallel tangents used to abort refinement at 0.101 AU.
	const inner = KeplerOrbit.meanAnomaly(1 * (1 - 0.1 * 0.1), 0.1, 0, 0, 0, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	const outer = KeplerOrbit.meanAnomaly((1.2 / 0.9) * (1 - 0.1 * 0.1), 0.1, 0, 0, Math.PI + Math.PI / 180, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	expect(moid(inner, outer).distance).toBeCloseTo(0.1000088, 6)
})

test('the MOID of nearly similar orbits follows the diagonal valley to the continuous minimum', () => {
	// Two nearly coplanar, nearly similar ellipses have a long diagonal distance valley. The default
	// 2 deg grid minimum is at periapsis (~0.0105 AU); the continuous MOID is ~0.000171 AU near ν ≈ 5.03.
	// With an Euclidean (hypot) step cap of one cell and only 40 Gauss-Newton iterations, refinement
	// stalled ~56 deg short and reported ~0.00209 AU. samples = 90 and 360 already reached the bottom.
	const first = KeplerOrbit.meanAnomaly(1.2 * (1 - 0.4 * 0.4), 0.4, 0.001, 0, 0, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	const second = KeplerOrbit.meanAnomaly(1.21 * (1 - 0.41 * 0.41), 0.41, 0.0012, 0.002, 0.01, 0, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	const result = moid(first, second)
	expect(result.distance).toBeCloseTo(0.000170938, 8)
	expect(moid(first, second, { samples: 90 }).distance).toBeCloseTo(result.distance, 8)
	expect(moid(first, second, { samples: 360 }).distance).toBeCloseTo(result.distance, 8)
})

test('the MOID of an orbit with itself is zero', () => {
	// Identical orbits share every point, so their MOID vanishes.
	expect(moid(CERES, CERES).distance).toBeCloseTo(0, 8)
})

test('MOID requires bound orbits', () => {
	// A hyperbolic relative velocity gives eccentricity > 1, which has no closed curve to intersect.
	const hyperbolic = new KeplerOrbit([1, 0, 0], [0, 0.05, 0], EPOCH, GM_SUN_PITJEVA_2005, IDENTITY)
	expect(hyperbolic.eccentricity).toBeGreaterThan(1)
	expect(() => moid(hyperbolic, EARTH)).toThrow()
})
