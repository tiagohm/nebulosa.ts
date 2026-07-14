import type { Point, Rect } from '../../math/numerical/geometry'
import { mulberry32 } from '../../math/numerical/random'
import type { Angle } from '../../math/units/angle'
import { type CfaPattern, type Image, type ImageRawType, makeImageRawTypedArray } from '../model/types'

// Deterministic rasterization of defocused, centrally obstructed stellar patterns. Geometry is expressed
// in full-image pixel coordinates with Y increasing downward. The low-level renderer adds flux to a
// caller-owned buffer; the image generator allocates a normalized Float32 image and applies global
// seeing, tracking, noise, saturation, defects, and crop effects.

// Numerical limit used to avoid overflow in the logistic edge occupancy.
const LOGISTIC_LIMIT = 40
// Number of obstruction-boundary samples used by the conservative containment validation.
const CONTAINMENT_SAMPLES = 72
// Gaussian blur support, in standard deviations on either side of the center.
const GAUSSIAN_SUPPORT = 3
// Smallest positive normalization divisor accepted by the flux-preserving renderer.
const MIN_WEIGHT_SUM = 1e-12

// Elliptical boundary of a synthetic collimation pattern. Axes and softness are measured in pixels.
export interface SyntheticEllipse {
	// Ellipse center in full-image pixel coordinates.
	readonly center: Readonly<Point>
	// Semi-major axis in pixels.
	readonly semiMajor: number
	// Semi-minor axis in pixels.
	readonly semiMinor: number
	// Major-axis angle in image coordinates, radians clockwise because Y grows downward.
	readonly theta: Angle
	// Logistic edge softness in pixels; must be strictly positive.
	readonly softness: number
}

// Azimuthal brightness modulation applied around the outer ellipse.
export interface SyntheticHarmonic {
	// Positive integer harmonic order.
	readonly order: number
	// Fractional cosine amplitude; the combined brightness is clamped at zero.
	readonly amplitude: number
	// Harmonic phase in image coordinates, radians.
	readonly phase: Angle
}

// Linear motion blur applied after rasterizing the annulus.
export interface SyntheticDirectionalBlur {
	// End-to-end blur length in pixels.
	readonly length: number
	// Blur direction in image coordinates, radians clockwise because Y grows downward.
	readonly angle: Angle
}

// Anisotropic Gaussian blur standard deviations in output-image pixels.
export interface SyntheticGaussianBlur {
	// Horizontal Gaussian standard deviation in pixels.
	readonly sigmaX: number
	// Vertical Gaussian standard deviation in pixels.
	readonly sigmaY: number
}

// Radial spider-vane attenuation centered on the outer ellipse.
export interface SyntheticSpider {
	// Number of radial vanes; zero disables the effect.
	readonly vanes: number
	// Angle of the first vane in image coordinates, radians.
	readonly angle: Angle
	// Full vane width in pixels.
	readonly width: number
	// Fractional attenuation inside a vane, from zero to one.
	readonly attenuation: number
}

// Broad angular attenuation that approximates a thermal plume crossing the annulus.
export interface SyntheticThermalPlume {
	// Plume direction from the outer center, radians in image coordinates.
	readonly angle: Angle
	// Angular Gaussian standard deviation in radians.
	readonly width: Angle
	// Fractional attenuation at the plume center, from zero to one.
	readonly strength: number
}

