import { validateNonNegativeFinite } from '../../core/validation'
import { clamp, type NumberArray } from '../../math/numerical/math'
import { akimaSplineLUT, catmullRomSplineLUT, cubicHermiteSplineLUT, naturalCubicSplineLUT } from '../../math/numerical/spline'
import { truncatePixel } from '../model/image'
import { GRAYSCALES, type Image, type ImageChannelOrGray } from '../model/types'

// Curves transformation of the normalized [0, 1] raw buffer: applies per-channel or RGB/K tone curves
// through a configurable spline LUT, preserving color ratios for luminance-style curves. Operates in
// place.

// Spline interpolation used by the curves transformation.
export type CurvesTransformationInterpolation = 'cubicHermite' | 'akima' | 'catmullRom' | 'naturalCubic'

// One channel's control points for the curves transformation.
export interface CurvesTransformationCurve {
	readonly channel: ImageChannelOrGray
	// Input control-point values (ascending).
	readonly x: Readonly<NumberArray>
	// Output values at each control point.
	readonly y: Readonly<NumberArray>
}

// Options for the curves transformation.
export interface CurvesTransformationOptions {
	// Bit depth of the input/output values.
	readonly bits: number
	// Spline interpolation between control points.
	readonly interpolation: CurvesTransformationInterpolation
	// Per-channel curves; undefined entries leave that channel unchanged.
	readonly curves: readonly (CurvesTransformationCurve | undefined)[]
}

// A user curve resolved to typed arrays with endpoints injected and an identity flag.
interface ResolvedCurvesTransformationCurve {
	readonly channel: ImageChannelOrGray
	readonly x: Float64Array
	readonly y: Float64Array
	// True when the curve maps every value to itself (can be skipped).
	readonly identity: boolean
}

// Default curves transformation (16-bit, Akima spline, no-op curve).
export const DEFAULT_CURVES_TRANSFORMATION_OPTIONS: Readonly<CurvesTransformationOptions> = {
	bits: 16,
	interpolation: 'akima',
	curves: [undefined],
}

// Control points of the identity mapping (input equals output at 0 and 1).
const IDENTITY_CURVES_TRANSFORMATION = new Float64Array([0, 1])

// Absolute tolerance accepted for normalized custom grayscale weights.
const CURVES_WEIGHT_SUM_TOLERANCE = 1e-6

