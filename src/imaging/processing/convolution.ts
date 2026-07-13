import { TAU } from '../../core/constants'
import { validateNonNegativeFinite, validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import type { Size } from '../../math/numerical/geometry'
import type { NumberArray } from '../../math/numerical/math'
import type { Image, ImageMetadata, ImageRawType } from '../model/types'

// Spatial convolution of images in place on the normalized [0, 1] raw buffer: a generic kernel
// convolver with optional edge renormalization, a raw separable dilated smoother, kernel builders,
// and named filters (edge detection, emboss, mean/box blur, sharpen, pyramid blur, and Gaussian blur).

// A convolution kernel and its normalization divisor.
export interface ConvolutionKernel extends Readonly<Size> {
	// Row-major kernel weights, width*height long.
	readonly kernel: Readonly<NumberArray>
	// Divisor applied to the weighted sum (kernel normalization).
	readonly divisor: number
}

// Common convolution behavior options.
export interface ConvolutionOptions {
	// Recompute the divisor at edges from the in-bounds kernel weights instead of clamping.
	dynamicDivisorForEdges: boolean
	// Normalize the kernel so its weights sum to one.
	normalize: boolean
}

// A non-negative one-dimensional smoothing kernel and its positive normalization divisor.
export interface SeparableSmoothingKernel {
	// Kernel weights in increasing offset order; the length is odd and at least three.
	readonly kernel: Readonly<NumberArray>
	// Positive divisor applied independently by the horizontal and vertical passes.
	readonly divisor: number
}

// Sampling and edge-normalization options for raw separable smoothing.
export interface SeparableSmoothingOptions {
	// Positive integer spacing, in pixels, between adjacent kernel taps.
	readonly step: number
	// Recompute each axis divisor from in-bounds weights at truncated borders.
	readonly dynamicDivisorForEdges: boolean
}

// Options for a Gaussian blur convolution.
export interface GaussianBlurConvolutionOptions extends ConvolutionOptions {
	// Standard deviation of the Gaussian, in pixels.
	sigma: number
	// Kernel side length, in pixels.
	size: number
}

// Default convolution options.
export const DEFAULT_CONVOLUTION_OPTIONS: Readonly<ConvolutionOptions> = {
	dynamicDivisorForEdges: true,
	normalize: true,
}

// Default raw separable smoothing options: adjacent taps and normalized truncated borders.
const DEFAULT_SEPARABLE_SMOOTHING_OPTIONS: Readonly<SeparableSmoothingOptions> = {
	step: 1,
	dynamicDivisorForEdges: true,
}

// Default Gaussian blur (sigma 1.4, 5x5 kernel).
export const DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS: Readonly<GaussianBlurConvolutionOptions> = {
	...DEFAULT_CONVOLUTION_OPTIONS,
	sigma: 1.4,
	size: 5,
}

// Builds a convolution kernel descriptor and infers its divisor when omitted.
export function convolutionKernel(kernel: Readonly<NumberArray>, width: number, height: number = width, divisor?: number): ConvolutionKernel {
	if (kernel.length < width * height) {
		throw new Error('invalid kernel size')
	}

	divisor ??= (kernel as number[]).reduce((a, b) => a + b)

	return { kernel, width, height, divisor }
}

// Validates a smoothing kernel descriptor used by the two separable passes.
function validateSeparableSmoothingKernel(kernel: SeparableSmoothingKernel) {
	if (kernel.kernel.length < 3 || kernel.kernel.length % 2 === 0) {
		throw new RangeError('separable kernel length must be odd and at least 3')
	}

	for (let i = 0; i < kernel.kernel.length; i++) {
		validateNonNegativeFinite(kernel.kernel[i])
	}

	validatePositiveFinite(kernel.divisor)
}

// Builds a validated one-dimensional smoothing kernel, inferring its positive divisor when omitted.
export function separableSmoothingKernel(kernel: Readonly<NumberArray>, divisor?: number): SeparableSmoothingKernel {
	if (kernel.length < 3 || kernel.length % 2 === 0) {
		throw new RangeError('separable kernel length must be odd and at least 3')
	}

	let sum = 0

	for (let i = 0; i < kernel.length; i++) {
		const weight = kernel[i]
		validateNonNegativeFinite(weight)
		sum += weight
	}

	const resolvedDivisor = divisor ?? sum
	const result = { kernel, divisor: resolvedDivisor }
	validateSeparableSmoothingKernel(result)
	return result
}

// Applies a dilated separable smoothing kernel from source into output via a reusable full-frame
// intermediate buffer. Buffers must be non-overlapping, have one precision, and match metadata;
// the returned value aliases output.
//
// This is intentionally separate from convolution(): expanding an a trous kernel would create a
// sparse square kernel with side 2*radius*step+1. The generic 2D path caps sides at 99, visits every
// inserted zero, and therefore makes work grow with the square of the dilated support. These two 1D
// passes visit only the original taps, keeping work linear in the raw buffer length at every scale;
// the full intermediate buffer also preserves source samples without a scale-dependent row queue.
export function separableSmoothing(source: ImageRawType, output: ImageRawType, intermediate: ImageRawType, metadata: ImageMetadata, kernel: SeparableSmoothingKernel, options: Partial<SeparableSmoothingOptions> = DEFAULT_SEPARABLE_SMOOTHING_OPTIONS): ImageRawType {
	validateSeparableSmoothingKernel(kernel)

	const step = options.step ?? DEFAULT_SEPARABLE_SMOOTHING_OPTIONS.step
	const dynamicDivisorForEdges = options.dynamicDivisorForEdges ?? DEFAULT_SEPARABLE_SMOOTHING_OPTIONS.dynamicDivisorForEdges
	const radius = kernel.kernel.length >>> 1
	const effectiveRadius = radius * step
	validatePositiveInteger(step)

	if (!Number.isFinite(effectiveRadius)) {
		throw new RangeError('separable smoothing effective radius must be finite')
	}

	const { width, height, channels, stride, pixelCount } = metadata

	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 || !Number.isInteger(channels) || channels <= 0 || stride !== width * channels || pixelCount !== width * height) {
		throw new RangeError('invalid image metadata for separable smoothing')
	}

	const length = stride * height

	if (source.length !== length || output.length !== length || intermediate.length !== length) {
		throw new RangeError('separable smoothing buffers must match image metadata')
	}

	if (source.BYTES_PER_ELEMENT !== output.BYTES_PER_ELEMENT || source.BYTES_PER_ELEMENT !== intermediate.BYTES_PER_ELEMENT) {
		throw new TypeError('separable smoothing buffers must use the same precision')
	}

	if (source.buffer === output.buffer || source.buffer === intermediate.buffer || output.buffer === intermediate.buffer) {
		throw new TypeError('separable smoothing buffers must not alias')
	}

	const weights = kernel.kernel

	for (let y = 0; y < height; y++) {
		const row = y * stride

		for (let x = 0; x < width; x++) {
			let divisor = kernel.divisor

			if (dynamicDivisorForEdges) {
				divisor = 0

				for (let tap = 0; tap < weights.length; tap++) {
					const sampleX = x + (tap - radius) * step
					if (sampleX >= 0 && sampleX < width) divisor += weights[tap]
				}

				// A valid non-negative kernel can still have no positive in-bounds weight.
				if (divisor === 0) divisor = kernel.divisor
			}

			const pixel = row + x * channels

			for (let channel = 0; channel < channels; channel++) {
				let sum = 0

				for (let tap = 0; tap < weights.length; tap++) {
					const sampleX = x + (tap - radius) * step

					if (sampleX >= 0 && sampleX < width) {
						sum += weights[tap] * source[row + sampleX * channels + channel]
					}
				}

				intermediate[pixel + channel] = sum / divisor
			}
		}
	}

	for (let y = 0; y < height; y++) {
		let divisor = kernel.divisor

		if (dynamicDivisorForEdges) {
			divisor = 0

			for (let tap = 0; tap < weights.length; tap++) {
				const sampleY = y + (tap - radius) * step
				if (sampleY >= 0 && sampleY < height) divisor += weights[tap]
			}

			if (divisor === 0) divisor = kernel.divisor
		}

		const row = y * stride

		for (let x = 0; x < width; x++) {
			const pixel = row + x * channels

			for (let channel = 0; channel < channels; channel++) {
				let sum = 0

				for (let tap = 0; tap < weights.length; tap++) {
					const sampleY = y + (tap - radius) * step

					if (sampleY >= 0 && sampleY < height) {
						sum += weights[tap] * intermediate[sampleY * stride + x * channels + channel]
					}
				}

				output[pixel + channel] = sum / divisor
			}
		}
	}

	return output
}

