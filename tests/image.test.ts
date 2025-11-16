import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { Bitpix, bitpixInBytes, readFits } from '../src/fits'
import { FitsDataSource, readImageFromFits, writeImageToFits } from '../src/image'
import { adf, blur5x5, convolution, convolutionKernel, debayer, edges, emboss, gaussianBlur, grayscale, horizontalFlip, invert, mean, psf, scnr, sharpen, stf, verticalFlip } from '../src/image.transformation'
import { fileHandleSink, fileHandleSource } from '../src/io'
import { BITPIXES, CHANNELS, readImage, readImageAndSaveWithOptions, readImageTransformAndSave, saveImageAndCompareHash } from './image.util'

test('readImageFromFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [image, fits] = await readImage(bitpix, channel)

			expect(image!.header).toBe(fits!.hdus[0].header)

			const hash = channel === 1 ? 'e298f4abb217bac172a36f027ac6d8db' : '0a1b903f8612fa73756c266fddee0706'

			await readImageTransformAndSave((i) => i, `read-${bitpix}.${channel}`, hash, bitpix, channel)
		}
	}
}, 15000)

test('writeImageToFits', async () => {
	for (const bitpix of BITPIXES) {
		for (const channel of CHANNELS) {
			const [image0] = await readImage(bitpix, channel)
			const key = `${bitpix}.${channel}`

			let handle = await fs.open(`out/witf-${key}.fit`, 'w+')
			await using sink = fileHandleSink(handle)
			await writeImageToFits(image0, sink)

			handle = await fs.open(`out/witf-${key}.fit`, 'r')
			await using source = fileHandleSource(handle)
			const image1 = await readImageFromFits(await readFits(source))

			expect(image0.header).toEqual(image1!.header)

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
	const image = await readImageTransformAndSave((i) => stf(debayer(i) ?? i, 0.05), 'debayer-grbg', '3f049c06d25eec196b3d37471776de01', Bitpix.SHORT, 1, 'fit', 'GRBG')

	expect(image.header.NAXIS).toBe(3)
	expect(image.header.NAXIS3).toBe(3)
	expect(image.metadata.channels).toBe(3)
}, 5000)

test('stf', () => {
	return readImageTransformAndSave((i) => stf(i, 0.005), 'stf', 'b690674f467c3416d09d551157f4e3c2')
}, 5000)

test('auto stf', () => {
	return readImageTransformAndSave((i) => stf(i, ...adf(i)), 'stf-auto', '3e1d22fb79df143993138e5b28611f6d')
}, 5000)

test('scnr', () => {
	return readImageTransformAndSave((i) => scnr(i, 'GREEN', 0.9), 'scnr', '73f4a8308f0e234610b913400cce2adb')
}, 5000)

test('horizontal flip', () => {
	return readImageTransformAndSave((i) => horizontalFlip(i), 'flip-h', '56b0ed9d8c265f1eb1d5ca2cdea1d619')
}, 5000)

test('vertical flip', () => {
	return readImageTransformAndSave((i) => verticalFlip(i), 'flip-v', '0c07e73e73bd7383c799874da41ee284')
}, 5000)

test('horizontal & vertical flip', () => {
	return readImageTransformAndSave((i) => verticalFlip(horizontalFlip(i)), 'flip-hv', 'fd71d2b9372436699bf54f58f9dbadf5')
}, 5000)

test('invert', () => {
	return readImageTransformAndSave((i) => invert(i), 'invert', 'a9b92211de5965f5afb1aab2f0427b79')
}, 5000)

test('grayscale', async () => {
	const image = await readImageTransformAndSave((i) => grayscale(i), 'grayscale', '462d4b777ec6d7bc374c96c3fa8ae24f')

	expect(image.header.NAXIS).toBe(2)
	expect(image.header.NAXIS3).toBeUndefined()
	expect(image.metadata.stride).toBe(image.metadata.width)
	expect(image.metadata.channels).toBe(1)
}, 5000)

test('red grayscale', () => {
	return readImageTransformAndSave((i) => grayscale(i, 'RED'), 'grayscale-red', 'd2ec26a745f4354337d69ed260210c7f')
}, 5000)

test('convolution identity 3x3', () => {
	const kernel = convolutionKernel(new Float64Array([0, 0, 0, 0, 1, 0, 0, 0, 0]), 3)
	return readImageTransformAndSave((i) => convolution(i, kernel), 'conv-identity-3', '0a1b903f8612fa73756c266fddee0706')
}, 5000)

test('convolution identity 5x5', () => {
	const kernel = convolutionKernel(new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 5)
	return readImageTransformAndSave((i) => convolution(i, kernel), 'conv-identity-5', '0a1b903f8612fa73756c266fddee0706')
}, 5000)

test('convolution edges', () => {
	return readImageTransformAndSave((i) => edges(i), 'conv-edges', 'd9127c5a23401b825e3723a745c3816f')
}, 5000)

test('convolution emboss', () => {
	return readImageTransformAndSave((i) => emboss(i), 'conv-emboss', '697d469d1054d1ab5968c770c7a1d933')
}, 5000)

test('convolution sharpen', () => {
	return readImageTransformAndSave((i) => sharpen(i), 'conv-sharpen', '08cdbeae49b286e57f5023caca63baed')
}, 5000)

test('convolution mean', () => {
	return readImageTransformAndSave((i) => mean(i), 'conv-mean', '8d3677043d6d3ccd08d4bf6f3143e099')
}, 5000)

test('convolution blur 5x5', () => {
	return readImageTransformAndSave((i) => blur5x5(i), 'conv-blur-5', '4fb12cb57692f4ff35d0ec88293950a0')
}, 5000)

test('convolution gaussian blur', () => {
	return readImageTransformAndSave((i) => gaussianBlur(i), 'conv-gaussian-blur', 'd20c32b6329a9fabbe641d1f2ea6307e')
}, 5000)

test('convolution gaussian blur 11x11', () => {
	return readImageTransformAndSave((i) => gaussianBlur(i, { sigma: 3, size: 11 }), 'conv-gaussian-blur-11', '666479278a517554e6cdd15f117e5a90')
}, 5000)

test('psf', () => {
	return readImageTransformAndSave((i) => psf(i), 'psf', '988a9ee41852e889d37b712d51653fe4')
}, 5000)

test('mean + psf', () => {
	return readImageTransformAndSave((i) => psf(mean(grayscale(i))), 'mean-psf', 'e26eeaa2e1991f2709a85e898ce9fdf8')
}, 5000)

test('horizontal flip', () => {
	return readImageAndSaveWithOptions({ horizontalFlip: true }, 'flip-h-2', '56b0ed9d8c265f1eb1d5ca2cdea1d619')
}, 5000)

test('vertical flip', () => {
	return readImageAndSaveWithOptions({ verticalFlip: true }, 'flip-v-2', '0c07e73e73bd7383c799874da41ee284')
}, 5000)

test('sharpen', () => {
	return readImageAndSaveWithOptions({ sharpen: true }, 'sharpen', 'e45a3f735e0a2ac6a55509f0c618e55b')
}, 5000)

test('normalize', () => {
	return readImageAndSaveWithOptions({ normalize: true }, 'normalize', '0a1b903f8612fa73756c266fddee0706')
}, 5000)

test('brightness', () => {
	return readImageAndSaveWithOptions({ brightness: 30 }, 'brightness', '06b7df04c9110fd6b5fa04d15d0c0b48')
}, 5000)

test('contrast', () => {
	return readImageAndSaveWithOptions({ contrast: 5 }, 'contrast', 'd407e71e6fc4108082249dc0bb3c0bf6')
}, 5000)

test('saturation', () => {
	return readImageAndSaveWithOptions({ saturation: 30 }, 'saturation', '2103ecbf94a8006ea7dfd1a2551ccfe2')
}, 5000)

test('brightness & saturation', () => {
	return readImageAndSaveWithOptions({ brightness: 30, saturation: 30 }, 'brightness-saturation', 'ce8ad38b1ccf90f227e568523df94326')
}, 5000)

test('gamma', () => {
	return readImageAndSaveWithOptions({ gamma: 2.2 }, 'gamma', '22c9e73c1ec3f917896503370b06548e')
}, 5000)

test('median', () => {
	return readImageAndSaveWithOptions({ median: true }, 'median', '18ab1f9f14e5776e00b3c3b7eddff13d')
}, 5000)

test('blur', () => {
	return readImageAndSaveWithOptions({ blur: true }, 'blur', 'e71d4f269e5d5a483fce3f5e8b0d3584')
}, 5000)

test('negate', () => {
	return readImageAndSaveWithOptions({ negate: true }, 'negate', 'a9b92211de5965f5afb1aab2f0427b79')
}, 5000)
