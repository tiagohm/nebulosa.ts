import type { Rect } from '../../math/numerical/geometry'
import { type CfaPattern, type DigitalImage, shiftCfaPattern } from '../model/types'
import type { SensorPlane } from './sensor/types'

// Shared image-plane geometry for digital mono, interleaved RGB, and non-debayered CFA analysis.
// Rectangles are left/top inclusive and right/bottom exclusive; CFA metadata is image-local unless
// the caller explicitly supplies the offset needed to shift a full-sensor pattern once.

// Mono, RGB, or individual row-major CFA plane selected without luminance conversion or debayering.
export type ImageAnalysisPlane = SensorPlane | 'green'

// Selected plane-grid geometry and raw-buffer increments mapped to source image coordinates.
export interface ImagePlaneGeometry {
	// First selected source x coordinate, in output pixels from the image origin.
	readonly sourceLeft: number
	// First selected source y coordinate, in output pixels from the image origin.
	readonly sourceTop: number
	// Source-coordinate step along both axes; one for mono/RGB and two for CFA.
	readonly step: 1 | 2
	// Number of selected samples along X.
	readonly width: number
	// Number of selected samples along Y.
	readonly height: number
	// Raw-buffer index of the first selected sample.
	readonly rawStart: number
	// Raw-buffer increment between adjacent selected X samples.
	readonly rawColumnStep: number
	// Raw-buffer increment between adjacent selected Y samples.
	readonly rawRowStep: number
	// Image-local CFA pattern used to select the plane, omitted for mono/RGB images.
	readonly cfaPattern?: CfaPattern
}

// Canonical plane order for interleaved RGB images.
export const RGB_ANALYSIS_PLANES: readonly ImageAnalysisPlane[] = ['red', 'green', 'blue']

// Canonical plane order for non-debayered CFA images.
export const CFA_ANALYSIS_PLANES: readonly ImageAnalysisPlane[] = ['red', 'green1', 'green2', 'blue']

// Canonical plane list for a monochrome image.
export const MONO_ANALYSIS_PLANES: readonly ImageAnalysisPlane[] = ['mono']

// Validates the dense row-major layout required by quantitative digital-image analysis.
export function validateDigitalImageLayout(image: DigitalImage): void {
	if (image.sampleScale !== 'digital') throw new TypeError('digital image analysis requires sampleScale digital')
	if (!(image.raw instanceof Float32Array) && !(image.raw instanceof Float64Array)) throw new TypeError('digital image raw buffer must be Float32Array or Float64Array')

	const { width, height, channels, pixelCount, stride, bayer } = image.metadata
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) throw new RangeError('digital image dimensions must be positive safe integers')
	if (channels !== 1 && channels !== 3) throw new RangeError('digital image channels must be 1 or 3')
	if (pixelCount !== width * height) throw new RangeError('digital image pixel count is inconsistent with its dimensions')
	if (stride !== width * channels) throw new RangeError('digital image stride is inconsistent with its dense interleaved layout')
	if (image.raw.length < stride * height) throw new RangeError('digital image raw buffer is smaller than its declared layout')
	if (bayer !== undefined && channels !== 1) throw new RangeError('digital CFA images must contain one non-debayered channel')

	if (image.digitalRange !== undefined) {
		const [lower, upper] = image.digitalRange
		if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) throw new RangeError('digital image storage range must contain two ordered finite limits')
	}
	if (image.quantizationStep !== undefined && (!Number.isFinite(image.quantizationStep) || image.quantizationStep <= 0)) throw new RangeError('digital image quantization step must be finite and positive')
}

// Resolves and validates a non-empty inclusive-exclusive area inside an image extent.
export function resolveAnalysisArea(area: Readonly<Rect> | undefined, width: number, height: number): Readonly<Rect> {
	const resolved = area ?? { left: 0, top: 0, right: width, bottom: height }
	if (!Number.isInteger(resolved.left) || !Number.isInteger(resolved.top) || !Number.isInteger(resolved.right) || !Number.isInteger(resolved.bottom) || resolved.left < 0 || resolved.top < 0 || resolved.right > width || resolved.bottom > height || resolved.left >= resolved.right || resolved.top >= resolved.bottom)
		throw new RangeError('analysis area must be a non-empty inclusive-exclusive integer rectangle')
	return resolved
}

