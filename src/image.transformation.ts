import { PI } from './constants'
import { exposureTimeKeyword } from './fits'
import { truncatePixel } from './image'
// biome-ignore format: too long!
import { type ApplyScreenTransferFunctionOptions, type CfaPattern, type ConvolutionKernel, type ConvolutionOptions, channelIndex, type DarkBiasSubtractionOptions, DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS, DEFAULT_CONVOLUTION_OPTIONS, DEFAULT_DARK_BIAS_SUBTRACTION_OPTIONS, DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS, type GaussianBlurConvolutionOptions, grayscaleFromChannel, type Image, type ImageChannel, type ImageChannelOrGray, type ImageMetadata, type ImageRawType, type SCNRAlgorithm, type SCNRProtectionMethod } from './image.types'
import type { NumberArray } from './math'

// Apply Screen Transfer Function to image.
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Display_Function__
// https://pixinsight.com/tutorials/24-bit-stf/
export function stf(image: Image, midtone: number = 0.5, shadow: number = 0, highlight: number = 1, options: Partial<ApplyScreenTransferFunctionOptions> = DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS) {
	if (midtone === 0.5 && shadow === 0 && highlight === 1) return image

	const factor = shadow === highlight ? 1 : 1 / (highlight - shadow)
	const k1 = (midtone - 1) * factor
	const k2 = (2 * midtone - 1) * factor

	const { raw, metadata } = image
	const isColor = metadata.channels === 3
	const { channel = DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS.channel, bits = DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS.bits } = options
	const lut = new Float32Array(1 << bits).fill(NaN)
	const max = lut.length - 1

	const step = isColor && (channel === 'RED' || channel === 'GREEN' || channel === 'BLUE') ? 3 : 1

	for (let i = isColor ? channelIndex(channel) : 0; i < raw.length; i += step) {
		let value = raw[i]
		const p = truncatePixel(value, max)

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

const CFA_PATTERNS: Record<CfaPattern, Uint8Array[]> = {
	RGGB: [new Uint8Array([0, 1]), new Uint8Array([1, 2])],
	BGGR: [new Uint8Array([2, 1]), new Uint8Array([1, 0])],
	GBRG: [new Uint8Array([1, 2]), new Uint8Array([0, 1])],
	GRBG: [new Uint8Array([1, 0]), new Uint8Array([2, 1])],
	GRGB: [new Uint8Array([1, 0]), new Uint8Array([1, 2])],
	GBGR: [new Uint8Array([1, 2]), new Uint8Array([1, 0])],
	RGBG: [new Uint8Array([0, 1]), new Uint8Array([2, 1])],
	BGRG: [new Uint8Array([2, 1]), new Uint8Array([0, 1])],
}

export function debayer(image: Image, pattern?: CfaPattern): Image | undefined {
	const { metadata, raw } = image

	if (metadata.channels === 1) {
		pattern ??= metadata.bayer

		if (pattern) {
			const cfa = CFA_PATTERNS[pattern]
			const values = raw instanceof Float64Array ? new Float64Array(3) : new Float32Array(3)
			const counters = new Uint8Array(3)
			const output = raw instanceof Float64Array ? new Float64Array(raw.length * 3) : new Float32Array(raw.length * 3)

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
				metadata: { ...metadata, channels: 3, stride: width * 3 },
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

export function invert(image: Image) {
	const { raw } = image

	for (let i = 0; i < raw.length; i++) {
		raw[i] = 1 - raw[i]
	}

	return image
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
	const mean = new Float32Array(channels)

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

export function convolutionKernel(kernel: Readonly<NumberArray>, width: number, height: number = width, divisor?: number): ConvolutionKernel {
	if (kernel.length < width * height) {
		throw new Error('invalid kernel size')
	}

	divisor ??= (kernel as number[]).reduce((a, b) => a + b)

	return { kernel, width, height, divisor }
}

function shift(buffer: NumberArray[]) {
	const n = buffer.length - 1
	const first = buffer[0]
	for (let i = 0; i < n; i++) buffer[i] = buffer[i + 1]
	buffer[n] = first
}

export function convolution(image: Image, kernel: ConvolutionKernel, { dynamicDivisorForEdges = true, normalize = true }: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	if (kernel.width % 2 === 0 || kernel.height % 2 === 0) {
		throw new Error('kernel size must be odd')
	}
	if (kernel.width < 3 || kernel.width > 99 || kernel.height < 3 || kernel.height > 99) {
		throw new Error('kernel size bust be in range [3..99]')
	}

	const xr = Math.trunc(kernel.width / 2)
	const yr = Math.trunc(kernel.height / 2)

	const { raw, metadata } = image
	const { width: iw, height: ih, channels, stride } = metadata
	const mask = new Float64Array(channels)
	const { width: kw, height: kh, kernel: kd } = kernel
	const buffer = new Array<ImageRawType>(kh)

	function read(y: number, output: ImageRawType) {
		if (y < 0 || y >= ih) {
			// output.fill(0)
		} else {
			const start = y * stride
			output.set(raw.subarray(start, start + stride))
		}
	}

	for (let i = 0; i < buffer.length; i++) {
		buffer[i] = raw instanceof Float64Array ? new Float64Array(stride) : new Float32Array(stride)
		read(i - yr, buffer[i])
	}

	for (let y = 0, p = 0; y < ih; y++) {
		for (let x = 0; x < iw; x++) {
			let divisor = 0
			let offset = 0

			mask.fill(0)

			for (let i = 0; i < kh; i++) {
				const a = y + i - yr

				if (a < 0) continue
				if (a >= ih) break

				const row = buffer[i]

				for (let j = 0, ki = i * kw; j < kw; j++, ki++) {
					const b = x + j - xr

					if (b >= 0 && b < iw) {
						const k = kd[ki]
						divisor += k

						for (let c = 0, m = b * channels; c < channels; c++, m++) {
							mask[c] += k * row[m]
						}
					}
				}
			}

			if (!dynamicDivisorForEdges) {
				divisor = kernel.divisor
			}

			if (normalize) {
				if (divisor < 0) {
					divisor = -divisor
					offset = 1
				}
			}

			if (divisor === 0) {
				divisor = 1
				offset = 0.5
			}

			for (let c = 0; c < channels; c++, p++) {
				raw[p] = mask[c] / divisor + offset
			}
		}

		shift(buffer)
		read(y + yr + 1, buffer[buffer.length - 1])
	}

	return image
}

const EDGES = convolutionKernel(new Int8Array([0, -1, 0, -1, 4, -1, 0, -1, 0]), 3, 3, 0)
const EMBOSS = convolutionKernel(new Int8Array([-1, 0, 0, 0, 0, 0, 0, 0, 1]), 3, 3, 0)
const MEAN_3x3 = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), 3, 3, 9)
const MEAN_5x5 = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 5, 5, 25)
const MEAN_7x7 = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 7, 7, 49)
const SHARPEN = convolutionKernel(new Int8Array([0, -1, 0, -1, 5, -1, 0, -1, 0]), 3, 3, 1)
const BLUR_3x3 = convolutionKernel(new Int8Array([1, 2, 1, 2, 4, 2, 1, 2, 1]), 3, 3, 16)
const BLUR_5x5 = convolutionKernel(new Int8Array([1, 2, 3, 2, 1, 2, 4, 6, 4, 2, 3, 6, 9, 6, 3, 2, 4, 6, 4, 2, 1, 2, 3, 2, 1]), 5, 5, 81)
const BLUR_7x7 = convolutionKernel(new Int8Array([1, 2, 3, 4, 3, 2, 1, 2, 4, 6, 8, 6, 4, 2, 3, 6, 9, 12, 9, 6, 3, 4, 8, 12, 16, 12, 8, 4, 3, 6, 9, 12, 9, 6, 3, 2, 4, 6, 8, 6, 4, 2, 1, 2, 3, 4, 3, 2, 1]), 7, 7, 256)

export function gaussianBlurKernel(sigma: number = 1.4, size: number = 5) {
	if (size < 2 || size % 2 === 0) {
		throw new Error('size must be odd and greater or equal to 3')
	}
	if (sigma < 0.5 || sigma > 5) {
		throw new Error('kernel size bust be in range [0.5..5]')
	}

	const sigmaSquared = sigma * sigma
	const r = Math.trunc(Math.trunc(size) / 2)

	function gaussian2D(x: number, y: number) {
		return Math.exp((x * x + y * y) / (-2 * sigmaSquared)) / (2 * PI * sigmaSquared)
	}

	const kernel = new Float32Array(size * size)

	for (let y = -r, i = 0; y <= r; y++) {
		for (let x = -r; x <= r; x++, i++) {
			kernel[i] = gaussian2D(x, y)
		}
	}

	const min = kernel[0]

	for (let i = 0; i < kernel.length; i++) {
		kernel[i] /= min
	}

	return convolutionKernel(kernel, size)
}

export function edges(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, EDGES, options)
}

export function emboss(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, EMBOSS, options)
}

