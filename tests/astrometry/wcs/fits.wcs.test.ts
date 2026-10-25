import { describe, expect, test } from 'bun:test'
import { plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { cd, cdFromCdelt, cdMatrix, DEC_TAN, DEC_TAN_SIP, hasCd, isWcsFitsKeyword, pc2cd, RA_TAN, RA_TAN_SIP, reflectFitsWcs, scaleAndCropFitsWcs, sipKeywordsValid, sipOrdersValid, tanHeader, tanProject, tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import { Wcs } from '../../../src/bindings/astrometry/libwcs'
import { PIOVERTWO } from '../../../src/core/constants'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { type Angle, deg } from '../../../src/math/units/angle'

function expectMatrixCloseTo(actual: readonly number[], expected: readonly number[], precision: number = 12) {
	for (let i = 0; i < actual.length; i++) {
		expect(actual[i]).toBeCloseTo(expected[i], precision)
	}
}

const TAN_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 400.5, CRPIX2: 300.5, CRVAL1: 100.215755, CRVAL2: 9.831592, CD1_1: -7e-4, CD1_2: -2.5e-5, CD2_1: 3e-5, CD2_2: 6.8e-4 } as const
const TAN_PC_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 512.5, CRPIX2: 512.5, CRVAL1: 187.1252286, CRVAL2: 56.720194049, CDELT1: -8e-4, CDELT2: 7.5e-4, PC1_1: Math.cos(deg(27)), PC1_2: -Math.sin(deg(27)), PC2_1: Math.sin(deg(27)), PC2_2: Math.cos(deg(27)) } as const
const TAN_CROTA_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 6844.54215495, CRPIX2: 2924.71455892, CRVAL1: 211.789996831, CRVAL2: 54.3250783745, CDELT1: -0.000246219, CDELT2: 0.000246219, CROTA2: 11.8 } as const
const TAN_LONPOLE_HEADER = { ...TAN_HEADER, LONPOLE: 90 } as const

const TAN_SIP_HEADER = {
	NAXIS: 2,
	NAXIS1: 256,
	NAXIS2: 256,
	CTYPE1: RA_TAN_SIP,
	CTYPE2: DEC_TAN_SIP,
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
} as const satisfies FitsHeader

// WCS emitted by ASTAP CLI 2026.06.29 with -sip for a 2072x1410 FITS image.
// Only astrometric cards are retained; dimensions are inferred from its central CRPIX as in astapPlateSolve.
const ASTAP_SIP_HEADER = {
	NAXIS1: 2072,
	NAXIS2: 1410,
	EQUINOX: 2000,
	CTYPE1: 'RA---TAN-SIP',
	CTYPE2: 'DEC--TAN-SIP',
	CUNIT1: 'deg',
	CRPIX1: 1036.5,
	CRPIX2: 705.5,
	CRVAL1: 228.8439336238,
	CRVAL2: -65.70119704162,
	CD1_1: -1.079903219473e-3,
	CD1_2: 5.789461881308e-5,
	CD2_1: -5.762143664478e-5,
	CD2_2: -1.079367239763e-3,
	A_ORDER: 3,
	A_0_0: -1.599397400696e-2,
	A_1_0: 6.286091399779e-4,
	A_0_1: 3.029980544263e-4,
	A_2_0: 1.867192403307e-8,
	A_1_1: 3.084667215629e-8,
	A_0_2: 5.418071626898e-8,
	A_3_0: -6.557134360888e-10,
	A_2_1: -3.915168056723e-10,
	A_1_2: -1.273014423754e-9,
	A_0_3: 7.86758458763e-11,
	B_ORDER: 3,
	B_0_0: 9.402765316743e-2,
	B_0_1: 2.909543239387e-4,
	B_1_0: 2.576536496058e-4,
	B_2_0: -1.340027322956e-7,
	B_1_1: -1.544082771086e-7,
	B_0_2: -3.3771713305e-8,
	B_3_0: 7.192240149936e-11,
	B_2_1: -8.139562870158e-10,
	B_1_2: -3.036956018419e-10,
	B_0_3: -1.746459287858e-10,
	AP_ORDER: 3,
	AP_0_0: 1.60799566312e-2,
	AP_1_0: -6.29067304285e-4,
	AP_0_1: -3.028715356256e-4,
	AP_2_0: -1.876479865884e-8,
	AP_1_1: -3.093726830057e-8,
	AP_0_2: -5.430269510454e-8,
	AP_3_0: 6.564930435165e-10,
	AP_2_1: 3.907769504492e-10,
	AP_1_2: 1.274022059964e-9,
	AP_0_3: -7.874314713237e-11,
	BP_ORDER: 3,
	BP_0_0: -9.411418543914e-2,
	BP_1_0: -2.574806621537e-4,
	BP_0_1: -2.911930355207e-4,
	BP_2_0: 1.340657585253e-7,
	BP_1_1: 1.544235180871e-7,
	BP_0_2: 3.391866381086e-8,
	BP_3_0: -7.210338800097e-11,
	BP_2_1: 8.14385260811e-10,
	BP_1_2: 3.030095495138e-10,
	BP_0_3: 1.752640351706e-10,
} as const satisfies FitsHeader

