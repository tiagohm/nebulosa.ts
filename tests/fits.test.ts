import { describe, expect, test } from 'bun:test'
import { dms, hms } from '../src/angle'
import { bitpixInBytes, computeRemainingBytes, declinationKeyword, FITS_BLOCK_SIZE, FITS_HEADER_CARD_SIZE, type FitsHeaderCard, FitsKeywordReader, FitsKeywordWriter, heightKeyword, observationDateKeyword, readFits, rightAscensionKeyword, widthKeyword, writeFits } from '../src/fits'
import { bufferSink, bufferSource } from '../src/io'
import { BITPIXES, CHANNELS, openFits } from './image.util'

test('read and write', async () => {
	const buffer = Buffer.alloc(1024 * 1024 * 18)

	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const sink = bufferSink(buffer)

			await openFits(bitpix, channel, async (a) => {
				await writeFits(sink, a)

				const size = widthKeyword(a.hdus[0].header, 0) * heightKeyword(a.hdus[0].header, 0) * bitpixInBytes(bitpix) * channel
				expect(sink.position).toBe(5760 + size + computeRemainingBytes(size))

				const source = bufferSource(buffer)
				const b = await readFits(source)

				expect(Object.keys(b!.hdus[0].header).length).toBeGreaterThanOrEqual(60)
				expect(b!.hdus[0].header).toEqual(a.hdus[0].header)
				expect(b!.hdus[0].data.size).toEqual(a.hdus[0].data.size!)
				expect(b!.hdus[0].data.offset).toEqual(5760)
			})

			buffer.fill(0)
		}
	}
}, 10000)

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

describe('keywords', () => {
	test('width', () => {
		expect(widthKeyword({ NAXIS1: 1200 }, undefined)).toBe(1200)
		expect(widthKeyword({ IMAGEW: 1400 }, undefined)).toBe(1400)
		expect(widthKeyword({ NAXIS1: 1100, IMAGEW: 1400 }, undefined)).toBe(1100)
	})

	test('height', () => {
		expect(heightKeyword({ NAXIS2: 1200 }, undefined)).toBe(1200)
		expect(heightKeyword({ IMAGEH: 1400 }, undefined)).toBe(1400)
		expect(heightKeyword({ NAXIS2: 1100, IMAGEH: 1400 }, undefined)).toBe(1100)
	})

	test('right ascension', () => {
		expect(rightAscensionKeyword({ OBJCTRA: '12 44 04.261' }, undefined)).toBeCloseTo(hms(12, 44, 4.261), 12)
		expect(rightAscensionKeyword({ RA: 161.0177548315 }, undefined)).toBeCloseTo(hms(10, 44, 4.26115956), 12)
		expect(rightAscensionKeyword({ OBJCTRA: '11 44 04.261', RA: 161.0177548315 }, undefined)).toBeCloseTo(hms(10, 44, 4.26115956), 12)
	})

	test('declination', () => {
		expect(declinationKeyword({ OBJCTDEC: '59 36 08.17' }, undefined)).toBeCloseTo(dms(59, 36, 8.17), 12)
		expect(declinationKeyword({ DEC: -59.6022705034 }, undefined)).toBeCloseTo(dms(-59, 36, 8.17381224), 12)
		expect(declinationKeyword({ OBJCTDEC: '59 36 08.17', DEC: -59.6022705034 }, undefined)).toBeCloseTo(dms(-59, 36, 8.17381224), 12)
	})

	test('observation date', () => {
		expect(observationDateKeyword({ 'DATE-OBS': '2023-01-15T01:27:05.460' })).toBe(1673746025460)
		expect(observationDateKeyword({ 'DATE-END': '2023-01-15T01:27:05.460' })).toBe(1673746025460)
		expect(observationDateKeyword({ DATE: '2023-01-15T01:27:05.460', DEC: -59.6022705034 })).toBe(1673746025460)
		expect(observationDateKeyword({ 'DATE-OBS': '2023-01-15', DATE: '2023-01-15T01:27:05.460' })).toBe(1673740800000)
	})
})
