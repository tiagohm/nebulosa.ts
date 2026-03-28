import { describe, expect, test } from 'bun:test'
import { PI } from '../src/constants'
import { cd, cdFromCdelt, cdMatrix, hasCd, isWcsFitsKeyword, pc2cd } from '../src/fits.wcs'

function expectMatrixCloseTo(actual: readonly number[], expected: readonly number[], precision: number = 12) {
	for (let i = 0; i < actual.length; i++) {
		expect(actual[i]).toBeCloseTo(expected[i], precision)
	}
}

describe('has cd', () => {
	test('detects supported WCS matrix encodings', () => {
		expect(hasCd({ CD1_1: 1 })).toBeTrue()
		expect(hasCd({ CDELT1: 1, CDELT2: 2, CROTA2: 30 })).toBeTrue()
		expect(hasCd({ CDELT1: 1, CDELT2: 2, PC1_1: 1 })).toBeTrue()
		expect(hasCd({ CDELT1: 1, CDELT2: 2 })).toBeFalse()
	})
})

describe('cd matrix', () => {
	test('reads the direct CD matrix', () => {
		expectMatrixCloseTo(cdMatrix({ CD1_1: 1, CD1_2: 2, CD2_1: 3, CD2_2: 4 }), [1, 2, 3, 4])
	})

	test('prefers PC keywords over legacy CROTA2 when both are present', () => {
		const header = { CDELT1: 2, CDELT2: 3, CROTA2: 45, PC1_1: 0, PC1_2: 1, PC2_1: -1, PC2_2: 0 } as const
		expectMatrixCloseTo(cdMatrix(header), [0, 2, -3, 0])
	})

	test('uses identity defaults for missing PC diagonal terms', () => {
		const header = { CDELT1: 2, CDELT2: 3, PC1_2: 0.5 } as const
		expectMatrixCloseTo(cdMatrix(header), [2, 1, 0, 3])
	})

	test('falls back to a diagonal matrix when only CDELT is present', () => {
		expectMatrixCloseTo(cdMatrix({ CDELT1: -2, CDELT2: 3 }), [-2, 0, 0, 3])
	})
})

describe('cd', () => {
	test('returns individual matrix elements using FITS indices', () => {
		const header = { CDELT1: 2, CDELT2: 3, PC1_1: 0, PC1_2: 1, PC2_1: -1, PC2_2: 0 } as const

		expect(cd(header, 1, 1)).toBeCloseTo(0, 12)
		expect(cd(header, 1, 2)).toBeCloseTo(2, 12)
		expect(cd(header, 2, 1)).toBeCloseTo(-3, 12)
		expect(cd(header, 2, 2)).toBeCloseTo(0, 12)
	})
})

describe('cd from cdelt', () => {
	test('converts scale and rotation into a CD matrix', () => {
		expectMatrixCloseTo(cdFromCdelt(2, 3, PI / 2), [0, 3, -2, 0])
	})

	test('applies axis flips to the rotated matrix', () => {
		expectMatrixCloseTo(cdFromCdelt(2, 3, 0, true, true), [-2, 0, 0, -3])
	})
})

describe('pc2cd', () => {
	test('scales the PC matrix without swapping elements', () => {
		expectMatrixCloseTo(pc2cd(1, 2, 3, 4, 10, 20), [10, 20, 60, 80])
	})
})

describe('is wcs fits keyword', () => {
	test('matches supported WCS and SIP keywords', () => {
		expect(isWcsFitsKeyword('CD1_1')).toBeTrue()
		expect(isWcsFitsKeyword('PC2_1')).toBeTrue()
		expect(isWcsFitsKeyword('PV1_0')).toBeTrue()
		expect(isWcsFitsKeyword('AP_2_1')).toBeTrue()
		expect(isWcsFitsKeyword('BP_ORDER')).toBeTrue()
	})

	test('rejects unrelated or malformed FITS keywords', () => {
		expect(isWcsFitsKeyword('BZERO')).toBeFalse()
		expect(isWcsFitsKeyword('CD1')).toBeFalse()
		expect(isWcsFitsKeyword('PS_1_0')).toBeFalse()
		expect(isWcsFitsKeyword('WCSAXESA')).toBeFalse()
	})
})
