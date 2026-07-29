import { PI } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { ImageRawType } from '../model/types'
import { colorIndexToRgbWeights } from './generator'

// Options controlling three additive Bahtinov diffraction spikes on an existing image.
export interface PlotBahtinovSpikesOptions {
	// Normal angles of the three spikes in radians; each is canonicalized modulo PI.
	readonly normalAngles?: readonly [Angle, Angle, Angle]
	// Index of the central spike whose normal distance receives `error`.
	readonly central?: 0 | 1 | 2
	// Transverse full width at half maximum in pixels.
	readonly fwhm?: number
	// Nominal half-length of every spike in pixels.
	readonly halfLength?: number
	// Length of the smooth fade at each longitudinal end in pixels.
	readonly taperLength?: number
	// Non-negative relative integrated strengths of the three spikes.
	readonly strengths?: readonly [number, number, number]
	// Multiplicative gain applied to the requested integrated flux.
	readonly gain?: number
	// Transverse Gaussian cutoff in sigma units.
	readonly cutoffSigma?: number
	// Gamma applied to RGB color weights, or false to skip compensation.
	readonly gammaCompensation?: number | false
}

// sqrt(2 ln 2): half-width-at-half-maximum factor relating FWHM and Gaussian sigma.
const SQRT_TWO_LN_TWO = 1.1774100225154747
// Default symmetric normal angles for a simple three-spike Bahtinov pattern.
const DEFAULT_BAHTINOV_NORMAL_ANGLES: readonly [Angle, Angle, Angle] = [PI / 12, 0, (PI * 11) / 12]
// Default central-spike index in `DEFAULT_BAHTINOV_NORMAL_ANGLES`.
const DEFAULT_BAHTINOV_CENTRAL = 1
// Default transverse spike width in pixels.
const DEFAULT_BAHTINOV_FWHM = 2
// Default nominal half-length of each spike in pixels.
const DEFAULT_BAHTINOV_HALF_LENGTH = 60
// Default longitudinal fade length at each spike end in pixels.
const DEFAULT_BAHTINOV_TAPER_LENGTH = 12
// Default equal integrated strength assigned to the three spikes.
const DEFAULT_BAHTINOV_STRENGTHS: readonly [number, number, number] = [1, 1, 1]
// Default transverse Gaussian cutoff in sigma units.
const DEFAULT_BAHTINOV_CUTOFF_SIGMA = 4
// Largest finite value representable by a Float32Array sample.
const MAX_FLOAT32 = 3.4028234663852886e38

