import { PI, PIOVERTWO, TAU } from 'nebulosa/src/core/constants'
import { type FFT2DWorkspace, fft2DWorkspace, fftComplex2D } from '../../../math/numerical/fft'
import { medianAbsoluteDeviationOf, medianBySelectionOf } from '../../../math/numerical/statistics'

// Translation-registration primitives for extended-scene tracking: robust sample normalization, Hann
// windowing, FFT phase correlation with Guizar-Sicairos localized-DFT subpixel refinement, masked
// zero-mean normalized cross-correlation (ZNCC) with a 2D quadratic peak, and optional translation-only
// ECC refinement (Evangelidis & Psarakis 2008, OpenCV-compatible update rule).
//
// Planes are dense row-major grids in analysis samples with origin at the upper left, +X right and +Y
// down. A translation [dx, dy] means a reference sample at (x, y) appears at (x + dx, y + dy) in the
// current plane. Callers convert sample units to image pixels (for example by a CFA plane step).
// Functions write only caller-owned outputs, workspaces or scratch; correlation sums use Float64.

// Floating-point sample storage accepted by the registration primitives.
export type RegistrationSamples = Float32Array | Float64Array

// Dense row-major analysis plane. Masked samples are excluded from every statistic and correlation.
export interface RegistrationPlane {
	// Number of samples along X.
	readonly width: number
	// Number of samples along Y.
	readonly height: number
	// Row-major samples with at least width·height entries.
	readonly data: RegistrationSamples
	// Optional row-major exclusion flags; any nonzero value marks a masked sample.
	readonly mask?: Uint8Array
}

// Cross-power normalization: 'phase' whitens every frequency (gain-tolerant, noise-sensitive); 'none'
// keeps amplitude weighting (plain cross-correlation, better at low SNR).
export type CorrelationNormalization = 'phase' | 'none'

// Stable rejection reasons shared with tracker diagnostics.
export type RegistrationRejection = 'lowContrast' | 'masked' | 'insufficientOverlap' | 'correlationLow' | 'correlationAmbiguous' | 'shiftOutOfRange' | 'subpixelDegenerate'

// Failed registration with a stable reason.
export interface RegistrationFailure {
	// Discriminant for failed registration.
	readonly success: false
	// Stable rejection reason.
	readonly reason: RegistrationRejection
}

// Robust location and scale used to normalize registration samples.
export interface RobustNormalization {
	// Median of the unmasked samples, in input units; NaN when nothing is valid.
	readonly location: number
	// Gaussian-equivalent MAD of the unmasked samples, in input units; zero when unresolved.
	readonly scale: number
	// Number of unmasked finite samples.
	readonly validCount: number
}

// Options for phase correlation.
export interface PhaseCorrelationOptions {
	// Largest accepted per-axis translation, in samples. Defaults to the workspace capacity.
	readonly maximumShift?: number
	// Localized-DFT upsampling factor; 1 disables subpixel refinement. Defaults to 20 (0.05 sample).
	readonly upsampleFactor?: number
	// Cross-power normalization. Defaults to 'phase'.
	readonly normalization?: CorrelationNormalization
	// Half-width in samples of the square excluded around the peak for PSR/second-peak. Defaults to 3.
	readonly sidelobeExclusionRadius?: number
	// Minimum accepted peak-to-sidelobe ratio. Defaults to 6.
	readonly minimumPeakToSidelobeRatio?: number
	// Maximum accepted secondary-peak/peak ratio; larger values indicate repeated texture. Defaults to 0.8.
	readonly maximumSecondPeakRatio?: number
}

// Successful phase-correlation measurement.
export interface PhaseCorrelationResult {
	// Discriminant for a successful registration.
	readonly success: true
	// Measured translation [dx, dy] in samples.
	readonly translation: readonly [number, number]
	// Normalized correlation peak in [0, 1] at the refined translation.
	readonly peak: number
	// (peak - sidelobe mean) / sidelobe standard deviation on the integer correlation surface.
	readonly peakToSidelobeRatio: number
	// Largest distinct local maximum outside the exclusion window divided by the peak, in [0, 1].
	readonly secondPeakRatio: number
	// Guizar-Sicairos normalized registration error sqrt(1 - peak²), in [0, 1].
	readonly error?: number
	// Whether the localized-DFT refinement found an interior subpixel peak.
	readonly refined: boolean
}

// Phase-correlation outcome.
export type PhaseCorrelationOutcome = PhaseCorrelationResult | RegistrationFailure

// Forward spectrum of one windowed, zero-padded plane, reusable as a cached reference.
export interface PhaseCorrelationSpectrum {
	// Padded FFT width.
	readonly width: number
	// Padded FFT height.
	readonly height: number
	// Real spectrum parts, row-major.
	readonly real: Float64Array
	// Imaginary spectrum parts, row-major.
	readonly imaginary: Float64Array
	// Spectral energy Σ|F|² (N times the windowed sample energy by Parseval).
	readonly energy: number
	// Number of unmasked input samples.
	readonly validCount: number
}

