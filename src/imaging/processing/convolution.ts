import { TAU } from '../../core/constants'
import type { NumberArray } from '../../math/numerical/math'
import { type ConvolutionKernel, type ConvolutionOptions, DEFAULT_CONVOLUTION_OPTIONS, DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS, type GaussianBlurConvolutionOptions, type Image, type ImageRawType } from '../model/types'

// Builds a convolution kernel descriptor and infers its divisor when omitted.
export function convolutionKernel(kernel: Readonly<NumberArray>, width: number, height: number = width, divisor?: number): ConvolutionKernel {
	if (kernel.length < width * height) {
		throw new Error('invalid kernel size')
	}

	divisor ??= (kernel as number[]).reduce((a, b) => a + b)

	return { kernel, width, height, divisor }
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
