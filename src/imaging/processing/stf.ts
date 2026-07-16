import { validateInRange } from '../../core/validation'
import { channelIndex, type Image, type ImageChannelOrGray } from '../model/types'

// Screen transfer function (display stretch) applied in place to the normalized [0, 1] raw buffer.
// Remaps pixel values through a midtone/shadow/highlight transfer curve over a chosen channel or
// all channels.

// Options for applying a screen transfer function (display stretch).
export interface ApplyScreenTransferFunctionOptions {
	// RGB channel to transform, or any non-RGB channel selector to transform every stored sample.
	channel?: ImageChannelOrGray
}

// Default screen transfer function options apply the curve to every stored sample.
export const DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS: Readonly<ApplyScreenTransferFunctionOptions> = {
	channel: 'GRAY',
}

// Apply Screen Transfer Function to image.
// https://pixinsight.com/doc/docs/XISF-1.0-spec/XISF-1.0-spec.html#__XISF_Data_Objects_:_XISF_Image_:_Display_Function__
// https://pixinsight.com/tutorials/24-bit-stf/
export function stf(image: Image, midtone: number = 0.5, shadow: number = 0, highlight: number = 1, options: Partial<ApplyScreenTransferFunctionOptions> = DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS): Image {
	if (midtone === 0.5 && shadow === 0 && highlight === 1) return image
	validateInRange(midtone, 0, 1)
	validateInRange(shadow, 0, 1)
	validateInRange(highlight, 0, 1)
	if (shadow > highlight) throw new RangeError('shadow must be less than or equal to highlight')

	const factor = shadow === highlight ? 1 : 1 / (highlight - shadow)
	const k1 = (midtone - 1) * factor
	const k2 = (2 * midtone - 1) * factor

	const { raw, metadata } = image
	const isColor = metadata.channels === 3
	const { channel = DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS.channel } = options
	const step = isColor && (channel === 'RED' || channel === 'GREEN' || channel === 'BLUE') ? 3 : 1
	const n = raw.length

	// Evaluate the exact curve per sample. A quantized LUT was slower for both small and large images,
	// allocated a temporary buffer per call, and made Float64 results depend on the first sample in a bin.
	for (let i = isColor ? channelIndex(channel) : 0; i < n; i += step) {
		const value = raw[i]

		if (value <= shadow) raw[i] = 0
		else if (value >= highlight) raw[i] = 1
		else if (midtone === 1) raw[i] = 0
		else {
			const d = value - shadow
			raw[i] = (d * k1) / (d * k2 - midtone)
		}
	}

	return image
}
