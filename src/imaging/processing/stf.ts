import { truncatePixel } from '../model/image'
import { channelIndex, type Image, type ImageChannelOrGray } from '../model/types'

// Screen transfer function (display stretch) applied in place to the normalized [0, 1] raw buffer.
// Remaps pixel values through a midtone/shadow/highlight transfer curve via a cached LUT, over a
// chosen channel or all channels.

// Options for applying a screen transfer function (display stretch).
export interface ApplyScreenTransferFunctionOptions {
	channel?: ImageChannelOrGray
	// Bit depth of the data.
	bits: number
}

// Default screen transfer function options (grayscale, 16-bit).
export const DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS: Readonly<ApplyScreenTransferFunctionOptions> = {
	channel: 'GRAY',
	bits: 16,
}

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
	const lut = new Float32Array(1 << bits).fill(Number.NaN)
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
