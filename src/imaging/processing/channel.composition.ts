import { medianAbsoluteDeviationOf, medianOf } from '../../math/numerical/statistics'
import type { ImageRawType } from '../model/types'
import { MIN_GLOBAL_NORMALIZATION_SAMPLES, NORMALIZATION_SAMPLE_LIMIT, solveGlobalNormalization } from './normalization'

// Linear multichannel composition of registered mono masters into RGB. A master is a source identity
// (a filter such as Ha, OIII, or L), never an output channel: a mix assigns weighted masters to red,
// green, and blue, so one master can drive several channels (HOO) or none. An optional luminance master
// is blended afterwards into the luminance of the mixed RGB with one common gain per pixel, which keeps
// channel ratios. Everything stays linear: nothing is clipped, stretched, or rescaled per image, and
// pixels without support are NaN with a cleared validity byte. Planes are processed as strips of
// consecutive row-major pixels of one common grid, so callers bound their memory by the strip height;
// RGB output is interleaved. Samples are in the masters' own linear units.

// Output channel of an RGB composition.
export type CompositionChannel = 'red' | 'green' | 'blue'

// Output channels in interleaved order.
const CHANNELS: readonly CompositionChannel[] = ['red', 'green', 'blue']

// BT.709 luminance coefficients of linear red, green, and blue; they sum to 1.
export const BT709_LUMINANCE: readonly [number, number, number] = [0.2126, 0.7152, 0.0722]

// Default number of robust standard deviations of the mixed luminance below which a pixel is too close
// to zero for a ratio, so the luminance blend adds its difference instead of scaling.
export const DEFAULT_LUMINANCE_FLOOR_SIGMAS = 3

// Strip of one registered mono master and the linear correction applied before mixing.
export interface CompositionPlane {
	// Samples of the strip's pixels, row-major.
	readonly raw: ArrayLike<number>
	// One byte per pixel, nonzero where the master has support.
	readonly valid: ArrayLike<number>
	// Multiplier applied to every sample; finite and positive.
	readonly gain: number
	// Value added after the gain, in the master's units; finite.
	readonly offset: number
}

// Contribution of one plane, by index, to an output channel, with a non-negative unitless weight.
export interface ChannelTerm {
	readonly plane: number
	readonly weight: number
}

// Weighted plane contributions of each output channel.
export interface ChannelMix {
	readonly red: readonly ChannelTerm[]
	readonly green: readonly ChannelTerm[]
	readonly blue: readonly ChannelTerm[]
}

// Reason a mix or a plane correction cannot produce a meaningful composition.
export type ChannelMixIssueCode = 'emptyChannel' | 'invalidWeight' | 'unknownPlane' | 'invalidGain' | 'invalidOffset'

// One problem of a mix, with the channel and plane it concerns when it has them.
export interface ChannelMixIssue {
	readonly code: ChannelMixIssueCode
	readonly channel?: CompositionChannel
	readonly plane?: number
}

// Running counts of a composition over every strip, in pixels.
export interface CompositionCounters {
	// Pixels with all three channels finite.
	valid: number
	// Pixels missing support of a contributing plane, or of the luminance master.
	unsupported: number
	// Pixels whose finite inputs produced a non-finite result.
	nonFinite: number
	// Pixels whose luminance was blended additively because a ratio was ill-conditioned there.
	luminanceFallback: number
}

// Mode of matching the luminance master to the mixed luminance before blending.
export type LuminanceMatchMode = 'off' | 'robustLinear'

// Paired samples of the mixed luminance and the corrected luminance master, taken at a fixed stride of
// the composed pixels so every strip contributes in proportion; the stride keeps at most
// NORMALIZATION_SAMPLE_LIMIT pairs.
export interface LuminanceSamples {
	// Pixels between two samples.
	readonly stride: number
	// Index of the next composed pixel.
	position: number
	readonly rgb: number[]
	readonly luminance: number[]
}

// Linear map `matched = scale · L + offset` taking the corrected luminance master to the mixed luminance,
// and the luminance floor of the blend, both in the mixed RGB units.
export interface LuminanceMatch {
	readonly scale: number
	readonly offset: number
	// Whether the map was fitted; false for mode off or fewer than MIN_GLOBAL_NORMALIZATION_SAMPLES pairs, then identity.
	readonly matched: boolean
	// Number of sample pairs used.
	readonly samples: number
	// Mixed luminance at or below which a ratio is ill-conditioned; non-negative.
	readonly floor: number
}

