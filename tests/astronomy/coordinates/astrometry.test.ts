import { expect, test } from 'bun:test'
import { refractedAltitude } from '../../../src/astronomy/coordinates/astrometry'
import { deg, toArcsec } from '../../../src/math/units/angle'

// https://bitbucket.org/Isbeorn/nina/src/master/NINA.Test/AstrometryTest/AstrometryTest.cs
test('refracted altitude', () => {
	const refraction = { pressure: 1005, temperature: 7, relativeHumidity: 0.8, wl: 0.574 }

	function refract(altitude: number, expected: number, tolerance: number) {
		const a = deg(altitude)
		const r = Math.abs(toArcsec(a - refractedAltitude(a, refraction)))
		expect(r).toBeCloseTo(expected, -Math.log10(2 * tolerance))
	}

	refract(10, 318.55, 4)
	refract(12, 267.29, 3)
	refract(14, 229.43, 2)
	refract(16, 200.38, 2)
	refract(18, 177.37, 2)
	refract(20, 158.68, 2)
	refract(25, 124.26, 2)
	refract(30, 100.54, 1)
	refract(35, 82.99, 1)
	refract(40, 69.3, 1)
	refract(45, 58.18, 1)
	refract(50, 48.83, 1)
	refract(60, 33.61, 1)
	refract(70, 21.2, 1)
	refract(80, 10.27, 1)
})

// Regression: the previous A*tan(z) + B*tan^3(z) brute-force inversion returned
// wildly wrong, non-monotonic values below ~5 deg and NaN below ~1.5 deg. The
// bounded ERFA model must stay finite and physical all the way to the horizon.
test('refracted altitude stays finite and lifts the object at low altitude', () => {
	for (const altitude of [5, 3, 2, 1, 0.5, 0.01]) {
		const a = deg(altitude)
		const refracted = refractedAltitude(a)

		expect(Number.isNaN(refracted)).toBe(false)
		// Refraction always lifts the object: apparent altitude > true altitude.
		expect(refracted).toBeGreaterThan(a)
	}

	// 2 deg previously collapsed to a spurious ~164"; the bounded model caps it near
	// the ~3 deg value instead (a few hundred arcsec), never NaN or sub-true.
	expect(toArcsec(refractedAltitude(deg(2)) - deg(2))).toBeGreaterThan(500)
})

test('no refraction model below the horizon', () => {
	expect(refractedAltitude(deg(-1))).toBe(deg(-1))
})
