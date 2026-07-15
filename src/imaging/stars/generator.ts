import { clamp, lerp } from '../../math/numerical/math'
import type { ImageRawType } from '../model/types'

// Synthetic star renderer: plots a realistic stellar profile into a raw pixel buffer, modeling the
// point-spread function (Gaussian or Moffat), elongation/orientation, defocus, an optional halo, sub-
// pixel jitter, color (from a B-V style color index), gain, and saturation. Intensities use the
// normalized [0, 1] pixel scale; geometry is in pixels. Used by the synthetic image generator.

// Point-spread-function shape used to render a star.
export type StarPsfModel = 'gaussian' | 'moffat'

// Options controlling how a single star is plotted.
export interface PlotStarOptions {
	// Background level added under the star, 0..1.
	readonly background?: number
	// Pixel value at which the star saturates (clips), 0..1.
	readonly saturationLevel?: number
	// Current focuser position; combined with bestFocus to defocus the star.
	readonly focusStep?: number
	// Focuser position of best focus.
	readonly bestFocus?: number
	// Focuser travel over which the star fully defocuses.
	readonly maxFocusStep?: number
	// Multiplier on the star's peak intensity.
	readonly peakScale?: number
	// Elongation (0 = round, toward 1 = elongated).
	readonly ellipticity?: number
	// Orientation of the elongation, radians.
	readonly theta?: number
	// Soft-core radius flattening the very center, pixels.
	readonly softCore?: number
	// PSF model selector.
	readonly psfModel?: StarPsfModel
	// Moffat beta parameter (wing steepness).
	readonly beta?: number
	// Strength of the optional extended halo, 0..1.
	readonly haloStrength?: number
	// Radial scale of the halo relative to the core.
	readonly haloScale?: number
	// Sub-pixel centroid offset in x, pixels.
	readonly jitterX?: number
	// Sub-pixel centroid offset in y, pixels.
	readonly jitterY?: number
	// Multiplicative gain applied to the rendered flux.
	readonly gain?: number
	// Gamma applied to the color weights, or false to skip color compensation.
	readonly gammaCompensation?: number | false
	// Hint of the additive noise level, used to taper the faint wings.
	readonly additiveNoiseHint?: number
	// Minimum plotted box half-width, pixels.
	readonly minPlotRadius?: number
	// Maximum plotted box half-width, pixels.
	readonly maxPlotRadius?: number
	// Plot cutoff in sigma units beyond which pixels are skipped.
	readonly cutoffSigma?: number
}

// Per-star PSF changes already expressed in the output image coordinate system.
export interface StarPsfModifiers {
	// X scale applied to the complete base PSF before additive covariance, normally 1/binX.
	readonly scaleX?: number
	// Y scale applied to the complete base PSF before additive covariance, normally 1/binY.
	readonly scaleY?: number
	// Overrides the global normalized defocus amount for this star, clamped to 0..1.
	readonly defocus?: number
	// Additive Gaussian covariance xx component, in output pixel squared.
	readonly covarianceXX?: number
	// Additive Gaussian covariance xy component, in output pixel squared.
	readonly covarianceXY?: number
	// Additive Gaussian covariance yy component, in output pixel squared.
	readonly covarianceYY?: number
	// Normalized asymmetric coma strength, 0..1.
	readonly coma?: number
	// Coma direction in image coordinates, radians clockwise because Y grows downward.
	readonly comaTheta?: number
}

// sqrt(2 ln 2): half-width-at-half-maximum factor relating FWHM and Gaussian sigma.
const SQRT_TWO_LN_TWO = 1.1774100225154747
// Converts a half-flux diameter to the equivalent Gaussian sigma.
const HFD_TO_SIGMA = 1 / (2 * SQRT_TWO_LN_TWO)
// Default B-V color index (Sun-like) when none is supplied.
const DEFAULT_COLOR_INDEX = 0.65
// Minimum half-flux diameter, pixels.
const MIN_HFD = 0.35
// Minimum Gaussian sigma, pixels.
const MIN_SIGMA = 0.18
// Minimum minor/major axis ratio (caps elongation).
const MIN_AXIS_RATIO = 0.2
// Default Moffat beta parameter.
const DEFAULT_BETA = 2.5
// Default halo radial scale.
const DEFAULT_HALO_SCALE = 2.8
// Default minimum plot box half-width, pixels.
const DEFAULT_MIN_RADIUS = 2
// Default maximum plot box half-width, pixels.
const DEFAULT_MAX_RADIUS = 24
// Default plot cutoff, in sigma units.
const DEFAULT_CUTOFF_SIGMA = 4.25
// Below this ellipticity the round (faster) rendering path is used.
const FAST_PATH_ELLIPTICITY_EPSILON = 1e-6
// Upper bound on focuser travel used in defocus computations.
const MAX_FOCUS_STEP = 100000
// Maximum half-width of the plotted box, in units of the steepest Gaussian scale. Beyond this the
// incremental exp() recurrence seed exp(-0.5 * n^2) underflows (n^2 / 2 > ~745) and the row march
// breaks down; the dropped pixels carry less than exp(-648) of the star flux, so capping is lossless.
const SAFE_RADIUS_SIGMA = 36

