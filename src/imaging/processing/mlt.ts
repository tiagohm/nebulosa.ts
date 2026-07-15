import { makeImageRawTypedArray, type Image, type ImageRawType } from '../model/types'
import { separableSmoothingKernel, separableSmoothing } from './convolution'
import { multiscaleDetailScales, multiscaleNeedsDenoise, resolveMultiscaleLayer, resolveMultiscaleLayers, resolveMultiscaleResidualGain, type MultiscaleTransformLayerOptions, type MultiscaleTransformOptions } from './multiscale'

// Redundant a trous multiscale linear transform (MLT) with a dilated B3-spline scaling function.
// Interleaved Float32/Float64 images are decomposed and reconstructed in place without downsampling,
// output clamping, expanded kernels, or allocations inside sample loops.

// Per-detail-layer controls for the multiscale linear transform.
export interface MultiscaleLinearTransformLayerOptions extends MultiscaleTransformLayerOptions {}

// Decomposition and reconstruction controls for the multiscale linear transform.
export interface MultiscaleLinearTransformOptions extends MultiscaleTransformOptions {}

// Default MLT detail controls: no denoise and unit coefficient gain.
export const DEFAULT_MLT_LAYER_OPTIONS: Readonly<MultiscaleLinearTransformLayerOptions> = {
	threshold: 0,
	amount: 1,
	bias: 0,
}

// Default MLT controls: three detail layers and a unit residual gain.
export const DEFAULT_MLT_OPTIONS: Readonly<MultiscaleLinearTransformOptions> = {
	layers: 3,
	detailLayers: [],
	residualGain: 1,
}

// Five-tap cubic B-spline scaling function [1, 4, 6, 4, 1] / 16.
const B3_SPLINE_KERNEL = separableSmoothingKernel(new Int8Array([1, 4, 6, 4, 1]), 16)

// Applies an in-place redundant B3-spline MLT. Detail denoise/gains and the residual gain are
// independent, and reconstructed values retain their full signed range.
export function multiscaleLinearTransform(image: Image, options: Partial<MultiscaleLinearTransformOptions> = DEFAULT_MLT_OPTIONS): Image {
	const requestedLayers = resolveMultiscaleLayers(options.layers, DEFAULT_MLT_OPTIONS.layers)
	const maxDimension = Math.max(image.metadata.width, image.metadata.height)
	const maxUsefulLayers = maxDimension > 1 ? Math.ceil(Math.log2(maxDimension)) : 0
	const layers = Math.min(requestedLayers, maxUsefulLayers)

	if (layers === 0) return image

	const residualGain = resolveMultiscaleResidualGain(options.residualGain, DEFAULT_MLT_OPTIONS.residualGain)
	const detailLayers = options.detailLayers ?? DEFAULT_MLT_OPTIONS.detailLayers
	const { raw, metadata } = image
	const length = raw.length
	let current: ImageRawType = raw.slice()
	let filtered = makeImageRawTypedArray(raw, length)
	const intermediate = makeImageRawTypedArray(raw, length)
	const denoise = multiscaleNeedsDenoise(detailLayers, layers, DEFAULT_MLT_LAYER_OPTIONS)
	const samples = denoise ? new Float64Array(metadata.pixelCount) : undefined
	const scales = denoise ? new Float64Array(metadata.channels) : undefined

	raw.fill(0)

	for (let layer = 0; layer < layers; layer++) {
		const detail = resolveMultiscaleLayer(detailLayers[layer], DEFAULT_MLT_LAYER_OPTIONS)

		separableSmoothing(current, filtered, intermediate, metadata, B3_SPLINE_KERNEL, { step: 2 ** layer, dynamicDivisorForEdges: true })

		const channelScales = detail.threshold > 0 && detail.amount > 0 ? multiscaleDetailScales(current, filtered, metadata.channels, samples!, scales!) : undefined

		for (let i = 0; i < length; i++) {
			let value = current[i] - filtered[i]

			if (channelScales !== undefined) {
				const limit = detail.threshold * channelScales[i % metadata.channels]
				if (Math.abs(value) <= limit) value *= 1 - detail.amount
			}

			raw[i] += value * detail.gain
		}

		const swap = current
		current = filtered
		filtered = swap
	}

	if (residualGain !== 0) {
		for (let i = 0; i < length; i++) raw[i] += current[i] * residualGain
	}

	return image
}
