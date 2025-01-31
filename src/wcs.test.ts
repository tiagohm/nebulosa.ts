import { expect, test } from 'bun:test'
import { deg, parseAngle } from './angle'
import { Wcs } from './wcs'

// https://fits.gsfc.nasa.gov/registry/sip/sipsample.txt
// https://www.atnf.csiro.au/computing/software/wcs/WCS/example_data.html

const centerRA = parseAngle('18h 59m 51s')!
const centerDEC = parseAngle('-66d 15m 57s')!

test('air', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---AIR', CRPIX1: -2.347545010835e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--AIR', CRPIX2: 8.339330824422, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('ait', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---AIT', CRPIX1: -2.462317116277e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--AIT', CRPIX2: 7.115850027049, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('arc', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---ARC', CRPIX1: -2.46941901905e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--ARC', CRPIX2: 5.082274450444, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('azp', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---AZP', CRPIX1: -2.541100848779e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--AZP', CRPIX2: -1.134948542534e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('car', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---CAR', CRPIX1: -2.482173814412e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--CAR', CRPIX2: 7.527038199745, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('cea', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---CEA', CRPIX1: -2.482173814412e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--CEA', CRPIX2: 7.688571124876, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('csc', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---CSC', CRPIX1: -2.686531829635e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--CSC', CRPIX2: -7.043520126533, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 1)
	expect(y).toBeCloseTo(97, 1)
})

test('cyp', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---CYP', CRPIX1: -1.471055514007e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--CYP', CRPIX2: 2.056099939277e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('hpx', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---HPX', CRPIX1: -248.217381441188, CDELT1: -0.0666666666666667, CRVAL1: 0, CTYPE2: 'DEC--HPX', CRPIX2: -8.21754831338666, CDELT2: 0.0666666666666667, CRVAL2: -90, LONPOLE: 180, LATPOLE: 0, RADESYS: 'FK5', EQUINOX: 2000.0 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('mer', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---MER', CRPIX1: -2.482173814412e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--MER', CRPIX2: 7.364978412864, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('mol', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---MOL', CRPIX1: -2.127655947497e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--MOL', CRPIX2: -2.310670994515, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('ncp', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---SIN', CRPIX1: -2.371895431541e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--SIN', CRPIX2: 7.688572009351, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('par', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---PAR', CRPIX1: -2.465551494284e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--PAR', CRPIX2: 3.322937769653, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('pco', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---PCO', CRPIX1: -2.462486098896e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--PCO', CRPIX2: 3.620782775517e-1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('qsc', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---QSC', CRPIX1: -2.583408175994e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--QSC', CRPIX2: -8.258194421088, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('sfl', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---SFL', CRPIX1: -2.463483086237e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--SFL', CRPIX2: 7.527038199745, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('sin', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---SIN', CRPIX1: -2.371895431541e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--SIN', CRPIX2: 7.688571124876, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('stg', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---STG', CRPIX1: -2.51945990929e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--STG', CRPIX2: 3.744942537739, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('szp', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---SZP', CRPIX1: -2.478656972779e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--SZP', CRPIX2: -2.262051956373e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	// expect(ra).toBeCloseTo(centerRA, 13)
	// expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('tan', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---TAN', CRPIX1: -2.680658087122e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--TAN', CRPIX2: -5.630437201085e-1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('tsc', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---TSC', CRPIX1: -1.897220156818e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--TSC', CRPIX2: 2.037416464676e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0.0, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('zea', () => {
	const header = { NAXIS: 2, NAXIS1: 192, NAXIS2: 192, CTYPE1: 'RA---ZEA', CRPIX1: -2.444880690361e2, CDELT1: -6.666666666667e-2, CRVAL1: 0.0, CTYPE2: 'DEC--ZEA', CRPIX2: 5.738055949994, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(97, 97)!

	expect(ra).toBeCloseTo(centerRA, 13)
	expect(dec).toBeCloseTo(centerDEC, 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(97, 8)
	expect(y).toBeCloseTo(97, 8)
})

test('sip', () => {
	const header = {
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

	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(128, 128)!

	expect(ra).toBeCloseTo(deg(202.482322805429), 13)
	expect(dec).toBeCloseTo(deg(47.1751189300101), 13)

	const [x, y] = wcs.skyToPix(ra, dec)!

	expect(x).toBeCloseTo(128, 10)
	expect(y).toBeCloseTo(128, 10)
})