// Options for bounded masked ZNCC patch search.
export interface ZNCCSearchOptions {
	// Integer per-axis search radius around the predicted displacement, in samples.
	readonly searchRadius: number
	// Minimum fraction of valid template samples overlapping valid current samples. Defaults to 0.6.
	readonly minimumOverlap?: number
	// Minimum accepted peak ZNCC. Defaults to 0.5.
	readonly minimumCorrelation?: number
	// Maximum accepted secondary local maximum / peak. Defaults to 0.9.
	readonly maximumSecondPeakRatio?: number
	// Half-width of the square excluded around the peak for PSR/second-peak, in samples. Defaults to 2.
	readonly sidelobeExclusionRadius?: number
}

// Successful ZNCC patch match.
export interface ZNCCMatch {
	// Discriminant for a successful registration.
	readonly success: true
	// Template-to-current translation [dx, dy] in samples, including the predicted displacement.
	readonly translation: readonly [number, number]
	// Peak ZNCC at the best integer displacement, in [-1, 1].
	readonly correlation: number
	// (peak - sidelobe mean) / sidelobe standard deviation of the search surface, capped at 1000.
	readonly peakToSidelobeRatio: number
	// Largest distinct interior local maximum outside the exclusion window divided by the peak.
	readonly secondPeakRatio: number
	// Valid overlap at the peak as a fraction of valid template samples, in [0, 1].
	readonly overlapFraction: number
	// Heuristic 1-sigma position uncertainty in samples from peak decorrelation and curvature.
	readonly uncertainty: number
}

// ZNCC patch-search outcome.
export type ZNCCOutcome = ZNCCMatch | RegistrationFailure

// Options for translation-only ECC refinement.
export interface ECCRefinementOptions {
	// Maximum Gauss-Newton iterations. Defaults to 30.
	readonly maximumIterations?: number
	// Convergence threshold on the update norm, in samples. Defaults to 1e-3.
	readonly tolerance?: number
	// Largest accepted distance from the initial translation, in samples. Defaults to 1.5.
	readonly maximumCorrection?: number
}

// Successful ECC refinement.
export interface ECCRefinement {
	// Discriminant for a successful refinement.
	readonly success: true
	// Refined translation [dx, dy] in samples.
	readonly translation: readonly [number, number]
	// Final enhanced correlation coefficient in [-1, 1].
	readonly correlation: number
	// Iterations performed.
	readonly iterations: number
}

// ECC outcome; failures mean the caller should keep its initialization.
export type ECCOutcome = ECCRefinement | { readonly success: false }

// Maximum reported peak-to-sidelobe ratio, preventing infinite output on a perfectly flat sidelobe.
const MAXIMUM_PEAK_TO_SIDELOBE_RATIO = 1000

// Cross-power magnitude, relative to its maximum, below which phase normalization stops whitening.
const PHASE_MAGNITUDE_FLOOR = 1e-3

// Writes (sample - median) / scale for unmasked finite samples and zero elsewhere. The median and
// Gaussian-equivalent MAD are estimated from a deterministic stride subsample that fits in scratch.
// When MAD vanishes the mean absolute deviation is used; scale is zero when no spread exists, and
// then out holds only median-centered samples. data and out may alias.
export function normalizeRegistrationSamples(data: Readonly<RegistrationSamples>, mask: Readonly<Uint8Array> | undefined, count: number, out: RegistrationSamples, scratch: Float64Array): RobustNormalization {
	const stride = Math.max(1, Math.ceil(count / scratch.length))
	let sampled = 0
	let validCount = 0

	for (let i = 0; i < count; i++) {
		const value = data[i]
		if ((mask !== undefined && mask[i] !== 0) || !Number.isFinite(value)) continue
		if (validCount++ % stride === 0 && sampled < scratch.length) scratch[sampled++] = value
	}

	if (sampled === 0) {
		out.fill(0, 0, count)
		return { location: Number.NaN, scale: 0, validCount: 0 }
	}

	const location = medianBySelectionOf(scratch, sampled)
	let scale = medianAbsoluteDeviationOf(scratch, location, true, sampled, scratch)

	if (!(scale > 0)) {
		let sum = 0
		for (let i = 0; i < count; i++) if ((mask === undefined || mask[i] === 0) && Number.isFinite(data[i])) sum += Math.abs(data[i] - location)
		scale = validCount > 0 ? (sum / validCount) * Math.sqrt(PIOVERTWO) : 0
	}

	const inverse = scale > 0 ? 1 / scale : 1

	for (let i = 0; i < count; i++) {
		const value = data[i]
		out[i] = (mask !== undefined && mask[i] !== 0) || !Number.isFinite(value) ? 0 : (value - location) * inverse
	}

	return { location, scale, validCount }
}

