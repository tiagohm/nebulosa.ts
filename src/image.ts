import sharp, { type AvifOptions, type FormatEnum, type GifOptions, type HeifOptions, type Jp2Options, type JpegOptions, type JxlOptions, type OutputOptions, type PngOptions, type TiffOptions, type WebpOptions } from 'sharp'
import { Bitpix, type Fits, type FitsData, type FitsHdu, type FitsHeader, bitpix, bitpixInBytes, height, numberOfChannels, text, width, writeFits } from './fits'
import { type Sink, type Source, bufferSink, bufferSource, readUntil } from './io'
import { Histogram } from './statistics'

export type ImageChannel = 'RED' | 'GREEN' | 'BLUE'

export type ImageFormat = keyof FormatEnum | 'fits' | 'xisf'

export type CfaPattern = 'RGGB' | 'BGGR' | 'GBRG' | 'GRBG' | 'GRGB' | 'GBGR' | 'RGBG' | 'BGRG'

export type SCNRProtectionMethod = 'MAXIMUM_MASK' | 'ADDITIVE_MASK' | 'AVERAGE_NEUTRAL' | 'MAXIMUM_NEUTRAL' | 'MINIMUM_NEUTRAL'

export type SCNRAlgorithm = (a: number, b: number, c: number, amount: number) => number

export type Grayscale = Readonly<Record<Lowercase<ImageChannel>, number>>

export type GrayscaleAlgorithm = 'BT709' | 'RMY' | 'Y' | Grayscale

export type ImageChannelOrGray = ImageChannel | GrayscaleAlgorithm | 'GRAY'

export type HistogramPixelTransform = (p: number) => number

export interface WriteImageToFormatOptions {
	format?: OutputOptions | JpegOptions | PngOptions | WebpOptions | AvifOptions | HeifOptions | JxlOptions | GifOptions | Jp2Options | TiffOptions
	horizontalFlip?: boolean
	verticalFlip?: boolean
	sharpen?: boolean
	median?: boolean
	blur?: boolean
	gamma?: number // 1 - 3
	normalize?: boolean // Enhance output image contrast
	brightness?: number
	saturation?: number
	negate?: boolean
}

export interface Image {
	readonly header: FitsHeader
	readonly metadata: ImageMetadata
	readonly raw: Float64Array
}

export interface ImageMetadata {
	readonly width: number
	readonly height: number
	readonly channels: number
	readonly strideInPixels: number
	readonly pixelCount: number
	readonly pixelSizeInBytes: number
	readonly bitpix: Bitpix
	readonly bayer?: CfaPattern
}

export const BT709_GRAYSCALE: Grayscale = { red: 0.2125, green: 0.7154, blue: 0.0721 }
export const RMY_GRAYSCALE: Grayscale = { red: 0.5, green: 0.419, blue: 0.081 }
export const Y_GRAYSCALE: Grayscale = { red: 0.299, green: 0.587, blue: 0.114 }
export const RED_GRAYSCALE: Grayscale = { red: 1, green: 0, blue: 0 }
export const GREEN_GRAYSCALE: Grayscale = { red: 0, green: 1, blue: 0 }
export const BLUE_GRAYSCALE: Grayscale = { red: 0, green: 0, blue: 1 }
export const DEFAULT_GRAYSCALE = BT709_GRAYSCALE

export function cfaPattern(header: FitsHeader) {
	return text(header, 'BAYERPAT') as CfaPattern | undefined
}

export function channelIndex(channel?: ImageChannelOrGray) {
	return channel === 'GREEN' ? 1 : channel === 'BLUE' ? 2 : 0
}

export function grayscaleFromChannel(channel?: ImageChannelOrGray): Grayscale {
	return channel === 'BT709' ? BT709_GRAYSCALE : channel === 'RMY' ? RMY_GRAYSCALE : channel === 'Y' ? Y_GRAYSCALE : channel === 'GRAY' ? DEFAULT_GRAYSCALE : channel === 'RED' ? RED_GRAYSCALE : channel === 'GREEN' ? GREEN_GRAYSCALE : channel === 'BLUE' ? BLUE_GRAYSCALE : (channel ?? DEFAULT_GRAYSCALE)
}

