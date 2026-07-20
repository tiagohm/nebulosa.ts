import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../src/core/constants'
import { deg } from '../../../src/math/units/angle'
import { challisRefractionCorrection, fitChallisPolarAlignment, type ChallisObservation } from '../../../src/observation/alignment/polaralignment.challis'

// Tests Challis/Taki signs, star intercepts, robust fitting, hemispheres, and refraction correction.

// Builds exact observations for shared u/v and star-specific intercepts.
function syntheticObservations(u: number, v: number, stars: Readonly<Record<string, number>>, hourAngles: readonly number[]): ChallisObservation[] {
	const observations: ChallisObservation[] = []
	for (const [star, intercept] of Object.entries(stars)) {
		for (const hourAngle of hourAngles) observations.push({ star, hourAngle, mountDeclination: intercept + u * Math.cos(hourAngle) - v * Math.sin(hourAngle) })
	}
	return observations
}

test('one star at three instants recovers exact Taki u and v signs', () => {
	const observations = syntheticObservations(0.008, -0.003, { sirius: 0.4 }, [deg(-70), deg(5), deg(95)])
	const result = fitChallisPolarAlignment(observations, deg(35))
	expect(result.u).toBeCloseTo(0.008, 12)
	expect(result.v).toBeCloseTo(-0.003, 12)
	expect(result.magnitude).toBeCloseTo(Math.hypot(0.008, -0.003), 12)
	expect(result.takiPole[0]).toBeGreaterThan(0)
	expect(result.takiPole[1]).toBeLessThan(0)
	expect(result.residuals.every((value) => Math.abs(value) < 1e-12)).toBeTrue()
})

test('multiple stars retain separate intercepts while sharing u and v', () => {
	const observations = syntheticObservations(-0.004, 0.006, { alpha: 0.2, beta: -0.5, gamma: 0.9 }, [deg(-100), deg(-20), deg(55), deg(130)])
	for (let i = 0; i < observations.length; i++) observations[i] = { ...observations[i], correction: 0.001, mountDeclination: observations[i].mountDeclination + 0.001 }
	const result = fitChallisPolarAlignment(observations, deg(-28))
	expect(result.u).toBeCloseTo(-0.004, 12)
	expect(result.v).toBeCloseTo(0.006, 12)
	expect(result.altitude).toBeGreaterThan(0)
	expect(result.conditionNumber).toBeLessThan(10)
})

test('published Taki section 5.5.2.2 Challis example is reproduced', () => {
	const result = fitChallisPolarAlignment(
		[
			{ star: 'alpha Boo', hourAngle: 5.99662377, mountDeclination: 0 },
			{ star: 'alpha Boo', hourAngle: 6.21538725, mountDeclination: -0.00016736 },
			{ star: 'alpha Boo', hourAngle: 6.35977114, mountDeclination: -0.00048675 },
		],
		deg(52 + 9 / 60 + 20.32 / 3600),
	)
	// The printed hour angles and drifts are rounded; they recover the published result within that input precision.
	expect(Math.abs(result.u - 0.008051)).toBeLessThan(2.5e-4)
	expect(Math.abs(result.v - 0.002204)).toBeLessThan(3e-5)
})

test('Tukey regression suppresses a gross declination outlier', () => {
	const expectedU = 0.005
	const expectedV = -0.002
	const observations = syntheticObservations(expectedU, expectedV, { star: 0.3 }, [deg(-150), deg(-100), deg(-40), deg(10), deg(55), deg(100), deg(150)])
	observations[5] = { ...observations[5], mountDeclination: observations[5].mountDeclination + 0.1 }
	const ordinary = fitChallisPolarAlignment(observations, deg(40))
	const robust = fitChallisPolarAlignment(observations, deg(40), { robust: 'tukey' })
	const ordinaryError = Math.hypot(ordinary.u - expectedU, ordinary.v - expectedV)
	const robustError = Math.hypot(robust.u - expectedU, robust.v - expectedV)
	expect(robustError).toBeLessThan(ordinaryError)
	expect(robust.weights[5]).toBeLessThan(ordinary.weights[5])
})

test('north and south results publish the physical pole above the horizon', () => {
	const observations = syntheticObservations(0.003, 0.004, { star: 0.2 }, [deg(-90), 0, deg(90)])
	const north = fitChallisPolarAlignment(observations, deg(30))
	const south = fitChallisPolarAlignment(observations, deg(-30))
	expect(north.takiPole).toEqual(south.takiPole)
	expect(north.poleEnu[2]).toBeGreaterThan(0)
	expect(south.poleEnu[2]).toBeGreaterThan(0)
	expect(north.altitude).toBeGreaterThan(0)
	expect(south.altitude).toBeGreaterThan(0)
})

test('polar fits retain total error when adjustment components are singular', () => {
	const u = 0.003
	const v = 0.004
	const observations = syntheticObservations(u, v, { star: 0.2 }, [deg(-90), 0, deg(90)])

	for (const latitude of [-PIOVERTWO, PIOVERTWO]) {
		const result = fitChallisPolarAlignment(observations, latitude)
		expect(result.u).toBeCloseTo(u, 12)
		expect(result.v).toBeCloseTo(v, 12)
		expect(result.totalError).toBeCloseTo(Math.atan(Math.hypot(u, v)), 12)
		expect(result.azimuthError).toBeUndefined()
		expect(result.altitudeError).toBeUndefined()
	}
})

test('refraction correction uses the shared atmosphere model and rejects deep-below-horizon data', () => {
	const correction = challisRefractionCorrection(0, deg(20), deg(45))
	expect(Number.isFinite(correction)).toBeTrue()
	expect(correction).not.toBe(0)
	expect(() => challisRefractionCorrection(PI, deg(-60), deg(45))).toThrow()
})

test('insufficient, rank-deficient, and invalid observations are rejected', () => {
	expect(() => fitChallisPolarAlignment([], deg(30))).toThrow()
	expect(() =>
		fitChallisPolarAlignment(
			[
				{ star: 1, hourAngle: 0, mountDeclination: 0 },
				{ star: 1, hourAngle: 1, mountDeclination: 0 },
			],
			deg(30),
		),
	).toThrow()
	expect(() =>
		fitChallisPolarAlignment(
			[
				{ star: 1, hourAngle: 0, mountDeclination: 0 },
				{ star: 1, hourAngle: 0, mountDeclination: 0 },
				{ star: 1, hourAngle: 0, mountDeclination: 0 },
			],
			deg(30),
		),
	).toThrow()
	expect(() => fitChallisPolarAlignment(syntheticObservations(0, 0, { star: 0 }, [-1, 0, 1]), deg(30), { tuning: 0 })).toThrow()
})
