import { describe, expect, test } from 'bun:test'
import * as platesolver from '../../../src/astrometry/solvers/platesolver'
import { plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP, tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { type Angle, deg, toArcsec, toDeg } from '../../../src/math/units/angle'

// Angular distance in arcseconds between a solution center and a reference in degrees.
function separationArcsec(rightAscension: Angle, declination: Angle, [ra, dec]: readonly [number, number]) {
	return toArcsec(Math.hypot((rightAscension - deg(ra)) * Math.cos(declination), declination - deg(dec)))
}

// https://nova.astrometry.net/user_images/12367041
test('M101', () => {
	const header: FitsHeader = {
		SIMPLE: true,
		BITPIX: 8,
		NAXIS: 0,
		WCSAXES: 2,
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

	const solution = plateSolutionFrom(header)

	expect(180 - toDeg(solution!.orientation)).toBeCloseTo(191.8, 1)
	expect(toArcsec(solution!.scale)).toBeCloseTo(0.887, 3)
	// The center of the image, not CRVAL (211.789996831°, 54.3250783745°, 34.17′ away): Astropy 7.1.0 with
	// numpy 2.2.6, WCS.pixel_to_world_values((W - 1) / 2, (H - 1) / 2) with SIP.
	expect(separationArcsec(solution!.rightAscension, solution!.declination, [210.81342485450145, 54.330288289427784])).toBeLessThan(1)
	expect(toArcsec(Math.abs(solution!.rightAscension - deg(header.CRVAL1 as number)))).toBeGreaterThan(1000)
	expect(toDeg(solution!.width)).toBeCloseTo(2.26, 2)
	expect(toDeg(solution!.height)).toBeCloseTo(1.69, 2)
	expect(toDeg(solution!.radius)).toBeCloseTo(1.411, 3)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(9176)
	expect(solution!.heightInPixels).toBe(6870)

	for (const key in header) {
		expect(solution![key]).toBe(header[key])
	}
})

test('anisotropic cd matrix', () => {
	const header = plateHeaderFromCd(0.008660254037844387, 0.01, -0.004999999999999999, 0.017320508075688773)
	const solution = plateSolutionFrom(header)

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(30, 12)
	expect(toDeg(solution!.scale)).toBeCloseTo(Math.SQRT2 / 100, 12)
	expect(toDeg(solution!.width)).toBeCloseTo(1, 12)
	expect(toDeg(solution!.height)).toBeCloseTo(1, 12)
	expect(toDeg(solution!.radius)).toBeCloseTo(Math.SQRT2 / 2, 12)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(100)
	expect(solution!.heightInPixels).toBe(50)
})

test('90 degree cd matrix', () => {
	const header = plateHeaderFromCd(0, 0.02, -0.01, 0)
	const solution = plateSolutionFrom(header)

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(90, 12)
	expect(toDeg(solution!.scale)).toBeCloseTo(Math.SQRT2 / 100, 12)
	expect(toDeg(solution!.width)).toBeCloseTo(1, 12)
	expect(toDeg(solution!.height)).toBeCloseTo(1, 12)
	expect(toDeg(solution!.radius)).toBeCloseTo(Math.SQRT2 / 2, 12)
	expect(solution!.parity).toBe('NORMAL')
})

test('singular cd matrix', () => {
	const header = plateHeaderFromCd(0.01, 0.02, 0.01, 0.02)

	expect(plateSolutionFrom(header)).toBeUndefined()
})

test('flipped parity cd matrix', () => {
	// Negative determinant flips parity; orientation negates cd22 before atan2.
	const header = plateHeaderFromCd(0.01, 0, 0, -0.01)
	const solution = plateSolutionFrom(header)

	expect(solution).toBeDefined()
	expect(solution!.parity).toBe('FLIPPED')
	expect(toDeg(solution!.orientation)).toBeCloseTo(0, 12)
	expect(toDeg(solution!.scale)).toBeCloseTo(0.01, 12)
	expect(toDeg(solution!.width)).toBeCloseTo(1, 12)
	expect(toDeg(solution!.height)).toBeCloseTo(0.5, 12)
})

test('cdelt and crota keywords', () => {
	const header: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, CRPIX1: 50.5, CRPIX2: 25.5, CRVAL1: 42, CRVAL2: -17, CDELT1: 0.02, CDELT2: 0.01, CROTA2: 30, NAXIS1: 100, NAXIS2: 50 }
	const solution = plateSolutionFrom(header)

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(-30, 12)
	expect(toDeg(solution!.scale)).toBeCloseTo(Math.SQRT2 / 100, 12)
	expect(toDeg(solution!.width)).toBeCloseTo(2, 12)
	expect(toDeg(solution!.height)).toBeCloseTo(0.5, 12)
	expect(solution!.parity).toBe('NORMAL')
})

test('pc and cdelt keywords', () => {
	const header: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, CRPIX1: 50.5, CRPIX2: 25.5, CRVAL1: 42, CRVAL2: -17, CDELT1: 0.02, CDELT2: 0.01, PC1_1: 0, PC1_2: -1, PC2_1: 1, PC2_2: 0, NAXIS1: 100, NAXIS2: 50 }
	const solution = plateSolutionFrom(header)

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(-90, 12)
	expect(toDeg(solution!.scale)).toBeCloseTo(Math.SQRT2 / 100, 12)
	expect(toDeg(solution!.width)).toBeCloseTo(1, 12)
	expect(toDeg(solution!.height)).toBeCloseTo(1, 12)
	expect(solution!.parity).toBe('NORMAL')
})

