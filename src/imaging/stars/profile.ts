import { medianOf } from '../../core/util'
import type { Point } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import type { Angle } from '../../math/units/angle'
import type { Image, ImageChannelOrGray } from '../model/types'
import { grayscale } from '../processing/geometry'
import { type DetectStarOptions, detectStars } from './detector'
import { createMoffatFitWorkspace, fitEllipticalMoffat, type MoffatFitWorkspace, type MoffatProfileFit } from './profile.moffat'
import { starMomentShape } from './shape'

// Robust moment-based and optional Moffat optical star profiles measured from grayscale apertures.
// The functions return fresh result objects, never mutate the input image, and use pixels and radians.

// Full width at half maximum of a unit-variance Gaussian, in pixels per standard deviation.
const GAUSSIAN_FWHM_FACTOR = 2 * Math.sqrt(2 * Math.LN2)
// Width of the radial bins used to approximate the curve-of-growth HFD, in pixels.
const HFD_BIN_WIDTH = 0.25
// Default initial circular aperture radius, in pixels.
const DEFAULT_INITIAL_RADIUS = 4
// Default maximum circular aperture radius, in pixels.
const DEFAULT_MAXIMUM_RADIUS = 32
// Default maximum number of centroid/ROI refinement passes.
const DEFAULT_MAX_ITERATIONS = 3
// Default saturation threshold for normalized image samples.
const DEFAULT_SATURATION_LEVEL = 1
// Default minimum SNR required for a profile to be valid.
const DEFAULT_MIN_SNR = 3
// Default distance from an image edge at which a profile is marked near-border, in pixels.
const DEFAULT_BORDER_MARGIN = 4
// Default allowed fraction of saturated signal-aperture samples.
const DEFAULT_MAXIMUM_SATURATED_FRACTION = 0
// Largest permitted positive signal fraction in the outer one-pixel aperture band before growing the ROI.
const OUTER_FLUX_FRACTION = 0.01
// Minimum eccentricity that makes a major-axis direction meaningful.
const MIN_ORIENTATION_ECCENTRICITY = 0.05
// Secondary local-maximum peak ratio used as a conservative blended-profile warning.
const BLEND_PEAK_RATIO = 0.25

// Identifies the implemented profile model.
export type StarProfileModel = 'moments' | 'moffat'

// Marks a measurement condition that can reduce confidence or invalidate a star profile.
export type StarProfileFlag = 'nonFinite' | 'nearBorder' | 'clipped' | 'saturated' | 'lowSignal' | 'invalidBackground' | 'invalidCentroid' | 'degenerateShape' | 'blended' | 'poorFit'

// Describes one attempt to measure an optical star profile from image samples.
export interface StarProfile extends Readonly<Point> {
	// Index of the supplied candidate when measured as part of a batch.
	readonly sourceIndex?: number
	// Whether the mandatory profile measurements passed finite, signal, saturation, and clipping checks.
	readonly valid: boolean
	// Integrated positive flux above the local background, in image sample units.
	readonly flux?: number
	// Signal-to-noise ratio estimated from flux and robust local background deviation.
	readonly snr?: number
	// Curve-of-growth half-flux diameter, in pixels, with at most one radial-bin diameter of quantization error.
	readonly hfd?: number
	// Geometric-mean Gaussian-equivalent FWHM, in pixels.
	readonly fwhm?: number
	// Gaussian-equivalent FWHM along the major principal axis, in pixels.
	readonly major?: number
	// Gaussian-equivalent FWHM along the minor principal axis, in pixels.
	readonly minor?: number
	// Shape eccentricity from 0 for round stars toward 1 for elongated stars.
	readonly eccentricity?: number
	// Major/minor Gaussian-equivalent axis ratio, at least 1.
	readonly elongation?: number
	// Major-axis orientation in [0, PI), clockwise in image coordinates because Y grows downward.
	readonly theta?: Angle
	// Robust local background median in image sample units.
	readonly background?: number
	// Robust local background deviation estimated from scaled MAD in image sample units.
	readonly deviation?: number
	// Largest measured signal sample above background in image sample units.
	readonly peak?: number
	// Normalized profile quality from 0 to 1 after applying measurement flags.
	readonly quality: number
	// Measurement model used for this profile.
	readonly model: StarProfileModel
	// Moffat fit diagnostics when that model was explicitly requested, including failed fallback attempts.
	readonly moffat?: MoffatProfileFit
	// Stable flags describing degraded or invalid measurement conditions.
	readonly flags: readonly StarProfileFlag[]
}