// Rotates the convolution row buffer forward by one slot.
export function shift(buffer: NumberArray[]) {
	const n = buffer.length - 1
	const first = buffer[0]
	for (let i = 0; i < n; i++) buffer[i] = buffer[i + 1]
	buffer[n] = first
}

// Applies a spatial convolution kernel in place with optional edge renormalization.
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

	// Copies one source row into the rolling convolution buffer when it is in bounds.
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
		read(y + yr + 1, buffer.at(-1)!)
	}

	return image
}

// Prebuilt convolution kernels for the named filters below (edge detection, emboss, mean/box blur,
// sharpen, and pyramid blur), each with its normalization divisor.
const EDGES = convolutionKernel(new Int8Array([0, -1, 0, -1, 4, -1, 0, -1, 0]), 3, 3, 0)
const EMBOSS = convolutionKernel(new Int8Array([-1, 0, 0, 0, 0, 0, 0, 0, 1]), 3, 3, 0)
const MEAN_3x3 = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), 3, 3, 9)
const MEAN_5x5 = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 5, 5, 25)
const MEAN_7x7 = convolutionKernel(new Int8Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 7, 7, 49)
const SHARPEN = convolutionKernel(new Int8Array([0, -1, 0, -1, 5, -1, 0, -1, 0]), 3, 3, 1)
const BLUR_3x3 = convolutionKernel(new Int8Array([1, 2, 1, 2, 4, 2, 1, 2, 1]), 3, 3, 16)
const BLUR_5x5 = convolutionKernel(new Int8Array([1, 2, 3, 2, 1, 2, 4, 6, 4, 2, 3, 6, 9, 6, 3, 2, 4, 6, 4, 2, 1, 2, 3, 2, 1]), 5, 5, 81)
const BLUR_7x7 = convolutionKernel(new Int8Array([1, 2, 3, 4, 3, 2, 1, 2, 4, 6, 8, 6, 4, 2, 3, 6, 9, 12, 9, 6, 3, 4, 8, 12, 16, 12, 8, 4, 3, 6, 9, 12, 9, 6, 3, 2, 4, 6, 8, 6, 4, 2, 1, 2, 3, 4, 3, 2, 1]), 7, 7, 256)

