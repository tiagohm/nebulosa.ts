import { describe, expect, test } from 'bun:test'
import { Jpeg } from '../src/libturbojpeg'
import { saveAndCompareHash } from './image.util'

describe('compress', () => {
	const jpeg = new Jpeg()

	const rgb = Buffer.alloc(100 * 100 * 3)
	for (let i = 0; i < rgb.length; i += 9) rgb[i] = 255 // R
	for (let i = 4; i < rgb.length; i += 9) rgb[i] = 255 // G
	for (let i = 8; i < rgb.length; i += 9) rgb[i] = 255 // B

	const grayscale = Buffer.alloc(100 * 100)
	for (let i = 0; i < grayscale.length; i++) grayscale[i] = i % 256

	test('rgb', () => {
		const bytes = jpeg.compress(rgb, 100, 100, 'RGB', 100)
		expect(bytes).toBeDefined()
		return saveAndCompareHash(bytes!, 'compress-rgb.jpg', 'd9b243a3bdab8deb8b51c837ba4bfed1')
	})

	test('rgb with chrominance subsampling 4:2:0', () => {
		const bytes = jpeg.compress(rgb, 100, 100, 'RGB', 75, '4:2:0')
		expect(bytes).toBeDefined()
		return saveAndCompareHash(bytes!, 'compress-rgb-420.jpg', 'ef3bacf9d7b6b27091626fed7ddafb7e')
	})

	test('rgb grayscale', () => {
		const bytes = jpeg.compress(rgb, 100, 100, 'RGB', 100, 'GRAY')
		expect(bytes).toBeDefined()
		return saveAndCompareHash(bytes!, 'compress-rgb-grayscale.jpg', 'a50f0ae28aa5eb7c9182c559f6c6add2')
	})

	test('grayscale', () => {
		const bytes = jpeg.compress(grayscale, 100, 100, 'GRAY', 100)
		expect(bytes).toBeDefined()
		return saveAndCompareHash(bytes!, 'compress-grayscale.jpg', '81b2c116b552e4f0b6f5291a12d24797')
	})
})

describe('read header', () => {
	const jpeg = new Jpeg()

	test('rgb', () => {
		const width = 16
		const height = 8
		const rgb = Buffer.alloc(width * height * 3, 128)
		const bytes = jpeg.compress(rgb, width, height, 'RGB', 90, '4:2:0')

		expect(bytes).toBeDefined()
		expect(jpeg.readHeader(bytes!)).toEqual({ width, height, subsampling: '4:2:0', colorspace: 'YCbCr' })
	})

	test('grayscale', () => {
		const width = 16
		const height = 8
		const grayscale = Buffer.alloc(width * height, 128)
		const bytes = jpeg.compress(grayscale, width, height, 'GRAY', 90)

		expect(bytes).toBeDefined()
		expect(jpeg.readHeader(bytes!)).toEqual({ width, height, subsampling: 'GRAY', colorspace: 'GRAY' })
	})
})

describe('decompress', () => {
	const jpeg = new Jpeg()

	test('grayscale', () => {
		const width = 16
		const height = 8
		const grayscale = Buffer.alloc(width * height)

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				grayscale[y * width + x] = Math.round((x / (width - 1)) * 255)
			}
		}

		const bytes = jpeg.compress(grayscale, width, height, 'GRAY', 100)
		expect(bytes).toBeDefined()

		const decoded = jpeg.decompress(bytes!, 'GRAY')
		expect(decoded).toBeDefined()
		expect(decoded!.width).toBe(width)
		expect(decoded!.height).toBe(height)
		expect(decoded!.format).toBe('GRAY')
		expect(decoded!.data.length).toBe(grayscale.length)

		let maxDelta = 0

		for (let i = 0; i < grayscale.length; i++) {
			maxDelta = Math.max(maxDelta, Math.abs(grayscale[i] - decoded!.data[i]))
		}

		expect(maxDelta).toBeLessThanOrEqual(8)
	})
})
