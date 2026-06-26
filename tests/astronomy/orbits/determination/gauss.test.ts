import { expect, test } from 'bun:test'
import type { EquatorialCoordinate } from '../../../../src/astronomy/coordinates/coordinate'
import { KeplerOrbit } from '../../../../src/astronomy/orbits/asteroid'
import { gauss, type GaussObservation } from '../../../../src/astronomy/orbits/determination/gauss'
import { type Time, Timescale, timeShift, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { DAYSPERJY, GM_SUN_PITJEVA_2005, TAU } from '../../../../src/core/constants'
import { matIdentity } from '../../../../src/math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecDistance, vecLength } from '../../../../src/math/linear-algebra/vec3'
import { normalizeAngle } from '../../../../src/math/units/angle'

const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
const MU = GM_SUN_PITJEVA_2005
const IDENTITY_ROTATION = matIdentity()
const ORBIT = KeplerOrbit.trueAnomaly(1.9, 0.18, 0.12, 0.8, 1.1, 0.35, EPOCH, MU, IDENTITY_ROTATION)

function observerPositionAt(offsetDays: number): MutVec3 {
	const angle = (TAU * offsetDays) / DAYSPERJY + 0.4
	return [Math.cos(angle), Math.sin(angle), 0.04 * Math.sin(2 * angle)]
}

function modelRaDec(position: Vec3, observer: Vec3): EquatorialCoordinate {
	const x = position[0] - observer[0]
	const y = position[1] - observer[1]
	const z = position[2] - observer[2]
	const range = Math.hypot(x, y, z)
	return { rightAscension: normalizeAngle(Math.atan2(y, x)), declination: Math.asin(z / range) }
}

function observationAt(offsetDays: number): GaussObservation {
	const time = timeShift(EPOCH, offsetDays)
	const observer = observerPositionAt(offsetDays)
	const model = modelRaDec(ORBIT.at(time)[0], observer)
	return { time, rightAscension: model.rightAscension, declination: model.declination, observer }
}

function observations(spacingDays: number = 4): readonly [GaussObservation, GaussObservation, GaussObservation] {
	return [observationAt(-spacingDays), observationAt(0), observationAt(spacingDays)]
}

function circularObservations(inclination: number, anomaly: number, observerPhase: number = 0, observerZ: number = 0) {
	const orbit = KeplerOrbit.trueAnomaly(1.1, 0, inclination, 0.2, 0.5, anomaly, EPOCH, MU, IDENTITY_ROTATION)
	const observer = (offsetDays: number): MutVec3 => {
		const angle = (TAU * offsetDays) / DAYSPERJY + observerPhase
		return [Math.cos(angle), Math.sin(angle), observerZ * Math.sin(2 * angle)]
	}
	const observation = (offsetDays: number): GaussObservation => {
		const time = timeShift(EPOCH, offsetDays)
		const site = observer(offsetDays)
		const model = modelRaDec(orbit.at(time)[0], site)
		return { time, rightAscension: model.rightAscension, declination: model.declination, observer: site }
	}

	return {
		orbit,
		observations: [observation(-1), observation(0), observation(1)] as const,
	}
}

function expectFiniteState(result: ReturnType<typeof gauss>) {
	expect(result.state.r.every(Number.isFinite)).toBeTrue()
	expect(result.state.v.every(Number.isFinite)).toBeTrue()
	expect(result.positions.r1.every(Number.isFinite)).toBeTrue()
	expect(result.positions.r2.every(Number.isFinite)).toBeTrue()
	expect(result.positions.r3.every(Number.isFinite)).toBeTrue()
}

test('returns a plausible initial state for a synthetic two-body orbit', () => {
	const [obs1, obs2, obs3] = observations(4)
	const result = gauss(obs1, obs2, obs3, { mu: MU })
	const [truePosition, trueVelocity] = ORBIT.at(EPOCH)

	expectFiniteState(result)
	expect(vecDistance(result.state.r, truePosition)).toBeLessThan(3e-4)
	expect(vecDistance(result.state.v, trueVelocity)).toBeLessThan(1e-5)
	expect(result.ranges.rho1).toBeGreaterThan(0)
	expect(result.ranges.rho2).toBeGreaterThan(0)
	expect(result.ranges.rho3).toBeGreaterThan(0)
	expect(result.diagnostics.candidateRoots.length).toBeGreaterThan(1)
	expect(Math.abs(result.diagnostics.selectedRoot - vecLength(truePosition))).toBeLessThan(3e-4)
})

test('does not select the far branch for multiple-root circular arcs', () => {
	const cases = [circularObservations(0.1, 0.2), circularObservations(0.7, 0.8, 0.4, 0.04)]

	for (const entry of cases) {
		const [obs1, obs2, obs3] = entry.observations
		const result = gauss(obs1, obs2, obs3, { mu: MU })
		const [truePosition] = entry.orbit.at(EPOCH)

		expect(result.diagnostics.candidateRoots.length).toBeGreaterThan(1)
		expect(Math.abs(result.diagnostics.selectedRoot - vecLength(truePosition))).toBeLessThan(2e-4)
		expect(vecDistance(result.state.r, truePosition)).toBeLessThan(2e-4)
	}
})

test('rejects degenerate line-of-sight geometry', () => {
	const [obs1, obs2, obs3] = observations()
	const sameLineOfSight = { rightAscension: obs1.rightAscension, declination: obs1.declination }

	expect(() => gauss({ ...obs1, ...sameLineOfSight }, { ...obs2, ...sameLineOfSight }, { ...obs3, ...sameLineOfSight }, { mu: MU })).toThrow('line-of-sight geometry is degenerate')
})

test('rejects invalid time order', () => {
	const [obs1, obs2, obs3] = observations()

	expect(() => gauss(obs2, obs1, obs3, { mu: MU })).toThrow('strictly increasing observation times')
	expect(() => gauss(obs1, obs3, obs2, { mu: MU })).toThrow('strictly increasing observation times')
	expect(() => gauss(obs1, { ...obs2, time: obs1.time }, obs3, { mu: MU })).toThrow('strictly increasing observation times')
})

test('rejects invalid numeric input', () => {
	const [obs1, obs2, obs3] = observations()
	const invalidTime: Time = { ...obs1.time, day: Number.NaN }

	expect(() => gauss({ ...obs1, rightAscension: Number.NaN }, obs2, obs3, { mu: MU })).toThrow('value must be finite')
	expect(() => gauss({ ...obs1, declination: Number.POSITIVE_INFINITY }, obs2, obs3, { mu: MU })).toThrow('value must be finite')
	expect(() => gauss({ ...obs1, declination: Math.PI }, obs2, obs3, { mu: MU })).toThrow('value must be within')
	expect(() => gauss({ ...obs1, observer: [Number.NaN, 0, 0] }, obs2, obs3, { mu: MU })).toThrow('value must be finite')
	expect(() => gauss({ ...obs1, time: invalidTime }, obs2, obs3, { mu: MU })).toThrow('value must be finite')
	expect(() => gauss(obs1, obs2, obs3, { mu: 0 })).toThrow('value must be positive')
	expect(() => gauss(obs1, obs2, obs3, { mu: Number.POSITIVE_INFINITY })).toThrow('value must be finite')
})

test('rejects candidates below the configured positive range floor', () => {
	const [obs1, obs2, obs3] = observations()

	expect(() => gauss(obs1, obs2, obs3, { mu: MU, minPositiveRho: 10 })).toThrow('rejected all positive range candidates')
})

test('uses requested velocity method and favors Herrick-Gibbs automatically for short arcs', () => {
	const [obs1, obs2, obs3] = observations(1)
	const gibbsResult = gauss(obs1, obs2, obs3, { mu: MU, method: 'gibbs' })
	const herrickResult = gauss(obs1, obs2, obs3, { mu: MU, method: 'herrick-gibbs' })
	const automaticResult = gauss(obs1, obs2, obs3, { mu: MU })

	expectFiniteState(gibbsResult)
	expectFiniteState(herrickResult)
	expect(gibbsResult.diagnostics.methodForVelocity).toBe('gibbs')
	expect(herrickResult.diagnostics.methodForVelocity).toBe('herrick-gibbs')
	expect(automaticResult.diagnostics.methodForVelocity).toBe('herrick-gibbs')
})
