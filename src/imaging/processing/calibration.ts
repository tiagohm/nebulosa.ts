import { exposureTimeKeyword } from '../../io/formats/fits/util'
import type { Image } from '../model/types'

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

// Verifies one calibration master has the same geometry and storage layout as the light.
function validateMaster(light: Image, master: Image, name: string) {
	const expectedLength = light.metadata.pixelCount * light.metadata.channels
	if (light.raw.length !== expectedLength) throw new Error(`light raw length does not match metadata: ${light.raw.length} != ${expectedLength}`)
	if (master.metadata.width !== light.metadata.width) throw new Error(`${name} width does not match light: ${master.metadata.width} != ${light.metadata.width}`)
	if (master.metadata.height !== light.metadata.height) throw new Error(`${name} height does not match light: ${master.metadata.height} != ${light.metadata.height}`)
	if (master.metadata.channels !== light.metadata.channels) throw new Error(`${name} channels do not match light: ${master.metadata.channels} != ${light.metadata.channels}`)
	if (master.raw.length !== expectedLength) throw new Error(`${name} raw length does not match metadata: ${master.raw.length} != ${expectedLength}`)
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

// Computes and validates the global corrected-flat mean without allocating an image-sized temporary.
function correctedFlatMean(flat: Image, bias: Image | undefined, darkFlat: Image | undefined, scale: number, minimum: number) {
	let sum = 0
	const flatRaw = flat.raw
	const biasRaw = bias?.raw
	const darkFlatRaw = darkFlat?.raw
	const n = flatRaw.length

	if (darkFlatRaw) {
		if (scale === 1) {
			for (let i = 0; i < n; i++) {
				const value = flatRaw[i] - darkFlatRaw[i]
				if (!Number.isFinite(value) || value <= minimum) throw new Error(`corrected flat sample ${i} must be finite and greater than ${minimum}: ${value}`)
				sum += value
			}
		} else {
			for (let i = 0; i < n; i++) {
				const pedestal = biasRaw![i]
				const value = flatRaw[i] - pedestal - scale * (darkFlatRaw[i] - pedestal)
				if (!Number.isFinite(value) || value <= minimum) throw new Error(`corrected flat sample ${i} must be finite and greater than ${minimum}: ${value}`)
				sum += value
			}
		}
	} else if (biasRaw) {
		for (let i = 0; i < n; i++) {
			const value = flatRaw[i] - biasRaw[i]
			if (!Number.isFinite(value) || value <= minimum) throw new Error(`corrected flat sample ${i} must be finite and greater than ${minimum}: ${value}`)
			sum += value
		}
	} else {
		for (let i = 0; i < n; i++) {
			const value = flatRaw[i]
			if (!Number.isFinite(value) || value <= minimum) throw new Error(`corrected flat sample ${i} must be finite and greater than ${minimum}: ${value}`)
			sum += value
		}
	}

	const mean = sum / n
	if (!Number.isFinite(mean) || mean <= minimum) throw new Error(`corrected flat mean must be finite and greater than ${minimum}: ${mean}`)
	return mean
}

// Calibrates `light` in place and returns the same object. Masters are raw: dark and dark-flat include
// their bias pedestal, while flat includes bias and dark current. Exposure scaling requires finite
// positive FITS exposure metadata and a bias whenever target and dark exposures differ. Results are
// intentionally not clipped, so valid noise residuals can be negative or exceed one.
export function calibrate(light: Image, options: CalibrationOptions = {}) {
	const { dark, flat, bias, darkFlat, darkScaling = 'exposure', minimumFlat = 0 } = options
	if (darkScaling !== 'exposure' && darkScaling !== 'none') throw new Error(`unsupported dark scaling: ${darkScaling}`)
	if (!Number.isFinite(minimumFlat) || minimumFlat < 0) throw new Error(`minimumFlat must be finite and non-negative: ${minimumFlat}`)
	if (darkFlat && !flat) throw new Error('darkFlat requires a flat master')

	if (dark) validateMaster(light, dark, 'dark')
	if (flat) validateMaster(light, flat, 'flat')
	if (bias) validateMaster(light, bias, 'bias')
	if (darkFlat) validateMaster(light, darkFlat, 'darkFlat')

	const darkExposureScale = dark ? darkScale(light, dark, bias, darkScaling, 'light', 'dark') : 1
	const darkFlatExposureScale = flat && darkFlat ? darkScale(flat, darkFlat, bias, darkScaling, 'flat', 'darkFlat') : 1
	const flatMean = flat ? correctedFlatMean(flat, bias, darkFlat, darkFlatExposureScale, minimumFlat) : 1

	if (!dark && !flat && !bias) return light

	const lightRaw = light.raw
	const darkRaw = dark?.raw
	const flatRaw = flat?.raw
	const biasRaw = bias?.raw
	const darkFlatRaw = darkFlat?.raw
	const n = lightRaw.length

	for (let i = 0; i < n; i++) {
		let value = lightRaw[i]
		if (darkRaw) {
			if (darkExposureScale === 1) value -= darkRaw[i]
			else value -= biasRaw![i] + darkExposureScale * (darkRaw[i] - biasRaw![i])
		} else if (biasRaw) {
			value -= biasRaw[i]
		}

		if (flatRaw) {
			let correctedFlat = flatRaw[i]
			if (darkFlatRaw) {
				if (darkFlatExposureScale === 1) correctedFlat -= darkFlatRaw[i]
				else correctedFlat -= biasRaw![i] + darkFlatExposureScale * (darkFlatRaw[i] - biasRaw![i])
			} else if (biasRaw) {
				correctedFlat -= biasRaw[i]
			}
			value *= flatMean / correctedFlat
		}
		lightRaw[i] = value
	}

	return light
}