// Complete deterministic fixture description for a defocused collimation image.
export interface SyntheticCollimationPattern {
	// Full output width in pixels before an optional crop.
	readonly width: number
	// Full output height in pixels before an optional crop.
	readonly height: number
	// Number of interleaved channels; defaults to monochrome.
	readonly channels?: 1 | 3
	// Normalized red, green, and blue signal fractions for RGB output; defaults to equal energy.
	readonly channelWeights?: readonly [number, number, number]
	// Optional CFA metadata for a monochrome mosaic.
	readonly bayer?: CfaPattern
	// Outer illuminated boundary.
	readonly outer: SyntheticEllipse
	// Inner obscuration boundary, which must remain inside the outer ellipse.
	readonly obstruction: SyntheticEllipse
	// Total integrated annulus signal above background.
	readonly signal: number
	// Constant background level added after optical effects and before sensor effects.
	readonly background: number
	// Standard deviation of additive Gaussian noise per sample.
	readonly noise: number
	// Deterministic random seed; defaults to one.
	readonly seed?: number
	// Gaussian seeing standard deviation in pixels.
	readonly seeing?: number
	// Optional directional tracking blur.
	readonly tracking?: SyntheticDirectionalBlur
	// Optional azimuthal brightness terms.
	readonly harmonics?: readonly SyntheticHarmonic[]
	// Optional spider-vane attenuation.
	readonly spider?: SyntheticSpider
	// Optional thermal-plume attenuation.
	readonly thermalPlume?: SyntheticThermalPlume
	// Optional upper sample clamp applied before hot pixels.
	readonly saturation?: number
	// Defective pixels set to the saturation level or the brightest representable fixture value.
	readonly hotPixels?: readonly Readonly<Point>[]
	// Optional half-open crop in full-image coordinates.
	readonly crop?: Readonly<Rect>
}

// Validated integer raster bounds surrounding an outer ellipse.
interface RasterBounds {
	readonly left: number
	readonly top: number
	readonly right: number
	readonly bottom: number
}

// Cached ellipse transform used in the two renderer passes.
interface ResolvedEllipse {
	readonly centerX: number
	readonly centerY: number
	readonly semiMajor: number
	readonly semiMinor: number
	readonly equivalentRadius: number
	readonly cosTheta: number
	readonly sinTheta: number
	readonly softness: number
}

// Adds one normalized collimation annulus to an existing interleaved image buffer. Signal is integrated
// across all pixels and channels. An optional saturation level clamps each accumulated sample. Returns
// false when the complete outer support falls outside the frame.
export function renderSyntheticCollimationPattern(raw: ImageRawType, pattern: SyntheticCollimationPattern, saturationLevel?: number): boolean {
	validateSyntheticCollimationPattern(pattern, false)
	if (saturationLevel !== undefined && (!Number.isFinite(saturationLevel) || saturationLevel < 0)) throw new RangeError('saturation level must be finite and non-negative')
	const channels = pattern.channels ?? 1
	const expectedLength = pattern.width * pattern.height * channels
	if (raw.length !== expectedLength) throw new RangeError(`buffer length mismatch: expected ${expectedLength}, received ${raw.length}`)

	const outer = resolveEllipse(pattern.outer)
	const obstruction = resolveEllipse(pattern.obstruction)
	const support = ellipseBounds(outer)
	const bounds = clipBounds(support, pattern.width, pattern.height)
	if (bounds.left >= bounds.right || bounds.top >= bounds.bottom || pattern.signal === 0) return false

	let weightSum = 0
	for (let y = support.top; y < support.bottom; y++) {
		for (let x = support.left; x < support.right; x++) weightSum += annulusWeight(x, y, outer, obstruction, pattern)
	}
	if (!(weightSum > MIN_WEIGHT_SUM)) return false

	const scale = pattern.signal / weightSum
	const channelWeights = pattern.channelWeights ?? [1 / 3, 1 / 3, 1 / 3]
	for (let y = bounds.top; y < bounds.bottom; y++) {
		let pixel = (y * pattern.width + bounds.left) * channels
		for (let x = bounds.left; x < bounds.right; x++, pixel += channels) {
			const value = annulusWeight(x, y, outer, obstruction, pattern) * scale
			if (channels === 1) raw[pixel] = saturationLevel === undefined ? raw[pixel] + value : Math.min(saturationLevel, raw[pixel] + value)
			else {
				const red = raw[pixel] + value * channelWeights[0]
				const green = raw[pixel + 1] + value * channelWeights[1]
				const blue = raw[pixel + 2] + value * channelWeights[2]
				raw[pixel] = saturationLevel === undefined ? red : Math.min(saturationLevel, red)
				raw[pixel + 1] = saturationLevel === undefined ? green : Math.min(saturationLevel, green)
				raw[pixel + 2] = saturationLevel === undefined ? blue : Math.min(saturationLevel, blue)
			}
		}
	}
	return true
}