// Adds only three Bahtinov diffraction spikes to an existing mono or interleaved RGB buffer.
//
// `(x, y)` is the external-line intersection in image pixels, `flux` is nominal integrated signal,
// and `error` is the signed central-line offset in pixels recovered by the analyzer convention. The
// buffer is mutated additively without background generation, noise, clipping, or saturation.
export function plotBahtinovSpikes(raw: ImageRawType, width: number, height: number, channels: 1 | 3, x: number, y: number, flux: number, error: number, colorIndex?: number, options: PlotBahtinovSpikesOptions = {}): boolean {
	if (!Number.isInteger(width) || width <= 0) throw new RangeError('width must be a positive integer')
	if (!Number.isInteger(height) || height <= 0) throw new RangeError('height must be a positive integer')
	if (channels !== 1 && channels !== 3) throw new RangeError('channels must be 1 or 3')
	const expectedLength = width * height * channels
	if (raw.length < expectedLength) throw new RangeError(`buffer length mismatch: expected ${expectedLength}, received ${raw.length}`)
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(flux) || flux <= 0) return false
	if (!Number.isFinite(error)) throw new RangeError('error must be finite')

	const normalAngles = options.normalAngles ?? DEFAULT_BAHTINOV_NORMAL_ANGLES
	const central = options.central ?? DEFAULT_BAHTINOV_CENTRAL
	const fwhm = options.fwhm ?? DEFAULT_BAHTINOV_FWHM
	const halfLength = options.halfLength ?? DEFAULT_BAHTINOV_HALF_LENGTH
	const taperLength = options.taperLength ?? DEFAULT_BAHTINOV_TAPER_LENGTH
	const strengths = options.strengths ?? DEFAULT_BAHTINOV_STRENGTHS
	const gain = options.gain ?? 1
	const cutoffSigma = options.cutoffSigma ?? DEFAULT_BAHTINOV_CUTOFF_SIGMA
	validateBahtinovSpikeOptions(normalAngles, central, fwhm, halfLength, taperLength, strengths, gain, cutoffSigma, options.gammaCompensation)

	const totalFlux = flux * gain
	if (!Number.isFinite(totalFlux) || totalFlux <= 0) return false
	const strengthSum = strengths[0] + strengths[1] + strengths[2]
	if (!(strengthSum > 0) || !Number.isFinite(strengthSum)) throw new RangeError('at least one finite Bahtinov strength must be positive')

	const sigma = fwhm / (2 * SQRT_TWO_LN_TWO)
	const cutoffDistance = sigma * cutoffSigma
	const maximumSample = raw instanceof Float32Array ? MAX_FLOAT32 : Number.MAX_VALUE
	let redWeight = 1
	let greenWeight = 1
	let blueWeight = 1
	if (channels === 3) [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(colorIndex, options.gammaCompensation)

	let rendered = false
	for (let index = 0; index < 3; index++) {
		const relativeStrength = strengths[index] / strengthSum
		if (relativeStrength <= 0) continue
		const angle = canonicalBahtinovNormalAngle(normalAngles[index])
		const normalX = Math.cos(angle)
		const normalY = Math.sin(angle)
		const tangentX = -normalY
		const tangentY = normalX
		const distance = x * normalX + y * normalY - (index === central ? error : 0)
		const normalization = bahtinovSpikeDiscreteSum(x, y, normalX, normalY, tangentX, tangentY, distance, sigma, cutoffDistance, halfLength, taperLength)
		if (!(normalization > 0) || !Number.isFinite(normalization)) continue
		const amplitude = (totalFlux * relativeStrength) / normalization
		if (!(amplitude > 0) || !Number.isFinite(amplitude)) continue

		const centerX = x - (index === central ? error * normalX : 0)
		const centerY = y - (index === central ? error * normalY : 0)
		const extentX = Math.abs(tangentX) * halfLength + Math.abs(normalX) * cutoffDistance
		const extentY = Math.abs(tangentY) * halfLength + Math.abs(normalY) * cutoffDistance
		const minimumX = Math.max(0, Math.floor(centerX - extentX))
		const maximumX = Math.min(width - 1, Math.ceil(centerX + extentX))
		const minimumY = Math.max(0, Math.floor(centerY - extentY))
		const maximumY = Math.min(height - 1, Math.ceil(centerY + extentY))
		if (minimumX > maximumX || minimumY > maximumY) continue

		const inverseTwoSigmaSquared = 0.5 / (sigma * sigma)
		for (let sampleY = minimumY; sampleY <= maximumY; sampleY++) {
			const row = sampleY * width
			for (let sampleX = minimumX; sampleX <= maximumX; sampleX++) {
				const orthogonalDistance = sampleX * normalX + sampleY * normalY - distance
				if (Math.abs(orthogonalDistance) > cutoffDistance) continue
				const longitudinalDistance = (sampleX - x) * tangentX + (sampleY - y) * tangentY
				const longitudinalWeight = bahtinovLongitudinalWeight(Math.abs(longitudinalDistance), halfLength, taperLength)
				if (longitudinalWeight <= 0) continue
				const signal = amplitude * Math.exp(-(orthogonalDistance * orthogonalDistance) * inverseTwoSigmaSquared) * longitudinalWeight
				if (!(signal > 0) || !Number.isFinite(signal)) continue

				const pixel = (row + sampleX) * channels
				if (channels === 1) {
					addFiniteSample(raw, pixel, signal, maximumSample)
				} else {
					addFiniteSample(raw, pixel, signal * redWeight, maximumSample)
					addFiniteSample(raw, pixel + 1, signal * greenWeight, maximumSample)
					addFiniteSample(raw, pixel + 2, signal * blueWeight, maximumSample)
				}
				rendered = true
			}
		}
	}

	return rendered
}

