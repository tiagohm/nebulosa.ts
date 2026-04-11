import { TAU } from './constants'
import { exposureTimeKeyword } from './fits.util'
import { truncatePixel } from './image'
import { estimateBackgroundUsingMode } from './image.computation'
// biome-ignore format: too long!
import { type ApplyScreenTransferFunctionOptions, type ArcsinhStretchOptions, type CfaPattern, type ConvolutionKernel, type ConvolutionOptions, channelIndex, DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS, DEFAULT_ARCSINH_STRETCH_OPTIONS, DEFAULT_CONVOLUTION_OPTIONS, DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS, DEFAULT_MMT_LAYER_OPTIONS, DEFAULT_MMT_OPTIONS, type FFTFilterType, type GaussianBlurConvolutionOptions, GRAYSCALES, grayscaleFromChannel, type Image, type ImageChannel, type ImageChannelOrGray, type ImageMetadata, type ImageRawType, type MultiscaleMedianTransformOptions, type SCNRAlgorithm, type SCNRProtectionMethod } from './image.types'
import { clamp, type NumberArray } from './math'
import { meanOf, medianOf, STANDARD_DEVIATION_SCALE } from './util'

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
	const n = raw.length

	for (let i = isColor ? channelIndex(channel) : 0; i < n; i += step) {
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

// Solves beta/asinh(beta)=stretchFactor for the PixInsight-compatible softening factor.
function arcsinhStretchBeta(stretchFactor: number) {
	if (!(stretchFactor > 1)) return 0

	let low = 0
	let high = 1

	while (high / Math.asinh(high) < stretchFactor) {
		high *= 2
	}

	for (let i = 0; i < 56; i++) {
		const mid = 0.5 * (low + high)
		if (mid / Math.asinh(mid) < stretchFactor) low = mid
		else high = mid
	}

	return 0.5 * (low + high)
}

// Clips the black point and renormalizes the remaining range back to [0,1].
function normalizeArcsinhStretchPixel(value: number, blackPoint: number, inverseSpan: number) {
	if (value <= blackPoint) return 0
	return inverseSpan === 0 ? 1 : Math.min(1, (value - blackPoint) * inverseSpan)
}

// Apply a PixInsight-style arcsinh stretch while preserving RGB ratios above the black point.
// https://pixinsight.com/doc/tools/ArcsinhStretch/ArcsinhStretch.html
export function arcsinhStretch(image: Image, options: Partial<ArcsinhStretchOptions> = DEFAULT_ARCSINH_STRETCH_OPTIONS) {
	const stretchFactor = options.stretchFactor ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.stretchFactor
	const blackPoint = options.blackPoint ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.blackPoint
	const protectHighlights = options.protectHighlights ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.protectHighlights
	const useRgbWorkingSpace = options.useRgbWorkingSpace ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.useRgbWorkingSpace
	const rgbWorkingSpace = options.rgbWorkingSpace ?? DEFAULT_ARCSINH_STRETCH_OPTIONS.rgbWorkingSpace

	const resolvedStretchFactor = Number.isFinite(stretchFactor) ? Math.max(1, stretchFactor) : DEFAULT_ARCSINH_STRETCH_OPTIONS.stretchFactor
	const resolvedBlackPoint = Number.isFinite(blackPoint) ? clamp(blackPoint, 0, 1) : DEFAULT_ARCSINH_STRETCH_OPTIONS.blackPoint

	if (resolvedStretchFactor === 1 && resolvedBlackPoint === 0) return image

	const inverseSpan = resolvedBlackPoint === 1 ? 0 : 1 / (1 - resolvedBlackPoint)

	const beta = arcsinhStretchBeta(resolvedStretchFactor)
	const betaScale = beta === 0 ? 0 : 1 / Math.asinh(beta)
	const { raw, metadata } = image

	if (metadata.channels === 1) {
		const n = raw.length

		for (let i = 0; i < n; i++) {
			const value = normalizeArcsinhStretchPixel(raw[i], resolvedBlackPoint, inverseSpan)
			raw[i] = beta === 0 ? value : Math.asinh(beta * value) * betaScale
		}

		return image
	}

	let redWeight = 1 / 3
	let greenWeight = 1 / 3
	let blueWeight = 1 / 3

	if (useRgbWorkingSpace) {
		const grayscale = typeof rgbWorkingSpace === 'object' ? rgbWorkingSpace : GRAYSCALES[rgbWorkingSpace]
		const sum = grayscale.red + grayscale.green + grayscale.blue

		if (Number.isFinite(sum) && sum > 0) {
			redWeight = grayscale.red / sum
			greenWeight = grayscale.green / sum
			blueWeight = grayscale.blue / sum
		}
	}

	let maxValue = 1
	const n = raw.length

	for (let i = 0; i < n; i += 3) {
		const r = normalizeArcsinhStretchPixel(raw[i], resolvedBlackPoint, inverseSpan)
		const g = normalizeArcsinhStretchPixel(raw[i + 1], resolvedBlackPoint, inverseSpan)
		const b = normalizeArcsinhStretchPixel(raw[i + 2], resolvedBlackPoint, inverseSpan)
		const luminance = r * redWeight + g * greenWeight + b * blueWeight

		if (luminance === 0 || beta === 0) {
			raw[i] = r
			raw[i + 1] = g
			raw[i + 2] = b
		} else {
			const multiplier = (Math.asinh(beta * luminance) * betaScale) / luminance
			raw[i] = r * multiplier
			raw[i + 1] = g * multiplier
			raw[i + 2] = b * multiplier
		}

		if (protectHighlights) {
			if (raw[i] > maxValue) maxValue = raw[i]
			if (raw[i + 1] > maxValue) maxValue = raw[i + 1]
			if (raw[i + 2] > maxValue) maxValue = raw[i + 2]
		} else {
			raw[i] = Math.min(1, raw[i])
			raw[i + 1] = Math.min(1, raw[i + 1])
			raw[i + 2] = Math.min(1, raw[i + 2])
		}
	}

	if (protectHighlights && maxValue > 1) {
		const scale = 1 / maxValue
		for (let i = 0; i < n; i++) raw[i] *= scale
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

// Bayer an RGB image into a mono CFA frame.
export function bayer(image: Image, pattern: CfaPattern): Image | undefined {
	const { metadata, raw } = image

	if (metadata.channels === 3) {
		const header = structuredClone(image.header)
		const cfa = CFA_PATTERNS[pattern]
		const output = raw instanceof Float64Array ? new Float64Array(metadata.pixelCount) : new Float32Array(metadata.pixelCount)
		const { width, height, stride } = metadata

		for (let y = 0; y < height; y++) {
			const cfaRow = cfa[y & 1]
			let ii = y * stride
			let oi = y * width

			for (let x = 0; x < width; x++, oi++) {
				output[oi] = raw[ii + cfaRow[x & 1]]
				ii += 3
			}
		}

		delete header.NAXIS3
		header.BAYERPAT = pattern
		header.NAXIS = 2

		return {
			header,
			metadata: { ...metadata, bayer: pattern, channels: 1, stride: width },
			raw: output,
		}
	}

	return undefined
}

// Debayer a single CFA pixel while preserving the original accumulation order.
function debayerPixel(raw: ImageRawType, output: ImageRawType, width: number, ci: number, xParity: number, cfaRow: Uint8Array, cfaNextRow: Uint8Array, hasLeft: boolean, hasRight: boolean, hasTop: boolean, hasBottom: boolean, values: ImageRawType, counters: Uint8Array) {
	const nextParity = xParity ^ 1
	const centerChannel = cfaRow[xParity]
	const horizontalChannel = cfaRow[nextParity]
	const verticalChannel = cfaNextRow[xParity]
	const diagonalChannel = cfaNextRow[nextParity]

	values[0] = 0
	values[1] = 0
	values[2] = 0
	counters[0] = 0
	counters[1] = 0
	counters[2] = 0

	values[centerChannel] += raw[ci]
	counters[centerChannel]++

	if (hasLeft) {
		values[horizontalChannel] += raw[ci - 1]
		counters[horizontalChannel]++
	}

	if (hasRight) {
		values[horizontalChannel] += raw[ci + 1]
		counters[horizontalChannel]++
	}

	if (hasTop) {
		values[verticalChannel] += raw[ci - width]
		counters[verticalChannel]++

		if (hasLeft) {
			values[diagonalChannel] += raw[ci - width - 1]
			counters[diagonalChannel]++
		}

		if (hasRight) {
			values[diagonalChannel] += raw[ci - width + 1]
			counters[diagonalChannel]++
		}
	}

	if (hasBottom) {
		values[verticalChannel] += raw[ci + width]
		counters[verticalChannel]++

		if (hasLeft) {
			values[diagonalChannel] += raw[ci + width - 1]
			counters[diagonalChannel]++
		}

		if (hasRight) {
			values[diagonalChannel] += raw[ci + width + 1]
			counters[diagonalChannel]++
		}
	}

	let oi = ci * 3
	output[oi++] = values[0] / counters[0]
	output[oi++] = values[1] / counters[1]
	output[oi] = values[2] / counters[2]
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
			const widthLast = width - 1
			const heightLast = height - 1

			if (width > 2 && height > 2) {
				for (let x = 0; x < width; x++) {
					debayerPixel(raw, output, width, x, x & 1, cfa[0], cfa[1], x !== 0, x !== widthLast, false, true, values, counters)
				}

				for (let y = 1; y < heightLast; y++) {
					const row = y * width
					const cfaRow = cfa[y & 1]
					const cfaNextRow = cfa[(y + 1) & 1]

					debayerPixel(raw, output, width, row, 0, cfaRow, cfaNextRow, false, true, true, true, values, counters)

					for (let x = 1; x < widthLast; x++) {
						const ci = row + x
						const xParity = x & 1
						const nextParity = xParity ^ 1
						const centerChannel = cfaRow[xParity]
						const horizontalChannel = cfaRow[nextParity]
						const verticalChannel = cfaNextRow[xParity]
						const diagonalChannel = cfaNextRow[nextParity]

						values[0] = 0
						values[1] = 0
						values[2] = 0
						counters[0] = 0
						counters[1] = 0
						counters[2] = 0

						// Interior pixels have a complete 3x3 neighborhood, so the hot path can stay branch-light.
						values[centerChannel] += raw[ci]
						counters[centerChannel]++
						values[horizontalChannel] += raw[ci - 1]
						counters[horizontalChannel]++
						values[horizontalChannel] += raw[ci + 1]
						counters[horizontalChannel]++
						values[verticalChannel] += raw[ci - width]
						counters[verticalChannel]++
						values[diagonalChannel] += raw[ci - width - 1]
						counters[diagonalChannel]++
						values[diagonalChannel] += raw[ci - width + 1]
						counters[diagonalChannel]++
						values[verticalChannel] += raw[ci + width]
						counters[verticalChannel]++
						values[diagonalChannel] += raw[ci + width - 1]
						counters[diagonalChannel]++
						values[diagonalChannel] += raw[ci + width + 1]
						counters[diagonalChannel]++

						let oi = ci * 3
						output[oi++] = values[0] / counters[0]
						output[oi++] = values[1] / counters[1]
						output[oi] = values[2] / counters[2]
					}

					debayerPixel(raw, output, width, row + widthLast, widthLast & 1, cfaRow, cfaNextRow, true, false, true, true, values, counters)
				}

				const bottomRow = heightLast * width

				for (let x = 0; x < width; x++) {
					debayerPixel(raw, output, width, bottomRow + x, x & 1, cfa[heightLast & 1], cfa[height & 1], x !== 0, x !== widthLast, true, false, values, counters)
				}
			} else {
				for (let y = 0; y < height; y++) {
					const row = y * width
					const cfaRow = cfa[y & 1]
					const cfaNextRow = cfa[(y + 1) & 1]
					const hasTop = y !== 0
					const hasBottom = y !== heightLast

					for (let x = 0; x < width; x++) {
						debayerPixel(raw, output, width, row + x, x & 1, cfaRow, cfaNextRow, x !== 0, x !== widthLast, hasTop, hasBottom, values, counters)
					}
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
		const n = raw.length

		for (let i = 0; i < n; i += 3) {
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
	const n = raw.length

	for (let i = 0; i < n; i++) {
		raw[i] = 1 - raw[i]
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
		return Math.exp((x * x + y * y) / (-2 * sigmaSquared)) / (TAU * sigmaSquared)
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

	const divisor = n * n
	return convolutionKernel(kernel, size, size, divisor * divisor)
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

const MMT_MEDIAN_HISTOGRAM_BITS = 14
const MMT_MEDIAN_HISTOGRAM_SIZE = 1 << MMT_MEDIAN_HISTOGRAM_BITS
const MMT_MEDIAN_HISTOGRAM_LAST = MMT_MEDIAN_HISTOGRAM_SIZE - 1
const MMT_MEDIAN_HISTOGRAM_GROUP_BITS = 6
const MMT_MEDIAN_HISTOGRAM_GROUP_SIZE = 1 << MMT_MEDIAN_HISTOGRAM_GROUP_BITS
const MMT_MEDIAN_HISTOGRAM_GROUP_COUNT = MMT_MEDIAN_HISTOGRAM_SIZE >> MMT_MEDIAN_HISTOGRAM_GROUP_BITS

// Tracks the quantization range for one image channel.
function multiscaleMedianHistogramRange(raw: ImageRawType, channels: number, channel: number) {
	let min = Number.POSITIVE_INFINITY
	let max = Number.NEGATIVE_INFINITY

	for (let i = channel; i < raw.length; i += channels) {
		const value = raw[i]

		if (value < min) min = value
		if (value > max) max = value
	}

	return [min, max] as const
}

// Quantizes one value into the MMT histogram domain.
function multiscaleMedianHistogramBin(value: number, min: number, inverse: number) {
	const bin = Math.round((value - min) * inverse)
	if (bin <= 0) return 0
	if (bin >= MMT_MEDIAN_HISTOGRAM_LAST) return MMT_MEDIAN_HISTOGRAM_LAST
	return bin
}

// Updates both fine and coarse histograms for one quantized sample.
function multiscaleMedianHistogramUpdate(fine: Int32Array, coarse: Int32Array, bin: number, delta: number) {
	fine[bin] += delta
	coarse[bin >>> MMT_MEDIAN_HISTOGRAM_GROUP_BITS] += delta
}

// Adds or removes a full window column from the histogram.
function multiscaleMedianHistogramColumn(raw: ImageRawType, stride: number, channels: number, channel: number, x: number, y0: number, y1: number, min: number, inverse: number, fine: Int32Array, coarse: Int32Array, delta: number) {
	for (let y = y0, i = y0 * stride + x * channels + channel; y <= y1; y++, i += stride) {
		const bin = multiscaleMedianHistogramBin(raw[i], min, inverse)
		multiscaleMedianHistogramUpdate(fine, coarse, bin, delta)
	}
}

// Finds the first bin whose cumulative population exceeds the requested rank.
function multiscaleMedianHistogramSelect(fine: Int32Array, coarse: Int32Array, rank: number) {
	let cumulative = 0
	let group = 0

	for (; group < coarse.length; group++) {
		const next = cumulative + coarse[group]
		if (next > rank) break
		cumulative = next
	}

	const start = group << MMT_MEDIAN_HISTOGRAM_GROUP_BITS
	const end = Math.min(start + MMT_MEDIAN_HISTOGRAM_GROUP_SIZE, fine.length)

	for (let bin = start; bin < end; bin++) {
		cumulative += fine[bin]
		if (cumulative > rank) return bin
	}

	return MMT_MEDIAN_HISTOGRAM_LAST
}

// Returns the quantized median value for the current histogram population.
function multiscaleMedianHistogramMedian(fine: Int32Array, coarse: Int32Array, count: number, min: number, scale: number) {
	if (count <= 1 || scale === 0) return min

	const lower = multiscaleMedianHistogramSelect(fine, coarse, (count - 1) >>> 1)
	const upper = multiscaleMedianHistogramSelect(fine, coarse, count >>> 1)
	return min + (lower + upper) * 0.5 * scale
}

// Applies a quantized Huang-style sliding median with truncated borders.
function multiscaleMedianFilter(raw: ImageRawType, output: ImageRawType, metadata: ImageMetadata, radius: number) {
	if (radius <= 0) {
		output.set(raw)
		return output
	}

	const { width, height, channels, stride } = metadata
	const fine = new Int32Array(MMT_MEDIAN_HISTOGRAM_SIZE)
	const coarse = new Int32Array(MMT_MEDIAN_HISTOGRAM_GROUP_COUNT)

	for (let channel = 0; channel < channels; channel++) {
		const range = multiscaleMedianHistogramRange(raw, channels, channel)

		const [min, max] = range
		const scale = (max - min) / MMT_MEDIAN_HISTOGRAM_LAST

		if (scale === 0) {
			for (let y = 0, i = channel; y < height; y++) {
				for (let x = 0; x < width; x++, i += channels) {
					output[i] = min
				}
			}

			continue
		}

		const inverse = 1 / scale

		for (let y = 0; y < height; y++) {
			const y0 = Math.max(0, y - radius)
			const y1 = Math.min(height - 1, y + radius)
			const rowCount = y1 - y0 + 1

			fine.fill(0)
			coarse.fill(0)

			for (let x = 0, end = Math.min(width - 1, radius); x <= end; x++) {
				multiscaleMedianHistogramColumn(raw, stride, channels, channel, x, y0, y1, min, inverse, fine, coarse, 1)
			}

			for (let x = 0, i = y * stride + channel; x < width; x++, i += channels) {
				const left = Math.max(0, x - radius)
				const right = Math.min(width - 1, x + radius)
				const count = rowCount * (right - left + 1)

				output[i] = multiscaleMedianHistogramMedian(fine, coarse, count, min, scale)

				const removeX = x - radius

				if (removeX >= 0) {
					multiscaleMedianHistogramColumn(raw, stride, channels, channel, removeX, y0, y1, min, inverse, fine, coarse, -1)
				}

				const addX = x + radius + 1

				if (addX < width) {
					multiscaleMedianHistogramColumn(raw, stride, channels, channel, addX, y0, y1, min, inverse, fine, coarse, 1)
				}
			}
		}
	}

	return output
}

// Estimates a robust per-channel coefficient scale for MMT thresholding.
function multiscaleMedianScales(working: ImageRawType, filtered: ImageRawType, channels: number) {
	const pixelCount = working.length / channels
	const samples = new Float64Array(pixelCount)
	const scales = new Float64Array(channels)

	for (let channel = 0; channel < channels; channel++) {
		let sumSquares = 0

		for (let i = channel, k = 0; i < working.length; i += channels, k++) {
			const value = working[i] - filtered[i]
			const absolute = Math.abs(value)
			samples[k] = absolute
			sumSquares += value * value
		}

		let scale = STANDARD_DEVIATION_SCALE * medianOf(samples.sort(), pixelCount)

		// Sparse detail layers can have zero MAD, so fall back to RMS.
		if (!(scale > 0)) {
			scale = Math.sqrt(sumSquares / pixelCount)
		}

		scales[channel] = scale
	}

	return scales
}

// Applies a redundant dyadic multiscale median transform similar to PixInsight's MMT.
export function multiscaleMedianTransform(image: Image, options: Partial<MultiscaleMedianTransformOptions> = DEFAULT_MMT_OPTIONS): Image {
	const resolvedLayers = options.layers ?? DEFAULT_MMT_OPTIONS.layers
	const layers = Number.isFinite(resolvedLayers) ? Math.max(0, Math.trunc(resolvedLayers)) : DEFAULT_MMT_OPTIONS.layers

	if (layers === 0) return image

	const detailLayers = options.detailLayers ?? DEFAULT_MMT_OPTIONS.detailLayers
	const resolvedResidualGain = options.residualGain ?? DEFAULT_MMT_OPTIONS.residualGain
	const residualGain = Number.isFinite(resolvedResidualGain) ? resolvedResidualGain : DEFAULT_MMT_OPTIONS.residualGain
	const { raw, metadata } = image
	const n = raw.length
	const working = raw.slice()
	const filtered = raw instanceof Float64Array ? new Float64Array(n) : new Float32Array(n)

	raw.fill(0)

	for (let layer = 0; layer < layers; layer++) {
		const radius = 1 << layer
		const detailLayer = detailLayers[layer]
		const resolvedThreshold = detailLayer?.threshold ?? DEFAULT_MMT_LAYER_OPTIONS.threshold
		const threshold = Number.isFinite(resolvedThreshold) ? Math.max(0, resolvedThreshold) : DEFAULT_MMT_LAYER_OPTIONS.threshold
		const resolvedAmount = detailLayer?.amount ?? DEFAULT_MMT_LAYER_OPTIONS.amount
		const amount = Number.isFinite(resolvedAmount) ? clamp(resolvedAmount, 0, 1) : DEFAULT_MMT_LAYER_OPTIONS.amount
		const resolvedBias = detailLayer?.bias ?? DEFAULT_MMT_LAYER_OPTIONS.bias
		const bias = Number.isFinite(resolvedBias) ? resolvedBias : DEFAULT_MMT_LAYER_OPTIONS.bias
		const gain = 1 + bias

		multiscaleMedianFilter(working, filtered, metadata, radius)

		const scales = threshold > 0 && amount > 0 ? multiscaleMedianScales(working, filtered, metadata.channels) : undefined

		for (let i = 0; i < n; i++) {
			let value = working[i] - filtered[i]

			if (scales !== undefined) {
				const limit = threshold * scales[i % metadata.channels]

				if (Math.abs(value) <= limit) {
					value *= 1 - amount
				}
			}

			raw[i] += value * gain
			working[i] = filtered[i]
		}
	}

	if (residualGain !== 0) {
		for (let i = 0; i < n; i++) {
			raw[i] += working[i] * residualGain
		}
	}

	return image
}

interface FFTPlan {
	readonly size: number
	readonly bitReversed: Uint32Array
	readonly twiddleReal: Float64Array
	readonly twiddleImag: Float64Array
}

interface FFTMaskCache {
	width: number
	height: number
	cutoff: number
	filterType: FFTFilterType
	mask: Float64Array
}

// A fixed second-order Butterworth amplitude response gives a smooth halo roll-off without a near-hard cutoff ring.
const FFT_BUTTERWORTH_ORDER = 2
// Skip MaxIm-style range restoration when the low-pass output is nearly flat, to avoid stretching numerical residue into false texture.
const FFT_MIN_NORMALIZE_RANGE_RATIO = 1e-2

// Returns the next power-of-two FFT length, using one when size is zero or one.
function fftPaddedSize(size: number) {
	let padded = 1
	while (padded < size) padded *= 2
	return padded
}

// Clamps padded coordinates to the nearest border pixel to avoid mirrored duplicate stars near image edges.
function fftPadIndex(index: number, size: number) {
	if (size <= 1) return 0
	return index < size ? index : size - 1
}

// Returns a cached radix-2 FFT plan with bit-reversal and twiddle tables.
function fftPlan(size: number): FFTPlan {
	let bits = 0

	for (let n = size; n > 1; n *= 0.5) {
		bits++
	}

	const bitReversed = new Uint32Array(size)
	const twiddleReal = new Float64Array(size > 1 ? size >>> 1 : 0)
	const twiddleImag = new Float64Array(twiddleReal.length)

	for (let i = 0; i < size; i++) {
		let source = i
		let reversed = 0

		for (let bit = 0; bit < bits; bit++) {
			reversed = (reversed << 1) | (source & 1)
			source >>>= 1
		}

		bitReversed[i] = reversed
	}

	const scale = -TAU / size

	for (let i = 0; i < twiddleReal.length; i++) {
		const angle = scale * i
		twiddleReal[i] = Math.cos(angle)
		twiddleImag[i] = Math.sin(angle)
	}

	return { size, bitReversed, twiddleReal, twiddleImag }
}

// Represents a reusable FFT buffers sized for the image dimensions.
export class FFTWorkspace {
	readonly width: number
	readonly height: number
	readonly real: Float64Array
	readonly imaginary: Float64Array
	readonly columnReal: Float64Array
	readonly columnImaginary: Float64Array
	readonly rowPlan: FFTPlan
	readonly columnPlan: FFTPlan

	#mask?: FFTMaskCache

	constructor(width: number, height: number) {
		width = fftPaddedSize(width)
		height = fftPaddedSize(height)

		this.rowPlan = fftPlan(width)
		this.columnPlan = width === height ? this.rowPlan : fftPlan(height)

		const size = width * height
		const columnSize = Math.max(width, height)

		this.width = width
		this.height = height
		this.real = new Float64Array(size)
		this.imaginary = new Float64Array(size)
		this.columnReal = new Float64Array(columnSize)
		this.columnImaginary = new Float64Array(columnSize)
	}

	mask(filterType: FFTFilterType, cutoff: number) {
		if (this.#mask !== undefined && this.#mask.filterType === filterType && Math.abs(this.#mask.cutoff - cutoff) <= Number.EPSILON) {
			return this.#mask
		}

		this.#mask = fftMask(this.width, this.height, filterType, cutoff)

		return this.#mask
	}
}

// Computes the radial mask gain at normalized radius r for the selected FFT filter.
function fftMaskGain(filterType: FFTFilterType, cutoff: number, radius: number) {
	if (cutoff <= 0) {
		const lowPassGain = radius <= 0 ? 1 : 0
		return filterType === 'lowPass' ? lowPassGain : 1 - lowPassGain
	}

	if (cutoff >= 1) {
		return filterType === 'lowPass' ? 1 : 0
	}

	const radialCutoff2 = cutoff * cutoff
	const radius2 = radius * radius
	let cutoffPow = radialCutoff2
	let radiusPow = radius2

	// cutoff is the normalized -3 dB radius of a Butterworth amplitude mask, matching MaxIm DL's smooth roll-off style.
	for (let i = 1; i < FFT_BUTTERWORTH_ORDER; i++) {
		cutoffPow *= radialCutoff2
		radiusPow *= radius2
	}

	const denominator = cutoffPow + radiusPow
	const lowPassGain = Math.sqrt(cutoffPow / denominator)

	return filterType === 'lowPass' ? lowPassGain : Math.sqrt(radiusPow / denominator)
}

// Returns a cached centered radial mask for the padded FFT grid and slider state.
function fftMask(width: number, height: number, filterType: FFTFilterType, cutoff: number): FFTMaskCache {
	const mask = new Float64Array(width * height)
	const centerX = width >>> 1
	const centerY = height >>> 1
	const radiusScaleX = centerX > 0 ? 1 / centerX : 0
	const radiusScaleY = centerY > 0 ? 1 / centerY : 0

	if (centerX <= 0 && centerY <= 0) {
		mask[0] = filterType === 'lowPass' ? 1 : 0
	} else {
		for (let y = 0, i = 0; y < height; y++) {
			const dy = (y - centerY) * radiusScaleY
			const dy2 = dy * dy

			for (let x = 0; x < width; x++, i++) {
				const dx = (x - centerX) * radiusScaleX
				// r is normalized by each axis Nyquist radius so cutoff tracks MaxIm's percentage slider and stays circular on rectangular grids.
				const radius = Math.sqrt(dx * dx + dy2)

				mask[i] = fftMaskGain(filterType, cutoff, radius)
			}
		}
	}

	return { width, height, filterType, cutoff, mask }
}

// Runs one in-place radix-2 FFT over a contiguous complex vector.
function fftVector(real: Float64Array, imaginary: Float64Array, offset: number, plan: FFTPlan, inverse: boolean) {
	const { size, bitReversed, twiddleReal, twiddleImag } = plan

	for (let i = 0; i < size; i++) {
		const j = bitReversed[i]

		if (j > i) {
			const a = offset + i
			const b = offset + j
			const realValue = real[a]
			const imaginaryValue = imaginary[a]

			real[a] = real[b]
			imaginary[a] = imaginary[b]
			real[b] = realValue
			imaginary[b] = imaginaryValue
		}
	}

	const twiddleSign = inverse ? -1 : 1

	for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
		const halfSize = blockSize >>> 1
		const twiddleStep = size / blockSize

		for (let blockOffset = 0; blockOffset < size; blockOffset += blockSize) {
			for (let i = 0, twiddleIndex = 0; i < halfSize; i++, twiddleIndex += twiddleStep) {
				const a = offset + blockOffset + i
				const b = a + halfSize
				const wr = twiddleReal[twiddleIndex]
				const wi = twiddleImag[twiddleIndex] * twiddleSign
				const br = real[b]
				const bi = imaginary[b]
				const tr = wr * br - wi * bi
				const ti = wr * bi + wi * br
				const ar = real[a]
				const ai = imaginary[a]

				real[a] = ar + tr
				imaginary[a] = ai + ti
				real[b] = ar - tr
				imaginary[b] = ai - ti
			}
		}
	}

	if (inverse) {
		const scale = 1 / size

		for (let i = 0, j = offset; i < size; i++, j++) {
			real[j] *= scale
			imaginary[j] *= scale
		}
	}
}

// Runs a separable 2D FFT over the padded spectrum buffers.
function fftTransform2D(workspace: FFTWorkspace, inverse: boolean) {
	const { width, height, real, imaginary, columnReal, columnImaginary, rowPlan, columnPlan } = workspace

	for (let y = 0, offset = 0; y < height; y++, offset += width) {
		fftVector(real, imaginary, offset, rowPlan, inverse)
	}

	for (let x = 0; x < width; x++) {
		for (let y = 0, i = x; y < height; y++, i += width) {
			columnReal[y] = real[i]
			columnImaginary[y] = imaginary[i]
		}

		fftVector(columnReal, columnImaginary, 0, columnPlan, inverse)

		for (let y = 0, i = x; y < height; y++, i += width) {
			real[i] = columnReal[y]
			imaginary[i] = columnImaginary[y]
		}
	}
}

// Loads one image channel into the centered FFT plane with replicated-edge power-of-two padding.
function fftLoadChannel(image: Image, channel: number, workspace: FFTWorkspace) {
	const { width, height, channels, stride } = image.metadata
	const { real, imaginary, width: fftWidth, height: fftHeight } = workspace
	const { raw } = image

	for (let y = 0, i = 0; y < fftHeight; y++) {
		const sy = fftPadIndex(y, height)
		const row = sy * stride + channel

		for (let x = 0; x < fftWidth; x++, i++) {
			const sx = fftPadIndex(x, width)
			const pixel = raw[row + sx * channels]
			const value = Number.isFinite(pixel) ? pixel : 0

			// Multiplication by (-1)^(x+y) centers the DC component before masking.
			real[i] = ((x + y) & 1) === 0 ? value : -value
			imaginary[i] = 0
		}
	}
}

// Restores one low-pass output channel to the original channel dynamic range used by MaxIm DL.
function fftNormalizeChannel(image: Image, channel: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number) {
	const inputRange = inputMax - inputMin
	const outputRange = outputMax - outputMin
	if (!(inputRange > 0) || !(outputRange > 0)) return
	if (outputRange <= inputRange * FFT_MIN_NORMALIZE_RANGE_RATIO) return

	const { width, height, channels, stride } = image.metadata
	const { raw } = image
	const scale = inputRange / outputRange

	for (let y = 0; y < height; y++) {
		let oi = y * stride + channel

		for (let x = 0; x < width; x++, oi += channels) {
			raw[oi] = inputMin + (raw[oi] - outputMin) * scale
		}
	}
}

// Stores the inverse FFT plane back into one image channel, applies the weight blend in place, and returns channel ranges.
function fftStoreChannel(image: Image, channel: number, workspace: FFTWorkspace, weight: number) {
	const { width, height, channels, stride } = image.metadata
	const { real, width: fftWidth } = workspace
	const { raw } = image
	const originalWeight = 1 - weight
	let inputMin = Number.POSITIVE_INFINITY
	let inputMax = Number.NEGATIVE_INFINITY
	let outputMin = Number.POSITIVE_INFINITY
	let outputMax = Number.NEGATIVE_INFINITY

	for (let y = 0; y < height; y++) {
		let ii = y * fftWidth
		let oi = y * stride + channel

		for (let x = 0; x < width; x++, ii++, oi += channels) {
			const original = Number.isFinite(raw[oi]) ? raw[oi] : 0
			const unshifted = ((x + y) & 1) === 0 ? real[ii] : -real[ii]
			const filtered = Number.isFinite(unshifted) ? unshifted : original

			// weight blends the original and fully filtered result without moving the cutoff radius.
			const output = originalWeight * original + weight * filtered
			raw[oi] = output

			if (original < inputMin) inputMin = original
			if (original > inputMax) inputMax = original
			if (output < outputMin) outputMin = output
			if (output > outputMax) outputMax = output
		}
	}

	return [inputMin, inputMax, outputMin, outputMax] as const
}

// Applies a centered radial FFT low-pass or high-pass filter in place.
export function fft(image: Image, workspace: FFTWorkspace, filterType: FFTFilterType = 'lowPass', cutoff?: number, weight: number = 1): Image {
	const { width, height, channels } = image.metadata
	const amount = clamp(weight, 0, 1)
	if (amount <= 0 || width <= 0 || height <= 0 || channels <= 0) return image
	if (workspace.width < width || workspace.height < height) throw new Error(`FFT workspace ${workspace.width}x${workspace.height} is smaller than image ${width}x${height}`)

	const threshold = clamp(cutoff ?? (filterType === 'lowPass' ? 1 : 0), 0, 1)
	const { mask } = workspace.mask(filterType, threshold)
	const { real, imaginary } = workspace

	for (let channel = 0; channel < channels; channel++) {
		fftLoadChannel(image, channel, workspace)
		fftTransform2D(workspace, false)

		for (let i = 0; i < mask.length; i++) {
			const gain = mask[i]

			real[i] *= gain
			imaginary[i] *= gain
		}

		fftTransform2D(workspace, true)
		const [inputMin, inputMax, outputMin, outputMax] = fftStoreChannel(image, channel, workspace, amount)
		if (filterType === 'lowPass') fftNormalizeChannel(image, channel, inputMin, inputMax, outputMin, outputMax)
	}

	return image
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
		const n = raw.length

		for (let i = 0; i < n; i++) {
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
		const n = raw.length

		for (let i = 0; i < n; i += 3) {
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
		const n = raw.length

		for (let i = 0; i < n; i++) {
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
		const n = raw.length

		for (let i = 0; i < n; i++) {
			raw[i] = raw[i] ** inv
		}
	}

	return image
}

function checkDimensions(a: Image, b: Image) {
	if (a.metadata.channels !== b.metadata.channels) throw new Error(`channels does not match: ${a.metadata.channels} != ${b.metadata.channels}`)
	if (a.metadata.width !== b.metadata.width) throw new Error(`width does not match: ${a.metadata.width} != ${b.metadata.width}`)
	if (a.metadata.height !== b.metadata.height) throw new Error(`height does not match: ${a.metadata.height} != ${b.metadata.height}`)
}

export function clone(image: Image): Image {
	const header = structuredClone(image.header)
	const metadata = structuredClone(image.metadata)
	const { buffer } = Buffer.copyBytesFrom(image.raw)
	const raw = image.raw instanceof Float32Array ? new Float32Array(buffer) : new Float64Array(buffer)
	return { header, metadata, raw }
}

export function copyInto(from: Image, to: Image) {
	checkDimensions(from, to)

	const a = from.raw
	const b = to.raw
	const n = a.length
	for (let i = 0; i < n; i++) b[i] = a[i]
	return to
}

export function plus(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.min(1, a.raw[i] + b.raw[i])
	return out
}

export function plusScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.min(1, a.raw[i] + scalar)
	return out
}

export function subtract(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.max(0, a.raw[i] - b.raw[i])
	return out
}

export function subtractScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = Math.max(0, a.raw[i] - scalar)
	return out
}

export function multiply(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] * b.raw[i]
	return out
}

export function multiplyScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] * scalar
	return out
}

export function divide(a: Image, b: Image, out: Image = a) {
	checkDimensions(a, b)
	checkDimensions(b, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] / b.raw[i]
	return out
}

export function divideScalar(a: Image, scalar: number, out: Image = a) {
	checkDimensions(a, out)

	const n = a.raw.length
	for (let i = 0; i < n; i++) out.raw[i] = a.raw[i] / scalar
	return out
}

// Calibrated = (Light - Dark) / (Flat - Bias) * mean(Flat)
export function calibrate(light: Image, dark?: Image, flat?: Image, bias?: Image, darkFlat?: Image) {
	let tmp: Image | undefined

	// DARK

	if (dark) {
		const TL = Math.trunc(exposureTimeKeyword(light.header, 0) * 1000000)
		const TD = Math.trunc(exposureTimeKeyword(dark.header, 0) * 1000000)

		if (TL !== TD) {
			// dark = linear(DARK - BIAS, TL / TD, 0)

			tmp = clone(light)

			if (bias) subtract(tmp, bias)
			const bgL = estimateBackgroundUsingMode(tmp)

			copyInto(dark, tmp)
			if (bias) subtract(tmp, bias)
			const bgD = estimateBackgroundUsingMode(tmp)

			plusScalar(tmp, bgL - bgD)
			subtract(light, tmp)
		} else {
			subtract(light, dark)
		}
	} else if (bias) {
		subtract(light, bias)
	}

	// FLAT

	if (flat) {
		if (bias || darkFlat) {
			if (tmp) copyInto(flat, tmp)
			else tmp = clone(flat)

			if (darkFlat) subtract(tmp, darkFlat)
			else if (bias) subtract(tmp, bias)

			flat = tmp
		}

		divide(light, flat)
		multiplyScalar(light, meanOf(flat.raw))
	}

	return light
}
