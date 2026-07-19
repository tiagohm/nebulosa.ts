import { reflectFitsWcs } from '../../astrometry/wcs/fits.wcs'
import { validateNonNegativeFinite } from '../../core/validation'
import { channelIndex, grayscaleFromChannel, type Image, type ImageChannelOrGray, type ImageMetadata, makeImageRawTypedArray, shiftCfaPattern } from '../model/types'

// Geometric and channel operations on dense normalized images. Flips and inversion mutate the input;
// grayscale returns a fresh mono image. Flips keep CFA phase and FITS WCS aligned with moved pixels.

// Absolute tolerance accepted for normalized custom grayscale weights.
const GRAYSCALE_WEIGHT_SUM_TOLERANCE = 1e-6
// Structural and WCS keywords tied to a removed third image axis.
const THIRD_AXIS_HEADER_KEY_PATTERN = /^(?:NAXIS3|ZNAXIS3|ZTILE3|CUNIT3|CTYPE3|CRPIX3|CRVAL3|CDELT3|CROTA3|(?:CD|PC)(?:3_\d+|\d+_3)|(?:PS|PV)3_\d+)$/

// Verifies the dense mono or interleaved RGB layout required by geometry operations.
function validateGeometryImage(image: Image) {
	const { width, height, channels, stride, pixelCount } = image.metadata
	if (!Number.isInteger(width) || width <= 0) throw new Error(`image width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || height <= 0) throw new Error(`image height must be a positive integer: ${height}`)
	if (channels !== 1 && channels !== 3) throw new Error(`image channels must be 1 or 3: ${channels}`)
	const expectedPixelCount = width * height
	if (pixelCount !== expectedPixelCount) throw new Error(`image pixelCount does not match geometry: ${pixelCount} != ${expectedPixelCount}`)
	const expectedStride = width * channels
	if (stride !== expectedStride) throw new Error(`image stride does not match geometry: ${stride} != ${expectedStride}`)
	const expectedLength = pixelCount * channels
	if (image.raw.length !== expectedLength) throw new Error(`image raw length does not match metadata: ${image.raw.length} != ${expectedLength}`)
}

// Verifies finite non-negative grayscale weights normalized to unit sum.
function validateGrayscaleWeights(red: number, green: number, blue: number) {
	validateNonNegativeFinite(red)
	validateNonNegativeFinite(green)
	validateNonNegativeFinite(blue)
	const sum = red + green + blue
	if (Math.abs(sum - 1) > GRAYSCALE_WEIGHT_SUM_TOLERANCE) throw new RangeError(`grayscale weights must sum to one: ${sum}`)
}

// Shifts raw CFA phase metadata after a reflection whose new origin maps to the supplied old offset.
function reflectCfaPattern(image: Image, offsetX: number, offsetY: number) {
	if (image.metadata.channels !== 1 || image.metadata.bayer === undefined) return
	const pattern = shiftCfaPattern(image.metadata.bayer, offsetX, offsetY)!
	Object.assign(image.metadata, { bayer: pattern })
	image.header.BAYERPAT = pattern
}

// Mirrors the image across the vertical axis in place and updates WCS and raw-CFA phase metadata.
export function horizontalFlip(image: Image) {
	validateGeometryImage(image)
	const { raw, metadata, header } = image
	const { width, height, channels, stride } = metadata
	reflectFitsWcs(header, width, height, true, false)
	reflectCfaPattern(image, width - 1, 0)
	const halfWidth = width >>> 1

	if (channels === 1) {
		for (let y = 0; y < height; y++) {
			let left = y * stride
			let right = left + width - 1
			for (let x = 0; x < halfWidth; x++, left++, right--) {
				const value = raw[left]
				raw[left] = raw[right]
				raw[right] = value
			}
		}
	} else {
		for (let y = 0; y < height; y++) {
			let left = y * stride
			let right = left + (width - 1) * 3
			for (let x = 0; x < halfWidth; x++, left += 3, right -= 3) {
				let value = raw[left]
				raw[left] = raw[right]
				raw[right] = value
				value = raw[left + 1]
				raw[left + 1] = raw[right + 1]
				raw[right + 1] = value
				value = raw[left + 2]
				raw[left + 2] = raw[right + 2]
				raw[right + 2] = value
			}
		}
	}

	return image
}

// Mirrors the image across the horizontal axis in place and updates WCS and raw-CFA phase metadata.
export function verticalFlip(image: Image) {
	validateGeometryImage(image)
	const { raw, metadata, header } = image
	const { width, height, channels, stride } = metadata
	reflectFitsWcs(header, width, height, false, true)
	reflectCfaPattern(image, 0, height - 1)
	const lastRow = (height - 1) * stride
	const halfHeight = height >>> 1

	if (channels === 1) {
		for (let y = 0; y < halfHeight; y++) {
			const top = y * stride
			const bottom = lastRow - top
			for (let x = 0; x < stride; x++) {
				const value = raw[top + x]
				raw[top + x] = raw[bottom + x]
				raw[bottom + x] = value
			}
		}
	} else {
		for (let y = 0; y < halfHeight; y++) {
			const top = y * stride
			const bottom = lastRow - top
			for (let x = 0; x < stride; x += 3) {
				let value = raw[top + x]
				raw[top + x] = raw[bottom + x]
				raw[bottom + x] = value
				value = raw[top + x + 1]
				raw[top + x + 1] = raw[bottom + x + 1]
				raw[bottom + x + 1] = value
				value = raw[top + x + 2]
				raw[top + x + 2] = raw[bottom + x + 2]
				raw[bottom + x + 2] = value
			}
		}
	}

	return image
}

// Inverts every normalized sample in place after validating dense image storage.
export function invert(image: Image) {
	validateGeometryImage(image)
	const { raw } = image
	const n = raw.length
	for (let i = 0; i < n; i++) raw[i] = 1 - raw[i]
	return image
}

// Converts a dense RGB image to a fresh single-channel image, or returns an already-mono image.
export function grayscale(image: Image, channel?: ImageChannelOrGray): Image {
	validateGeometryImage(image)
	if (image.metadata.channels === 1) return image

	let red = 0
	let green = 0
	let blue = 0
	const extractsChannel = channel === 'RED' || channel === 'GREEN' || channel === 'BLUE'
	if (!extractsChannel) {
		const weights = grayscaleFromChannel(channel)
		if (!weights) throw new RangeError(`unsupported grayscale channel: ${typeof channel === 'string' ? channel : 'custom weights'}`)
		red = weights.red
		green = weights.green
		blue = weights.blue
		validateGrayscaleWeights(red, green, blue)
	}

	const header = { ...image.header }
	for (const key in header) if (THIRD_AXIS_HEADER_KEY_PATTERN.test(key)) delete header[key]
	if (header.WCSAXES !== undefined) header.WCSAXES = 2
	delete header.BAYERPAT
	header.NAXIS = 2

	const { width, pixelCount, pixelSizeInBytes } = image.metadata
	const metadata: ImageMetadata = { ...image.metadata, bayer: undefined, channels: 1, stride: width, strideInBytes: width * pixelSizeInBytes }
	const color = image.raw
	const raw = makeImageRawTypedArray(color, pixelCount)

	if (extractsChannel) {
		for (let i = 0, k = channelIndex(channel); i < pixelCount; i++, k += 3) raw[i] = color[k]
	} else {
		for (let i = 0, k = 0; i < pixelCount; i++) raw[i] = color[k++] * red + color[k++] * green + color[k++] * blue
	}

	return { header, metadata, raw }
}
