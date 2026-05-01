import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readImageFromBuffer, readImageFromPath, readImageFromXisf } from '../src/image'
import { bufferSink, bufferSource, fileHandleSource } from '../src/io'
import { byteShuffle, byteUnshuffle, isXisf, parseXisfHeader, readXisf, writeXisf, XisfImageReader, XisfImageWriter } from '../src/xisf'
import { downloadPerTag } from './download'
import { BITPIXES, CHANNELS, saveImageAndCompareHash } from './image.util'

await downloadPerTag('xisf')

const COMPRESSION_FORMATS = ['zstd', 'zstd+sh', 'zlib', 'zlib+sh'] as const

test('is xisf', async () => {
	const buffer = await Bun.file('data/NGC3372-8.1.xisf').arrayBuffer()
	expect(isXisf(buffer)).toBeTrue()
})

describe('parse header', () => {
	test('single image', () => {
		const XML = `<xisf version="1.0"><Image geometry="1037:706:1" sampleFormat="Float64" bounds="0:1" colorSpace="Gray" location="attachment:8192:5856976"></Image></xisf>`
		const hdus = parseXisfHeader(Buffer.from(XML))

		expect(hdus).toHaveLength(1)
		expect(hdus[0].byteOrder).toBe('little')
		expect(hdus[0].colorSpace).toBe('Gray')
		expect(hdus[0].geometry).toEqual({ width: 1037, height: 706, channels: 1 })
		expect(hdus[0].imageType).toBe('Light')
		expect(hdus[0].location).toEqual({ size: 5856976, offset: 8192 })
		expect(hdus[0].pixelStorage).toBe('Planar')
		expect(hdus[0].sampleFormat).toBe('Float64')
		expect(hdus[0].bitpix).toBe(-64)
		expect(hdus[0].compression).toBeUndefined()
		expect(hdus[0].header).toEqual({ SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: 1037, NAXIS2: 706 })
	})

	test('multiple images', () => {
		const XML = `<xisf version="1.0"><Image geometry="1037:706:1" sampleFormat="Float64" bounds="0:1" colorSpace="Gray" location="attachment:8192:5856976" compression="zstd:1464244"></Image><Image geometry="4096:4096:4" sampleFormat="Float32" bounds="0:1" colorSpace="RGB" location="attachment:4096:268435456" compression="zstd+sh:1464244:2"></Image></xisf>`
		const hdus = parseXisfHeader(Buffer.from(XML))

		expect(hdus).toHaveLength(2)
		expect(hdus[0].byteOrder).toBe('little')
		expect(hdus[0].colorSpace).toBe('Gray')
		expect(hdus[0].geometry).toEqual({ width: 1037, height: 706, channels: 1 })
		expect(hdus[0].imageType).toBe('Light')
		expect(hdus[0].location).toEqual({ size: 5856976, offset: 8192 })
		expect(hdus[0].pixelStorage).toBe('Planar')
		expect(hdus[0].sampleFormat).toBe('Float64')
		expect(hdus[0].bitpix).toBe(-64)
		expect(hdus[0].compression).toEqual({ format: 'zstd', shuffled: false, uncompressedSize: 1464244, itemSize: 0 })
		expect(hdus[0].header).toEqual({ SIMPLE: true, NAXIS: 2, NAXIS1: 1037, NAXIS2: 706, BITPIX: -64 })

		expect(hdus[1].byteOrder).toBe('little')
		expect(hdus[1].colorSpace).toBe('RGB')
		expect(hdus[1].geometry).toEqual({ width: 4096, height: 4096, channels: 4 })
		expect(hdus[1].imageType).toBe('Light')
		expect(hdus[1].location).toEqual({ size: 268435456, offset: 4096 })
		expect(hdus[1].pixelStorage).toBe('Planar')
		expect(hdus[1].sampleFormat).toBe('Float32')
		expect(hdus[1].bitpix).toBe(-32)
		expect(hdus[1].compression).toEqual({ format: 'zstd', shuffled: true, uncompressedSize: 1464244, itemSize: 2 })
		expect(hdus[1].header).toEqual({ SIMPLE: true, NAXIS: 3, NAXIS1: 4096, NAXIS2: 4096, NAXIS3: 4, BITPIX: -32 })
	})
})

describe('read', () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			test(`channel=${channel}, bitpix=${bitpix}`, async () => {
				const handle = await fs.open(`data/NGC3372-${bitpix}.${channel}.xisf`)
				await using source = fileHandleSource(handle)
				const xisf = await readXisf(source)
				const image = await readImageFromXisf(xisf!, source)
				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'
				await saveImageAndCompareHash(image!, `xisf-${bitpix}-${channel}`, hash)
			})
		}
	}
})

