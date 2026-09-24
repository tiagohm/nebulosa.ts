import { expect, test } from 'bun:test'
import { parallacticAngle } from '../../../src/astronomy/coordinates/astrometry'
import { eraRefco } from '../../../src/astronomy/coordinates/erfa/erfa'
import { atmosphericDispersion, differentialRefraction, refractiveDisplacement } from '../../../src/astronomy/coordinates/refraction'
import { DEG2RAD, PIOVERTWO } from '../../../src/core/constants'

test('differential refraction matches eraRefco and puts the shorter wavelength higher', () => {
	const altitude = 45 * DEG2RAD
	const zenith = PIOVERTWO - altitude
	const tanZenith = Math.tan(zenith)
	const [blueA, blueB] = eraRefco(1013.25, 15, 0.5, 0.45)
	const [redA, redB] = eraRefco(1013.25, 15, 0.5, 0.65)
	const expected = (blueA - redA) * tanZenith + (blueB - redB) * tanZenith ** 3
	const difference = differentialRefraction(altitude, 0.45, 0.65)
	expect(difference).toBeDefined()
	expect(difference!).toBeCloseTo(expected, 12)
	expect(difference!).toBeGreaterThan(0)
	expect(refractiveDisplacement(PIOVERTWO, 0.55)).toBe(0)
	expect(differentialRefraction(0, 0.45, 0.65)).toBeUndefined()
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
