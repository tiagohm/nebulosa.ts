import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { dms, hms } from '../src/angle'
import { declinationKeyword, FITS_BLOCK_SIZE, FITS_HEADER_CARD_SIZE, type FitsHeader, type FitsHeaderCard, FitsKeywordReader, FitsKeywordWriter, heightKeyword, isFits, observationDateKeyword, readFits, rightAscensionKeyword, widthKeyword, writeFits } from '../src/fits'
import { KEYWORDS } from '../src/fits.headers'
import { readImageFromBuffer, readImageFromFits, readImageFromPath } from '../src/image'
import { bufferSink, fileHandleSource } from '../src/io'
import { BITPIXES, CHANNELS, saveImageAndCompareHash } from './image.util'

test('is fits', async () => {
	const buffer = await Bun.file('data/NGC3372-8.1.fit').arrayBuffer()
	expect(isFits(buffer)).toBeTrue()
})

describe('read', () => {
	test('mono 8-bit', async () => {
		const handle = await fs.open('data/NGC3372-8.1.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-mono-8', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color 8-bit', async () => {
		const handle = await fs.open('data/NGC3372-8.3.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-color-8', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono 16-bit', async () => {
		const handle = await fs.open('data/NGC3372-16.1.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-mono-16', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color 16-bit', async () => {
		const handle = await fs.open('data/NGC3372-16.3.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-color-16', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono 32-bit', async () => {
		const handle = await fs.open('data/NGC3372-32.1.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-mono-32', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color 32-bit', async () => {
		const handle = await fs.open('data/NGC3372-32.3.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-color-32', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono float 32-bit', async () => {
		const handle = await fs.open('data/NGC3372--32.1.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-mono-F32', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color float 32-bit', async () => {
		const handle = await fs.open('data/NGC3372--32.3.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-color-F32', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono float 64-bit', async () => {
		const handle = await fs.open('data/NGC3372--64.1.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-mono-F64', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color float 64-bit', async () => {
		const handle = await fs.open('data/NGC3372--64.3.fit')
		await using source = fileHandleSource(handle)
		const fits = await readFits(source)
		const image = await readImageFromFits(fits!, source)
		await saveImageAndCompareHash(image!, 'fits-color-F64', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})
})

test('write fits', async () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)

	for (const channel of CHANNELS) {
		for (const bitpix of BITPIXES) {
			buffer.fill(20)

			const image = (await readImageFromPath(`data/NGC3372-${bitpix}.${channel}.fit`))!

			const sink = bufferSink(buffer)
			await writeFits(sink, [image])

			const output = (await readImageFromBuffer(buffer))!

			expect(Object.keys(output.header).length).toBeGreaterThanOrEqual(60)
			expect(output.header).toEqual(image.header)

			await saveImageAndCompareHash(output, `write-fits-${bitpix}-${channel}`, channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4')
		}
	}
}, 10000)

test('read keyword', () => {
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

test('write keyword', () => {
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

test('write all keywords', () => {
	FitsKeywordWriter.keywords = KEYWORDS

	const writer = new FitsKeywordWriter()
	const buffer = Buffer.allocUnsafe(FITS_BLOCK_SIZE)

	function write(card: FitsHeader, expectedLength: number = FITS_HEADER_CARD_SIZE) {
		const n = writer.writeAll(card, buffer)
		expect(n).toBe(expectedLength)
		return buffer.toString('ascii', 0, n)
	}

	expect(write({ SIMPLE: true })).toBe('SIMPLE  =                    T / Primary HDU                                    ')
	expect(write({ BITPIX: 16 })).toBe('BITPIX  =                   16 / Bits per data element                          ')
	expect(write({ DATE: '2007-08-08T19:29:51.619' })).toBe("DATE    = '2007-08-08T19:29:51.619' / Date of file creation                     ")
	expect(write({ CDELT1: -2.23453599999999991165e-4 })).toBe('CDELT1  = -2.23453599999999991165E-4 / Coordinate spacing along axis            ')
	expect(write({ COMMENT: "FITS (Flexible Image Transport System) format is defined in 'Astronomy" })).toBe("COMMENT  FITS (Flexible Image Transport System) format is defined in 'Astronomy ")
	expect(write({ COMMENT: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, 160)).toBe(
		'COMMENT  AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA COMMENT  BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB ',
	)
	expect(write({ COMMENT: '/' })).toBe('COMMENT  /                                                                      ')
})

test('continue keyword', () => {
	FitsKeywordWriter.keywords = {}

	const source = Buffer.allocUnsafe(400)

	source.write('SIMPLE  =                    T                                                  ', 0)
	source.write("TEXT    = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed pharet&'", 80)
	source.write("CONTINUE  'ra nulla leo, ut porta lorem sodales vel. Maecenas ut felis tincidu&'", 160)
	source.write("CONTINUE  'nt mauris faucibus accumsan et ac nibh.'                             ", 240)
	source.write('END                                                                             ', 320)

	const reader = new FitsKeywordReader()
	const header = reader.readAll(source)

	expect(header.SIMPLE).toBeTrue()
	expect(header.TEXT).toBe('Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed pharetra nulla leo, ut porta lorem sodales vel. Maecenas ut felis tincidunt mauris faucibus accumsan et ac nibh.')

	const sink = Buffer.allocUnsafe(400)
	const writer = new FitsKeywordWriter()
	writer.writeAll(header, sink)
	writer.write(['END'], sink, 320)

	expect(sink).toEqual(source)
})

test('escape keyword', () => {
	FitsKeywordWriter.keywords = {}

	const source = Buffer.allocUnsafe(400)

	source.write('SIMPLE  =                    T                                                  ', 0)
	source.write("TEXT0   = 'It''s a beautiful day outside.'                                      ", 80)
	source.write("TEXT1   = 'The teacher said, ''Homework is due tomorrow.'''                     ", 160)
	source.write("TEXT2   = 'The word ''paradox'' perfectly describes the situation.'             ", 240)
	source.write('END                                                                             ', 320)

	const reader = new FitsKeywordReader()
	const header = reader.readAll(source)

	expect(header.SIMPLE).toBeTrue()
	expect(header.TEXT0).toBe("It's a beautiful day outside.")
	expect(header.TEXT1).toBe("The teacher said, 'Homework is due tomorrow.'")
	expect(header.TEXT2).toBe("The word 'paradox' perfectly describes the situation.")

	const sink = Buffer.allocUnsafe(400)
	const writer = new FitsKeywordWriter()
	writer.writeAll(header, sink)
	writer.write(['END'], sink, 320)

	expect(sink).toEqual(source)
})

test('width keywords', () => {
	expect(widthKeyword({ NAXIS1: 1200 }, undefined)).toBe(1200)
	expect(widthKeyword({ IMAGEW: 1400 }, undefined)).toBe(1400)
	expect(widthKeyword({ NAXIS1: 1100, IMAGEW: 1400 }, undefined)).toBe(1100)
})

test('height keywords', () => {
	expect(heightKeyword({ NAXIS2: 1200 }, undefined)).toBe(1200)
	expect(heightKeyword({ IMAGEH: 1400 }, undefined)).toBe(1400)
	expect(heightKeyword({ NAXIS2: 1100, IMAGEH: 1400 }, undefined)).toBe(1100)
})

test('right ascension keywords', () => {
	expect(rightAscensionKeyword({ OBJCTRA: '12 44 04.261' }, undefined)).toBeCloseTo(hms(12, 44, 4.261), 12)
	expect(rightAscensionKeyword({ RA: 161.0177548315 }, undefined)).toBeCloseTo(hms(10, 44, 4.26115956), 12)
	expect(rightAscensionKeyword({ OBJCTRA: '11 44 04.261', RA: 161.0177548315 }, undefined)).toBeCloseTo(hms(10, 44, 4.26115956), 12)
	expect(rightAscensionKeyword({ CRVAL1: 161.0177548315 }, undefined)).toBeCloseTo(hms(10, 44, 4.26115956), 12)
})

test('declination keywords', () => {
	expect(declinationKeyword({ OBJCTDEC: '59 36 08.17' }, undefined)).toBeCloseTo(dms(59, 36, 8.17), 12)
	expect(declinationKeyword({ DEC: -59.6022705034 }, undefined)).toBeCloseTo(dms(-59, 36, 8.17381224), 12)
	expect(declinationKeyword({ OBJCTDEC: '59 36 08.17', DEC: -59.6022705034 }, undefined)).toBeCloseTo(dms(-59, 36, 8.17381224), 12)
	expect(declinationKeyword({ CRVAL2: -59.6022705034 }, undefined)).toBeCloseTo(dms(-59, 36, 8.17381224), 12)
})

test('observation date keywords', () => {
	expect(observationDateKeyword({ 'DATE-OBS': '2023-01-15T01:27:05.460' })).toBe(1673746025460)
	expect(observationDateKeyword({ 'DATE-END': '2023-01-15T01:27:05.460' })).toBe(1673746025460)
	expect(observationDateKeyword({ DATE: '2023-01-15T01:27:05.460', DEC: -59.6022705034 })).toBe(1673746025460)
	expect(observationDateKeyword({ 'DATE-OBS': '2023-01-15', DATE: '2023-01-15T01:27:05.460' })).toBe(1673740800000)
})