// Resolves the image-local CFA pattern, shifting a full-sensor pattern only when an offset is explicit.
export function resolveLocalCfaPattern(image: DigitalImage, cfaOffset?: readonly [number, number]): CfaPattern | undefined {
	const pattern = image.metadata.bayer
	if (cfaOffset === undefined) return pattern
	if (pattern === undefined) throw new RangeError('CFA offset requires a non-debayered CFA image')
	return shiftCfaPattern(pattern, cfaOffset[0], cfaOffset[1])
}

// Returns the canonical planes supported by the image layout without allocating per sample.
export function resolveImageAnalysisPlanes(image: DigitalImage): readonly ImageAnalysisPlane[] {
	validateDigitalImageLayout(image)
	if (image.metadata.bayer !== undefined) return CFA_ANALYSIS_PLANES
	return image.metadata.channels === 3 ? RGB_ANALYSIS_PLANES : MONO_ANALYSIS_PLANES
}

// Maps one selected mono, RGB, or CFA plane inside an area to dense grid and raw-buffer increments.
export function resolveImagePlaneGeometry(image: DigitalImage, area: Readonly<Rect>, plane: ImageAnalysisPlane, cfaOffset?: readonly [number, number]): ImagePlaneGeometry {
	const geometry = resolveOptionalImagePlaneGeometry(image, area, plane, cfaOffset)
	if (!geometry) throw new RangeError('selected CFA plane has no samples inside the analysis area')
	return geometry
}

// Maps one selected image plane to grid increments, returning undefined only when a valid CFA plane has
// no sample in the area. Invalid layouts, rectangles, offsets, and plane selections still throw.
export function resolveOptionalImagePlaneGeometry(image: DigitalImage, area: Readonly<Rect>, plane: ImageAnalysisPlane, cfaOffset?: readonly [number, number]): ImagePlaneGeometry | undefined {
	validateDigitalImageLayout(image)
	const resolvedArea = resolveAnalysisArea(area, image.metadata.width, image.metadata.height)
	const pattern = resolveLocalCfaPattern(image, cfaOffset)
	const channels = image.metadata.channels

	if (pattern === undefined) {
		let channel = 0
		if (channels === 1) {
			if (plane !== 'mono') throw new RangeError('monochrome analysis supports only the mono plane')
		} else {
			channel = plane === 'red' ? 0 : plane === 'green' ? 1 : plane === 'blue' ? 2 : -1
			if (channel < 0) throw new RangeError('RGB analysis supports only red, green, and blue planes')
		}

		return {
			sourceLeft: resolvedArea.left,
			sourceTop: resolvedArea.top,
			step: 1,
			width: resolvedArea.right - resolvedArea.left,
			height: resolvedArea.bottom - resolvedArea.top,
			rawStart: resolvedArea.top * image.metadata.stride + resolvedArea.left * channels + channel,
			rawColumnStep: channels,
			rawRowStep: image.metadata.stride,
		}
	}

	const slot = cfaPlaneSlot(pattern, plane)
	let sourceLeft = resolvedArea.left
	let sourceTop = resolvedArea.top
	if ((sourceLeft & 1) !== (slot & 1)) sourceLeft++
	if ((sourceTop & 1) !== slot >>> 1) sourceTop++
	const width = sourceLeft < resolvedArea.right ? Math.floor((resolvedArea.right - 1 - sourceLeft) / 2) + 1 : 0
	const height = sourceTop < resolvedArea.bottom ? Math.floor((resolvedArea.bottom - 1 - sourceTop) / 2) + 1 : 0
	if (width <= 0 || height <= 0) return undefined

	return {
		sourceLeft,
		sourceTop,
		step: 2,
		width,
		height,
		rawStart: sourceTop * image.metadata.stride + sourceLeft,
		rawColumnStep: 2,
		rawRowStep: image.metadata.stride * 2,
		cfaPattern: pattern,
	}
}

// Finds the row-major 2x2 CFA slot for one physical color plane.
function cfaPlaneSlot(pattern: CfaPattern, plane: ImageAnalysisPlane): number {
	if (plane === 'mono' || plane === 'green') throw new RangeError('CFA analysis requires red, green1, green2, or blue plane')
	const channel = plane === 'red' ? 'R' : plane === 'blue' ? 'B' : 'G'
	const first = pattern.indexOf(channel)
	const slot = plane === 'green2' ? pattern.indexOf(channel, first + 1) : first
	if (slot < 0) throw new RangeError(`analysis plane ${plane} is absent from CFA pattern ${pattern}`)
	return slot
}
