import { applyTransformToPoint, invertSimilarityTransform, type SimilarityTransform } from '../../src/astrometry/matching/star.matching'
import type { Image } from '../../src/imaging/model/types'
import type { DetectedStar } from '../../src/imaging/stars/detector'
import { Bitpix, type FitsHeader } from '../../src/io/formats/fits/fits'
import { mulberry32, normal } from '../../src/math/numerical/random'

// Seeded multi-filter acquisition fixtures for stacking and channel-composition tests. One sky field
// (stars and an emission nebula) is observed through broadband and narrowband filters on a mono
// sensor. Each light is rendered analytically in its own pixel grid from a known similarity transform
// to the reference grid, then degraded by vignetting, sky transparency, a dark pedestal, Gaussian
// noise, and optional cosmic-ray impulses. Samples are normalized full-scale units (DN / 65535) and
// pixel coordinates are zero-based centers with x right and y down.

// Filters a synthetic field can be observed through.
export type SyntheticFilter = 'R' | 'G' | 'B' | 'L' | 'Ha' | 'OIII' | 'SII'

// Every synthetic filter, broadband first.
export const SYNTHETIC_FILTERS: readonly SyntheticFilter[] = ['R', 'G', 'B', 'L', 'Ha', 'OIII', 'SII']

// Relative stellar continuum transmitted by each filter.
const STAR_RESPONSE: Readonly<Record<SyntheticFilter, number>> = { R: 1, G: 1, B: 0.8, L: 2.4, Ha: 0.12, OIII: 0.1, SII: 0.08 }

// Relative nebular emission transmitted by each filter: Ha passes R, OIII passes G and B.
const NEBULA_RESPONSE: Readonly<Record<SyntheticFilter, number>> = { R: 0.5, G: 0.2, B: 0.25, L: 0.8, Ha: 1, OIII: 0.55, SII: 0.3 }

// Sky background transmitted by each filter, normalized units per second.
const SKY_RESPONSE: Readonly<Record<SyntheticFilter, number>> = { R: 2e-4, G: 2e-4, B: 1.6e-4, L: 5e-4, Ha: 2e-5, OIII: 2e-5, SII: 2e-5 }

// One star of the field, in reference-grid pixels, with its broadband flux in normalized units per second.
export interface SyntheticStar {
	readonly x: number
	readonly y: number
	readonly flux: number
}

// The observed sky: reference raster size, stars, and an elliptical Gaussian nebula.
export interface SyntheticField {
	readonly width: number
	readonly height: number
	readonly stars: readonly SyntheticStar[]
	// Nebula center in reference-grid pixels and its peak emission, normalized units per second.
	readonly nebula: { readonly x: number; readonly y: number; readonly sigmaX: number; readonly sigmaY: number; readonly peak: number }
}

// Acquisition parameters of one light.
export interface SyntheticFrameOptions {
	readonly filter: SyntheticFilter
	// Seed of the noise and impulse draws of this light.
	readonly seed: number
	// Exposure time, seconds.
	readonly exposure?: number
	// Maps this light's pixels to reference-grid pixels; identity when absent.
	readonly toReference?: SimilarityTransform
	// Fraction of the signal reaching the sensor, 0..1; 1 is a clear sky.
	readonly transparency?: number
	// Star FWHM, pixels.
	readonly seeing?: number
	// Gaussian read noise, normalized units.
	readonly noise?: number
	// Number of single-pixel cosmic-ray impulses.
	readonly cosmicRays?: number
}

// One rendered light with its truth.
export interface SyntheticFrame {
	readonly image: Image
	// Star centers and fluxes in this light's pixels, as an ideal detector would report them.
	readonly stars: readonly DetectedStar[]
	readonly toReference: SimilarityTransform
	// Pixel indices hit by a cosmic ray.
	readonly cosmicRays: readonly number[]
}

// Calibration masters of the synthetic sensor, in normalized units.
export interface SyntheticMasters {
	// Pedestal plus dark current for the light exposure, hot pixels included.
	readonly dark: Image
	// Vignetting with mean 1, already corrected and normalized.
	readonly flat: Image
	// Pixel indices of the hot pixels.
	readonly hotPixels: readonly number[]
}

// Sensor settings shared by every synthetic frame, so calibration compatibility checks agree.
const SENSOR_HEADER: FitsHeader = { XBINNING: 1, YBINNING: 1, GAIN: 100, OFFSET: 50, 'CCD-TEMP': -10 }

// Constant bias pedestal, normalized units.
const PEDESTAL = 0.015

// Dark current, normalized units per second.
const DARK_RATE = 2e-6

// Creates a field of stars spread over the reference raster, deterministic for the seed.
export function syntheticField(width: number, height: number, starCount: number, seed: number): SyntheticField {
	const random = mulberry32(seed)
	const stars: SyntheticStar[] = []
	const margin = 6

	for (let i = 0; i < starCount; i++) {
		stars.push({ x: margin + random() * (width - 2 * margin), y: margin + random() * (height - 2 * margin), flux: 0.4 + random() * 1.6 })
	}

	return { width, height, stars, nebula: { x: width * 0.55, y: height * 0.45, sigmaX: width * 0.18, sigmaY: height * 0.12, peak: 4e-3 } }
}

// Builds a similarity transform rotating by `rotation` radians about the raster center, then shifting by (dx, dy) pixels.
export function syntheticTransform(field: SyntheticField, dx: number, dy: number, rotation: number = 0): SimilarityTransform {
	const a = Math.cos(rotation)
	const b = Math.sin(rotation)
	const cx = (field.width - 1) / 2
	const cy = (field.height - 1) / 2
	return { a, b, tx: cx - a * cx + b * cy + dx, ty: cy - b * cx - a * cy + dy, mirrored: false }
}

