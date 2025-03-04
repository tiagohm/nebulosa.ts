import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, readFits } from '../src/fits'
import { FitsDataSource, readImageFromFits, stf, writeImageToFits, writeImageToFormat } from '../src/image'
import { fileHandleSink, fileHandleSource } from '../src/io'

describe('readImageFromFits', () => {
	describe('mono', () => {
		test('byte', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-byte.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-mono-byte.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-byte.png').arrayBuffer(), 'hex')).toBe('f56de59c02a6ba90a0159c972ba1b0b5')
		})

		test('short', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-short.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-mono-short.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-short.png').arrayBuffer(), 'hex')).toBe('468ec0bb58e382228977c1f109c426d2')
		})

		test('integer', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-integer.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-mono-integer.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-integer.png').arrayBuffer(), 'hex')).toBe('e02aafba8e06005cef8666d425d6476d')
		})

		test('float', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-float.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-mono-float.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-float.png').arrayBuffer(), 'hex')).toBe('e67940309bcc520ff79bbbde35530750')
		})

		test('double', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-double.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-mono-double.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-mono-double.png').arrayBuffer(), 'hex')).toBe('e67940309bcc520ff79bbbde35530750')
		})
	})

	describe('color', () => {
		test('byte', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-byte.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-color-byte.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-byte.png').arrayBuffer(), 'hex')).toBe('870ac19a84ef38ec58f27c9f3fcf9624')
		})

		test('short', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-short.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-color-short.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-short.png').arrayBuffer(), 'hex')).toBe('425102b2ef786309ac746e0af5ec463f')
		})

		test('integer', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-integer.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-color-integer.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-integer.png').arrayBuffer(), 'hex')).toBe('5879055756829ed1455ab50de84babe8')
		})

		test('float', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-float.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-color-float.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-float.png').arrayBuffer(), 'hex')).toBe('edefee01963ff38abbb83e258fc18310')
		})

		test('double', async () => {
			await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-double.fits'))
			const image = await readImageFromFits(await readFits(source))
			expect(image).not.toBeUndefined()
			expect(image!.raw.length).toBe(256 * 174 * 3)

			await writeImageToFormat(stf(image!, 0.001), '.cache/NGC3372-color-double.png', 'png')
			expect(Bun.MD5.hash(await Bun.file('.cache/NGC3372-color-double.png').arrayBuffer(), 'hex')).toBe('edefee01963ff38abbb83e258fc18310')
		})
	})
})

