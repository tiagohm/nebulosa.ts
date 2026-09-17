import { describe, expect, test } from 'bun:test'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI, SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import { type Vec3, vecCross, vecNormalize, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { arcmin, arcsec, deg, toArcsec } from '../../../src/math/units/angle'
// oxfmt-ignore
import { DEFAULT_POLAR_ALIGNMENT_MAX_TRAIL, polarAlignmentExposureLimit, polarAlignmentExposureLimitForResult, polarAlignmentFieldRadius, polarAlignmentGuidedFieldRotationRate, polarAlignmentImageScale, polarAlignmentResidualAngularVelocity, polarAlignmentUnguidedDriftRate, polarAlignmentWorstCaseDriftRate } from '../../../src/observation/alignment/polaralignment.exposure'
import { applyMountAdjustment, celestialPoleVector } from '../../../src/observation/alignment/polaralignment.util'

const POLE = [0, 0, 1] as const
const IMAGE_SCALE = arcsec(1)

function mountWithError(error = arcmin(5)): Vec3 {
	return [Math.sin(error), 0, Math.cos(error)]
}

function determinant(a: Vec3, b: Vec3, c: Vec3): number {
	return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
}

describe('polar-alignment instantaneous rates', () => {
	test('returns zero for perfect alignment and preserves inputs', () => {
		const mount = [0, 0, 4] as const
		const pole = [0, 0, 2] as const
		const mountBefore = [...mount]
		const poleBefore = [...pole]

		expect(polarAlignmentResidualAngularVelocity(mount, pole)).toEqual([0, 0, 0])
		expect(polarAlignmentWorstCaseDriftRate(mount, pole)).toBe(0)
		expect([...mount]).toEqual(mountBefore)
		expect([...pole]).toEqual(poleBefore)
	})

	test('normalizes vectors and computes the residual angular-velocity components', () => {
		const error = arcmin(5)
		const mount = mountWithError(error)
		const residual = polarAlignmentResidualAngularVelocity([mount[0] * 3, 0, mount[2] * 3], [0, 0, 7])

		expect(residual[0]).toBeCloseTo(-SIDEREAL_DRIFT_RATE * Math.sin(error), 15)
		expect(residual[1]).toBe(0)
		expect(residual[2]).toBeCloseTo(SIDEREAL_DRIFT_RATE * (1 - Math.cos(error)), 15)
	})

	test('matches the exact worst-case expression and the five-arcminute reference', () => {
		const error = arcmin(5)
		const rate = polarAlignmentWorstCaseDriftRate(mountWithError(error), POLE)

		expect(rate).toBeCloseTo(2 * SIDEREAL_DRIFT_RATE * Math.sin(error / 2), 15)
		expect(toArcsec(rate)).toBeCloseTo(0.021875, 5)
	})

	test('depends on target orientation and is symmetric for opposite targets', () => {
		const mount = mountWithError()
		const residualDirection = vecNormalize([POLE[0] - mount[0], POLE[1] - mount[1], POLE[2] - mount[2]])
		const perpendicular = vecNormalize(vecCross(residualDirection, [0, 1, 0]))
		const maximum = polarAlignmentWorstCaseDriftRate(mount, POLE)

		expect(polarAlignmentUnguidedDriftRate(mount, POLE, residualDirection)).toBeLessThan(maximum * 1e-7)
		expect(polarAlignmentUnguidedDriftRate(mount, POLE, perpendicular)).toBeCloseTo(maximum, 14)
		expect(polarAlignmentUnguidedDriftRate(mount, POLE, perpendicular)).toBeCloseTo(polarAlignmentUnguidedDriftRate(mount, POLE, [-perpendicular[0], -perpendicular[1], -perpendicular[2]]), 15)
	})

	test('rejects zero and non-finite directions', () => {
		expect(() => polarAlignmentWorstCaseDriftRate([0, 0, 0], POLE)).toThrow(RangeError)
		expect(() => polarAlignmentWorstCaseDriftRate([Number.NaN, 0, 1], POLE)).toThrow(RangeError)
		expect(() => polarAlignmentUnguidedDriftRate(POLE, POLE, [0, Number.POSITIVE_INFINITY, 1])).toThrow(RangeError)
	})
})

describe('guided polar-alignment field rotation', () => {
	test('matches an independent three-axis linear-system solution', () => {
		for (const [mount, guide] of [
			[vecNormalize([0.03, -0.02, 1]), vecNormalize([0.7, 0.2, 0.3])],
			[vecNormalize([-0.08, 0.01, 1]), vecNormalize([-0.4, 0.8, 0.2])],
			[vecNormalize([0.04, 0.07, -1]), vecNormalize([0.6, -0.2, -0.4])],
		] as const) {
			const declinationAxis = vecNormalize(vecCross(mount, guide))
			const negativeMount = [-mount[0], -mount[1], -mount[2]] as const
			const negativeDeclination = [-declinationAxis[0], -declinationAxis[1], -declinationAxis[2]] as const
			const earth = [SIDEREAL_DRIFT_RATE * POLE[0], SIDEREAL_DRIFT_RATE * POLE[1], SIDEREAL_DRIFT_RATE * POLE[2]] as const
			const expected = determinant(earth, negativeMount, negativeDeclination) / determinant(guide, negativeMount, negativeDeclination)

			expect(polarAlignmentGuidedFieldRotationRate(mount, POLE, guide)).toBeCloseTo(expected, 14)
		}
	})

	test('returns zero when aligned and undefined near the RA-axis singularity', () => {
		expect(polarAlignmentGuidedFieldRotationRate(POLE, POLE, [1, 0, 0])).toBeCloseTo(0, 15)
		expect(polarAlignmentGuidedFieldRotationRate(mountWithError(), POLE, mountWithError())).toBeUndefined()
	})
})

describe('polar-alignment exposure limits', () => {
	test('returns unlimited exposures for perfect alignment', () => {
		const result = polarAlignmentExposureLimit({ mountPole: POLE, celestialPole: POLE, imageScale: IMAGE_SCALE, target: [1, 0, 0], guiding: { guide: [1, 0, 0], fieldRadius: deg(1) } })

		expect(result.polarError).toBe(0)
		expect(result.maxTrail).toBe(DEFAULT_POLAR_ALIGNMENT_MAX_TRAIL)
		expect(result.unguided.worstCase).toBe(Number.POSITIVE_INFINITY)
		expect(result.unguided.target).toBe(Number.POSITIVE_INFINITY)
		expect(result.guided?.exposure).toBe(Number.POSITIVE_INFINITY)
	})

	test('reproduces the five-arcminute worst-case exposure', () => {
		const result = polarAlignmentExposureLimit({ mountPole: mountWithError(), celestialPole: POLE, imageScale: IMAGE_SCALE })
		const exact = (IMAGE_SCALE * 0.5) / (2 * SIDEREAL_DRIFT_RATE * Math.sin(arcmin(5) / 2))

		expect(result.unguided.worstCase).toBeCloseTo(exact, 2)
		expect(result.unguided.worstCase).toBeCloseTo(22.86, 1)
	})

	test('does not report infinity when the initial target drift is zero but later grows', () => {
		const mount = mountWithError()
		const target = vecNormalize([POLE[0] - mount[0], POLE[1] - mount[1], POLE[2] - mount[2]])
		const result = polarAlignmentExposureLimit({ mountPole: mount, celestialPole: POLE, imageScale: IMAGE_SCALE, target, searchLimit: 20_000 })

		expect(result.unguided.targetRate).toBeLessThan(1e-14)
		expect(result.unguided.target).toBeFinite()
		expect(result.unguided.target).toBeGreaterThan(result.unguided.worstCase)
	})

	test('scales with image scale and maximum trail', () => {
		const input = { mountPole: mountWithError(), celestialPole: POLE, target: [0, 1, 0] as const }
		const base = polarAlignmentExposureLimit({ ...input, imageScale: IMAGE_SCALE, maxTrail: 0.5 })
		const doubleScale = polarAlignmentExposureLimit({ ...input, imageScale: 2 * IMAGE_SCALE, maxTrail: 0.5 })
		const doubleTrail = polarAlignmentExposureLimit({ ...input, imageScale: IMAGE_SCALE, maxTrail: 1 })

		expect(doubleScale.unguided.worstCase / base.unguided.worstCase).toBeCloseTo(2, 3)
		expect(doubleTrail.unguided.worstCase / base.unguided.worstCase).toBeCloseTo(2, 3)
		expect(doubleScale.unguided.target! / base.unguided.target!).toBeCloseTo(2, 2)
	})

	test('returns infinity when the threshold is not reached within searchLimit', () => {
		const result = polarAlignmentExposureLimit({ mountPole: mountWithError(arcsec(0.01)), celestialPole: POLE, imageScale: IMAGE_SCALE, searchLimit: 1 })
		expect(result.unguided.worstCase).toBe(Number.POSITIVE_INFINITY)
	})

	test('marks singular guiding and handles a zero-radius field', () => {
		const mount = mountWithError()
		const singular = polarAlignmentExposureLimit({ mountPole: mount, celestialPole: POLE, imageScale: IMAGE_SCALE, guiding: { guide: mount, fieldRadius: deg(1) } })
		const centered = polarAlignmentExposureLimit({ mountPole: mount, celestialPole: POLE, imageScale: IMAGE_SCALE, guiding: { guide: [1, 0, 0], fieldRadius: 0 } })

		expect(singular.guided).toEqual({ rotationRate: 0, fieldRadius: deg(1), singular: true })
		expect(centered.guided?.singular).toBeFalse()
		expect(centered.guided?.exposure).toBe(Number.POSITIVE_INFINITY)
	})

	test('decreases guided exposure as field radius increases', () => {
		const input = { mountPole: mountWithError(deg(2)), celestialPole: POLE, imageScale: IMAGE_SCALE }
		const small = polarAlignmentExposureLimit({ ...input, guiding: { guide: [1, 0, 0], fieldRadius: deg(0.5) } })
		const large = polarAlignmentExposureLimit({ ...input, guiding: { guide: [1, 0, 0], fieldRadius: deg(1) } })

		expect(small.guided?.exposure).toBeFinite()
		expect(large.guided?.exposure).toBeLessThan(small.guided!.exposure!)
		expect(small.guided!.exposure! / large.guided!.exposure!).toBeCloseTo(2, 1)
	})

	test('scales guided exposure with image scale and maximum trail', () => {
		const common = { mountPole: mountWithError(deg(2)), celestialPole: POLE, guiding: { guide: [1, 0, 0] as const, fieldRadius: deg(1) } }
		const base = polarAlignmentExposureLimit({ ...common, imageScale: IMAGE_SCALE, maxTrail: 0.5 })
		const doubleScale = polarAlignmentExposureLimit({ ...common, imageScale: 2 * IMAGE_SCALE, maxTrail: 0.5 })
		const doubleTrail = polarAlignmentExposureLimit({ ...common, imageScale: IMAGE_SCALE, maxTrail: 1 })

		expect(doubleScale.guided!.exposure! / base.guided!.exposure!).toBeCloseTo(2, 2)
		expect(doubleTrail.guided!.exposure! / base.guided!.exposure!).toBeCloseTo(2, 2)
	})

	test('supports pure and combined mount adjustments in both hemispheres', () => {
		for (const sign of [1, -1]) {
			const pole = [0, 0, sign] as const
			const up = [sign, 0, 0] as const
			const east = [0, 1, 0] as const
			for (const [azimuth, altitude] of [
				[arcmin(5), 0],
				[0, arcmin(5)],
				[arcmin(3), arcmin(-4)],
			] as const) {
				const mount = applyMountAdjustment(pole, up, east, azimuth, altitude)
				const result = polarAlignmentExposureLimit({ mountPole: mount, celestialPole: pole, imageScale: IMAGE_SCALE })
				expect(result.polarError).toBeCloseTo(Math.hypot(azimuth, altitude), 5)
				expect(result.unguided.worstCase).toBeFinite()
			}
		}
	})

	test('rejects invalid scalar inputs and field radii', () => {
		const base = { mountPole: mountWithError(), celestialPole: POLE, imageScale: IMAGE_SCALE }
		expect(() => polarAlignmentExposureLimit({ ...base, guiding: { guide: [1, 0, 0], fieldRadius: -1 } })).toThrow(RangeError)
		expect(() => polarAlignmentExposureLimit({ ...base, guiding: { guide: [1, 0, 0], fieldRadius: PI + 1 } })).toThrow(RangeError)
	})
})

describe('polar-alignment exposure helpers', () => {
	test('computes optical image scale and sensor-corner field radius', () => {
		const imageScale = polarAlignmentImageScale(3.75, 1000)
		const radius = polarAlignmentFieldRadius(4000, 3000, imageScale)

		expect(toArcsec(imageScale)).toBeCloseTo(0.773493, 5)
		expect(radius).toBeCloseTo(Math.atan(2500 * Math.tan(imageScale)), 15)
	})

	test('uses the geometric celestial pole from a three-point result', () => {
		const time = timeYMDHMS(2025, 1, 1, 0, 0, 0)
		const location = geodeticLocation(deg(-45), deg(-23), 0)
		time.location = location
		const pole = celestialPoleVector(time, location, false)
		const mount = vecRotateByRodrigues(pole, [1, 0, 0], arcmin(5))
		const direct = polarAlignmentExposureLimit({ mountPole: mount, celestialPole: pole, imageScale: IMAGE_SCALE })
		const convenience = polarAlignmentExposureLimitForResult({ alignment: { pole: mount, time }, imageScale: IMAGE_SCALE })

		expect(convenience.polarError).toBeCloseTo(direct.polarError, 14)
		expect(convenience.unguided.worstCase).toBeCloseTo(direct.unguided.worstCase, 10)
	})
})
