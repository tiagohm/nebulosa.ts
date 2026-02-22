import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readImageFromXisf } from '../src/image'
import { fileHandleSource } from '../src/io'
import { byteShuffle, byteUnshuffle, isXisf, parseXisfHeader, readXisf } from '../src/xisf'
import { saveImageAndCompareHash } from './image.util'

test('is xisf', async () => {
	const buffer = await Bun.file('data/NGC3372-8.1.xisf').arrayBuffer()
	expect(isXisf(buffer)).toBeTrue()
})

describe('header', () => {
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
		const XML = `<xisf version="1.0"><Image geometry="1037:706:1" sampleFormat="Float64" bounds="0:1" colorSpace="Gray" location="attachment:8192:5856976" compression="zstd:1464244"><FITSKeyword name="EXPTIME" value="30." comment="Exposure time in seconds"/></Image><Image geometry="4096:4096:4" sampleFormat="Float32" bounds="0:1" colorSpace="RGB" location="attachment:4096:268435456" compression="zstd+sh:1464244:2"><FITSKeyword name="EXPTIME" value="30." comment="Exposure time in seconds"/></Image></xisf>`
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
		expect(hdus[0].header).toEqual({ SIMPLE: true, NAXIS: 2, NAXIS1: 1037, NAXIS2: 706, BITPIX: -64, EXPTIME: 30 })

		expect(hdus[1].byteOrder).toBe('little')
		expect(hdus[1].colorSpace).toBe('RGB')
		expect(hdus[1].geometry).toEqual({ width: 4096, height: 4096, channels: 4 })
		expect(hdus[1].imageType).toBe('Light')
		expect(hdus[1].location).toEqual({ size: 268435456, offset: 4096 })
		expect(hdus[1].pixelStorage).toBe('Planar')
		expect(hdus[1].sampleFormat).toBe('Float32')
		expect(hdus[1].bitpix).toBe(-32)
		expect(hdus[1].compression).toEqual({ format: 'zstd', shuffled: true, uncompressedSize: 1464244, itemSize: 2 })
		expect(hdus[1].header).toEqual({ SIMPLE: true, NAXIS: 3, NAXIS1: 4096, NAXIS2: 4096, NAXIS3: 4, BITPIX: -32, EXPTIME: 30 })
	})
})

describe('read', () => {
	test('mono 8-bit', async () => {
		const handle = await fs.open('data/NGC3372-8.1.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-mono-8', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color 8-bit', async () => {
		const handle = await fs.open('data/NGC3372-8.3.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-color-8', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono 16-bit', async () => {
		const handle = await fs.open('data/NGC3372-16.1.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-mono-16', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color 16-bit', async () => {
		const handle = await fs.open('data/NGC3372-16.3.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-color-16', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono 32-bit', async () => {
		const handle = await fs.open('data/NGC3372-32.1.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-mono-32', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color 32-bit', async () => {
		const handle = await fs.open('data/NGC3372-32.3.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-color-32', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono float 32-bit', async () => {
		const handle = await fs.open('data/NGC3372--32.1.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-mono-F32', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color float 32-bit', async () => {
		const handle = await fs.open('data/NGC3372--32.3.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-color-F32', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})

	test('mono float 64-bit', async () => {
		const handle = await fs.open('data/NGC3372--64.1.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-mono-F64', 'c754bf834dc1bb3948ec3cf8b9aca303')
	})

	test('color float 64-bit', async () => {
		const handle = await fs.open('data/NGC3372--64.3.xisf')
		await using source = fileHandleSource(handle)
		const xisf = await readXisf(source)
		const image = await readImageFromXisf(xisf!, source)
		await saveImageAndCompareHash(image!, 'xisf-color-F64', '1ca5a4dd509ee4c67e3a2fbca43f81d4')
	})
})

test('byte shuffle & unshuffle', () => {
	const original = new Uint8Array(512)
	for (let i = 0; i < 256; i += 2) original[i] = i
	const shuffled = new Uint8Array(512)
	const unshuffled = new Uint8Array(512)

	byteShuffle(original, shuffled, 2)
	expect(original).not.toEqual(shuffled)

	byteUnshuffle(shuffled, unshuffled, 2)
	expect(unshuffled).toEqual(original)

	expect(Bun.gzipSync(shuffled).byteLength).toBeLessThan(Bun.gzipSync(original).byteLength)
})
