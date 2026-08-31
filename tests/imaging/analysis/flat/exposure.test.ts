import { expect, test } from 'bun:test'
import { estimateFlatExposure } from '../../../../src/imaging/analysis/flat/exposure'

test('keeps an exposure whose current level is already inside the target', () => {
	const result = estimateFlatExposure({ observations: [{ exposure: 1, level: 100 }], levelMode: 'observed', targetRange: [90, 110], exposureRange: [0.1, 10] })
	expect(result).toMatchObject({ status: 'accepted', method: 'none', recommendedExposure: 1, predictedLevel: 100 })
})

test('uses a through-origin ratio only for positive corrected signal', () => {
	const result = estimateFlatExposure({ observations: [{ exposure: 1, level: 100 }], levelMode: 'corrected', targetRange: [190, 210], exposureRange: [0.1, 10] })
	expect(result).toMatchObject({ status: 'increase', method: 'ratio', recommendedExposure: 2, predictedLevel: 200 })

	const invalid = estimateFlatExposure({ observations: [{ exposure: 1, level: 0 }], levelMode: 'corrected', targetRange: [190, 210], exposureRange: [0.1, 10] })
	expect(invalid.status).toBe('invalid')
})

test('interpolates the closest positive-slope bracket regardless of pedestal', () => {
	const result = estimateFlatExposure({
		observations: [
			{ exposure: 0.5, level: 100 },
			{ exposure: 1.5, level: 300 },
		],
		levelMode: 'observed',
		targetRange: [190, 210],
		exposureRange: [0.1, 10],
	})
	expect(result).toMatchObject({ status: 'decrease', method: 'interpolation', recommendedExposure: 1, predictedLevel: 200 })
})

test('fits a positive affine pedestal model from distinct observed exposures', () => {
	const result = estimateFlatExposure({
		observations: [
			{ exposure: 1, level: 150 },
			{ exposure: 2, level: 250 },
		],
		levelMode: 'observed',
		targetRange: [340, 360],
		exposureRange: [0.1, 10],
	})
	expect(result).toMatchObject({ status: 'increase', method: 'affine', recommendedExposure: 3, predictedLevel: 350 })
})

test('rejects insufficient, contradictory, non-positive-slope, and unstable observed models', () => {
	const one = estimateFlatExposure({ observations: [{ exposure: 1, level: 100 }], levelMode: 'observed', targetRange: [190, 210], exposureRange: [0.1, 10] })
	expect(one.status).toBe('invalid')
	expect(one.diagnostics[0].code).toBe('insufficientSamples')

	const duplicate = estimateFlatExposure({
		observations: [
			{ exposure: 1, level: 100 },
			{ exposure: 1, level: 101 },
		],
		levelMode: 'observed',
		targetRange: [100, 102],
		exposureRange: [0.1, 10],
	})
	expect(duplicate.status).toBe('invalid')

	const decreasing = estimateFlatExposure({
		observations: [
			{ exposure: 1, level: 200 },
			{ exposure: 2, level: 100 },
		],
		levelMode: 'observed',
		targetRange: [290, 310],
		exposureRange: [0.1, 10],
	})
	expect(decreasing.status).toBe('invalid')

	const unstable = estimateFlatExposure({
		observations: [
			{ exposure: 1, level: 100 },
			{ exposure: 2, level: 300 },
			{ exposure: 3, level: 110 },
		],
		levelMode: 'observed',
		targetRange: [390, 410],
		exposureRange: [0.1, 10],
	})
	expect(unstable.status).toBe('invalid')
})

test('reports allowed-range bounds and limits each absolute exposure step', () => {
	const above = estimateFlatExposure({ observations: [{ exposure: 1, level: 100 }], levelMode: 'corrected', targetRange: [390, 410], exposureRange: [0.5, 3] })
	expect(above).toMatchObject({ status: 'aboveMaximum', method: 'ratio', recommendedExposure: 3, predictedLevel: 300 })

	const below = estimateFlatExposure({ observations: [{ exposure: 4, level: 400 }], levelMode: 'corrected', targetRange: [90, 110], exposureRange: [2, 10] })
	expect(below).toMatchObject({ status: 'belowMinimum', method: 'ratio', recommendedExposure: 2, predictedLevel: 200 })

	const stepped = estimateFlatExposure({ observations: [{ exposure: 1, level: 100 }], levelMode: 'corrected', targetRange: [390, 410], exposureRange: [0.5, 10], maximumStep: 0.5 })
	expect(stepped).toMatchObject({ status: 'increase', method: 'ratio', recommendedExposure: 1.5, predictedLevel: 150 })
})

test('returns invalid instead of exposing non-finite scalar input or predictions', () => {
	const result = estimateFlatExposure({ observations: [{ exposure: Number.NaN, level: 100 }], levelMode: 'corrected', targetRange: [90, 110], exposureRange: [0.1, 10] })
	expect(result).toEqual({ status: 'invalid', method: 'none', diagnostics: [expect.objectContaining({ code: 'targetUnavailable' })] })
})
