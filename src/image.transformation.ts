import { exposureTimeKeyword } from './fits'
import { type CfaPattern, channelIndex, grayscaleFromChannel, type Image, type ImageChannel, type ImageChannelOrGray, type ImageMetadata, type SCNRAlgorithm, type SCNRProtectionMethod, truncatePixel } from './image'
import { median, medianAbsoluteDiviation } from './image.computation'

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

export function scnrMinimumNeutral(a: number, b: number, c: number, amount: number) {
	const m = Math.min(b, c)
	return Math.min(a, m)
}

const SCNR_ALGORITHMS: Readonly<Record<SCNRProtectionMethod, SCNRAlgorithm>> = {
	MAXIMUM_MASK: scnrMaximumMask,
	ADDITIVE_MASK: scnrAdditiveMask,
	AVERAGE_NEUTRAL: scnrAverageNeutral,
	MAXIMUM_NEUTRAL: scnrMaximumNeutral,
	MINIMUM_NEUTRAL: scnrMinimumNeutral,
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

export interface DarkBiasSubtractionOptions {
	darkCorrected?: boolean
	exposureNormalization?: boolean
}

const DEFAULT_DARK_BIAS_SUBTRACTION_OPTIONS: Readonly<Required<DarkBiasSubtractionOptions>> = {
	darkCorrected: false,
	exposureNormalization: true,
}

// Subtract dark and bias frames from image.
// If darkCorrected is true, the dark frame will be already corrected for bias.
export function darkBiasSubtraction(image: Image, dark?: Image, bias?: Image, options?: DarkBiasSubtractionOptions) {
	if (dark && (image.metadata.width !== dark.metadata.width || image.metadata.height !== dark.metadata.height || image.metadata.channels !== dark.metadata.channels)) {
		// throw new Error('image and dark frame must have the same dimensions and channels')
		return image
	}
	if (bias && (image.metadata.width !== bias.metadata.width || image.metadata.height !== bias.metadata.height || image.metadata.channels !== bias.metadata.channels)) {
		// throw new Error('image and bias frame must have the same dimensions and channels')
		return image
	}

	const { raw } = image
	const { darkCorrected = false, exposureNormalization = true } = options ?? DEFAULT_DARK_BIAS_SUBTRACTION_OPTIONS
	const normalizationFactor = exposureNormalization && dark ? exposureTimeKeyword(image.header, 1) / exposureTimeKeyword(dark.header, 1) : 1

	let pedestal = 0

	// corrected = image - bias - (dark - bias) # subtrai bias do dark primeiro
	// or
	// corrected = image - bias - dark_corrected

	if (dark && bias) {
		for (let i = 0; i < raw.length; i++) {
			const d = raw[i] - bias.raw[i] - (darkCorrected ? dark.raw[i] : dark.raw[i] - bias.raw[i]) * normalizationFactor
			if (d < 0) pedestal = Math.max(pedestal, -d)
			raw[i] = Math.max(0, d)
		}
	} else if (dark) {
		for (let i = 0; i < raw.length; i++) {
			const d = raw[i] - dark.raw[i] * normalizationFactor
			if (d < 0) pedestal = Math.max(pedestal, -d)
			raw[i] = Math.max(0, d)
		}
	} else if (bias) {
		for (let i = 0; i < raw.length; i++) {
			const d = raw[i] - bias.raw[i]
			if (d < 0) pedestal = Math.max(pedestal, -d)
			raw[i] = Math.max(0, d)
		}
	}

	// If pedestal is greater than 0, it means that the image has a negative offset
	//  that should be added to all pixels.
	if (pedestal) {
		for (let i = 0; i < raw.length; i++) {
			raw[i] = Math.min(1, raw[i] + pedestal)
		}

		image.header.PEDESTAL = pedestal
	}

	return image
}

// Apply flat correction to image.
export function flatCorrection(image: Image, flat: Image) {
	if (image.metadata.width !== flat.metadata.width || image.metadata.height !== flat.metadata.height || image.metadata.channels !== flat.metadata.channels) {
		// throw new Error('image and flat frame must have the same dimensions and channels')
		return image
	}

	const { raw, metadata } = image
	const { channels } = metadata
	const mean = new Float64Array(channels)

	// Calculate mean for each channel.
	for (let i = 0; i < mean.length; i++) {
		let sum = 0
		let n = 0

		for (let j = i; j < raw.length; j += channels, n++) {
			sum += raw[j]
		}

		mean[i] = sum / n
	}

	// Apply flat correction.
	for (let i = 0; i < mean.length; i++) {
		const m = mean[i]

		for (let j = i; j < raw.length; j += channels) {
			raw[j] = flat.raw[j] !== 0 ? (raw[j] * m) / flat.raw[j] : 0 // Avoid division by zero
		}
	}

	return image
}

export function grayscale(image: Image, channel?: ImageChannelOrGray): Image {
	if (image.metadata.channels === 1) return image

	const header = structuredClone(image.header)
	const metadata: ImageMetadata = { ...image.metadata, bayer: undefined, channels: 1 }

	const color = image.raw
	const n = metadata.width * metadata.height
	const raw = new Float64Array(n)
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