export async function readImageFromFits(fitsOrHdu?: Fits | FitsHdu): Promise<Image | undefined> {
	const hdu = !fitsOrHdu || 'header' in fitsOrHdu ? fitsOrHdu : fitsOrHdu.hdus[0]
	if (!hdu) return undefined
	const { header, data } = hdu
	const bp = bitpix(header)
	if (bp === 0 || bp === Bitpix.LONG) return undefined
	const sw = width(header)
	const sh = height(header)
	const nc = Math.max(1, Math.min(3, numberOfChannels(header)))
	const pixelSizeInBytes = bitpixInBytes(bp)
	const pixelCount = sw * sh
	const strideInBytes = sw * pixelSizeInBytes
	const strideInPixels = sw * nc
	const buffer = Buffer.allocUnsafe(strideInBytes)
	const raw = new Float64Array(pixelCount * nc)
	const minMax = [1, 0]
	const source = Buffer.isBuffer(data.source) ? bufferSource(data.source) : data.source

	source.seek?.(data.offset ?? 0)

	for (let channel = 0; channel < nc; channel++) {
		let index = channel

		for (let i = 0; i < sh; i++) {
			const n = await readUntil(source, buffer)

			if (n !== strideInBytes) return undefined

			for (let k = 0; k < n; k += pixelSizeInBytes, index += nc) {
				let pixel = 0

				if (bp === Bitpix.BYTE) pixel = buffer.readUInt8(k) / 255.0
				else if (bp === Bitpix.SHORT) pixel = (buffer.readInt16BE(k) + 32768) / 65535.0
				else if (bp === Bitpix.INTEGER) pixel = (buffer.readInt32BE(k) + 2147483648) / 4294967295.0
				else if (bp === Bitpix.FLOAT) pixel = buffer.readFloatBE(k)
				else if (bp === Bitpix.DOUBLE) pixel = buffer.readDoubleBE(k)

				raw[index] = pixel
				minMax[0] = Math.min(pixel, minMax[0])
				minMax[1] = Math.max(pixel, minMax[1])
			}
		}
	}

	if (minMax[0] < 0 || minMax[1] > 1) {
		const [min, max] = minMax
		const delta = max - min

		for (let i = 0; i < raw.length; i++) {
			raw[i] = (raw[i] - min) / delta
		}
	}

	const metadata: ImageMetadata = { width: sw, height: sh, channels: nc, strideInPixels, pixelCount, pixelSizeInBytes, bitpix: bp, bayer: cfaPattern(header) }
	return { header, metadata, raw }
}

export async function writeImageToFormat(image: Image, output: string | NodeJS.WritableStream, format: Exclude<ImageFormat, 'fits' | 'xisf'>, options?: WriteImageToFormatOptions) {
	const { raw, metadata } = image
	const { width, height, channels } = metadata
	const input = new Uint8ClampedArray(raw.length)

	for (let i = 0; i < input.length; i++) input[i] = raw[i] * 255

	const s = sharp(input, { raw: { width, height, channels: channels as never, premultiplied: false } }).toFormat(format, options?.format)

	if (options?.horizontalFlip) s.flop()
	if (options?.verticalFlip) s.flip()
	if (options?.normalize) s.normalise()
	if (options?.brightness !== undefined || options?.saturation !== undefined) s.modulate({ brightness: options.brightness ?? 1, saturation: options.saturation ?? 1 })
	if (options?.gamma !== undefined) s.gamma(options.gamma)
	if (options?.sharpen) s.sharpen()
	if (options?.median) s.median()
	if (options?.blur) s.blur()
	if (options?.negate) s.negate()

	if (channels === 1) s.toColourspace('b-w')

	if (typeof output === 'string') {
		return await s.toFile(output)
	} else {
		s.pipe(output)
		return undefined
	}
}

export class FitsDataSource implements Source {
	private position = 0
	private channel = 0
	private readonly raw: Float64Array
	private readonly bitpix: Bitpix
	private readonly pixelSizeInBytes: number
	private readonly channels: number

