import { describe, expect, test } from 'bun:test'
import { normalizeAngle, normalizePI } from '../src/angle'
import { KeplerOrbit } from '../src/asteroid'
import { ASEC2RAD, TAU } from '../src/constants'
import { matIdentity } from '../src/mat3'
import { type OrbitFitAngularResidual, type OrbitFitOptions, fitOrbit, type OrbitFitObservation } from '../src/orbit.fit'
import { type Time, Timescale, timeShift, timeYMDHMS } from '../src/time'
import { vecDistance, type MutVec3, type Vec3 } from '../src/vec3'
import { mulberry32, normal } from '../src/random'
import type { EquatorialCoordinate } from '../src/coordinate'

const IDENTITY_ROTATION = matIdentity()
const EPOCH = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
const TRUE_ORBIT = KeplerOrbit.trueAnomaly(1.9, 0.18, 0.12, 0.8, 1.1, 0.35, EPOCH, undefined, IDENTITY_ROTATION)
const ASTROMETRY_ERR = 0.25 * ASEC2RAD

interface SyntheticOptions {
	readonly count?: number
	readonly spacingDays?: number
	readonly noiseSigma?: number
	readonly seed?: number
	readonly raErr?: number
	readonly decErr?: number
}

function makeSyntheticObservations(options: SyntheticOptions = {}) {
	const count = options.count ?? 12
	const spacingDays = options.spacingDays ?? 8
	const noiseSigma = options.noiseSigma ?? 0
	const random = normal(mulberry32(options.seed ?? 1))
	const observations = new Array<OrbitFitObservation>(count)

	for (let i = 0; i < count; i++) {
		const offset = (i - (count - 1) / 2) * spacingDays
		const time = timeShift(EPOCH, offset)
		const observerPosition = observerPositionAt(offset)
		const model = modelRaDec(TRUE_ORBIT, time, observerPosition)
		const raNoise = noiseSigma ? random() * noiseSigma : 0
		const decNoise = noiseSigma ? random() * noiseSigma : 0

		observations[i] = {
			time,
			rightAscension: normalizeAngle(model.rightAscension + raNoise),
			declination: model.declination + decNoise,
			raErr: options.raErr ?? ASTROMETRY_ERR,
			decErr: options.decErr ?? ASTROMETRY_ERR,
			observerPosition,
		}
	}

	return observations
}

function observerPositionAt(offsetDays: number): MutVec3 {
	const angle = (TAU * offsetDays) / 365.25 + 0.4
	return [Math.cos(angle), Math.sin(angle), 0.04 * Math.sin(2 * angle)]
}

function modelRaDec(orbit: KeplerOrbit, time: Time, observerPosition: Vec3): EquatorialCoordinate {
	const position = orbit.at(time)[0]
	const x = position[0] - observerPosition[0]
	const y = position[1] - observerPosition[1]
	const z = position[2] - observerPosition[2]
	const range = Math.hypot(x, y, z)
	return { rightAscension: normalizeAngle(Math.atan2(y, x)), declination: Math.asin(Math.max(-1, Math.min(1, z / range))) }
}

function perturbedPosition(): MutVec3 {
	return [TRUE_ORBIT.position[0] + 0.003, TRUE_ORBIT.position[1] - 0.0025, TRUE_ORBIT.position[2] + 0.0015]
}

function perturbedVelocity(): MutVec3 {
	return [TRUE_ORBIT.velocity[0] - 1.5e-5, TRUE_ORBIT.velocity[1] + 1.2e-5, TRUE_ORBIT.velocity[2] - 8e-6]
}

function residualMean(residuals: readonly OrbitFitAngularResidual[], start: number, end: number) {
	let sum = 0
	for (let i = start; i < end; i++) sum += residuals[i].total
	return sum / (end - start)
}

function fitOptions(): OrbitFitOptions {
	return { maxIterations: 80, tolerance: 1e-14, parameterTolerance: 1e-13, gradientTolerance: 1e-11 }
}

test('recovers a synthetic two-body orbit from noisy astrometry', () => {
	const observations = makeSyntheticObservations({ noiseSigma: ASTROMETRY_ERR, seed: 42 })
	const result = fitOrbit(observations, EPOCH, perturbedPosition(), perturbedVelocity(), fitOptions())

	expect(result.converged).toBeTrue()
	expect(vecDistance(result.state.position, TRUE_ORBIT.position)).toBeLessThan(7e-4)
	expect(vecDistance(result.state.velocity, TRUE_ORBIT.velocity)).toBeLessThan(2e-5)
	expect(Math.abs(result.orbit.semiMajorAxis - TRUE_ORBIT.semiMajorAxis)).toBeLessThan(0.003)
	expect(Math.abs(result.orbit.eccentricity - TRUE_ORBIT.eccentricity)).toBeLessThan(0.0015)
	expect(result.rms).toBeLessThan(2 * ASTROMETRY_ERR)
})

