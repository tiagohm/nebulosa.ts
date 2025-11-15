import { channelIndex, grayscaleFromChannel, type HistogramPixelTransform, type Image, type ImageChannelOrGray, truncatePixel } from './image'
import { Histogram } from './statistics'

export function median(image: Image, channel?: ImageChannelOrGray, transform?: HistogramPixelTransform) {
	return histogram(image, channel, transform).median() / 65535
}

const STANDARD_DEVIATION_SCALE = 1.482602218505602

export function medianAbsoluteDiviation(image: Image, channel?: ImageChannelOrGray, normalized: boolean = false, m?: number) {
	m ||= median(image, channel)
	const mad = median(image, channel, (p) => Math.abs(p - m))
	return normalized ? STANDARD_DEVIATION_SCALE * mad : mad
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
