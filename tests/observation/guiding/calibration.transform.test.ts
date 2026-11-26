import { describe, expect, test } from 'bun:test'
import { DEG2RAD } from '../../../src/core/constants'
import { effectiveGuidingCalibration, GUIDING_CALIBRATION_RECORD_VERSION, type GuidingCalibrationContext, type GuidingCalibrationRecord, rotateGuidingCalibration, scaleRightAscension, validateGuidingCalibrationRecord } from '../../../src/observation/guiding/calibration.transform'
import { flipGuidingCalibration, type GuidingCalibrationAxisSolution, type GuidingCalibrationResult } from '../../../src/observation/guiding/calibrator'
import { directionDecision } from '../../../src/observation/guiding/client'

// A calibration with RA along +X at 0.01 px/ms and DEC 80° from it at 0.008 px/ms.
function calibration(): GuidingCalibrationResult {
	const raAngle = 10 * DEG2RAD
	const decAngle = 90 * DEG2RAD
	const ra = axis(raAngle, 0.01)
	const dec = axis(decAngle, 0.008)
	const [m00, m01, m10, m11] = [ra.unitX * ra.ratePxPerMs, dec.unitX * dec.ratePxPerMs, ra.unitY * ra.ratePxPerMs, dec.unitY * dec.ratePxPerMs]
	const determinant = m00 * m11 - m01 * m10

	return {
		ra: { ...ra, direction: 'WEST' },
		dec: { ...dec, direction: 'NORTH' },
		imageMotion: [m00, m01, m10, m11],
		imageToAxis: [m11 / determinant, -m01 / determinant, -m10 / determinant, m00 / determinant],
		determinant,
		backlash: 0,
		startX: 100,
		startY: 100,
		decStartX: 100,
		decStartY: 100,
		clearingSteps: 0,
		decReturnSteps: 0,
		warnings: [],
		orthogonalAssumed: false,
		review: { raSamples: [], clearingSamples: [], decSamples: [], decReturnSamples: [], excludedSamples: [], phaseHistory: ['completed'], measuredDec: dec, orthogonalityError: 10 * DEG2RAD },
	}
}

function axis(angle: number, ratePxPerMs: number): GuidingCalibrationAxisSolution {
	return { unitX: Math.cos(angle), unitY: Math.sin(angle), ratePxPerMs, totalTravelPx: 20, totalPulse: 20 / ratePxPerMs, angle, rmsOrthogonalResidualPx: 0.1, negativeProjectionCount: 0 }
}

function record(context: GuidingCalibrationContext): GuidingCalibrationRecord {
	return { version: GUIDING_CALIBRATION_RECORD_VERSION, calibration: calibration(), context, acquiredAt: 1_700_000_000_000 }
}

const OPTIONS = { declinationCompensation: true, reverseDecOutputAfterMeridianFlip: false }

function expectInverse(result: GuidingCalibrationResult) {
	const [a, b, c, d] = result.imageMotion
	const [p, q, r, s] = result.imageToAxis
	expect(p * a + q * c).toBeCloseTo(1, 12)
	expect(p * b + q * d).toBeCloseTo(0, 12)
	expect(r * a + s * c).toBeCloseTo(0, 12)
	expect(r * b + s * d).toBeCloseTo(1, 12)
}