// Removes the least-squares plane a + b·x + c·y fitted to unmasked samples, in place. Masked samples
// are left unchanged. Returns false when fewer than three non-collinear unmasked samples exist.
export function removeLinearTrend(plane: RegistrationPlane): boolean {
	const { width, height, data, mask } = plane
	const cx = (width - 1) * 0.5
	const cy = (height - 1) * 0.5
	let n = 0
	let sx = 0
	let sy = 0
	let sxx = 0
	let syy = 0
	let sxy = 0
	let sz = 0
	let sxz = 0
	let syz = 0

	for (let y = 0, i = 0; y < height; y++) {
		const dy = y - cy

		for (let x = 0; x < width; x++, i++) {
			if (mask !== undefined && mask[i] !== 0) continue
			const dx = x - cx
			const z = data[i]
			n++
			sx += dx
			sy += dy
			sxx += dx * dx
			syy += dy * dy
			sxy += dx * dy
			sz += z
			sxz += dx * z
			syz += dy * z
		}
	}

	// Cramer's rule on the symmetric 3x3 normal equations [n sx sy; sx sxx sxy; sy sxy syy].
	const determinant = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy)
	if (n < 3 || !(Math.abs(determinant) > 1e-12 * Math.max(1, n * sxx * syy))) return false
	const a = (sz * (sxx * syy - sxy * sxy) - sx * (sxz * syy - sxy * syz) + sy * (sxz * sxy - sxx * syz)) / determinant
	const b = (n * (sxz * syy - sxy * syz) - sz * (sx * syy - sxy * sy) + sy * (sx * syz - sxz * sy)) / determinant
	const c = (n * (sxx * syz - sxz * sxy) - sx * (sx * syz - sxz * sy) + sz * (sx * sxy - sxx * sy)) / determinant

	for (let y = 0, i = 0; y < height; y++) {
		const base = a + c * (y - cy)

		for (let x = 0; x < width; x++, i++) {
			if (mask === undefined || mask[i] === 0) data[i] -= base + b * (x - cx)
		}
	}

	return true
}

// Fills out with a symmetric Hann window sin²(π(i + 0.5)/size), which is positive at both ends.
// Allocates when out is omitted; returns out.
export function hannWindow(size: number, out: Float64Array = new Float64Array(size)) {
	const scale = PI / size

	for (let i = 0; i < size; i++) {
		const s = Math.sin((i + 0.5) * scale)
		out[i] = s * s
	}

	return out
}

// Reusable buffers for phase correlation of planes with fixed source dimensions. The padded FFT grid
// holds the source plus maximumShift on each axis so accepted shifts cannot alias through cyclic wrap.
export class PhaseCorrelationWorkspace {
	// Source plane width in samples.
	readonly width: number
	// Source plane height in samples.
	readonly height: number
	// Largest per-axis shift representable without wrap ambiguity, in samples.
	readonly maximumShift: number
	// Padded complex FFT buffers.
	readonly fft: FFT2DWorkspace
	// Cross-power spectrum real parts retained for localized-DFT refinement.
	readonly crossReal: Float64Array
	// Cross-power spectrum imaginary parts retained for localized-DFT refinement.
	readonly crossImaginary: Float64Array
	// Hann window along X with source width.
	readonly windowX: Float64Array
	// Hann window along Y with source height.
	readonly windowY: Float64Array

	// Lazily sized localized-DFT scratch; grows only when a larger upsample factor is requested.
	#upsample?: { readonly samples: number; readonly rowReal: Float64Array; readonly rowImaginary: Float64Array; readonly kernelX: Float64Array; readonly kernelY: Float64Array }

	// Allocates buffers for width×height planes with shifts up to maximumShift samples per axis.
	constructor(width: number, height: number, maximumShift: number) {
		this.width = width
		this.height = height
		this.maximumShift = Math.max(0, Math.floor(maximumShift))
		this.fft = fft2DWorkspace(width + this.maximumShift, height + this.maximumShift)
		this.crossReal = new Float64Array(this.fft.real.length)
		this.crossImaginary = new Float64Array(this.fft.real.length)
		this.windowX = hannWindow(width)
		this.windowY = hannWindow(height)
	}

	// Returns localized-DFT scratch for an n-sample upsampled window, reallocating only when it grows.
	upsampleScratch(samples: number) {
		if (this.#upsample === undefined || this.#upsample.samples < samples) {
			const { width, height } = this.fft
			this.#upsample = { samples, rowReal: new Float64Array(height * samples), rowImaginary: new Float64Array(height * samples), kernelX: new Float64Array(width * samples * 2), kernelY: new Float64Array(height * samples * 2) }
		}

		return this.#upsample
	}
}

// Computes the forward spectrum of a plane after removing its window-weighted mean, applying the
// workspace Hann window and zero-padding. Writes into out when given (reallocating mismatched
// buffers) and returns a fresh descriptor sharing out buffers, otherwise allocates. The plane must
// match the workspace source dimensions.
export function phaseCorrelationSpectrum(plane: RegistrationPlane, workspace: PhaseCorrelationWorkspace, out?: PhaseCorrelationSpectrum): PhaseCorrelationSpectrum {
	const { width, height, data, mask } = plane
	const { windowX, windowY, fft } = workspace
	const { real, imaginary, width: paddedWidth } = fft
	let weightSum = 0
	let weightedSum = 0
	let validCount = 0

	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i++) {
			if (mask !== undefined && mask[i] !== 0) continue
			const value = data[i]
			if (!Number.isFinite(value)) continue
			const w = windowX[x] * windowY[y]
			weightSum += w
			weightedSum += w * value
			validCount++
		}
	}

	const mean = weightSum > 0 ? weightedSum / weightSum : 0
	real.fill(0)
	imaginary.fill(0)

	for (let y = 0, i = 0; y < height; y++) {
		const row = y * paddedWidth

		for (let x = 0; x < width; x++, i++) {
			const value = data[i]
			if ((mask !== undefined && mask[i] !== 0) || !Number.isFinite(value)) continue
			real[row + x] = (value - mean) * windowX[x] * windowY[y]
		}
	}

	fftComplex2D(fft, false)

	let energy = 0
	for (let i = 0; i < real.length; i++) energy += real[i] * real[i] + imaginary[i] * imaginary[i]

	const spectrumReal = out !== undefined && out.real.length === real.length ? out.real : new Float64Array(real.length)
	const spectrumImaginary = out !== undefined && out.imaginary.length === real.length ? out.imaginary : new Float64Array(real.length)
	spectrumReal.set(real)
	spectrumImaginary.set(imaginary)
	return { width: fft.width, height: fft.height, real: spectrumReal, imaginary: spectrumImaginary, energy, validCount }
}

