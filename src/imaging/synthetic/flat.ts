import { TAU } from '../../core/constants'
import type { Point, Size } from '../../math/numerical/geometry'
import type { CfaPattern, DigitalImage, ImageRawType } from '../model/types'

// Deterministic flat-frame fixtures in digital or caller-selected sample units. Spatial effects are
// evaluated in unbinned sensor coordinates so fixed patterns remain stable across crops and binning.

// Sensor geometry represented by an output image. Origins and dimensions are unbinned sensor pixels.
export interface SyntheticFlatSensorGeometry {
	// Full sensor width in unbinned pixels.
	readonly width: number
	// Full sensor height in unbinned pixels.
	readonly height: number
	// Absolute origin of output pixel (0, 0), in unbinned sensor pixels.
	readonly origin?: Readonly<Point>
	// Horizontal and vertical hardware-binning factors.
	readonly binning?: readonly [number, number]
	// Selected unbinned frame extent; defaults to width*binX by height*binY.
	readonly extent?: Readonly<Size>
}

// Elliptical Gaussian dust shadow expressed in absolute unbinned sensor coordinates.
export interface SyntheticDustMote {
	// Shadow center in unbinned sensor pixels.
	readonly center: Readonly<Point>
	// Horizontal Gaussian standard deviation before rotation, in unbinned pixels.
	readonly sigmaX: number
	// Vertical Gaussian standard deviation before rotation, in unbinned pixels.
	readonly sigmaY: number
	// Ellipse angle in image coordinates, radians clockwise because Y grows downward.
	readonly angle?: number
	// Fractional attenuation at the center, in [0, 1].
	readonly contrast: number
}

// Sinusoidal row- or column-correlated illumination variation.
export interface SyntheticBanding {
	// Fractional sinusoidal amplitude, in [0, 1].
	readonly amplitude: number
	// Period in unbinned sensor pixels.
	readonly period: number
	// Sinusoidal phase in radians.
	readonly phase?: number
}

// Complete deterministic flat-frame description. Bias, signal, noise, clipping, and quantization use
// the caller's output units; generateSyntheticFlatImage interprets those units as digital numbers.
export interface SyntheticFlatModel {
	// Output width in pixels after optional hardware binning.
	readonly width: number
	// Output height in pixels after optional hardware binning.
	readonly height: number
	// Number of interleaved output channels; defaults to monochrome.
	readonly channels?: 1 | 3
	// Full-sensor CFA pattern for a monochrome, unbinned mosaic.
	readonly bayer?: CfaPattern
	// Red, green, and blue sensitivity multipliers; defaults to equal response.
	readonly channelResponse?: readonly [number, number, number]
	// Optional mapping from output pixels to the full unbinned sensor.
	readonly sensor?: SyntheticFlatSensorGeometry
	// Constant digital pedestal added after multiplicative illumination effects.
	readonly bias: number
	// Mean signal above the pedestal at the illumination center.
	readonly signal: number
	// Fractional quadratic falloff at the farthest sensor corner, in [0, 1].
	readonly vignetting: number
	// Illumination-center displacement in fractions of the sensor half-width and half-height.
	readonly centerOffset?: Readonly<Point>
	// Signed edge-to-edge fractional gradient along the sensor X and Y axes.
	readonly gradient?: Readonly<Point>
	// Gaussian pixel-response non-uniformity standard deviation as a signal fraction.
	readonly prnu?: number
	// Additive temporal Gaussian-noise standard deviation in output units.
	readonly noise?: number
	// Seed shared by fixed and temporal random fields; defaults to one.
	readonly seed?: number
	// Temporal realization index; affects noise but never fixed spatial effects.
	readonly frameIndex?: number
	// Multiplicative elliptical dust shadows.
	readonly dustMotes?: readonly SyntheticDustMote[]
	// Horizontal stripes whose value changes with sensor Y.
	readonly rowBanding?: SyntheticBanding
	// Vertical stripes whose value changes with sensor X.
	readonly columnBanding?: SyntheticBanding
	// Optional lower output clamp.
	readonly lowerClip?: number
	// Optional upper output clamp.
	readonly upperClip?: number
	// Optional positive quantization interval aligned to zero output units.
	readonly quantizationStep?: number
}

