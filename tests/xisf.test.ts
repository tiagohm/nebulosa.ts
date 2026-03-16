import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readImageFromBuffer, readImageFromPath, readImageFromXisf } from '../src/image'
import { bufferSink, fileHandleSource } from '../src/io'
import { byteShuffle, byteUnshuffle, isXisf, parseXisfHeader, readXisf, writeXisf } from '../src/xisf'
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
})