// Maps a cyclic FFT index to a signed shift in [-size/2, size/2).
function signedFrequency(index: number, size: number) {
	return index < size >>> 1 ? index : index - size
}

// Measures the translation of current relative to reference by phase correlation. Both spectra
// must come from the same workspace. Rejects flat inputs, peaks beyond maximumShift, weak PSR and
// ambiguous secondary peaks. Overwrites the workspace FFT and cross-power buffers.
export function phaseCorrelate(reference: PhaseCorrelationSpectrum, current: PhaseCorrelationSpectrum, workspace: PhaseCorrelationWorkspace, options: PhaseCorrelationOptions = {}): PhaseCorrelationOutcome {
	const { fft, crossReal, crossImaginary } = workspace
	const { width, height, real, imaginary } = fft
	const size = width * height
	const normalization = options.normalization ?? 'phase'
	const maximumShift = Math.min(options.maximumShift ?? workspace.maximumShift, workspace.maximumShift)
	const exclusion = Math.max(1, Math.floor(options.sidelobeExclusionRadius ?? 3))

	if (!(reference.energy > 0) || !(current.energy > 0)) return { success: false, reason: 'lowContrast' }

	let maximumMagnitude = 0

	for (let i = 0; i < size; i++) {
		const rr = reference.real[i]
		const ri = reference.imaginary[i]
		const cr = current.real[i]
		const ci = current.imaginary[i]
		// current · conj(reference) places the correlation peak at +translation.
		crossReal[i] = cr * rr + ci * ri
		crossImaginary[i] = ci * rr - cr * ri
		if (normalization === 'phase') maximumMagnitude = Math.max(maximumMagnitude, Math.hypot(crossReal[i], crossImaginary[i]))
	}

	let normalizer = Math.sqrt(reference.energy * current.energy)

	if (normalization === 'phase') {
		// Regularized whitening: frequencies weaker than the floor keep their relative amplitude, so
		// window leakage and numerical residue cannot dominate the phase surface.
		const floor = maximumMagnitude * PHASE_MAGNITUDE_FLOOR
		let weight = 0

		for (let i = 0; i < size; i++) {
			const magnitude = Math.hypot(crossReal[i], crossImaginary[i])
			const scale = 1 / Math.max(magnitude, floor)
			crossReal[i] *= scale
			crossImaginary[i] *= scale
			weight += magnitude * scale
		}

		if (!(weight > 0)) return { success: false, reason: 'lowContrast' }
		normalizer = weight
	}

	real.set(crossReal)
	imaginary.set(crossImaginary)
	fftComplex2D(fft, true)

	let peakIndex = 0
	for (let i = 1; i < size; i++) if (real[i] > real[peakIndex]) peakIndex = i

	// The inverse transform carries 1/N, so N·value/normalizer is the normalized correlation.
	const peakValue = real[peakIndex]
	if (!(peakValue > 0)) return { success: false, reason: 'correlationLow' }
	const peakX = peakIndex % width
	const peakY = (peakIndex - peakX) / width
	const shiftX = signedFrequency(peakX, width)
	const shiftY = signedFrequency(peakY, height)
	if (!(Math.abs(shiftX) <= maximumShift && Math.abs(shiftY) <= maximumShift)) return { success: false, reason: 'shiftOutOfRange' }

	let sidelobeCount = 0
	let sidelobeSum = 0
	let sidelobeSquares = 0
	let secondPeak = 0

	for (let y = 0, i = 0; y < height; y++) {
		const dy = Math.abs(signedFrequency((y - peakY + height) % height, height))

		for (let x = 0; x < width; x++, i++) {
			const value = real[i]
			const dx = Math.abs(signedFrequency((x - peakX + width) % width, width))
			if (dx <= exclusion && dy <= exclusion) continue
			sidelobeCount++
			sidelobeSum += value
			sidelobeSquares += value * value

			if (value > secondPeak && isCyclicLocalMaximum(real, width, height, x, y)) secondPeak = value
		}
	}

	const sidelobeMean = sidelobeCount > 0 ? sidelobeSum / sidelobeCount : 0
	const sidelobeDeviation = sidelobeCount > 1 ? Math.sqrt(Math.max(0, sidelobeSquares / sidelobeCount - sidelobeMean * sidelobeMean)) : 0
	const peakToSidelobeRatio = sidelobeDeviation > 0 ? Math.min(MAXIMUM_PEAK_TO_SIDELOBE_RATIO, (peakValue - sidelobeMean) / sidelobeDeviation) : MAXIMUM_PEAK_TO_SIDELOBE_RATIO
	const secondPeakRatio = Math.min(1, secondPeak / peakValue)

	if (!(peakToSidelobeRatio >= (options.minimumPeakToSidelobeRatio ?? 6))) return { success: false, reason: 'correlationLow' }
	if (!(secondPeakRatio <= (options.maximumSecondPeakRatio ?? 0.8))) return { success: false, reason: 'correlationAmbiguous' }

	const upsampleFactor = Math.max(1, Math.floor(options.upsampleFactor ?? 20))
	let translationX = shiftX
	let translationY = shiftY
	let peak = Math.min(1, (peakValue * size) / normalizer)
	let refined = false

	if (upsampleFactor > 1) {
		const local = localizedDFTPeak(workspace, shiftX, shiftY, upsampleFactor)

		if (local.interior) {
			translationX = local.x
			translationY = local.y
			peak = Math.min(1, Math.max(0, local.value / normalizer))
			refined = true
		}
	}

	return { success: true, translation: [translationX, translationY], peak, peakToSidelobeRatio, secondPeakRatio, error: Math.sqrt(Math.max(0, 1 - peak * peak)), refined }
}

