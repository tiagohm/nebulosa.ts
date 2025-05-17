import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, bitpixInBytes, readFits } from '../src/fits'
import { FitsDataSource, autoStf, horizontalFlip, readImageFromFits, scnr, stf, verticalFlip, writeImageToFits } from '../src/image'
import { fileHandleSink, fileHandleSource } from '../src/io'
import { BITPIXES, CHANNELS, readImage, readImageAndTransformAndSaveImage, saveImage } from './image.util'

test('readImageFromFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [fits, image] = await readImage(bitpix, channel)

			expect(image!.header).toBe(fits!.hdus[0].header)

			const hash = channel === 1 ? 'fb9ca4a1edb3588a2cf678227ed4b364' : '3d0e63969cdbffcf75bb1450ce6e61da'

			await readImageAndTransformAndSaveImage((i) => i, `read-${bitpix}.${channel}`, hash, bitpix, channel)
		}
	}
}, 15000)

test('writeImageToFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [, image0] = await readImage(bitpix, channel)

			let handle = await fs.open(`out/witf-${channel}-${bitpix}.fit`, 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image0!, sink)

			handle = await fs.open(`out/witf-${channel}-${bitpix}.fit`, 'r')
			await using source = fileHandleSource(handle)
			const image1 = await readImageFromFits(await readFits(source))

			expect(image0!.header).toEqual(image1!.header)

			const hash = channel === 1 ? 'fb9ca4a1edb3588a2cf678227ed4b364' : '3d0e63969cdbffcf75bb1450ce6e61da'

			await saveImage(image1!, `write-${bitpix}.${channel}`, hash)
		}
	}
}, 15000)

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

test('stf', async () => {
	return readImageAndTransformAndSaveImage((i) => stf(i, 0.005), 'stf', 'b690674f467c3416d09d551157f4e3c2')
})

test('auto stf', async () => {
	return readImageAndTransformAndSaveImage((i) => stf(i, ...autoStf(i)), 'astf', '3e1d22fb79df143993138e5b28611f6d')
})

test('scnr', async () => {
	return readImageAndTransformAndSaveImage((i) => scnr(i, 'GREEN', 0.9), 'scnr', '56e93f2a267d35779b428e0a62e32882')
})

test('horizontal flip', async () => {
	return readImageAndTransformAndSaveImage((i) => horizontalFlip(i), 'hf', '613209919daf05ac07c60906458c070c')
})

test('vertical flip', async () => {
	return readImageAndTransformAndSaveImage((i) => verticalFlip(i), 'vf', 'b7dac23121498363105254fb78c3ae7f')
})

test('horizontal & vertical flip', () => {
	return readImageAndTransformAndSaveImage((i) => verticalFlip(horizontalFlip(i)), 'hvf', 'b3707db8d6b6d1ea89e90dd03fc8af4c')
})
