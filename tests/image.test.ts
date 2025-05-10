import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, bitpixInBytes, readFits } from '../src/fits'
import { FitsDataSource, horizontalFlip, readImageFromFits, scnr, stf, verticalFlip, writeImageToFits, writeImageToFormat } from '../src/image'
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

test.skip('stf', async () => {
	const fits = generateFits(8, 8, Bitpix.DOUBLE, 3)
	const image = await readImageFromFits(fits)
	const output = 'data/out/stf.png'
	await writeImageToFormat(stf(image!, 0.5), output, 'png')
	const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	console.log(md5)
})

test('scnr', async () => {
	const fits = generateFits(8, 8, Bitpix.DOUBLE, 3)
	const image = await readImageFromFits(fits)
	const output = 'data/out/scnr.png'
	await writeImageToFormat(scnr(image!, 'GREEN', 0.9), output, 'png')
	const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	expect(md5).toBe('bb1d7cb7e843a0fb5afd8e930002e9b8')
})

test('horizontal flip', async () => {
	const fits = generateFits(8, 8, Bitpix.DOUBLE, 3)
	const image = await readImageFromFits(fits)
	const output = 'data/out/hf.png'
	await writeImageToFormat(horizontalFlip(image!), output, 'png')
	const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	expect(md5).toBe('0e2c97f0c78fc8692a1c5d8aaf2402bb')
})

test('vertical flip', async () => {
	const fits = generateFits(8, 8, Bitpix.DOUBLE, 3)
	const image = await readImageFromFits(fits)
	const output = 'data/out/vf.png'
	await writeImageToFormat(verticalFlip(image!), output, 'png')
	const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	expect(md5).toBe('6e601f915745dcd6ab7bf1f600248037')
})

test('horizontal & vertical flip', async () => {
	const fits = generateFits(8, 8, Bitpix.DOUBLE, 3)
	const image = await readImageFromFits(fits)
	const output = 'data/out/hvf.png'
	await writeImageToFormat(verticalFlip(horizontalFlip(image!)), output, 'png')
	const md5 = Bun.MD5.hash(await Bun.file(output).arrayBuffer(), 'hex')
	expect(md5).toBe('d6cfba9d41b828ef7e8b65c4585b3507')
})