// Tests whether a cell is not smaller than its eight cyclic neighbors.
function isCyclicLocalMaximum(surface: Float64Array, width: number, height: number, x: number, y: number) {
	const value = surface[y * width + x]

	for (let oy = -1; oy <= 1; oy++) {
		const row = ((y + oy + height) % height) * width

		for (let ox = -1; ox <= 1; ox++) {
			if ((ox !== 0 || oy !== 0) && surface[row + ((x + ox + width) % width)] > value) return false
		}
	}

	return true
}

// Evaluates the inverse DFT of the retained cross-power spectrum on a 1.5×upsample-sample square
// around the integer peak with spacing 1/upsample (Guizar-Sicairos et al. 2008), using two separable
// matrix products. Returns the best real correlation sum (not divided by N) and whether it is interior.
function localizedDFTPeak(workspace: PhaseCorrelationWorkspace, peakX: number, peakY: number, upsample: number) {
	const { crossReal, crossImaginary } = workspace
	const { width, height } = workspace.fft
	const samples = Math.ceil(upsample * 1.5) | 1
	const center = samples >>> 1
	const { rowReal, rowImaginary, kernelX, kernelY } = workspace.upsampleScratch(samples)

	for (let u = 0; u < width; u++) {
		const frequency = (TAU * signedFrequency(u, width)) / width

		for (let k = 0; k < samples; k++) {
			const angle = frequency * (peakX + (k - center) / upsample)
			const index = (u * samples + k) * 2
			kernelX[index] = Math.cos(angle)
			kernelX[index + 1] = Math.sin(angle)
		}
	}

	for (let v = 0; v < height; v++) {
		const frequency = (TAU * signedFrequency(v, height)) / height

		for (let k = 0; k < samples; k++) {
			const angle = frequency * (peakY + (k - center) / upsample)
			const index = (v * samples + k) * 2
			kernelY[index] = Math.cos(angle)
			kernelY[index + 1] = Math.sin(angle)
		}
	}

	for (let v = 0; v < height; v++) {
		const row = v * width

		for (let k = 0; k < samples; k++) {
			let sumReal = 0
			let sumImaginary = 0

			for (let u = 0; u < width; u++) {
				const cr = crossReal[row + u]
				const ci = crossImaginary[row + u]
				if (cr === 0 && ci === 0) continue
				const index = (u * samples + k) * 2
				const kr = kernelX[index]
				const ki = kernelX[index + 1]
				sumReal += cr * kr - ci * ki
				sumImaginary += cr * ki + ci * kr
			}

			rowReal[v * samples + k] = sumReal
			rowImaginary[v * samples + k] = sumImaginary
		}
	}

	let bestValue = Number.NEGATIVE_INFINITY
	let bestX = center
	let bestY = center

	for (let j = 0; j < samples; j++) {
		for (let k = 0; k < samples; k++) {
			let sum = 0

			for (let v = 0; v < height; v++) {
				const index = (v * samples + j) * 2
				// Only the real part is needed: the correlation of real signals is real.
				sum += rowReal[v * samples + k] * kernelY[index] - rowImaginary[v * samples + k] * kernelY[index + 1]
			}

			if (sum > bestValue) {
				bestValue = sum
				bestX = k
				bestY = j
			}
		}
	}

	const interior = bestX > 0 && bestY > 0 && bestX < samples - 1 && bestY < samples - 1
	return { x: peakX + (bestX - center) / upsample, y: peakY + (bestY - center) / upsample, value: bestValue, interior }
}

