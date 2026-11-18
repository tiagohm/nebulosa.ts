import { expect, test } from 'bun:test'
import { HIPS2FITS_ALTERNATIVE_URL, HIPS2FITS_BASE_URL, type Hips2FitsOptions, hips2Fits, hips2FitsUrl, hipsSurveys, hipsSurveysUrl, parseHipsSurveys } from '../../../src/adapters/sky/hips2fits'
import { readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { deg } from '../../../src/math/units/angle'
import { isNetworkTestSkipped } from '../../util'

const SKIP = isNetworkTestSkipped()

test('cutout url', () => {
	const url = new URL(hips2FitsUrl('CDS/P/DSS2/color', deg(83.82), deg(-5.39), { width: 800, height: 600, fov: deg(2), rotation: deg(30), format: 'jpg', baseUrl: HIPS2FITS_ALTERNATIVE_URL }))

	expect(url.origin).toBe('http://alaskybis.cds.unistra.fr')
	expect(url.pathname).toBe('/hips-image-services/hips2fits')
	expect(url.searchParams.get('hips')).toBe('CDS/P/DSS2/color')
	expect(+url.searchParams.get('ra')!).toBeCloseTo(83.82, 12)
	expect(+url.searchParams.get('dec')!).toBeCloseTo(-5.39, 12)
	expect(url.searchParams.get('width')).toBe('800')
	expect(url.searchParams.get('height')).toBe('600')
	expect(+url.searchParams.get('fov')!).toBeCloseTo(2, 12)
	expect(+url.searchParams.get('rotation_angle')!).toBeCloseTo(30, 12)
	expect(url.searchParams.get('projection')).toBe('TAN')
	expect(url.searchParams.get('coordsys')).toBe('icrs')
	expect(url.searchParams.get('format')).toBe('jpg')
})

test('cutout url defaults', () => {
	const url = new URL(hips2FitsUrl('CDS/P/DSS2/red', 0, 0))

	expect(url.origin).toBe(new URL(HIPS2FITS_BASE_URL).origin)
	expect(url.searchParams.get('width')).toBe('1200')
	expect(url.searchParams.get('height')).toBe('900')
	expect(+url.searchParams.get('fov')!).toBeCloseTo(1, 12)
	expect(url.searchParams.get('rotation_angle')).toBe('0')
	expect(url.searchParams.get('format')).toBe('fits')
})

test('surveys url', () => {
	const url = new URL(hipsSurveysUrl(0.5))

	expect(url.pathname).toBe('/MocServer/query')
	expect(url.searchParams.get('get')).toBe('record')
	expect(url.searchParams.get('fmt')).toBe('json')
	expect(url.searchParams.get('expr')).toContain('moc_sky_fraction >= 0.5')
})

test('parse surveys', () => {
	const [survey, bare] = parseHipsSurveys([
		{
			ID: 'CDS/P/DSS2/color',
			client_category: 'Image/Optical/DSS',
			hips_frame: 'equatorial',
			obs_regime: 'Optical',
			hips_pixel_bitpix: '0',
			hips_pixel_scale: '2.236e-4',
			moc_sky_fraction: '1',
			obs_title: 'DSS colored',
			obs_copyright: 'Digitized Sky Survey - STScI/NASA',
			obs_copyright_url: 'https://archive.stsci.edu/dss/',
		},
		{ ID: 'CDS/P/2MASS/H', client_category: 'Image/Infrared/2MASS', hips_frame: 'equatorial', obs_regime: 'Infrared', hips_pixel_bitpix: '-32', hips_pixel_scale: '2.236e-4', moc_sky_fraction: '1' },
	])

	expect(survey).toEqual({ id: 'CDS/P/DSS2/color', category: 'Image/Optical/DSS', frame: 'equatorial', regime: 'optical', bitpix: 0, pixelScale: 2.236e-4, skyFraction: 1, title: 'DSS colored', copyright: 'Digitized Sky Survey - STScI/NASA', copyrightUrl: 'https://archive.stsci.edu/dss/' })
	expect(bare).toEqual({ id: 'CDS/P/2MASS/H', category: 'Image/Infrared/2MASS', frame: 'equatorial', regime: 'infrared', bitpix: -32, pixelScale: 2.236e-4, skyFraction: 1 })
})

test.skipIf(SKIP)('fits', async () => {
	const options: Hips2FitsOptions = { width: 400, height: 400, baseUrl: HIPS2FITS_ALTERNATIVE_URL }
	const blob = await hips2Fits('CDS/P/DSS2/red', deg(201.36506337683), deg(-43.01911250808), options)
	const buffer = Buffer.from(await blob!.arrayBuffer())
	const source = bufferSource(buffer)
	const fits = await readFits(source)
	const header = fits!.hdus[0].header

	expect(header.SIMPLE).toBeTrue()
	expect(header.BITPIX).toBe(16)
	expect(header.NAXIS).toBe(2)
	expect(header.NAXIS1).toBe(400)
	expect(header.NAXIS2).toBe(400)
	expect(header.WCSAXES).toBe(2)
	expect(header.CRPIX1).toBe(200)
	expect(header.CRPIX2).toBe(200)
	expect(header.CDELT1).toBeCloseTo(-0.0025000634638957, 8)
	expect(header.CDELT2).toBeCloseTo(0.0025000634638957, 8)
	expect(header.CUNIT1).toBe('deg')
	expect(header.CUNIT2).toBe('deg')
	expect(header.CTYPE1).toBe('RA---TAN')
	expect(header.CTYPE2).toBe('DEC--TAN')
	expect(header.CRVAL1).toBeCloseTo(201.36506337683, 8)
	expect(header.CRVAL2).toBeCloseTo(-43.01911250808, 8)
	expect(header.LONPOLE).toBe(180)
	expect(header.LATPOLE).toBeCloseTo(-43.01911250808, 8)
	expect(header.RADESYS).toBe('ICRS')
})

test.skipIf(SKIP)('hips surveys', async () => {
	const surveys = await hipsSurveys()

	expect(surveys.length).toBeGreaterThanOrEqual(98)
	expect(surveys[0].id).toBe('CDS/P/2MASS/H')
	expect(surveys[0].category).toBe('Image/Infrared/2MASS')
	expect(surveys[0].frame).toBe('equatorial')
	expect(surveys[0].regime).toBe('infrared')
	expect(surveys[0].bitpix).toBe(-32)
	expect(surveys[0].pixelScale).toBe(2.236e-4)
	expect(surveys[0].skyFraction).toBe(1)
})
