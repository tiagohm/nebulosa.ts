import type { ImageRawType } from './image.types'
import { clamp, lerp } from './math'

export type StarPsfModel = 'gaussian' | 'moffat'

export interface PlotStarOptions {
	readonly background?: number
	readonly saturationLevel?: number
	readonly colorIndex?: number
	readonly focusStep?: number
	readonly bestFocus?: number
	readonly peakScale?: number
	readonly ellipticity?: number
	readonly theta?: number
	readonly softCore?: number
	readonly psfModel?: StarPsfModel
	readonly beta?: number
	readonly haloStrength?: number
	readonly haloScale?: number
	readonly jitterX?: number
	readonly jitterY?: number
	readonly gain?: number
	readonly gammaCompensation?: number | false
	readonly additiveNoiseHint?: number
	readonly minPlotRadius?: number
	readonly maxPlotRadius?: number
	readonly cutoffSigma?: number
}

const SQRT_TWO_LN_TWO = 1.1774100225154747
const HFD_TO_SIGMA = 1 / (2 * SQRT_TWO_LN_TWO)
const DEFAULT_COLOR_INDEX = 0.65
const MIN_HFD = 0.35
const MIN_SIGMA = 0.18
const MIN_AXIS_RATIO = 0.2
const DEFAULT_BETA = 2.5
const DEFAULT_HALO_SCALE = 2.8
const DEFAULT_MIN_RADIUS = 2
const DEFAULT_MAX_RADIUS = 24
const DEFAULT_CUTOFF_SIGMA = 4.25
const FAST_PATH_ELLIPTICITY_EPSILON = 1e-6
const MAX_FOCUS_STEP = 100000

const COLOR_INDEX_LUT = [
	[-0.4, 0.72, 0.86, 1.42],
	[0.0, 0.9, 0.98, 1.12],
	[0.45, 1.0, 1.0, 1.0],
	[0.9, 1.18, 0.97, 0.78],
	[1.4, 1.34, 0.9, 0.56],
	[2.0, 1.42, 0.82, 0.42],
] as const

// Maps a bounded B-V style color index into normalized RGB channel weights.
export function colorIndexToRgbWeights(colorIndex: number = DEFAULT_COLOR_INDEX, gammaCompensation: number | false = false) {
	const ci = clampFinite(colorIndex, DEFAULT_COLOR_INDEX, -0.4, 2)
	let index = 0

	for (; index < COLOR_INDEX_LUT.length - 2; index++) {
		if (ci <= COLOR_INDEX_LUT[index + 1][0]) break
	}

	const left = COLOR_INDEX_LUT[index]
	const right = COLOR_INDEX_LUT[index + 1]
	const span = right[0] - left[0]
	const t = span > 0 ? (ci - left[0]) / span : 0
	let red = lerp(left[1], right[1], t)
	let green = lerp(left[2], right[2], t)
	let blue = lerp(left[3], right[3], t)

	if (gammaCompensation !== false && Number.isFinite(gammaCompensation) && gammaCompensation > 0) {
		const power = 1 / gammaCompensation
		red = red ** power
		green = green ** power
		blue = blue ** power
	}

	const sum = red + green + blue
	if (sum <= 0) return [1 / 3, 1 / 3, 1 / 3] as const
	else return [red / sum, green / sum, blue / sum] as const
}

// Converts HFD and seeing terms, both treated as HFD-like diameters in pixels, into one effective Gaussian sigma.
export function effectiveGaussianSigma(hfd: number, seeing: number = 0, snr: number = 0, softCore: number = 0, additiveNoiseHint: number = 0, peakScale: number = 1, background: number = 0) {
	const hfdSigma = Math.max(MIN_SIGMA, sanitizePositive(hfd, MIN_HFD) * HFD_TO_SIGMA)
	const seeingSigma = Math.max(0, sanitizePositive(seeing, 0) * HFD_TO_SIGMA)
	const combinedSigma = Math.hypot(hfdSigma, seeingSigma)
	const lowSnr = 1 - clamp(sanitizePositive(snr, 0) / 32, 0, 1)
	const noiseSoftening = clamp(sanitizePositive(additiveNoiseHint, 0) * 0.04, 0, 0.2)
	const backgroundSoftening = clamp(sanitizePositive(background, 0) * 4, 0, 0.2)
	const softCoreFactor = 1 + clamp(sanitizePositive(softCore, 0), 0, 4) * 0.12 + lowSnr * 0.18 + noiseSoftening + backgroundSoftening
	const concentration = Math.sqrt(clamp(sanitizePositive(peakScale, 1), 0.25, 4))
	return Math.max(MIN_SIGMA, (combinedSigma * softCoreFactor) / concentration)
}