// Builds a normalized Gaussian convolution kernel from sigma and kernel size.
export function gaussianBlurKernel(sigma: number = 1.4, size: number = 5) {
	if (size < 2 || size % 2 === 0) {
		throw new Error('size must be odd and greater or equal to 3')
	}
	if (sigma < 0.5 || sigma > 5) {
		throw new Error('kernel size bust be in range [0.5..5]')
	}

	const sigmaSquared = sigma * sigma
	const r = Math.trunc(Math.trunc(size) / 2)

	// Evaluates the continuous 2D Gaussian density at one kernel offset.
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

// Applies the 3x3 edge-detection kernel.
export function edges(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, EDGES, options)
}

// Applies the 3x3 emboss kernel.
export function emboss(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, EMBOSS, options)
}

// Builds a box-blur kernel of arbitrary odd size.
export function meanConvolutionKernel(size: number) {
	if (size < 3) throw new Error('size must be greater or equal to 3')
	if (size > 99) throw new Error('size must be less or equal to 99')
	if (size % 2 === 0) throw new Error('size must be odd')

	const kernel = new Int8Array(size * size).fill(1)
	return convolutionKernel(kernel, size, size, kernel.length)
}

// Applies mean convolution with optimized kernels for common sizes.
export function mean(image: Image, size: number, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	if (size === 3) return mean3x3(image, options)
	if (size === 5) return mean5x5(image, options)
	if (size === 7) return mean7x7(image, options)

	return convolution(image, meanConvolutionKernel(size), options)
}

// Applies the 3x3 mean blur kernel.
export function mean3x3(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, MEAN_3x3, options)
}

// Applies the 5x5 mean blur kernel.
export function mean5x5(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, MEAN_5x5, options)
}

// Applies the 7x7 mean blur kernel.
export function mean7x7(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, MEAN_7x7, options)
}

// Applies the 3x3 sharpening kernel.
export function sharpen(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, SHARPEN, options)
}

// Builds a pyramid-weight blur kernel of arbitrary odd size.
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

// Applies pyramid blur convolution with optimized kernels for common sizes.
export function blur(image: Image, size: number, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	if (size === 3) return blur3x3(image, options)
	if (size === 5) return blur5x5(image, options)
	if (size === 7) return blur7x7(image, options)

	return convolution(image, blurConvolutionKernel(size), options)
}

// Applies the 3x3 pyramid blur kernel.
export function blur3x3(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, BLUR_3x3, options)
}

// Applies the 5x5 pyramid blur kernel.
export function blur5x5(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, BLUR_5x5, options)
}

// Applies the 7x7 pyramid blur kernel.
export function blur7x7(image: Image, options: Partial<ConvolutionOptions> = DEFAULT_CONVOLUTION_OPTIONS) {
	return convolution(image, BLUR_7x7, options)
}

// Applies Gaussian blur using a generated kernel.
export function gaussianBlur(image: Image, options: Partial<GaussianBlurConvolutionOptions> = DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS) {
	return convolution(image, gaussianBlurKernel(options.sigma, options.size), options)
}
