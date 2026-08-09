import { describe, expect, test } from 'bun:test'
import { ASEC2RAD, DEG2RAD, SIDEREAL_RATE } from '../../../src/core/constants'
import { flipGuidingCalibration, type GuidingCalibrationResult } from '../../../src/observation/guiding/calibrator'
import type { DitherOffset } from '../../../src/observation/guiding/dither'
import { type DitherGuideRateContext, ditherPulsePlanFromCalibration, ditherPulsePlanFromGuideRate } from '../../../src/observation/guiding/dither.pulse'

const RA_RATE_PX_PER_MS = 0.01
const DEC_RATE_PX_PER_MS = 0.008
const MAX_DURATION = 10000

function makeCalibration(raRate = RA_RATE_PX_PER_MS, decRate = DEC_RATE_PX_PER_MS): GuidingCalibrationResult {
	const ra = { unitX: 1, unitY: 0, ratePxPerMs: raRate, totalTravelPx: 100, totalPulse: 100 / raRate, angle: 0, rmsOrthogonalResidualPx: 0, negativeProjectionCount: 0, direction: 'WEST' } as const
	const dec = { unitX: 0, unitY: 1, ratePxPerMs: decRate, totalTravelPx: 80, totalPulse: 80 / decRate, angle: Math.PI / 2, rmsOrthogonalResidualPx: 0, negativeProjectionCount: 0, direction: 'NORTH' } as const
	const [m00, m01, m10, m11] = [ra.unitX * raRate, dec.unitX * decRate, ra.unitY * raRate, dec.unitY * decRate]
	const determinant = m00 * m11 - m01 * m10

	return {
		ra,
		dec,
		imageMotion: [m00, m01, m10, m11],
		imageToAxis: [m11 / determinant, -m01 / determinant, -m10 / determinant, m00 / determinant],
		determinant,
		backlash: 0,
		startX: 0,
		startY: 0,
		decStartX: 0,
		decStartY: 0,
		clearingSteps: 0,
		warnings: [],
	}
}

function offset(rightAscension: number, declination: number): DitherOffset {
	return { rightAscension, declination }
}

function makeGuideRateContext(overrides: Partial<DitherGuideRateContext> = {}): DitherGuideRateContext {
	return {
		guideRate: { rightAscension: 0.5, declination: 0.5 },
		declination: 0,
		rightAscensionDirection: 'WEST',
		declinationDirection: 'NORTH',
		...overrides,
	}
}

describe('from calibration', () => {
	test('divides the pixel offset by the calibrated rate', () => {
		const plan = ditherPulsePlanFromCalibration(offset(5, 4), makeCalibration(), MAX_DURATION)

		expect(plan?.rightAscension).toEqual({ direction: 'WEST', duration: 500 })
		expect(plan?.declination).toEqual({ direction: 'NORTH', duration: 500 })
	})

	test('reverses the direction for a negative offset', () => {
		const plan = ditherPulsePlanFromCalibration(offset(-5, -4), makeCalibration(), MAX_DURATION)

		expect(plan?.rightAscension).toEqual({ direction: 'EAST', duration: 500 })
		expect(plan?.declination).toEqual({ direction: 'SOUTH', duration: 500 })
	})

	test('omits an axis with a zero offset', () => {
		const plan = ditherPulsePlanFromCalibration(offset(5, 0), makeCalibration(), MAX_DURATION)

		expect(plan?.rightAscension).toBeDefined()
		expect(plan?.declination).toBeUndefined()
	})

	test('returns an empty plan when both axes are zero', () => {
		const plan = ditherPulsePlanFromCalibration(offset(0, 0), makeCalibration(), MAX_DURATION)

		expect(plan).toBeDefined()
		expect(plan?.rightAscension).toBeUndefined()
		expect(plan?.declination).toBeUndefined()
	})

	test('normalizes a fractional duration to whole milliseconds of at least one', () => {
		const plan = ditherPulsePlanFromCalibration(offset(0.00001, 0.0123), makeCalibration(), MAX_DURATION)

		expect(plan?.rightAscension?.duration).toBe(1)
		expect(plan?.declination?.duration).toBe(2)
	})

	test('rejects the whole plan when one axis exceeds the duration limit', () => {
		expect(ditherPulsePlanFromCalibration(offset(5, 400), makeCalibration(), MAX_DURATION)).toBeUndefined()
		expect(ditherPulsePlanFromCalibration(offset(5, 4), makeCalibration(), 499)).toBeUndefined()
	})

	test('rejects a non-positive or non-finite rate', () => {
		expect(ditherPulsePlanFromCalibration(offset(5, 4), makeCalibration(0, DEC_RATE_PX_PER_MS), MAX_DURATION)).toBeUndefined()
		expect(ditherPulsePlanFromCalibration(offset(5, 4), makeCalibration(RA_RATE_PX_PER_MS, Number.NaN), MAX_DURATION)).toBeUndefined()
	})

	test('ignores an invalid rate on an axis carrying no motion', () => {
		const plan = ditherPulsePlanFromCalibration(offset(5, 0), makeCalibration(RA_RATE_PX_PER_MS, 0), MAX_DURATION)

		expect(plan?.rightAscension).toEqual({ direction: 'WEST', duration: 500 })
	})

	test('follows the calibration through a meridian flip', () => {
		const flipped = flipGuidingCalibration(makeCalibration())
		const reversed = flipGuidingCalibration(makeCalibration(), true)

		expect(ditherPulsePlanFromCalibration(offset(5, 4), flipped, MAX_DURATION)?.declination).toEqual({ direction: 'NORTH', duration: 500 })
		expect(ditherPulsePlanFromCalibration(offset(5, 4), reversed, MAX_DURATION)?.declination).toEqual({ direction: 'SOUTH', duration: 500 })
	})
})

