import { expect, test } from 'bun:test'
import { deg, parseAngle } from '../src/angle'
import type { FitsHeader } from '../src/fits'
import { Wcs } from '../src/wcs'

// https://fits.gsfc.nasa.gov/registry/sip/sipsample.txt
// https://www.atnf.csiro.au/computing/software/wcs/WCS/example_data.html

const doNotRun = process.platform === 'linux'

const centerRA = parseAngle('18h 59m 51s')!
const centerDEC = parseAngle('-66d 15m 57s')!

function project(header: FitsHeader, precision = 12, px = 97, py = 97, pra = centerRA, pdec = centerDEC) {
	using wcs = new Wcs(header)
	const [ra, dec] = wcs.pixToSky(px, py)!

	expect(ra).toBeCloseTo(pra, precision)
	expect(dec).toBeCloseTo(pdec, precision)

	const [x, y] = wcs.skyToPix(pra, pdec)!

	expect(x).toBeCloseTo(px, precision - 4)
	expect(y).toBeCloseTo(py, precision - 4)
}

test.skipIf(doNotRun)('air', () => {
	const header = { CTYPE1: 'RA---AIR', CRPIX1: -2.347545010835e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--AIR', CRPIX2: 8.339330824422, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, PV2_1: 4.5e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('ait', () => {
	const header = { CTYPE1: 'RA---AIT', CRPIX1: -2.462317116277e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--AIT', CRPIX2: 7.115850027049, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('arc', () => {
	const header = { CTYPE1: 'RA---ARC', CRPIX1: -2.46941901905e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--ARC', CRPIX2: 5.082274450444, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('azp', () => {
	const header = { CTYPE1: 'RA---AZP', CRPIX1: -2.541100848779e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--AZP', CRPIX2: -1.134948542534e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, PV2_1: 2.0, PV2_2: 3.0e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('bon', () => {
	const header = { CTYPE1: 'RA---BON', CRPIX1: -2.431263982441e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--BON', CRPIX2: -3.30741266819e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, PV2_1: 4.5e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('car', () => {
	const header = { CTYPE1: 'RA---CAR', CRPIX1: -2.482173814412e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--CAR', CRPIX2: 7.527038199745, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('cea', () => {
	const header = { CTYPE1: 'RA---CEA', CRPIX1: -2.482173814412e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--CEA', CRPIX2: 7.688571124876, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, PV2_1: 1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('cod', () => {
	const header = { CTYPE1: 'RA---COD', CRPIX1: -2.153431714695e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--COD', CRPIX2: 1.561302682707e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -4.5e1, PV2_1: 4.5e1, PV2_2: 2.5e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('coe', () => {
	const header = { CTYPE1: 'RA---COE', CRPIX1: -2.230375366798e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--COE', CRPIX2: -1.435249668783e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 4.5e1, PV2_1: -4.5e1, PV2_2: 2.5e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('coo', () => {
	const header = { CTYPE1: 'RA---COO', CRPIX1: -2.136486051767e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--COO', CRPIX2: 1.292640949564e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -4.5e1, PV2_1: 4.5e1, PV2_2: 2.5e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('cop', () => {
	const header = { CTYPE1: 'RA---COP', CRPIX1: -2.151923139086e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--COP', CRPIX2: 1.505768272737e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -4.5e1, PV2_1: 4.5e1, PV2_2: 2.5e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('csc', () => {
	const header = { CTYPE1: 'RA---CSC', CRPIX1: -2.686531829635e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--CSC', CRPIX2: -7.043520126533, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header, 4)
})

test.skipIf(doNotRun)('cyp', () => {
	const header = { CTYPE1: 'RA---CYP', CRPIX1: -1.471055514007e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--CYP', CRPIX2: 2.056099939277e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, PV2_1: 1, PV2_2: 7.07106781187e-1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('hpx', () => {
	const header = { CTYPE1: 'RA---HPX', CRPIX1: -248.217381441188, CDELT1: -0.0666666666666667, CRVAL1: 0, CTYPE2: 'DEC--HPX', CRPIX2: -8.21754831338666, CDELT2: 0.0666666666666667, CRVAL2: -90, LONPOLE: 180, LATPOLE: 0, RADESYS: 'FK5', EQUINOX: 2000.0 }
	project(header)
})

test.skipIf(doNotRun)('mer', () => {
	const header = { CTYPE1: 'RA---MER', CRPIX1: -2.482173814412e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--MER', CRPIX2: 7.364978412864, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('mol', () => {
	const header = { CTYPE1: 'RA---MOL', CRPIX1: -2.127655947497e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--MOL', CRPIX2: -2.310670994515, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('ncp', () => {
	const header = { CTYPE1: 'RA---SIN', CRPIX1: -2.371895431541e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--SIN', CRPIX2: 7.688572009351, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, PV2_1: 0, PV2_2: -1.216796447506e-8, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('par', () => {
	const header = { CTYPE1: 'RA---PAR', CRPIX1: -2.465551494284e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--PAR', CRPIX2: 3.322937769653, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('pco', () => {
	const header = { CTYPE1: 'RA---PCO', CRPIX1: -2.462486098896e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--PCO', CRPIX2: 3.620782775517e-1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('qsc', () => {
	const header = { CTYPE1: 'RA---QSC', CRPIX1: -2.583408175994e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--QSC', CRPIX2: -8.258194421088, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('sfl', () => {
	const header = { CTYPE1: 'RA---SFL', CRPIX1: -2.463483086237e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--SFL', CRPIX2: 7.527038199745, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('sin', () => {
	const header = { CTYPE1: 'RA---SIN', CRPIX1: -2.371895431541e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--SIN', CRPIX2: 7.688571124876, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, PV2_1: 0, PV2_2: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('stg', () => {
	const header = { CTYPE1: 'RA---STG', CRPIX1: -2.51945990929e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--STG', CRPIX2: 3.744942537739, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('szp', () => {
	const header = { CTYPE1: 'RA---SZP', CRPIX1: -2.478656972779e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--SZP', CRPIX2: -2.262051956373e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, PV2_1: 2.0, PV2_2: 1.8e2, PV2_3: 6.0e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('tan', () => {
	const header = { CTYPE1: 'RA---TAN', CRPIX1: -2.680658087122e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--TAN', CRPIX2: -5.630437201085e-1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('tsc', () => {
	const header = { CTYPE1: 'RA---TSC', CRPIX1: -1.897220156818e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--TSC', CRPIX2: 2.037416464676e1, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: 0, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('zea', () => {
	const header = { CTYPE1: 'RA---ZEA', CRPIX1: -2.444880690361e2, CDELT1: -6.666666666667e-2, CRVAL1: 0, CTYPE2: 'DEC--ZEA', CRPIX2: 5.738055949994, CDELT2: 6.666666666667e-2, CRVAL2: -9.0e1, LONPOLE: 1.8e2, LATPOLE: -9.0e1, EQUINOX: 2.0e3 }
	project(header)
})

test.skipIf(doNotRun)('zpn', () => {
	const header = {
		CTYPE1: 'RA---ZPN',
		CRPIX1: -1.832937255632e2,
		CDELT1: -6.666666666667e-2,
		CRVAL1: 0,
		CTYPE2: 'DEC--ZPN',
		CRPIX2: 2.209211120575e1,
		CDELT2: 6.666666666667e-2,
		CRVAL2: -9.0e1,
		LONPOLE: 1.8e2,
		LATPOLE: -9.0e1,
		PV2_0: 5.0e-2,
		PV2_1: 9.75e-1,
		PV2_2: -8.07e-1,
		PV2_3: 3.37e-1,
		PV2_4: -6.5e-2,
		PV2_5: 1.0e-2,
		PV2_6: 3.0e-3,
		PV2_7: -1.0e-3,
		PV2_8: 0,
		PV2_9: 0,
		EQUINOX: 2.0e3,
	}

	project(header)
})

test.skipIf(doNotRun)('sip', () => {
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

	project(header, 13, 128, 128, deg(202.482322805429), deg(47.1751189300101))
})