// Returns every problem of a mix over planes with these corrections; an empty list means composable.
// A channel needs at least one term of positive weight; weights must be finite and non-negative; terms
// must name an existing plane; a used plane needs a finite positive gain and a finite offset.
export function validateChannelMix(mix: ChannelMix, planes: readonly Pick<CompositionPlane, 'gain' | 'offset'>[]): ChannelMixIssue[] {
	const issues: ChannelMixIssue[] = []
	const used = new Set<number>()

	for (const channel of CHANNELS) {
		let positive = false

		for (const { plane, weight } of mix[channel]) {
			if (!Number.isInteger(plane) || plane < 0 || plane >= planes.length) issues.push({ code: 'unknownPlane', channel, plane })
			else if (!(Number.isFinite(weight) && weight >= 0)) issues.push({ code: 'invalidWeight', channel, plane })
			else if (weight > 0) {
				positive = true
				used.add(plane)
			}
		}

		if (!positive) issues.push({ code: 'emptyChannel', channel })
	}

	for (const plane of used) {
		if (!(Number.isFinite(planes[plane].gain) && planes[plane].gain > 0)) issues.push({ code: 'invalidGain', plane })
		if (!Number.isFinite(planes[plane].offset)) issues.push({ code: 'invalidOffset', plane })
	}

	return issues
}

// Creates zeroed counters.
export function createCompositionCounters(): CompositionCounters {
	return { valid: 0, unsupported: 0, nonFinite: 0, luminanceFallback: 0 }
}

// Mixes `pixels` pixels of the planes into interleaved RGB. Each channel is the weighted mean of its
// corrected terms, Σ w·(gain·x + offset) / Σ w, with a denominator fixed by the mix, so the color of a
// pixel never depends on which planes happen to cover it. A pixel is valid only where every plane with
// a positive weight in any channel is valid; elsewhere `rgb` holds NaN and `rgbValid` 0. The mix must
// pass validateChannelMix. Updates `counters`.
export function mixChannelRows(planes: readonly CompositionPlane[], mix: ChannelMix, pixels: number, rgb: ImageRawType, rgbValid: Uint8Array, counters: CompositionCounters) {
	const terms = CHANNELS.map((channel) => mix[channel].filter((term) => term.weight > 0))
	const denominators = terms.map((list) => list.reduce((sum, term) => sum + term.weight, 0))
	const required = [...new Set(terms.flat().map((term) => term.plane))]

	for (let pixel = 0, out = 0; pixel < pixels; pixel++, out += 3) {
		let supported = true

		for (let i = 0; i < required.length; i++) {
			const plane = planes[required[i]]
			if (plane.valid[pixel] === 0 || !Number.isFinite(plane.raw[pixel])) {
				supported = false
				break
			}
		}

		if (!supported) {
			rgb[out] = rgb[out + 1] = rgb[out + 2] = Number.NaN
			rgbValid[pixel] = 0
			counters.unsupported++
			continue
		}

		let finite = true

		for (let channel = 0; channel < 3; channel++) {
			const list = terms[channel]
			let sum = 0

			for (let i = 0; i < list.length; i++) {
				const plane = planes[list[i].plane]
				sum += list[i].weight * (plane.gain * plane.raw[pixel] + plane.offset)
			}

			const value = sum / denominators[channel]
			rgb[out + channel] = value
			if (!Number.isFinite(value)) finite = false
		}

		if (finite) {
			rgbValid[pixel] = 1
			counters.valid++
		} else {
			rgb[out] = rgb[out + 1] = rgb[out + 2] = Number.NaN
			rgbValid[pixel] = 0
			counters.nonFinite++
		}
	}
}

// Creates an empty sample set for a composition of `totalPixels` pixels.
export function createLuminanceSamples(totalPixels: number): LuminanceSamples {
	return { stride: Math.max(1, Math.ceil(totalPixels / NORMALIZATION_SAMPLE_LIMIT)), position: 0, rgb: [], luminance: [] }
}

