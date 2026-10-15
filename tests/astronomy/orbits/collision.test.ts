import { describe, expect, test } from 'bun:test'
import { parseCDM } from '../../../src/astronomy/orbits/cdm'
import { cdmCollisionProbability, cdmEncounterStates, type CollisionProbabilityEstimate, type CollisionProbabilityOptions, type CollisionProbabilityResult, collisionProbability, type EncounterObjectState, rotateStateCovariance, rtnRotation } from '../../../src/astronomy/orbits/collision'
import { AU_M, DAYSEC, EARTH_ANGULAR_VELOCITY_VECTOR } from '../../../src/core/constants'
import { type Mat3, matMul, matMulVec, matRotX, matRotY, matRotZ, matTranspose } from '../../../src/math/linear-algebra/mat3'
import { Matrix } from '../../../src/math/linear-algebra/matrix'
import { type Vec3, vecCross, vecDot, vecLength, vecMinus, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { meter, toMeter } from '../../../src/math/units/distance'

// Reference probabilities are 30-digit mpmath 1.3.0 quadratures of the 2D Gaussian density over the disk
// in polar coordinates (independent of the 1D reduction under test); the CDM-example references project
// the covariances with an independent NumPy 2.3.3 pipeline first. Isotropic cases use the exact Marcum-Q
// series 1 - Q1(d/σ, R/σ) = e^-(a²+b²)/2 Σ (b/a)^k I_k(ab) at 50 digits (the polar quadrature is not
// reliable at 1e-81); the grazing cases agree with a 40-digit 1D Rice/Cartesian quadrature, and SciPy
// 1.16.2 ncx2.cdf agrees with the offset isotropic case.

// Metres per second to AU per day.
const M_S = DAYSEC / AU_M

// CCSDS 508.0-B-1 section 3.6.2 example CDM (obligatory keywords only), transcribed from the Blue Book
// (June 2013 with Cor. 2, October 2021). The two state vectors reproduce MISS_DISTANCE = 715 m and the
// optional-example RELATIVE_SPEED = 14762 m/s, so the example is geometrically self-consistent.
const CDM_EXAMPLE = await Bun.file('data/cdm.kvn').text()

// Builds a primary/secondary pair whose relative velocity is `speed` (m/s) along +Z, so the encounter
// plane is the frame XY plane, with the combined position covariance [[sxx, sxy, 0], [sxy, syy, 0],
// [0, 0, szz]] (m²) carried by the primary, miss (mx, my) in metres, and a velocity covariance of
// `velocityVariance` (m²/s²) on each axis. The primary flies a 7000 km LEO state radial along +Z, so the
// in-plane miss and the relative velocity add to zero or exact components and keep full precision.
function encounter(mx: number, my: number, sxx: number, sxy: number, syy: number, szz: number = sxx, speed: number = 10000, velocityVariance: number = 1e-6): readonly [EncounterObjectState, EncounterObjectState] {
	const m2 = 1 / (AU_M * AU_M)
	const v2 = M_S * M_S
	const primaryCovariance = new Matrix(6, 6)
	primaryCovariance.set(0, 0, sxx * m2)
	primaryCovariance.set(0, 1, sxy * m2)
	primaryCovariance.set(1, 0, sxy * m2)
	primaryCovariance.set(1, 1, syy * m2)
	primaryCovariance.set(2, 2, szz * m2)
	for (let i = 3; i < 6; i++) primaryCovariance.set(i, i, velocityVariance * v2)

	const position: Vec3 = [0, 0, meter(7000e3)]
	const velocity: Vec3 = [7500 * M_S, 0, 0]
	const primary: EncounterObjectState = { position, velocity, covariance: primaryCovariance }
	const secondary: EncounterObjectState = { position: vecPlus(position, [meter(mx), meter(my), 0]), velocity: vecPlus(velocity, [0, 0, speed * M_S]), covariance: new Matrix(6, 6) }
	return [primary, secondary]
}

// Rotates both states (positions, velocities and covariances) by the same rotation.
function rotateEncounter(states: readonly [EncounterObjectState, EncounterObjectState], rotation: Mat3) {
	return states.map((state) => ({ position: matMulVec(rotation, state.position), velocity: matMulVec(rotation, state.velocity), covariance: rotateStateCovariance(state.covariance, rotation) })) as unknown as readonly [EncounterObjectState, EncounterObjectState]
}

// Narrows a result to an estimate.
function estimate(result: CollisionProbabilityResult): CollisionProbabilityEstimate {
	if (result.kind !== 'estimate') throw new Error(`expected an estimate, got ${result.reason}`)
	return result
}

// Quadrature probability of a synthetic encounter.
function pc(states: readonly [EncounterObjectState, EncounterObjectState], radius: number, options?: CollisionProbabilityOptions) {
	return estimate(collisionProbability(states[0], states[1], meter(radius), options))
}

// Asserts a relative error bound.
function expectRelative(value: number, reference: number, tolerance: number) {
	expect(Math.abs(value / reference - 1)).toBeLessThan(tolerance)
}

describe('rtnRotation', () => {
	test('orthonormal radial, transverse and normal axes', () => {
		const r: Vec3 = [7000, 1200, -300]
		const v: Vec3 = [-1.1, 7.2, 0.9]
		const m = rtnRotation(r, v)!
		const R: Vec3 = [m[0], m[1], m[2]]
		const T: Vec3 = [m[3], m[4], m[5]]
		const N: Vec3 = [m[6], m[7], m[8]]

		expect(vecLength(R)).toBeCloseTo(1, 15)
		expect(vecLength(T)).toBeCloseTo(1, 15)
		expect(vecDot(R, T)).toBeCloseTo(0, 15)
		expect(vecDot(vecCross(R, T), N)).toBeCloseTo(1, 15)
		expect(vecDot(R, r)).toBeCloseTo(vecLength(r), 10)
		// T points along the velocity and N along the angular momentum.
		expect(vecDot(T, v)).toBeGreaterThan(0)
		expect(vecDot(N, vecCross(r, v))).toBeCloseTo(vecLength(vecCross(r, v)), 10)
		expect(matMulVec(m, v)[2]).toBeCloseTo(0, 14)
	})

	test('undefined for degenerate states', () => {
		expect(rtnRotation([0, 0, 0], [1, 0, 0])).toBeUndefined()
		expect(rtnRotation([1, 2, 3], [2, 4, 6])).toBeUndefined()
		expect(rtnRotation([1, 2, 3], [0, 0, 0])).toBeUndefined()
	})
})

describe('rotateStateCovariance', () => {
	test('RTN round trip and invariants', () => {
		const cdm = parseCDM(CDM_EXAMPLE)
		const object = cdm.objects[1]
		const m = rtnRotation(object.position, object.velocity)!
		const frame = rotateStateCovariance(object.covariance, matTranspose(m))
		const back = rotateStateCovariance(frame, m)

		for (let i = 0; i < 36; i++) expect(back.data[i] / object.covariance.data[i]).toBeCloseTo(1, 10)
		// A rotation preserves the position and velocity traces and keeps the matrix symmetric.
		expect(frame.get(0, 0) + frame.get(1, 1) + frame.get(2, 2)).toBeCloseTo(object.covariance.get(0, 0) + object.covariance.get(1, 1) + object.covariance.get(2, 2), 30)
		expect((frame.get(3, 3) + frame.get(4, 4) + frame.get(5, 5)) / (object.covariance.get(3, 3) + object.covariance.get(4, 4) + object.covariance.get(5, 5))).toBeCloseTo(1, 14)
		for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) expect(frame.get(i, j)).toBe(frame.get(j, i))
	})

	test('9x9 input keeps only the position/velocity block', () => {
		const covariance = Matrix.identity(9)
		const rotated = rotateStateCovariance(covariance, matRotZ(0.3))
		expect(rotated.rows).toBe(6)
		expect(rotated.get(4, 4)).toBeCloseTo(1, 15)
	})
})

