import { describe, expect, test } from 'bun:test'
import { type Angle, deg } from '../src/angle'
import { PI } from '../src/constants'
import type { FitsHeader } from '../src/fits'
import { cd, cdFromCdelt, cdMatrix, hasCd, isWcsFitsKeyword, pc2cd, tanProject, tanUnproject } from '../src/fits.wcs'
import { Wcs } from '../src/wcs'

function expectMatrixCloseTo(actual: readonly number[], expected: readonly number[], precision: number = 12) {
	for (let i = 0; i < actual.length; i++) {
		expect(actual[i]).toBeCloseTo(expected[i], precision)
	}
}

const TAN_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 400.5, CRPIX2: 300.5, CRVAL1: 100.215755, CRVAL2: 9.831592, CD1_1: -7.0e-4, CD1_2: -2.5e-5, CD2_1: 3.0e-5, CD2_2: 6.8e-4 } as const
const TAN_PC_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 512.5, CRPIX2: 512.5, CRVAL1: 187.1252286, CRVAL2: 56.720194049, CDELT1: -8.0e-4, CDELT2: 7.5e-4, PC1_1: Math.cos(deg(27)), PC1_2: -Math.sin(deg(27)), PC2_1: Math.sin(deg(27)), PC2_2: Math.cos(deg(27)) } as const
const TAN_CROTA_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 6844.54215495, CRPIX2: 2924.71455892, CRVAL1: 211.789996831, CRVAL2: 54.3250783745, CDELT1: -0.000246219, CDELT2: 0.000246219, CROTA2: 11.8 } as const
const TAN_LONPOLE_HEADER = { ...TAN_HEADER, LONPOLE: 90 } as const

function expectTanMatchesNativeProject(header: FitsHeader, rightAscension: Angle, declination: Angle, precision: number = 9) {
	using wcs = new Wcs(header)
	const native = wcs.skyToPix(rightAscension, declination)
	const projected = tanProject(header, rightAscension, declination)

	expect(native).toBeDefined()
	expect(projected).toBeDefined()

	if (!native || !projected) return

	expect(projected[0]).toBeCloseTo(native[0], precision)
	expect(projected[1]).toBeCloseTo(native[1], precision)
}

function expectTanMatchesNativeUnproject(header: FitsHeader, x: number, y: number, precision: number = 11) {
	using wcs = new Wcs(header)
	const native = wcs.pixToSky(x, y)
	const unprojected = tanUnproject(header, x, y)

	expect(native).toBeDefined()
	expect(unprojected).toBeDefined()

	if (!native || !unprojected) return

	expect(unprojected[0]).toBeCloseTo(native[0], precision)
	expect(unprojected[1]).toBeCloseTo(native[1], precision)
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

describe('tan project', () => {
	test('projects the tangent point to CRPIX', () => {
		const projected = tanProject(TAN_HEADER, deg(TAN_HEADER.CRVAL1), deg(TAN_HEADER.CRVAL2))
		expect(projected).toBeDefined()

		if (!projected) return

		expect(projected[0]).toBeCloseTo(TAN_HEADER.CRPIX1, 12)
		expect(projected[1]).toBeCloseTo(TAN_HEADER.CRPIX2, 12)
	})

	test('matches the native WCS projection for direct CD headers', () => {
		expectTanMatchesNativeProject(TAN_HEADER, deg(100.246), deg(9.801))
	})

	test('matches the native WCS projection for direct CD headers with LONPOLE', () => {
		expectTanMatchesNativeProject(TAN_LONPOLE_HEADER, deg(100.246), deg(9.801))
	})

	test('matches the native WCS projection for PC plus CDELT headers', () => {
		expectTanMatchesNativeProject(TAN_PC_HEADER, deg(187.095), deg(56.742))
	})

	test('matches the native WCS projection for CROTA2 headers', () => {
		expectTanMatchesNativeProject(TAN_CROTA_HEADER, deg(211.82), deg(54.29), 8)
	})

	test('rejects points outside the visible tangent hemisphere', () => {
		expect(tanProject(TAN_HEADER, deg(TAN_HEADER.CRVAL1 + 180), -deg(TAN_HEADER.CRVAL2))).toBeUndefined()
	})

	test('rejects non-TAN axis types such as TAN-SIP', () => {
		expect(tanProject({ ...TAN_HEADER, CTYPE1: 'RA---TAN-SIP' }, deg(TAN_HEADER.CRVAL1), deg(TAN_HEADER.CRVAL2))).toBeUndefined()
	})
})

describe('tan unproject', () => {
	test('unprojects CRPIX to the tangent point', () => {
		const unprojected = tanUnproject(TAN_HEADER, TAN_HEADER.CRPIX1, TAN_HEADER.CRPIX2)
		expect(unprojected).toBeDefined()

		if (!unprojected) return

		expect(unprojected[0]).toBeCloseTo(deg(TAN_HEADER.CRVAL1), 12)
		expect(unprojected[1]).toBeCloseTo(deg(TAN_HEADER.CRVAL2), 12)
	})

	test('matches the native WCS inverse projection for direct CD headers', () => {
		expectTanMatchesNativeUnproject(TAN_HEADER, 512.25, 180.75)
	})

	test('matches the native WCS inverse projection for direct CD headers with LONPOLE', () => {
		expectTanMatchesNativeUnproject(TAN_LONPOLE_HEADER, 512.25, 180.75)
	})

	test('matches the native WCS inverse projection for PC plus CDELT headers', () => {
		expectTanMatchesNativeUnproject(TAN_PC_HEADER, 620.25, 455.75)
	})

	test('matches the native WCS inverse projection for CROTA2 headers', () => {
		expectTanMatchesNativeUnproject(TAN_CROTA_HEADER, 7012.5, 3101.25, 10)
	})
})