// Samples the next `pixels` composed pixels: at every stride position where the mixed RGB and the
// luminance master are both valid and finite, records the BT.709 luminance and the corrected master.
// Advances `samples.position` by `pixels`.
export function collectLuminanceSamples(samples: LuminanceSamples, rgb: Readonly<ImageRawType>, rgbValid: Readonly<Uint8Array>, luminance: CompositionPlane, pixels: number) {
	const { stride } = samples
	const start = samples.position
	let pixel = (stride - (start % stride)) % stride

	for (; pixel < pixels; pixel += stride) {
		if (rgbValid[pixel] === 0 || luminance.valid[pixel] === 0) continue
		const value = luminance.gain * luminance.raw[pixel] + luminance.offset
		if (!Number.isFinite(value)) continue
		const out = pixel * 3
		samples.rgb.push(BT709_LUMINANCE[0] * rgb[out] + BT709_LUMINANCE[1] * rgb[out + 1] + BT709_LUMINANCE[2] * rgb[out + 2])
		samples.luminance.push(value)
	}

	samples.position = start + pixels
}

// Fits the luminance match and floor from collected samples. robustLinear matches the background
// (25th percentile) and the 25th–75th percentile span of both distributions, a quantile match that
// tolerates residual misregistration; off, or too few pairs, keeps the identity. The floor is
// `floorSigmas` times the robust (normalized MAD) dispersion of the mixed luminance samples.
export function solveLuminanceMatch(samples: LuminanceSamples, mode: LuminanceMatchMode, floorSigmas: number = DEFAULT_LUMINANCE_FLOOR_SIGMAS): LuminanceMatch {
	const count = samples.rgb.length
	let floor = 0

	if (count > 0) {
		const sorted = Float64Array.from(samples.rgb).sort()
		floor = floorSigmas * medianAbsoluteDeviationOf(sorted, medianOf(sorted), true)
	}

	if (mode === 'off' || count < MIN_GLOBAL_NORMALIZATION_SAMPLES) return { scale: 1, offset: 0, matched: false, samples: count, floor }
	const { scale, offset } = solveGlobalNormalization(samples.rgb, samples.luminance, 'background-scale')
	return { scale, offset, matched: true, samples: count, floor }
}

// Blends the luminance master into `pixels` mixed RGB pixels in place. With Y the BT.709 luminance,
// L' = gain·L + offset the corrected master, and M = match.scale·L' + match.offset, the target is
// Yt = (1 − alpha)·Y + alpha·M, alpha in [0, 1]. Where Y is above the floor and Yt positive, the three channels are multiplied by Yt/Y,
// which keeps their ratios; elsewhere Yt − Y is added to each channel, which reaches Yt without an
// unstable ratio and keeps neutral pixels neutral (counted as luminanceFallback). alpha 0 leaves `rgb`
// untouched. A pixel the luminance master does not support becomes NaN and invalid.
export function blendLuminanceRows(rgb: ImageRawType, rgbValid: Uint8Array, luminance: CompositionPlane, match: LuminanceMatch, alpha: number, pixels: number, counters: CompositionCounters) {
	if (alpha === 0) return

	const [cr, cg, cb] = BT709_LUMINANCE

	for (let pixel = 0, out = 0; pixel < pixels; pixel++, out += 3) {
		if (rgbValid[pixel] === 0) continue

		const corrected = luminance.gain * luminance.raw[pixel] + luminance.offset

		if (luminance.valid[pixel] === 0 || !Number.isFinite(corrected)) {
			rgb[out] = rgb[out + 1] = rgb[out + 2] = Number.NaN
			rgbValid[pixel] = 0
			counters.valid--
			counters.unsupported++
			continue
		}

		const y = cr * rgb[out] + cg * rgb[out + 1] + cb * rgb[out + 2]
		const target = (1 - alpha) * y + alpha * (match.scale * corrected + match.offset)

		if (y > match.floor && target > 0) {
			const gain = target / y
			rgb[out] *= gain
			rgb[out + 1] *= gain
			rgb[out + 2] *= gain
		} else {
			const delta = target - y
			rgb[out] += delta
			rgb[out + 1] += delta
			rgb[out + 2] += delta
			counters.luminanceFallback++
		}

		if (!(Number.isFinite(rgb[out]) && Number.isFinite(rgb[out + 1]) && Number.isFinite(rgb[out + 2]))) {
			rgb[out] = rgb[out + 1] = rgb[out + 2] = Number.NaN
			rgbValid[pixel] = 0
			counters.valid--
			counters.nonFinite++
		}
	}
}
