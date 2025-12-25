import { truncatePixel } from './image'
import { type AdaptiveDisplayFunctionOptions, channelIndex, DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS, DEFAULT_HISTOGRAM_OPTIONS, DEFAULT_SIGMA_CLIP_OPTIONS, grayscaleFromChannel, type HistogramOptions, type Image, type SigmaClipOptions, STANDARD_DEVIATION_SCALE } from './image.types'
import { Histogram } from './statistics'

export function median(image: Image, options: Partial<HistogramOptions> = DEFAULT_HISTOGRAM_OPTIONS) {
	return histogram(image, options).median
}

export function medianAbsoluteDeviation(image: Image, m: number, normalized: boolean = false, options: Partial<HistogramOptions> = DEFAULT_HISTOGRAM_OPTIONS) {
	const transform = options.transform ?? DEFAULT_HISTOGRAM_OPTIONS.transform
	const mad = median(image, { ...options, transform: (p, i) => Math.abs(transform(p, i) - m) })
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
}

// Adaptive Display Function Algorithm
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Adaptive_Display_Function_Algorithm__
export function adf(image: Image, options: Partial<AdaptiveDisplayFunctionOptions> = DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS) {
	const bits = options.bits === undefined || typeof options.bits === 'number' ? new Int32Array(1 << (options.bits ?? 16)) : options.bits
	options = { ...options, bits }
	const meanBackground = options.meanBackground || DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS.meanBackground
	const clippingPoint = options.clippingPoint || DEFAULT_ADAPTIVE_DISPLAY_FUNCTION_OPTIONS.clippingPoint
	const med = median(image, options)
	const mad = medianAbsoluteDeviation(image, med, true, options)
	const upperHalf = med > 0.5
	const shadow = upperHalf || mad === 0 ? 0 : Math.min(1, Math.max(0, med + clippingPoint * mad))
	const highlight = !upperHalf || mad === 0 ? 1 : Math.min(1, Math.max(0, med - clippingPoint * mad))
	const x = upperHalf ? meanBackground : med - shadow
	const m = upperHalf ? highlight - med : meanBackground
	const midtone = x === 0 ? 0 : x === m ? 0.5 : x === 1 ? 1 : ((m - 1) * x) / ((2 * m - 1) * x - m)
	return [midtone, shadow, highlight] as const
}

export function histogram(image: Image, options: Partial<HistogramOptions> = DEFAULT_HISTOGRAM_OPTIONS) {
	const { channel, bits, area, transform, sigmaClip } = Object.assign({}, DEFAULT_HISTOGRAM_OPTIONS, options)
	const h = typeof bits === 'number' ? new Int32Array(1 << bits) : bits.fill(0)
	const max = h.length - 1
	const { raw, metadata } = image
	const { stride, width, height, channels } = metadata

	const left = Math.max(0, Math.min(area?.left ?? 0, width))
	const top = Math.max(0, Math.min(area?.top ?? 0, height))
	const right = Math.max(0, Math.min(area?.right ?? width - 1, width))
	const bottom = Math.max(0, Math.min(area?.bottom ?? height - 1, height))

	const offset = channelIndex(channel)
	const { red, green, blue } = grayscaleFromChannel(channel)
	const isGrayscale = channels === 3 && !(channel === 'RED' || channel === 'GREEN' || channel === 'BLUE')

	for (let y = top; y <= bottom; y++) {
		const m = y * stride

		for (let x = left; x <= right; x++) {
			const i = m + x * channels + offset
			if (sigmaClip !== undefined && sigmaClip[i] !== 0) continue
			const v = isGrayscale ? raw[i] * red + raw[i + 1] * green + raw[i + 2] * blue : raw[i]
			const p = truncatePixel(transform(v, i), max)
			h[p]++
		}
	}

	return new Histogram(h, max)
}

export function sigmaClip(image: Image, options: Partial<SigmaClipOptions> = DEFAULT_SIGMA_CLIP_OPTIONS) {
	const { channel, centerMethod, dispersionMethod, sigmaLower, sigmaUpper, tolerance, maxIterations } = Object.assign({}, DEFAULT_SIGMA_CLIP_OPTIONS, options)

	const { raw, metadata } = image
	const { red, green, blue } = grayscaleFromChannel(channel)
	const { pixelCount: n, channels } = metadata
	const mask = options.mask?.fill(0) ?? new Int8Array(raw.length)

	if (raw.length > mask.length) throw new Error(`mask must have length >= ${raw.length}`)

	const bits = options.bits === undefined || typeof options.bits === 'number' ? new Int32Array(1 << (options.bits ?? 16)) : options.bits
	options = { ...options, bits, transform: (p, i) => (mask[i] === 1 ? 0 : p), sigmaClip: undefined } as HistogramOptions

	const isMono = channels === 1

	let lastCenter = 1

	for (let i = 0; i < maxIterations; i++) {
		const { mean, median, standardDeviation } = histogram(image, options)

		const center = centerMethod === 'mean' ? mean : median
		const dispersion = dispersionMethod === 'std' ? standardDeviation : medianAbsoluteDeviation(image, median, true, options)

		if (!Number.isFinite(dispersion) || dispersion === 0) break

		// Check convergence
		if (Math.abs(center - lastCenter) < tolerance * Math.abs(center)) break

		lastCenter = center

		const lower = center - sigmaLower * dispersion
		const upper = center + sigmaUpper * dispersion

		let count = 0

		if (isMono) {
			for (let i = 0; i < n; i++) {
				if (mask[i] === 1) continue

				const p = raw[i]

				if (p < lower || p > upper) {
					mask[i] = 1
					count++
				}
			}
		} else if (channel === 'RED' || channel === 'GREEN' || channel === 'BLUE') {
			for (let i = 0, k = channelIndex(channel); i < n; i++, k += 3) {
				if (mask[k] === 1) continue

				const p = raw[k]

				if (p < lower || p > upper) {
					mask[k] = 1
					count++
				}
			}
		} else {
			for (let i = 0, k = 0; i < n; i++, k += 3) {
				if (mask[k] === 1) continue

				const p = raw[k] * red + raw[k + 1] * green + raw[k + 2] * blue

				if (p < lower || p > upper) {
					mask[k] = 1
					mask[k + 1] = 1
					mask[k + 2] = 1
					count++
				}
			}
		}

		// Good!
		if (count === 0) break
	}

	return mask
}
