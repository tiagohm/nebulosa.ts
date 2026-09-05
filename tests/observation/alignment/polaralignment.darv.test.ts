import { describe, expect, test } from 'bun:test'
import { SIDEREAL_RATE } from '../../../src/core/constants'
import { hour, deg } from '../../../src/math/units/angle'
import { type DarvExposureInput, COARSE_DARV_EXPOSURE_PRESET, estimateDarvExposure } from '../../../src/observation/alignment/polaralignment.darv'

function darvInput(input: Partial<DarvExposureInput> = {}): DarvExposureInput {
	return { focalLength: 1000, pixelSize: 3.75, declination: 0, hourAngle: hour(6), latitude: deg(45), mode: 'altitude', preset: COARSE_DARV_EXPOSURE_PRESET, ...input }
}

describe('darv exposure estimator', () => {
	test('computes RA velocity at the celestial equator', () => {
		const estimate = estimateDarvExposure(darvInput({ declination: 0, preset: { targetTrail: 1, detectableSeparation: 1, targetPolarError: 10, guideRateSidereal: 1 } }))

		expect(estimate.raVelocity).toBeCloseTo(SIDEREAL_RATE, 12)
	})

	test('exposure increases for smaller detectable polar error', () => {
		const common = { targetTrail: 1, detectableSeparation: 3, guideRateSidereal: 1 }
		const coarse = estimateDarvExposure(darvInput({ preset: { ...common, targetPolarError: 10 } }))
		const fine = estimateDarvExposure(darvInput({ preset: { ...common, targetPolarError: 2 } }))

		expect(fine.driftDetectionTime).toBeGreaterThan(fine.raTrailTime)
		expect(fine.recommendedExposure).toBeGreaterThan(coarse.recommendedExposure)
	})

	test('exposure increases for shorter focal length', () => {
		const shortFocal = estimateDarvExposure(darvInput({ focalLength: 500 }))
		const longFocal = estimateDarvExposure(darvInput({ focalLength: 2000 }))

		expect(shortFocal.imageScale).toBeGreaterThan(longFocal.imageScale)
		expect(shortFocal.recommendedExposure).toBeGreaterThan(longFocal.recommendedExposure)
	})

	test('computes azimuth mode geometry factor on the meridian, where it peaks', () => {
		const estimate = estimateDarvExposure(darvInput({ latitude: deg(60), mode: 'azimuth', hourAngle: 0 }))

		expect(estimate.geometryFactor).toBeCloseTo(Math.abs(Math.cos(deg(60))), 12)
	})

	test('computes altitude mode geometry factor six hours out, where it peaks', () => {
		const estimate = estimateDarvExposure(darvInput({ latitude: deg(60), mode: 'altitude', hourAngle: hour(6) }))

		expect(estimate.geometryFactor).toBeCloseTo(1, 12)
	})

	test('follows the hour angle each mode actually drifts with', () => {
		// The two modes peak at opposite ends of the sky, which is why drift alignment asks for a star
		// near the meridian to set azimuth and one near the horizon to set altitude. Verified against the
		// mount simulator, whose pointing model reproduces these factors to five significant figures.
		for (const [hourAngleHours, azimuth, altitude] of [
			[0, 1, 0],
			[2, Math.cos(hour(2)), Math.sin(hour(2))],
			[4, Math.cos(hour(4)), Math.sin(hour(4))],
			[6, 0, 1],
		] as const) {
			const hourAngle = hour(hourAngleHours)
			const latitude = deg(45)

			expect(estimateDarvExposure(darvInput({ latitude, mode: 'azimuth', hourAngle: hourAngle + 1e-6 })).geometryFactor).toBeCloseTo(Math.cos(latitude) * azimuth, 5)
			expect(estimateDarvExposure(darvInput({ latitude, mode: 'altitude', hourAngle: hourAngle + 1e-6 })).geometryFactor).toBeCloseTo(altitude, 5)
		}
	})

	test('is symmetric about the meridian, since DARV shows a separation either way', () => {
		const east = estimateDarvExposure(darvInput({ mode: 'altitude', hourAngle: hour(-4) }))
		const west = estimateDarvExposure(darvInput({ mode: 'altitude', hourAngle: hour(4) }))

		expect(east.geometryFactor).toBeCloseTo(west.geometryFactor, 12)
		expect(east.geometryFactor).toBeGreaterThan(0)
	})

	test('rejects invalid DARV geometries', () => {
		expect(() => estimateDarvExposure(darvInput({ declination: deg(90) }))).toThrow('stars too close to the celestial pole')
		expect(() => estimateDarvExposure(darvInput({ latitude: deg(90), mode: 'azimuth', hourAngle: 0 }))).toThrow('DARV DEC drift is too small')
	})

	test('rejects a star in the wrong part of the sky for the mode', () => {
		// The failure the hour angle was added to expose. Both of these used to return a confident
		// exposure for a star whose drift is identically zero in that mode.
		expect(() => estimateDarvExposure(darvInput({ mode: 'altitude', hourAngle: 0 }))).toThrow('DARV DEC drift is too small')
		expect(() => estimateDarvExposure(darvInput({ mode: 'azimuth', hourAngle: hour(6) }))).toThrow('DARV DEC drift is too small')
	})

	test('needs a longer exposure the further the star is from the ideal hour angle', () => {
		const ideal = estimateDarvExposure(darvInput({ mode: 'altitude', hourAngle: hour(6) }))
		const poor = estimateDarvExposure(darvInput({ mode: 'altitude', hourAngle: hour(1) }))

		expect(poor.driftDec).toBeLessThan(ideal.driftDec)
		expect(poor.recommendedExposure).toBeGreaterThan(ideal.recommendedExposure)
	})

	test('resolves built-in and custom presets', () => {
		const preset = { targetTrail: 10, detectableSeparation: 4, targetPolarError: 8, guideRateSidereal: 0.25 }
		const estimate = estimateDarvExposure(darvInput({ preset }))

		expect(estimate.raVelocity).toBeCloseTo(SIDEREAL_RATE * preset.guideRateSidereal, 12)
		expect(estimate.raTrailTime).toBeCloseTo((preset.targetTrail * estimate.imageScale) / estimate.raVelocity, 12)
		expect(estimate.driftDec).toBeCloseTo(0.004375 * preset.targetPolarError, 12)
	})
})