// Maps focusStep and bestFocus into a normalized defocus amount in the [0, 1] range.
export function focusDefocusAmount(focusStep?: number, bestFocus?: number) {
	if (!Number.isFinite(focusStep) || !Number.isFinite(bestFocus)) return 0
	const focus = clamp(focusStep!, 0, MAX_FOCUS_STEP)
	const best = clamp(bestFocus!, 0, MAX_FOCUS_STEP)
	const maxOffset = Math.max(best, MAX_FOCUS_STEP - best, 1)
	return clamp(Math.abs(focus - best) / maxOffset, 0, 1)
}

// Plots one synthetic star into an existing ImageRawType image buffer.
export function plotStar(raw: ImageRawType, width: number, height: number, channels: 1 | 3, x: number, y: number, flux: number, hfd: number, snr: number, seeing: number, options: PlotStarOptions = {}) {
	if (!Number.isInteger(width) || width <= 0) throw new RangeError('width must be a positive integer')
	if (!Number.isInteger(height) || height <= 0) throw new RangeError('height must be a positive integer')
	const expectedLength = width * height * channels
	if (raw.length < expectedLength) throw new RangeError(`buffer length mismatch: expected ${expectedLength}, received ${raw.length}`)

	const gain = sanitizePositive(options.gain, 1)
	const totalFlux = sanitizePositive(flux, 0) * gain
	if (totalFlux <= 0) return false

	const centerX = x + sanitizeSigned(options.jitterX, 0)
	const centerY = y + sanitizeSigned(options.jitterY, 0)
	if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return false

	const background = sanitizePositive(options.background, 0)
	const peakScale = sanitizePositive(options.peakScale, 1)
	const defocus = focusDefocusAmount(options.focusStep, options.bestFocus)
	const effectiveSoftCore = (options.softCore ?? 0) + defocus * 3.2
	const effectivePeakScale = Math.max(0.2, peakScale / (1 + defocus * 1.4))
	const sigma = effectiveGaussianSigma(hfd, seeing, snr, effectiveSoftCore, options.additiveNoiseHint ?? 0, effectivePeakScale, background) * (1 + defocus * defocus * 2.4)
	const lowSnr = 1 - clamp(sanitizePositive(snr, 0) / 32, 0, 1)
	const haloVisibility = 1 - lowSnr * 0.5 - clamp(background * 2, 0, 0.25)
	const haloStrength = Math.max(0, (sanitizePositive(options.haloStrength, 0) + defocus * defocus * 0.24) * Math.max(0, haloVisibility))
	const haloScale = clamp(sanitizePositive(options.haloScale, DEFAULT_HALO_SCALE) * (1 + defocus * 0.6), 1.1, 10)
	const haloSigma = sigma * haloScale
	const axisRatio = 1 - clamp(sanitizePositive(options.ellipticity, 0), 0, 1 - MIN_AXIS_RATIO)
	const ellipticity = 1 - axisRatio
	const psfModel = options.psfModel === 'moffat' ? 'moffat' : 'gaussian'
	const beta = Math.max(1.05, sanitizePositive(options.beta, DEFAULT_BETA))
	const saturationEnabled = options.saturationLevel !== undefined && Number.isFinite(options.saturationLevel)
	const saturationLevel = saturationEnabled ? Math.max(0, options.saturationLevel!) : 0
	const cutoffSigma = clamp(sanitizePositive(options.cutoffSigma, DEFAULT_CUTOFF_SIGMA), 2.5, 7)
	const minPlotRadius = Math.max(0, sanitizePositive(options.minPlotRadius, DEFAULT_MIN_RADIUS))
	const maxPlotRadius = Math.max(minPlotRadius, sanitizePositive(options.maxPlotRadius, DEFAULT_MAX_RADIUS))
	const wingsScale = psfModel === 'moffat' ? 1.35 : 1
	const sigmaExtent = Math.max(sigma / Math.sqrt(axisRatio), haloStrength > 0 ? haloSigma / Math.sqrt(axisRatio) : 0)
	const radius = Math.ceil(clamp(cutoffSigma * wingsScale * sigmaExtent * (1 - lowSnr * 0.08), minPlotRadius, maxPlotRadius))
	const plotMinX = Math.ceil(centerX - radius)
	const plotMaxX = Math.floor(centerX + radius)
	const plotMinY = Math.ceil(centerY - radius)
	const plotMaxY = Math.floor(centerY + radius)
	const minX = Math.max(0, plotMinX)
	const maxX = Math.min(width - 1, plotMaxX)
	const minY = Math.max(0, plotMinY)
	const maxY = Math.min(height - 1, plotMaxY)

	if (maxX < minX || maxY < minY) return false

	const coreFlux = totalFlux / (1 + haloStrength)
	const haloFlux = totalFlux - coreFlux

	if (psfModel === 'gaussian' && ellipticity <= FAST_PATH_ELLIPTICITY_EPSILON) {
		const coreAmplitude = coreFlux / Math.max(Number.EPSILON, circularGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, sigma))
		const haloAmplitude = haloFlux > 0 ? haloFlux / Math.max(Number.EPSILON, circularGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, haloSigma)) : 0

		if (channels === 1) {
			plotCircularGaussianMono(raw, width, minX, maxX, minY, maxY, centerX, centerY, sigma, coreAmplitude, haloSigma, haloAmplitude, saturationEnabled, saturationLevel)
		} else {
			const [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(options.colorIndex, options.gammaCompensation)
			plotCircularGaussianRgb(raw, width, minX, maxX, minY, maxY, centerX, centerY, sigma, coreAmplitude, haloSigma, haloAmplitude, redWeight, greenWeight, blueWeight, saturationEnabled, saturationLevel)
		}

		return true
	}

	const axisRatioSqrt = Math.sqrt(axisRatio)

	if (psfModel === 'gaussian') {
		const majorSigma = sigma / axisRatioSqrt
		const minorSigma = sigma * axisRatioSqrt
		const haloMajorSigma = haloStrength > 0 ? haloSigma / axisRatioSqrt : 0
		const haloMinorSigma = haloStrength > 0 ? haloSigma * axisRatioSqrt : 0
		const coreAmplitude = coreFlux / Math.max(Number.EPSILON, ellipticalGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, majorSigma, minorSigma, options.theta || 0))
		const haloAmplitude = haloFlux > 0 ? haloFlux / Math.max(Number.EPSILON, ellipticalGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, haloMajorSigma, haloMinorSigma, options.theta || 0)) : 0

		if (channels === 1) {
			plotEllipticalGaussianMono(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorSigma, minorSigma, options.theta || 0, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, saturationEnabled, saturationLevel)
		} else {
			const [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(options.colorIndex, options.gammaCompensation)
			plotEllipticalGaussianRgb(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorSigma, minorSigma, options.theta || 0, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, redWeight, greenWeight, blueWeight, saturationEnabled, saturationLevel)
		}

		return true
	}

	const effectiveHfd = sigma / HFD_TO_SIGMA
	const baseAlpha = moffatAlphaFromHfd(effectiveHfd, beta)
	const majorAlpha = baseAlpha / axisRatioSqrt
	const minorAlpha = baseAlpha * axisRatioSqrt
	const haloMajorSigma = haloSigma / axisRatioSqrt
	const haloMinorSigma = haloSigma * axisRatioSqrt
	const coreAmplitude = coreFlux / Math.max(Number.EPSILON, moffatDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, majorAlpha, minorAlpha, options.theta || 0, beta))
	const haloAmplitude = haloFlux > 0 ? haloFlux / Math.max(Number.EPSILON, ellipticalGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, haloMajorSigma, haloMinorSigma, options.theta || 0)) : 0

	if (channels === 1) {
		plotMoffatMono(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorAlpha, minorAlpha, options.theta || 0, beta, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, saturationEnabled, saturationLevel)
	} else {
		const [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(options.colorIndex, options.gammaCompensation)
		plotMoffatRgb(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorAlpha, minorAlpha, options.theta || 0, beta, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, redWeight, greenWeight, blueWeight, saturationEnabled, saturationLevel)
	}

	return true
}