export function meanConvolutionKernel(size: number) {
	if (size < 3) throw new Error('size must be greater or equal to 3')
	if (size > 99) throw new Error('size must be less or equal to 99')
	if (size % 2 === 0) throw new Error('size must be odd')

	const kernel = new Int8Array(size * size).fill(1)
	return convolutionKernel(kernel, size, size, kernel.length)
}

export function mean(image: Image, size: number, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	if (size === 3) return mean3x3(image, options)
	if (size === 5) return mean5x5(image, options)
	if (size === 7) return mean7x7(image, options)

	return convolution(image, meanConvolutionKernel(size), options)
}

export function mean3x3(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, MEAN_3x3, options)
}

export function mean5x5(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, MEAN_5x5, options)
}

export function mean7x7(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, MEAN_7x7, options)
}

export function sharpen(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, SHARPEN, options)
}

export function blurConvolutionKernel(size: number) {
	if (size < 3) throw new Error('size must be greater or equal to 3')
	if (size > 99) throw new Error('size must be less or equal to 99')
	if (size % 2 === 0) throw new Error('size must be odd')

	const kernel = new Int16Array(size * size)
	const n = Math.ceil(size / 2)

	for (let y = 1, c = 0; y <= size; y++) {
		const m = y <= n ? y : size - y + 1

		for (let x = 1, k = m; x <= size; x++, c++) {
			kernel[c] = k
			if (x < n) k += m
			else k -= m
		}
	}

	return convolutionKernel(kernel, size, size, Math.ceil(size / 2) << 2)
}