// Applies Gaussian seeing and optional linear tracking blur to an interleaved image in place. Temporary
// buffers are allocated once per call, not inside pixel loops.
export function applySyntheticCollimationBlur(raw: ImageRawType, width: number, height: number, channels: 1 | 3, seeing: number | SyntheticGaussianBlur = 0, tracking?: SyntheticDirectionalBlur): ImageRawType {
	validateRaster(raw, width, height, channels)
	const sigmaX = typeof seeing === 'number' ? seeing : seeing.sigmaX
	const sigmaY = typeof seeing === 'number' ? seeing : seeing.sigmaY
	if (!Number.isFinite(sigmaX) || sigmaX < 0 || !Number.isFinite(sigmaY) || sigmaY < 0) throw new RangeError('seeing must be finite and non-negative')
	if (tracking !== undefined) {
		if (!Number.isFinite(tracking.length) || tracking.length < 0) throw new RangeError('tracking length must be finite and non-negative')
		if (!Number.isFinite(tracking.angle)) throw new RangeError('tracking angle must be finite')
	}

	if (sigmaX > 0 || sigmaY > 0) gaussianBlurInPlace(raw, width, height, channels, sigmaX, sigmaY)
	if (tracking !== undefined && tracking.length > 0) directionalBlurInPlace(raw, width, height, channels, tracking)
	return raw
}

// Generates a fresh normalized image from a deterministic collimation fixture. Optical blur precedes
// noise and saturation; hot pixels are applied last. A crop returns local pixel coordinates and records
// its full-frame origin in the FITS-compatible header.
export function generateSyntheticCollimationImage(pattern: SyntheticCollimationPattern): Image {
	validateSyntheticCollimationPattern(pattern, true)
	const channels = pattern.channels ?? 1
	const length = pattern.width * pattern.height * channels
	const raw = new Float32Array(length)
	renderSyntheticCollimationPattern(raw, pattern)
	applySyntheticCollimationBlur(raw, pattern.width, pattern.height, channels, pattern.seeing, pattern.tracking)
	if (pattern.background !== 0) {
		for (let i = 0; i < raw.length; i++) raw[i] += pattern.background
	}
	applyNoiseAndOutputEffects(raw, pattern, channels)

	const crop = pattern.crop
	if (crop === undefined) return makeImage(raw, pattern.width, pattern.height, channels, pattern.bayer)
	const width = crop.right - crop.left
	const height = crop.bottom - crop.top
	const cropped = new Float32Array(width * height * channels)
	for (let y = 0; y < height; y++) {
		const sourceStart = ((crop.top + y) * pattern.width + crop.left) * channels
		cropped.set(raw.subarray(sourceStart, sourceStart + width * channels), y * width * channels)
	}
	const image = makeImage(cropped, width, height, channels, shiftCfaPattern(pattern.bayer, crop.left, crop.top))
	image.header.XORGSUBF = crop.left
	image.header.YORGSUBF = crop.top
	return image
}