// Configures robust moment measurement and an optional single-component elliptical Moffat refinement.
export interface MeasureStarProfileOptions {
	// Requested profile model; `moffat` falls back to moments when its nonlinear fit is rejected.
	readonly model?: StarProfileModel
	// Image channel or grayscale coefficients used for color inputs.
	readonly channel?: ImageChannelOrGray
	// Initial signal-aperture radius in pixels.
	readonly initialRadius?: number
	// Maximum signal-aperture radius in pixels.
	readonly maximumRadius?: number
	// Maximum number of centroid/ROI refinement passes.
	readonly maxIterations?: number
	// Sample value considered saturated in the grayscale image scale.
	readonly saturationLevel?: number
	// Minimum SNR required for `valid` to be true.
	readonly minSNR?: number
	// Minimum distance from an image edge before adding `nearBorder`, in pixels.
	readonly borderMargin?: number
	// Largest accepted saturated-sample fraction within the signal aperture.
	readonly maximumSaturatedFraction?: number
}

// Stores reusable per-batch numeric buffers, avoiding per-pixel object allocation.
interface ProfileScratch {
	// Samples collected from a background annulus before sorting for the median.
	ring: Float64Array
	// Absolute background deviations before sorting for MAD.
	deviations: Float64Array
	// Flux accumulated by radial HFD bin.
	bins: Float64Array
	// Fixed-size workspace reused by optional Moffat fits.
	readonly moffat: MoffatFitWorkspace
}

// Stores the robust local background estimated in an annulus around a candidate.
interface BackgroundEstimate {
	// Median background in image sample units.
	readonly background: number
	// Scaled MAD background deviation in image sample units.
	readonly deviation: number
	// Whether a non-finite source sample was ignored.
	readonly nonFinite: boolean
}

// Stores moment and curve-of-growth measurements for one refined signal aperture.
interface SignalMeasurement {
	// Refined flux-weighted centroid X coordinate, in pixels.
	readonly x: number
	// Refined flux-weighted centroid Y coordinate, in pixels.
	readonly y: number
	// Integrated positive signal flux in image sample units.
	readonly flux: number
	// Signal-to-noise ratio.
	readonly snr: number
	// Curve-of-growth HFD in pixels.
	readonly hfd: number
	// Major principal-axis variance in pixels squared, when finite.
	readonly majorVariance?: number
	// Minor principal-axis variance in pixels squared, when finite.
	readonly minorVariance?: number
	// Eccentricity derived from the central moments, when finite.
	readonly eccentricity?: number
	// Major/minor ratio derived from the central moments, when finite.
	readonly elongation?: number
	// Major-axis orientation in [0, PI), when the moments are non-degenerate.
	readonly theta?: Angle
	// Brightest signal sample above background in image sample units.
	readonly peak: number
	// Fraction of aperture samples at or above the saturation threshold.
	readonly saturatedFraction: number
	// Positive signal in the outer one-pixel aperture band in image sample units.
	readonly outerFlux: number
	// Whether a non-finite signal-aperture sample was ignored.
	readonly nonFinite: boolean
}

