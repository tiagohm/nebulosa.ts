import { expect, test } from 'bun:test'
import { deg, toArcsec } from '../src/angle'
import { refractedAltitude } from '../src/astrometry'

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
