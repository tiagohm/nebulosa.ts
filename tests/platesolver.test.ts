import { expect, test } from 'bun:test'
import { toArcsec, toDeg } from '../src/angle'
import type { FitsHeader } from '../src/fits'
import { plateSolutionFrom } from '../src/platesolver'

// https://nova.astrometry.net/user_images/12367041
test('M101', () => {
	const header: FitsHeader = {
		SIMPLE: true,
		BITPIX: 8,
		NAXIS: 0,
		WCSAXES: 2,
		CTYPE1: 'RA---TAN-SIP',
		CTYPE2: 'DEC--TAN-SIP',
		EQUINOX: 2000.0,
		LONPOLE: 180.0,
		LATPOLE: 0.0,
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

	expect(solution.solved).toBeTrue()
	expect(180 - toDeg(solution.orientation)).toBeCloseTo(191.8, 1)
	expect(toArcsec(solution.scale)).toBeCloseTo(0.887, 3)
	expect(toDeg(solution.rightAscension)).toBeCloseTo(211.79, 3)
	expect(toDeg(solution.declination)).toBeCloseTo(54.325, 3)
	expect(toDeg(solution.width)).toBeCloseTo(2.26, 2)
	expect(toDeg(solution.height)).toBeCloseTo(1.69, 2)
	expect(toDeg(solution.radius)).toBeCloseTo(1.411, 3)
	expect(solution.parity).toBe('NORMAL')
	expect(solution.widthInPixels).toBe(9176)
	expect(solution.heightInPixels).toBe(6870)

	for (const key in header) {
		expect(solution[key]).toBe(header[key]!)
	}
})