// Searches integer displacements within ±searchRadius of the rounded predicted displacement for the
// template reference[left..left+width, top..top+height) and refines the best one by a 3x3 quadratic.
// Only samples valid in both planes contribute. scratch must hold (2·searchRadius + 1)² values and is
// overwritten with the ZNCC surface (NaN where overlap is insufficient). Rejects flat templates, weak
// or ambiguous peaks, peaks on the search boundary and non-concave peak neighborhoods.
export function matchPatchZNCC(reference: RegistrationPlane, left: number, top: number, width: number, height: number, current: RegistrationPlane, predictedX: number, predictedY: number, options: ZNCCSearchOptions, scratch: Float64Array): ZNCCOutcome {
	const radius = Math.max(1, Math.floor(options.searchRadius))
	const side = 2 * radius + 1
	// A short scratch would silently corrupt the surface; this is a structural caller error.
	if (scratch.length < side * side) throw new RangeError('ZNCC scratch must hold the full search surface')

	const minimumOverlap = options.minimumOverlap ?? 0.6
	const exclusion = Math.max(1, Math.floor(options.sidelobeExclusionRadius ?? 2))
	const referenceData = reference.data
	const referenceMask = reference.mask
	const currentData = current.data
	const currentMask = current.mask
	const referenceWidth = reference.width
	const currentWidth = current.width
	const currentHeight = current.height
	let templateCount = 0
	let templateSum = 0
	let templateSquares = 0

	for (let j = 0; j < height; j++) {
		const row = (top + j) * referenceWidth + left

		for (let i = 0; i < width; i++) {
			const index = row + i
			if (referenceMask !== undefined && referenceMask[index] !== 0) continue
			const value = referenceData[index]
			templateCount++
			templateSum += value
			templateSquares += value * value
		}
	}

	if (templateCount < 9) return { success: false, reason: 'masked' }
	if (!(templateSquares - (templateSum * templateSum) / templateCount > 1e-12 * templateCount)) return { success: false, reason: 'lowContrast' }

	const baseX = Math.round(predictedX)
	const baseY = Math.round(predictedY)
	let bestIndex = -1
	let bestOverlap = 0

	for (let oy = -radius, s = 0; oy <= radius; oy++) {
		const dy = baseY + oy

		for (let ox = -radius; ox <= radius; ox++, s++) {
			const dx = baseX + ox
			const j0 = Math.max(0, -(top + dy))
			const j1 = Math.min(height, currentHeight - (top + dy))
			const i0 = Math.max(0, -(left + dx))
			const i1 = Math.min(width, currentWidth - (left + dx))
			let n = 0
			let st = 0
			let sc = 0
			let stt = 0
			let scc = 0
			let stc = 0

			for (let j = j0; j < j1; j++) {
				const referenceRow = (top + j) * referenceWidth + left
				const currentRow = (top + j + dy) * currentWidth + left + dx

				for (let i = i0; i < i1; i++) {
					const ri = referenceRow + i
					const ci = currentRow + i
					if ((referenceMask !== undefined && referenceMask[ri] !== 0) || (currentMask !== undefined && currentMask[ci] !== 0)) continue
					const t = referenceData[ri]
					const c = currentData[ci]
					n++
					st += t
					sc += c
					stt += t * t
					scc += c * c
					stc += t * c
				}
			}

			const overlap = n / templateCount
			const templateVariance = n * stt - st * st
			const currentVariance = n * scc - sc * sc

			if (overlap >= minimumOverlap && templateVariance > 0 && currentVariance > 0) {
				scratch[s] = (n * stc - st * sc) / Math.sqrt(templateVariance * currentVariance)

				if (bestIndex < 0 || scratch[s] > scratch[bestIndex]) {
					bestIndex = s
					bestOverlap = overlap
				}
			} else {
				scratch[s] = Number.NaN
			}
		}
	}

	if (bestIndex < 0) return { success: false, reason: 'insufficientOverlap' }

	const correlation = scratch[bestIndex]
	const bestX = bestIndex % side
	const bestY = (bestIndex - bestX) / side
	if (bestX === 0 || bestY === 0 || bestX === side - 1 || bestY === side - 1) return { success: false, reason: 'shiftOutOfRange' }
	if (!(correlation >= (options.minimumCorrelation ?? 0.5))) return { success: false, reason: 'correlationLow' }

	let sidelobeCount = 0
	let sidelobeSum = 0
	let sidelobeSquares = 0
	let secondPeak = Number.NEGATIVE_INFINITY

	for (let y = 0, s = 0; y < side; y++) {
		for (let x = 0; x < side; x++, s++) {
			const value = scratch[s]
			if (!Number.isFinite(value) || (Math.abs(x - bestX) <= exclusion && Math.abs(y - bestY) <= exclusion)) continue
			sidelobeCount++
			sidelobeSum += value
			sidelobeSquares += value * value
			if (value > secondPeak && x > 0 && y > 0 && x < side - 1 && y < side - 1 && isFiniteLocalMaximum(scratch, side, x, y)) secondPeak = value
		}
	}

	const sidelobeMean = sidelobeCount > 0 ? sidelobeSum / sidelobeCount : 0
	const sidelobeDeviation = sidelobeCount > 1 ? Math.sqrt(Math.max(0, sidelobeSquares / sidelobeCount - sidelobeMean * sidelobeMean)) : 0
	const peakToSidelobeRatio = sidelobeDeviation > 0 ? Math.min(MAXIMUM_PEAK_TO_SIDELOBE_RATIO, (correlation - sidelobeMean) / sidelobeDeviation) : MAXIMUM_PEAK_TO_SIDELOBE_RATIO
	const secondPeakRatio = secondPeak > 0 ? Math.min(1, secondPeak / correlation) : 0
	if (!(secondPeakRatio <= (options.maximumSecondPeakRatio ?? 0.9))) return { success: false, reason: 'correlationAmbiguous' }

	const peak = quadraticPeak3x3(scratch, side, bestX, bestY)
	if (peak === undefined) return { success: false, reason: 'subpixelDegenerate' }

	// Near the peak ZNCC ≈ ρ0 - ½ xᵀHx; the displacement whose drop equals the residual decorrelation
	// along the flattest direction is a scale-free proxy for the positional standard deviation.
	const decorrelation = Math.max(1e-3, 1 - correlation)
	const uncertainty = Math.min(radius, Math.max(0.01, Math.sqrt((2 * decorrelation) / peak.curvature)))

	return { success: true, translation: [baseX + bestX - radius + peak.x, baseY + bestY - radius + peak.y], correlation, peakToSidelobeRatio, secondPeakRatio, overlapFraction: bestOverlap, uncertainty }
}