// Uses recurrence relations to avoid transcendental work inside the circular Gaussian inner loop.
function plotCircularGaussianMono(buffer: ImageRawType, width: number, minX: number, maxX: number, minY: number, maxY: number, centerX: number, centerY: number, sigma: number, amplitude: number, haloSigma: number, haloAmplitude: number, saturationEnabled: boolean, saturationLevel: number) {
	const invTwoSigma2 = 0.5 / (sigma * sigma)
	const xStart = minX - centerX
	const xWeightStart = Math.exp(-(xStart * xStart) * invTwoSigma2)
	const xStepStart = Math.exp(-(2 * xStart + 1) * invTwoSigma2)
	const xStepMul = Math.exp(-1 / (sigma * sigma))

	const haloEnabled = haloAmplitude > 0
	const haloInvTwoSigma2 = haloEnabled ? 0.5 / (haloSigma * haloSigma) : 0
	const haloXWeightStart = haloEnabled ? Math.exp(-(xStart * xStart) * haloInvTwoSigma2) : 0
	const haloXStepStart = haloEnabled ? Math.exp(-(2 * xStart + 1) * haloInvTwoSigma2) : 0
	const haloXStepMul = haloEnabled ? Math.exp(-1 / (haloSigma * haloSigma)) : 1

	const dy = minY - centerY
	let yWeight = Math.exp(-(dy * dy) * invTwoSigma2)
	let yStep = Math.exp(-(2 * dy + 1) * invTwoSigma2)
	const yStepMul = Math.exp(-1 / (sigma * sigma))
	let haloYWeight = haloEnabled ? Math.exp(-(dy * dy) * haloInvTwoSigma2) : 0
	let haloYStep = haloEnabled ? Math.exp(-(2 * dy + 1) * haloInvTwoSigma2) : 0
	const haloYStepMul = haloEnabled ? Math.exp(-1 / (haloSigma * haloSigma)) : 1

	if (saturationEnabled) {
		for (let py = minY; py <= maxY; py++) {
			let index = py * width + minX
			let xWeight = xWeightStart
			let xStep = xStepStart
			let haloXWeight = haloXWeightStart
			let haloXStep = haloXStepStart
			const rowCore = amplitude * yWeight
			const rowHalo = haloAmplitude * haloYWeight

			for (let px = minX; px <= maxX; px++, index++) {
				const value = rowCore * xWeight + rowHalo * haloXWeight
				const next = buffer[index] + value
				buffer[index] = next > saturationLevel ? saturationLevel : next
				xWeight *= xStep
				xStep *= xStepMul
				haloXWeight *= haloXStep
				haloXStep *= haloXStepMul
			}

			yWeight *= yStep
			yStep *= yStepMul
			haloYWeight *= haloYStep
			haloYStep *= haloYStepMul
		}
	} else {
		for (let py = minY; py <= maxY; py++) {
			let index = py * width + minX
			let xWeight = xWeightStart
			let xStep = xStepStart
			let haloXWeight = haloXWeightStart
			let haloXStep = haloXStepStart
			const rowCore = amplitude * yWeight
			const rowHalo = haloAmplitude * haloYWeight

			for (let px = minX; px <= maxX; px++, index++) {
				buffer[index] += rowCore * xWeight + rowHalo * haloXWeight
				xWeight *= xStep
				xStep *= xStepMul
				haloXWeight *= haloXStep
				haloXStep *= haloXStepMul
			}

			yWeight *= yStep
			yStep *= yStepMul
			haloYWeight *= haloYStep
			haloYStep *= haloYStepMul
		}
	}
}