// Normalizes options to finite values that preserve the profile API's pixel and sample conventions.
function resolveOptions(options: MeasureStarProfileOptions): Required<Omit<MeasureStarProfileOptions, 'channel'>> {
	const initialRadius = finitePositive(options.initialRadius, DEFAULT_INITIAL_RADIUS)
	const maximumRadius = Math.max(initialRadius, finitePositive(options.maximumRadius, DEFAULT_MAXIMUM_RADIUS))

	return {
		model: options.model === 'moffat' ? 'moffat' : 'moments',
		initialRadius,
		maximumRadius,
		maxIterations: Math.max(1, Math.trunc(finitePositive(options.maxIterations, DEFAULT_MAX_ITERATIONS))),
		saturationLevel: finitePositive(options.saturationLevel, DEFAULT_SATURATION_LEVEL),
		minSNR: Math.max(0, finiteNumber(options.minSNR, DEFAULT_MIN_SNR)),
		borderMargin: Math.max(0, finiteNumber(options.borderMargin, DEFAULT_BORDER_MARGIN)),
		maximumSaturatedFraction: clamp(finiteNumber(options.maximumSaturatedFraction, DEFAULT_MAXIMUM_SATURATED_FRACTION), 0, 1),
	}
}

// Returns a finite positive value or the requested fallback.
function finitePositive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

// Returns a finite numeric value or the requested fallback.
function finiteNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback
}

// Extends a typed scratch buffer when the requested capacity exceeds its current length.
function ensureCapacity(buffer: Float64Array, capacity: number): Float64Array {
	return buffer.length >= capacity ? buffer : new Float64Array(capacity)
}

// Adds a flag only once while preserving deterministic insertion order.
function addFlag(flags: StarProfileFlag[], flag: StarProfileFlag): void {
	if (!flags.includes(flag)) flags.push(flag)
}

// Constructs a finite, discriminated failed profile without leaking NaN coordinates or measurements.
function failedProfile(star: Readonly<Point>, flags: readonly StarProfileFlag[], sourceIndex?: number): StarProfile {
	return {
		x: Number.isFinite(star.x) ? star.x : 0,
		y: Number.isFinite(star.y) ? star.y : 0,
		sourceIndex,
		valid: false,
		quality: 0,
		model: 'moments',
		flags,
	}
}

// Estimates local background from an annulus outside the current signal aperture using median and scaled MAD.
function estimateBackground(image: Image, x: number, y: number, radius: number, scratch: ProfileScratch): BackgroundEstimate | undefined {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const innerRadius = radius + 1
	const outerRadius = radius + 3
	const innerRadiusSq = innerRadius * innerRadius
	const outerRadiusSq = outerRadius * outerRadius
	const x0 = Math.max(0, Math.ceil(x - outerRadius))
	const y0 = Math.max(0, Math.ceil(y - outerRadius))
	const x1 = Math.min(width - 1, Math.floor(x + outerRadius))
	const y1 = Math.min(height - 1, Math.floor(y + outerRadius))
	const maximumSamples = Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1))
	scratch.ring = ensureCapacity(scratch.ring, maximumSamples)

	let count = 0
	let nonFinite = false

	for (let py = y0; py <= y1; py++) {
		const dy = py - y
		const dySq = dy * dy
		const row = py * stride

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			const distanceSq = dx * dx + dySq
			if (distanceSq < innerRadiusSq || distanceSq > outerRadiusSq) continue

			const value = raw[row + px]
			if (!Number.isFinite(value)) {
				nonFinite = true
				continue
			}

			scratch.ring[count++] = value
		}
	}

	if (count < 8) return undefined

	const ring = scratch.ring.subarray(0, count)
	const background = medianOf(ring.sort(), count)
	if (!Number.isFinite(background)) return undefined

	scratch.deviations = ensureCapacity(scratch.deviations, count)
	for (let i = 0; i < count; i++) scratch.deviations[i] = Math.abs(ring[i] - background)
	const deviations = scratch.deviations.subarray(0, count)
	const deviation = 1.4826 * medianOf(deviations.sort(), count)

	return Number.isFinite(deviation) ? { background, deviation, nonFinite } : undefined
}