// Lookup table mapping a B-V color index to [colorIndex, redWeight, greenWeight, blueWeight];
// interpolated to convert star color into RGB channel scaling.
const COLOR_INDEX_LUT = [
	[-0.4, 0.72, 0.86, 1.42],
	[0, 0.9, 0.98, 1.12],
	[0.45, 1, 1, 1],
	[0.9, 1.18, 0.97, 0.78],
	[1.4, 1.34, 0.9, 0.56],
	[2, 1.42, 0.82, 0.42],
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

// Converts a non-negative half-flux diameter in pixels to the standard deviation of an equivalent
// circular Gaussian. Invalid and negative diameters produce zero.
export function gaussianSigmaFromHfd(hfd: number): number {
	return Math.max(0, sanitizePositive(hfd, 0) * HFD_TO_SIGMA)
}

// Converts HFD and seeing terms, both treated as HFD-like diameters in pixels, into one effective Gaussian sigma.
export function effectiveGaussianSigma(hfd: number, seeing: number = 0, snr: number = 0, softCore: number = 0, additiveNoiseHint: number = 0, peakScale: number = 1, background: number = 0) {
	const hfdSigma = Math.max(MIN_SIGMA, sanitizePositive(hfd, MIN_HFD) * HFD_TO_SIGMA)
	const seeingSigma = gaussianSigmaFromHfd(seeing)
	const combinedSigma = Math.hypot(hfdSigma, seeingSigma)
	const lowSnr = 1 - clamp(sanitizePositive(snr, 0) / 32, 0, 1)
	const noiseSoftening = clamp(sanitizePositive(additiveNoiseHint, 0) * 0.04, 0, 0.2)
	const backgroundSoftening = clamp(sanitizePositive(background, 0) * 4, 0, 0.2)
	const softCoreFactor = 1 + clamp(sanitizePositive(softCore, 0), 0, 4) * 0.12 + lowSnr * 0.18 + noiseSoftening + backgroundSoftening
	const concentration = Math.sqrt(clamp(sanitizePositive(peakScale, 1), 0.25, 4))
	return Math.max(MIN_SIGMA, (combinedSigma * softCoreFactor) / concentration)
}

// Maps focusStep and bestFocus into a normalized defocus amount in the [0, 1] range.
export function focusDefocusAmount(focusStep?: number, bestFocus?: number, maxFocusStep: number = MAX_FOCUS_STEP) {
	if (bestFocus === focusStep || bestFocus === 0) return 0
	if (!Number.isFinite(focusStep) || !Number.isFinite(bestFocus)) return 0
	if (!Number.isFinite(maxFocusStep) || maxFocusStep <= 0 || maxFocusStep > MAX_FOCUS_STEP) maxFocusStep = MAX_FOCUS_STEP
	const focus = clamp(focusStep!, 0, maxFocusStep)
	const best = clamp(bestFocus!, 0, maxFocusStep)
	const maxOffset = Math.max(best, maxFocusStep - best, 1)
	return clamp(Math.abs(focus - best) / maxOffset, 0, 1)
}

// Plots one synthetic star into an existing ImageRawType image buffer.
export function plotStar(raw: ImageRawType, width: number, height: number, channels: 1 | 3, x: number, y: number, flux: number, hfd: number, snr: number, seeing: number, colorIndex?: number, options: PlotStarOptions = {}, modifiers?: StarPsfModifiers) {
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
	const globalDefocus = focusDefocusAmount(options.focusStep, options.bestFocus, options.maxFocusStep)
	const defocus = modifiers?.defocus === undefined ? globalDefocus : clamp(sanitizePositive(modifiers.defocus, 0), 0, 1)
	const effectiveSoftCore = (options.softCore ?? 0) + defocus * 3.2
	const effectivePeakScale = Math.max(0.2, peakScale / (1 + defocus * 1.4))
	const sigma = effectiveGaussianSigma(hfd, seeing, snr, effectiveSoftCore, options.additiveNoiseHint ?? 0, effectivePeakScale, background) * (1 + defocus * defocus * 2.4)
	const lowSnr = 1 - clamp(sanitizePositive(snr, 0) / 32, 0, 1)
	const haloVisibility = 1 - lowSnr * 0.5 - clamp(background * 2, 0, 0.25)
	const haloStrength = Math.max(0, (sanitizePositive(options.haloStrength, 0) + defocus * defocus * 0.24) * Math.max(0, haloVisibility))
	const haloScale = clamp(sanitizePositive(options.haloScale, DEFAULT_HALO_SCALE) * (1 + defocus * 0.6), 1.1, 10)
	const globalEllipticity = clamp(sanitizePositive(options.ellipticity, 0), 0, 1 - MIN_AXIS_RATIO)
	const globalAxisRatioSqrt = Math.sqrt(1 - globalEllipticity)
	const baseMajorSigma = sigma / globalAxisRatioSqrt
	const baseMinorSigma = sigma * globalAxisRatioSqrt
	const globalTheta = sanitizeSigned(options.theta, 0)
	const scaleX = sanitizePositive(modifiers?.scaleX, 1)
	const scaleY = sanitizePositive(modifiers?.scaleY, 1)
	const localCovarianceXX = sanitizePositive(modifiers?.covarianceXX, 0)
	const localCovarianceXY = sanitizeSigned(modifiers?.covarianceXY, 0)
	const localCovarianceYY = sanitizePositive(modifiers?.covarianceYY, 0)
	let majorSigma = baseMajorSigma * scaleX
	let minorSigma = baseMinorSigma * scaleY
	let theta = globalEllipticity > FAST_PATH_ELLIPTICITY_EPSILON ? globalTheta : 0

	if (Math.abs(scaleX - scaleY) > Number.EPSILON || localCovarianceXX > 0 || Math.abs(localCovarianceXY) > Number.EPSILON || localCovarianceYY > 0) {
		const cosGlobalTheta = Math.cos(globalTheta)
		const sinGlobalTheta = Math.sin(globalTheta)
		const baseMajorVariance = baseMajorSigma * baseMajorSigma
		const baseMinorVariance = baseMinorSigma * baseMinorSigma
		const covarianceXX = (baseMajorVariance * cosGlobalTheta * cosGlobalTheta + baseMinorVariance * sinGlobalTheta * sinGlobalTheta) * scaleX * scaleX + localCovarianceXX
		const covarianceXY = (baseMajorVariance - baseMinorVariance) * cosGlobalTheta * sinGlobalTheta * scaleX * scaleY + localCovarianceXY
		const covarianceYY = (baseMajorVariance * sinGlobalTheta * sinGlobalTheta + baseMinorVariance * cosGlobalTheta * cosGlobalTheta) * scaleY * scaleY + localCovarianceYY
		const halfDifference = (covarianceXX - covarianceYY) * 0.5
		const discriminant = Math.hypot(halfDifference, covarianceXY)
		const halfTrace = Math.max(MIN_SIGMA * MIN_SIGMA, (covarianceXX + covarianceYY) * 0.5)
		majorSigma = Math.sqrt(Math.max(MIN_SIGMA * MIN_SIGMA, halfTrace + discriminant))
		minorSigma = Math.sqrt(Math.max(MIN_SIGMA * MIN_SIGMA, halfTrace - discriminant))
		theta = discriminant > Number.EPSILON ? 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY) : 0
	}
	const psfModel = options.psfModel === 'moffat' ? 'moffat' : 'gaussian'
	const beta = Math.max(1.05, sanitizePositive(options.beta, DEFAULT_BETA))
	const saturationEnabled = options.saturationLevel !== undefined && Number.isFinite(options.saturationLevel)
	const saturationLevel = saturationEnabled ? Math.max(0, options.saturationLevel) : 0
	const cutoffSigma = clamp(sanitizePositive(options.cutoffSigma, DEFAULT_CUTOFF_SIGMA), 2.5, 7)
	const minPlotRadius = Math.max(0, sanitizePositive(options.minPlotRadius, DEFAULT_MIN_RADIUS))
	const maxPlotRadius = Math.max(minPlotRadius, sanitizePositive(options.maxPlotRadius, DEFAULT_MAX_RADIUS))
	const coma = clamp(sanitizePositive(modifiers?.coma, 0), 0, 1)

	if (coma <= 0) return plotStarComponent(raw, width, height, channels, centerX, centerY, totalFlux, majorSigma, minorSigma, theta, colorIndex, lowSnr, haloStrength, haloScale, psfModel, beta, saturationEnabled, saturationLevel, cutoffSigma, minPlotRadius, maxPlotRadius, options.gammaCompensation)

	const comaTheta = sanitizeSigned(modifiers?.comaTheta, 0)
	const geometricSigma = Math.sqrt(majorSigma * minorSigma)
	const separation = geometricSigma * (0.75 + coma * 2.25)
	const tailFraction = coma * 0.3
	const coreFraction = 1 - tailFraction
	const offsetX = Math.cos(comaTheta) * separation
	const offsetY = Math.sin(comaTheta) * separation
	const coreRendered = plotStarComponent(
		raw,
		width,
		height,
		channels,
		centerX - tailFraction * offsetX,
		centerY - tailFraction * offsetY,
		totalFlux * coreFraction,
		majorSigma,
		minorSigma,
		theta,
		colorIndex,
		lowSnr,
		haloStrength,
		haloScale,
		psfModel,
		beta,
		saturationEnabled,
		saturationLevel,
		cutoffSigma,
		minPlotRadius,
		maxPlotRadius,
		options.gammaCompensation,
	)
	const tailScale = 1 + coma * 1.5
	const tailRendered = plotStarComponent(
		raw,
		width,
		height,
		channels,
		centerX + coreFraction * offsetX,
		centerY + coreFraction * offsetY,
		totalFlux * tailFraction,
		majorSigma * tailScale,
		minorSigma * tailScale,
		theta,
		colorIndex,
		lowSnr,
		haloStrength,
		haloScale,
		psfModel,
		beta,
		saturationEnabled,
		saturationLevel,
		cutoffSigma,
		minPlotRadius,
		maxPlotRadius,
		options.gammaCompensation,
	)
	return coreRendered || tailRendered
}

