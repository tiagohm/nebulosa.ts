import { describe, expect, test } from 'bun:test'
import { applyEquatorialPointingError, equatorialPointingError, type EquatorialPointingModel, IDENTITY_EQUATORIAL_POINTING_MODEL, isIdentityEquatorialPointingModel, MAX_POINTING_DECLINATION } from '../../../src/astronomy/coordinates/pointing'
import { PIOVERTWO } from '../../../src/core/constants'
import { arcsec, deg, hour, normalizePI, toArcsec } from '../../../src/math/units/angle'
import { polarAlignmentError } from '../../../src/observation/alignment/polaralignment'

// Unit coverage for the TPoint equatorial pointing model: each geometric term in isolation, the
// declination dependency of the sec/tan terms, pole singularity handling, and agreement with the
// existing polar-alignment forward model.

// Builds a model with a single non-zero term so each coefficient can be verified in isolation.
function model(term: Partial<EquatorialPointingModel>): EquatorialPointingModel {
	return { ...IDENTITY_EQUATORIAL_POINTING_MODEL, ...term }
}

describe('equatorial pointing error', () => {
	test('identity model is an exact no-op', () => {
		for (const declination of [deg(-80), deg(-20), 0, deg(35), deg(88)]) {
			for (const hourAngle of [hour(-6), hour(-1), 0, hour(3), hour(11)]) {
				const [deltaHourAngle, deltaDeclination] = equatorialPointingError(hourAngle, declination, IDENTITY_EQUATORIAL_POINTING_MODEL)
				expect(deltaHourAngle).toBe(0)
				expect(deltaDeclination).toBe(0)
			}
		}

		expect(isIdentityEquatorialPointingModel(IDENTITY_EQUATORIAL_POINTING_MODEL)).toBeTrue()
		expect(isIdentityEquatorialPointingModel(model({ coneError: arcsec(1) }))).toBeFalse()
	})

	test('index errors are constant offsets independent of orientation', () => {
		const indexErrors = model({ indexHourAngle: arcsec(30), indexDeclination: arcsec(-45) })

		for (const declination of [deg(-60), 0, deg(20), deg(75)]) {
			for (const hourAngle of [hour(-5), 0, hour(2), hour(9)]) {
				const [deltaHourAngle, deltaDeclination] = equatorialPointingError(hourAngle, declination, indexErrors)
				expect(toArcsec(deltaHourAngle)).toBeCloseTo(30, 9)
				expect(toArcsec(deltaDeclination)).toBeCloseTo(-45, 9)
			}
		}
	})

	test('cone error scales as sec of the declination', () => {
		const coneError = arcsec(120)
		const coneModel = model({ coneError })

		// At the equator sec δ = 1, so the hour-angle error equals the coefficient itself.
		expect(toArcsec(equatorialPointingError(hour(3), 0, coneModel)[0])).toBeCloseTo(120, 9)

		// sec 60° = 2 exactly.
		expect(toArcsec(equatorialPointingError(hour(3), deg(60), coneModel)[0])).toBeCloseTo(240, 6)

		// The declination is untouched by CH.
		expect(equatorialPointingError(hour(3), deg(60), coneModel)[1]).toBe(0)
	})

	test('axis non-perpendicularity scales as tan of the declination', () => {
		const axisNonPerpendicularity = arcsec(90)
		const axisModel = model({ axisNonPerpendicularity })

		// tan 0 = 0, so NP vanishes at the equator.
		expect(equatorialPointingError(hour(-2), 0, axisModel)[0]).toBeCloseTo(0, 12)

		// tan 45° = 1 exactly.
		expect(toArcsec(equatorialPointingError(hour(-2), deg(45), axisModel)[0])).toBeCloseTo(90, 6)

		expect(equatorialPointingError(hour(-2), deg(45), axisModel)[1]).toBe(0)
	})

	test('polar axis errors follow the classic MA/ME dependency', () => {
		const polarAzimuthError = arcsec(200)
		const polarAltitudeError = arcsec(-150)
		const polarModel = model({ polarAzimuthError, polarAltitudeError })

		// At H = 0: Δδ = ME, and the MA contribution to ΔH is -MA·tan δ.
		const [deltaHourAngleAtZero, deltaDeclinationAtZero] = equatorialPointingError(0, deg(45), polarModel)
		expect(toArcsec(deltaDeclinationAtZero)).toBeCloseTo(-150, 6)
		expect(toArcsec(deltaHourAngleAtZero)).toBeCloseTo(-200, 6)

		// At H = 6h (90°): Δδ = MA, and the ME contribution to ΔH is +ME·tan δ.
		const [deltaHourAngleAtSix, deltaDeclinationAtSix] = equatorialPointingError(hour(6), deg(45), polarModel)
		expect(toArcsec(deltaDeclinationAtSix)).toBeCloseTo(200, 6)
		expect(toArcsec(deltaHourAngleAtSix)).toBeCloseTo(-150, 6)
	})

	test('agrees with polarAlignmentError apart from the Ralph Pass sin latitude term', () => {
		const latitude = deg(-22)
		const lst = hour(4)
		const azimuthError = arcsec(300)
		const altitudeError = arcsec(-200)

		// polarAlignmentError uses MA = azimuthError·cos φ and ME = -altitudeError, plus a constant
		// azimuthError·sin φ term in hour angle that is not part of the canonical TPoint model.
		const equivalent = model({
			polarAzimuthError: azimuthError * Math.cos(latitude),
			polarAltitudeError: -altitudeError,
			indexHourAngle: azimuthError * Math.sin(latitude),
		})

		for (const declination of [deg(-40), deg(-10), deg(25), deg(60)]) {
			for (const rightAscension of [hour(0), hour(5), hour(13), hour(21)]) {
				const [expectedRightAscension, expectedDeclination] = polarAlignmentError(rightAscension, declination, latitude, lst, azimuthError, altitudeError)
				const [actualRightAscension, actualDeclination] = applyEquatorialPointingError(rightAscension, declination, lst, equivalent)

				expect(normalizePI(actualRightAscension - expectedRightAscension)).toBeCloseTo(0, 12)
				expect(actualDeclination - expectedDeclination).toBeCloseTo(0, 12)
			}
		}
	})

	test('stays finite at the poles', () => {
		const singular = model({ coneError: arcsec(60), axisNonPerpendicularity: arcsec(60), polarAzimuthError: arcsec(600), polarAltitudeError: arcsec(600) })

		for (const declination of [PIOVERTWO, -PIOVERTWO, deg(90), deg(-90), deg(89.99)]) {
			const [deltaHourAngle, deltaDeclination] = equatorialPointingError(hour(3), declination, singular)
			expect(Number.isFinite(deltaHourAngle)).toBeTrue()
			expect(Number.isFinite(deltaDeclination)).toBeTrue()

			// The clamp bounds the hour-angle error by the value it would take at the clamp declination.
			const maxTan = Math.tan(MAX_POINTING_DECLINATION)
			expect(Math.abs(deltaHourAngle)).toBeLessThanOrEqual(arcsec(60) / Math.cos(MAX_POINTING_DECLINATION) + arcsec(60) * maxTan + arcsec(600) * maxTan * 2)
		}

		// Without the clamp this would explode: tan(PIOVERTWO) is about 1.6e16 in double precision.
		const [poleDeltaHourAngle] = equatorialPointingError(0, PIOVERTWO, model({ polarAzimuthError: arcsec(600) }))
		expect(Math.abs(toArcsec(poleDeltaHourAngle))).toBeLessThan(4e5)
	})

	test('applies the hour-angle error with the right ascension sign convention', () => {
		const lst = hour(6)
		const rightAscension = hour(2)
		const declination = deg(30)

		// A pure positive index error in hour angle must decrease the right ascension, since H = LST - RA.
		const [shiftedRightAscension] = applyEquatorialPointingError(rightAscension, declination, lst, model({ indexHourAngle: arcsec(360) }))
		expect(toArcsec(normalizePI(shiftedRightAscension - rightAscension))).toBeCloseTo(-360, 6)

		// A positive index error in declination increases the declination.
		const [, shiftedDeclination] = applyEquatorialPointingError(rightAscension, declination, lst, model({ indexDeclination: arcsec(360) }))
		expect(toArcsec(shiftedDeclination - declination)).toBeCloseTo(360, 6)
	})

	test('writes into the optional output parameter and returns it', () => {
		const output: [number, number] = [0, 0]
		const result = equatorialPointingError(hour(1), deg(20), model({ indexHourAngle: arcsec(10), indexDeclination: arcsec(20) }), output)
		expect(result).toBe(output)
		expect(toArcsec(output[0])).toBeCloseTo(10, 9)
		expect(toArcsec(output[1])).toBeCloseTo(20, 9)

		const applied: [number, number] = [0, 0]
		expect(applyEquatorialPointingError(hour(1), deg(20), hour(3), IDENTITY_EQUATORIAL_POINTING_MODEL, applied)).toBe(applied)
	})
})
