import { expect, test } from 'bun:test'
import { makeImageBytesFromFits } from '../src/alpaca.server'
import { bitpixInBytes } from '../src/fits'
import { Jpeg } from '../src/jpeg'
import { CHANNELS, saveAndCompareHash } from './image.util'

test('make image bytes from fits', async () => {
	const jpeg = new Jpeg()
	const output = Buffer.allocUnsafe(jpeg.estimateBufferSize(706, 1037, '4:4:4'))

	for (const bitpix of [8, 16]) {
		for (const channel of CHANNELS) {
			const buffer = await Bun.file(`data/NGC3372-${bitpix}.${channel}.fit`).arrayBuffer()
			const bytes = makeImageBytesFromFits(Buffer.from(buffer)).subarray(44)
			expect(bytes.byteLength).toBe(channel * 1037 * 706 * bitpixInBytes(bitpix))

			if (bitpix === 16) for (let i = 1, k = 0; i < bytes.byteLength; i += 2, k++) bytes[k] = bytes[i] + (bytes[i - 1] >>> 8)

			if (channel === 1) {
				const hash = bitpix === 8 ? 'a893bd416ad767923730a05aff9717b0' : 'afe683cfb71daa3df1de985c4d5f2090'
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'GRAY', 100, 'GRAY', output)!, `imagebytes-${bitpix}-1.jpg`, hash)
			} else {
				const hash = bitpix === 8 ? 'b35a4a24e3f51a725288ea8edf6e215f' : '643a16c1c94fabb47b0823f88a3abdfd'
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'RGB', 100, '4:4:4', output)!, `imagebytes-${bitpix}-3.jpg`, hash)
			}
		}
	}
}, 5000)
