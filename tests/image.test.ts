import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, bitpixInBytes, readFits } from '../src/fits'
import { adf, debayer, FitsDataSource, horizontalFlip, invert, readImageFromFits, scnr, stf, verticalFlip, writeImageToFits } from '../src/image'
import { fileHandleSink, fileHandleSource } from '../src/io'
import { BITPIXES, CHANNELS, readImage, readImageAndSaveWithOptions, readImageTransformAndSave, saveImageAndCompareHash } from './image.util'

test('readImageFromFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [fits, image] = await readImage(bitpix, channel)

			expect(image!.header).toBe(fits!.hdus[0].header)

			const hash = channel === 1 ? 'e298f4abb217bac172a36f027ac6d8db' : '0a1b903f8612fa73756c266fddee0706'

			await readImageTransformAndSave((i) => i, `read-${bitpix}.${channel}`, hash, bitpix, channel)
		}
	}
}, 15000)

test('writeImageToFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [, image0] = await readImage(bitpix, channel)
			const key = `${bitpix}.${channel}`

			let handle = await fs.open(`out/witf-${key}.fit`, 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image0!, sink)

			handle = await fs.open(`out/witf-${key}.fit`, 'r')
			await using source = fileHandleSource(handle)
			const image1 = await readImageFromFits(await readFits(source))

			expect(image0!.header).toEqual(image1!.header)

			const hash = channel === 1 ? 'e298f4abb217bac172a36f027ac6d8db' : '0a1b903f8612fa73756c266fddee0706'

			await saveImageAndCompareHash(image1!, `write-${key}`, hash)
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

test('debayer', async () => {
	const image = await readImageTransformAndSave((i) => stf(debayer(i) ?? i, 0.05), 'grbg', '3f049c06d25eec196b3d37471776de01', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
})

test('stf', () => {
	return readImageTransformAndSave((i) => stf(i, 0.005), 'stf', 'b690674f467c3416d09d551157f4e3c2')
})

test('auto stf', () => {
	return readImageTransformAndSave((i) => stf(i, ...adf(i)), 'astf', '3e1d22fb79df143993138e5b28611f6d')
})

test('scnr', () => {
	return readImageTransformAndSave((i) => scnr(i, 'GREEN', 0.9), 'scnr', '73f4a8308f0e234610b913400cce2adb')
})

test('horizontal flip', () => {
	return readImageTransformAndSave((i) => horizontalFlip(i), 'hf', '56b0ed9d8c265f1eb1d5ca2cdea1d619')
})

test('vertical flip', () => {
	return readImageTransformAndSave((i) => verticalFlip(i), 'vf', '0c07e73e73bd7383c799874da41ee284')
})

test('horizontal & vertical flip', () => {
	return readImageTransformAndSave((i) => verticalFlip(horizontalFlip(i)), 'hvf', 'fd71d2b9372436699bf54f58f9dbadf5')
})

test('invert', () => {
	return readImageTransformAndSave((i) => invert(i), 'invert', 'a9b92211de5965f5afb1aab2f0427b79')
})

test('horizontal flip', () => {
	return readImageAndSaveWithOptions({ horizontalFlip: true }, 'hf2', '56b0ed9d8c265f1eb1d5ca2cdea1d619')
})

test('vertical flip', () => {
	return readImageAndSaveWithOptions({ verticalFlip: true }, 'vf2', '0c07e73e73bd7383c799874da41ee284')
})

test('sharpen', () => {
	return readImageAndSaveWithOptions({ sharpen: true }, 'sharpen', 'e45a3f735e0a2ac6a55509f0c618e55b')
})

test('normalize', () => {
	return readImageAndSaveWithOptions({ normalize: true }, 'normalize', '0a1b903f8612fa73756c266fddee0706')
})

test('brightness', () => {
	return readImageAndSaveWithOptions({ brightness: 30 }, 'brightness', '06b7df04c9110fd6b5fa04d15d0c0b48')
})

test('contrast', () => {
	return readImageAndSaveWithOptions({ contrast: 5 }, 'contrast', 'd407e71e6fc4108082249dc0bb3c0bf6')
})

test('saturation', () => {
	return readImageAndSaveWithOptions({ saturation: 30 }, 'saturation', '2103ecbf94a8006ea7dfd1a2551ccfe2')
})

test('brightness & saturation', () => {
	return readImageAndSaveWithOptions({ brightness: 30, saturation: 30 }, 'brightness-saturation', 'ce8ad38b1ccf90f227e568523df94326')
})

test('gamma', () => {
	return readImageAndSaveWithOptions({ gamma: 2.2 }, 'gamma', '22c9e73c1ec3f917896503370b06548e')
})

test('median', () => {
	return readImageAndSaveWithOptions({ median: true }, 'median', '18ab1f9f14e5776e00b3c3b7eddff13d')
})

test('blur', () => {
	return readImageAndSaveWithOptions({ blur: true }, 'blur', 'e71d4f269e5d5a483fce3f5e8b0d3584')
})

test('negate', () => {
	return readImageAndSaveWithOptions({ negate: true }, 'negate', 'a9b92211de5965f5afb1aab2f0427b79')
})