// Uses recurrence relations to keep the RGB path branch-free inside the per-pixel loop.
function plotCircularGaussianRgb(
	buffer: ImageRawType,
	width: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	centerX: number,
	centerY: number,
	sigma: number,
	amplitude: number,
	haloSigma: number,
	haloAmplitude: number,
	redWeight: number,
	greenWeight: number,
	blueWeight: number,
	saturationEnabled: boolean,
	saturationLevel: number,
) {
	const invTwoSigma2 = 0.5 / (sigma * sigma)
	const xStart = minX - centerX
	const xWeightStart = Math.exp(-(xStart * xStart) * invTwoSigma2)
	const xStepStart = Math.exp(-(2 * xStart + 1) * invTwoSigma2)
	const xStepMul = Math.exp(-1 / (sigma * sigma))

	const haloEnabled = haloAmplitude > 0
	const haloInvTwoSigma2 = haloEnabled ? 0.5 / (haloSigma * haloSigma) : 0
	const haloXWeightStart = haloEnabled ? Math.exp(-(xStart * xStart) * haloInvTwoSigma2) : 0
	const haloXStepStart = haloEnabled ? Math.exp(-(2 * xStart + 1) * haloInvTwoSigma2) : 0
	const haloXStepMul = haloEnabled ? Math.exp(-1 / (haloSigma * haloSigma)) : 1

	const dy = minY - centerY
	let yWeight = Math.exp(-(dy * dy) * invTwoSigma2)
	let yStep = Math.exp(-(2 * dy + 1) * invTwoSigma2)
	const yStepMul = Math.exp(-1 / (sigma * sigma))
	let haloYWeight = haloEnabled ? Math.exp(-(dy * dy) * haloInvTwoSigma2) : 0
	let haloYStep = haloEnabled ? Math.exp(-(2 * dy + 1) * haloInvTwoSigma2) : 0
	const haloYStepMul = haloEnabled ? Math.exp(-1 / (haloSigma * haloSigma)) : 1

	if (saturationEnabled) {
		for (let py = minY; py <= maxY; py++) {
			let index = (py * width + minX) * 3
			let xWeight = xWeightStart
			let xStep = xStepStart
			let haloXWeight = haloXWeightStart
			let haloXStep = haloXStepStart
			const rowCore = amplitude * yWeight
			const rowHalo = haloAmplitude * haloYWeight

			for (let px = minX; px <= maxX; px++, index += 3) {
				const value = rowCore * xWeight + rowHalo * haloXWeight
				const red = buffer[index] + value * redWeight
				const green = buffer[index + 1] + value * greenWeight
				const blue = buffer[index + 2] + value * blueWeight
				buffer[index] = red > saturationLevel ? saturationLevel : red
				buffer[index + 1] = green > saturationLevel ? saturationLevel : green
				buffer[index + 2] = blue > saturationLevel ? saturationLevel : blue
				xWeight *= xStep
				xStep *= xStepMul
				haloXWeight *= haloXStep
				haloXStep *= haloXStepMul
			}

			yWeight *= yStep
			yStep *= yStepMul
			haloYWeight *= haloYStep
			haloYStep *= haloYStepMul
		}
	} else {
		for (let py = minY; py <= maxY; py++) {
			let index = (py * width + minX) * 3
			let xWeight = xWeightStart
			let xStep = xStepStart
			let haloXWeight = haloXWeightStart
			let haloXStep = haloXStepStart
			const rowCore = amplitude * yWeight
			const rowHalo = haloAmplitude * haloYWeight

			for (let px = minX; px <= maxX; px++, index += 3) {
				const value = rowCore * xWeight + rowHalo * haloXWeight
				buffer[index] += value * redWeight
				buffer[index + 1] += value * greenWeight
				buffer[index + 2] += value * blueWeight
				xWeight *= xStep
				xStep *= xStepMul
				haloXWeight *= haloXStep
				haloXStep *= haloXStepMul
			}

			yWeight *= yStep
			yStep *= yStepMul
			haloYWeight *= haloYStep
			haloYStep *= haloYStepMul
		}
	}
}

