import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { readFits } from '../src/fits'
import { type Hips2FitsOptions, hips2Fits, hipsSurveys } from '../src/hips2fits'
import { bufferSource } from '../src/io'

test.skip('fits', async () => {
	const options: Hips2FitsOptions = { width: 400, height: 400 }
	const blob = await hips2Fits('CDS/P/DSS2/red', deg(201.36506337683), deg(-43.01911250808), options)
	const buffer = Buffer.from(await blob.arrayBuffer())
	console.log(buffer.byteLength)
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

test.skip('hipsSurveys', async () => {
	const surveys = await hipsSurveys()

	expect(surveys).toHaveLength(116)
	expect(surveys[0].id).toBe('CDS/P/2MASS/H')
	expect(surveys[0].category).toBe('Image/Infrared/2MASS')
	expect(surveys[0].frame).toBe('equatorial')
	expect(surveys[0].regime).toBe('infrared')
	expect(surveys[0].bitpix).toBe(-32)
	expect(surveys[0].pixelScale).toBe(2.236e-4)
	expect(surveys[0].skyFraction).toBe(1)
})