// Validates fixture geometry and optional output effects. The low-level renderer skips crop/effect checks
// so the camera can reuse the same geometry while applying its own sensor model.
function validateSyntheticCollimationPattern(pattern: SyntheticCollimationPattern, validateEffects: boolean): void {
	if (!Number.isInteger(pattern.width) || pattern.width <= 0) throw new RangeError('width must be a positive integer')
	if (!Number.isInteger(pattern.height) || pattern.height <= 0) throw new RangeError('height must be a positive integer')
	if (pattern.channels !== undefined && pattern.channels !== 1 && pattern.channels !== 3) throw new RangeError('channels must be 1 or 3')
	if (pattern.bayer !== undefined && (pattern.channels ?? 1) !== 1) throw new RangeError('bayer metadata requires one channel')
	if (pattern.channelWeights !== undefined) {
		if ((pattern.channels ?? 1) !== 3) throw new RangeError('channel weights require three channels')
		const sum = pattern.channelWeights[0] + pattern.channelWeights[1] + pattern.channelWeights[2]
		if (!pattern.channelWeights.every((weight) => Number.isFinite(weight) && weight >= 0) || Math.abs(sum - 1) > 1e-9) throw new RangeError('channel weights must be finite, non-negative, and sum to one')
	}
	if (!Number.isFinite(pattern.signal) || pattern.signal < 0) throw new RangeError('signal must be finite and non-negative')
	if (!Number.isFinite(pattern.background)) throw new RangeError('background must be finite')
	if (!Number.isFinite(pattern.noise) || pattern.noise < 0) throw new RangeError('noise must be finite and non-negative')
	validateEllipse(pattern.outer, 'outer')
	validateEllipse(pattern.obstruction, 'obstruction')
	validateObstructionContainment(pattern.outer, pattern.obstruction)

	for (const harmonic of pattern.harmonics ?? []) {
		if (!Number.isInteger(harmonic.order) || harmonic.order <= 0) throw new RangeError('harmonic order must be a positive integer')
		if (!Number.isFinite(harmonic.amplitude) || !Number.isFinite(harmonic.phase)) throw new RangeError('harmonic amplitude and phase must be finite')
	}
	if (pattern.spider !== undefined) validateSpider(pattern.spider)
	if (pattern.thermalPlume !== undefined) validateThermalPlume(pattern.thermalPlume)
	if (!validateEffects) return

	if (pattern.saturation !== undefined && (!Number.isFinite(pattern.saturation) || pattern.saturation < 0)) throw new RangeError('saturation must be finite and non-negative')
	for (const point of pattern.hotPixels ?? []) validatePixelPoint(point, pattern.width, pattern.height, 'hot pixel')
	if (pattern.crop !== undefined) validateCrop(pattern.crop, pattern.width, pattern.height)
}

// Validates a finite ellipse with positive axes and edge softness.
function validateEllipse(ellipse: SyntheticEllipse, name: string): void {
	if (!Number.isFinite(ellipse.center.x) || !Number.isFinite(ellipse.center.y)) throw new RangeError(`${name} center must be finite`)
	if (!Number.isFinite(ellipse.semiMajor) || ellipse.semiMajor <= 0 || !Number.isFinite(ellipse.semiMinor) || ellipse.semiMinor <= 0) throw new RangeError(`${name} axes must be finite and positive`)
	if (!Number.isFinite(ellipse.theta)) throw new RangeError(`${name} angle must be finite`)
	if (!Number.isFinite(ellipse.softness) || ellipse.softness <= 0) throw new RangeError(`${name} softness must be finite and positive`)
}

// Conservatively checks the full inner boundary against the rotated outer ellipse.
function validateObstructionContainment(outer: SyntheticEllipse, obstruction: SyntheticEllipse): void {
	const resolvedOuter = resolveEllipse(outer)
	const cosTheta = Math.cos(obstruction.theta)
	const sinTheta = Math.sin(obstruction.theta)
	for (let i = 0; i < CONTAINMENT_SAMPLES; i++) {
		const angle = (i * Math.PI * 2) / CONTAINMENT_SAMPLES
		const localX = obstruction.semiMajor * Math.cos(angle)
		const localY = obstruction.semiMinor * Math.sin(angle)
		const x = obstruction.center.x + localX * cosTheta - localY * sinTheta
		const y = obstruction.center.y + localX * sinTheta + localY * cosTheta
		if (ellipseNormalizedRadius(x, y, resolvedOuter) > 1 + 1e-9) throw new RangeError('obstruction must be contained inside outer ellipse')
	}
}

// Validates spider count, geometry, and attenuation.
function validateSpider(spider: SyntheticSpider): void {
	if (!Number.isInteger(spider.vanes) || spider.vanes < 0) throw new RangeError('spider vanes must be a non-negative integer')
	if (!Number.isFinite(spider.angle)) throw new RangeError('spider angle must be finite')
	if (!Number.isFinite(spider.width) || spider.width < 0) throw new RangeError('spider width must be finite and non-negative')
	if (!Number.isFinite(spider.attenuation) || spider.attenuation < 0 || spider.attenuation > 1) throw new RangeError('spider attenuation must be between 0 and 1')
}