	constructor(image: Image | Float64Array, bitpix?: Bitpix, channels?: number) {
		this.raw = image instanceof Float64Array ? image : image.raw
		this.bitpix = image instanceof Float64Array ? bitpix! : (image.header.BITPIX as Bitpix)
		this.pixelSizeInBytes = bitpixInBytes(this.bitpix)
		this.channels = image instanceof Float64Array ? channels! : numberOfChannels(image.header)
	}

	read(buffer: Buffer, offset?: number, size?: number): number {
		offset ??= 0
		size ??= buffer.byteLength - offset

		if (this.position >= this.raw.length) {
			if (++this.channel < this.channels) {
				this.position = this.channel
			} else {
				return 0
			}
		}

		let n = 0

		for (; this.position < this.raw.length && n < size; this.position += this.channels, n += this.pixelSizeInBytes, offset += this.pixelSizeInBytes) {
			const pixel = this.raw[this.position]

			if (this.bitpix === Bitpix.BYTE) buffer.writeUInt8(pixel * 255, offset)
			else if (this.bitpix === Bitpix.SHORT) buffer.writeInt16BE(Math.trunc(pixel * 65535) - 32768, offset)
			else if (this.bitpix === Bitpix.INTEGER) buffer.writeInt32BE(Math.trunc(pixel * 4294967295) - 2147483648, offset)
			else if (this.bitpix === Bitpix.FLOAT) buffer.writeFloatBE(pixel, offset)
			else if (this.bitpix === Bitpix.DOUBLE) buffer.writeDoubleBE(pixel, offset)
		}

		return n
	}
}

export function writeImageToFits(image: Image, output: Buffer | Sink) {
	if (Buffer.isBuffer(output)) {
		output = bufferSink(output)
	}

	const source: Source = new FitsDataSource(image)
	const data: FitsData = { source }
	const hdu: FitsHdu = { header: image.header, data }

	return writeFits(output, [hdu])
}

function truncatePixel(p: number) {
	return Math.max(0, Math.min(Math.trunc(p * 65535), 65535))
}

// Apply Screen Transfer Function to image.
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Display_Function__
// https://pixinsight.com/tutorials/24-bit-stf/
export function stf(image: Image, midtone: number = 0.5, shadow: number = 0, highlight: number = 1, channel?: ImageChannelOrGray) {
	if (midtone === 0.5 && shadow === 0 && highlight === 1) return image

	const factor = shadow === highlight ? 1 : 1 / (highlight - shadow)
	const k1 = (midtone - 1) * factor
	const k2 = (2 * midtone - 1) * factor
	const lut = new Float64Array(65536).fill(NaN)

	const { raw, metadata } = image

	const s = metadata.channels === 3 ? channelIndex(channel) : 0
	const p = metadata.channels === 3 && channel ? 3 : 1

	for (let i = s; i < raw.length; i += p) {
		let value = raw[i]
		const p = truncatePixel(value)

		if (!Number.isNaN(lut[p])) raw[i] = lut[p]
		else if (value < shadow) raw[i] = 0
		else if (value > highlight) raw[i] = 1
		else {
			const d = value - shadow
			value = (d * k1) / (d * k2 - midtone)
			lut[p] = value
			raw[i] = value
		}
	}

	return image
}

export const DEFAULT_MEAN_BACKGROUND = 0.25
export const DEFAULT_CLIPPING_POINT = -2.8

// Adaptive Display Function Algorithm
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Adaptive_Display_Function_Algorithm__
export function adf(image: Image, channel?: ImageChannelOrGray, meanBackground: number = DEFAULT_MEAN_BACKGROUND, clippingPoint: number = DEFAULT_CLIPPING_POINT) {
	const med = median(image, channel)
	const mad = medianAbsoluteDiviation(image, channel, true, med)
	const upperHalf = med > 0.5
	const shadow = upperHalf || mad === 0 ? 0 : Math.min(1, Math.max(0, med + clippingPoint * mad))
	const highlight = !upperHalf || mad === 0 ? 1 : Math.min(1, Math.max(0, med - clippingPoint * mad))
	const x = upperHalf ? meanBackground : med - shadow
	const m = upperHalf ? highlight - med : meanBackground
	const midtone = x === 0 ? 0 : x === m ? 0.5 : x === 1 ? 1 : ((m - 1) * x) / ((2 * m - 1) * x - m)
	return [midtone, shadow, highlight] as const
}