describe('cdmEncounterStates', () => {
	test('published example relative RTN values are reproduced with Earth-fixed (ITRF) states', () => {
		// The section 3.6.3 RELATIVE_POSITION/VELOCITY values are matched to every printed digit only when the
		// RTN normal is built from v + ω×r, i.e. treating the example states as ITRF (Object1 RTN, annex E).
		const cdm = parseCDM(CDM_EXAMPLE.replaceAll('REF_FRAME = EME2000', 'REF_FRAME = ITRF'))
		const [a, b] = cdm.objects
		const [primary] = cdmEncounterStates(cdm)
		const transport = vecCross(EARTH_ANGULAR_VELOCITY_VECTOR, a.position)
		for (const [i, x] of vecMinus(primary.velocity, a.velocity).entries()) expect(x).toBeCloseTo(transport[i], 17)

		const m = rtnRotation(primary.position, primary.velocity)!
		const position = matMulVec(m, vecMinus(b.position, a.position)).map((x) => x * AU_M)
		const velocity = matMulVec(m, vecMinus(b.velocity, a.velocity)).map((x) => x / M_S)
		expect(position).toEqual([expect.closeTo(27.4, 1), expect.closeTo(-70.2, 1), expect.closeTo(711.8, 1)])
		expect(velocity).toEqual([expect.closeTo(-7.2, 1), expect.closeTo(-14692, 1), expect.closeTo(-1437.2, 1)])

		// With the declared EME2000 the inertial normal differs by |ω×r|/|v| ≈ 1.9°.
		const inertial = parseCDM(CDM_EXAMPLE).objects[0]
		const tilt = Math.atan2(matMulVec(rtnRotation(inertial.position, inertial.velocity)!, vecMinus(b.position, a.position))[1], matMulVec(rtnRotation(inertial.position, inertial.velocity)!, vecMinus(b.position, a.position))[2])
		expect(Math.abs(tilt - Math.atan2(position[1], position[2]))).toBeCloseTo(0.0331, 3)
	})

	test('RTN covariance becomes frame covariance', () => {
		const cdm = parseCDM(CDM_EXAMPLE)
		const [primary, secondary] = cdmEncounterStates(cdm)
		const m = rtnRotation(cdm.objects[0].position, cdm.objects[0].velocity)!
		const r: Vec3 = [m[0], m[1], m[2]]

		// The radial variance of the frame covariance is the CDM CR_R.
		const c = primary.covariance
		const radial = r[0] * (c.get(0, 0) * r[0] + c.get(0, 1) * r[1] + c.get(0, 2) * r[2]) + r[1] * (c.get(1, 0) * r[0] + c.get(1, 1) * r[1] + c.get(1, 2) * r[2]) + r[2] * (c.get(2, 0) * r[0] + c.get(2, 1) * r[1] + c.get(2, 2) * r[2])
		expect(radial * AU_M * AU_M).toBeCloseTo(41.42, 9)
		expect(secondary.position).toEqual(cdm.objects[1].position)
		expect(secondary.velocity).toEqual(cdm.objects[1].velocity)
	})
})

