import { describe, expect, test } from 'bun:test'
import { DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters, refractedAltitude } from '../../../src/astronomy/coordinates/astrometry'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { vecAngleUnit, vecX, vecY, vecZ, vecZero } from '../../../src/math/linear-algebra/vec3'
import { arcmin, deg, hour, normalizePI, toArcmin } from '../../../src/math/units/angle'
import { applyInverseMountAdjustment, applyMountAdjustment, celestialPoleVector, convertPolarAlignmentAltitudeError, decomposePolarErrorGeodesic, mountAdjustmentAxes, polarAlignmentError, polarAlignmentReferenceAltitude } from '../../../src/observation/alignment/polaralignment'

// Creates a known current pole by inversely applying the correction that should recover the target.
function makeAdjustment(latitude: number, azimuth: number = arcmin(6), altitude: number = arcmin(-4)) {
	const location = geodeticLocation(deg(-45), latitude)
	const time = timeYMDHMS(2026, 7, 12, 2, 0, 0)
	time.location = location
	const targetPole = celestialPoleVector(time, location, false)
	const axes = mountAdjustmentAxes(time, location)
	const currentPole = applyInverseMountAdjustment(targetPole, axes.upAxis, axes.eastAxis, azimuth, altitude)
	return { targetPole, axes, currentPole, azimuth, altitude }
}

describe('polar altitude error references', () => {
	const atmospheres: readonly (RefractionParameters | false)[] = [false, DEFAULT_REFRACTION_PARAMETERS, { pressure: 750, temperature: -5, relativeHumidity: 0.3, wl: 0.6 }, { pressure: 0 }]

	for (const latitude of [-60, -30, -3, 0, 3, 30, 60].map(deg)) {
		test(`converts both pole altitudes and round-trips at latitude ${latitude}`, () => {
			for (const atmosphere of atmospheres) {
				expect(polarAlignmentReferenceAltitude(latitude, atmosphere)).toBe(atmosphere === false ? Math.abs(latitude) : refractedAltitude(Math.abs(latitude), atmosphere))
				for (const error of [-arcmin(30), 0, arcmin(30)]) {
					const displayed = convertPolarAlignmentAltitudeError(error, latitude, false, atmosphere)
					expect(Number.isFinite(displayed)).toBe(true)
					expect(convertPolarAlignmentAltitudeError(displayed, latitude, atmosphere, false)).toBeCloseTo(error, 13)
					if (atmosphere === false) expect(displayed).toBe(error)
				}
			}
			const error = arcmin(5)
			const defaultDisplay = convertPolarAlignmentAltitudeError(error, latitude)
			const customDisplay = convertPolarAlignmentAltitudeError(defaultDisplay, latitude, DEFAULT_REFRACTION_PARAMETERS, atmospheres[2])
			expect(customDisplay).toBeCloseTo(convertPolarAlignmentAltitudeError(error, latitude, false, atmospheres[2]), 13)
		})
	}
})

test('matches Ralph Pass two-star polar alignment reference example', () => {
	const latitude = deg(42 + 40 / 60)
	const lst = 0

	const azimuthError = arcmin(32.26)
	const altitudeError = arcmin(7.39)

	const star1 = [hour(3), deg(48)] as const
	const star2 = [hour(23), deg(45)] as const

	const actual1 = polarAlignmentError(star1[0], star1[1], latitude, lst, azimuthError, altitudeError)
	const actual2 = polarAlignmentError(star2[0], star2[1], latitude, lst, azimuthError, altitudeError)

	const readoutError1 = [normalizePI(star1[0] - actual1[0]), star1[1] - actual1[1]]
	const readoutError2 = [normalizePI(star2[0] - actual2[0]), star2[1] - actual2[1]]

	// Ralph Pass syncs on star 1, so only the differential readout error remains at star 2.
	const syncedRaError = normalizePI(readoutError2[0] - readoutError1[0])
	const syncedDecError = readoutError2[1] - readoutError1[1]

	expect(toArcmin(syncedRaError)).toBeCloseTo(-12, 2)
	expect(toArcmin(syncedDecError)).toBeCloseTo(-21, 2)
})

describe('mount adjustment geometry', () => {
	test('direct and inverse transformations recover arbitrary vectors', () => {
		const alignment = makeAdjustment(deg(35), deg(12), deg(-8))
		const vectors = [alignment.targetPole, [0.2, -0.7, 0.68] as const, [-0.8, 0.1, 0.55] as const]

		for (const vector of vectors) {
			const moved = applyMountAdjustment(vector, alignment.axes.upAxis, alignment.axes.eastAxis, alignment.azimuth, alignment.altitude)
			const recovered = applyInverseMountAdjustment(moved, alignment.axes.upAxis, alignment.axes.eastAxis, alignment.azimuth, alignment.altitude)
			expect(vecAngleUnit(vector, recovered)).toBeLessThan(1e-14)
		}
	})

	test('uses the altitude axis carried by the azimuth-rotated base', () => {
		const alignment = makeAdjustment(deg(-28), deg(30), deg(20))
		const corrected = applyMountAdjustment(alignment.currentPole, alignment.axes.upAxis, alignment.axes.eastAxis, alignment.azimuth, alignment.altitude)
		expect(vecAngleUnit(corrected, alignment.targetPole)).toBeLessThan(1e-14)
	})

	test('geodesic components preserve the exact total error magnitude', () => {
		const alignment = makeAdjustment(deg(42), arcmin(24), arcmin(-15))
		const components = decomposePolarErrorGeodesic(alignment.currentPole, alignment.targetPole, alignment.axes.upAxis, alignment.axes.eastAxis)
		expect(components).toBeDefined()
		if (!components) return
		expect(Math.hypot(components.azimuth, components.altitude)).toBeCloseTo(components.total, 12)
		expect(components.total).toBeCloseTo(vecAngleUnit(alignment.currentPole, alignment.targetPole), 12)
	})

	test('rejects degenerate public adjustment axes', () => {
		expect(() => applyMountAdjustment(vecX(), vecZero(), vecY(), 0, 0)).toThrow()
		expect(() => applyMountAdjustment(vecX(), vecY(), vecY(2), 0, 0)).toThrow()
		expect(() => applyMountAdjustment([Number.NaN, 0, 0], vecY(), vecZ(), 0, 0)).toThrow()
		expect(() => applyMountAdjustment([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], vecY(), vecZ(), 0, 0)).toThrow()
	})

	test('rejects the undefined antipodal spherical logarithm', () => {
		const alignment = makeAdjustment(deg(35))
		const antipode = [-alignment.targetPole[0], -alignment.targetPole[1], -alignment.targetPole[2]] as const
		expect(decomposePolarErrorGeodesic(antipode, alignment.targetPole, alignment.axes.upAxis, alignment.axes.eastAxis)).toBeUndefined()
	})
})
