import type { PathLike } from 'fs'
import sharp, { type FormatEnum, type OutputInfo } from 'sharp'
import { Bitpix, bitpix, naxisn, read, type Fits, type FitsHeader } from './fits'

export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

export type ImageFormat = 'FITS' | 'JPEG' | 'PNG'

export interface Image extends Readonly<Record<Lowercase<ImageChannel>, Float64Array | undefined>> {
	readonly header: FitsHeader
	readonly metadata: ImageMetadata
}

export interface ImageMetadata {
	readonly width: number
	readonly height: number
	readonly numberOfChannels: number
	readonly numberOfPixels: number
	readonly sizeInBytes: number
}

export async function fits(path: PathLike | Fits): Promise<Image | undefined> {
	const fits = typeof path === 'object' && 'hdus' in path ? path : await read(path)

	if (fits) {
		const { header, data } = fits.hdus[0]
		const bp = bitpix(header)
		if (bp === Bitpix.LONG) return undefined
		const width = naxisn(header, 1)
		const height = naxisn(header, 2)
		const numberOfChannels = Math.max(1, Math.min(3, naxisn(header, 3, 1)))
		const sizeInBytes = Math.trunc(Math.abs(bp) / 8)
		const numberOfPixels = width * height
		const stride = width * sizeInBytes
		const buffer = Buffer.alloc(stride)
		const { handle, offset } = data!
		const channels = new Array<Float64Array>(numberOfChannels)

		for (let channel = 0; channel < numberOfChannels; channel++) {
			const pixels = new Float64Array(numberOfPixels)

			// if (bp === Bitpix.DOUBLE) {
			// 	await handle!.read(pixels, 0, pixels.byteLength, offset)
			// } else {
			let index = 0

			for (let i = 0, position = offset + channel * numberOfPixels * sizeInBytes; i < height; i++, position += stride) {
				const ret = await handle!.read(buffer, 0, stride, position)

				for (let k = 0; k < ret.bytesRead; k += sizeInBytes) {
					let pixel = 0

					if (bp === Bitpix.BYTE) pixel = buffer.readUInt8(k) / 255.0
					else if (bp === Bitpix.SHORT) pixel = (buffer.readInt16BE(k) + 32768) / 65535.0
					else if (bp === Bitpix.INTEGER) pixel = (buffer.readInt32BE(k) + 2147483648) / 4294967295.0
					else if (bp === Bitpix.FLOAT) pixel = buffer.readFloatBE(k)
					else if (bp === Bitpix.DOUBLE) pixel = buffer.readDoubleBE(k)

					pixels[index++] = pixel
				}
			}
			// }

			channels[channel] = pixels
		}

		await fits.close()

		const metadata: ImageMetadata = { width, height, numberOfChannels, numberOfPixels, sizeInBytes }
		return { header, metadata, red: channels[0], green: channels[1], blue: channels[2] }
	}

	return undefined
}

export async function saveTo(image: Image, path: string, format: keyof FormatEnum) {
	const { width, height, numberOfPixels, numberOfChannels } = image.metadata
	const input = new Uint8Array(numberOfPixels * numberOfChannels)
	const channels = [image.red, image.green, image.blue]

	for (let c = 0; c < numberOfChannels; c++) {
		const channel = channels[c]!

		for (let i = 0, k = c; i < numberOfPixels; i++, k += numberOfChannels) {
			input[k] = Math.trunc(channel[i] * 255.0)
		}
	}

	await sharp(input, { raw: { width, height, channels: numberOfChannels as OutputInfo['channels'] } })
		.toFormat(format)
		.toFile(path)
}

// Apply Screen Transfer Function to image.
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Display_Function__
// https://pixinsight.com/tutorials/24-bit-stf/
export function stf(image: Image, midtone: number = 0.5, shadow: number = 0, highlight: number = 1) {
	if (midtone === 0.5 && shadow === 0 && highlight === 1) return image

	const { numberOfPixels } = image.metadata
	const rangeFactor = shadow === highlight ? 1 : 1 / (highlight - shadow)
	const k1 = (midtone - 1) * rangeFactor
	const k2 = (2 * midtone - 1) * rangeFactor
	const lut = new Float64Array(65536).fill(NaN)

	function df(value: number) {
		const p = Math.max(0, Math.min(Math.trunc(value * 65535), 65535))
		if (!isNaN(lut[p])) return lut[p]
		if (value < shadow) return 0
		if (value > highlight) return 1

		const i = value - shadow
		value = (i * k1) / (i * k2 - midtone)
		lut[p] = value

		return value
	}

	for (let i = 0; i < numberOfPixels; i++) {
		if (image.red) image.red[i] = df(image.red[i])
		if (image.green) image.green[i] = df(image.green[i])
		if (image.blue) image.blue[i] = df(image.blue[i])
	}

	return image
}
