import { channelIndex, grayscaleFromChannel, type Image, type ImageChannelOrGray, type ImageMetadata } from '../model/types'

// Mirrors the image across the vertical axis in place.
export function horizontalFlip(image: Image) {
	const { raw, metadata } = image
	const { height, channels, stride } = metadata
	const maxW = Math.trunc(stride / 2)
	const sc = stride - channels

	for (let y = 0; y < height; y++) {
		const k = y * stride

		for (let x = 0; x < maxW; x += channels) {
			let si = k + sc - x
			let ei = k + x

			for (let i = 0; i < channels; i++, si++, ei++) {
				const p = raw[si]
				raw[si] = raw[ei]
				raw[ei] = p
			}
		}
	}

	return image
}

// Mirrors the image across the horizontal axis in place.
export function verticalFlip(image: Image) {
	const { raw, metadata } = image
	const { height, channels, stride } = metadata
	const sh = (height - 1) * stride
	const maxH = Math.trunc(height / 2)

	for (let y = 0; y < maxH; y++) {
		const k = y * stride
		const ek = sh - k

		for (let x = 0; x < stride; x += channels) {
			let si = k + x
			let ei = ek + x

			for (let i = 0; i < channels; i++, si++, ei++) {
				const p = raw[si]
				raw[si] = raw[ei]
				raw[ei] = p
			}
		}
	}

	return image
}

// Inverts every normalized sample in place.
export function invert(image: Image) {
	const { raw } = image
	const n = raw.length

	for (let i = 0; i < n; i++) {
		raw[i] = 1 - raw[i]
	}

	return image
}

// Converts an RGB image to a single grayscale channel.
export function grayscale(image: Image, channel?: ImageChannelOrGray): Image {
	if (image.metadata.channels === 1) return image

	const header = structuredClone(image.header)
	const metadata: ImageMetadata = { ...image.metadata, bayer: undefined, channels: 1, stride: image.metadata.width }

	const color = image.raw
	const n = metadata.pixelCount
	const raw = image.raw instanceof Float64Array ? new Float64Array(n) : new Float32Array(n)
	const { red, green, blue } = grayscaleFromChannel(channel)

	if (channel === 'RED' || channel === 'GREEN' || channel === 'BLUE') {
		for (let i = 0, k = channelIndex(channel); i < n; i++, k += 3) {
			raw[i] = color[k]
		}
	} else {
		for (let i = 0, k = 0; i < n; i++) {
			raw[i] = color[k++] * red + color[k++] * green + color[k++] * blue
		}
	}

	delete header.NAXIS3
	delete header.BAYERPAT
	header.NAXIS = 2

	return { header, metadata, raw }
}
