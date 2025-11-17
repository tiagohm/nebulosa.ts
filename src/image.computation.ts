import type { Rect } from './geometry'
import { channelIndex, grayscaleFromChannel, type Image, type ImageChannelOrGray, truncatePixel } from './image'
import { Histogram } from './statistics'

export type HistogramPixelTransform = (p: number) => number

export function median(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform) {
	return histogram(image, channel, transform).median() / 65535
}

const STANDARD_DEVIATION_SCALE = 1.482602218505602

export function medianAbsoluteDiviation(image: Image, channel?: ImageChannelOrGray, normalized: boolean = false, m?: number) {
	m ||= median(image, channel)
	const mad = median(image, channel, (p) => Math.abs(p - m))
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
}

export function histogram(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform, area?: Partial<Rect>, bits: number = 16) {
	const histogram = new Int32Array(1 << bits)
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

	return new Histogram(histogram)
}