// Measures a signal aperture, refines its centroid, and fills radial HFD bins around that centroid.
function measureSignal(image: Image, x: number, y: number, radius: number, background: number, deviation: number, saturationLevel: number, scratch: ProfileScratch): SignalMeasurement | undefined {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const radiusSq = radius * radius
	const x0 = Math.max(0, Math.ceil(x - radius))
	const y0 = Math.max(0, Math.ceil(y - radius))
	const x1 = Math.min(width - 1, Math.floor(x + radius))
	const y1 = Math.min(height - 1, Math.floor(y + radius))
	let flux = 0
	let weightedX = 0
	let weightedY = 0
	let aperturePixels = 0
	let nonFinite = false

	for (let py = y0; py <= y1; py++) {
		const dy = py - y
		const dySq = dy * dy
		const row = py * stride

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			if (dx * dx + dySq > radiusSq) continue
			aperturePixels++
			const value = raw[row + px]
			if (!Number.isFinite(value)) {
				nonFinite = true
				continue
			}
			const signal = value - background
			if (signal <= 0) continue
			flux += signal
			weightedX += signal * px
			weightedY += signal * py
		}
	}

	if (!(flux > 0) || aperturePixels === 0) return undefined

	const centroidX = weightedX / flux
	const centroidY = weightedY / flux
	if (!Number.isFinite(centroidX) || !Number.isFinite(centroidY)) return undefined

	const refinedX0 = Math.max(0, Math.ceil(centroidX - radius))
	const refinedY0 = Math.max(0, Math.ceil(centroidY - radius))
	const refinedX1 = Math.min(width - 1, Math.floor(centroidX + radius))
	const refinedY1 = Math.min(height - 1, Math.floor(centroidY + radius))
	const binCount = Math.ceil(radius / HFD_BIN_WIDTH) + 1
	scratch.bins = ensureCapacity(scratch.bins, binCount)
	scratch.bins.fill(0, 0, binCount)

	let refinedFlux = 0
	let momentXX = 0
	let momentXY = 0
	let momentYY = 0
	let peak = 0
	let saturated = 0
	let refinedAperturePixels = 0
	let outerFlux = 0
	const outerRadius = Math.max(0, radius - 1)
	const outerRadiusSq = outerRadius * outerRadius

	for (let py = refinedY0; py <= refinedY1; py++) {
		const dy = py - centroidY
		const dySq = dy * dy
		const row = py * stride

		for (let px = refinedX0; px <= refinedX1; px++) {
			const dx = px - centroidX
			const distanceSq = dx * dx + dySq
			if (distanceSq > radiusSq) continue
			refinedAperturePixels++
			const value = raw[row + px]
			if (!Number.isFinite(value)) {
				nonFinite = true
				continue
			}
			if (value >= saturationLevel) saturated++
			const signal = value - background
			if (signal <= 0) continue

			refinedFlux += signal
			momentXX += signal * dx * dx
			momentXY += signal * dx * dy
			momentYY += signal * dySq
			if (signal > peak) peak = signal
			if (distanceSq >= outerRadiusSq) outerFlux += signal
			const bin = Math.min(binCount - 1, Math.floor(Math.sqrt(distanceSq) / HFD_BIN_WIDTH))
			scratch.bins[bin] += signal
		}
	}

	if (!(refinedFlux > 0) || refinedAperturePixels === 0 || !Number.isFinite(peak)) return undefined

	const hfd = halfFluxDiameter(scratch.bins, binCount, refinedFlux)
	if (!Number.isFinite(hfd)) return undefined

	const shape = starMomentShape(momentXX / refinedFlux, momentXY / refinedFlux, momentYY / refinedFlux)
	const snr = refinedFlux / Math.sqrt(Math.max(refinedFlux + refinedAperturePixels * deviation * deviation, Number.EPSILON))

	return {
		x: centroidX,
		y: centroidY,
		flux: refinedFlux,
		snr,
		hfd,
		majorVariance: shape.majorVariance,
		minorVariance: shape.minorVariance,
		eccentricity: shape.eccentricity,
		elongation: shape.elongation,
		theta: shape.theta,
		peak,
		saturatedFraction: saturated / refinedAperturePixels,
		outerFlux,
		nonFinite,
	}
}