// Evaluates an elliptical Gaussian with one exponential per row plus recurrence across each row.
function plotEllipticalGaussianMono(
	buffer: ImageRawType,
	width: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	centerX: number,
	centerY: number,
	sigmaX: number,
	sigmaY: number,
	theta: number,
	amplitude: number,
	haloSigmaX: number,
	haloSigmaY: number,
	haloAmplitude: number,
	saturationEnabled: boolean,
	saturationLevel: number,
) {
	const [a, b, c] = gaussianQuadraticTerms(sigmaX, sigmaY, theta)
	const haloEnabled = haloAmplitude > 0
	const [ha, hb, hc] = haloEnabled ? gaussianQuadraticTerms(haloSigmaX, haloSigmaY, theta) : [0, 0, 0]
	const xStart = minX - centerX
	const delta2a = 2 * a
	const haloDelta2a = 2 * ha
	const stepMul = Math.exp(-a)
	const haloStepMul = haloEnabled ? Math.exp(-ha) : 1

	if (saturationEnabled) {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let dq = a * (2 * xStart + 1) + b * dy
			let w = Math.exp(-0.5 * (a * xStart * xStart + b * xStart * dy + c * dy * dy))
			let step = Math.exp(-0.5 * dq)
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = py * width + minX

			for (let px = minX; px <= maxX; px++, index++) {
				const value = amplitude * w + haloAmplitude * haloW
				const next = buffer[index] + value
				buffer[index] = next > saturationLevel ? saturationLevel : next
				w *= step
				step *= stepMul
				dq += delta2a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	} else {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let dq = a * (2 * xStart + 1) + b * dy
			let w = Math.exp(-0.5 * (a * xStart * xStart + b * xStart * dy + c * dy * dy))
			let step = Math.exp(-0.5 * dq)
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = py * width + minX

			for (let px = minX; px <= maxX; px++, index++) {
				buffer[index] += amplitude * w + haloAmplitude * haloW
				w *= step
				step *= stepMul
				dq += delta2a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	}
}

// Applies the same elliptical Gaussian model to interleaved RGB data.
function plotEllipticalGaussianRgb(
	buffer: ImageRawType,
	width: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	centerX: number,
	centerY: number,
	sigmaX: number,
	sigmaY: number,
	theta: number,
	amplitude: number,
	haloSigmaX: number,
	haloSigmaY: number,
	haloAmplitude: number,
	redWeight: number,
	greenWeight: number,
	blueWeight: number,
	saturationEnabled: boolean,
	saturationLevel: number,
) {
	const [a, b, c] = gaussianQuadraticTerms(sigmaX, sigmaY, theta)
	const haloEnabled = haloAmplitude > 0
	const [ha, hb, hc] = haloEnabled ? gaussianQuadraticTerms(haloSigmaX, haloSigmaY, theta) : [0, 0, 0]
	const xStart = minX - centerX
	const delta2a = 2 * a
	const haloDelta2a = 2 * ha
	const stepMul = Math.exp(-a)
	const haloStepMul = haloEnabled ? Math.exp(-ha) : 1

	if (saturationEnabled) {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let dq = a * (2 * xStart + 1) + b * dy
			let w = Math.exp(-0.5 * (a * xStart * xStart + b * xStart * dy + c * dy * dy))
			let step = Math.exp(-0.5 * dq)
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = (py * width + minX) * 3

			for (let px = minX; px <= maxX; px++, index += 3) {
				const value = amplitude * w + haloAmplitude * haloW
				const red = buffer[index] + value * redWeight
				const green = buffer[index + 1] + value * greenWeight
				const blue = buffer[index + 2] + value * blueWeight
				buffer[index] = red > saturationLevel ? saturationLevel : red
				buffer[index + 1] = green > saturationLevel ? saturationLevel : green
				buffer[index + 2] = blue > saturationLevel ? saturationLevel : blue
				w *= step
				step *= stepMul
				dq += delta2a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	} else {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let dq = a * (2 * xStart + 1) + b * dy
			let w = Math.exp(-0.5 * (a * xStart * xStart + b * xStart * dy + c * dy * dy))
			let step = Math.exp(-0.5 * dq)
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = (py * width + minX) * 3

			for (let px = minX; px <= maxX; px++, index += 3) {
				const value = amplitude * w + haloAmplitude * haloW
				buffer[index] += value * redWeight
				buffer[index + 1] += value * greenWeight
				buffer[index + 2] += value * blueWeight
				w *= step
				step *= stepMul
				dq += delta2a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	}
}

// Uses a direct Moffat evaluation only on the optional slower path.
function plotMoffatMono(
	buffer: ImageRawType,
	width: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	centerX: number,
	centerY: number,
	alphaX: number,
	alphaY: number,
	theta: number,
	beta: number,
	amplitude: number,
	haloSigmaX: number,
	haloSigmaY: number,
	haloAmplitude: number,
	saturationEnabled: boolean,
	saturationLevel: number,
) {
	const [a, b, c] = moffatQuadraticTerms(alphaX, alphaY, theta)
	const haloEnabled = haloAmplitude > 0
	const [ha, hb, hc] = haloEnabled ? gaussianQuadraticTerms(haloSigmaX, haloSigmaY, theta) : [0, 0, 0]
	const xStart = minX - centerX
	const haloDelta2a = 2 * ha
	const haloStepMul = haloEnabled ? Math.exp(-ha) : 1

	if (saturationEnabled) {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let q = a * xStart * xStart + b * xStart * dy + c * dy * dy
			let dq = a * (2 * xStart + 1) + b * dy
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = py * width + minX

			for (let px = minX; px <= maxX; px++, index++) {
				const value = amplitude / (1 + q) ** beta + haloAmplitude * haloW
				const next = buffer[index] + value
				buffer[index] = next > saturationLevel ? saturationLevel : next
				q += dq
				dq += 2 * a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	} else {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let q = a * xStart * xStart + b * xStart * dy + c * dy * dy
			let dq = a * (2 * xStart + 1) + b * dy
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = py * width + minX

			for (let px = minX; px <= maxX; px++, index++) {
				buffer[index] += amplitude / (1 + q) ** beta + haloAmplitude * haloW
				q += dq
				dq += 2 * a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	}
}

// Applies the optional Moffat core with the same RGB accumulation rules.
function plotMoffatRgb(
	buffer: ImageRawType,
	width: number,
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	centerX: number,
	centerY: number,
	alphaX: number,
	alphaY: number,
	theta: number,
	beta: number,
	amplitude: number,
	haloSigmaX: number,
	haloSigmaY: number,
	haloAmplitude: number,
	redWeight: number,
	greenWeight: number,
	blueWeight: number,
	saturationEnabled: boolean,
	saturationLevel: number,
) {
	const [a, b, c] = moffatQuadraticTerms(alphaX, alphaY, theta)
	const haloEnabled = haloAmplitude > 0
	const [ha, hb, hc] = haloEnabled ? gaussianQuadraticTerms(haloSigmaX, haloSigmaY, theta) : [0, 0, 0]
	const xStart = minX - centerX
	const haloDelta2a = 2 * ha
	const haloStepMul = haloEnabled ? Math.exp(-ha) : 1

	if (saturationEnabled) {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let q = a * xStart * xStart + b * xStart * dy + c * dy * dy
			let dq = a * (2 * xStart + 1) + b * dy
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = (py * width + minX) * 3

			for (let px = minX; px <= maxX; px++, index += 3) {
				const value = amplitude / (1 + q) ** beta + haloAmplitude * haloW
				const red = buffer[index] + value * redWeight
				const green = buffer[index + 1] + value * greenWeight
				const blue = buffer[index + 2] + value * blueWeight
				buffer[index] = red > saturationLevel ? saturationLevel : red
				buffer[index + 1] = green > saturationLevel ? saturationLevel : green
				buffer[index + 2] = blue > saturationLevel ? saturationLevel : blue
				q += dq
				dq += 2 * a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	} else {
		for (let py = minY; py <= maxY; py++) {
			const dy = py - centerY
			let q = a * xStart * xStart + b * xStart * dy + c * dy * dy
			let dq = a * (2 * xStart + 1) + b * dy
			let haloDq = ha * (2 * xStart + 1) + hb * dy
			let haloW = haloEnabled ? Math.exp(-0.5 * (ha * xStart * xStart + hb * xStart * dy + hc * dy * dy)) : 0
			let haloStep = haloEnabled ? Math.exp(-0.5 * haloDq) : 1
			let index = (py * width + minX) * 3

			for (let px = minX; px <= maxX; px++, index += 3) {
				const value = amplitude / (1 + q) ** beta + haloAmplitude * haloW
				buffer[index] += value * redWeight
				buffer[index + 1] += value * greenWeight
				buffer[index + 2] += value * blueWeight
				q += dq
				dq += 2 * a
				haloW *= haloStep
				haloStep *= haloStepMul
				haloDq += haloDelta2a
			}
		}
	}
}

// Expands the rotated elliptical Gaussian quadratic form q = A dx^2 + B dx dy + C dy^2.
function gaussianQuadraticTerms(sigmaX: number, sigmaY: number, theta: number) {
	const cosTheta = Math.cos(theta)
	const sinTheta = Math.sin(theta)
	const invSigmaX2 = 1 / (sigmaX * sigmaX)
	const invSigmaY2 = 1 / (sigmaY * sigmaY)
	const cos2 = cosTheta * cosTheta
	const sin2 = sinTheta * sinTheta
	const cross = 2 * sinTheta * cosTheta * (invSigmaX2 - invSigmaY2)
	return [cos2 * invSigmaX2 + sin2 * invSigmaY2, cross, sin2 * invSigmaX2 + cos2 * invSigmaY2] as const
}

// Reuses the same rotated quadratic form for the Moffat core.
function moffatQuadraticTerms(alphaX: number, alphaY: number, theta: number) {
	return gaussianQuadraticTerms(alphaX, alphaY, theta)
}

// Converts an HFD-like diameter into a Moffat alpha parameter.
function moffatAlphaFromHfd(hfd: number, beta: number) {
	const radius = 0.5 * Math.max(MIN_HFD, sanitizePositive(hfd, MIN_HFD))
	const denominator = Math.sqrt(Math.max(1e-9, 2 ** (1 / (beta - 1)) - 1))
	return Math.max(MIN_SIGMA, radius / denominator)
}

// Computes the sampled Gaussian mass along one axis for the exact plotted lattice.
function gaussian1DDiscreteSum(minIndex: number, maxIndex: number, center: number, sigma: number) {
	const invTwoSigma2 = 0.5 / (sigma * sigma)
	const start = minIndex - center
	let weight = Math.exp(-(start * start) * invTwoSigma2)
	let step = Math.exp(-(2 * start + 1) * invTwoSigma2)
	const stepMul = Math.exp(-1 / (sigma * sigma))
	let sum = 0

	for (let index = minIndex; index <= maxIndex; index++) {
		sum += weight
		weight *= step
		step *= stepMul
	}

	return sum
}

// Computes the sampled circular Gaussian mass over the plotted support.
function circularGaussianDiscreteSum(minX: number, maxX: number, minY: number, maxY: number, centerX: number, centerY: number, sigma: number) {
	return gaussian1DDiscreteSum(minX, maxX, centerX, sigma) * gaussian1DDiscreteSum(minY, maxY, centerY, sigma)
}

// Computes the sampled elliptical Gaussian mass over the plotted support.
function ellipticalGaussianDiscreteSum(minX: number, maxX: number, minY: number, maxY: number, centerX: number, centerY: number, sigmaX: number, sigmaY: number, theta: number) {
	const [a, b, c] = gaussianQuadraticTerms(sigmaX, sigmaY, theta)
	const xStart = minX - centerX
	const delta2a = 2 * a
	const stepMul = Math.exp(-a)
	let sum = 0

	for (let py = minY; py <= maxY; py++) {
		const dy = py - centerY
		let dq = a * (2 * xStart + 1) + b * dy
		let weight = Math.exp(-0.5 * (a * xStart * xStart + b * xStart * dy + c * dy * dy))
		let step = Math.exp(-0.5 * dq)

		for (let px = minX; px <= maxX; px++) {
			sum += weight
			weight *= step
			step *= stepMul
			dq += delta2a
		}
	}

	return sum
}

// Computes the sampled Moffat mass over the plotted support.
function moffatDiscreteSum(minX: number, maxX: number, minY: number, maxY: number, centerX: number, centerY: number, alphaX: number, alphaY: number, theta: number, beta: number) {
	const [a, b, c] = moffatQuadraticTerms(alphaX, alphaY, theta)
	const xStart = minX - centerX
	let sum = 0

	for (let py = minY; py <= maxY; py++) {
		const dy = py - centerY
		let q = a * xStart * xStart + b * xStart * dy + c * dy * dy
		let dq = a * (2 * xStart + 1) + b * dy

		for (let px = minX; px <= maxX; px++) {
			sum += 1 / (1 + q) ** beta
			q += dq
			dq += 2 * a
		}
	}

	return sum
}

function sanitizePositive(value: number | undefined, fallback: number) {
	return Number.isFinite(value) && value! > 0 ? value! : fallback
}

function sanitizeSigned(value: number | undefined, fallback: number) {
	return Number.isFinite(value) ? value! : fallback
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number) {
	return clamp(sanitizeSigned(value, fallback), min, max)
}