// Tests whether an interior surface cell is finite and not smaller than its finite eight neighbors.
function isFiniteLocalMaximum(surface: Float64Array, side: number, x: number, y: number) {
	const value = surface[y * side + x]

	for (let oy = -1; oy <= 1; oy++) {
		for (let ox = -1; ox <= 1; ox++) {
			if (ox === 0 && oy === 0) continue
			const neighbor = surface[(y + oy) * side + x + ox]
			if (neighbor > value) return false
		}
	}

	return true
}

// Least-squares quadratic f = a + bx + cy + dx² + exy + fy² over the 3x3 neighborhood of an interior
// surface cell. Returns the stationary-point offset within ±1 sample and the smaller principal
// curvature magnitude, or undefined when a sample is not finite or the peak is not strictly concave.
function quadraticPeak3x3(surface: Float64Array, side: number, x: number, y: number) {
	const at = (ox: number, oy: number) => surface[(y + oy) * side + x + ox]
	const values = [at(-1, -1), at(0, -1), at(1, -1), at(-1, 0), at(0, 0), at(1, 0), at(-1, 1), at(0, 1), at(1, 1)]
	for (let i = 0; i < 9; i++) if (!Number.isFinite(values[i])) return undefined
	const [mm, zm, pm, mz, zz, pz, mp, zp, pp] = values
	const left = mm + mz + mp
	const middleX = zm + zz + zp
	const right = pm + pz + pp
	const upper = mm + zm + pm
	const middleY = mz + zz + pz
	const lower = mp + zp + pp
	const b = (right - left) / 6
	const c = (lower - upper) / 6
	const d = (left + right - 2 * middleX) / 6
	const f = (upper + lower - 2 * middleY) / 6
	const e = (pp - pm - mp + mm) / 4
	// Hessian [[2d, e], [e, 2f]] must be negative definite.
	const hxx = 2 * d
	const hyy = 2 * f
	const determinant = hxx * hyy - e * e
	if (!(hxx < 0 && hyy < 0 && determinant > 0)) return undefined
	const offsetX = (-b * hyy + c * e) / determinant
	const offsetY = (-c * hxx + b * e) / determinant
	if (!(Math.abs(offsetX) <= 1 && Math.abs(offsetY) <= 1)) return undefined
	const trace = hxx + hyy
	const curvature = Math.abs(trace * 0.5 + Math.sqrt(Math.max(0, (trace * trace) / 4 - determinant)))
	if (!(curvature > 0)) return undefined
	return { x: offsetX, y: offsetY, curvature }
}

// Samples a masked plane bilinearly; returns NaN outside the grid or when any support sample is masked.
function bilinearSample(plane: RegistrationPlane, x: number, y: number) {
	const { width, height, data, mask } = plane
	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) return Number.NaN
	const i = y0 * width + x0
	if (mask !== undefined && (mask[i] !== 0 || mask[i + 1] !== 0 || mask[i + width] !== 0 || mask[i + width + 1] !== 0)) return Number.NaN
	const fx = x - x0
	const fy = y - y0
	const top = data[i] + (data[i + 1] - data[i]) * fx
	const bottom = data[i + width] + (data[i + width + 1] - data[i + width]) * fx
	return top + (bottom - top) * fy
}