test('missing reference coordinate keywords yield no solution', () => {
	const base = plateHeaderFromCd(0.01, 0, 0, 0.01)
	const noRa = { ...base }
	delete noRa.CRVAL1
	const noDec = { ...base }
	delete noDec.CRVAL2

	expect(plateSolutionFrom(noRa)).toBeUndefined()
	expect(plateSolutionFrom(noDec)).toBeUndefined()
})

// Builds a minimal 100 by 50 TAN header centered on its reference pixel around a custom CD matrix.
function plateHeaderFromCd(cd11: number, cd12: number, cd21: number, cd22: number): FitsHeader {
	return { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, CRPIX1: 50.5, CRPIX2: 25.5, CRVAL1: 42, CRVAL2: -17, CD1_1: cd11, CD1_2: cd12, CD2_1: cd21, CD2_2: cd22, NAXIS1: 100, NAXIS2: 50 }
}

// A 1000 by 800 TAN solution whose reference pixel is far from the image center.
const OFF_CENTER_TAN: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, RADESYS: 'ICRS', CRVAL1: 42, CRVAL2: -17, CRPIX1: 100, CRPIX2: 700, CD1_1: -0.001, CD1_2: 0.0002, CD2_1: 0.0003, CD2_2: 0.001, NAXIS1: 1000, NAXIS2: 800 }

// A 1200 by 900 TAN-SIP solution of order 3 without reverse polynomials, reference pixel off center.
const OFF_CENTER_SIP: FitsHeader = {
	CTYPE1: RA_TAN_SIP,
	CTYPE2: DEC_TAN_SIP,
	RADESYS: 'ICRS',
	CRVAL1: 150,
	CRVAL2: 30,
	CRPIX1: 400,
	CRPIX2: 250,
	CD1_1: -0.0002,
	CD1_2: 0.00003,
	CD2_1: 0.00004,
	CD2_2: 0.0002,
	NAXIS1: 1200,
	NAXIS2: 900,
	A_ORDER: 3,
	A_2_0: 1e-6,
	A_1_1: -5e-7,
	A_0_2: 2e-7,
	A_3_0: 1e-9,
	A_2_1: 3e-10,
	A_1_2: -4e-10,
	A_0_3: -2e-10,
	B_ORDER: 3,
	B_2_0: -3e-7,
	B_1_1: 6e-7,
	B_0_2: -1e-6,
	B_3_0: 2e-10,
	B_2_1: -1e-10,
	B_1_2: 5e-10,
	B_0_3: 1e-9,
}