export function blur(image: Image, size: number, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	if (size === 3) return blur3x3(image, options)
	if (size === 5) return blur5x5(image, options)
	if (size === 7) return blur7x7(image, options)

	return convolution(image, blurConvolutionKernel(size), options)
}

export function blur3x3(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, BLUR_3x3, options)
}

export function blur5x5(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, BLUR_5x5, options)
}

export function blur7x7(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, BLUR_7x7, options)
}

export function gaussianBlur(image: Image, options: Partial<GaussianBlurConvolutionOptions> = DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS) {
	return convolution(image, gaussianBlurKernel(options.sigma, options.size), options)
}

// https://github.com/KDE/kstars/blob/master/kstars/ekos/guide/internalguide/guidealgorithms.cpp

//                              A      B1     B2     C1    C2      C3     D1       D2     D3
const PSF = new Float32Array([0.906, 0.584, 0.365, 0.117, 0.049, -0.05, -0.064, -0.074, -0.094])

// PSF Grid
// D3 D3 D3 D3 D3 D3 D3 D3 D3
// D3 D3 D3 D2 D1 D2 D3 D3 D3
// D3 D3 C3 C2 C1 C2 C3 D3 D3
// D3 D2 C2 B2 B1 B2 C2 D2 D3
// D3 D1 C1 B1 A  B1 C1 D1 D3
// D3 D2 C2 B2 B1 B2 C2 D2 D3
// D3 D3 C3 C2 C1 C2 C3 D3 D3
// D3 D3 D3 D2 D1 D2 D3 D3 D3
// D3 D3 D3 D3 D3 D3 D3 D3 D3

// 1@A
// 4@B1, B2, C1, C3, D1
// 8@C2, D2
// 44 * D3