// Cached scalar configuration used by the allocation-free raster loop.
interface ResolvedSyntheticFlatModel {
	readonly width: number
	readonly height: number
	readonly channels: 1 | 3
	readonly sensorWidth: number
	readonly sensorHeight: number
	readonly originX: number
	readonly originY: number
	readonly binX: number
	readonly binY: number
	readonly frameWidth: number
	readonly frameHeight: number
	readonly centerX: number
	readonly centerY: number
	readonly inverseMaximumRadiusSquared: number
	readonly bias: number
	readonly signal: number
	readonly vignetting: number
	readonly gradientX: number
	readonly gradientY: number
	readonly prnu: number
	readonly noise: number
	readonly seed: number
	readonly frameIndex: number
	readonly response: readonly [number, number, number]
	readonly bayer?: CfaPattern
	readonly dustMotes: readonly ResolvedSyntheticDustMote[]
	readonly rowBanding?: SyntheticBanding
	readonly columnBanding?: SyntheticBanding
	readonly lowerClip?: number
	readonly upperClip?: number
	readonly quantizationStep?: number
}

// Dust geometry with cached rotation and reciprocal variances for the raster hot path.
interface ResolvedSyntheticDustMote {
	readonly centerX: number
	readonly centerY: number
	readonly inverseVarianceX: number
	readonly inverseVarianceY: number
	readonly cosAngle: number
	readonly sinAngle: number
	readonly contrast: number
}

// Salt separating the fixed PRNU field from temporal noise realizations.
const PRNU_SALT = 0x2c1b3c6d
// Salt separating temporal noise from the fixed spatial fields.
const NOISE_SALT = 0x9e3779b9

// Overwrites a caller-owned interleaved buffer with one deterministic synthetic flat frame.
export function renderSyntheticFlat(raw: ImageRawType, model: SyntheticFlatModel): ImageRawType {
	const resolved = resolveSyntheticFlatModel(raw, model)
	const sensorSpanX = resolved.sensorWidth - 1
	const sensorSpanY = resolved.sensorHeight - 1
	const rowBanding = resolved.rowBanding
	const columnBanding = resolved.columnBanding
	const prnuSeed = resolved.seed ^ PRNU_SALT
	const temporalSeed = resolved.seed ^ NOISE_SALT ^ mix32(resolved.frameIndex)

	for (let y = 0; y < resolved.height; y++) {
		const sampleHeight = Math.min(resolved.binY, resolved.frameHeight - y * resolved.binY)
		const sensorY = resolved.originY + y * resolved.binY + (sampleHeight - 1) * 0.5
		const sensorY2 = resolved.originY * 2 + y * resolved.binY * 2 + sampleHeight - 1
		const normalizedY = sensorSpanY > 0 ? (sensorY * 2) / sensorSpanY - 1 : 0
		const rowFactor = rowBanding === undefined ? 0 : rowBanding.amplitude * Math.sin((TAU * sensorY) / rowBanding.period + (rowBanding.phase ?? 0))

		for (let x = 0; x < resolved.width; x++) {
			const sampleWidth = Math.min(resolved.binX, resolved.frameWidth - x * resolved.binX)
			const sensorX = resolved.originX + x * resolved.binX + (sampleWidth - 1) * 0.5
			const sensorX2 = resolved.originX * 2 + x * resolved.binX * 2 + sampleWidth - 1
			const normalizedX = sensorSpanX > 0 ? (sensorX * 2) / sensorSpanX - 1 : 0
			const dx = sensorX - resolved.centerX
			const dy = sensorY - resolved.centerY
			const radiusSquared = (dx * dx + dy * dy) * resolved.inverseMaximumRadiusSquared
			const vignetting = 1 - resolved.vignetting * radiusSquared
			const gradient = 1 + 0.5 * (resolved.gradientX * normalizedX + resolved.gradientY * normalizedY)
			const columnFactor = columnBanding === undefined ? 0 : columnBanding.amplitude * Math.sin((TAU * sensorX) / columnBanding.period + (columnBanding.phase ?? 0))
			const banding = 1 + rowFactor + columnFactor
			const dust = evaluateDust(sensorX, sensorY, resolved.dustMotes)
			const baseIndex = (y * resolved.width + x) * resolved.channels

			for (let channel = 0; channel < resolved.channels; channel++) {
				const color = resolved.bayer === undefined ? channel : cfaColorIndex(resolved.bayer, Math.round(sensorX), Math.round(sensorY))
				const pixelResponse = resolved.prnu === 0 ? 1 : Math.max(0, 1 + resolved.prnu * sampleCoordinateGaussian(prnuSeed, sensorX2, sensorY2, channel))
				const temporalNoise = resolved.noise === 0 ? 0 : resolved.noise * sampleCoordinateGaussian(temporalSeed, sensorX2, sensorY2, channel)
				let value = resolved.bias + resolved.signal * resolved.response[color] * vignetting * gradient * pixelResponse * dust * banding + temporalNoise

				if (resolved.quantizationStep !== undefined) value = Math.round(value / resolved.quantizationStep) * resolved.quantizationStep
				if (resolved.lowerClip !== undefined && value < resolved.lowerClip) value = resolved.lowerClip
				if (resolved.upperClip !== undefined && value > resolved.upperClip) value = resolved.upperClip
				raw[baseIndex + channel] = value
			}
		}
	}

	return raw
}