describe('plate solution contract', () => {
	test('ICRS and FK5 J2000 frames give the same center', () => {
		const expected = plateSolutionFrom(plateHeaderFromCd(0.01, 0, 0, 0.01))!

		// FITS 4.0 §8: without RADESYS, no EQUINOX means ICRS and an EQUINOX of 1984 or later means FK5.
		for (const frame of [{ RADESYS: 'ICRS' }, { RADESYS: ' fk5 ', EQUINOX: 2000 }, { RADESYS: 'FK5' }, {}, { EQUINOX: 2000 }]) {
			const solution = plateSolutionFrom({ ...plateHeaderFromCd(0.01, 0, 0, 0.01), ...frame })
			expect(solution).toBeDefined()
			expect(solution!.rightAscension).toBe(expected.rightAscension)
			expect(solution!.declination).toBe(expected.declination)
		}
	})

	test('other frames and coordinate systems give no solution', () => {
		for (const frame of [{ RADESYS: 'FK4' }, { RADESYS: 'FK5', EQUINOX: 1950 }, { EQUINOX: 1950 }, { RADESYS: 'GAPPT' }, { CTYPE1: 'GLON-TAN', CTYPE2: 'GLAT-TAN' }, { CTYPE1: 'ELON-TAN', CTYPE2: 'ELAT-TAN' }]) {
			expect(plateSolutionFrom({ ...plateHeaderFromCd(0.01, 0, 0, 0.01), ...frame })).toBeUndefined()
		}
	})

	test('the center is the central pixel, which is CRVAL only when CRPIX is central', () => {
		const solution = plateSolutionFrom(OFF_CENTER_TAN)!
		// Astropy 7.1.0, numpy 2.2.6: WCS.pixel_to_world_values(499.5, 399.5).
		expect(separationArcsec(solution.rightAscension, solution.declination, [41.51811369569679, -17.17877757907346])).toBeLessThan(0.01)
		expect(tanUnproject(OFF_CENTER_TAN, 500.5, 400.5)).toEqual([solution.rightAscension, solution.declination])
		expect(toDeg(Math.abs(solution.rightAscension - deg(42)))).toBeGreaterThan(0.1)

		const centered = plateSolutionFrom({ ...OFF_CENTER_TAN, CRPIX1: 500.5, CRPIX2: 400.5 })!
		expect(centered.rightAscension).toBeCloseTo(deg(42), 12)
		expect(centered.declination).toBeCloseTo(deg(-17), 12)
	})

	test('a TAN-SIP center applies the distortion', () => {
		const solution = plateSolutionFrom(OFF_CENTER_SIP)!
		const linear = plateSolutionFrom({ ...Object.fromEntries(Object.entries(OFF_CENTER_SIP).filter(([key]) => !/^[AB]_/.test(key))), CTYPE1: RA_TAN, CTYPE2: DEC_TAN })!

		// Astropy 7.1.0, numpy 2.2.6: WCS.pixel_to_world_values(599.5, 449.5) with SIP.
		expect(separationArcsec(solution.rightAscension, solution.declination, [149.96061461173204, 30.04811242388725])).toBeLessThan(0.05)
		expect(separationArcsec(linear.rightAscension, linear.declination, [149.96062294484386, 30.048114123864135])).toBeLessThan(0.05)
		expect(separationArcsec(solution.rightAscension, solution.declination, [toDeg(linear.rightAscension), toDeg(linear.declination)])).toBeGreaterThan(0.02)
	})

	test('unknown or non-positive dimensions give no solution', () => {
		const { NAXIS1, NAXIS2, ...base } = plateHeaderFromCd(0.01, 0, 0, 0.01)

		expect(plateSolutionFrom(base)).toBeUndefined()
		expect(plateSolutionFrom({ ...base, IMAGEW: NAXIS1, IMAGEH: NAXIS2 })?.widthInPixels).toBe(100)
		expect(plateSolutionFrom({ ...base, NAXIS1: 0, NAXIS2 })).toBeUndefined()
		expect(plateSolutionFrom({ ...base, NAXIS1, NAXIS2: -50 })).toBeUndefined()
		expect(plateSolutionFrom({ ...base, NAXIS1: Number.POSITIVE_INFINITY, NAXIS2 })).toBeUndefined()
	})

	test('only a declared equatorial TAN or TAN-SIP pair is a solution', () => {
		const { CTYPE1, CTYPE2, ...linear } = plateHeaderFromCd(0.01, 0, 0, 0.01)

		// An absent CTYPE is a linear axis for FITS, although tanUnproject keeps reading it as TAN.
		expect(plateSolutionFrom(linear)).toBeUndefined()
		expect(tanUnproject(linear, 50.5, 25.5)).toBeDefined()
		expect(plateSolutionFrom({ ...linear, CTYPE1 })).toBeUndefined()

		for (const [ctype1, ctype2] of [
			['RA---SIN', 'DEC--SIN'],
			['RA---ZEA', 'DEC--ZEA'],
			['RA---TPV', 'DEC--TPV'],
			[DEC_TAN, RA_TAN],
			[RA_TAN_SIP, DEC_TAN],
			[RA_TAN, DEC_TAN_SIP],
		]) {
			expect(plateSolutionFrom({ ...linear, CTYPE1: ctype1, CTYPE2: ctype2 })).toBeUndefined()
		}

		expect(plateSolutionFrom({ ...linear, CTYPE1: ' ra---tan ', CTYPE2: 'dec--tan' })).toBeDefined()
	})

	test('no neutral solution is exported', () => {
		expect('EMPTY_PLATE_SOLUTION' in platesolver).toBeFalse()
	})
})
