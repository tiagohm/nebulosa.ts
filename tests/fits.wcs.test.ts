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

const TAN_SIP_HEADER = {
	NAXIS: 2,
	NAXIS1: 256,
	NAXIS2: 256,
	CTYPE1: 'RA---TAN-SIP',
	CTYPE2: 'DEC--TAN-SIP',
	CRVAL1: 202.482322805429,
	CRVAL2: 47.1751189300101,
	CRPIX1: 128,
	CRPIX2: 128,
	CD1_1: 0.000249756880272355,
	CD1_2: 0.000230177809743655,
	CD2_1: 0.000230428519265417,
	CD2_2: -0.000249965770576587,
	A_ORDER: 3,
	A_0_2: 2.9656e-6,
	A_0_3: 3.7746e-9,
	A_1_1: 2.1886e-5,
	A_1_2: -1.6847e-7,
	A_2_0: -2.3863e-5,
	A_2_1: -8.561e-9,
	A_3_0: -1.4172e-7,
	A_DMAX: 1.394,
	B_ORDER: 3,
	B_0_2: 2.31e-5,
	B_0_3: -1.6168e-7,
	B_1_1: -2.4386e-5,
	B_1_2: -5.7813e-9,
	B_2_0: 2.1197e-6,
	B_2_1: -1.6583e-7,
	B_3_0: -2.0249e-8,
	B_DMAX: 1.501,
	AP_ORDER: 3,
	AP_0_1: -6.4275e-7,
	AP_0_2: -2.9425e-6,
	AP_0_3: -3.582e-9,
	AP_1_0: -1.4897e-5,
	AP_1_1: -2.225e-5,
	AP_1_2: 1.7195e-7,
	AP_2_0: 2.4146e-5,
	AP_2_1: 6.709e-9,
	AP_3_0: 1.4492e-7,
	BP_ORDER: 3,
	BP_0_1: -1.6588e-5,
	BP_0_2: -2.3424e-5,
	BP_0_3: 1.651e-7,
	BP_1_0: -2.6783e-6,
	BP_1_1: 2.4753e-5,
	BP_1_2: 3.8917e-9,
	BP_2_0: -2.151e-6,
	BP_2_1: 1.7e-7,
	BP_3_0: 2.0482e-8,
}

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

	test('matches the native WCS projection for SIP headers', () => {
		expectTanMatchesNativeProject(TAN_SIP_HEADER, deg(202.5715), deg(47.1726), 2)
	})

	test('rejects points outside the visible tangent hemisphere', () => {
		expect(tanProject(TAN_HEADER, deg(TAN_HEADER.CRVAL1 + 180), -deg(TAN_HEADER.CRVAL2))).toBeUndefined()
	})

	test('rejects non-TAN axis types', () => {
		expect(tanProject({ ...TAN_HEADER, CTYPE1: 'RA---SIN' }, deg(TAN_HEADER.CRVAL1), deg(TAN_HEADER.CRVAL2))).toBeUndefined()
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

	test('matches the native WCS inverse projection for SIP headers', () => {
		expectTanMatchesNativeUnproject(TAN_SIP_HEADER, 255, 255, 10)
	})
})