// Computes nominal discrete support so image-edge clipping never renormalizes visible brightness.
function bahtinovSpikeDiscreteSum(x: number, y: number, normalX: number, normalY: number, tangentX: number, tangentY: number, distance: number, sigma: number, cutoffDistance: number, halfLength: number, taperLength: number): number {
	const centerX = x - (x * normalX + y * normalY - distance) * normalX
	const centerY = y - (x * normalX + y * normalY - distance) * normalY
	const extentX = Math.abs(tangentX) * halfLength + Math.abs(normalX) * cutoffDistance
	const extentY = Math.abs(tangentY) * halfLength + Math.abs(normalY) * cutoffDistance
	const minimumX = Math.floor(centerX - extentX)
	const maximumX = Math.ceil(centerX + extentX)
	const minimumY = Math.floor(centerY - extentY)
	const maximumY = Math.ceil(centerY + extentY)
	const inverseTwoSigmaSquared = 0.5 / (sigma * sigma)
	let sum = 0

	for (let sampleY = minimumY; sampleY <= maximumY; sampleY++) {
		for (let sampleX = minimumX; sampleX <= maximumX; sampleX++) {
			const orthogonalDistance = sampleX * normalX + sampleY * normalY - distance
			if (Math.abs(orthogonalDistance) > cutoffDistance) continue
			const longitudinalDistance = (sampleX - x) * tangentX + (sampleY - y) * tangentY
			const longitudinalWeight = bahtinovLongitudinalWeight(Math.abs(longitudinalDistance), halfLength, taperLength)
			if (longitudinalWeight <= 0) continue
			sum += Math.exp(-(orthogonalDistance * orthogonalDistance) * inverseTwoSigmaSquared) * longitudinalWeight
		}
	}

	return sum
}

// Evaluates a unit plateau with a smoothstep fade over the final longitudinal taper.
function bahtinovLongitudinalWeight(absoluteDistance: number, halfLength: number, taperLength: number): number {
	if (absoluteDistance >= halfLength) return 0
	if (taperLength <= 0 || absoluteDistance <= halfLength - taperLength) return 1
	const unit = (halfLength - absoluteDistance) / taperLength
	return unit * unit * (3 - 2 * unit)
}

// Canonicalizes a finite normal angle to `[0, PI)`.
function canonicalBahtinovNormalAngle(angle: Angle): Angle {
	let canonical = angle % PI
	if (canonical < 0) canonical += PI
	return canonical
}

// Adds one finite positive signal without allowing typed-array overflow to become non-finite.
function addFiniteSample(raw: ImageRawType, index: number, signal: number, maximumSample: number): void {
	const current = raw[index]
	if (!Number.isFinite(current)) return
	raw[index] = Math.min(maximumSample, current + signal)
}

// Validates Bahtinov spike geometry and visual options before mutating the destination buffer.
function validateBahtinovSpikeOptions(normalAngles: readonly [Angle, Angle, Angle], central: number, fwhm: number, halfLength: number, taperLength: number, strengths: readonly [number, number, number], gain: number, cutoffSigma: number, gammaCompensation: number | false | undefined): void {
	if (central !== 0 && central !== 1 && central !== 2) throw new RangeError('central must be 0, 1, or 2')
	for (let index = 0; index < 3; index++) {
		if (!Number.isFinite(normalAngles[index])) throw new RangeError('Bahtinov normal angles must be finite')
		if (!Number.isFinite(strengths[index]) || strengths[index] < 0) throw new RangeError('Bahtinov strengths must be finite and non-negative')
	}
	if (!Number.isFinite(fwhm) || fwhm <= 0) throw new RangeError('fwhm must be finite and positive')
	if (!Number.isFinite(halfLength) || halfLength <= 0) throw new RangeError('halfLength must be finite and positive')
	if (!Number.isFinite(taperLength) || taperLength < 0 || taperLength > halfLength) throw new RangeError('taperLength must be finite and between 0 and halfLength')
	if (!Number.isFinite(gain) || gain <= 0) throw new RangeError('gain must be finite and positive')
	if (!Number.isFinite(cutoffSigma) || cutoffSigma <= 0) throw new RangeError('cutoffSigma must be finite and positive')
	if (gammaCompensation !== undefined && gammaCompensation !== false && (!Number.isFinite(gammaCompensation) || gammaCompensation <= 0)) throw new RangeError('gammaCompensation must be false or finite and positive')
}