// Noise-free sky signal of a filter at a reference-grid position, normalized units per second.
function skySignal(field: SyntheticField, filter: SyntheticFilter, x: number, y: number) {
	const { nebula } = field
	const u = (x - nebula.x) / nebula.sigmaX
	const v = (y - nebula.y) / nebula.sigmaY
	return SKY_RESPONSE[filter] + NEBULA_RESPONSE[filter] * nebula.peak * Math.exp(-0.5 * (u * u + v * v))
}

// Adds a Gaussian star of total `flux` centered at (x, y) into a mono raster.
function addStar(raw: Float32Array, width: number, height: number, x: number, y: number, flux: number, fwhm: number) {
	const sigma = fwhm / 2.3548200450309493
	const radius = Math.ceil(4 * sigma)
	const norm = flux / (2 * Math.PI * sigma * sigma)

	for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(height - 1, Math.ceil(y + radius)); py++) {
		for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(width - 1, Math.ceil(x + radius)); px++) {
			const dx = px - x
			const dy = py - y
			raw[py * width + px] += norm * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
		}
	}
}

// Wraps a mono Float32 raster into an image with the given header.
function monoImage(width: number, height: number, raw: Float32Array, header: FitsHeader): Image {
	return {
		header: { SIMPLE: true, BITPIX: Bitpix.FLOAT, NAXIS: 2, NAXIS1: width, NAXIS2: height, ...SENSOR_HEADER, ...header },
		metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
		raw,
	}
}

// Vignetting factor at a pixel before normalization to mean 1.
function vignetting(width: number, height: number, x: number, y: number) {
	const u = (2 * x) / (width - 1) - 1
	const v = (2 * y) / (height - 1) - 1
	return 1 - 0.25 * (u * u + v * v)
}

// Creates the dark and flat masters of the synthetic sensor for an exposure in seconds.
export function syntheticMasters(field: SyntheticField, exposure: number, seed: number): SyntheticMasters {
	const { width, height } = field
	const random = mulberry32(seed)
	const dark = new Float32Array(width * height).fill(PEDESTAL + DARK_RATE * exposure)
	const hotPixels: number[] = []

	for (let i = 0; i < Math.max(1, Math.round(width * height * 5e-4)); i++) {
		const index = Math.floor(random() * width * height)
		dark[index] += 0.05 + random() * 0.1
		hotPixels.push(index)
	}

	const flat = new Float32Array(width * height)
	let sum = 0

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const value = vignetting(width, height, x, y)
			flat[y * width + x] = value
			sum += value
		}
	}

	const mean = sum / flat.length
	for (let i = 0; i < flat.length; i++) flat[i] /= mean

	return {
		dark: monoImage(width, height, dark, { IMAGETYP: 'Dark Frame', EXPTIME: exposure }),
		flat: monoImage(width, height, flat, { IMAGETYP: 'Flat Field' }),
		hotPixels,
	}
}

// Renders the noise-free, calibrated signal of a filter on the reference grid for an exposure in seconds.
export function syntheticTruth(field: SyntheticField, filter: SyntheticFilter, exposure: number, seeing: number = 3.5): Image {
	const { width, height } = field
	const raw = new Float32Array(width * height)

	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = skySignal(field, filter, x, y) * exposure
	for (const star of field.stars) addStar(raw, width, height, star.x, star.y, star.flux * STAR_RESPONSE[filter] * 1e-2 * exposure, seeing)

	return monoImage(width, height, raw, { IMAGETYP: 'Light Frame', FILTER: filter, EXPTIME: exposure })
}

// Renders one raw light: sky and stars in the light's own grid, attenuated by vignetting and
// transparency, plus the dark of `masters`, Gaussian noise, and cosmic-ray impulses.
export function syntheticLight(field: SyntheticField, masters: SyntheticMasters, options: SyntheticFrameOptions): SyntheticFrame {
	const { width, height } = field
	const { filter, seed, exposure = 300, transparency = 1, seeing = 3.5, noise = 2e-4, cosmicRays = 0 } = options
	const toReference = options.toReference ?? syntheticTransform(field, 0, 0)
	const fromReference = invertSimilarityTransform(toReference)!
	const raw = new Float32Array(width * height)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const point = applyTransformToPoint(x, y, toReference)
			raw[y * width + x] = skySignal(field, filter, point.x, point.y) * exposure
		}
	}

	const stars: DetectedStar[] = []

	for (const star of field.stars) {
		const point = applyTransformToPoint(star.x, star.y, fromReference)
		if (point.x < 0 || point.y < 0 || point.x > width - 1 || point.y > height - 1) continue
		const flux = star.flux * STAR_RESPONSE[filter] * 1e-2 * exposure
		addStar(raw, width, height, point.x, point.y, flux, seeing)
		stars.push({ x: point.x, y: point.y, flux: flux * transparency, hfd: seeing, snr: (flux * transparency) / (noise * seeing * 2) })
	}

	const gaussian = normal(mulberry32(seed), 0, noise)
	const random = mulberry32(seed ^ 0x9e3779b9)
	const hits: number[] = []

	for (let i = 0; i < raw.length; i++) raw[i] = raw[i] * transparency * masters.flat.raw[i] + masters.dark.raw[i] + gaussian()

	for (let i = 0; i < cosmicRays; i++) {
		const index = Math.floor(random() * raw.length)
		raw[index] += 0.3 + random() * 0.4
		hits.push(index)
	}

	return { image: monoImage(width, height, raw, { IMAGETYP: 'Light Frame', FILTER: filter, EXPTIME: exposure, OBJECT: 'Synthetic' }), stars, toReference, cosmicRays: hits }
}
