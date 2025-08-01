import { expect, test } from 'bun:test'
import { dms, hms } from '../src/angle'
import { computeRemainingBytes, FITS_BLOCK_SIZE, FITS_HEADER_CARD_SIZE, type FitsHeaderCard, FitsKeywordReader, FitsKeywordWriter, readFits, writeFits } from '../src/fits'
import { bitpixInBytes, declination, height, rightAscension, width } from '../src/fits.util'
import { bufferSink, bufferSource } from '../src/io'
import { BITPIXES, CHANNELS, openFits } from './image.util'

test('read and write', async () => {
	const buffer = Buffer.alloc(1024 * 1024 * 18)

	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const a = await openFits(bitpix, channel)
			const sink = bufferSink(buffer)
			await writeFits(sink, a)

			const size = width(a.hdus[0].header) * height(a.hdus[0].header) * bitpixInBytes(bitpix) * channel
			expect(sink.position).toBe(5760 + size + computeRemainingBytes(size))

			const source = bufferSource(buffer)
			const b = await readFits(source)

			expect(Object.keys(b!.hdus[0].header).length).toBeGreaterThanOrEqual(60)
			expect(b!.hdus[0].header).toEqual(a.hdus[0].header)
			expect(b!.hdus[0].data.size).toEqual(a.hdus[0].data.size!)
			expect(b!.hdus[0].data.offset).toEqual(5760)

			buffer.fill(0)
		}
	}
}, 15000)

test('reader', () => {
	const reader = new FitsKeywordReader()
	const buffer = Buffer.allocUnsafe(FITS_HEADER_CARD_SIZE * 2)
	const offset = Math.trunc(Math.random() * FITS_HEADER_CARD_SIZE)

	function read(line: string) {
		buffer.fill(32).write(line, offset, 'ascii')
		return reader.read(buffer, offset)
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
	const offset = Math.trunc(Math.random() * (FITS_BLOCK_SIZE / 2)) + 1

	function write(card: FitsHeaderCard, expectedLength: number = FITS_HEADER_CARD_SIZE) {
		const n = writer.write(card, buffer, offset)
		expect(n).toBe(expectedLength)
		return buffer.toString('ascii', offset, offset + n)
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

test('width', () => {
	expect(width({ NAXIS1: 1200 })).toBe(1200)
	expect(width({ IMAGEW: 1200 })).toBe(1200)
})

test('height', () => {
	expect(height({ NAXIS2: 1200 })).toBe(1200)
	expect(height({ IMAGEH: 1200 })).toBe(1200)
})

test('rightAscension', () => {
	expect(rightAscension({ OBJCTRA: '10 44 04.261' })).toBeCloseTo(hms(10, 44, 4.261), 12)
	expect(rightAscension({ RA: 161.0177548315 })).toBeCloseTo(hms(10, 44, 4.26115956), 12)
})

test('declination', () => {
	expect(declination({ OBJCTDEC: '-59 36 08.17' })).toBeCloseTo(dms(-59, 36, 8.17), 12)
	expect(declination({ DEC: -59.6022705034 })).toBeCloseTo(dms(-59, 36, 8.17381224), 12)
})
