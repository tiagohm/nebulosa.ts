import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, bitpixInBytes, readFits } from '../src/fits'
import { FitsDataSource, readImageFromFits, writeImageToFits, writeImageToFormat } from '../src/image'
import { fileHandleSink, fileHandleSource } from '../src/io'
import { BITPIXES, CHANNELS, generateFits } from './fits.generator'

test('readImageFromFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const fits = generateFits(8, 8, bitpix, channel)
			const image = await readImageFromFits(fits)

			expect(image!.header).toBe(fits.hdus[0].header)

			const output = `data/out/riff-${channel}-${bitpix}.png`
			await writeImageToFormat(image!, output, 'png')

			const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')

			if (channel === 1) expect(md5).toBe('7a361f42788e229ce6edd0d864efb0a6')
			else expect(md5).toBe('60d01613155ab17ababba10082e61d72')
		}
	}
})

test('writeImageToFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const fits = generateFits(8, 8, bitpix, channel)
			let image = await readImageFromFits(fits)

			let handle = await fs.open(`data/out/witf-${channel}-${bitpix}.fits`, 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image!, sink)

			handle = await fs.open(`data/out/witf-${channel}-${bitpix}.fits`, 'r')
			await using source = fileHandleSource(handle)
			image = await readImageFromFits(await readFits(source))

			expect(image!.header).toEqual(fits.hdus[0].header)

			const output = `data/out/witf-${channel}-${bitpix}.png`
			await writeImageToFormat(image!, output, 'png')

			const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')

			if (channel === 1) expect(md5).toBe('7a361f42788e229ce6edd0d864efb0a6')
			else expect(md5).toBe('60d01613155ab17ababba10082e61d72')
		}
	}
})

test('fitsDataSource', () => {
	const buffer = Buffer.allocUnsafe(64)
	const data = new Float64Array([0.5, 1, 0])

	const expectedByte: Record<Bitpix, number[]> = {
		[Bitpix.BYTE]: [127, 255, 0],
		[Bitpix.SHORT]: [-1, 32767, -32768],
		[Bitpix.INTEGER]: [-1, 2147483647, -2147483648],
		[Bitpix.LONG]: [0, 0, 0],
		[Bitpix.FLOAT]: [0.5, 1, 0],
		[Bitpix.DOUBLE]: [0.5, 1, 0],
	}

	for (const bitpix of BITPIXES) {
		const pixelSizeInBytes = bitpixInBytes(bitpix)

		for (const channel of CHANNELS) {
			const source = new FitsDataSource(data.subarray(0, channel), bitpix, channel)

			for (let i = 0; i < channel; i++) {
				expect(source.read(buffer)).toBe(pixelSizeInBytes)

				if (bitpix === Bitpix.BYTE) expect(buffer.readUInt8(0)).toBe(expectedByte[bitpix][i])
				else if (bitpix === Bitpix.SHORT) expect(buffer.readInt16BE(0)).toBe(expectedByte[bitpix][i])
				else if (bitpix === Bitpix.INTEGER) expect(buffer.readInt32BE(0)).toBe(expectedByte[bitpix][i])
				else if (bitpix === Bitpix.FLOAT) expect(buffer.readFloatBE(0)).toBe(expectedByte[bitpix][i])
				else if (bitpix === Bitpix.DOUBLE) expect(buffer.readDoubleBE(0)).toBe(expectedByte[bitpix][i])
			}

			expect(source.read(buffer)).toBe(0)
		}
	}
})