describe('effective calibration', () => {
	test('applies the source directly in the same context', () => {
		const source = record({ declination: 10 * DEG2RAD, pierSide: 'EAST' })
		const result = effectiveGuidingCalibration(source, { declination: 10.2 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)
		expect(result.status).toBe('direct')
		if (result.status !== 'direct') return
		expect(result.calibration).toBe(source.calibration)
		expect(result.transformations).toEqual([])
		expect(result.declinationScale).toBe(1)
	})

	test('scales only the RA response by the ratio of the declination cosines', () => {
		const source = record({ declination: 0, pierSide: 'WEST' })
		const result = effectiveGuidingCalibration(source, { declination: 60 * DEG2RAD, pierSide: 'WEST' }, OPTIONS)
		expect(result.status).toBe('transformed')
		if (result.status !== 'transformed') return

		const original = source.calibration
		expect(result.transformations).toEqual(['declinationCompensation'])
		expect(result.declinationScale).toBeCloseTo(0.5, 12)
		expect(result.calibration.ra.ratePxPerMs).toBeCloseTo(original.ra.ratePxPerMs * 0.5, 12)
		expect(result.calibration.imageMotion[0]).toBeCloseTo(original.imageMotion[0] * 0.5, 12)
		expect(result.calibration.imageMotion[2]).toBeCloseTo(original.imageMotion[2] * 0.5, 12)
		expect(result.calibration.imageMotion[1]).toBe(original.imageMotion[1])
		expect(result.calibration.imageMotion[3]).toBe(original.imageMotion[3])
		expect(result.calibration.dec).toEqual(original.dec)
		expect(result.calibration.ra.unitX).toBe(original.ra.unitX)
		expectInverse(result.calibration)
		// The source is left untouched.
		expect(source.calibration.ra.ratePxPerMs).toBe(0.01)
	})

	test('derives every context from the source, so transformations never accumulate', () => {
		const source = record({ declination: 5 * DEG2RAD, pierSide: 'EAST' })
		const throughA = effectiveGuidingCalibration(source, { declination: 40 * DEG2RAD, pierSide: 'WEST' }, OPTIONS)
		const direct = effectiveGuidingCalibration(source, { declination: 50 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)
		const throughB = effectiveGuidingCalibration(source, { declination: 50 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)
		expect(throughA.status).toBe('transformed')
		expect(direct).toEqual(throughB)

		const back = effectiveGuidingCalibration(source, { declination: 5 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)
		expect(back.status).toBe('direct')
	})

	test('flips once for the other side of the pier, then scales, in either order the same', () => {
		const source = record({ declination: 0, pierSide: 'EAST' })
		const result = effectiveGuidingCalibration(source, { declination: 45 * DEG2RAD, pierSide: 'WEST' }, OPTIONS)
		expect(result.status).toBe('transformed')
		if (result.status !== 'transformed') return

		const original = source.calibration
		const scale = Math.cos(45 * DEG2RAD)
		expect(result.transformations).toEqual(['pierFlip', 'declinationCompensation'])
		expect(result.calibration.imageMotion[0]).toBeCloseTo(-original.imageMotion[0] * scale, 12)
		expect(result.calibration.imageMotion[1]).toBeCloseTo(-original.imageMotion[1], 12)
		expect(result.calibration.ra.direction).toBe('WEST')
		expect(result.calibration.dec.direction).toBe('NORTH')
		expectInverse(result.calibration)

		const reversed = effectiveGuidingCalibration(source, { declination: 45 * DEG2RAD, pierSide: 'WEST' }, { ...OPTIONS, reverseDecOutputAfterMeridianFlip: true })
		if (reversed.status !== 'transformed') throw new Error('not transformed')
		expect(reversed.calibration.imageMotion[1]).toBeCloseTo(original.imageMotion[1], 12)
		expect(reversed.calibration.dec.direction).toBe('SOUTH')
	})

	test('skips the declination without compensation', () => {
		const source = record({ pierSide: 'EAST' })
		const result = effectiveGuidingCalibration(source, { declination: 70 * DEG2RAD, pierSide: 'EAST' }, { ...OPTIONS, declinationCompensation: false })
		expect(result.status).toBe('direct')
	})

	test('refuses an unknown side of the pier or declination as insufficient evidence', () => {
		expect(effectiveGuidingCalibration(record({ declination: 0 }), { declination: 0, pierSide: 'EAST' }, OPTIONS)).toEqual({ status: 'insufficientEvidence', reasons: ['pierSideUnknown'] })
		expect(effectiveGuidingCalibration(record({ declination: 0, pierSide: 'NEITHER' }), { declination: 0, pierSide: 'NEITHER' }, OPTIONS)).toEqual({ status: 'insufficientEvidence', reasons: ['pierSideUnknown'] })
		expect(effectiveGuidingCalibration(record({ pierSide: 'EAST' }), { declination: 0, pierSide: 'EAST' }, OPTIONS)).toEqual({ status: 'insufficientEvidence', reasons: ['declinationUnknown'] })
		expect(effectiveGuidingCalibration(record({ declination: 0, pierSide: 'EAST' }), { pierSide: 'EAST' }, OPTIONS)).toEqual({ status: 'insufficientEvidence', reasons: ['declinationUnknown'] })
	})

	test('requires a new calibration near the pole', () => {
		expect(effectiveGuidingCalibration(record({ declination: 70 * DEG2RAD, pierSide: 'EAST' }), { declination: 10 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)).toEqual({ status: 'requiresRecalibration', reasons: ['sourceNearPole'] })
		expect(effectiveGuidingCalibration(record({ declination: 0, pierSide: 'EAST' }), { declination: -88 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)).toEqual({ status: 'requiresRecalibration', reasons: ['declinationNearPole'] })
		// Calibrated high, guided at the same declination: nothing to scale.
		expect(effectiveGuidingCalibration(record({ declination: 70 * DEG2RAD, pierSide: 'EAST' }), { declination: 70 * DEG2RAD, pierSide: 'EAST' }, OPTIONS).status).toBe('direct')
	})

	test('refuses an RA rate scaled below the calibrator minimum', () => {
		const slow = { ...record({ declination: 0, pierSide: 'EAST' }) }
		const tiny = scaleRightAscension(slow.calibration, 0.015)
		const result = effectiveGuidingCalibration({ ...slow, calibration: tiny }, { declination: 84 * DEG2RAD, pierSide: 'EAST' }, OPTIONS)
		expect(result).toEqual({ status: 'requiresRecalibration', reasons: ['rateTooSmall'] })
	})
})

describe('rotation of the guide image', () => {
	const TURNING = { ...OPTIONS, rotation: { kind: 'turning' } } as const
	const SOURCE = { declination: 10 * DEG2RAD, pierSide: 'EAST', rotatorAngle: 100 } as const

	test('a rotation of zero is the identity and keeps the inverse consistent', () => {
		const source = calibration()
		const rotated = rotateGuidingCalibration(source, 0)
		expect(rotated.imageMotion.map((value, i) => value - source.imageMotion[i])).toEqual([0, 0, 0, 0])
		expectInverse(rotateGuidingCalibration(source, 37 * DEG2RAD))
	})

	test('both axes turn by the angle, rates and determinant kept, and the record stays valid', () => {
		const source = calibration()
		const rotated = rotateGuidingCalibration(source, 30 * DEG2RAD)
		expect(rotated.ra.angle).toBeCloseTo(40 * DEG2RAD, 12)
		expect(rotated.dec.angle).toBeCloseTo(120 * DEG2RAD, 12)
		expect(rotated.ra.ratePxPerMs).toBe(source.ra.ratePxPerMs)
		expect(rotated.determinant).toBeCloseTo(source.determinant, 15)
		expect(validateGuidingCalibrationRecord({ ...record(SOURCE), calibration: rotated }).ok).toBeTrue()
	})

	test('the rotation commutes with the pier flip and the RA scale', () => {
		const source = calibration()
		const angle = 25 * DEG2RAD
		const a = rotateGuidingCalibration(scaleRightAscension(flipGuidingCalibration(source), 0.7), angle)
		const b = scaleRightAscension(flipGuidingCalibration(rotateGuidingCalibration(source, angle)), 0.7)
		for (let i = 0; i < 4; i++) expect(a.imageMotion[i]).toBeCloseTo(b.imageMotion[i], 15)
	})

	test('a fixed guide image is never rotated, whatever the rotator did', () => {
		const result = effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, rotatorAngle: 170 }, { ...OPTIONS, rotation: { kind: 'fixed' } })
		expect(result).toMatchObject({ status: 'direct', rotatorChange: 0 })
		expect(effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, rotatorAngle: 170 }, OPTIONS)).toMatchObject({ status: 'direct', rotatorChange: 0 })
	})

	test('an unknown rotator angle on either end is refused as insufficient evidence', () => {
		expect(effectiveGuidingCalibration(record({ ...SOURCE, rotatorAngle: undefined }), SOURCE, TURNING)).toEqual({ status: 'insufficientEvidence', reasons: ['rotatorAngleUnknown'] })
		expect(effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, rotatorAngle: undefined }, TURNING)).toEqual({ status: 'insufficientEvidence', reasons: ['rotatorAngleUnknown'] })
	})

	test('a small rotation is applied with a known sense and left out with an unknown one, never checked', () => {
		const known = effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, rotatorAngle: 105 }, { ...OPTIONS, rotation: { kind: 'turning', sense: -1 } })
		expect(known).toMatchObject({ status: 'transformed', transformations: ['rotation'], rotatorChange: 5 })
		if (known.status !== 'transformed') return
		expect(known.directionCheck).toBeUndefined()
		expect(known.calibration.ra.angle).toBeCloseTo(5 * DEG2RAD, 12)

		const unknown = effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, rotatorAngle: 105 }, TURNING)
		expect(unknown).toMatchObject({ status: 'direct', rotatorChange: 0 })
	})

	test('a large rotation offers both senses for a direction check, the known one first, through the 0°/360° wrap', () => {
		const unknown = effectiveGuidingCalibration(record({ ...SOURCE, rotatorAngle: 350 }), { ...SOURCE, rotatorAngle: 30 }, TURNING)
		expect(unknown).toMatchObject({ status: 'transformed', rotatorChange: 40 })
		if (unknown.status !== 'transformed') return
		expect(unknown.directionCheck!.map(({ sense }) => sense)).toEqual([1, -1])
		expect(unknown.calibration).toBe(unknown.directionCheck![0].calibration)
		expect(unknown.directionCheck![0].calibration.ra.angle).toBeCloseTo(50 * DEG2RAD, 12)
		expect(unknown.directionCheck![1].calibration.ra.angle).toBeCloseTo(-30 * DEG2RAD, 12)

		const known = effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, rotatorAngle: 60 }, { ...OPTIONS, rotation: { kind: 'turning', sense: -1 } })
		expect(known).toMatchObject({ status: 'transformed', rotatorChange: -40 })
		if (known.status !== 'transformed') return
		expect(known.directionCheck!.map(({ sense }) => sense)).toEqual([-1, 1])
		expect(known.calibration.ra.angle).toBeCloseTo(50 * DEG2RAD, 12)
	})

	test('a pier flip and a rotation apply together', () => {
		const result = effectiveGuidingCalibration(record(SOURCE), { ...SOURCE, pierSide: 'WEST', rotatorAngle: 110 }, { ...OPTIONS, rotation: { kind: 'turning', sense: 1 } })
		expect(result).toMatchObject({ status: 'transformed', transformations: ['pierFlip', 'rotation'] })
	})

	test('a stored record with a non-finite rotator angle is invalid', () => {
		expect(validateGuidingCalibrationRecord({ ...record(SOURCE), context: { ...SOURCE, rotatorAngle: Number.NaN } }).ok).toBeFalse()
	})
})