export function psf(image: Image) {
	const { raw, metadata } = image
	const { width: iw, height: ih, channels, stride } = metadata
	const buffer = new Array<ImageRawType>(9)

	function read(y: number, output: ImageRawType) {
		if (y < 0 || y >= ih) {
			// output.fill(0)
		} else {
			const start = y * stride
			output.set(raw.subarray(start, start + stride))
		}
	}

	for (let i = 0; i < buffer.length; i++) {
		buffer[i] = raw instanceof Float64Array ? new Float64Array(stride) : new Float32Array(stride)
		read(i, buffer[i])
	}

	const c0 = 0
	const c1 = channels
	const c2 = 2 * channels
	const c3 = 3 * channels
	const c4 = 4 * channels

	for (let y = 4; y < ih - 4; y++) {
		const py = y * stride

		const b0 = buffer[0]
		const b1 = buffer[1]
		const b2 = buffer[2]
		const b3 = buffer[3]
		const b4 = buffer[4]
		const b5 = buffer[5]
		const b6 = buffer[6]
		const b7 = buffer[7]
		const b8 = buffer[8]

		for (let x = 4; x < iw - 4; x++) {
			for (let c = 0, xi = x * channels; c < channels; c++, xi++) {
				const A = b4[xi + c0]
				const B1 = b3[xi + c0] + b5[xi + c0] + b4[xi + c1] + b4[xi - c1]
				const B2 = b3[xi - c1] + b3[xi + c1] + b5[xi - c1] + b5[xi + c1]
				const C1 = b2[xi + c0] + b4[xi - c2] + b4[xi + c2] + b6[xi + c0]
				const C2 = b2[xi - c1] + b2[xi + c1] + b3[xi - c2] + b3[xi + c2] + b5[xi - c2] + b5[xi + c2] + b6[xi - c1] + b6[xi + c1]
				const C3 = b2[xi - c2] + b2[xi + c2] + b6[xi - c2] + b6[xi + c2]
				const D1 = b1[xi + c0] + b4[xi - c3] + b4[xi + c3] + b7[xi + c0]
				const D2 = b1[xi - c1] + b1[xi + c1] + b3[xi - c3] + b3[xi + c3] + b5[xi - c3] + b5[xi + c3] + b7[xi - c1] + b7[xi + c1]
				let D3 = b2[xi - c4] + b2[xi - c3] + b2[xi + c3] + b2[xi + c4] + b3[xi - c4] + b3[xi + c4] + b4[xi - c4] + b4[xi + c4] + b5[xi - c4] + b5[xi + c4] + b6[xi - c4] + b6[xi - c3] + b6[xi + c3] + b6[xi + c4]

				D3 += b0[xi - c4] + b0[xi - c3] + b0[xi - c2] + b0[xi - c1] + b0[xi - c0]
				D3 += b0[xi + c4] + b0[xi + c3] + b0[xi + c2] + b0[xi + c1]

				D3 += b1[xi - c4] + b1[xi - c3] + b1[xi - c2]
				D3 += b1[xi + c4] + b1[xi + c3] + b1[xi + c2]

				D3 += b7[xi - c4] + b7[xi - c3] + b7[xi - c2]
				D3 += b7[xi + c4] + b7[xi + c3] + b7[xi + c2]

				D3 += b8[xi - c4] + b8[xi - c3] + b8[xi - c2] + b8[xi - c1] + b8[xi - c0]
				D3 += b8[xi + c4] + b8[xi + c3] + b8[xi + c2] + b8[xi + c1]

				const mean = (A + B1 + B2 + C1 + C2 + C3 + D1 + D2 + D3) / 81
				const mean4 = mean * 4
				const mean8 = mean * 8

				raw[py + xi] = PSF[0] * (A - mean) + PSF[1] * (B1 - mean4) + PSF[2] * (B2 - mean4) + PSF[3] * (C1 - mean4) + PSF[4] * (C2 - mean8) + PSF[5] * (C3 - mean4) + PSF[6] * (D1 - mean4) + PSF[7] * (D2 - mean8) + PSF[8] * (D3 - 44 * mean)
			}
		}

		shift(buffer)
		read(y + 5, buffer[buffer.length - 1])
	}

	return image
}

// Apply brightness adjustment to image.
export function brightness(image: Image, value: number) {
	if (value >= 0 && value !== 1) {
		const { raw } = image

		for (let i = 0; i < raw.length; i++) {
			raw[i] = Math.min(1, raw[i] * value)
		}
	}

	return image
}

// Apply saturation adjustment to image.
export function saturation(image: Image, value: number, channel: ImageChannelOrGray = 'GRAY') {
	if (value >= 0 && value !== 1 && image.metadata.channels === 3) {
		const { raw } = image
		const { red, green, blue } = grayscaleFromChannel(channel)

		for (let i = 0; i < raw.length; i += 3) {
			const r = raw[i]
			const g = raw[i + 1]
			const b = raw[i + 2]
			const gray = red * r + green * g + blue * b

			raw[i] = Math.min(1, gray + (r - gray) * value)
			raw[i + 1] = Math.min(1, gray + (g - gray) * value)
			raw[i + 2] = Math.min(1, gray + (b - gray) * value)
		}
	}

	return image
}

// Apply linear transformation to image.
export function linear(image: Image, slope: number, intercept: number) {
	if (slope !== 1 || intercept !== 0) {
		const { raw } = image

		for (let i = 0; i < raw.length; i++) {
			raw[i] = Math.max(0, Math.min(1, raw[i] * slope + intercept))
		}
	}

	return image
}

// Apply contrast adjustment to image.
export function contrast(image: Image, value: number) {
	return linear(image, value, 0.5 - 0.5 * value)
}

// Apply gamma correction to image. value between 1.0 and 3.0.
export function gamma(image: Image, value: number) {
	if (value > 1 && value <= 3) {
		const inv = 1 / value
		const { raw } = image

		for (let i = 0; i < raw.length; i++) {
			raw[i] = raw[i] ** inv
		}
	}

	return image
}
