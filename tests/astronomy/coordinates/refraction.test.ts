import { expect, test } from 'bun:test'
import { parallacticAngle, unrefractedAltitude } from '../../../src/astronomy/coordinates/astrometry'
import { atmosphericDispersion, differentialRefraction, refractiveDisplacement } from '../../../src/astronomy/coordinates/refraction'
import { ARCSEC_PER_RADIAN, DEG2RAD, PIOVERTWO } from '../../../src/core/constants'

test('differential refraction uses the bounded observed-place model and puts blue higher', () => {
	const altitude = 45 * DEG2RAD
	const blue = altitude - unrefractedAltitude(altitude, { wl: 0.45 })
	const red = altitude - unrefractedAltitude(altitude, { wl: 0.65 })
	const difference = differentialRefraction(altitude, 0.45, 0.65)
	expect(difference).toBeDefined()
	expect(difference!).toBeCloseTo(blue - red, 15)
	expect(difference!).toBeGreaterThan(0)
	expect(refractiveDisplacement(PIOVERTWO, 0.55)).toBe(0)
	expect(differentialRefraction(0, 0.45, 0.65)).toBeUndefined()
})

test('refractive displacement stays finite, positive, and model-consistent near the horizon', () => {
	for (const degrees of [45, 20, 10, 5, 3, 2, 1]) {
		const altitude = degrees * DEG2RAD
		const displacement = refractiveDisplacement(altitude, 0.55)
		expect(displacement).toBeDefined()
		expect(displacement!).toBeFinite()
		expect(displacement!).toBeGreaterThan(0)
		expect(displacement!).toBeCloseTo(altitude - unrefractedAltitude(altitude, { wl: 0.55 }), 15)
	}

	for (const degrees of [5, 3, 2, 1]) {
		const difference = differentialRefraction(degrees * DEG2RAD, 0.45, 0.65)
		expect(difference).toBeDefined()
		expect(difference!).toBeFinite()
		expect(difference!).toBeGreaterThan(0)
	}

	// PyERFA 2.0.1.5 refco coefficients evaluated with SOFA eraAtioq's bounded correction and an
	// independent bisection inversion give 646.928433594 arcsec at 1° apparent altitude.
	expect(refractiveDisplacement(DEG2RAD, 0.55)! * ARCSEC_PER_RADIAN).toBeCloseTo(646.928433594, 9)
})

test('dispersion length is the band difference and its direction is the parallactic angle', () => {
	const altitude = 40 * DEG2RAD
	const hourAngle = 0.4
	const declination = 0.2
	const latitude = 0.6
	const dispersion = atmosphericDispersion(altitude, 0.7, 0.4, { hourAngle, declination, latitude, arcsecPerPixel: 1.5 })
	const signed = differentialRefraction(altitude, 0.4, 0.7)
	expect(dispersion).toBeDefined()
	expect(dispersion!.angle).toBeCloseTo(Math.abs(signed!), 12)
	expect(dispersion!.positionAngle).toBeCloseTo(parallacticAngle(hourAngle, declination, latitude), 12)
	expect(dispersion!.pixels).toBeCloseTo(dispersion!.arcseconds / 1.5, 12)
	expect(atmosphericDispersion(altitude, 0.4, 0.7)?.positionAngle).toBeUndefined()
})