describe('read compressed', () => {
	for (const format of COMPRESSION_FORMATS) {
		test(format, async () => {
			const handle = await fs.open(`data/NGC3372-${format}-16.1.xisf`)
			await using source = fileHandleSource(handle)
			const xisf = await readXisf(source)
			const shuffled = format.endsWith('+sh')
			expect(xisf!.images[0].compression!).toEqual({ format: format.replace('+sh', '') as never, shuffled, uncompressedSize: 1464244, itemSize: shuffled ? 2 : 0 })
			const image = await readImageFromXisf(xisf!, source)
			await saveImageAndCompareHash(image!, `xisf-${format}-16-1`, 'c754bf834dc1bb3948ec3cf8b9aca303')
		})
	}
})

describe('write', () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)

	for (const channel of CHANNELS) {
		for (const bitpix of BITPIXES) {
			test(`channel=${channel}, bitpix=${bitpix}`, async () => {
				buffer.fill(20)

				const image = await readImageFromPath(`data/NGC3372-${bitpix}.${channel}.xisf`)

				const sink = bufferSink(buffer)
				expect(await writeXisf(sink, [image!])).toBeGreaterThan(0)

				const output = await readImageFromBuffer(buffer)

				expect(Object.keys(output!.header).length).toBeGreaterThanOrEqual(57)
				expect(output!.header).toEqual(image!.header)

				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'
				await saveImageAndCompareHash(output!, `write-xisf-${bitpix}-${channel}`, hash)
			}, 5000)
		}
	}
})

describe('write compressed', () => {
	const buffer = Buffer.allocUnsafe(1024 * 1024 * 18)
	const sizes: Record<string, number> = {}

	for (const channel of CHANNELS) {
		for (const bitpix of BITPIXES) {
			for (const format of COMPRESSION_FORMATS) {
				test(`channel=${channel}, bitpix=${bitpix}, format=${format}`, async () => {
					buffer.fill(20)

					const image = await readImageFromPath(`data/NGC3372-${bitpix}.${channel}.xisf`)
					const sink = bufferSink(buffer)
					const shuffled = format.endsWith('+sh')
					const compressedSize = await writeXisf(sink, [image!], { compression: { format: format.replace('+sh', '') as never, shuffled } })
					expect(compressedSize).toBeLessThan(image!.metadata.pixelSizeInBytes * image!.metadata.pixelCount * image!.metadata.channels)

					sizes[`${bitpix}_${channel}_${format}`] = compressedSize
				}, 5000)
			}
		}
	}

	test('shuffled compression must have size less than unshuffled compression', () => {
		for (const channel of CHANNELS) {
			for (const bitpix of BITPIXES) {
				if (bitpix === 8) continue

				for (const format of COMPRESSION_FORMATS.filter((e) => !e.endsWith('+sh'))) {
					const key = `${bitpix}_${channel}_${format}`
					expect(sizes[`${key}+sh`]).toBeLessThan(sizes[key])
				}
			}
		}
	})
})

describe('byte shuffle and unshuffle', () => {
	for (let itemSize = 1; itemSize <= 4; itemSize *= 2) {
		test(`itemSize=${itemSize}`, () => {
			const TypedArray = itemSize === 1 ? Uint8Array : itemSize === 2 ? Uint16Array : Uint32Array
			const original = new TypedArray(512)
			const shuffled = new TypedArray(512)
			const unshuffled = new TypedArray(512)

			for (let i = 0; i < original.length; i++) original[i] = i

			byteShuffle(Buffer.from(original.buffer), Buffer.from(shuffled.buffer), itemSize)

			if (itemSize === 1) expect(original).toEqual(shuffled)
			else expect(original).not.toEqual(shuffled)

			byteUnshuffle(Buffer.from(shuffled.buffer), Buffer.from(unshuffled.buffer), itemSize)
			expect(unshuffled).toEqual(original)

			if (itemSize > 1) expect(Bun.gzipSync(shuffled.buffer).byteLength).toBeLessThan(Bun.gzipSync(original.buffer).byteLength)
		})
	}

	test('preserves trailing bytes', () => {
		const original = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		const shuffled = new Uint8Array(original.length)
		const unshuffled = new Uint8Array(original.length)

		byteShuffle(original, shuffled, 4)
		expect(shuffled).toEqual(Uint8Array.from([1, 5, 2, 6, 3, 7, 4, 8, 9, 10]))

		byteUnshuffle(shuffled, unshuffled, 4)
		expect(unshuffled).toEqual(original)
	})
})