const CFA_PATTERNS: Record<CfaPattern, number[][]> = {
	RGGB: [
		[0, 1],
		[1, 2],
	],
	BGGR: [
		[2, 1],
		[1, 0],
	],
	GBRG: [
		[1, 2],
		[0, 1],
	],
	GRBG: [
		[1, 0],
		[2, 1],
	],
	GRGB: [
		[1, 0],
		[1, 2],
	],
	GBGR: [
		[1, 2],
		[1, 0],
	],
	RGBG: [
		[0, 1],
		[2, 1],
	],
	BGRG: [
		[2, 1],
		[0, 1],
	],
}

export function debayer(image: Image, pattern?: CfaPattern) {
	const { metadata, raw } = image

	if (metadata.channels === 1) {
		pattern ??= metadata.bayer

		if (pattern) {
			const cfa = CFA_PATTERNS[pattern]
			const values = new Float64Array(3)
			const counters = new Uint8Array(3)
			const output = new Float64Array(raw.length * 3)

			const { width, height } = metadata

			for (let y = 0; y < height; y++) {
				const ri = y * width

				for (let x = 0; x < width; x++) {
					const ci = ri + x

					values.fill(0)
					counters.fill(0)

					// center
					let bi = cfa[y & 1][x & 1]
					values[bi] += raw[ci]
					counters[bi]++

					// left
					if (x !== 0) {
						bi = cfa[y & 1][(x - 1) & 1]
						values[bi] += raw[ci - 1]
						counters[bi]++
					}

					// right
					if (x !== width - 1) {
						bi = cfa[y & 1][(x + 1) & 1]
						values[bi] += raw[ci + 1]
						counters[bi]++
					}

					if (y !== 0) {
						// top center
						bi = cfa[(y - 1) & 1][x & 1]
						values[bi] += raw[ci - width]
						counters[bi]++

						// top left
						if (x !== 0) {
							bi = cfa[(y - 1) & 1][(x - 1) & 1]
							values[bi] += raw[ci - width - 1]
							counters[bi]++
						}

						// top right
						if (x !== width - 1) {
							bi = cfa[(y - 1) & 1][(x + 1) & 1]
							values[bi] += raw[ci - width + 1]
							counters[bi]++
						}
					}

					if (y !== height - 1) {
						// bottom center
						bi = cfa[(y + 1) & 1][x & 1]
						values[bi] += raw[ci + width]
						counters[bi]++

						// bottom left
						if (x !== 0) {
							bi = cfa[(y + 1) & 1][(x - 1) & 1]
							values[bi] += raw[ci + width - 1]
							counters[bi]++
						}

						// bottom right
						if (x !== width - 1) {
							bi = cfa[(y + 1) & 1][(x + 1) & 1]
							values[bi] += raw[ci + width + 1]
							counters[bi]++
						}
					}

					let oi = ci * 3

					output[oi++] = values[0] / counters[0]
					output[oi++] = values[1] / counters[1]
					output[oi] = values[2] / counters[2]
				}
			}

			return {
				header: { ...image.header, NAXIS: 3, NAXIS3: 3 },
				metadata: { ...metadata, channels: 3, strideInPixels: width * 3 },
				raw: output,
			}
		}
	}

	return undefined
}

export function scnrMaximumMask(a: number, b: number, c: number, amount: number) {
	const m = Math.max(b, c)
	return a * (1 - amount) * (1 - m) + m * a
}

export function scnrAdditiveMask(a: number, b: number, c: number, amount: number) {
	const m = Math.min(1, b + c)
	return a * (1 - amount) * (1 - m) + m * a
}