describe('collisionProbability', () => {
	test('published CDM example against an independent pipeline', () => {
		const cdm = parseCDM(CDM_EXAMPLE)
		const result = estimate(cdmCollisionProbability(cdm, meter(20)))

		expectRelative(result.probability, 4.7427901165612568e-7, 1e-9)
		expect(result.converged).toBeTrue()
		expect(result.error).toBeLessThan(1e-10 * result.probability)
		expect(toMeter(result.geometry.plane.miss[0])).toBeCloseTo(715.7474410561721, 6)
		expect(result.geometry.plane.covariance.map((x) => x * AU_M * AU_M)).toEqual([expect.closeTo(42566.06986166, 5), expect.closeTo(-4525.30418054, 5), expect.closeTo(-4525.30418054, 5), expect.closeTo(924.7178253, 5)])
		expect(result.geometry.relativeSpeed / M_S).toBeCloseTo(14762.08, 1)
		expect(Math.abs(result.geometry.closestApproachOffset)).toBeLessThan(0.01)

		// Object1's published 6x6 covariance is not positive semidefinite: |corr(R, Tdot)| = 5.476/sqrt(2533·0.005744) > 1.
		expect(result.covariance.primaryState.definiteness).toBe('indefinite')
		expect(result.covariance.primaryPosition.definiteness).toBe('positiveDefinite')
		expect(result.covariance.secondaryState.definiteness).toBe('positiveDefinite')
		expect(result.covariance.combinedPosition.conditionNumber).toBeGreaterThan(1)
		expect(result.validity.valid).toBeTrue()
		expect(result.validity.encounterDuration).toBeLessThan(2)

		// Hard-body radius from the two AREA_PC values of the optional example.
		const small = estimate(cdmCollisionProbability(cdm, meter(Math.sqrt(5.2 / Math.PI) + Math.sqrt(0.9 / Math.PI))))
		expectRelative(small.probability, 1.3784657993106846e-9, 1e-9)

		const itrf = estimate(cdmCollisionProbability(parseCDM(CDM_EXAMPLE.replaceAll('REF_FRAME = EME2000', 'REF_FRAME = ITRF')), meter(20)))
		expectRelative(itrf.probability, 2.2288231396530627e-11, 1e-8)
	})

	test('isotropic closed forms and tails', () => {
		// Centred: 1 - exp(-R²/2σ²); this is also the head-on, zero-miss case with no in-plane miss direction.
		expectRelative(pc(encounter(0, 0, 1, 0, 1), 1).probability, 1 - Math.exp(-0.5), 1e-12)
		expectRelative(pc(encounter(3, 0, 1, 0, 1), 0.5).probability, 0.0016997672944606263, 1e-10)
		expectRelative(pc(encounter(20, 0, 1, 0, 1), 1).probability, 1.8680666576614974025e-81, 1e-9)
		expectRelative(pc(encounter(0.2, 0.1, 0.01, 0.002, 0.02), 1).probability, 0.9999999969785173, 1e-12)
	})

	test('anisotropic and rotated covariances', () => {
		expectRelative(pc(encounter(30, -15, 1e6, 3e3, 100), 20).probability, 0.008412223530995946, 1e-9)
		expectRelative(pc(encounter(40, 25, 400, 250, 300), 5).probability, 0.0070074555211855448, 1e-9)
		expectRelative(pc(encounter(50, 10, 900, 100, 400), 0.5).probability, 5.1363057488085673e-5, 1e-9)

		// The probability is invariant under a common rotation of the frame; rotating the absolute AU positions
		// rounds the relative position at ~1e-11, which bounds the agreement.
		const states = encounter(40, 25, 400, 250, 300)
		const rotation = matMul(matRotZ(1.1), matMul(matRotY(-0.7), matRotX(2.3)))
		const rotated = rotateEncounter(states, rotation)
		expectRelative(pc(rotated, 5).probability, pc(states, 5).probability, 1e-9)
		expect(pc(rotated, 5).geometry.plane.zAxis).toEqual(matMulVec(rotation, [0, 0, 1]).map((x) => expect.closeTo(x, 14)) as unknown as Vec3)
	})

	test('grazing encounters', () => {
		// Gaussian centred on the disk edge: 1/2 minus the curvature term σ/(2R)·φ(0).
		expectRelative(pc(encounter(1, 0, 1e-4, 0, 1e-4), 1).probability, 0.49800526366269763, 1e-9)
		expectRelative(pc(encounter(1, 0, 1e-4, 0, 1), 1).probability, 0.046105627436784471, 1e-9)
	})

	test('small-object approximation converges to the quadrature as R -> 0', () => {
		const states = encounter(0, 0, 1, 0, 1)
		for (const radius of [0.1, 0.01, 0.001]) {
			const exact = pc(states, radius).probability
			const approximate = pc(states, radius, { method: 'smallObject' })
			expect(approximate.method).toBe('smallObject')
			// Exact ratio (1 - e^-x)/x with x = R²/2σ², which tends to 1 - x/2.
			const x = (radius * radius) / 2
			expect(exact / approximate.probability).toBeCloseTo(-Math.expm1(-x) / x, 11)
		}

		const offset = encounter(50, 10, 900, 100, 400)
		const ratio = pc(offset, 0.5).probability / pc(offset, 0.5, { method: 'smallObject' }).probability
		expect(Math.abs(ratio - 1)).toBeLessThan(0.25 / 400)
	})

	test('panel budget is reported', () => {
		const result = pc(encounter(30, -15, 1e6, 3e3, 100), 20, { maxPanels: 1, relativeTolerance: 0 })
		expect(result.converged).toBeFalse()
		expect(result.probability).toBeGreaterThan(0)
	})

	test('short-encounter validity diagnostics', () => {
		const fast = pc(encounter(30, 0, 100, 0, 100, 100), 10)
		expect(fast.validity.encounterDuration).toBeCloseTo((2 * (5 * 10 + 10)) / 10000, 12)
		// The relative velocity is radial, so both objects have |r×v|/|r|² = 7500 m/s / 7000 km.
		expect(fast.validity.orbitalArc).toBeCloseTo((fast.validity.encounterDuration * 7500) / 7000e3, 12)
		expect(fast.validity.velocityAngle).toBeCloseTo(Math.sqrt(1e-6) / 10000, 15)
		expect(fast.validity.valid).toBeTrue()

		const slow = pc(encounter(30, 0, 100, 0, 100, 100, 0.05), 10)
		expect(slow.validity.encounterDuration).toBeCloseTo(2400, 6)
		expect(slow.validity.valid).toBeFalse()

		const uncertain = pc(encounter(30, 0, 100, 0, 100, 100, 10000, 1e6), 10)
		expect(uncertain.validity.velocityAngle).toBeCloseTo(0.1, 12)
		expect(uncertain.validity.valid).toBeFalse()
		expect(pc(encounter(30, 0, 100, 0, 100, 100, 10000, 1e6), 10, { maximumVelocityAngle: 0.2 }).validity.valid).toBeTrue()
	})

	test('failures', () => {
		const [primary] = encounter(30, 0, 100, 0, 100)
		const same = collisionProbability(primary, { ...primary, covariance: new Matrix(6, 6) }, meter(10))
		expect(same.kind === 'failure' && same.reason).toBe('zeroRelativeVelocity')

		// Correlation 2 between x and y.
		const indefinite = collisionProbability(...encounter(30, 0, 100, 200, 100), meter(10))
		expect(indefinite.kind === 'failure' && indefinite.reason).toBe('indefiniteCovariance')
		expect(indefinite.covariance.primaryPosition.definiteness).toBe('indefinite')
		expect(indefinite.covariance.primaryPosition.minimumEigenvalue).toBeCloseTo(-1, 12)
		expect(indefinite.kind === 'failure' && indefinite.geometry?.plane.miss[0]).toBeCloseTo(meter(30), 20)

		// Uncertainty only along the relative velocity leaves no density in the encounter plane.
		const alongTrack = collisionProbability(...encounter(30, 0, 0, 0, 0, 100), meter(10))
		expect(alongTrack.kind === 'failure' && alongTrack.reason).toBe('degenerateEncounterCovariance')
		expect(alongTrack.covariance.primaryPosition.definiteness).toBe('positiveSemidefinite')

		// Perfect correlation in the plane is singular (rank one).
		const rankOne = collisionProbability(...encounter(30, 0, 100, 100, 100), meter(10))
		expect(rankOne.kind === 'failure' && rankOne.reason).toBe('degenerateEncounterCovariance')
		expect(rankOne.covariance.primaryPosition.definiteness).toBe('positiveSemidefinite')
	})

	test('near-singular covariances stay finite and conditioned', () => {
		// Correlation 1 - 1e-9 between x and y: positive definite but ill-conditioned.
		const result = pc(encounter(30, 0, 100, 100 * (1 - 1e-9), 100), 10, { covarianceTolerance: 1e-12 })
		expect(result.covariance.primaryPosition.definiteness).toBe('positiveDefinite')
		expect(result.covariance.primaryPosition.conditionNumber).toBeGreaterThan(1e9)
		expect(Number.isFinite(result.probability)).toBeTrue()
		expect(result.probability).toBeGreaterThanOrEqual(0)
		expect(result.geometry.plane.sigmaMinor).toBeGreaterThan(0)

		// A zero variance with a non-zero covariance is not a covariance.
		const [primary, secondary] = encounter(30, 0, 100, 0, 100)
		primary.covariance.set(3, 3, 0)
		primary.covariance.set(3, 4, 1e-20)
		primary.covariance.set(4, 3, 1e-20)
		const coupled = pc([primary, secondary], 10)
		expect(coupled.covariance.primaryState.definiteness).toBe('indefinite')
		expect(coupled.covariance.primaryPosition.definiteness).toBe('positiveDefinite')
	})
})