// Interpolates the radius enclosing half of the positive signal and returns its diameter in pixels.
function halfFluxDiameter(bins: Readonly<Float64Array>, count: number, flux: number): number {
	const halfFlux = 0.5 * flux
	let cumulative = 0

	for (let i = 0; i < count; i++) {
		const binFlux = bins[i]
		const next = cumulative + binFlux

		if (next >= halfFlux && binFlux > 0) {
			const fraction = clamp((halfFlux - cumulative) / binFlux, 0, 1)
			return 2 * (i + fraction) * HFD_BIN_WIDTH
		}

		cumulative = next
	}

	return Number.NaN
}

// Detects a separated secondary local maximum that makes the single-star aperture plausibly blended.
function hasSecondaryPeak(image: Image, x: number, y: number, radius: number, background: number, peak: number, minor: number | undefined): boolean {
	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const minimumPeak = peak * BLEND_PEAK_RATIO
	const separation = Math.max(1.5, 0.75 * (minor ?? 2))
	const separationSq = separation * separation
	const radiusSq = radius * radius
	const x0 = Math.max(1, Math.ceil(x - radius))
	const y0 = Math.max(1, Math.ceil(y - radius))
	const x1 = Math.min(width - 2, Math.floor(x + radius))
	const y1 = Math.min(height - 2, Math.floor(y + radius))

	for (let py = y0; py <= y1; py++) {
		const dy = py - y
		const row = py * stride

		for (let px = x0; px <= x1; px++) {
			const dx = px - x
			const distanceSq = dx * dx + dy * dy
			if (distanceSq <= separationSq || distanceSq > radiusSq) continue
			const value = raw[row + px]
			if (!Number.isFinite(value) || value - background < minimumPeak) continue

			let localMaximum = true
			for (let oy = -1; oy <= 1 && localMaximum; oy++) {
				const neighborRow = (py + oy) * stride
				for (let ox = -1; ox <= 1; ox++) {
					if (ox === 0 && oy === 0) continue
					if (raw[neighborRow + px + ox] > value) {
						localMaximum = false
						break
					}
				}
			}

			if (localMaximum) return true
		}
	}

	return false
}

// Converts a measured aperture into the public profile while applying deterministic quality flags.
function profileFromMeasurement(width: number, height: number, sourceIndex: number | undefined, reachedBorder: boolean, background: BackgroundEstimate, measurement: SignalMeasurement, options: Required<Omit<MeasureStarProfileOptions, 'channel'>>, flags: StarProfileFlag[]): StarProfile {
	if (background.nonFinite || measurement.nonFinite) addFlag(flags, 'nonFinite')
	if (measurement.x < options.borderMargin || measurement.y < options.borderMargin || measurement.x > width - 1 - options.borderMargin || measurement.y > height - 1 - options.borderMargin) addFlag(flags, 'nearBorder')
	if (measurement.saturatedFraction > options.maximumSaturatedFraction) addFlag(flags, 'saturated')
	if (measurement.snr < options.minSNR) addFlag(flags, 'lowSignal')

	const major = measurement.majorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(measurement.majorVariance) : undefined
	const minor = measurement.minorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(measurement.minorVariance) : undefined
	const fwhm = major !== undefined && minor !== undefined ? Math.sqrt(major * minor) : undefined
	const borderDistance = Math.min(measurement.x, measurement.y, width - 1 - measurement.x, height - 1 - measurement.y)
	if (reachedBorder && (measurement.outerFlux > measurement.flux * OUTER_FLUX_FRACTION || borderDistance < options.initialRadius || (major !== undefined && borderDistance < 0.5 * major))) addFlag(flags, 'clipped')

	if (major === undefined || minor === undefined || measurement.eccentricity === undefined || measurement.elongation === undefined) addFlag(flags, 'degenerateShape')

	const theta = measurement.eccentricity !== undefined && measurement.eccentricity >= MIN_ORIENTATION_ECCENTRICITY ? measurement.theta : undefined
	const invalid = flags.includes('nonFinite') || flags.includes('clipped') || flags.includes('saturated') || flags.includes('lowSignal')
	const quality = profileQuality(flags, invalid)

	return {
		x: measurement.x,
		y: measurement.y,
		sourceIndex,
		valid: !invalid,
		flux: measurement.flux,
		snr: measurement.snr,
		hfd: measurement.hfd,
		fwhm,
		major,
		minor,
		eccentricity: measurement.eccentricity,
		elongation: measurement.elongation,
		theta,
		background: background.background,
		deviation: background.deviation,
		peak: measurement.peak,
		quality,
		model: 'moments',
		flags,
	}
}