test('uses the short residual across the RA wrap boundary', () => {
	const p: MutVec3 = [1, 1e-6, 0]
	const v: MutVec3 = [0, 0.017, 0.001]
	const orbit = new KeplerOrbit(p, v, EPOCH, undefined, IDENTITY_ROTATION)
	const observerPosition: Vec3 = [0, 0, 0]
	const model = modelRaDec(orbit, EPOCH, observerPosition)
	const observations = Array.from({ length: 3 }, () => <OrbitFitObservation>{ time: EPOCH, rightAscension: normalizeAngle(model.rightAscension - 3e-6), declination: model.declination, raErr: ASEC2RAD, decErr: ASEC2RAD, observerPosition })

	const result = fitOrbit(observations, EPOCH, p, v, { maxIterations: 0, computeCovariance: false })

	expect(result.residuals.angular[0].dRA).toBeCloseTo(-3e-6 * Math.cos(model.declination), 14)
	expect(Math.abs(result.residuals.angular[0].dRA)).toBeLessThan(1e-5)
})

test('weights high-uncertainty observations less than precise observations', () => {
	const precise = makeSyntheticObservations({ count: 12, noiseSigma: 0, raErr: ASTROMETRY_ERR, decErr: ASTROMETRY_ERR })
	const biased = precise.map((observation, index) => {
		if (index < precise.length / 2) return observation
		return { ...observation, rightAscension: normalizeAngle(observation.rightAscension + 5e-4), raErr: 1e-3, decErr: 1e-3 }
	})
	const allPrecise = biased.map((observation) => ({ ...observation, raErr: ASTROMETRY_ERR, decErr: ASTROMETRY_ERR }))
	const weighted = fitOrbit(biased, EPOCH, perturbedPosition(), perturbedVelocity(), fitOptions())
	const unweighted = fitOrbit(allPrecise, EPOCH, perturbedPosition(), perturbedVelocity(), fitOptions())
	const preciseMean = residualMean(weighted.residuals.angular, 0, precise.length / 2)
	const biasedMean = residualMean(weighted.residuals.angular, precise.length / 2, precise.length)

	expect(weighted.converged).toBeTrue()
	expect(vecDistance(weighted.state.position, TRUE_ORBIT.position)).toBeLessThan(vecDistance(unweighted.state.position, TRUE_ORBIT.position) * 0.4)
	expect(preciseMean).toBeLessThan(2e-6)
	expect(biasedMean).toBeGreaterThan(1e-4)
})

test('rejects fewer than three observations', () => {
	const observations = makeSyntheticObservations({ count: 2 })

	expect(() => fitOrbit(observations, EPOCH, TRUE_ORBIT.position, TRUE_ORBIT.velocity)).toThrow('at least 3 observations')
})

test('rejects an invalid topocentric model gracefully', () => {
	const observations = Array.from({ length: 3 }, () => <OrbitFitObservation>{ time: EPOCH, rightAscension: 0, declination: 0, observerPosition: TRUE_ORBIT.position })

	expect(() => fitOrbit(observations, EPOCH, TRUE_ORBIT.position, TRUE_ORBIT.velocity)).toThrow('initial orbit state cannot be evaluated')
})

describe('covariance', () => {
	test('is finite and symmetric for a well-conditioned fit', () => {
		const observations = makeSyntheticObservations({ count: 14, noiseSigma: ASTROMETRY_ERR, seed: 7 })
		const result = fitOrbit(observations, EPOCH, perturbedPosition(), perturbedVelocity(), fitOptions())

		expect(result.covariance).toBeDefined()

		const covariance = result.covariance!
		expect(covariance.rows).toBe(6)
		expect(covariance.cols).toBe(6)

		for (let row = 0; row < covariance.rows; row++) {
			for (let col = 0; col < covariance.cols; col++) {
				expect(Number.isFinite(covariance.get(row, col))).toBeTrue()
				expect(covariance.get(row, col)).toBeCloseTo(covariance.get(col, row), 12)
			}
		}
	})

	test('is undefined for an ill-conditioned observation geometry', () => {
		const observation = makeSyntheticObservations({ count: 1 })[0]
		const observations = Array.from({ length: 4 }, () => observation)
		const result = fitOrbit(observations, EPOCH, TRUE_ORBIT.position, TRUE_ORBIT.velocity, { maxIterations: 0 })

		expect(result.covariance).toBeUndefined()
	})
})

test('normalizes final residuals by per-axis uncertainty', () => {
	const observation = makeSyntheticObservations({ count: 1 })[0]
	const observations: readonly OrbitFitObservation[] = [
		{ ...observation, rightAscension: normalizeAngle(observation.rightAscension + ASEC2RAD), raErr: ASEC2RAD, decErr: ASEC2RAD },
		{ ...observation, rightAscension: normalizeAngle(observation.rightAscension + ASEC2RAD), raErr: 10 * ASEC2RAD, decErr: ASEC2RAD },
		{ ...observation, rightAscension: normalizeAngle(observation.rightAscension + ASEC2RAD), raErr: 100 * ASEC2RAD, decErr: ASEC2RAD },
	]

	const result = fitOrbit(observations, EPOCH, TRUE_ORBIT.position, TRUE_ORBIT.velocity, { maxIterations: 0, computeCovariance: false })
	const cosDec = Math.cos(observation.declination)

	expect(result.residuals.normalized[0]).toBeCloseTo(cosDec, 10)
	expect(result.residuals.normalized[2]).toBeCloseTo(cosDec / 10, 10)
	expect(result.residuals.normalized[4]).toBeCloseTo(cosDec / 100, 10)
	expect(normalizePI(observations[0].rightAscension - observation.rightAscension)).toBeCloseTo(ASEC2RAD, 14)
})