// Renders one symmetric Gaussian or Moffat component with discrete flux normalization.
function plotStarComponent(
	raw: ImageRawType,
	width: number,
	height: number,
	channels: 1 | 3,
	centerX: number,
	centerY: number,
	totalFlux: number,
	majorSigma: number,
	minorSigma: number,
	theta: number,
	colorIndex: number | undefined,
	lowSnr: number,
	haloStrength: number,
	haloScale: number,
	psfModel: StarPsfModel,
	beta: number,
	saturationEnabled: boolean,
	saturationLevel: number,
	cutoffSigma: number,
	minPlotRadius: number,
	maxPlotRadius: number,
	gammaCompensation?: number | false,
) {
	if (totalFlux <= 0 || !Number.isFinite(centerX) || !Number.isFinite(centerY)) return false
	const geometricSigma = Math.sqrt(majorSigma * minorSigma)
	const axisRatio = clamp(minorSigma / majorSigma, MIN_AXIS_RATIO, 1)
	const ellipticity = 1 - axisRatio
	const axisRatioSqrt = Math.sqrt(axisRatio)
	const haloSigma = geometricSigma * haloScale
	const haloMajorSigma = haloStrength > 0 ? haloSigma / axisRatioSqrt : 0
	const haloMinorSigma = haloStrength > 0 ? haloSigma * axisRatioSqrt : 0
	const wingsScale = psfModel === 'moffat' ? 1.35 : 1
	const sigmaExtent = Math.max(majorSigma, haloMajorSigma)
	// Smallest Gaussian scale evaluated by the incremental exponential recurrence used in the
	// plotting loops. Each row seeds the recurrence at the box edge as exp(-0.5 * (edge/scale)^2);
	// far enough into the tail that seed underflows to 0, and the multiplicative march then
	// collapses the whole row to 0 or NaN (0 * overflowing step), erasing even the core. Cap the
	// radius at SAFE_RADIUS_SIGMA scales so the edge seed stays representable. The Moffat core is
	// evaluated additively and never underflows, so only its optional Gaussian halo constrains it.
	const haloScaleMinor = haloStrength > 0 ? haloMinorSigma : Number.POSITIVE_INFINITY
	const recurrenceScale = psfModel === 'moffat' ? haloScaleMinor : Math.min(minorSigma, haloScaleMinor)
	const safeRadius = Number.isFinite(recurrenceScale) ? Math.max(1, Math.floor(SAFE_RADIUS_SIGMA * recurrenceScale)) : Number.POSITIVE_INFINITY
	const radius = Math.min(Math.ceil(clamp(cutoffSigma * wingsScale * sigmaExtent * (1 - lowSnr * 0.08), minPlotRadius, maxPlotRadius)), safeRadius)
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
		const coreAmplitude = coreFlux / Math.max(Number.EPSILON, circularGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, geometricSigma))
		const haloAmplitude = haloFlux > 0 ? haloFlux / Math.max(Number.EPSILON, circularGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, haloSigma)) : 0

		if (channels === 1) {
			plotCircularGaussianMono(raw, width, minX, maxX, minY, maxY, centerX, centerY, geometricSigma, coreAmplitude, haloSigma, haloAmplitude, saturationEnabled, saturationLevel)
		} else {
			const [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(colorIndex, gammaCompensation)
			plotCircularGaussianRgb(raw, width, minX, maxX, minY, maxY, centerX, centerY, geometricSigma, coreAmplitude, haloSigma, haloAmplitude, redWeight, greenWeight, blueWeight, saturationEnabled, saturationLevel)
		}

		return true
	}

	if (psfModel === 'gaussian') {
		const coreAmplitude = coreFlux / Math.max(Number.EPSILON, ellipticalGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, majorSigma, minorSigma, theta))
		const haloAmplitude = haloFlux > 0 ? haloFlux / Math.max(Number.EPSILON, ellipticalGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, haloMajorSigma, haloMinorSigma, theta)) : 0

		if (channels === 1) {
			plotEllipticalGaussianMono(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorSigma, minorSigma, theta, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, saturationEnabled, saturationLevel)
		} else {
			const [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(colorIndex, gammaCompensation)
			plotEllipticalGaussianRgb(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorSigma, minorSigma, theta, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, redWeight, greenWeight, blueWeight, saturationEnabled, saturationLevel)
		}

		return true
	}

	const effectiveHfd = geometricSigma / HFD_TO_SIGMA
	const baseAlpha = moffatAlphaFromHfd(effectiveHfd, beta)
	const majorAlpha = baseAlpha / axisRatioSqrt
	const minorAlpha = baseAlpha * axisRatioSqrt
	const coreAmplitude = coreFlux / Math.max(Number.EPSILON, moffatDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, majorAlpha, minorAlpha, theta, beta))
	const haloAmplitude = haloFlux > 0 ? haloFlux / Math.max(Number.EPSILON, ellipticalGaussianDiscreteSum(plotMinX, plotMaxX, plotMinY, plotMaxY, centerX, centerY, haloMajorSigma, haloMinorSigma, theta)) : 0

	if (channels === 1) {
		plotMoffatMono(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorAlpha, minorAlpha, theta, beta, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, saturationEnabled, saturationLevel)
	} else {
		const [redWeight, greenWeight, blueWeight] = colorIndexToRgbWeights(colorIndex, gammaCompensation)
		plotMoffatRgb(raw, width, minX, maxX, minY, maxY, centerX, centerY, majorAlpha, minorAlpha, theta, beta, coreAmplitude, haloMajorSigma, haloMinorSigma, haloAmplitude, redWeight, greenWeight, blueWeight, saturationEnabled, saturationLevel)
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

// Returns `value` when it is finite and positive, otherwise `fallback`.
function sanitizePositive(value: number | undefined, fallback: number) {
	return Number.isFinite(value) && value! > 0 ? value! : fallback
}

// Returns `value` when it is finite (any sign), otherwise `fallback`.
function sanitizeSigned(value: number | undefined, fallback: number) {
	return Number.isFinite(value) ? value! : fallback
}

// Returns `value` (or `fallback` if non-finite) clamped to [min, max].
function clampFinite(value: number | undefined, fallback: number, min: number, max: number) {
	return clamp(sanitizeSigned(value, fallback), min, max)
}
