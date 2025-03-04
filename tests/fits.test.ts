import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { FITS_BLOCK_SIZE, FITS_HEADER_CARD_SIZE, type FitsHeaderCard, FitsKeywordReader, FitsKeywordWriter, readFits, writeFits } from '../src/fits'
import { bufferSink, bufferSource, fileHandleSource } from '../src/io'

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
	expect(fits1!.hdus[0].data.size).toEqual(fits0!.hdus[0].data.size!)
	expect(fits1!.hdus[0].data.offset).toEqual(fits0!.hdus[0].data.offset!)
})

test('reader', () => {
	const reader = new FitsKeywordReader()
	const buffer = Buffer.allocUnsafe(FITS_HEADER_CARD_SIZE)

	function read(line: string) {
		buffer.fill(' ').write(line)
		return reader.read(buffer)
	}

	expect(read('SIMPLE  =                    T / file does conform to FITS standard')).toEqual(['SIMPLE', true, 'file does conform to FITS standard'])
	expect(read('BITPIX  =                   16 / number of bits per data pixel')).toEqual(['BITPIX', 16, 'number of bits per data pixel'])
	expect(read("DATE    = '2007-08-08T19:29:51.619' / date this file was written")).toEqual(['DATE', '2007-08-08T19:29:51.619', 'date this file was written'])
	expect(read('CDELT1  = -2.23453599999999991165E-04 / arcsec per x-pixel in degrees')).toEqual(['CDELT1', -2.23453599999999991165e-4, 'arcsec per x-pixel in degrees'])
	expect(read("COMMENT   FITS (Flexible Image Transport System) format is defined in 'Astronomy")).toEqual(['COMMENT', undefined, "FITS (Flexible Image Transport System) format is defined in 'Astronomy"])
	expect(read('COMMENT   /')).toEqual(['COMMENT', undefined, '/'])
	// expect(read("HIERARCH ESO DET CHIP1 DATE  = '11/11/99'   / Date of installation [YYYY-MM-DD]")).toEqual(['HIERARCH.ESO.DET.CHIP1.DATE', '11/11/99', 'Date of installation [YYYY-MM-DD]'])
	expect(read('END')).toEqual(['END', undefined, undefined])
})

test('writer', () => {
	const writer = new FitsKeywordWriter()
	const buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE)

	function write(card: FitsHeaderCard, expectedLength: number = FITS_HEADER_CARD_SIZE) {
		const n = writer.write(card, buffer)
		expect(n).toBe(expectedLength)
		return buffer.toString('ascii', 0, n)
	}

	expect(write(['SIMPLE', true, 'file does conform to FITS standard'])).toBe('SIMPLE  =                    T / file does conform to FITS standard             ')
	expect(write(['BITPIX', 16, 'number of bits per data pixel'])).toBe('BITPIX  =                   16 / number of bits per data pixel                  ')
	expect(write(['DATE', '2007-08-08T19:29:51.619', 'date this file was written'])).toBe("DATE    = '2007-08-08T19:29:51.619' / date this file was written                ")
	expect(write(['CDELT1', -2.23453599999999991165e-4, 'arcsec per x-pixel in degrees'])).toBe('CDELT1  = -2.23453599999999991165E-4 / arcsec per x-pixel in degrees            ')
	expect(write(['COMMENT', undefined, "FITS (Flexible Image Transport System) format is defined in 'Astronomy"])).toBe("COMMENT  FITS (Flexible Image Transport System) format is defined in 'Astronomy ")
	expect(write(['COMMENT', undefined, '/'])).toBe('COMMENT  /                                                                      ')
	expect(write(['END', undefined, undefined])).toBe('END                                                                             ')
})

test('continue', async () => {
	const source = Buffer.allocUnsafe(400)

	source.write('SIMPLE  =                    T                                                  ', 0)
	source.write("TEXT    = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed pharet&'", 80)
	source.write("CONTINUE  'ra nulla leo, ut porta lorem sodales vel. Maecenas ut felis tincidu&'", 160)
	source.write("CONTINUE  'nt mauris faucibus accumsan et ac nibh.'                             ", 240)
	source.write('END                                                                             ', 320)

	const fits = await readFits(bufferSource(source))
	const { header } = fits!.hdus[0]

	expect(header.TEXT).toBe('Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed pharetra nulla leo, ut porta lorem sodales vel. Maecenas ut felis tincidunt mauris faucibus accumsan et ac nibh.')

	const sink = Buffer.allocUnsafe(400)
	await writeFits(bufferSink(sink), fits!)

	expect(sink).toEqual(source)
})

test('escape', async () => {
	const source = Buffer.allocUnsafe(400)

	source.write('SIMPLE  =                    T                                                  ', 0)
	source.write("TEXT0   = 'It''s a beautiful day outside.'                                      ", 80)
	source.write("TEXT1   = 'The teacher said, ''Homework is due tomorrow.'''                     ", 160)
	source.write("TEXT2   = 'The word ''paradox'' perfectly describes the situation.'             ", 240)
	source.write('END                                                                             ', 320)

	const fits = await readFits(bufferSource(source))
	const { header } = fits!.hdus[0]

	expect(header.TEXT0).toBe("It's a beautiful day outside.")
	expect(header.TEXT1).toBe("The teacher said, 'Homework is due tomorrow.'")
	expect(header.TEXT2).toBe("The word 'paradox' perfectly describes the situation.")

	const sink = Buffer.allocUnsafe(400)
	await writeFits(bufferSink(sink), fits!)

	expect(sink).toEqual(source)
})
