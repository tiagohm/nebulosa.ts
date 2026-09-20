import { expect, test } from 'bun:test'
import { frameSphericalPositionAndVelocity, type PositionAndVelocity, sphericalPositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { frameAt, frameToBase, GALACTIC, galactic, ICRS, ITRS, ITRS_INSTANTANEOUS } from '../../../src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ANGVEL_PER_DAY, PI, PIOVERTWO } from '../../../src/core/constants'
import type { Vec3 } from '../../../src/math/linear-algebra/vec3'
import { normalizeAngle, normalizePI } from '../../../src/math/units/angle'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC)

test('circular cartesian motion has longitude rate omega', () => {
	const omega = 0.37
	const s = sphericalPositionAndVelocity([
		[1, 0, 0],
		[0, omega, 0],
	])!

	expect(s.longitude).toBeCloseTo(0, 15)
	expect(s.latitude).toBeCloseTo(0, 15)
	expect(s.distance).toBeCloseTo(1, 15)
	expect(s.longitudeRate).toBeCloseTo(omega, 15)
	expect(s.latitudeRate).toBeCloseTo(0, 15)
	expect(s.radialVelocity).toBeCloseTo(0, 15)
})

test('pure radial motion has zero angular rates', () => {
	const s = sphericalPositionAndVelocity([
		[1, 0, 0],
		[0.01, 0, 0],
	])!

	expect(s.longitude).toBeCloseTo(0, 15)
	expect(s.latitude).toBeCloseTo(0, 15)
	expect(s.distance).toBeCloseTo(1, 15)
	expect(s.longitudeRate).toBeCloseTo(0, 15)
	expect(s.latitudeRate).toBeCloseTo(0, 15)
	expect(s.radialVelocity).toBeCloseTo(0.01, 15)
})

test('static vector has zero rates', () => {
	const s = sphericalPositionAndVelocity([
		[0.6, -0.8, 0],
		[0, 0, 0],
	])!

	expect(s.longitude).toBeCloseTo(normalizeAngle(Math.atan2(-0.8, 0.6)), 15)
	expect(s.latitude).toBeCloseTo(0, 15)
	expect(s.distance).toBeCloseTo(1, 15)
	expect(s.longitudeRate).toBeCloseTo(0, 15)
	expect(s.latitudeRate).toBeCloseTo(0, 15)
	expect(s.radialVelocity).toBeCloseTo(0, 15)
})

test('pure latitude motion has latitude rate omega', () => {
	const omega = -0.22
	const s = sphericalPositionAndVelocity([
		[1, 0, 0],
		[0, 0, omega],
	])!

	expect(s.longitudeRate).toBeCloseTo(0, 15)
	expect(s.latitudeRate).toBeCloseTo(omega, 15)
	expect(s.radialVelocity).toBeCloseTo(0, 15)
})

test('mixed 3D motion matches the analytic formulas', () => {
	const x = 3
	const y = 4
	const z = 12
	const vx = 0.1
	const vy = -0.2
	const vz = 0.3
	const s = sphericalPositionAndVelocity([
		[x, y, z],
		[vx, vy, vz],
	])!

	const rho2 = x * x + y * y
	const rho = Math.sqrt(rho2)
	const r2 = rho2 + z * z
	const R = Math.sqrt(r2)
	const xyDotV = x * vx + y * vy

	expect(s.longitude).toBeCloseTo(Math.atan2(y, x), 15)
	expect(s.latitude).toBeCloseTo(Math.atan2(z, rho), 15)
	expect(s.distance).toBeCloseTo(R, 15)
	expect(s.longitudeRate).toBeCloseTo((x * vy - y * vx) / rho2, 15)
	expect(s.latitudeRate).toBeCloseTo((rho2 * vz - z * xyDotV) / (r2 * rho), 15)
	expect(s.radialVelocity).toBeCloseTo((xyDotV + z * vz) / R, 15)
})