// Validates thermal-plume angular width and attenuation.
function validateThermalPlume(plume: SyntheticThermalPlume): void {
	if (!Number.isFinite(plume.angle)) throw new RangeError('thermal plume angle must be finite')
	if (!Number.isFinite(plume.width) || plume.width <= 0) throw new RangeError('thermal plume width must be finite and positive')
	if (!Number.isFinite(plume.strength) || plume.strength < 0 || plume.strength > 1) throw new RangeError('thermal plume strength must be between 0 and 1')
}

// Validates an integer point inside a full frame.
function validatePixelPoint(point: Readonly<Point>, width: number, height: number, name: string): void {
	if (!Number.isInteger(point.x) || !Number.isInteger(point.y) || point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) throw new RangeError(`${name} must be an integer pixel inside the image`)
}

// Validates a non-empty integer half-open crop inside the full frame.
function validateCrop(crop: Readonly<Rect>, width: number, height: number): void {
	if (!Number.isInteger(crop.left) || !Number.isInteger(crop.top) || !Number.isInteger(crop.right) || !Number.isInteger(crop.bottom)) throw new RangeError('crop coordinates must be integers')
	if (crop.left < 0 || crop.top < 0 || crop.right > width || crop.bottom > height || crop.left >= crop.right || crop.top >= crop.bottom) throw new RangeError('crop must be a non-empty rectangle inside the image')
}

// Resolves trigonometry and scale terms shared by raster samples.
function resolveEllipse(ellipse: SyntheticEllipse): ResolvedEllipse {
	return {
		centerX: ellipse.center.x,
		centerY: ellipse.center.y,
		semiMajor: ellipse.semiMajor,
		semiMinor: ellipse.semiMinor,
		equivalentRadius: Math.sqrt(ellipse.semiMajor * ellipse.semiMinor),
		cosTheta: Math.cos(ellipse.theta),
		sinTheta: Math.sin(ellipse.theta),
		softness: ellipse.softness,
	}
}

// Computes the complete support of an ellipse including eight softness lengths.
function ellipseBounds(ellipse: ResolvedEllipse): RasterBounds {
	const extentX = Math.hypot(ellipse.semiMajor * ellipse.cosTheta, ellipse.semiMinor * ellipse.sinTheta) + ellipse.softness * 8
	const extentY = Math.hypot(ellipse.semiMajor * ellipse.sinTheta, ellipse.semiMinor * ellipse.cosTheta) + ellipse.softness * 8
	return {
		left: Math.floor(ellipse.centerX - extentX),
		top: Math.floor(ellipse.centerY - extentY),
		right: Math.ceil(ellipse.centerX + extentX + 1),
		bottom: Math.ceil(ellipse.centerY + extentY + 1),
	}
}

// Intersects complete ellipse support with the writable image rectangle.
function clipBounds(bounds: RasterBounds, width: number, height: number): RasterBounds {
	return {
		left: Math.max(0, bounds.left),
		top: Math.max(0, bounds.top),
		right: Math.min(width, bounds.right),
		bottom: Math.min(height, bounds.bottom),
	}
}

// Computes the dimensionless elliptical radius at one image sample.
function ellipseNormalizedRadius(x: number, y: number, ellipse: ResolvedEllipse): number {
	const dx = x - ellipse.centerX
	const dy = y - ellipse.centerY
	const localX = dx * ellipse.cosTheta + dy * ellipse.sinTheta
	const localY = -dx * ellipse.sinTheta + dy * ellipse.cosTheta
	return Math.hypot(localX / ellipse.semiMajor, localY / ellipse.semiMinor)
}

// Converts signed radial distance in pixels to a stable soft occupancy.
function ellipseOccupancy(x: number, y: number, ellipse: ResolvedEllipse): number {
	const distance = (1 - ellipseNormalizedRadius(x, y, ellipse)) * ellipse.equivalentRadius
	const z = distance / ellipse.softness
	if (z >= LOGISTIC_LIMIT) return 1
	if (z <= -LOGISTIC_LIMIT) return 0
	return 1 / (1 + Math.exp(-z))
}

