import { exposureTimeKeyword } from '../../io/formats/fits/util'
import type { CfaPattern, Image } from '../model/types'

// Astronomical frame calibration using raw bias, dark, flat, and dark-flat masters. The implementation
// validates every master before mutating the light, preserves signed residuals, and fuses calibration
// into one output pass. Exposure values are seconds and pixel values remain in normalized full-scale units.

// Policy used to match dark-current exposure to its target frame.
export type DarkScaling = 'exposure' | 'none'

// Raw master frames and numerical policies used to calibrate a light image.
export interface CalibrationOptions {
	// Master dark containing its original bias pedestal.
	readonly dark?: Image
	// Master flat containing its original bias and dark-current signals.
	readonly flat?: Image
	// Master bias acquired with the same sensor geometry and readout settings.
	readonly bias?: Image
	// Master dark-flat containing its original bias pedestal.
	readonly darkFlat?: Image
	// Exposure-based scaling assumes linear dark current; use `none` only for exposure-matched masters or sensors whose dark signal cannot be scaled.
	readonly darkScaling?: DarkScaling
	// Corrected flat samples at or below this normalized value are rejected before the light is mutated. Defaults to zero.
	readonly minimumFlat?: number
}

// Geometry and readout fields checked without requiring optional FITS metadata to be present.
const CALIBRATION_HEADER_KEYWORDS = ['XBINNING', 'YBINNING', 'XORGSUBF', 'YORGSUBF', 'XBAYROFF', 'YBAYROFF', 'GAIN', 'OFFSET'] as const

// Returns validated CFA metadata, treating the empty value emitted by some mono FITS files as absent.
function imageCfaPattern(image: Image, name: string): CfaPattern | undefined {
	const pattern = image.metadata.bayer
	if (!pattern) return undefined
	if (pattern === 'RGGB' || pattern === 'BGGR' || pattern === 'GBRG' || pattern === 'GRBG' || pattern === 'GRGB' || pattern === 'GBGR' || pattern === 'RGBG' || pattern === 'BGRG') return pattern
	throw new Error(`${name} has unsupported CFA pattern: ${pattern}`)
}

