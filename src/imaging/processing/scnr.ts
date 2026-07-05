import type { Image, ImageChannel } from '../model/types'

// Highlight/green-cast protection method for the SCNR (subtractive chromatic noise reduction) operation.
export type SCNRProtectionMethod = 'MAXIMUM_MASK' | 'ADDITIVE_MASK' | 'AVERAGE_NEUTRAL' | 'MAXIMUM_NEUTRAL' | 'MINIMUM_NEUTRAL'

// SCNR kernel: given the three channel values and an amount, returns the corrected middle channel.
export type SCNRAlgorithm = (a: number, b: number, c: number, amount: number) => number

// Computes the maximum-mask SCNR attenuation for one protected channel sample.
export function scnrMaximumMask(a: number, b: number, c: number, amount: number) {
	const m = Math.max(b, c)
	return a * (1 - amount) * (1 - m) + m * a
}

// Computes the additive-mask SCNR attenuation for one protected channel sample.
export function scnrAdditiveMask(a: number, b: number, c: number, amount: number) {
	const m = Math.min(1, b + c)
	return a * (1 - amount) * (1 - m) + m * a
}

// Computes the average-neutral SCNR replacement for one protected channel sample.
export function scnrAverageNeutral(a: number, b: number, c: number, amount: number) {
	const m = 0.5 * (b + c)
	return Math.min(a, m)
}

// Computes the maximum-neutral SCNR replacement for one protected channel sample.
export function scnrMaximumNeutral(a: number, b: number, c: number, amount: number) {
	const m = Math.max(b, c)
	return Math.min(a, m)
}

// Computes the minimum-neutral SCNR replacement for one protected channel sample.
export function scnrMinimumNeutral(a: number, b: number, c: number, amount: number) {
	const m = Math.min(b, c)
	return Math.min(a, m)
}

// Lookup from an SCNR protection method to its per-pixel correction kernel.
const SCNR_ALGORITHMS: Readonly<Record<SCNRProtectionMethod, SCNRAlgorithm>> = {
	MAXIMUM_MASK: scnrMaximumMask,
	ADDITIVE_MASK: scnrAdditiveMask,
	AVERAGE_NEUTRAL: scnrAverageNeutral,
	MAXIMUM_NEUTRAL: scnrMaximumNeutral,
	MINIMUM_NEUTRAL: scnrMinimumNeutral,
}

// Subtractive Chromatic Noise Reduction
export function scnr(image: Image, channel: ImageChannel = 'GREEN', amount: number = 0.5, method: SCNRProtectionMethod = 'MAXIMUM_MASK') {
	if (image.metadata.channels === 3) {
		const p0 = channel === 'RED' ? 0 : channel === 'GREEN' ? 1 : 2
		const p1 = channel === 'RED' ? 1 : channel === 'GREEN' ? 2 : 0
		const p2 = channel === 'RED' ? 2 : channel === 'GREEN' ? 0 : 1

		const { raw } = image
		const algorithm = SCNR_ALGORITHMS[method]
		const n = raw.length

		for (let i = 0; i < n; i += 3) {
			const k = i + p0
			const a = raw[k]
			const b = raw[i + p1]
			const c = raw[i + p2]
			raw[k] = algorithm(a, b, c, amount)
		}
	}

	return image
}
