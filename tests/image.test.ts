import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, readFits } from '../src/fits'
import { bitpixInBytes } from '../src/fits.util'
import { adf, debayer, FitsDataSource, horizontalFlip, invert, readImageFromFits, scnr, stf, verticalFlip, writeImageToFits } from '../src/image'
import { fileHandleSink, fileHandleSource } from '../src/io'
import { BITPIXES, CHANNELS, readImage, readImageAndSaveImageWithOptions, readImageAndTransformAndSaveImage, saveImageAndCompareHash } from './image.util'

test('readImageFromFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [fits, image] = await readImage(bitpix, channel)

			expect(image!.header).toBe(fits!.hdus[0].header)

			const hash = channel === 1 ? '386a11ebe344b73505aa13765e65df7b' : '3d0e63969cdbffcf75bb1450ce6e61da'

			await readImageAndTransformAndSaveImage((i) => i, `read-${bitpix}.${channel}`, hash, bitpix, channel)
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

			const hash = channel === 1 ? '386a11ebe344b73505aa13765e65df7b' : '3d0e63969cdbffcf75bb1450ce6e61da'

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
	const image = await readImageAndTransformAndSaveImage((i) => stf(debayer(i) ?? i, 0.05), 'grbg', '3f049c06d25eec196b3d37471776de01', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
})

test('stf', () => {
	return readImageAndTransformAndSaveImage((i) => stf(i, 0.005), 'stf', 'b690674f467c3416d09d551157f4e3c2')
})

test('auto stf', () => {
	return readImageAndTransformAndSaveImage((i) => stf(i, ...adf(i)), 'astf', '3e1d22fb79df143993138e5b28611f6d')
})

test('scnr', () => {
	return readImageAndTransformAndSaveImage((i) => scnr(i, 'GREEN', 0.9), 'scnr', '56e93f2a267d35779b428e0a62e32882')
})

test('horizontal flip', () => {
	return readImageAndTransformAndSaveImage((i) => horizontalFlip(i), 'hf', '613209919daf05ac07c60906458c070c')
})

test('vertical flip', () => {
	return readImageAndTransformAndSaveImage((i) => verticalFlip(i), 'vf', 'b7dac23121498363105254fb78c3ae7f')
})

test('horizontal & vertical flip', () => {
	return readImageAndTransformAndSaveImage((i) => verticalFlip(horizontalFlip(i)), 'hvf', 'b3707db8d6b6d1ea89e90dd03fc8af4c')
})

test('invert', () => {
	return readImageAndTransformAndSaveImage((i) => invert(i), 'invert', 'aca42e7bfb9c8823068f4d8efa1615bf')
})

test('horizontal flip', () => {
	return readImageAndSaveImageWithOptions({ horizontalFlip: true }, 'hf2', '613209919daf05ac07c60906458c070c')
})

test('vertical flip', () => {
	return readImageAndSaveImageWithOptions({ verticalFlip: true }, 'vf2', 'b7dac23121498363105254fb78c3ae7f')
})

test('sharpen', () => {
	return readImageAndSaveImageWithOptions({ sharpen: true }, 'sharpen', 'b77cdbb38f603e75c3e847d5dc0f872c')
})

test('normalize', () => {
	return readImageAndSaveImageWithOptions({ normalize: true }, 'normalize', '3d0e63969cdbffcf75bb1450ce6e61da')
})

test('brightness', () => {
	return readImageAndSaveImageWithOptions({ brightness: 30 }, 'brightness', 'e9c024713c6e71861b09b791cac9ffe9')
})

test('saturation', () => {
	return readImageAndSaveImageWithOptions({ saturation: 30 }, 'saturation', 'f099129b0ba7d3b0c8f277cec45084a6')
})

test('brightness & saturation', () => {
	return readImageAndSaveImageWithOptions({ brightness: 30, saturation: 30 }, 'brightness-saturation', 'bf17190e159247f13a6f86c4ebf5a63f')
})

test('gamma', () => {
	return readImageAndSaveImageWithOptions({ gamma: 2.2 }, 'gamma', '95a81d1d960fb96aa95d84c40f17bb17')
})

test('median', () => {
	return readImageAndSaveImageWithOptions({ median: true }, 'median', 'eba8ab1e9cee53361accd564f7c93ca0')
})

test('blur', () => {
	return readImageAndSaveImageWithOptions({ blur: true }, 'blur', '0b05253f6713e19932ab2c6eb2edd15a')
})

test('negate', () => {
	return readImageAndSaveImageWithOptions({ negate: true }, 'negate', 'aca42e7bfb9c8823068f4d8efa1615bf')
})