export function scnrAverageNeutral(a: number, b: number, c: number, amount: number) {
	const m = 0.5 * (b + c)
	return Math.min(a, m)
}

export function scnrMaximumNeutral(a: number, b: number, c: number, amount: number) {
	const m = Math.max(b, c)
	return Math.min(a, m)
}

export function scnrMimimumNeutral(a: number, b: number, c: number, amount: number) {
	const m = Math.min(b, c)
	return Math.min(a, m)
}

const SCNR_ALGORITHMS: Readonly<Record<SCNRProtectionMethod, SCNRAlgorithm>> = {
	MAXIMUM_MASK: scnrMaximumMask,
	ADDITIVE_MASK: scnrAdditiveMask,
	AVERAGE_NEUTRAL: scnrAverageNeutral,
	MAXIMUM_NEUTRAL: scnrMaximumNeutral,
	MINIMUM_NEUTRAL: scnrMimimumNeutral,
}

// Subtractive Chromatic Noise Reduction
export function scnr(image: Image, channel: ImageChannel = 'GREEN', amount: number = 0.5, method: SCNRProtectionMethod = 'MAXIMUM_MASK') {
	if (image.metadata.channels === 3) {
		const p0 = channel === 'RED' ? 0 : channel === 'GREEN' ? 1 : 2
		const p1 = channel === 'RED' ? 1 : channel === 'GREEN' ? 2 : 0
		const p2 = channel === 'RED' ? 2 : channel === 'GREEN' ? 0 : 1

		const { raw } = image
		const algorithm = SCNR_ALGORITHMS[method]

		for (let i = 0; i < raw.length; i += 3) {
			const k = i + p0
			const a = raw[k]
			const b = raw[i + p1]
			const c = raw[i + p2]
			raw[k] = algorithm(a, b, c, amount)
		}
	}

	return image
}

export function horizontalFlip(image: Image) {
	const { raw, metadata } = image
	const { height, channels, strideInPixels } = metadata
	const maxW = Math.trunc(strideInPixels / 2)
	const sc = strideInPixels - channels

	for (let y = 0; y < height; y++) {
		const k = y * strideInPixels

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

export function verticalFlip(image: Image) {
	const { raw, metadata } = image
	const { height, channels, strideInPixels } = metadata
	const sh = (height - 1) * strideInPixels
	const maxH = Math.trunc(height / 2)

	for (let y = 0; y < maxH; y++) {
		const k = y * strideInPixels
		const ek = sh - k

		for (let x = 0; x < strideInPixels; x += channels) {
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

export function invert(image: Image) {
	const { raw } = image

	for (let i = 0; i < raw.length; i++) {
		raw[i] = 1 - raw[i]
	}

	return image
}

export function histogram(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform) {
	const histogram = new Int32Array(65536)
	const { raw, metadata } = image

	if (metadata.channels === 3) {
		if (channel === 'RED' || channel === 'GREEN' || channel === 'BLUE') {
			for (let i = channelIndex(channel); i < raw.length; i += 3) {
				const v = raw[i]
				const p = truncatePixel(transform?.(v) ?? v)
				histogram[p]++
			}
		} else {
			const { red, green, blue } = grayscaleFromChannel(channel)

			for (let i = 0; i < raw.length; i += 3) {
				const v = raw[i] * red + raw[i + 1] * green + raw[i + 2] * blue
				const p = truncatePixel(transform?.(v) ?? v)
				histogram[p]++
			}
		}
	} else {
		for (let i = 0; i < raw.length; i++) {
			const v = raw[i]
			const p = truncatePixel(transform?.(v) ?? v)
			histogram[p]++
		}
	}

	return new Histogram(histogram)
}

export function median(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform) {
	return histogram(image, channel, transform).median() / 65535
}

const STANDARD_DEVIATION_SCALE = 1.482602218505602

export function medianAbsoluteDiviation(image: Image, channel?: ImageChannelOrGray, normalized: boolean = false, m?: number) {
	m ||= median(image, channel)
	const mad = median(image, channel, (p) => Math.abs(p - m))
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
}