describe('direction decision', () => {
	const source = calibration()
	const candidates = [
		{ sense: 1, calibration: rotateGuidingCalibration(source, 40 * DEG2RAD) },
		{ sense: -1, calibration: rotateGuidingCalibration(source, -40 * DEG2RAD) },
	] as const

	test('chooses the candidate the star moved along, at the calibrated rate', () => {
		const angle = -30 * DEG2RAD
		const decision = directionDecision(candidates, 8 * Math.cos(angle), 8 * Math.sin(angle), 800)
		expect(decision.chosen?.sense).toBe(-1)
		expect(decision.angleError).toBeCloseTo(0, 6)
		expect(decision.rateRatio).toBeCloseTo(1, 6)
	})

	test('refuses a direction near neither, a rate far off, and no motion', () => {
		expect(directionDecision(candidates, 0, -8, 800).chosen).toBeUndefined()
		const angle = 50 * DEG2RAD
		expect(directionDecision(candidates, 3 * Math.cos(angle), 3 * Math.sin(angle), 800).message).toContain('rate')
		expect(directionDecision(candidates, 0, 0, 800).message).toContain('did not move')
	})

	test('refuses when both candidates are too close to tell apart', () => {
		const close = [
			{ sense: 1, calibration: rotateGuidingCalibration(source, 5 * DEG2RAD) },
			{ sense: -1, calibration: rotateGuidingCalibration(source, -5 * DEG2RAD) },
		] as const
		expect(directionDecision(close, 8 * Math.cos(15 * DEG2RAD), 8 * Math.sin(15 * DEG2RAD), 800).chosen).toBeUndefined()
	})
})