describe('from guide rate', () => {
	test('converts a sky angle at the sidereal rate', () => {
		const context = makeGuideRateContext({ guideRate: { rightAscension: 1, declination: 1 } })
		const plan = ditherPulsePlanFromGuideRate(offset(SIDEREAL_RATE * ASEC2RAD, SIDEREAL_RATE * ASEC2RAD), context, MAX_DURATION)

		expect(plan?.rightAscension).toEqual({ direction: 'WEST', duration: 1000 })
		expect(plan?.declination).toEqual({ direction: 'NORTH', duration: 1000 })
	})

	test('doubles the duration at half the sidereal rate', () => {
		const plan = ditherPulsePlanFromGuideRate(offset(SIDEREAL_RATE * ASEC2RAD, SIDEREAL_RATE * ASEC2RAD), makeGuideRateContext(), MAX_DURATION)

		expect(plan?.rightAscension?.duration).toBe(2000)
		expect(plan?.declination?.duration).toBe(2000)
	})

	test('scales the right ascension duration by the inverse cosine of the declination', () => {
		const context = makeGuideRateContext({ declination: 60 * DEG2RAD })
		const plan = ditherPulsePlanFromGuideRate(offset(SIDEREAL_RATE * ASEC2RAD, SIDEREAL_RATE * ASEC2RAD), context, MAX_DURATION)

		expect(plan?.rightAscension?.duration).toBe(4000)
		expect(plan?.declination?.duration).toBe(2000)
	})

	test('is unaffected by the sign of the declination', () => {
		const north = ditherPulsePlanFromGuideRate(offset(1e-4, 0), makeGuideRateContext({ declination: 45 * DEG2RAD }), MAX_DURATION)
		const south = ditherPulsePlanFromGuideRate(offset(1e-4, 0), makeGuideRateContext({ declination: -45 * DEG2RAD }), MAX_DURATION)

		expect(north?.rightAscension?.duration).toBe(south!.rightAscension!.duration)
	})

	test('honors the configured positive directions', () => {
		const context = makeGuideRateContext({ rightAscensionDirection: 'EAST', declinationDirection: 'SOUTH' })
		const plan = ditherPulsePlanFromGuideRate(offset(1e-4, -1e-4), context, MAX_DURATION)

		expect(plan?.rightAscension?.direction).toBe('EAST')
		expect(plan?.declination?.direction).toBe('NORTH')
	})

	test('rejects a zero, negative or non-finite guide rate on a moving axis', () => {
		expect(ditherPulsePlanFromGuideRate(offset(1e-4, 0), makeGuideRateContext({ guideRate: { rightAscension: 0, declination: 0.5 } }), MAX_DURATION)).toBeUndefined()
		expect(ditherPulsePlanFromGuideRate(offset(1e-4, 0), makeGuideRateContext({ guideRate: { rightAscension: -0.5, declination: 0.5 } }), MAX_DURATION)).toBeUndefined()
		expect(ditherPulsePlanFromGuideRate(offset(0, 1e-4), makeGuideRateContext({ guideRate: { rightAscension: 0.5, declination: Number.NaN } }), MAX_DURATION)).toBeUndefined()
	})

	test('rejects a right ascension dither at the pole', () => {
		const context = makeGuideRateContext({ declination: Math.PI / 2 })

		expect(ditherPulsePlanFromGuideRate(offset(1e-4, 0), context, MAX_DURATION)).toBeUndefined()
		expect(ditherPulsePlanFromGuideRate(offset(1e-4, 0), makeGuideRateContext({ declination: 89.9999 * DEG2RAD }), MAX_DURATION)).toBeUndefined()
	})

	test('still dithers in declination at the pole', () => {
		const plan = ditherPulsePlanFromGuideRate(offset(0, 1e-4), makeGuideRateContext({ declination: Math.PI / 2 }), MAX_DURATION)

		expect(plan?.declination).toBeDefined()
	})

	test('rejects a non-finite offset', () => {
		expect(ditherPulsePlanFromGuideRate(offset(Number.POSITIVE_INFINITY, 0), makeGuideRateContext(), MAX_DURATION)).toBeUndefined()
	})
})