// Computes a bounded quality score from known non-fatal and fatal profile flags.
function profileQuality(flags: readonly StarProfileFlag[], invalid: boolean): number {
	if (invalid) return 0

	let quality = 1
	if (flags.includes('nearBorder')) quality *= 0.7
	if (flags.includes('blended')) quality *= 0.5
	if (flags.includes('degenerateShape')) quality *= 0.8
	if (flags.includes('poorFit')) quality *= 0.75
	return quality
}

// Applies an explicitly requested Moffat refinement or annotates a moment-profile fallback.
function refineWithMoffat(image: Image, radius: number, measurement: SignalMeasurement, background: BackgroundEstimate, options: Required<Omit<MeasureStarProfileOptions, 'channel'>>, flags: StarProfileFlag[], profile: StarProfile, workspace: MoffatFitWorkspace): StarProfile {
	if (options.model !== 'moffat') return profile
	const major = measurement.majorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(measurement.majorVariance) : undefined
	const minor = measurement.minorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(measurement.minorVariance) : undefined
	const moffat =
		major !== undefined && minor !== undefined
			? fitEllipticalMoffat(image, { x: measurement.x, y: measurement.y, radius, background: background.background, deviation: background.deviation, peak: measurement.peak, major, minor, theta: measurement.theta ?? 0, saturationLevel: options.saturationLevel }, workspace)
			: ({ success: false, reason: 'invalidInput', iterations: 0 } as const)

	if (!moffat.success) {
		addFlag(flags, 'poorFit')
		return { ...profile, quality: profileQuality(flags, !profile.valid), moffat, flags }
	}

	const fwhmFactor = 2 * Math.sqrt(2 ** (1 / moffat.beta) - 1)
	const fittedMajor = moffat.alphaMajor * fwhmFactor
	const fittedMinor = moffat.alphaMinor * fwhmFactor
	const elongation = fittedMajor / fittedMinor
	const eccentricity = Math.sqrt(Math.max(0, 1 - 1 / (elongation * elongation)))
	return { ...profile, x: moffat.centerX, y: moffat.centerY, fwhm: Math.sqrt(fittedMajor * fittedMinor), major: fittedMajor, minor: fittedMinor, eccentricity, elongation, theta: moffat.theta, model: 'moffat', moffat }
}