// Allocates a Float64 digital image with FITS-compatible geometry and source-range metadata.
export function generateSyntheticFlatImage(model: SyntheticFlatModel): DigitalImage {
	const channels = model.channels ?? 1
	const raw = new Float64Array(model.width * model.height * channels)
	renderSyntheticFlat(raw, model)
	const origin = model.sensor?.origin
	const bitpix = -64
	const pixelSizeInBytes = raw.BYTES_PER_ELEMENT
	const header = {
		SIMPLE: true,
		BITPIX: bitpix,
		NAXIS: channels === 1 ? 2 : 3,
		NAXIS1: model.width,
		NAXIS2: model.height,
		NAXIS3: channels === 3 ? 3 : undefined,
		BAYERPAT: model.bayer,
		XORGSUBF: origin?.x,
		YORGSUBF: origin?.y,
		XBINNING: model.sensor?.binning?.[0],
		YBINNING: model.sensor?.binning?.[1],
	}

	return {
		header,
		raw,
		metadata: {
			width: model.width,
			height: model.height,
			channels,
			pixelCount: model.width * model.height,
			pixelSizeInBytes,
			stride: model.width * channels,
			strideInBytes: model.width * channels * pixelSizeInBytes,
			bitpix,
			bayer: model.bayer,
		},
		sampleScale: 'digital',
		digitalRange: model.lowerClip !== undefined && model.upperClip !== undefined ? [model.lowerClip, model.upperClip] : undefined,
		quantizationStep: model.quantizationStep,
	}
}