test('longitude is normalized to 0..TAU in every cartesian quadrant', () => {
	expect(
		sphericalPositionAndVelocity([
			[1, 1, 0],
			[0, 0, 0],
		])!.longitude,
	).toBeCloseTo(PI / 4, 15)
	expect(
		sphericalPositionAndVelocity([
			[-1, 1, 0],
			[0, 0, 0],
		])!.longitude,
	).toBeCloseTo((3 * PI) / 4, 15)
	expect(
		sphericalPositionAndVelocity([
			[-1, -1, 0],
			[0, 0, 0],
		])!.longitude,
	).toBeCloseTo((5 * PI) / 4, 15)
	expect(
		sphericalPositionAndVelocity([
			[1, -1, 0],
			[0, 0, 0],
		])!.longitude,
	).toBeCloseTo((7 * PI) / 4, 15)
})

function finiteDifferenceRates(pv: readonly [Vec3, Vec3], dt = 1e-6) {
	const [p, v] = pv
	const plus = sphericalPositionAndVelocity([[p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt], v])!
	const minus = sphericalPositionAndVelocity([[p[0] - v[0] * dt, p[1] - v[1] * dt, p[2] - v[2] * dt], v])!
	return {
		longitudeRate: normalizePI(plus.longitude - minus.longitude) / (2 * dt),
		latitudeRate: (plus.latitude - minus.latitude) / (2 * dt),
		radialVelocity: (plus.distance - minus.distance) / (2 * dt),
	}
}

test('analytic rates agree with centered finite differences', () => {
	const states: ReadonlyArray<readonly [Vec3, Vec3]> = [
		[
			[1, 0, 0],
			[0, 0.37, 0],
		],
		[
			[1, 0, 0],
			[0.01, 0, 0],
		],
		[
			[3, 4, 12],
			[0.1, -0.2, 0.3],
		],
		[
			[-0.8, -0.4, 0.3],
			[0.012, -0.007, 0.004],
		],
		[
			[0.5, -1.2, 0.7],
			[-0.03, 0.02, 0.01],
		],
	]

	for (const pv of states) {
		const analytic = sphericalPositionAndVelocity(pv)!
		const numerical = finiteDifferenceRates(pv)
		expect(analytic.longitudeRate).toBeCloseTo(numerical.longitudeRate, 8)
		expect(analytic.latitudeRate).toBeCloseTo(numerical.latitudeRate, 8)
		expect(analytic.radialVelocity).toBeCloseTo(numerical.radialVelocity, 8)
	}
})

test('zero position vector has no sky direction', () => {
	expect(
		sphericalPositionAndVelocity([
			[0, 0, 0],
			[1, 0, 0],
		]),
	).toBeUndefined()
	expect(
		frameSphericalPositionAndVelocity(
			[
				[0, 0, 0],
				[0, 1, 0],
			],
			ICRS,
			TIME,
		),
	).toBeUndefined()
})

test('exact north pole keeps scalar geometry and omits angular rates', () => {
	const s = sphericalPositionAndVelocity([
		[0, 0, 2],
		[0.1, -0.2, 0.3],
	])!

	expect(s.longitude).toBeCloseTo(0, 15)
	expect(s.latitude).toBeCloseTo(PIOVERTWO, 15)
	expect(s.distance).toBeCloseTo(2, 15)
	expect(s.radialVelocity).toBeCloseTo(0.3, 15)
	expect(s.longitudeRate).toBeUndefined()
	expect(s.latitudeRate).toBeUndefined()
})

test('exact south pole keeps scalar geometry and omits angular rates', () => {
	const s = sphericalPositionAndVelocity([
		[0, 0, -4],
		[0.05, 0.1, -0.8],
	])!

	expect(s.longitude).toBeCloseTo(0, 15)
	expect(s.latitude).toBeCloseTo(-PIOVERTWO, 15)
	expect(s.distance).toBeCloseTo(4, 15)
	expect(s.radialVelocity).toBeCloseTo(0.8, 15)
	expect(s.longitudeRate).toBeUndefined()
	expect(s.latitudeRate).toBeUndefined()
})