describe('buffer views', () => {
	test('reader respects provided buffer offset', async () => {
		const storage = Buffer.alloc(8, 0)
		const buffer = storage.subarray(2, 4)
		const reader = new XisfImageReader({ bitpix: 16, location: { offset: 0, size: 2 }, byteOrder: 'little', pixelStorage: 'Normal', geometry: { width: 1, height: 1, channels: 1 } }, buffer)
		const output = new Float64Array(1)

		expect(await reader.read(bufferSource(Buffer.from([0xff, 0xff])), output)).toBeTrue()
		expect(output[0]).toBeCloseTo(1, 12)
		expect(buffer).toEqual(Buffer.from([0xff, 0xff]))
		expect(storage.subarray(0, 2)).toEqual(Buffer.from([0, 0]))
	})

	test('writer respects provided buffer offset', async () => {
		const storage = Buffer.alloc(8, 0)
		const buffer = storage.subarray(2, 4)
		const writer = new XisfImageWriter({ bitpix: 16, byteOrder: 'little', pixelStorage: 'Normal', geometry: { width: 1, height: 1, channels: 1 } }, false, buffer)
		const encoded = await writer.encode(new Float64Array([1]))

		expect(encoded.compression).toBeUndefined()
		expect(encoded.data).toEqual(Buffer.from([0xff, 0xff]))
		expect(buffer).toEqual(Buffer.from([0xff, 0xff]))
		expect(storage.subarray(0, 2)).toEqual(Buffer.from([0, 0]))
	})
})

test('should parse correctly XML header', () => {
	const xml = `<?xml version="1.0"?><!--
Extensible Image Serialization Format - XISF version 1.0
Created with libXISF - https://nouspiro.space
--><xisf version="1.0" xmlns="http://www.pixinsight.com/xisf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.pixinsight.com/xisf http://pixinsight.com/xisf/xisf-1.0.xsd"><Image geometry="1920:1080:1" sampleFormat="UInt16" colorSpace="Gray" imageType="Light" pixelStorage="Planar" location="attachment:2473:4147200"><Property id="Instrument:Camera:Name" type="String">SVBONY CCD SV305</Property><Property id="Instrument:ExposureTime" type="Float32" value="10"/><Property id="Instrument:Camera:XBinning" type="Int32" value="1"/><Property id="Instrument:Camera:YBinning" type="Int32" value="1"/><Property id="Observation:Time:Start" type="TimePoint" value="2026-03-17T01:28:36Z"/><Property id="Instrument:Camera:Gain" type="Float32" value="0"/><FITSKeyword name="ROWORDER" value="TOP-DOWN" comment="Row Order"/><FITSKeyword name="INSTRUME" value="SVBONY CCD SV305" comment="Camera Name"/><FITSKeyword name="EXPTIME" value="10" comment="Total Exposure Time (s)"/><FITSKeyword name="PIXSIZE1" value="2.9" comment="Pixel Size 1 (microns)"/><FITSKeyword name="PIXSIZE2" value="2.9" comment="Pixel Size 2 (microns)"/><FITSKeyword name="XBINNING" value="1" comment="Binning factor in width"/><FITSKeyword name="YBINNING" value="1" comment="Binning factor in height"/><FITSKeyword name="XPIXSZ" value="2.9" comment="X binned pixel size in microns"/><FITSKeyword name="YPIXSZ" value="2.9" comment="Y binned pixel size in microns"/><FITSKeyword name="FRAME" value="Light" comment="Frame Type"/><FITSKeyword name="IMAGETYP" value="Light Frame" comment="Frame Type"/><FITSKeyword name="XBAYROFF" value="0" comment="X offset of Bayer array"/><FITSKeyword name="YBAYROFF" value="0" comment="Y offset of Bayer array"/><FITSKeyword name="BAYERPAT" value="GRBG" comment="Bayer color pattern"/><FITSKeyword name="DATE-OBS" value="2026-03-17T01:28:36.431" comment="UTC start date of observation"/><FITSKeyword name="COMMENT" value="" comment="Generated by INDI"/><FITSKeyword name="GAIN" value="0" comment="Gain"/><FITSKeyword name="OFFSET" value="0" comment="Offset"/><ColorFilterArray pattern="GRBG" width="2" height="2"/></Image><Metadata><Property id="XISF:CreationTime" type="TimePoint" value="2026-03-17T01:28:46Z"/><Property id="XISF:CreatorApplication" type="String">LibXISF</Property></Metadata></xisf>`
	const images = parseXisfHeader(Buffer.from(xml))

	expect(images).toHaveLength(1)

	const header = images[0].header

	expect(header.ROWORDER).toBe('TOP-DOWN')
	expect(header.INSTRUME).toBe('SVBONY CCD SV305')
	expect(header.EXPTIME).toBe(10)
	expect(header.PIXSIZE1).toBe(2.9)
	expect(header.PIXSIZE2).toBe(2.9)
	expect(header.XBINNING).toBe(1)
	expect(header.YBINNING).toBe(1)
	expect(header.XPIXSZ).toBe(2.9)
	expect(header.YPIXSZ).toBe(2.9)
	expect(header.FRAME).toBe('Light')
	expect(header.IMAGETYP).toBe('Light Frame')
	expect(header.XBAYROFF).toBe(0)
	expect(header.YBAYROFF).toBe(0)
	expect(header.BAYERPAT).toBe('GRBG')
	expect(header['DATE-OBS']).toBe('2026-03-17T01:28:36.431')
	expect(header.COMMENT).toBeUndefined()
	expect(header.GAIN).toBe(0)
	expect(header.OFFSET).toBe(0)
})