// Validates a public model and resolves geometry and loop-invariant calculations.
function resolveSyntheticFlatModel(raw: ImageRawType, model: SyntheticFlatModel): ResolvedSyntheticFlatModel {
	if (!Number.isInteger(model.width) || model.width <= 0) throw new RangeError('width must be a positive integer')
	if (!Number.isInteger(model.height) || model.height <= 0) throw new RangeError('height must be a positive integer')
	const channels = model.channels ?? 1
	if (channels !== 1 && channels !== 3) throw new RangeError('channels must be 1 or 3')
	if (raw.length !== model.width * model.height * channels) throw new RangeError('buffer length does not match synthetic flat geometry')
	if (model.bayer !== undefined && channels !== 1) throw new RangeError('CFA output must be monochrome')

	const sensorWidth = model.sensor?.width ?? model.width
	const sensorHeight = model.sensor?.height ?? model.height
	const originX = model.sensor?.origin?.x ?? 0
	const originY = model.sensor?.origin?.y ?? 0
	const binX = model.sensor?.binning?.[0] ?? 1
	const binY = model.sensor?.binning?.[1] ?? 1
	const frameWidth = model.sensor?.extent?.width ?? model.width * binX
	const frameHeight = model.sensor?.extent?.height ?? model.height * binY
	for (const [name, value] of [
		['sensor width', sensorWidth],
		['sensor height', sensorHeight],
		['sensor origin X', originX],
		['sensor origin Y', originY],
		['horizontal binning', binX],
		['vertical binning', binY],
		['frame width', frameWidth],
		['frame height', frameHeight],
	] as const) {
		if (!Number.isInteger(value) || value < (name.includes('origin') ? 0 : 1)) throw new RangeError(`${name} must be ${name.includes('origin') ? 'a non-negative' : 'a positive'} integer`)
	}
	if (model.bayer !== undefined && (binX !== 1 || binY !== 1)) throw new RangeError('CFA output requires unit binning')
	if (originX + frameWidth > sensorWidth || originY + frameHeight > sensorHeight) throw new RangeError('selected frame extent exceeds the full sensor geometry')
	if (Math.ceil(frameWidth / binX) !== model.width || Math.ceil(frameHeight / binY) !== model.height) throw new RangeError('output dimensions do not match the selected frame extent and binning')

	for (const [name, value] of [
		['bias', model.bias],
		['signal', model.signal],
		['vignetting', model.vignetting],
		['center offset X', model.centerOffset?.x ?? 0],
		['center offset Y', model.centerOffset?.y ?? 0],
		['gradient X', model.gradient?.x ?? 0],
		['gradient Y', model.gradient?.y ?? 0],
		['PRNU', model.prnu ?? 0],
		['noise', model.noise ?? 0],
	] as const) {
		if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
	}
	if (model.signal < 0) throw new RangeError('signal must be non-negative')
	if (model.vignetting < 0 || model.vignetting > 1) throw new RangeError('vignetting must be in [0, 1]')
	if ((model.prnu ?? 0) < 0) throw new RangeError('PRNU must be non-negative')
	if ((model.noise ?? 0) < 0) throw new RangeError('noise must be non-negative')
	const gradientX = model.gradient?.x ?? 0
	const gradientY = model.gradient?.y ?? 0
	if (Math.abs(gradientX) + Math.abs(gradientY) > 2) throw new RangeError('gradient must remain non-negative across the sensor')

	const response = model.channelResponse ?? [1, 1, 1]
	if (!response.every((value) => Number.isFinite(value) && value >= 0)) throw new RangeError('channel response must contain finite non-negative values')
	if (model.lowerClip !== undefined && !Number.isFinite(model.lowerClip)) throw new RangeError('lower clip must be finite')
	if (model.upperClip !== undefined && !Number.isFinite(model.upperClip)) throw new RangeError('upper clip must be finite')
	if (model.lowerClip !== undefined && model.upperClip !== undefined && model.lowerClip >= model.upperClip) throw new RangeError('lower clip must be smaller than upper clip')
	if (model.quantizationStep !== undefined && (!Number.isFinite(model.quantizationStep) || model.quantizationStep <= 0)) throw new RangeError('quantization step must be finite and positive')
	if (!Number.isInteger(model.frameIndex ?? 0)) throw new RangeError('frame index must be an integer')
	if (!Number.isInteger(model.seed ?? 1)) throw new RangeError('seed must be an integer')

	const dustMotes = new Array<ResolvedSyntheticDustMote>(model.dustMotes?.length ?? 0)
	for (let i = 0; i < dustMotes.length; i++) {
		const mote = model.dustMotes![i]
		validateDustMote(mote)
		const angle = mote.angle ?? 0
		dustMotes[i] = {
			centerX: mote.center.x,
			centerY: mote.center.y,
			inverseVarianceX: 1 / (mote.sigmaX * mote.sigmaX),
			inverseVarianceY: 1 / (mote.sigmaY * mote.sigmaY),
			cosAngle: Math.cos(angle),
			sinAngle: Math.sin(angle),
			contrast: mote.contrast,
		}
	}
	validateBanding(model.rowBanding, 'row')
	validateBanding(model.columnBanding, 'column')
	if ((model.rowBanding?.amplitude ?? 0) + (model.columnBanding?.amplitude ?? 0) > 1) throw new RangeError('combined banding amplitudes must not exceed one')

	const geometricCenterX = (sensorWidth - 1) * 0.5
	const geometricCenterY = (sensorHeight - 1) * 0.5
	const centerX = geometricCenterX + (model.centerOffset?.x ?? 0) * geometricCenterX
	const centerY = geometricCenterY + (model.centerOffset?.y ?? 0) * geometricCenterY
	const maximumDx = Math.max(Math.abs(centerX), Math.abs(sensorWidth - 1 - centerX))
	const maximumDy = Math.max(Math.abs(centerY), Math.abs(sensorHeight - 1 - centerY))
	const maximumRadiusSquared = maximumDx * maximumDx + maximumDy * maximumDy

	return {
		width: model.width,
		height: model.height,
		channels,
		sensorWidth,
		sensorHeight,
		originX,
		originY,
		binX,
		binY,
		frameWidth,
		frameHeight,
		centerX,
		centerY,
		inverseMaximumRadiusSquared: maximumRadiusSquared > 0 ? 1 / maximumRadiusSquared : 0,
		bias: model.bias,
		signal: model.signal,
		vignetting: model.vignetting,
		gradientX,
		gradientY,
		prnu: model.prnu ?? 0,
		noise: model.noise ?? 0,
		seed: (model.seed ?? 1) >>> 0,
		frameIndex: model.frameIndex ?? 0,
		response,
		bayer: model.bayer,
		dustMotes,
		rowBanding: model.rowBanding,
		columnBanding: model.columnBanding,
		lowerClip: model.lowerClip,
		upperClip: model.upperClip,
		quantizationStep: model.quantizationStep,
	}
}