// Verifies an image has a dense planar buffer consistent with its declared geometry.
function validateImageLayout(image: Image, name: string) {
	const { width, height, channels, pixelCount } = image.metadata
	if (!Number.isInteger(width) || width <= 0) throw new Error(`${name} width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || height <= 0) throw new Error(`${name} height must be a positive integer: ${height}`)
	if (!Number.isInteger(channels) || channels <= 0) throw new Error(`${name} channels must be a positive integer: ${channels}`)
	const expectedPixelCount = width * height
	if (pixelCount !== expectedPixelCount) throw new Error(`${name} pixelCount does not match geometry: ${pixelCount} != ${expectedPixelCount}`)
	const expectedLength = pixelCount * channels
	if (image.raw.length !== expectedLength) throw new Error(`${name} raw length does not match metadata: ${image.raw.length} != ${expectedLength}`)
	const pattern = imageCfaPattern(image, name)
	if (pattern && channels !== 1) throw new Error(`${name} CFA data must have one channel: ${channels}`)
	return pattern
}

// Verifies one calibration master has the same geometry, storage, and known acquisition layout as the light.
function validateMaster(light: Image, master: Image, name: string, lightPattern: CfaPattern | undefined, requirePattern: boolean) {
	const pattern = validateImageLayout(master, name)
	if (master.metadata.width !== light.metadata.width) throw new Error(`${name} width does not match light: ${master.metadata.width} != ${light.metadata.width}`)
	if (master.metadata.height !== light.metadata.height) throw new Error(`${name} height does not match light: ${master.metadata.height} != ${light.metadata.height}`)
	if (master.metadata.channels !== light.metadata.channels) throw new Error(`${name} channels do not match light: ${master.metadata.channels} != ${light.metadata.channels}`)
	if ((requirePattern && pattern !== lightPattern) || (!requirePattern && pattern !== undefined && pattern !== lightPattern)) {
		throw new Error(`${name} CFA pattern does not match light: ${pattern ?? 'none'} != ${lightPattern ?? 'none'}`)
	}
	for (const keyword of CALIBRATION_HEADER_KEYWORDS) {
		const lightValue = light.header[keyword]
		const masterValue = master.header[keyword]
		if (lightValue !== undefined && masterValue !== undefined && lightValue !== masterValue) {
			throw new Error(`${name} ${keyword} does not match light: ${masterValue} != ${lightValue}`)
		}
	}
}

// Reads a finite positive exposure in seconds from EXPTIME or EXPOSURE.
function exposureSeconds(image: Image, name: string) {
	const exposure = exposureTimeKeyword(image.header, undefined)
	if (exposure === undefined || !Number.isFinite(exposure) || exposure <= 0) throw new Error(`${name} requires a finite positive EXPTIME or EXPOSURE`)
	return exposure
}

// Computes the target-to-dark exposure ratio, requiring bias when only dark current must be scaled.
function darkScale(target: Image, dark: Image, bias: Image | undefined, scaling: DarkScaling, targetName: string, darkName: string) {
	if (scaling === 'none') return 1
	const scale = exposureSeconds(target, targetName) / exposureSeconds(dark, darkName)
	if (scale !== 1 && !bias) throw new Error(`${darkName} exposure differs from ${targetName}; a bias master is required for exposure scaling`)
	return scale
}

// Computes and validates corrected-flat means independently for planar channels or the four CFA phases.
function correctedFlatMeans(flat: Image, bias: Image | undefined, darkFlat: Image | undefined, scale: number, minimum: number, pattern: CfaPattern | undefined) {
	const flatRaw = flat.raw
	const biasRaw = bias?.raw
	const darkFlatRaw = darkFlat?.raw
	const { width, height, channels, pixelCount } = flat.metadata
	const groupCount = pattern ? 4 : channels
	const sums = new Float64Array(groupCount)
	const counts = new Uint32Array(groupCount)

	if (pattern) {
		for (let y = 0; y < height; y++) {
			const row = y * width
			const rowPhase = (y & 1) << 1
			for (let x = 0; x < width; x++) {
				const i = row + x
				let value = flatRaw[i]
				if (darkFlatRaw) {
					if (scale === 1) value -= darkFlatRaw[i]
					else value -= biasRaw![i] + scale * (darkFlatRaw[i] - biasRaw![i])
				} else if (biasRaw) {
					value -= biasRaw[i]
				}
				if (!Number.isFinite(value) || value <= minimum) throw new Error(`corrected flat sample ${i} must be finite and greater than ${minimum}: ${value}`)
				const group = rowPhase | (x & 1)
				sums[group] += value
				counts[group]++
			}
		}
	} else {
		for (let channel = 0; channel < channels; channel++) {
			const end = (channel + 1) * pixelCount
			for (let i = channel * pixelCount; i < end; i++) {
				let value = flatRaw[i]
				if (darkFlatRaw) {
					if (scale === 1) value -= darkFlatRaw[i]
					else value -= biasRaw![i] + scale * (darkFlatRaw[i] - biasRaw![i])
				} else if (biasRaw) {
					value -= biasRaw[i]
				}
				if (!Number.isFinite(value) || value <= minimum) throw new Error(`corrected flat sample ${i} must be finite and greater than ${minimum}: ${value}`)
				sums[channel] += value
				counts[channel]++
			}
		}
	}

	for (let group = 0; group < groupCount; group++) {
		if (counts[group] === 0) {
			sums[group] = 1
			continue
		}
		const mean = sums[group] / counts[group]
		if (!Number.isFinite(mean) || mean <= minimum) throw new Error(`corrected flat mean ${group} must be finite and greater than ${minimum}: ${mean}`)
		sums[group] = mean
	}
	return sums
}

// Calibrates `light` in place and returns the same object. Masters are raw: dark and dark-flat include
// their bias pedestal, while flat includes bias and dark current. Exposure scaling requires finite
// positive FITS exposure metadata and a bias whenever target and dark exposures differ. Flat
// normalization is independent per planar channel or CFA phase. Results are intentionally not clipped.
export function calibrate(light: Image, options: CalibrationOptions = {}) {
	const { dark, flat, bias, darkFlat, darkScaling = 'exposure', minimumFlat = 0 } = options
	if (darkScaling !== 'exposure' && darkScaling !== 'none') throw new Error(`unsupported dark scaling: ${darkScaling}`)
	if (!Number.isFinite(minimumFlat) || minimumFlat < 0) throw new Error(`minimumFlat must be finite and non-negative: ${minimumFlat}`)
	if (darkFlat && !flat) throw new Error('darkFlat requires a flat master')
	if (!dark && !flat && !bias) return light

	const lightPattern = validateImageLayout(light, 'light')
	if (dark) validateMaster(light, dark, 'dark', lightPattern, false)
	if (flat) validateMaster(light, flat, 'flat', lightPattern, true)
	if (bias) validateMaster(light, bias, 'bias', lightPattern, false)
	if (darkFlat) validateMaster(light, darkFlat, 'darkFlat', lightPattern, false)

	const darkExposureScale = dark ? darkScale(light, dark, bias, darkScaling, 'light', 'dark') : 1
	const darkFlatExposureScale = flat && darkFlat ? darkScale(flat, darkFlat, bias, darkScaling, 'flat', 'darkFlat') : 1
	const flatMeans = flat ? correctedFlatMeans(flat, bias, darkFlat, darkFlatExposureScale, minimumFlat, lightPattern) : undefined
	const lightRaw = light.raw
	const darkRaw = dark?.raw
	const flatRaw = flat?.raw
	const biasRaw = bias?.raw
	const darkFlatRaw = darkFlat?.raw

	if (!flatRaw) {
		for (let i = 0; i < lightRaw.length; i++) {
			if (darkRaw) {
				if (darkExposureScale === 1) lightRaw[i] -= darkRaw[i]
				else lightRaw[i] -= biasRaw![i] + darkExposureScale * (darkRaw[i] - biasRaw![i])
			} else if (biasRaw) {
				lightRaw[i] -= biasRaw[i]
			}
		}
		return light
	}

	if (lightPattern) {
		const { width, height } = light.metadata
		for (let y = 0; y < height; y++) {
			const row = y * width
			const rowPhase = (y & 1) << 1
			for (let x = 0; x < width; x++) {
				const i = row + x
				let value = lightRaw[i]
				if (darkRaw) {
					if (darkExposureScale === 1) value -= darkRaw[i]
					else value -= biasRaw![i] + darkExposureScale * (darkRaw[i] - biasRaw![i])
				} else if (biasRaw) {
					value -= biasRaw[i]
				}
				let correctedFlat = flatRaw[i]
				if (darkFlatRaw) {
					if (darkFlatExposureScale === 1) correctedFlat -= darkFlatRaw[i]
					else correctedFlat -= biasRaw![i] + darkFlatExposureScale * (darkFlatRaw[i] - biasRaw![i])
				} else if (biasRaw) {
					correctedFlat -= biasRaw[i]
				}
				lightRaw[i] = value * (flatMeans![rowPhase | (x & 1)] / correctedFlat)
			}
		}
	} else {
		const { channels, pixelCount } = light.metadata
		for (let channel = 0; channel < channels; channel++) {
			const end = (channel + 1) * pixelCount
			const flatMean = flatMeans![channel]
			for (let i = channel * pixelCount; i < end; i++) {
				let value = lightRaw[i]
				if (darkRaw) {
					if (darkExposureScale === 1) value -= darkRaw[i]
					else value -= biasRaw![i] + darkExposureScale * (darkRaw[i] - biasRaw![i])
				} else if (biasRaw) {
					value -= biasRaw[i]
				}
				let correctedFlat = flatRaw[i]
				if (darkFlatRaw) {
					if (darkFlatExposureScale === 1) correctedFlat -= darkFlatRaw[i]
					else correctedFlat -= biasRaw![i] + darkFlatExposureScale * (darkFlatRaw[i] - biasRaw![i])
				} else if (biasRaw) {
					correctedFlat -= biasRaw[i]
				}
				lightRaw[i] = value * (flatMean / correctedFlat)
			}
		}
	}

	return light
}