// Measures a profile from a grayscale image and an optional source index using one reusable scratch context.
function measureStarProfileFromGrayscale(image: Image, star: Readonly<Point>, options: Required<Omit<MeasureStarProfileOptions, 'channel'>>, sourceIndex: number | undefined, scratch: ProfileScratch): StarProfile {
	const { width, height, stride } = image.metadata
	if (!Number.isFinite(star.x) || !Number.isFinite(star.y) || width <= 0 || height <= 0 || stride < width || image.raw.length < stride * height) return failedProfile(star, ['nonFinite'], sourceIndex)

	const flags: StarProfileFlag[] = []
	let x = star.x
	let y = star.y
	let radius = options.initialRadius
	let finalBackground: BackgroundEstimate | undefined
	let finalMeasurement: SignalMeasurement | undefined
	let reachedBorder = false

	for (let iteration = 0; iteration < options.maxIterations; iteration++) {
		const background = estimateBackground(image, x, y, radius, scratch)
		if (!background) return failedProfile(star, ['invalidBackground'], sourceIndex)
		const measurement = measureSignal(image, x, y, radius, background.background, background.deviation, options.saturationLevel, scratch)
		if (!measurement) return failedProfile(star, ['lowSignal'], sourceIndex)

		const major = measurement.majorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(measurement.majorVariance) : undefined
		const minor = measurement.minorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(measurement.minorVariance) : undefined
		const fwhm = major !== undefined && minor !== undefined ? Math.sqrt(major * minor) : undefined
		const desiredRadius = fwhm !== undefined ? clamp(Math.ceil(Math.max(DEFAULT_INITIAL_RADIUS, fwhm * 2)), options.initialRadius, options.maximumRadius) : radius
		const settled = measurement.outerFlux <= measurement.flux * OUTER_FLUX_FRACTION
		reachedBorder ||= measurement.x - radius <= 0 || measurement.y - radius <= 0 || measurement.x + radius >= width - 1 || measurement.y + radius >= height - 1
		finalBackground = background
		finalMeasurement = measurement

		const shifted = Math.hypot(measurement.x - x, measurement.y - y)
		x = measurement.x
		y = measurement.y
		const nextRadius = !settled ? Math.min(options.maximumRadius, Math.max(desiredRadius, radius + 2)) : desiredRadius

		if (shifted <= 0.05 && nextRadius === radius) break
		radius = nextRadius
	}

	if (!finalBackground || !finalMeasurement) return failedProfile(star, ['invalidCentroid'], sourceIndex)

	const minor = finalMeasurement.minorVariance !== undefined ? GAUSSIAN_FWHM_FACTOR * Math.sqrt(finalMeasurement.minorVariance) : undefined
	if (hasSecondaryPeak(image, finalMeasurement.x, finalMeasurement.y, radius, finalBackground.background, finalMeasurement.peak, minor)) addFlag(flags, 'blended')

	const profile = profileFromMeasurement(width, height, sourceIndex, reachedBorder, finalBackground, finalMeasurement, options, flags)
	return refineWithMoffat(image, radius, finalMeasurement, finalBackground, options, flags, profile, scratch.moffat)
}

// Measures one star profile after converting a color image to grayscale when necessary.
export function measureStarProfile(image: Image, star: Readonly<Point>, options: MeasureStarProfileOptions = {}): StarProfile {
	const grayscaleImage = grayscale(image, options.channel)
	const scratch: ProfileScratch = { ring: new Float64Array(0), deviations: new Float64Array(0), bins: new Float64Array(0), moffat: createMoffatFitWorkspace() }
	return measureStarProfileFromGrayscale(grayscaleImage, star, resolveOptions(options), undefined, scratch)
}

// Measures profiles in input order and assigns each result its source candidate index.
export function measureStarProfiles(image: Image, stars: readonly Readonly<Point>[], options: MeasureStarProfileOptions = {}): StarProfile[] {
	const grayscaleImage = grayscale(image, options.channel)
	const resolved = resolveOptions(options)
	const scratch: ProfileScratch = { ring: new Float64Array(0), deviations: new Float64Array(0), bins: new Float64Array(0), moffat: createMoffatFitWorkspace() }
	const profiles = new Array<StarProfile>(stars.length)

	for (let i = 0; i < stars.length; i++) profiles[i] = measureStarProfileFromGrayscale(grayscaleImage, stars[i], resolved, i, scratch)

	return profiles
}

// Detects candidates with the existing fast detector and then measures robust optical profiles for them.
export function detectStarProfiles(image: Image, detectOptions: Partial<DetectStarOptions> = {}, profileOptions: MeasureStarProfileOptions = {}): StarProfile[] {
	const grayscaleImage = grayscale(image, profileOptions.channel)
	const stars = detectStars(grayscaleImage, detectOptions)
	return measureStarProfiles(grayscaleImage, stars, profileOptions)
}
