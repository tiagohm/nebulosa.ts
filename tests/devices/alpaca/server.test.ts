import { expect, test } from 'bun:test'
import { Jpeg } from '../../../src/bindings/imaging/libturbojpeg'
import { makeImageBytesFromFits } from '../../../src/devices/alpaca/server'
import { AlpacaImageElementType } from '../../../src/devices/alpaca/types'
import { bitpixInBytes } from '../../../src/io/formats/fits/util'
import { downloadPerTag } from '../../download'
import { saveAndCompareHash } from '../../imaging/util'

await downloadPerTag('alpaca.server')

test('image bytes metadata header encodes version, rank, and dimensions', async () => {
	// Mono (NAXIS3 absent) -> rank 2, third dimension 0; color -> rank 3, third dimension 3.
	for (const channel of [1, 3]) {
		const buffer = await Bun.file(`data/NGC3372-16.${channel}.fit`).arrayBuffer()
		const bytes = makeImageBytesFromFits(Buffer.from(buffer))

		expect(bytes.readInt32LE(0)).toBe(1) // metadata version
		expect(bytes.readInt32LE(4)).toBe(0) // error number
		expect(bytes.readInt32LE(16)).toBe(44) // data start offset (44 for 16-bit)
		expect(bytes.readInt32LE(28)).toBe(channel === 1 ? 2 : 3) // rank
		expect(bytes.readInt32LE(32)).toBe(1037) // first dimension
		expect(bytes.readInt32LE(36)).toBe(706) // second dimension
		expect(bytes.readInt32LE(40)).toBe(channel === 1 ? 0 : 3) // third dimension
	}
})

test('image bytes metadata aligns 64-bit payloads', async () => {
	const buffer = await Bun.file('data/NGC3372--64.1.fit').arrayBuffer()
	const bytes = makeImageBytesFromFits(Buffer.from(buffer))

	expect(bytes.readInt32LE(16)).toBe(48) // 64-bit payloads start on an 8-byte boundary.
	expect(bytes.readInt32LE(24)).toBe(AlpacaImageElementType.Double)
	expect(bytes.byteLength - 48).toBe(1037 * 706 * bitpixInBytes(-64))
})

test('make image bytes from fits', async () => {
	const jpeg = new Jpeg()
	const output = Buffer.allocUnsafe(jpeg.estimateBufferSize(706, 1037, '4:4:4'))

	for (const bitpix of [8, 16]) {
		for (const channel of [1, 3]) {
			const buffer = await Bun.file(`data/NGC3372-${bitpix}.${channel}.fit`).arrayBuffer()
			const bytes = makeImageBytesFromFits(Buffer.from(buffer)).subarray(44)
			expect(bytes.byteLength).toBe(channel * 1037 * 706 * bitpixInBytes(bitpix))

			if (bitpix === 16) for (let i = 1, k = 0; i < bytes.byteLength; i += 2, k++) bytes[k] = bytes[i] + (bytes[i - 1] >>> 8)

			if (channel === 1) {
				const hash = bitpix === 8 ? 'a893bd416ad767923730a05aff9717b0' : 'afe683cfb71daa3df1de985c4d5f2090'
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'GRAY', 100, 'GRAY', output)!, `imagebytesfromfits-${bitpix}-1.jpg`, hash)
			} else {
				const hash = bitpix === 8 ? 'b35a4a24e3f51a725288ea8edf6e215f' : '643a16c1c94fabb47b0823f88a3abdfd'
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'RGB', 100, '4:4:4', output)!, `imagebytesfromfits-${bitpix}-3.jpg`, hash)
			}
		}
	}
}, 5000)