// Computes one non-negative annulus sample including azimuthal attenuation.
function annulusWeight(x: number, y: number, outer: ResolvedEllipse, obstruction: ResolvedEllipse, pattern: SyntheticCollimationPattern): number {
	let weight = ellipseOccupancy(x, y, outer) * (1 - ellipseOccupancy(x, y, obstruction))
	if (weight <= 0) return 0
	const dx = x - outer.centerX
	const dy = y - outer.centerY
	const phi = Math.atan2(dy, dx)

	let harmonic = 1
	for (const term of pattern.harmonics ?? []) harmonic += term.amplitude * Math.cos(term.order * (phi - term.phase))
	weight *= Math.max(0, harmonic)

	const spider = pattern.spider
	if (spider !== undefined && spider.vanes > 0 && spider.width > 0 && spider.attenuation > 0) {
		let insideVane = false
		for (let i = 0; i < spider.vanes; i++) {
			const angle = spider.angle + (i * Math.PI * 2) / spider.vanes
			const along = dx * Math.cos(angle) + dy * Math.sin(angle)
			const across = Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle))
			if (along >= 0 && across <= spider.width * 0.5) {
				insideVane = true
				break
			}
		}
		if (insideVane) weight *= 1 - spider.attenuation
	}

	const plume = pattern.thermalPlume
	if (plume !== undefined && plume.strength > 0) {
		const delta = Math.atan2(Math.sin(phi - plume.angle), Math.cos(phi - plume.angle))
		weight *= 1 - plume.strength * Math.exp(-(delta * delta) / (2 * plume.width * plume.width))
	}
	return weight
}

// Validates an interleaved raster shape without accepting padded strides.
function validateRaster(raw: ImageRawType, width: number, height: number, channels: 1 | 3): void {
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new RangeError('raster dimensions must be positive integers')
	if (raw.length !== width * height * channels) throw new RangeError('raster buffer length mismatch')
}

// Applies a normalized separable Gaussian kernel with zero-valued samples outside the frame.
function gaussianBlurInPlace(raw: ImageRawType, width: number, height: number, channels: 1 | 3, sigmaX: number, sigmaY: number): void {
	const horizontal = makeImageRawTypedArray(raw, raw.length)
	if (sigmaX > 0) {
		const kernel = gaussianKernel(sigmaX)
		const radius = (kernel.length - 1) >> 1
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const pixel = (y * width + x) * channels
				for (let channel = 0; channel < channels; channel++) {
					let sum = 0
					for (let tap = -radius; tap <= radius; tap++) {
						const sampleX = x + tap
						if (sampleX < 0 || sampleX >= width) continue
						sum += raw[(y * width + sampleX) * channels + channel] * kernel[tap + radius]
					}
					horizontal[pixel + channel] = sum
				}
			}
		}
	} else horizontal.set(raw)

	if (sigmaY <= 0) {
		raw.set(horizontal)
		return
	}

	const kernel = gaussianKernel(sigmaY)
	const radius = (kernel.length - 1) >> 1
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = (y * width + x) * channels
			for (let channel = 0; channel < channels; channel++) {
				let sum = 0
				for (let tap = -radius; tap <= radius; tap++) {
					const sampleY = y + tap
					if (sampleY < 0 || sampleY >= height) continue
					sum += horizontal[(sampleY * width + x) * channels + channel] * kernel[tap + radius]
				}
				raw[pixel + channel] = sum
			}
		}
	}
}

// Builds a normalized one-dimensional Gaussian kernel for a positive standard deviation in pixels.
function gaussianKernel(sigma: number): Float64Array {
	const radius = Math.max(1, Math.ceil(sigma * GAUSSIAN_SUPPORT))
	const kernel = new Float64Array(radius * 2 + 1)
	let divisor = 0
	for (let i = -radius; i <= radius; i++) {
		const value = Math.exp(-(i * i) / (2 * sigma * sigma))
		kernel[i + radius] = value
		divisor += value
	}
	for (let i = 0; i < kernel.length; i++) kernel[i] /= divisor
	return kernel
}

