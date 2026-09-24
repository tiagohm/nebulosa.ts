import { expect, test } from 'bun:test'
import { DEG2RAD, PI, PIOVERTWO, TAU } from '../../../src/core/constants'
import { evaluateMountLimits } from '../../../src/observation/mount/limits'

test('linear cable wrap and circular azimuth are tested independently', () => {
	const limits = { hourAngle: [-1, 1] as const, declination: [-0.5, 0.5] as const, altitude: [0.2, 1.2] as const, azimuth: [350 * DEG2RAD, 10 * DEG2RAD] as const }
	expect(evaluateMountLimits({ hourAngle: 0, declination: 0, altitude: 0.5, azimuth: 0 }, limits).accepted).toBeTrue()
	expect(evaluateMountLimits({ hourAngle: 0, azimuth: 359 * DEG2RAD }, limits).accepted).toBeTrue()

	const outside = evaluateMountLimits({ hourAngle: 2, declination: 1, altitude: 0, azimuth: PI }, limits)
	expect(outside.accepted).toBeFalse()
	expect(outside.violations.map((violation) => violation.axis)).toEqual(['hourAngle', 'declination', 'altitude', 'azimuth'])
	expect(evaluateMountLimits({ azimuth: -PI }, { azimuth: [0, 3], azimuthWrap: 'linear' }).accepted).toBeFalse()
	expect(evaluateMountLimits({}, limits).accepted).toBeTrue()
})

test('a full-turn circular azimuth range accepts every direction without changing linear ranges', () => {
	for (const azimuth of [0, PIOVERTWO, PI, 1.5 * PI]) {
		expect(evaluateMountLimits({ azimuth }, { azimuth: [0, TAU] }).accepted).toBeTrue()
		expect(evaluateMountLimits({ azimuth }, { azimuth: [-PI, PI] }).accepted).toBeTrue()
	}
	expect(evaluateMountLimits({ azimuth: 0 }, { azimuth: [0, 0] }).accepted).toBeTrue()
	expect(evaluateMountLimits({ azimuth: PIOVERTWO }, { azimuth: [0, 0] }).accepted).toBeFalse()
	expect(evaluateMountLimits({ azimuth: TAU }, { azimuth: [0, TAU], azimuthWrap: 'linear' }).accepted).toBeTrue()
	expect(evaluateMountLimits({ azimuth: PIOVERTWO }, { azimuth: [0, 0], azimuthWrap: 'linear' }).accepted).toBeFalse()
})
