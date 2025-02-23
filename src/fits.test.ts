import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { FITS_BLOCK_SIZE, readFits, writeFits } from './fits'
import { bufferSink, bufferSource, fileHandleSource } from './io'

test('read', async () => {
	const handle = await fs.open('data/fits/NGC3372-color-byte.fits')
	await using source = fileHandleSource(handle)
	const fits = await readFits(source)

	expect(fits!.hdus).toHaveLength(1)

	const [hdu] = fits!.hdus
	const { header, data } = hdu

	expect(hdu.offset).toBe(0)
	expect(header.SIMPLE).toBe(true)
	expect(header.BITPIX).toBe(8)
	expect(header.NAXIS).toBe(3)
	expect(header.NAXIS1).toBe(256)
	expect(header.NAXIS2).toBe(174)
	expect(header.NAXIS3).toBe(3)
	expect(header.EXTEND).toBe(true)
	expect(header.PROGRAM).toBe('PixInsight 1.8.9-3')
	expect(header.ROWORDER).toBe('TOP-DOWN')
	expect(header['DATE-OBS']).toBe('2023-01-15T01:27:05.460')
	expect(header.EXPTIME).toBe(30)
	expect(header.EXPOSURE).toBe(30)
	expect(header['SET-TEMP']).toBe(-10)
	expect(header['CCD-TEMP']).toBe(-10)
	expect(header.XBINNING).toBe(4)
	expect(header.YBINNING).toBe(4)
	expect(header.XORGSUBF).toBe(0)
	expect(header.YORGSUBF).toBe(0)
	expect(header.READOUTM).toBe('Mode0')
	expect(header.FILTER).toBe('Luminance+Red+Green+Blue')
	expect(header.IMAGETYP).toBe('Light Frame')
	expect(header.APTDIA).toBe(152)
	expect(header.APTAREA).toBe(18145.8396720886)
	expect(header.EGAIN).toBe(1.00224268436432)
	expect(header.GAIN).toBe(120)
	expect(header.OFFSET).toBe(30)
	expect(header.FOCUSPOS).toBe(1850)
	expect(header.FOCUSSSZ).toBe(10)
	expect(header.FOCUSTEM).toBe(31.5200004577637)
	expect(header.OBJECT).toBe('NGC3372')
	expect(header.PIERSIDE).toBe('WEST')
	expect(header.JD).toBe(2459959.56006319)
	expect(header['JD-HELIO']).toBe(2459959.56036103)
	expect(header.AIRMASS).toBe(2.05926677068602)
	expect(header.TELESCOP).toBe('')
	expect(header.INSTRUME).toBe('ASI Camera (1)')
	expect(header.OBSERVER).toBe('')
	expect(header.NOTES).toBe('')
	expect(header.FLIPSTAT).toBe('')
	expect(header.HISTORY).toBe('Dark Subtraction (Dark 19, 2072 x 1411, Bin4 x 4, Temp -10C,')
	expect(header.CALSTAT).toBe('D')
	expect(header.PEDESTAL).toBe(-100)
	expect(header.SWOWNER).toBe('Tiago Melo')
	expect(header.INPUTFMT).toBe('FITS')
	expect(header.SNAPSHOT).toBe(9)
	expect(header.MIDPOINT).toBe('2023-01-15T01:38:15.42')
	expect(header.CSTRETCH).toBe('High')
	expect(header.CBLACK).toBe(103)
	expect(header.CWHITE).toBe(1292)
	expect(header.RA).toBe(161.0177548315)
	expect(header.DEC).toBe(-59.6022705034)
	expect(header.TIMESYS).toBe('UTC')
	expect(header['DATE-END']).toBe('2023-01-15T01:27:35.460')
	expect(header.OBJCTRA).toBe('10 44 04.261')
	expect(header.OBJCTDEC).toBe('-59 36 08.17')
	expect(header.CUNIT1).toBe('deg')
	expect(header.PLTSOLVD).toBe(true)
	expect(header.DATAMIN).toBe(0)
	expect(header.DATAMAX).toBe(65535)
	expect(header.COMMENT).toBe(`FITS (Flexible Image Transport System) format is defined in 'Astronomy\nand Astrophysics', volume 376, page 359; bibcode: 2001A&A...376..359H\nPixInsight Class Library: PCL 2.7.0\nFITS module version 1.2.0\n7  Solved in 1.5 sec. Offset 0.3". Mount offset RA=0.0", DEC=0.3"`)

	expect(data?.size).toBe(256 * 174 * 3 * 1)
	expect(data?.offset).toBe(5760)
})