// Refines a template translation by translation-only ECC maximization (Evangelidis & Psarakis 2008,
// matching OpenCV findTransformECC MOTION_TRANSLATION). The current plane is bilinearly resampled and
// its gradient is the bilinearly sampled central difference. scratch must hold 4·width·height values.
// Fails, so callers keep the initialization, when the correlation would be minimized, the Hessian is
// singular, the update leaves maximumCorrection, or the final correlation is not finite.
export function refineTranslationECC(reference: RegistrationPlane, left: number, top: number, width: number, height: number, current: RegistrationPlane, initialX: number, initialY: number, options: ECCRefinementOptions, scratch: Float64Array): ECCOutcome {
	const count = width * height
	// A short scratch would silently overwrite unrelated samples; this is a structural caller error.
	if (scratch.length < 4 * count) throw new RangeError('ECC scratch must hold four values per template sample')

	const maximumIterations = Math.max(1, Math.floor(options.maximumIterations ?? 30))
	const tolerance = options.tolerance ?? 1e-3
	const maximumCorrection = options.maximumCorrection ?? 1.5
	const warped = scratch.subarray(0, count)
	const gradientX = scratch.subarray(count, 2 * count)
	const gradientY = scratch.subarray(2 * count, 3 * count)
	const template = scratch.subarray(3 * count, 4 * count)
	let px = initialX
	let py = initialY
	let iterations = 0
	let correlation = Number.NaN

	for (let j = 0, k = 0; j < height; j++) {
		const row = (top + j) * reference.width + left

		for (let i = 0; i < width; i++, k++) {
			template[k] = reference.mask !== undefined && reference.mask[row + i] !== 0 ? Number.NaN : reference.data[row + i]
		}
	}

	for (; iterations <= maximumIterations; iterations++) {
		let n = 0
		let sumT = 0
		let sumI = 0
		let sumGx = 0
		let sumGy = 0

		for (let j = 0, k = 0; j < height; j++) {
			const y = top + j + py

			for (let i = 0; i < width; i++, k++) {
				const x = left + i + px
				const value = Number.isNaN(template[k]) ? Number.NaN : bilinearSample(current, x, y)
				const gx = (bilinearSample(current, x + 1, y) - bilinearSample(current, x - 1, y)) * 0.5
				const gy = (bilinearSample(current, x, y + 1) - bilinearSample(current, x, y - 1)) * 0.5
				const valid = Number.isFinite(value) && Number.isFinite(gx) && Number.isFinite(gy)
				warped[k] = valid ? value : Number.NaN
				gradientX[k] = gx
				gradientY[k] = gy
				if (!valid) continue
				n++
				sumT += template[k]
				sumI += value
				sumGx += gx
				sumGy += gy
			}
		}

		if (n < 9) return { success: false }

		const meanT = sumT / n
		const meanI = sumI / n
		const meanGx = sumGx / n
		const meanGy = sumGy / n
		let tt = 0
		let ii = 0
		let ti = 0
		let hxx = 0
		let hxy = 0
		let hyy = 0
		let tpx = 0
		let tpy = 0
		let ipx = 0
		let ipy = 0

		for (let k = 0; k < count; k++) {
			const value = warped[k]
			if (Number.isNaN(value)) continue
			const t = template[k] - meanT
			const v = value - meanI
			const gx = gradientX[k] - meanGx
			const gy = gradientY[k] - meanGy
			tt += t * t
			ii += v * v
			ti += t * v
			hxx += gx * gx
			hxy += gx * gy
			hyy += gy * gy
			tpx += gx * t
			tpy += gy * t
			ipx += gx * v
			ipy += gy * v
		}

		correlation = tt > 0 && ii > 0 ? ti / Math.sqrt(tt * ii) : Number.NaN
		if (!Number.isFinite(correlation)) return { success: false }
		if (iterations === maximumIterations) break

		const determinant = hxx * hyy - hxy * hxy
		if (!(determinant > 1e-12 * Math.max(1, hxx * hyy))) return { success: false }
		const ixx = hyy / determinant
		const ixy = -hxy / determinant
		const iyy = hxx / determinant
		const hipx = ixx * ipx + ixy * ipy
		const hipy = ixy * ipx + iyy * ipy
		const lambdaNumerator = ii - (ipx * hipx + ipy * hipy)
		const lambdaDenominator = ti - (tpx * hipx + tpy * hipy)
		// OpenCV stops here: a non-positive denominator would minimize the correlation.
		if (!(lambdaDenominator > 0)) return { success: false }
		const lambda = lambdaNumerator / lambdaDenominator
		const ex = lambda * tpx - ipx
		const ey = lambda * tpy - ipy
		const deltaX = ixx * ex + ixy * ey
		const deltaY = ixy * ex + iyy * ey
		px += deltaX
		py += deltaY
		if (!(Math.hypot(px - initialX, py - initialY) <= maximumCorrection)) return { success: false }
		if (Math.hypot(deltaX, deltaY) < tolerance) {
			iterations++
			const final = eccCorrelation(template, left, top, width, height, current, px, py)
			if (!Number.isFinite(final)) return { success: false }
			return { success: true, translation: [px, py], correlation: final, iterations }
		}
	}

	return { success: true, translation: [px, py], correlation, iterations }
}

// Zero-mean normalized correlation between template values and the bilinearly warped current plane.
function eccCorrelation(template: Float64Array, left: number, top: number, width: number, height: number, current: RegistrationPlane, px: number, py: number) {
	let n = 0
	let st = 0
	let sc = 0
	let stt = 0
	let scc = 0
	let stc = 0

	for (let j = 0, k = 0; j < height; j++) {
		for (let i = 0; i < width; i++, k++) {
			const t = template[k]
			if (Number.isNaN(t)) continue
			const c = bilinearSample(current, left + i + px, top + j + py)
			if (!Number.isFinite(c)) continue
			n++
			st += t
			sc += c
			stt += t * t
			scc += c * c
			stc += t * c
		}
	}

	const templateVariance = n * stt - st * st
	const currentVariance = n * scc - sc * sc
	return n >= 9 && templateVariance > 0 && currentVariance > 0 ? (n * stc - st * sc) / Math.sqrt(templateVariance * currentVariance) : Number.NaN
}