test('near-pole longitude rate is the true large analytic value', () => {
	const x = 1e-12
	const pv: PositionAndVelocity = [
		[x, 0, 1],
		[0, 1, 0],
	]
	const s = sphericalPositionAndVelocity(pv)!
	const expected = 1 / x

	expect(s.longitudeRate).toBeCloseTo(expected, 12)
	expect(Math.abs(s.longitudeRate!)).toBeGreaterThan(1e8)
	expect(s.latitudeRate).toBeDefined()
	expect(Number.isFinite(s.latitudeRate!)).toBe(true)
})

test('velocity through the pole is singular only at the exact pole', () => {
	const v: Vec3 = [0, 1, 0]
	const atPole = sphericalPositionAndVelocity([[0, 0, 1], v])!
	expect(atPole.longitudeRate).toBeUndefined()
	expect(atPole.latitudeRate).toBeUndefined()
	expect(atPole.radialVelocity).toBeCloseTo(0, 15)

	const before = sphericalPositionAndVelocity([[-1e-9, 0, 1], v])!
	const after = sphericalPositionAndVelocity([[1e-9, 0, 1], v])!
	expect(before.longitudeRate).toBeDefined()
	expect(after.longitudeRate).toBeDefined()
	expect(Number.isFinite(before.longitudeRate!)).toBe(true)
	expect(Number.isFinite(after.longitudeRate!)).toBe(true)
	expect(Math.abs(before.longitudeRate!)).toBeGreaterThan(1e6)
	expect(Math.abs(after.longitudeRate!)).toBeGreaterThan(1e6)
	expect(Math.sign(before.longitudeRate!)).not.toBe(Math.sign(after.longitudeRate!))
})

test('ICRS frame helper matches the cartesian conversion', () => {
	const pv: PositionAndVelocity = [
		[0.8, -0.4, 0.3],
		[0.012, -0.007, 0.004],
	]
	const direct = sphericalPositionAndVelocity(pv)!
	const viaFrame = frameSphericalPositionAndVelocity(pv, ICRS, TIME)!

	expect(viaFrame.longitude).toBeCloseTo(direct.longitude, 15)
	expect(viaFrame.latitude).toBeCloseTo(direct.latitude, 15)
	expect(viaFrame.distance).toBeCloseTo(direct.distance, 15)
	expect(viaFrame.longitudeRate).toBeCloseTo(direct.longitudeRate!, 15)
	expect(viaFrame.latitudeRate).toBeCloseTo(direct.latitudeRate!, 15)
	expect(viaFrame.radialVelocity).toBeCloseTo(direct.radialVelocity, 15)
})

test('galactic frame helper matches a manually rotated state', () => {
	const pv: PositionAndVelocity = [
		[0.8, -0.4, 0.3],
		[0.012, -0.007, 0.004],
	]
	const rotated = galactic(pv)
	const expected = sphericalPositionAndVelocity(rotated)!
	const actual = frameSphericalPositionAndVelocity(pv, GALACTIC, TIME)!
	const viaFrameAt = sphericalPositionAndVelocity(frameAt(pv, GALACTIC, TIME))!

	expect(actual.longitude).toBeCloseTo(expected.longitude, 15)
	expect(actual.latitude).toBeCloseTo(expected.latitude, 15)
	expect(actual.distance).toBeCloseTo(expected.distance, 15)
	expect(actual.longitudeRate).toBeCloseTo(expected.longitudeRate!, 15)
	expect(actual.latitudeRate).toBeCloseTo(expected.latitudeRate!, 15)
	expect(actual.radialVelocity).toBeCloseTo(expected.radialVelocity, 15)
	expect(viaFrameAt.longitude).toBe(actual.longitude)
	expect(viaFrameAt.latitudeRate).toBe(actual.latitudeRate)
})