test('write', async () => {
	const handle = await fs.open('data/fits/NGC3372-color-byte.fits')
	await using fileSource = fileHandleSource(handle)
	const fits0 = await readFits(fileSource)

	const size = (await handle.stat()).size
	const buffer = Buffer.allocUnsafe(size)
	const sink = bufferSink(buffer)

	await writeFits(sink, fits0!)

	expect(sink.position).toBe(size)

	const source = bufferSource(buffer)
	const fits1 = await readFits(source)

	expect(fits1!.hdus[0].header).toEqual(fits0!.hdus[0].header)
	expect(fits1!.hdus[0].data.size).toEqual(fits0!.hdus[0].data.size)
	expect(fits1!.hdus[0].data.offset).toEqual(fits0!.hdus[0].data.offset)
})

describe('header', () => {
	const buffer = Buffer.alloc(FITS_BLOCK_SIZE, ' ')

	test('SIMPLE', async () => {
		buffer.write('SIMPLE  = T', 0)
		buffer.write('END', 80)

		const fits = await readFits(bufferSource(buffer))
		const { header } = fits!.hdus[0]

		expect(header.SIMPLE).toBeTrue()
	})

	test('NAXIS', async () => {
		buffer.write('SIMPLE  = T', 0)
		buffer.write('NAXIS   = 3', 80)
		buffer.write('END', 160)

		const fits = await readFits(bufferSource(buffer))
		const { header } = fits!.hdus[0]

		expect(header.NAXIS).toBe(3)
	})

	test('INSTRUME', async () => {
		buffer.write('SIMPLE  = T', 0)
		buffer.write("INSTRUME= 'ASI Camera (1)'", 80)
		buffer.write('END', 160)

		const fits = await readFits(bufferSource(buffer))
		const { header } = fits!.hdus[0]

		expect(header.INSTRUME).toBe('ASI Camera (1)')
	})

	test('DEC', async () => {
		buffer.write('SIMPLE  = T', 0)
		buffer.write('DEC     =       -59.6022705034 / Declination of the center of the image (deg)', 80)
		buffer.write('END', 160)

		const fits = await readFits(bufferSource(buffer))
		const { header } = fits!.hdus[0]

		expect(header.DEC).toBe(-59.6022705034)
	})

	test('COMMENT', async () => {
		buffer.write('SIMPLE  = T', 0)
		buffer.write("COMMENT   FITS (Flexible Image Transport System) format is defined in 'Astronomy", 80)
		buffer.write("COMMENT   and Astrophysics', volume 376, page 359; bibcode: 2001A&A...376..359H ", 160)
		buffer.write('END', 240)

		const fits = await readFits(bufferSource(buffer))
		const { header } = fits!.hdus[0]

		expect(header.COMMENT).toBe("FITS (Flexible Image Transport System) format is defined in 'Astronomy\nand Astrophysics', volume 376, page 359; bibcode: 2001A&A...376..359H")
	})

	test('CONTINUE', async () => {
		buffer.write('SIMPLE  = T', 0)
		buffer.write("SVALUE  = 'This is a long string value &'", 80)
		buffer.write("CONTINUE  'extending&     '", 160)
		buffer.write("CONTINUE  ' over 3 lines. '", 240)
		buffer.write('END', 320)

		const fits = await readFits(bufferSource(buffer))
		const { header } = fits!.hdus[0]

		expect(header.SVALUE).toBe('This is a long string value extending over 3 lines.')
	})
})
