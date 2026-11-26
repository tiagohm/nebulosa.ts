import { describe, expect, test } from 'bun:test'
import { plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { cdFromCdelt, DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP, tanProject, tanUnproject } from '../../../src/astrometry/wcs/fits.wcs'
import { imageTopPositionAngle, imageTopPositionAngleAt } from '../../../src/astrometry/wcs/orientation'
import { PI, TAU } from '../../../src/core/constants'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { sphericalPositionAngle } from '../../../src/math/numerical/geometry'
import { deg, normalizeAngle } from '../../../src/math/units/angle'

// Plate scale of the synthetic headers, degrees per pixel (1″).
const SCALE = 1 / 3600

// Synthetic TAN header of a 1000×800 frame centred on CRPIX, with the CD matrix of CDELT1/CDELT2 (degrees) and CROTA2
// (radians) per WCS Paper II.
function tanHeader(cdelt1: number, cdelt2: number, crota: number, crval1: number = 120, crval2: number = 35): FitsHeader {
	const [cd11, cd12, cd21, cd22] = cdFromCdelt(cdelt1, cdelt2, crota)
	return { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, CRPIX1: 500.5, CRPIX2: 400.5, CRVAL1: crval1, CRVAL2: crval2, CD1_1: cd11, CD1_2: cd12, CD2_1: cd21, CD2_2: cd22, NAXIS1: 1000, NAXIS2: 800 }
}

// Initial bearing, from north through east, of the great circle from a pixel to the pixel a hair above it (decreasing
// row). TAN maps great circles to straight lines, so this is the direction of the image top on the sky, independent of
// the great-circle projection of imageTopPositionAngle.
function bearingOfTop(header: FitsHeader, x: number, y: number) {
	const [ra0, dec0] = tanUnproject(header, x, y)!
	const [ra1, dec1] = tanUnproject(header, x, y - 1e-3)!
	return sphericalPositionAngle(ra0, dec0, ra1, dec1)
}

// Absolute difference between two directions, radians in [0, π].
function angularDifference(a: number, b: number) {
	const difference = normalizeAngle(a - b)
	return Math.min(difference, TAU - difference)
}

// https://nova.astrometry.net/user_images/12367041, as in platesolver.test.ts.
const M101: FitsHeader = {
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

describe('image top position angle', () => {
	test('follows CROTA2 at the reference pixel in both parities', () => {
		for (const crota of [0, deg(30), deg(90), deg(135), deg(200), deg(300)]) {
			// East left, north up when drawn with +Y up: the top as stored (−Y) points south when CROTA2 = 0, so the
			// angle is π − CROTA2. Mirroring X leaves the top unchanged; mirroring Y turns it by π.
			expect(angularDifference(imageTopPositionAngle(tanHeader(-SCALE, SCALE, crota), 500.5, 400.5)!, PI - crota)).toBeLessThan(1e-9)
			expect(angularDifference(imageTopPositionAngle(tanHeader(SCALE, SCALE, crota), 500.5, 400.5)!, PI - crota)).toBeLessThan(1e-9)
			expect(angularDifference(imageTopPositionAngle(tanHeader(-SCALE, -SCALE, crota), 500.5, 400.5)!, -crota)).toBeLessThan(1e-9)
		}
	})

	test('equals atan2(−CD1_2, −CD2_2) at the reference pixel', () => {
		const header = tanHeader(-SCALE, SCALE, deg(57))
		const expected = normalizeAngle(Math.atan2(-(header.CD1_2 as number), -(header.CD2_2 as number)))
		expect(imageTopPositionAngle(header, 500.5, 400.5)).toBeCloseTo(expected, 9)
	})

	test('follows the convergence of the meridians away from the reference pixel', () => {
		for (const header of [tanHeader(-SCALE * 5, SCALE * 5, deg(25), 80, 70), tanHeader(SCALE * 5, SCALE * 5, deg(160), 300, -60)]) {
			for (const [x, y] of [
				[1, 1],
				[1000, 1],
				[1000, 800],
				[1, 800],
				[250, 600],
			] as const) {
				const angle = imageTopPositionAngle(header, x, y)!
				expect(angle).toBeGreaterThanOrEqual(0)
				expect(angle).toBeLessThan(TAU)
				// The gnomonic projection is only conformal at its tangent point: up to ρ = 0.9° off it the north and east
				// directions of the pixel grid shear by up to about ρ²/2 (1.2e-4 rad).
				expect(angularDifference(angle, bearingOfTop(header, x, y))).toBeLessThan(2e-4)
			}

			expect(angularDifference(imageTopPositionAngle(header, 1, 1)!, imageTopPositionAngle(header, 1000, 1)!)).toBeGreaterThan(deg(1))
		}
	})

	test('stays defined and consistent in a field containing the celestial pole', () => {
		const header = tanHeader(-SCALE * 2, SCALE * 2, deg(40), 37, 89.8)
		const [x, y] = tanProject(header, 0, PI / 2)!

		expect(x).toBeGreaterThan(1)
		expect(x).toBeLessThan(1000)
		expect(y).toBeGreaterThan(1)
		expect(y).toBeLessThan(800)

		const atPole = imageTopPositionAngle(header, x, y)!
		expect(Number.isFinite(atPole)).toBeTrue()
		expect(atPole).toBeGreaterThanOrEqual(0)
		expect(atPole).toBeLessThan(TAU)

		// At the pole, north is the direction of the meridian of the right ascension the WCS gives there, so it is the
		// limit of the angle along that meridian, which a great circle through the pole keeps straight in TAN.
		const [ra] = tanUnproject(header, x, y)!
		const [mx, my] = tanProject(header, ra, PI / 2 - deg(0.05))!
		expect(angularDifference(atPole, imageTopPositionAngle(header, mx, my)!)).toBeLessThan(1e-6)
		expect(angularDifference(imageTopPositionAngle(header, mx, my)!, bearingOfTop(header, mx, my))).toBeLessThan(5e-5)

		for (const [px, py] of [
			[1, 1],
			[1000, 800],
			[x + 3, y - 2],
		] as const) {
			expect(angularDifference(imageTopPositionAngle(header, px, py)!, bearingOfTop(header, px, py))).toBeLessThan(5e-5)
		}
	})

	test('wraps into [0, 2π) near north', () => {
		const below = imageTopPositionAngle(tanHeader(-SCALE, SCALE, PI + 1e-6), 500.5, 400.5)!
		const above = imageTopPositionAngle(tanHeader(-SCALE, SCALE, PI - 1e-6), 500.5, 400.5)!
		const exact = imageTopPositionAngle(tanHeader(-SCALE, SCALE, PI), 500.5, 400.5)!

		expect(below).toBeCloseTo(TAU - 1e-6, 9)
		expect(above).toBeCloseTo(1e-6, 9)
		expect(exact).toBeGreaterThanOrEqual(0)
		expect(exact).toBeLessThan(TAU)
		expect(angularDifference(exact, 0)).toBeLessThan(1e-9)
	})

	test('matches the great-circle directions of a SIP solution', () => {
		// Astropy 8.0.3 with numpy 2.5.5: the same great-circle construction with WCS.all_pix2world and the iterative
		// WCS.all_world2pix (forward SIP only, tolerance 1e-12), from 0-based pixels (x - 1, y - 1). The residual is the
		// non-closure of the solver's AP/BP inverse on the forward SIP.
		const expected = [
			[4588.5, 3435.5, 2.921052990730808],
			[1, 1, 2.9000242847836355],
			[9176, 6870, 2.9438489765192934],
		] as const

		for (const [x, y, angle] of expected) {
			expect(Math.abs(imageTopPositionAngle(M101, x, y)! - angle)).toBeLessThan(1e-6)
		}
	})

	test('is undefined when the directions cannot be projected', () => {
		expect(imageTopPositionAngle(tanHeader(0, 0, 0), 500.5, 400.5)).toBeUndefined()
		expect(imageTopPositionAngle({ CTYPE1: RA_TAN, CTYPE2: DEC_TAN }, 1, 1)).toBeUndefined()
	})
})

describe('image top position angle at a sky position', () => {
	const solution = plateSolutionFrom(M101)!

	test('evaluates at the pixel of a position inside the image', () => {
		const [ra, dec] = tanUnproject(M101, 200, 300)!
		const angle = imageTopPositionAngleAt(solution, ra, dec)!
		expect(angle).toBeCloseTo(imageTopPositionAngle(M101, ...tanProject(M101, ra, dec)!)!, 12)
		expect(angularDifference(angle, imageTopPositionAngle(M101, 4588.5, 3435.5)!)).toBeGreaterThan(1e-3)
	})

	test('evaluates at the image centre for the solution centre', () => {
		expect(imageTopPositionAngleAt(solution, solution.rightAscension, solution.declination)).toBeCloseTo(imageTopPositionAngle(M101, 4588.5, 3435.5)!, 9)
	})

	test('falls back to the image centre outside the image or behind the plane', () => {
		const centre = imageTopPositionAngle(M101, 4588.5, 3435.5)!
		const [ra, dec] = tanUnproject(M101, -200, 300)!

		expect(imageTopPositionAngleAt(solution, ra, dec)).toBe(centre)
		expect(imageTopPositionAngleAt(solution, solution.rightAscension + PI, -solution.declination)).toBe(centre)
	})
})