// Applies a sampled line convolution with zero-valued samples outside the frame.
function directionalBlurInPlace(raw: ImageRawType, width: number, height: number, channels: 1 | 3, tracking: SyntheticDirectionalBlur): void {
	const samples = Math.max(2, Math.ceil(tracking.length) + 1)
	const dx = Math.cos(tracking.angle) * tracking.length
	const dy = Math.sin(tracking.angle) * tracking.length
	const output = makeImageRawTypedArray(raw, raw.length)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const pixel = (y * width + x) * channels
			for (let sample = 0; sample < samples; sample++) {
				const t = sample / (samples - 1) - 0.5
				const sampleX = x + dx * t
				const sampleY = y + dy * t
				if (sampleX < 0 || sampleX > width - 1 || sampleY < 0 || sampleY > height - 1) continue
				const x0 = Math.floor(sampleX)
				const y0 = Math.floor(sampleY)
				const x1 = Math.min(width - 1, x0 + 1)
				const y1 = Math.min(height - 1, y0 + 1)
				const fx = sampleX - x0
				const fy = sampleY - y0
				for (let channel = 0; channel < channels; channel++) {
					const top = raw[(y0 * width + x0) * channels + channel] * (1 - fx) + raw[(y0 * width + x1) * channels + channel] * fx
					const bottom = raw[(y1 * width + x0) * channels + channel] * (1 - fx) + raw[(y1 * width + x1) * channels + channel] * fx
					output[pixel + channel] += (top * (1 - fy) + bottom * fy) / samples
				}
			}
		}
	}
	raw.set(output)
}

// Applies deterministic Gaussian noise, saturation, and final hot-pixel defects.
function applyNoiseAndOutputEffects(raw: ImageRawType, pattern: SyntheticCollimationPattern, channels: 1 | 3): void {
	const random = mulberry32(pattern.seed ?? 1)
	let spare: number | undefined
	for (let i = 0; i < raw.length; i++) {
		if (pattern.noise > 0) {
			let gaussian: number
			if (spare !== undefined) {
				gaussian = spare
				spare = undefined
			} else {
				const radius = Math.sqrt(-2 * Math.log(Math.max(random(), Number.MIN_VALUE)))
				const angle = Math.PI * 2 * random()
				gaussian = radius * Math.cos(angle)
				spare = radius * Math.sin(angle)
			}
			raw[i] += gaussian * pattern.noise
		}
		if (pattern.saturation !== undefined && raw[i] > pattern.saturation) raw[i] = pattern.saturation
	}

	const hotValue = pattern.saturation ?? Math.max(pattern.background + pattern.signal, 1)
	for (const point of pattern.hotPixels ?? []) {
		const pixel = (point.y * pattern.width + point.x) * channels
		for (let channel = 0; channel < channels; channel++) raw[pixel + channel] = hotValue
	}
}

// Constructs normalized image metadata for a tightly packed Float32 raster.
function makeImage(raw: Float32Array, width: number, height: number, channels: 1 | 3, bayer?: CfaPattern): Image {
	return {
		sampleScale: 'normalized',
		header: {},
		metadata: {
			width,
			height,
			channels,
			stride: width * channels,
			pixelCount: width * height,
			strideInBytes: width * channels * raw.BYTES_PER_ELEMENT,
			pixelSizeInBytes: raw.BYTES_PER_ELEMENT,
			bitpix: -32,
			bayer,
		},
		raw,
	}
}

// Shifts a 2x2 CFA tile to the local origin of a cropped image.
function shiftCfaPattern(pattern: CfaPattern | undefined, offsetX: number, offsetY: number): CfaPattern | undefined {
	if (pattern === undefined || ((offsetX | offsetY) & 1) === 0) return pattern
	const x = offsetX & 1
	const y = offsetY & 1
	return `${pattern[y * 2 + x]}${pattern[y * 2 + ((x + 1) & 1)]}${pattern[((y + 1) & 1) * 2 + x]}${pattern[((y + 1) & 1) * 2 + ((x + 1) & 1)]}` as CfaPattern
}