// Verifies the dense mono or interleaved RGB layout required by curves transformation.
function validateCurvesImage(image: Image) {
	const { width, height, channels, stride, pixelCount } = image.metadata
	if (!Number.isInteger(width) || width <= 0) throw new Error(`image width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || height <= 0) throw new Error(`image height must be a positive integer: ${height}`)
	if (channels !== 1 && channels !== 3) throw new Error(`image channels must be 1 or 3: ${channels}`)
	const expectedPixelCount = width * height
	if (pixelCount !== expectedPixelCount) throw new Error(`image pixelCount does not match geometry: ${pixelCount} != ${expectedPixelCount}`)
	const expectedStride = width * channels
	if (stride !== expectedStride) throw new Error(`image stride does not match geometry: ${stride} != ${expectedStride}`)
	const expectedLength = pixelCount * channels
	if (image.raw.length !== expectedLength) throw new Error(`image raw length does not match metadata: ${image.raw.length} != ${expectedLength}`)
}

// Reports whether a runtime value names one of the supported spline interpolations.
function isCurvesInterpolation(value: unknown): value is CurvesTransformationInterpolation {
	return value === 'cubicHermite' || value === 'akima' || value === 'catmullRom' || value === 'naturalCubic'
}

// Validates a named channel or normalized custom grayscale weights before image mutation.
function validateCurvesChannel(channel: ImageChannelOrGray) {
	if (typeof channel === 'string') {
		if (!Object.hasOwn(GRAYSCALES, channel)) throw new RangeError(`unsupported curves transformation channel: ${channel}`)
		return
	}

	if (channel === null || typeof channel !== 'object') throw new RangeError('curves transformation channel must be a named channel or grayscale weights')
	const { red, green, blue } = channel
	validateNonNegativeFinite(red)
	validateNonNegativeFinite(green)
	validateNonNegativeFinite(blue)
	const sum = red + green + blue
	if (Math.abs(sum - 1) > CURVES_WEIGHT_SUM_TOLERANCE) throw new RangeError(`curves transformation weights must sum to one: ${sum}`)
}

// Resolves one user curve, injects missing end points, and detects identity mappings.
function resolveCurvesTransformationCurve(curve: CurvesTransformationCurve | undefined): ResolvedCurvesTransformationCurve {
	if (curve === undefined) return { channel: 'GRAY', x: IDENTITY_CURVES_TRANSFORMATION, y: IDENTITY_CURVES_TRANSFORMATION, identity: true }
	validateCurvesChannel(curve.channel)

	const { x: cx, y: cy } = curve
	if (cx === undefined || cy === undefined) throw new Error('curves transformation x and y arrays are required')
	const n = cx.length

	if (n !== cy.length) throw new Error('curves transformation x and y arrays must have the same length')
	if (n === 0) return { channel: curve.channel, x: IDENTITY_CURVES_TRANSFORMATION, y: IDENTITY_CURVES_TRANSFORMATION, identity: true }

	for (let i = 0; i < n; i++) {
		if (!Number.isFinite(cx[i]) || !Number.isFinite(cy[i])) throw new Error('curves transformation control points must be finite')
	}

	const firstX = clamp(cx[0], 0, 1)
	const lastX = clamp(cx[n - 1], 0, 1)
	const prepend = firstX > 0 ? 1 : 0
	const append = lastX < 1 ? 1 : 0
	const x = new Float64Array(n + prepend + append)
	const y = new Float64Array(n + prepend + append)
	let offset = 0

	if (prepend) {
		x[0] = 0
		y[0] = 0
		offset = 1
	}

	for (let i = 0; i < n; i++) {
		x[i + offset] = clamp(cx[i], 0, 1)
		y[i + offset] = clamp(cy[i], 0, 1)
	}

	if (append) {
		x[x.length - 1] = 1
		y[y.length - 1] = 1
	}

	let identity = true

	for (let i = 0; i < x.length; i++) {
		if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) throw new Error('curves transformation control points must be finite')
		if (i > 0 && !(x[i] > x[i - 1])) throw new Error('curves transformation x coordinates must be strictly increasing after clamping')
		if (identity && Math.abs(x[i] - y[i]) > 1e-12) identity = false
	}

	return { channel: curve.channel, x, y, identity }
}

// Builds and clamps a LUT for one resolved interpolation curve.
function curvesTransformationLUT(curve: ResolvedCurvesTransformationCurve, bits: number, interpolation: CurvesTransformationInterpolation) {
	if (curve.identity) return undefined
	const size = 1 << bits
	const lut = interpolation === 'cubicHermite' ? cubicHermiteSplineLUT(curve.x, curve.y, size) : interpolation === 'catmullRom' ? catmullRomSplineLUT(curve.x, curve.y, size) : interpolation === 'naturalCubic' ? naturalCubicSplineLUT(curve.x, curve.y, size) : akimaSplineLUT(curve.x, curve.y, size)
	const n = lut.length
	for (let i = 0; i < n; i++) lut[i] = clamp(lut[i], 0, 1)
	return lut
}

// Applies the shared RGB/K-style curve to every stored sample.
function applyCurvesTransformation(image: Image, lut: Float32Array, channel: ImageChannelOrGray) {
	const { raw, metadata } = image
	const max = lut.length - 1
	const n = raw.length

	if (metadata.channels === 1) for (let i = 0; i < n; i++) raw[i] = lut[truncatePixel(raw[i], max)]
	else if (channel === 'RED') for (let i = 0; i < n; i += 3) raw[i] = lut[truncatePixel(raw[i], max)]
	else if (channel === 'GREEN') for (let i = 1; i < n; i += 3) raw[i] = lut[truncatePixel(raw[i], max)]
	else if (channel === 'BLUE') for (let i = 2; i < n; i += 3) raw[i] = lut[truncatePixel(raw[i], max)]
	else {
		const { red, green, blue } = typeof channel === 'string' ? GRAYSCALES[channel] : channel

		for (let i = 0; i < n; i += 3) {
			const r = raw[i]
			const g = raw[i + 1]
			const b = raw[i + 2]
			const p = clamp(red * r + green * g + blue * b, 0, 1)
			const v = lut[truncatePixel(p, max)]

			if (p > 0) {
				const scale = v / p
				raw[i] = clamp(r * scale, 0, 1)
				raw[i + 1] = clamp(g * scale, 0, 1)
				raw[i + 2] = clamp(b * scale, 0, 1)
			} else {
				raw[i] = v
				raw[i + 1] = v
				raw[i + 2] = v
			}
		}
	}

	return image
}

// Applies RGB/K curves through a configurable spline LUT.
// https://pixinsight.com/doc/legacy/LE/17_curves/curves_transforms/curves_transforms.html
// https://pixinsight.com/doc/legacy/LE/17_curves/curves_window/curves_window.html
// https://pixinsight.com/forum/index.php?threads/creating-a-smooth-surface-from-an-array-of-points.14567/
export function curvesTransformation(image: Image, options: Partial<CurvesTransformationOptions> = DEFAULT_CURVES_TRANSFORMATION_OPTIONS): Image {
	validateCurvesImage(image)
	const curves = !options.curves || options.curves?.length === 0 ? DEFAULT_CURVES_TRANSFORMATION_OPTIONS.curves : options.curves
	const bits = Number.isFinite(options.bits) ? clamp(Math.trunc(options.bits ?? DEFAULT_CURVES_TRANSFORMATION_OPTIONS.bits), 8, 24) : DEFAULT_CURVES_TRANSFORMATION_OPTIONS.bits
	const interpolation = options.interpolation ?? DEFAULT_CURVES_TRANSFORMATION_OPTIONS.interpolation
	if (!isCurvesInterpolation(interpolation)) throw new RangeError(`unsupported curves transformation interpolation: ${interpolation}`)
	const resolvedCurves = curves.map(resolveCurvesTransformationCurve)

	for (const curve of resolvedCurves) {
		if (curve.identity) continue
		if (image.metadata.channels === 1 && (curve.channel === 'RED' || curve.channel === 'GREEN' || curve.channel === 'BLUE')) continue
		const lut = curvesTransformationLUT(curve, bits, interpolation)
		lut !== undefined && applyCurvesTransformation(image, lut, curve.channel)
	}

	return image
}
