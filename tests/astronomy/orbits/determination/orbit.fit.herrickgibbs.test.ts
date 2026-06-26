import { expect, test } from 'bun:test'
import { herrickGibbs, type HerrickGibbsWarning } from '../../../../src/astronomy/orbits/determination/orbit.fit.herrickgibbs'
import { type Time, Timescale, timeShift, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from '../../../../src/core/constants'
import { type MutVec3, type Vec3, vecDistance } from '../../../../src/math/linear-algebra/vec3'

const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
const MU = GM_SUN_PITJEVA_2005

function circularPosition(offsetDays: number, radius: number = 1): MutVec3 {
	const n = Math.sqrt(MU / radius ** 3)
	const angle = n * offsetDays
	return [radius * Math.cos(angle), radius * Math.sin(angle), 0]
}

function sampleTimes(spacingDays: number): readonly [Time, Time, Time] {
	return [timeShift(EPOCH, -spacingDays), EPOCH, timeShift(EPOCH, spacingDays)]
}

function sampleCircular(spacingDays: number = 0.05, radius: number = 1) {
	const [t1, t2, t3] = sampleTimes(spacingDays)
	return { r1: circularPosition(-spacingDays, radius), r2: circularPosition(0, radius), r3: circularPosition(spacingDays, radius), t1, t2, t3 }
}

function expectWarnings(warnings: readonly HerrickGibbsWarning[], ...expected: HerrickGibbsWarning[]) {
	for (const warning of expected) expect(warnings).toContain(warning)
}

test('returns a finite state for a valid smooth short arc', () => {
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular()
	const result = herrickGibbs(r1, r2, r3, t1, t2, t3, MU)

	expect(result.r).toEqual(r2)
	expect(result.v.every(Number.isFinite)).toBeTrue()
	expect(result.diagnostics.reliable).toBeTrue()
	expect(result.diagnostics.warnings).toHaveLength(0)
})

test('keeps AU/day unit consistency with a circular heliocentric sample', () => {
	const radius = 1.7
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular(0.04, radius)
	const result = herrickGibbs(r1, r2, r3, t1, t2, t3, MU)
	const expectedSpeedAuPerDay = Math.sqrt(MU / radius)

	expect(result.v[0]).toBeCloseTo(0, 13)
	expect(result.v[1]).toBeCloseTo(expectedSpeedAuPerDay, 9)
	expect(result.v[2]).toBeCloseTo(0, 13)
})

test('reports non-increasing time order and can throw on invalid input', () => {
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular()
	const cases = [
		[t2, t1, t3],
		[t1, t3, t2],
		[t1, t1, t3],
	] as const

	for (const [a, b, c] of cases) {
		const result = herrickGibbs(r1, r2, r3, a, b, c, MU)
		expect(result.diagnostics.reliable).toBeFalse()
		expectWarnings(result.diagnostics.warnings, 'NON_INCREASING_TIME')
		expect(result.v.every(Number.isNaN)).toBeTrue()
	}

	expect(() => herrickGibbs(r1, r2, r3, t2, t1, t3, MU, { throwOnInvalid: true })).toThrow('NON_INCREASING_TIME')
})

test('reports invalid position norms for zero, NaN, and infinite vectors', () => {
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular()
	const cases = [
		[[0, 0, 0], r2, r3],
		[[Number.NaN, 0, 0], r2, r3],
		[r1, [Number.POSITIVE_INFINITY, 0, 0], r3],
	] as const

	for (const [a, b, c] of cases) {
		const result = herrickGibbs(a, b, c, t1, t2, t3, MU)
		expect(result.diagnostics.reliable).toBeFalse()
		expectWarnings(result.diagnostics.warnings, 'INVALID_POSITION_NORM')
		expect(result.v.every(Number.isNaN)).toBeTrue()
	}
})

test('reports invalid gravitational parameters', () => {
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular()

	for (const mu of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const result = herrickGibbs(r1, r2, r3, t1, t2, t3, mu)
		expect(result.diagnostics.reliable).toBeFalse()
		expectWarnings(result.diagnostics.warnings, 'INVALID_GRAVITATIONAL_PARAMETER')
		expect(result.v.every(Number.isNaN)).toBeTrue()
	}
})

test('reports near-colinear radial geometry', () => {
	const [t1, t2, t3] = sampleTimes(0.05)
	const result = herrickGibbs([1, 0, 0], [1.00001, 0, 0], [1.00002, 0, 0], t1, t2, t3, MU)

	expect(result.diagnostics.reliable).toBeFalse()
	expectWarnings(result.diagnostics.warnings, 'NEAR_COLINEAR_POSITIONS', 'LOW_RELIABILITY_GEOMETRY')
})

test('reports poor coplanarity', () => {
	const [t1, t2, t3] = sampleTimes(0.05)
	const result = herrickGibbs([1, 0, 0], [Math.cos(0.01), Math.sin(0.01), 0], [Math.cos(0.02), Math.sin(0.02), 0.01], t1, t2, t3, MU)

	expect(result.diagnostics.reliable).toBeFalse()
	expect(result.diagnostics.coplanarityError).toBeGreaterThan(1e-3)
	expectWarnings(result.diagnostics.warnings, 'POOR_COPLANARITY', 'LOW_RELIABILITY_GEOMETRY')
})

test('reports angular separations outside configured limits', () => {
	const [t1, t2, t3] = sampleTimes(0.05)
	const tooSmall = herrickGibbs([1, 0, 0], [1, 1e-10, 0], [1, 2e-10, 0], t1, t2, t3, MU)
	const tooLarge = herrickGibbs([1, 0, 0], [Math.cos(0.2), Math.sin(0.2), 0], [Math.cos(0.4), Math.sin(0.4), 0], t1, t2, t3, MU)

	expect(tooSmall.diagnostics.reliable).toBeFalse()
	expectWarnings(tooSmall.diagnostics.warnings, 'ANGULAR_SEPARATION_TOO_SMALL')
	expect(tooLarge.diagnostics.reliable).toBeFalse()
	expectWarnings(tooLarge.diagnostics.warnings, 'ANGULAR_SEPARATION_TOO_LARGE')
})

test('reports long time intervals outside Herrick-Gibbs suitability', () => {
	const { r1, r2, r3 } = sampleCircular(10)
	const [t1, t2, t3] = sampleTimes(10)
	const result = herrickGibbs(r1, r2, r3, t1, t2, t3, MU)

	expect(result.diagnostics.reliable).toBeFalse()
	expectWarnings(result.diagnostics.warnings, 'TIME_INTERVAL_TOO_LARGE')
})

test('matches the analytic velocity for a symmetric short circular arc', () => {
	const spacingDays = 0.02
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular(spacingDays)
	const result = herrickGibbs(r1, r2, r3, t1, t2, t3, MU)
	const expected: Vec3 = [0, Math.sqrt(MU), 0]

	expect(vecDistance(result.v, expected)).toBeLessThan(1e-11)
})

test('does not mutate input vectors', () => {
	const { r1, r2, r3, t1, t2, t3 } = sampleCircular()
	const r1Before: MutVec3 = [...r1]
	const r2Before: MutVec3 = [...r2]
	const r3Before: MutVec3 = [...r3]

	herrickGibbs(r1, r2, r3, t1, t2, t3, MU)

	expect(r1).toEqual(r1Before)
	expect(r2).toEqual(r2Before)
	expect(r3).toEqual(r3Before)
})
