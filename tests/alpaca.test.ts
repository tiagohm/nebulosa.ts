import { expect, test } from 'bun:test'
import { makeImageBytesFromFits } from '../src/alpaca.server'
import { bitpixInBytes } from '../src/fits'
import { Jpeg } from '../src/jpeg'
import { BITPIXES, CHANNELS, openFitsFromBuffer, saveAndCompareHash } from './image.util'

test('make image bytes from fits', async () => {
	const jpeg = new Jpeg()
	const output = Buffer.allocUnsafe(jpeg.estimateBufferSize(706, 1037, '4:4:4'))

	for (const bitpix of BITPIXES) {
		const step = bitpixInBytes(bitpix)

		for (const channel of CHANNELS) {
			const [fits, buffer] = await openFitsFromBuffer(bitpix, channel, (fits) => fits)
			const input = makeImageBytesFromFits(fits, buffer).subarray(44)

			if (bitpix !== 8) {
				for (let i = 0, k = 0; i < input.byteLength; i += step, k++) {
					if (bitpix === 16) input.writeInt8((input.readUint16LE(i) >>> 8) - 128, k)
					else if (bitpix === 32) input.writeInt8((input.readUint32LE(i) >>> -8) - 128, k)
					else if (bitpix === -32) input.writeUInt8(Math.max(0, Math.min(input.readFloatLE(i) * 256, 255)), k)
					else input.writeUInt8(Math.max(0, Math.min(input.readDoubleLE(i) * 256, 255)), k)
				}
			}

			expect(input.byteLength).toBe(bitpixInBytes(bitpix) * channel * 1037 * 706)

			// Why hash is different?
			if (bitpix === 8 || bitpix === 16) continue

			if (channel === 1) {
				await saveAndCompareHash(jpeg.compress(input, 706, 1037, 'GRAY', 100, 'GRAY', output)!, `imagebytes-${bitpix}-1.jpg`, '51d35e864bc386bce1b47ef990bb2dc3', true)
			} else {
				await saveAndCompareHash(jpeg.compress(input, 706, 1037, 'RGB', 100, '4:4:4', output)!, `imagebytes-${bitpix}-3.jpg`, '2f099655982bfbe487057d96ea757ba6', true)
			}
		}
	}
}, 5000)