// Validates one elliptical dust shadow.
function validateDustMote(mote: SyntheticDustMote): void {
	if (!Number.isFinite(mote.center.x) || !Number.isFinite(mote.center.y)) throw new RangeError('dust center must be finite')
	if (!Number.isFinite(mote.sigmaX) || mote.sigmaX <= 0 || !Number.isFinite(mote.sigmaY) || mote.sigmaY <= 0) throw new RangeError('dust sigmas must be finite and positive')
	if (mote.angle !== undefined && !Number.isFinite(mote.angle)) throw new RangeError('dust angle must be finite')
	if (!Number.isFinite(mote.contrast) || mote.contrast < 0 || mote.contrast > 1) throw new RangeError('dust contrast must be in [0, 1]')
}

// Validates an optional sinusoidal banding component.
function validateBanding(banding: SyntheticBanding | undefined, axis: string): void {
	if (banding === undefined) return
	if (!Number.isFinite(banding.amplitude) || banding.amplitude < 0 || banding.amplitude > 1) throw new RangeError(`${axis} banding amplitude must be in [0, 1]`)
	if (!Number.isFinite(banding.period) || banding.period <= 0) throw new RangeError(`${axis} banding period must be finite and positive`)
	if (banding.phase !== undefined && !Number.isFinite(banding.phase)) throw new RangeError(`${axis} banding phase must be finite`)
}

// Multiplies all elliptical Gaussian dust attenuations at one sensor coordinate.
function evaluateDust(x: number, y: number, dustMotes: readonly ResolvedSyntheticDustMote[]): number {
	let attenuation = 1
	for (let i = 0; i < dustMotes.length; i++) {
		const mote = dustMotes[i]
		const dx = x - mote.centerX
		const dy = y - mote.centerY
		const rotatedX = mote.cosAngle * dx + mote.sinAngle * dy
		const rotatedY = -mote.sinAngle * dx + mote.cosAngle * dy
		const distanceSquared = rotatedX * rotatedX * mote.inverseVarianceX + rotatedY * rotatedY * mote.inverseVarianceY
		attenuation *= 1 - mote.contrast * Math.exp(-0.5 * distanceSquared)
	}
	return attenuation
}

// Returns the RGB response index at one absolute CFA sensor coordinate.
function cfaColorIndex(pattern: CfaPattern, x: number, y: number): number {
	const color = pattern[((y & 1) << 1) | (x & 1)]
	return color === 'R' ? 0 : color === 'B' ? 2 : 1
}

// Produces a coordinate-stable standard-normal sample without shared mutable RNG state.
function sampleCoordinateGaussian(seed: number, x2: number, y2: number, channel: number): number {
	const first = mix32(seed ^ Math.imul(x2, 0x85ebca6b) ^ Math.imul(y2, 0xc2b2ae35) ^ Math.imul(channel + 1, 0x27d4eb2d))
	const second = mix32(first ^ 0x165667b1)
	const u1 = (first + 1) / 4294967297
	const u2 = (second + 1) / 4294967297
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2)
}

// Mixes one integer into an unsigned 32-bit pseudo-random value.
function mix32(value: number): number {
	let mixed = value >>> 0
	mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d)
	mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b)
	return (mixed ^ (mixed >>> 16)) >>> 0
}
