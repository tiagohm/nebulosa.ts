import type { Rect } from './geometry'
import { truncatePixel } from './image'
import { channelIndex, grayscaleFromChannel, type Image, type ImageChannelOrGray } from './image.types'
import type { NumberArray } from './math'
import { Histogram } from './statistics'

export type HistogramPixelTransform = (p: number) => number

export function median(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform, area?: Partial<Rect>, bits?: NumberArray | number) {
	return histogram(image, channel, transform, area, bits).median
}

const STANDARD_DEVIATION_SCALE = 1.482602218505602

export function medianAbsoluteDeviation(image: Image, m: number, channel?: ImageChannelOrGray, area?: Partial<Rect>, bits?: NumberArray | number, normalized: boolean = false) {
	const mad = median(image, channel, (p) => Math.abs(p - m), area, bits)
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
}

export const DEFAULT_MEAN_BACKGROUND = 0.25
export const DEFAULT_CLIPPING_POINT = -2.8

// Adaptive Display Function Algorithm
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Adaptive_Display_Function_Algorithm__
export function adf(image: Image, channel?: ImageChannelOrGray, meanBackground: number = DEFAULT_MEAN_BACKGROUND, clippingPoint: number = DEFAULT_CLIPPING_POINT, area?: Partial<Rect>) {
	const hist = new Int32Array(65536)
	const med = median(image, channel, undefined, area, hist)
	const mad = medianAbsoluteDeviation(image, med, channel, area, hist, true)
	const upperHalf = med > 0.5
	const shadow = upperHalf || mad === 0 ? 0 : Math.min(1, Math.max(0, med + clippingPoint * mad))
	const highlight = !upperHalf || mad === 0 ? 1 : Math.min(1, Math.max(0, med - clippingPoint * mad))
	const x = upperHalf ? meanBackground : med - shadow
	const m = upperHalf ? highlight - med : meanBackground
	const midtone = x === 0 ? 0 : x === m ? 0.5 : x === 1 ? 1 : ((m - 1) * x) / ((2 * m - 1) * x - m)
	return [midtone, shadow, highlight] as const
}

export function histogram(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform, area?: Partial<Rect>, bits: NumberArray | number = 16) {
	const histogram = typeof bits === 'number' ? new Int32Array(1 << bits) : bits.fill(0)
	const max = histogram.length - 1
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
			const n = m + x * channels + offset
			const v = isGrayscale ? raw[n] * red + raw[n + 1] * green + raw[n + 2] * blue : raw[n]
			const p = truncatePixel(transform?.(v) ?? v, max)
			histogram[p]++
		}
	}

	return new Histogram(histogram, max)
}