describe('record validation', () => {
	test('accepts a record that went through JSON', () => {
		const source = record({ declination: 12 * DEG2RAD, pierSide: 'WEST' })
		const parsed = validateGuidingCalibrationRecord(JSON.parse(JSON.stringify(source)))
		expect(parsed.ok).toBeTrue()
		if (parsed.ok) expect(parsed.record).toEqual(source)
	})

	test('accepts a transformed calibration', () => {
		const source = record({ declination: 0, pierSide: 'EAST' })
		const result = effectiveGuidingCalibration(source, { declination: 50 * DEG2RAD, pierSide: 'WEST' }, OPTIONS)
		if (result.status !== 'transformed') throw new Error('not transformed')
		expect(validateGuidingCalibrationRecord({ ...source, calibration: result.calibration }).ok).toBeTrue()
	})

	test('rejects records that would guide wrongly', () => {
		const source = record({ declination: 0, pierSide: 'EAST' })
		const { calibration } = source
		const cases: unknown[] = [
			undefined,
			{ ...source, version: 2 },
			{ ...source, context: { declination: 4 } },
			{ ...source, context: { pierSide: 'NORTH' } },
			{ ...source, calibration: { ...calibration, ra: { ...calibration.ra, ratePxPerMs: 0 } } },
			{ ...source, calibration: { ...calibration, ra: { ...calibration.ra, unitX: 2 } } },
			{ ...source, calibration: { ...calibration, dec: { ...calibration.dec, direction: 'WEST' } } },
			{ ...source, calibration: { ...calibration, imageMotion: [1, 0, 0] } },
			{ ...source, calibration: { ...calibration, imageMotion: [...calibration.imageMotion.slice(0, 3), Number.NaN] } },
			{ ...source, calibration: { ...calibration, imageToAxis: [1, 0, 0, 1] } },
			{ ...source, calibration: { ...calibration, determinant: 1 } },
			{ ...source, calibration: { ...calibration, review: { ...calibration.review, raSamples: [{ leg: 'sideways' }] } } },
			{ ...source, calibration: { ...calibration, orthogonalAssumed: 'no' } },
		]

		for (const value of cases) expect(validateGuidingCalibrationRecord(value).ok).toBeFalse()
	})
})