describe('scale and crop FITS WCS', () => {
	test.each([
		['PC with implicit scales', { ...TAN_PC_HEADER, CDELT1: undefined, CDELT2: undefined }, { ...TAN_PC_HEADER, CDELT1: 1, CDELT2: 1 }],
		['PC with one implicit scale', { ...TAN_PC_HEADER, CDELT2: undefined }, { ...TAN_PC_HEADER, CDELT2: 1 }],
		['CD with implicit reference point', { ...TAN_HEADER, CRPIX1: undefined, CRPIX2: undefined, CRVAL1: undefined, CRVAL2: undefined }, { ...TAN_HEADER, CRPIX1: 0, CRPIX2: 0, CRVAL1: 0, CRVAL2: 0 }],
		['TAN with implicit identity', { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN' }, { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 0, CRPIX2: 0, CRVAL1: 0, CRVAL2: 0, CDELT1: 1, CDELT2: 1 }],
	] as const)('%s preserves the FITS default coordinate mapping', (_name, source, explicit) => {
		// FITS 4.0 section 8.2: missing CRPIX/CRVAL default to zero, CDELT to one, and PC to identity.
		const result: FitsHeader = { ...source }
		scaleAndCropFitsWcs(result, 2.3, 1.7, 13, 7)
		expect(result.CTYPE1).toBe('RA---TAN')
		expect(result.CDELT1).toBeUndefined()
		expect(result.PC1_1).toBeUndefined()
		for (const [x, y] of [
			[1, 1],
			[17, 25],
			[103, 87],
		]) {
			const expected = tanUnproject(explicit, x, y)!
			const actual = tanUnproject(result, (x - 0.5) * 2.3 + 0.5 - 13, (y - 0.5) * 1.7 + 0.5 - 7)!
			expect(actual).toBeDefined()
			expectMatrixCloseTo(actual, expected)
		}
	})

	test.each([
		['CD', TAN_HEADER],
		['PC', TAN_PC_HEADER],
		['CROTA', TAN_CROTA_HEADER],
		['diagonal CDELT', { ...TAN_CROTA_HEADER, CROTA2: undefined }],
		['SIP', TAN_SIP_HEADER],
		['ASTAP SIP', ASTAP_SIP_HEADER],
		['forward SIP', Object.fromEntries(Object.entries(TAN_SIP_HEADER).filter(([key]) => !key.startsWith('AP_') && !key.startsWith('BP_')))],
	] as const)('%s preserves sky and both pixel directions under anisotropic scale/crop', (_name, source) => {
		const original = { ...source }
		const result: FitsHeader = { ...source }
		const sx = 2.31
		const sy = 2.27
		const left = 13
		const top = 7

		expect(scaleAndCropFitsWcs(result, sx, sy, left, top)).toBe(result)
		expect(source).toEqual(original)
		expect(result.CDELT1).toBeUndefined()
		expect(result.PC1_1).toBeUndefined()
		expect(result.CROTA2).toBeUndefined()

		for (const [x, y] of [
			[90, 121],
			[128, 128],
			[170, 149],
		]) {
			const sky = tanUnproject(source, x, y)!
			const scaledSky = tanUnproject(result, (x - 0.5) * sx + 0.5 - left, (y - 0.5) * sy + 0.5 - top)!
			expectMatrixCloseTo(scaledSky, sky, 12)
			// Compare the same approximate SIP inverse, preserving its original residual.
			const back = tanProject(source, sky[0], sky[1])!
			const scaledBack = tanProject(result, sky[0], sky[1])!
			expect(scaledBack[0]).toBeCloseTo((back[0] - 0.5) * sx + 0.5 - left, 7)
			expect(scaledBack[1]).toBeCloseTo((back[1] - 0.5) * sy + 0.5 - top, 7)
		}
	})

	test('SIP inverse constants, linear terms and DMAX follow change of variables', () => {
		const h: FitsHeader = { ...TAN_SIP_HEADER, AP_0_0: 0.03, BP_0_0: -0.01 }
		scaleAndCropFitsWcs(h, 2, 3, 5, 7)
		expect(h.AP_0_0).toBeCloseTo(0.06, 14)
		expect(h.BP_0_0).toBeCloseTo(-0.03, 14)
		expect(h.AP_0_1).toBeCloseTo((TAN_SIP_HEADER.AP_0_1 * 2) / 3, 14)
		expect(h.A_DMAX).toBe(TAN_SIP_HEADER.A_DMAX * 2)
		expect(h.B_DMAX).toBe(TAN_SIP_HEADER.B_DMAX * 3)
	})

	test('undefined inverse cards are absent and higher-dimensional solutions are discarded completely', () => {
		const forward: FitsHeader = Object.fromEntries(Object.entries(TAN_SIP_HEADER).map(([key, value]) => [key, key.startsWith('AP_') || key.startsWith('BP_') ? undefined : value]))
		scaleAndCropFitsWcs(forward, 2, 2, 0, 0)
		expect(forward.A_ORDER).toBe(3)
		expect(forward.CTYPE1).toBe(RA_TAN_SIP)
		expect(forward.AP_0_1).toBeUndefined()
		const invalid: FitsHeader = { ...TAN_HEADER, CRPIX10: 5, OBJECT: 'M31' }
		scaleAndCropFitsWcs(invalid, 2, 2, 0, 0)
		expect(invalid).toEqual({ OBJECT: 'M31' })
	})

	test('removes alternate and unsupported complete solutions while preserving observation metadata', () => {
		const h: FitsHeader = { ...TAN_HEADER, CRPIX1A: 10, CTYPE1A: 'RA---TAN', WCSNAMEA: 'alternate', OBJECT: 'M31' }
		scaleAndCropFitsWcs(h, 2, 2, 0, 0)
		expect(h.CRPIX1A).toBeUndefined()
		expect(h.WCSNAMEA).toBeUndefined()
		expect(h.CRPIX1).toBeDefined()
		for (const invalid of [{ CPDIS1: 'LOOKUP', 'DP1.EXTVER': 1 }, { CTYPE1: 'RA---TPV', PV1_0: 0 }, { CTYPE1: RA_TAN_SIP }, { CD1_1: 0, CD1_2: 0 }]) {
			const unsupported: FitsHeader = { ...TAN_HEADER, ...invalid, OBJECT: 'M31' }
			scaleAndCropFitsWcs(unsupported, 2, 2, 0, 0)
			expect(unsupported).toEqual({ OBJECT: 'M31' })
		}
		const none = { OBJECT: 'M31' }
		expect(scaleAndCropFitsWcs(none, 2, 2, 0, 0)).toEqual(none)
	})
})

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
		// Canonical WCS conversion: CD1_2 = -CDELT2·sin, CD2_1 = CDELT1·sin.
		expectMatrixCloseTo(cdFromCdelt(2, 3, PIOVERTWO), [0, -3, 2, 0])
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

describe('reflect fits wcs', () => {
	const cases: readonly { name: string; header: FitsHeader; width: number; height: number; x: number; y: number; precision: number }[] = [
		{ name: 'direct CD', header: TAN_HEADER, width: 800, height: 600, x: 512.25, y: 180.75, precision: 10 },
		{ name: 'PC plus CDELT', header: TAN_PC_HEADER, width: 1024, height: 1024, x: 620.25, y: 455.75, precision: 10 },
		{ name: 'CDELT plus CROTA', header: TAN_CROTA_HEADER, width: 13689, height: 5849, x: 7012.5, y: 3101.25, precision: 9 },
		{ name: 'CDELT only', header: { ...TAN_HEADER, CD1_1: undefined, CD1_2: undefined, CD2_1: undefined, CD2_2: undefined, CDELT1: -7e-4, CDELT2: 6.8e-4 }, width: 800, height: 600, x: 512.25, y: 180.75, precision: 10 },
		{ name: 'SIP', header: TAN_SIP_HEADER, width: 256, height: 256, x: 200.5, y: 210.25, precision: 9 },
		{ name: 'ASTAP SIP', header: ASTAP_SIP_HEADER, width: 2072, height: 1410, x: 200.5, y: 210.25, precision: 3 },
	]

	for (const entry of cases) {
		for (const [name, horizontal, vertical] of [
			['horizontal', true, false],
			['vertical', false, true],
			['both', true, true],
		] as const) {
			test(`${entry.name} ${name}`, () => {
				const before = tanUnproject(entry.header, entry.x, entry.y)
				expect(before).toBeDefined()
				if (!before) return

				const header = { ...entry.header }
				expect(reflectFitsWcs(header, entry.width, entry.height, horizontal, vertical)).toBe(header)
				const x = horizontal ? entry.width + 1 - entry.x : entry.x
				const y = vertical ? entry.height + 1 - entry.y : entry.y
				const after = tanUnproject(header, x, y)
				expect(after).toBeDefined()
				if (!after) return

				expect(after[0]).toBeCloseTo(before[0], entry.precision)
				expect(after[1]).toBeCloseTo(before[1], entry.precision)
				expectTanMatchesNativeUnproject(header, x, y, entry.name === 'SIP' ? 9 : entry.precision)
				const projected = tanProject(header, before[0], before[1])
				expect(projected).toBeDefined()
				if (!projected) return
				expect(projected[0]).toBeCloseTo(x, entry.name === 'SIP' ? 3 : entry.precision)
				expect(projected[1]).toBeCloseTo(y, entry.name === 'SIP' ? 3 : entry.precision)
			})
		}
	}

	test('rejects invalid dimensions before mutation', () => {
		const header: FitsHeader = { ...TAN_HEADER }
		const before = { ...header }
		expect(() => reflectFitsWcs(header, 0, 600, true, false)).toThrow('width must be a positive integer')
		expect(header).toEqual(before)
		expect(() => reflectFitsWcs(header, 800, Number.NaN, false, true)).toThrow('height must be a positive integer')
		expect(header).toEqual(before)
	})

	test('is an exact involution and preserves a no-op request', () => {
		const header: FitsHeader = { ...TAN_SIP_HEADER }
		const before = { ...header }
		expect(reflectFitsWcs(header, 256, 256, false, false)).toBe(header)
		expect(header).toEqual(before)
		reflectFitsWcs(header, 256, 256, true, false)
		reflectFitsWcs(header, 256, 256, true, false)
		expect(header).toEqual(before)
		reflectFitsWcs(header, 256, 256, false, true)
		reflectFitsWcs(header, 256, 256, false, true)
		expect(header).toEqual(before)
	})
})

describe('is wcs fits keyword', () => {
	test('matches supported WCS and SIP keywords', () => {
		expect(isWcsFitsKeyword('CD1_1')).toBeTrue()
		expect(isWcsFitsKeyword('PC2_1')).toBeTrue()
		expect(isWcsFitsKeyword('PV1_0')).toBeTrue()
		expect(isWcsFitsKeyword('AP_2_1')).toBeTrue()
		expect(isWcsFitsKeyword('BP_ORDER')).toBeTrue()
		expect(isWcsFitsKeyword('A_DMAX')).toBeTrue()
		expect(isWcsFitsKeyword('B_DMAX')).toBeTrue()
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

	test('matches the native WCS projection for CROTA2 headers with same-sign CDELT', () => {
		const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 100, CRPIX2: 100, CRVAL1: 150, CRVAL2: 20, CDELT1: 2e-4, CDELT2: 2e-4, CROTA2: 20 } as const
		expectTanMatchesNativeProject(header, deg(150.02), deg(20.015), 8)
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

	test('rejects non-TAN axis types', () => {
		expect(tanUnproject({ ...TAN_HEADER, CTYPE2: 'DEC--SIN' }, TAN_HEADER.CRPIX1, TAN_HEADER.CRPIX2)).toBeUndefined()
	})

	test('returns no result for a singular CD matrix', () => {
		expect(tanUnproject({ ...TAN_HEADER, CD1_1: 1e-3, CD1_2: 2e-3, CD2_1: 1e-3, CD2_2: 2e-3 }, 100, 100)).toBeUndefined()
	})
})

describe('tan lonpole defaults', () => {
	// FITS WCS Paper II: for TAN, omitted LONPOLE is 0° when CRVAL2 ≥ 90° and 180° otherwise.
	const TAN_NCP_HEADER = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 100, CRPIX2: 100, CRVAL1: 0, CRVAL2: 90, CD1_1: -0.001, CD1_2: 0, CD2_1: 0, CD2_2: 0.001 } as const
	const TAN_SCP_HEADER = { ...TAN_NCP_HEADER, CRVAL2: -90 } as const

	test('defaults omitted LONPOLE to 0 at the north celestial pole', () => {
		expectTanMatchesNativeUnproject(TAN_NCP_HEADER, 150, 100)
		expectTanMatchesNativeProject(TAN_NCP_HEADER, deg(10), deg(89.5))
	})

	test('honors an explicit LONPOLE of 180 at the north celestial pole', () => {
		const header = { ...TAN_NCP_HEADER, LONPOLE: 180 }
		expectTanMatchesNativeUnproject(header, 150, 100)
		expectTanMatchesNativeProject(header, deg(10), deg(89.5))
	})

	test('defaults omitted LONPOLE to 180 at the south celestial pole', () => {
		expectTanMatchesNativeUnproject(TAN_SCP_HEADER, 150, 100)
		expectTanMatchesNativeProject(TAN_SCP_HEADER, deg(10), deg(-89.5))
	})
})

describe('tan project/unproject round-trip', () => {
	// project(unproject(x, y)) must recover the original pixel without relying on the native binding.
	const cases = [
		{ name: 'direct CD', header: TAN_HEADER, x: 512.25, y: 180.75, precision: 9 },
		{ name: 'PC plus CDELT', header: TAN_PC_HEADER, x: 620.25, y: 455.75, precision: 9 },
		{ name: 'CROTA2', header: TAN_CROTA_HEADER, x: 7012.5, y: 3101.25, precision: 8 },
		// SIP round-trip is limited by the AP/BP coefficients only approximating the A/B forward inverse.
		{ name: 'SIP', header: TAN_SIP_HEADER, x: 200.5, y: 210.25, precision: 3 },
	] as const

	for (const entry of cases) {
		test(entry.name, () => {
			const sky = tanUnproject(entry.header, entry.x, entry.y)
			expect(sky).toBeDefined()
			if (!sky) return
			const pixel = tanProject(entry.header, sky[0], sky[1])
			expect(pixel).toBeDefined()
			if (!pixel) return
			expect(pixel[0]).toBeCloseTo(entry.x, entry.precision)
			expect(pixel[1]).toBeCloseTo(entry.y, entry.precision)
		})
	}
})

// https://nova.astrometry.net/user_images/12367041: a 9176 by 6870 TAN-SIP solution with zeroed forward linear
// terms, non-zero reverse constant and linear terms and a reference pixel far from the image center.
const M101_HEADER: FitsHeader = {
	CTYPE1: RA_TAN_SIP,
	CTYPE2: DEC_TAN_SIP,
	EQUINOX: 2000,
	LONPOLE: 180,
	LATPOLE: 0,
	CRVAL1: 211.789996831,
	CRVAL2: 54.3250783745,
	CRPIX1: 6844.54215495,
	CRPIX2: 2924.71455892,
	CUNIT1: 'deg',
	CUNIT2: 'deg',
	CD1_1: 0.00024098759167,
	CD1_2: -5.0386872296e-5,
	CD2_1: 5.05049438425e-5,
	CD2_2: 0.000241100662196,
	IMAGEW: 9176,
	IMAGEH: 6870,
	A_ORDER: 2,
	A_0_0: 0,
	A_0_1: 0,
	A_0_2: -1.19977665955e-8,
	A_1_0: 0,
	A_1_1: 3.64583422462e-7,
	A_2_0: 4.56030084803e-8,
	B_ORDER: 2,
	B_0_0: 0,
	B_0_1: 0,
	B_0_2: 6.99507235566e-8,
	B_1_0: 0,
	B_1_1: 1.19143632657e-7,
	B_2_0: -1.51089049833e-8,
	AP_ORDER: 2,
	AP_0_0: 0.00125507380633,
	AP_0_1: 5.41386160049e-7,
	AP_0_2: 1.1640011409e-8,
	AP_1_0: 8.29305028907e-7,
	AP_1_1: -3.64848349812e-7,
	AP_2_0: -4.55456767661e-8,
	BP_ORDER: 2,
	BP_0_0: 0.000512324546753,
	BP_0_1: 2.3090891984e-7,
	BP_0_2: -7.00930378576e-8,
	BP_1_0: 2.92061162221e-7,
	BP_1_1: -1.19102625774e-7,
	BP_2_0: 1.51337539596e-8,
}

// The center and three corners of the M101 image, in FITS 1-based pixels.
const M101_POINTS = [
	[4588.5, 3435.5],
	[1, 1],
	[9176, 1],
	[1, 6870],
] as const

// Expects every path to refuse a header: the descriptor, both projections at the center and at a corner, and the
// plate solution.
function expectRefused(header: FitsHeader) {
	expect(tanHeader(header)).toBeUndefined()
	expect(tanUnproject(header, 4588.5, 3435.5)).toBeUndefined()
	expect(tanUnproject(header, 1, 1)).toBeUndefined()
	expect(tanProject(header, deg(211), deg(54))).toBeUndefined()
	expect(plateSolutionFrom(header)).toBeUndefined()
}

// Expects every path to accept a header.
function expectAccepted(header: FitsHeader) {
	expect(tanHeader(header)).toBeDefined()
	expect(tanUnproject(header, 4588.5, 3435.5)).toBeDefined()
	expect(tanProject(header, deg(211), deg(54))).toBeDefined()
	expect(plateSolutionFrom(header)).toBeDefined()
}

describe('SIP validation', () => {
	test('only matching TAN or TAN-SIP pairs are gnomonic', () => {
		expectAccepted(M101_HEADER)
		expectAccepted({ ...M101_HEADER, CTYPE1: RA_TAN, CTYPE2: DEC_TAN })
		expectRefused({ ...M101_HEADER, CTYPE2: DEC_TAN })
		expectRefused({ ...M101_HEADER, CTYPE1: RA_TAN })
		expectRefused({ ...M101_HEADER, CTYPE1: undefined })

		// Two empty CTYPEs stay lenient for internally built headers, which are never plate solutions.
		const empty = { ...M101_HEADER, CTYPE1: undefined, CTYPE2: undefined }
		expect(tanUnproject(empty, 4588.5, 3435.5)).toBeDefined()
		expect(plateSolutionFrom(empty)).toBeUndefined()
	})

	test('forward orders must be integers from 2 to 9 on both axes', () => {
		for (const order of [undefined, 0, 1, 10, 2.5, -2, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
			expect(sipOrdersValid({ ...M101_HEADER, A_ORDER: order })).toBeFalse()
			expectRefused({ ...M101_HEADER, A_ORDER: order })
		}

		expectRefused({ ...M101_HEADER, B_ORDER: 1 })
		expect(sipOrdersValid({ ...M101_HEADER, A_ORDER: 9, B_ORDER: 9 })).toBeTrue()
		expectAccepted({ ...M101_HEADER, A_ORDER: 9, B_ORDER: 9 })
	})

	test('a huge order is refused at once, before any polynomial is evaluated', () => {
		const header = { ...M101_HEADER, A_ORDER: 1e6, B_ORDER: 1e6 }
		const started = performance.now()
		expectRefused(header)
		expect(performance.now() - started).toBeLessThan(10)
	})

	test('forward constant and linear terms are accepted, including zeros', () => {
		for (const key of ['A_1_0', 'A_0_1', 'A_0_0', 'B_0_1', 'B_1_0', 'B_0_0']) {
			expectAccepted({ ...M101_HEADER, [key]: 1e-6 })
			expectAccepted({ ...M101_HEADER, [key]: -0 })
		}
	})

	test('ASTAP SIP matches WCSLIB at the center and corners without dropping low-degree terms', () => {
		const forward: FitsHeader = Object.fromEntries(Object.entries(ASTAP_SIP_HEADER).filter(([key]) => !/^(AP|BP)_/.test(key)))
		const zeroed: FitsHeader = { ...ASTAP_SIP_HEADER, A_0_0: 0, A_1_0: 0, A_0_1: 0, B_0_0: 0, B_1_0: 0, B_0_1: 0 }
		using native = new Wcs(ASTAP_SIP_HEADER)

		for (const [x, y] of [
			[1036.5, 705.5],
			[1, 1],
			[2072, 1],
			[2072, 1410],
			[1, 1410],
		]) {
			const sky = tanUnproject(ASTAP_SIP_HEADER, x, y)!
			expectMatrixCloseTo(sky, native.pixToSky(x, y)!, 12)
			const fitted = tanProject(ASTAP_SIP_HEADER, ...sky)!
			const iterated = tanProject(forward, ...sky)!
			// AP/BP is an approximate inverse fitted by ASTAP; forward-only inversion converges more closely.
			expect(Math.hypot(fitted[0] - x, fitted[1] - y)).toBeLessThan(0.01)
			expect(Math.hypot(iterated[0] - x, iterated[1] - y)).toBeLessThan(1e-7)
			const withoutLowTerms = tanUnproject(zeroed, x, y)!
			expect(Math.hypot((sky[0] - withoutLowTerms[0]) * Math.cos(sky[1]), sky[1] - withoutLowTerms[1])).toBeGreaterThan(deg(0.3 / 3600))
		}

		const solution = plateSolutionFrom(ASTAP_SIP_HEADER)!
		expectMatrixCloseTo([solution.rightAscension, solution.declination], native.pixToSky(1036.5, 705.5)!, 12)
		expect(solution.A_0_0).toBe(ASTAP_SIP_HEADER.A_0_0)
	})

	test('a coefficient above its order or without one is refused', () => {
		expectAccepted({ ...M101_HEADER, A_2_0: 1e-8, A_1_1: 1e-8, A_0_2: 1e-8 })

		for (const extra of [{ A_3_0: 1e-9 }, { B_0_3: 1e-9 }, { AP_2_1: 1e-9 }, { BP_1_2: 1e-9 }, { A_10_0: 0 }, { A_2_0: Number.NaN }, { B_1_1: '1e-7' }]) {
			expect(sipKeywordsValid({ ...M101_HEADER, ...extra })).toBeFalse()
			expectRefused({ ...M101_HEADER, ...extra })
		}

		const { AP_ORDER, BP_ORDER, ...withoutReverseOrders } = M101_HEADER
		expect(AP_ORDER).toBe(BP_ORDER)
		expectRefused(withoutReverseOrders)
	})

	test('reverse polynomials keep their constant and linear terms and must be declared on both axes', () => {
		const withoutReverse = Object.fromEntries(Object.entries(M101_HEADER).filter(([key]) => !/^(AP|BP)_/.test(key)))

		// The reverse polynomials fit the inverse of the forward ones, so both reverse paths land on the same pixel.
		const sky = tanUnproject(M101_HEADER, 100, 200)!
		const fitted = tanProject(M101_HEADER, ...sky)!
		const iterated = tanProject({ ...withoutReverse, AP_ORDER: 0, BP_ORDER: 0 }, ...sky)!
		expect(Math.hypot(iterated[0] - 100, iterated[1] - 200)).toBeLessThan(1e-6)
		expect(Math.hypot(fitted[0] - 100, fitted[1] - 200)).toBeLessThan(0.015)
		expect(tanProject(withoutReverse, ...sky)).toEqual(iterated)

		// Astropy 7.1.0 accepts reverse orders of 10 and evaluates the forward map alone; nebulosa.ts stops at 9.
		expectRefused({ ...M101_HEADER, AP_ORDER: 10, BP_ORDER: 10 })
		expectRefused({ ...M101_HEADER, BP_ORDER: undefined })
		expectRefused({ ...M101_HEADER, AP_ORDER: undefined })
	})

	test('units must be degrees', () => {
		expectRefused({ ...M101_HEADER, CUNIT1: 'rad' })
		expectRefused({ ...M101_HEADER, CUNIT2: 'arcsec' })
		expectAccepted({ ...M101_HEADER, CUNIT1: ' DEG ', CUNIT2: undefined })
		expectRefused({ ...TAN_HEADER, CUNIT1: 'rad', NAXIS1: 800, NAXIS2: 600 })
	})

	test('the projection matches Astropy at the center and the corners', () => {
		// Astropy 7.1.0, numpy 2.2.6: WCS.pixel_to_world_values at the FITS pixels minus one.
		const withSip = [
			[210.81342485450145, 54.330288289427784],
			[209.2839147862296, 53.249392829888684],
			[212.9878012758693, 53.73177805160949],
			[208.574251119693, 54.88708022716851],
		] as const
		const withoutSip = [
			[210.81348555910475, 54.3303456789751],
			[209.280415117246, 53.24829998218111],
			[212.9887343553913, 53.73195835441583],
			[208.57721814000246, 54.88824147860589],
		] as const
		const linear = { ...Object.fromEntries(Object.entries(M101_HEADER).filter(([key]) => !/^(A|B|AP|BP)_/.test(key))), CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN' }

		for (let i = 0; i < M101_POINTS.length; i++) {
			const [x, y] = M101_POINTS[i]
			const [ra, dec] = tanUnproject(M101_HEADER, x, y)!
			expect(Math.hypot((ra - deg(withSip[i][0])) * Math.cos(dec), dec - deg(withSip[i][1]))).toBeLessThan(deg(0.01 / 3600))
			const [linearRa, linearDec] = tanUnproject(linear, x, y)!
			expect(Math.hypot((linearRa - deg(withoutSip[i][0])) * Math.cos(dec), linearDec - deg(withoutSip[i][1]))).toBeLessThan(deg(0.01 / 3600))
		}

		// Without its SIP the M101 center moves by about 0.24″.
		const [ra, dec] = tanUnproject(M101_HEADER, 4588.5, 3435.5)!
		const [linearRa, linearDec] = tanUnproject(linear, 4588.5, 3435.5)!
		expect(Math.hypot((ra - linearRa) * Math.cos(dec), dec - linearDec) / deg(1 / 3600)).toBeCloseTo(0.24, 2)
	})

	test('the reverse polynomials invert the forward ones within their fit error', () => {
		// The astrometry.net reverse fit of M101 inverts the forward one to 0.015 px over the whole image (measured: 3e-6 px
		// at the center, 0.0021 px at two corners and 0.0100 px, the maximum over a 10 by 10 grid, at the other two).
		for (const [x, y] of [...M101_POINTS, [9176, 6870] as const]) {
			const [ra, dec] = tanUnproject(M101_HEADER, x, y)!
			const [px, py] = tanProject(M101_HEADER, ra, dec)!
			expect(Math.hypot(px - x, py - y)).toBeLessThan(0.015)
		}
	})

	test('scaling and cropping keeps only well-formed SIP', () => {
		const preserved: FitsHeader = { ...M101_HEADER }
		scaleAndCropFitsWcs(preserved, 2, 2, 0, 0)
		expect(preserved.A_ORDER).toBe(2)
		expect(preserved.AP_0_0).toBeCloseTo((M101_HEADER.AP_0_0 as number) * 2, 14)

		for (const malformed of [{ A_ORDER: 1 }, { A_3_0: 1e-6 }]) {
			const header: FitsHeader = { ...M101_HEADER, ...malformed }
			scaleAndCropFitsWcs(header, 2, 2, 0, 0)
			expect(header.CTYPE1).toBeUndefined()
			expect(header.A_ORDER).toBeUndefined()
			expect(header.CD1_1).toBeUndefined()
		}
	})
})
