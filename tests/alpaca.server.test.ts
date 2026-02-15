import { expect, test } from 'bun:test'
import { makeImageBytesFromFits } from '../src/alpaca.server'
import { Jpeg } from '../src/jpeg'
import { CHANNELS, openFitsFromBuffer, saveAndCompareHash } from './image.util'

test.skip('make image bytes from fits', async () => {
	const jpeg = new Jpeg()
	const output = Buffer.allocUnsafe(jpeg.estimateBufferSize(706, 1037, '4:4:4'))

	for (const bitpix of [8, 16]) {
		for (const channel of CHANNELS) {
			const [, buffer] = await openFitsFromBuffer(bitpix, channel)
			const bytes = makeImageBytesFromFits(buffer).subarray(44)
			expect(bytes.byteLength).toBe(channel * 1037 * 706)

			if (channel === 1) {
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'GRAY', 100, 'GRAY', output)!, `imagebytes-${bitpix}-1.jpg`, undefined)
			} else {
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'RGB', 100, '4:4:4', output)!, `imagebytes-${bitpix}-3.jpg`, undefined)
			}
		}
	}
}, 5000)
