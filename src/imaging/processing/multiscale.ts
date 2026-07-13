import { medianOf, STANDARD_DEVIATION_SCALE } from '../../core/util'
import { clamp } from '../../math/numerical/math'
import type { ImageRawType } from '../model/types'

// Shared contracts and allocation-free option/statistics helpers for redundant multiscale image
// transforms. Detail statistics operate on interleaved Float32/Float64 buffers and reuse caller-owned
// Float64 workspaces; no helper mutates the source or filtered coefficient buffers.

// User-facing controls for one detail layer of a multiscale transform.
export interface MultiscaleTransformLayerOptions {
	// Non-negative multiple of the per-channel robust scale used as a denoise limit.
	readonly threshold: number
	// Fraction in [0, 1] removed from coefficients at or below the denoise limit.
	readonly amount: number
	// Additive gain control; the applied coefficient gain is 1 + bias.
	readonly bias: number
}

// Common decomposition and reconstruction controls for redundant multiscale transforms.
export interface MultiscaleTransformOptions {
	// Non-negative number of dyadic detail layers to execute.
	readonly layers: number
	// Optional per-layer controls indexed from the finest detail layer.
	readonly detailLayers: readonly Partial<MultiscaleTransformLayerOptions>[]
	// Finite gain applied independently to the final smooth residual.
	readonly residualGain: number
}

// Validated hot-loop controls for one multiscale detail layer.
export interface ResolvedMultiscaleTransformLayerOptions {
	// Non-negative multiple of the per-channel robust scale used as a denoise limit.
	readonly threshold: number
	// Fraction in [0, 1] removed from coefficients at or below the denoise limit.
	readonly amount: number
	// Finite multiplicative gain applied to every coefficient in the detail layer.
	readonly gain: number
}

// Resolves a requested layer count to a truncated non-negative integer, using the default for
// non-finite or absent values.
export function resolveMultiscaleLayers(value: number | undefined, defaultValue: number) {
	return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : defaultValue
}

// Resolves a residual gain, using the finite default for non-finite or absent values.
export function resolveMultiscaleResidualGain(value: number | undefined, defaultValue: number) {
	return value !== undefined && Number.isFinite(value) ? value : defaultValue
}

// Resolves threshold, amount, and bias for one detail layer and converts bias to multiplicative gain.
export function resolveMultiscaleLayer(options: Partial<MultiscaleTransformLayerOptions> | undefined, defaults: Readonly<MultiscaleTransformLayerOptions>): ResolvedMultiscaleTransformLayerOptions {
	const resolvedThreshold = options?.threshold ?? defaults.threshold
	const threshold = Number.isFinite(resolvedThreshold) ? Math.max(0, resolvedThreshold) : defaults.threshold
	const resolvedAmount = options?.amount ?? defaults.amount
	const amount = Number.isFinite(resolvedAmount) ? clamp(resolvedAmount, 0, 1) : defaults.amount
	const resolvedBias = options?.bias ?? defaults.bias
	const bias = Number.isFinite(resolvedBias) ? resolvedBias : defaults.bias
	return { threshold, amount, gain: 1 + bias }
}

// Reports whether any executed detail layer needs per-channel scale estimation for denoising.
export function multiscaleNeedsDenoise(detailLayers: readonly Partial<MultiscaleTransformLayerOptions>[] | undefined, layers: number, defaults: Readonly<MultiscaleTransformLayerOptions>) {
	for (let layer = 0; layer < layers; layer++) {
		const detail = resolveMultiscaleLayer(detailLayers?.[layer], defaults)
		if (detail.threshold > 0 && detail.amount > 0) return true
	}

	return false
}

// Estimates robust scales for interleaved detail coefficients current-filtered. Samples and scales
// are exact-size caller workspaces reused across layers; the returned value aliases scales.
export function multiscaleDetailScales(current: ImageRawType, filtered: ImageRawType, channels: number, samples: Float64Array, scales: Float64Array): Float64Array {
	if (!Number.isInteger(channels) || channels <= 0 || current.length === 0 || current.length !== filtered.length || current.length % channels !== 0) {
		throw new RangeError('invalid multiscale detail buffer layout')
	}

	const pixelCount = current.length / channels

	if (samples.length !== pixelCount || scales.length !== channels) {
		throw new RangeError('invalid multiscale detail workspaces')
	}

	for (let channel = 0; channel < channels; channel++) {
		let sumSquares = 0

		for (let i = channel, sample = 0; i < current.length; i += channels, sample++) {
			const value = current[i] - filtered[i]
			samples[sample] = Math.abs(value)
			sumSquares += value * value
		}

		let scale = STANDARD_DEVIATION_SCALE * medianOf(samples.sort(), pixelCount)

		// Sparse detail layers can have zero median absolute coefficient, so fall back to RMS.
		if (!(scale > 0)) scale = Math.sqrt(sumSquares / pixelCount)

		scales[channel] = scale
	}

	return scales
}
