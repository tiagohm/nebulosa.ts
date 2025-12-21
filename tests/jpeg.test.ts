import { describe, expect, test } from 'bun:test'
import { ChrominanceSubsampling, Jpeg, PixelFormat } from '../src/jpeg'
import { saveAndCompareHash } from './image.util'

describe('compress', () => {
	const jpeg = new Jpeg()

	const rgb = Buffer.alloc(100 * 100 * 3)
	for (let i = 0; i < rgb.length; i += 9) rgb[i] = 255 // R
	for (let i = 4; i < rgb.length; i += 9) rgb[i] = 255 // G
	for (let i = 8; i < rgb.length; i += 9) rgb[i] = 255 // B

	const grayscale = Buffer.alloc(100 * 100)
	for (let i = 0; i < grayscale.length; i++) grayscale[i] = i % 256

	test('rgb', async () => {
		const bytes = jpeg.compress(rgb, 100, 100, PixelFormat.RGB, 100, ChrominanceSubsampling.C444)
		expect(bytes).toBeDefined()
		await saveAndCompareHash(bytes!, 'compress-rgb.jpg', 'd9b243a3bdab8deb8b51c837ba4bfed1')
	})

    test('rgb with chrominance subsampling 4:2:0', async () => {
		const bytes = jpeg.compress(rgb, 100, 100, PixelFormat.RGB, 75)
		expect(bytes).toBeDefined()
		await saveAndCompareHash(bytes!, 'compress-rgb-420.jpg', 'ef3bacf9d7b6b27091626fed7ddafb7e')
	})

	test('rgb grayscale', async () => {
		const bytes = jpeg.compress(rgb, 100, 100, PixelFormat.RGB, 100, ChrominanceSubsampling.GRAY)
		expect(bytes).toBeDefined()
		await saveAndCompareHash(bytes!, 'compress-rgb-grayscale.jpg', 'a50f0ae28aa5eb7c9182c559f6c6add2')
	})

	test('grayscale', async () => {
		const bytes = jpeg.compress(grayscale, 100, 100, PixelFormat.GRAY, 100)
		expect(bytes).toBeDefined()
		await saveAndCompareHash(bytes!, 'compress-grayscale.jpg', '81b2c116b552e4f0b6f5291a12d24797')
	})
})
