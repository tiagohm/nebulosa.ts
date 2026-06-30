import { expect, test } from 'bun:test'
import { KeplerOrbit } from '../../../../src/astronomy/orbits/asteroid'
import { gibbs, type GibbsWarning } from '../../../../src/astronomy/orbits/determination/gibbs'
import { Timescale, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { AU_KM, DEG2RAD, GM_SUN_PITJEVA_2005, GM_SUN_PITJEVA_2005_KM3_S2 } from '../../../../src/core/constants'
import { matIdentity } from '../../../../src/math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecDistance } from '../../../../src/math/linear-algebra/vec3'

const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
const IDENTITY_ROTATION = matIdentity()

function circularPosition(angle: number, radius: number = 1): MutVec3 {
	return [radius * Math.cos(angle), radius * Math.sin(angle), 0]
}

function expectWarnings(warnings: readonly GibbsWarning[], ...expected: GibbsWarning[]) {
	for (const warning of expected) expect(warnings).toContain(warning)
}

test('recovers the middle velocity for a circular orbit', () => {
	const radius = 2
	const mu = 8
	const spacing = 5 * DEG2RAD
	const r1 = circularPosition(-spacing, radius)
	const r2 = circularPosition(0, radius)
	const r3 = circularPosition(spacing, radius)
	const result = gibbs(r1, r2, r3, mu)
	const expected: Vec3 = [0, Math.sqrt(mu / radius), 0]

	expect(result.r).toEqual(r2)
	expect(vecDistance(result.v, expected)).toBeLessThan(1e-14)
	expect(result.diagnostics.reliability).toBe('good')
	expect(result.diagnostics.warnings).toHaveLength(0)
	// A perfectly coplanar circular arc must report a negligible coplanarity error.
	expect(result.diagnostics.coplanarityError).toBeLessThan(1e-12)
})

test('returns a defensive copy of the middle position', () => {
	const r2 = circularPosition(0)
	const result = gibbs(circularPosition(-5 * DEG2RAD), r2, circularPosition(5 * DEG2RAD), 1)

	;(result.r as MutVec3)[0] = 99

	expect(r2[0]).toBe(1)
	expect(result.r).not.toBe(r2)
})

test('recovers the middle velocity for an elliptical orbit sample', () => {
	const spacing = 6 * DEG2RAD
	const middleAnomaly = 0.45
	const orbit1 = KeplerOrbit.trueAnomaly(1.8, 0.24, 0.18, 0.4, 0.7, middleAnomaly - spacing, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY_ROTATION)
	const orbit2 = KeplerOrbit.trueAnomaly(1.8, 0.24, 0.18, 0.4, 0.7, middleAnomaly, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY_ROTATION)
	const orbit3 = KeplerOrbit.trueAnomaly(1.8, 0.24, 0.18, 0.4, 0.7, middleAnomaly + spacing, EPOCH, GM_SUN_PITJEVA_2005, IDENTITY_ROTATION)
	const result = gibbs(orbit1.position, orbit2.position, orbit3.position, GM_SUN_PITJEVA_2005)

	expect(vecDistance(result.v, orbit2.velocity)).toBeLessThan(1e-13)
	expect(result.diagnostics.reliability).toBe('good')
})

test('keeps km and second units consistent when mu uses km cubed per second squared', () => {
	const spacing = 5 * DEG2RAD
	const r1 = circularPosition(-spacing, AU_KM)
	const r2 = circularPosition(0, AU_KM)
	const r3 = circularPosition(spacing, AU_KM)
	const result = gibbs(r1, r2, r3, GM_SUN_PITJEVA_2005_KM3_S2)
	const expectedSpeedKmPerSecond = Math.sqrt(GM_SUN_PITJEVA_2005_KM3_S2 / AU_KM)

	expect(result.v[0]).toBeCloseTo(0, 12)
	expect(result.v[1]).toBeCloseTo(expectedSpeedKmPerSecond, 10)
	expect(result.v[2]).toBeCloseTo(0, 12)
	expect(result.diagnostics.reliability).toBe('good')
})

test('rejects non-coplanar vectors by default and can expose bad diagnostics', () => {
	const r1: Vec3 = [1, 0, 0]
	const r2 = circularPosition(5 * DEG2RAD)
	const r3: Vec3 = [Math.cos(10 * DEG2RAD), Math.sin(10 * DEG2RAD), 0.01]

	expect(() => gibbs(r1, r2, r3, 1)).toThrow('POOR_COPLANARITY')

	const result = gibbs(r1, r2, r3, 1, { allowUnreliable: true })

	expect(result.diagnostics.reliability).toBe('bad')
	expect(result.diagnostics.coplanarityError).toBeGreaterThan(1e-5)
	expectWarnings(result.diagnostics.warnings, 'POOR_COPLANARITY')
})

test('reports weak geometry for angular separations below the recommended range', () => {
	const spacing = 0.25 * DEG2RAD
	const result = gibbs(circularPosition(-spacing), circularPosition(0), circularPosition(spacing), 1)

	expect(result.v.every(Number.isFinite)).toBeTrue()
	expect(result.diagnostics.reliability).toBe('warning')
	expectWarnings(result.diagnostics.warnings, 'ANGULAR_SEPARATION_TOO_SMALL')
})

test('reports weak geometry for angular separations above the recommended range', () => {
	const spacing = 70 * DEG2RAD
	const result = gibbs(circularPosition(-spacing), circularPosition(0), circularPosition(spacing), 1)

	expect(result.v.every(Number.isFinite)).toBeTrue()
	expect(result.diagnostics.reliability).toBe('warning')
	expectWarnings(result.diagnostics.warnings, 'ANGULAR_SEPARATION_TOO_LARGE')
})

test('rejects collinear and degenerate vectors', () => {
	expect(() => gibbs([1, 0, 0], [2, 0, 0], [3, 0, 0], 1)).toThrow('NEAR_COLINEAR_POSITIONS')
	expect(() => gibbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 1)).toThrow('INVALID_POSITION_NORM')
})

test('rejects invalid numeric inputs', () => {
	expect(() => gibbs([Number.NaN, 0, 0], [1, 0, 0], [0, 1, 0], 1)).toThrow('INVALID_POSITION_NORM')
	expect(() => gibbs([1, 0, 0], [0, 1, 0], [-1, 0, 0], 0)).toThrow('INVALID_GRAVITATIONAL_PARAMETER')
	expect(() => gibbs([1, 0, 0], [Number.POSITIVE_INFINITY, 0, 0], [0, 1, 0], 1)).toThrow('INVALID_POSITION_NORM')
})

test('does not mutate input vectors', () => {
	const r1 = circularPosition(-5 * DEG2RAD)
	const r2 = circularPosition(0)
	const r3 = circularPosition(5 * DEG2RAD)
	const r1Before: MutVec3 = [...r1]
	const r2Before: MutVec3 = [...r2]
	const r3Before: MutVec3 = [...r3]

	gibbs(r1, r2, r3, 1)

	expect(r1).toEqual(r1Before)
	expect(r2).toEqual(r2Before)
	expect(r3).toEqual(r3Before)
})