test('crust-fixed ITRS state has near-zero Earth-fixed angular rates', () => {
	const itrsRest: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[0, 0, 0],
	]
	const icrs = frameToBase(itrsRest, ITRS, TIME)
	const itrsSph = frameSphericalPositionAndVelocity(icrs, ITRS, TIME)!
	const icrsSph = frameSphericalPositionAndVelocity(icrs, ICRS, TIME)!
	const instantaneous = frameSphericalPositionAndVelocity(frameToBase(itrsRest, ITRS_INSTANTANEOUS, TIME), ITRS_INSTANTANEOUS, TIME)!

	expect(itrsSph.longitudeRate).toBeCloseTo(0, 12)
	expect(itrsSph.latitudeRate).toBeCloseTo(0, 12)
	expect(itrsSph.radialVelocity).toBeCloseTo(0, 12)
	expect(instantaneous.longitudeRate).toBeCloseTo(0, 12)
	expect(instantaneous.latitudeRate).toBeCloseTo(0, 12)

	// Inertial rates of the same crust-fixed state differ by Earth-rotation scale.
	expect(Math.abs(icrsSph.longitudeRate!)).toBeGreaterThan(0.5 * ANGVEL_PER_DAY)
	expect(Math.abs(icrsSph.longitudeRate! - itrsSph.longitudeRate!)).toBeGreaterThan(0.5 * ANGVEL_PER_DAY)
})

test('equatorial crust-fixed ICRS longitude rate is the Earth rotation rate', () => {
	const itrsRest: PositionAndVelocity = [
		[1, 0, 0],
		[0, 0, 0],
	]
	const icrs = frameToBase(itrsRest, ITRS, TIME)
	const icrsSph = frameSphericalPositionAndVelocity(icrs, ICRS, TIME)!
	const itrsSph = frameSphericalPositionAndVelocity(icrs, ITRS, TIME)!

	expect(itrsSph.longitudeRate).toBeCloseTo(0, 12)
	expect(icrsSph.longitudeRate).toBeCloseTo(ANGVEL_PER_DAY, 4)
})

test('frame helper reuses a transformed-state workspace', () => {
	const pv: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const out: PositionAndVelocity = [
		[0, 0, 0],
		[0, 0, 0],
	]
	const sph = frameSphericalPositionAndVelocity(pv, ITRS, TIME, out)!
	const transformed = frameAt(pv, ITRS, TIME)
	const fromWorkspace = sphericalPositionAndVelocity(out)!

	for (let i = 0; i < 3; i++) {
		expect(out[0][i]).toBeCloseTo(transformed[0][i], 15)
		expect(out[1][i]).toBeCloseTo(transformed[1][i], 15)
	}
	expect(fromWorkspace.longitude).toBeCloseTo(sph.longitude, 15)
	expect(fromWorkspace.longitudeRate).toBeCloseTo(sph.longitudeRate!, 15)
	expect(fromWorkspace.radialVelocity).toBeCloseTo(sph.radialVelocity, 15)
})

// Skyfield 1.55 ICRF([0.8, -0.4, 0.3], [0.012, -0.007, 0.004]).frame_latlon_and_rates(ICRS).
// Units: radians, AU, radians/day, AU/day.
test('ICRS spherical state matches Skyfield frame_latlon_and_rates', () => {
	const s = sphericalPositionAndVelocity([
		[0.8, -0.4, 0.3],
		[0.012, -0.007, 0.004],
	])!

	expect(s.latitude).toBeCloseTo(0.3236185653039863, 15)
	expect(s.longitude).toBeCloseTo(5.81953769817878, 15)
	expect(s.distance).toBeCloseTo(0.9433981132056605, 15)
	expect(s.latitudeRate).toBeCloseTo(-0.000653233341741511, 15)
	expect(s.longitudeRate).toBeCloseTo(-0.001, 15)
	expect(s.radialVelocity).toBeCloseTo(0.014415971168086496, 15)
})