describe('writeImageToFits', () => {
	describe('mono', async () => {
		await using source = fileHandleSource(await fs.open('data/fits/NGC3372-mono-double.fits'))
		const image = (await readImageFromFits(await readFits(source)))!

		expect(image).not.toBeUndefined()

		test('byte', async () => {
			image.header.BITPIX = Bitpix.BYTE
			const handle = await fs.open('.cache/NGC3372-mono-byte.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('short', async () => {
			image.header.BITPIX = Bitpix.SHORT
			const handle = await fs.open('.cache/NGC3372-mono-short.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('integer', async () => {
			image.header.BITPIX = Bitpix.INTEGER
			const handle = await fs.open('.cache/NGC3372-mono-integer.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('float', async () => {
			image.header.BITPIX = Bitpix.FLOAT
			const handle = await fs.open('.cache/NGC3372-mono-float.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('double', async () => {
			image.header.BITPIX = Bitpix.DOUBLE
			const handle = await fs.open('.cache/NGC3372-mono-double.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})
	})

	describe('color', async () => {
		await using source = fileHandleSource(await fs.open('data/fits/NGC3372-color-double.fits'))
		const image = (await readImageFromFits(await readFits(source)))!

		expect(image).not.toBeUndefined()

		test('byte', async () => {
			image.header.BITPIX = Bitpix.BYTE
			const handle = await fs.open('.cache/NGC3372-color-byte.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('short', async () => {
			image.header.BITPIX = Bitpix.SHORT
			const handle = await fs.open('.cache/NGC3372-color-short.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('integer', async () => {
			image.header.BITPIX = Bitpix.INTEGER
			const handle = await fs.open('.cache/NGC3372-color-integer.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('float', async () => {
			image.header.BITPIX = Bitpix.FLOAT
			const handle = await fs.open('.cache/NGC3372-color-float.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})

		test('double', async () => {
			image.header.BITPIX = Bitpix.DOUBLE
			const handle = await fs.open('.cache/NGC3372-color-double.fits', 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image, sink)
		})
	})
})

describe('fitsDataSource', () => {
	const buffer = Buffer.allocUnsafe(64)

	describe('mono', () => {
		const data = new Float64Array([0.6])

		test('byte', () => {
			const source = new FitsDataSource(data, Bitpix.BYTE, 1)

			expect(source.read(buffer)).toBe(1)
			expect(buffer.readUint8(0)).toBe(153)
			expect(source.read(buffer)).toBe(0)
		})

		test('short', () => {
			const source = new FitsDataSource(data, Bitpix.SHORT, 1)

			expect(source.read(buffer)).toBe(2)
			expect(buffer.readUInt16BE(0)).toBe(39321)
			expect(source.read(buffer)).toBe(0)
		})

		test('integer', () => {
			const source = new FitsDataSource(data, Bitpix.INTEGER, 1)

			expect(source.read(buffer)).toBe(4)
			expect(buffer.readUInt32BE(0)).toBe(2576980377)
			expect(source.read(buffer)).toBe(0)
		})

		test('float', () => {
			const source = new FitsDataSource(data, Bitpix.FLOAT, 1)

			expect(source.read(buffer)).toBe(4)
			expect(buffer.readFloatBE(0)).toBeCloseTo(0.6, 6)
			expect(source.read(buffer)).toBe(0)
		})

		test('double', () => {
			const source = new FitsDataSource(data, Bitpix.DOUBLE, 1)

			expect(source.read(buffer)).toBe(8)
			expect(buffer.readDoubleBE(0)).toBe(0.6)
			expect(source.read(buffer)).toBe(0)
		})
	})

	describe('color', () => {
		const data = new Float64Array([0.6, 0.1, 0.9])

		test('byte', () => {
			const source = new FitsDataSource(data, Bitpix.BYTE, 3)

			expect(source.read(buffer)).toBe(1)
			expect(buffer.readUint8(0)).toBe(153)
			expect(source.read(buffer)).toBe(1)
			expect(buffer.readUint8(0)).toBe(25)
			expect(source.read(buffer)).toBe(1)
			expect(buffer.readUint8(0)).toBe(229)
			expect(source.read(buffer)).toBe(0)
		})

		test('short', () => {
			const source = new FitsDataSource(data, Bitpix.SHORT, 3)

			expect(source.read(buffer)).toBe(2)
			expect(buffer.readUInt16BE(0)).toBe(39321)
			expect(source.read(buffer)).toBe(2)
			expect(buffer.readUInt16BE(0)).toBe(6553)
			expect(source.read(buffer)).toBe(2)
			expect(buffer.readUInt16BE(0)).toBe(58981)
			expect(source.read(buffer)).toBe(0)
		})

		test('integer', () => {
			const source = new FitsDataSource(data, Bitpix.INTEGER, 3)

			expect(source.read(buffer)).toBe(4)
			expect(buffer.readUInt32BE(0)).toBe(2576980377)
			expect(source.read(buffer)).toBe(4)
			expect(buffer.readUInt32BE(0)).toBe(429496729)
			expect(source.read(buffer)).toBe(4)
			expect(buffer.readUInt32BE(0)).toBe(3865470565)
			expect(source.read(buffer)).toBe(0)
		})

		test('float', () => {
			const source = new FitsDataSource(data, Bitpix.FLOAT, 3)

			expect(source.read(buffer)).toBe(4)
			expect(buffer.readFloatBE(0)).toBeCloseTo(0.6, 6)
			expect(source.read(buffer)).toBe(4)
			expect(buffer.readFloatBE(0)).toBeCloseTo(0.1, 6)
			expect(source.read(buffer)).toBe(4)
			expect(buffer.readFloatBE(0)).toBeCloseTo(0.9, 6)
			expect(source.read(buffer)).toBe(0)
		})

		test('double', () => {
			const source = new FitsDataSource(data, Bitpix.DOUBLE, 3)

			expect(source.read(buffer)).toBe(8)
			expect(buffer.readDoubleBE(0)).toBe(0.6)
			expect(source.read(buffer)).toBe(8)
			expect(buffer.readDoubleBE(0)).toBe(0.1)
			expect(source.read(buffer)).toBe(8)
			expect(buffer.readDoubleBE(0)).toBe(0.9)
			expect(source.read(buffer)).toBe(0)
		})
	})
})
