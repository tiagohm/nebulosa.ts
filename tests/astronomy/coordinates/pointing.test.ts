import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { applyEquatorialPointingError, equatorialPointingError, type EquatorialPointingModel, IDENTITY_EQUATORIAL_POINTING_MODEL, isIdentityEquatorialPointingModel, MAX_POINTING_DECLINATION, tubeFlexureError } from '../../../src/astronomy/coordinates/pointing'
import { angularDistance } from '../../../src/astronomy/coordinates/coordinate'
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

	test('keeps a cone error on the sky right up to the pole', () => {
		// A cone error tilts the optical axis by its own size wherever the mount is pointing: written as
		// a hour-angle offset it grows as sec δ, and the sky it covers is that times cos δ, which is the
		// same sixty arcseconds everywhere. Applying the offset at the true declination multiplied it by
		// cos δ a second time, so it faded away over the last tenth of a degree and vanished outright at
		// the pole, where turning about the polar axis moves nothing at all.
		const cone = model({ coneError: arcsec(60) })
		const lst = hour(3)
		const rightAscension = hour(1)

		// A tenth of an arcsecond of tolerance rather than an exact match: a displacement in hour angle
		// runs along a parallel of declination and not along a great circle, so measured as an angle on
		// the sky it falls a little short of the offset it was written as. That is the convention the
		// model is defined in, and it is under a tenth of an arcsecond even at the last declination it is
		// applied at.
		for (const declination of [deg(45), deg(89), deg(89.9), deg(89.99), deg(89.999), PIOVERTWO, -PIOVERTWO]) {
			const [shiftedRightAscension, shiftedDeclination] = applyEquatorialPointingError(rightAscension, declination, lst, cone)
			const separated = toArcsec(angularDistance(rightAscension, declination, shiftedRightAscension, shiftedDeclination))
			expect(Math.abs(separated - 60)).toBeLessThan(0.1)
		}
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

describe('tube flexure', () => {
	// Mid-northern site, so the zenith and the pole are well separated.
	const latitude = deg(45)
	// A gross droop, chosen so the geometry is legible rather than realistic.
	const flexure = arcsec(120)

	test('vanishes at the zenith, where the tube points straight up', () => {
		const [deltaHourAngle, deltaDeclination] = tubeFlexureError(0, latitude, latitude, flexure)
		expect(toArcsec(deltaHourAngle)).toBeCloseTo(0, 6)
		expect(toArcsec(deltaDeclination)).toBeCloseTo(0, 6)
	})

	test('is exactly zero without any flexure', () => {
		expect(tubeFlexureError(hour(2), deg(20), latitude, 0)).toEqual([0, 0])
	})

	test('droops towards the horizon on the meridian, where the zenith is due north', () => {
		// On the meridian below the zenith the parallactic angle is zero, so the whole droop lands in
		// declination and none of it in hour angle. The tube sags away from the zenith, which here means
		// southwards, so the declination decreases.
		const declination = latitude - deg(30)
		const [deltaHourAngle, deltaDeclination] = tubeFlexureError(0, declination, latitude, flexure)

		expect(toArcsec(deltaHourAngle)).toBeCloseTo(0, 9)
		expect(toArcsec(deltaDeclination)).toBeCloseTo(-flexureAt(deg(30)), 6)
	})

	test('reverses in declination above the zenith, where the zenith lies south of the target', () => {
		// Past the zenith the parallactic angle flips to 180 degrees, so sagging away from the zenith now
		// increases the declination instead of decreasing it.
		const [, deltaDeclination] = tubeFlexureError(0, latitude + deg(30), latitude, flexure)
		expect(toArcsec(deltaDeclination)).toBeCloseTo(flexureAt(deg(30)), 6)
	})

	test('grows with the zenith distance', () => {
		const near = Math.abs(tubeFlexureError(0, latitude - deg(10), latitude, flexure)[1])
		const far = Math.abs(tubeFlexureError(0, latitude - deg(60), latitude, flexure)[1])
		expect(far).toBeGreaterThan(near)
		// sin(60) / sin(10) for the two zenith distances.
		expect(far / near).toBeCloseTo(Math.sin(deg(60)) / Math.sin(deg(10)), 6)
	})

	test('mirrors across the meridian', () => {
		// Same zenith distance either side of the meridian: the declination component is identical and
		// the hour-angle component changes sign, which is what makes flexure fit as an even term.
		const west = tubeFlexureError(hour(2), deg(20), latitude, flexure)
		const east = tubeFlexureError(hour(-2), deg(20), latitude, flexure)

		expect(east[0]).toBeCloseTo(-west[0], 12)
		expect(east[1]).toBeCloseTo(west[1], 12)
		expect(Math.abs(toArcsec(west[0]))).toBeGreaterThan(1)
	})

	test('stays finite at the pole', () => {
		// cos(declination) divides the hour-angle term, so the clamp is what keeps this from diverging.
		const [deltaHourAngle, deltaDeclination] = tubeFlexureError(hour(3), PIOVERTWO, latitude, flexure)
		expect(Number.isFinite(deltaHourAngle)).toBeTrue()
		expect(Math.abs(toArcsec(deltaHourAngle))).toBeLessThan(1e5)
		expect(Math.abs(toArcsec(deltaDeclination))).toBeLessThanOrEqual(toArcsec(flexure))
	})

	test('writes into the optional output parameter and returns it', () => {
		const output: [number, number] = [0, 0]
		expect(tubeFlexureError(hour(2), deg(20), latitude, flexure, output)).toBe(output)
		expect(output[1]).not.toBe(0)
	})

	// Droop expected at a given zenith distance, arcseconds.
	function flexureAt(zenithDistance: number) {
		return toArcsec(flexure) * Math.sin(zenithDistance)
	}
})
