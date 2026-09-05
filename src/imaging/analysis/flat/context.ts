import { exposureTimeKeyword } from '../../../io/formats/fits/util'
import type { FlatFrame, FlatImageContext } from './types'

// Shared resolution of flat acquisition metadata. Explicit typed context wins over known FITS
// keywords, CFA offsets are applied exactly once, and unresolved values remain undefined.

// Acquisition fields used to prove reference and sequence compatibility.
export interface ResolvedFlatAcquisitionMetadata {
	// Camera gain in device-native units.
	readonly gain?: number
	// Camera offset in device-native units.
	readonly offset?: number
	// Sensor temperature, degrees Celsius.
	readonly temperature?: number
	// Camera-specific readout-mode identifier.
	readonly readoutMode?: string
	// Horizontal and vertical hardware binning factors.
	readonly binning?: readonly [number, number]
	// Sensor-space ROI origin in unbinned pixels.
	readonly sensorOrigin?: readonly [number, number]
	// Camera identifier.
	readonly camera?: string
	// Effective ADC or output bit depth.
	readonly bitDepth?: number
}

// Resolves and validates explicit acquisition metadata, falling back to known FITS keywords.
export function resolveFlatAcquisitionMetadata(context: FlatImageContext): ResolvedFlatAcquisitionMetadata {
	const point = context.operatingPoint
	const header = context.image.header
	if (point?.gain !== undefined && !Number.isFinite(point.gain)) throw new RangeError('flat operating-point gain must be finite')
	if (point?.offset !== undefined && !Number.isFinite(point.offset)) throw new RangeError('flat operating-point offset must be finite')
	if (point?.bitDepth !== undefined && (!Number.isInteger(point.bitDepth) || !(point.bitDepth > 0))) throw new RangeError('flat operating-point bit depth must be a positive integer')
	if (point?.temperature !== undefined && !Number.isFinite(point.temperature)) throw new RangeError('flat operating-point temperature must be finite')
	if (point?.binning && (!Number.isInteger(point.binning[0]) || !(point.binning[0] > 0) || !Number.isInteger(point.binning[1]) || !(point.binning[1] > 0))) throw new RangeError('flat operating-point binning must contain positive integers')
	if (point?.sensorOrigin && (!Number.isInteger(point.sensorOrigin[0]) || !(point.sensorOrigin[0] >= 0) || !Number.isInteger(point.sensorOrigin[1]) || !(point.sensorOrigin[1] >= 0))) throw new RangeError('flat operating-point sensor origin must contain non-negative integers')
	if (point?.size && (!Number.isInteger(point.size.width) || !(point.size.width > 0) || !Number.isInteger(point.size.height) || !(point.size.height > 0) || point.size.width !== context.image.metadata.width || point.size.height !== context.image.metadata.height))
		throw new RangeError('flat operating-point size must match the image dimensions')

	return {
		gain: point?.gain ?? finiteHeaderNumber(header.GAIN),
		offset: point?.offset ?? finiteHeaderNumber(header.OFFSET),
		temperature: point?.temperature ?? finiteHeaderNumber(header['CCD-TEMP']),
		readoutMode: point?.readoutMode ?? headerString(header.READOUTM),
		binning: point?.binning ?? headerIntegerPair(header.XBINNING, header.YBINNING, true),
		sensorOrigin: point?.sensorOrigin ?? headerIntegerPair(header.XORGSUBF, header.YORGSUBF, false),
		camera: point?.camera ?? headerString(header.INSTRUME),
		bitDepth: point?.bitDepth,
	}
}

// Resolves a caller-provided CFA offset or a complete integer XBAYROFF/YBAYROFF header pair.
export function resolveFlatContextCfaOffset(context: FlatImageContext): readonly [number, number] | undefined {
	if (context.cfaOffset !== undefined) return context.cfaOffset
	return headerIntegerPair(context.image.header.XBAYROFF, context.image.header.YBAYROFF, false)
}

// Reports incomplete or malformed FITS Bayer-offset metadata that cannot prove local phase.
export function hasIncompleteFlatHeaderCfaOffset(context: FlatImageContext): boolean {
	if (context.cfaOffset !== undefined || context.image.metadata.bayer === undefined) return false
	const x = context.image.header.XBAYROFF
	const y = context.image.header.YBAYROFF
	return (x !== undefined || y !== undefined) && headerIntegerPair(x, y, false) === undefined
}

// Resolves explicit or FITS exposure metadata in seconds, returning undefined when unavailable.
export function resolveFlatFrameExposure(frame: FlatFrame): number | undefined {
	const exposure = frame.exposure ?? exposureTimeKeyword(frame.image.header, undefined)
	return exposure !== undefined && Number.isFinite(exposure) && exposure > 0 ? exposure : undefined
}

// Compares scalar or two-element acquisition metadata without coercion.
export function sameFlatMetadataValue(first: number | string | readonly [number, number], second: number | string | readonly [number, number]): boolean {
	return Array.isArray(first) && Array.isArray(second) ? first[0] === second[0] && first[1] === second[1] : first === second
}

// Narrows one FITS value to a finite scalar number.
function finiteHeaderNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// Narrows one FITS value to a non-empty string.
function headerString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Resolves a complete integer FITS pair, optionally requiring both values to be positive.
function headerIntegerPair(first: unknown, second: unknown, positive: boolean): readonly [number, number] | undefined {
	if (typeof first !== 'number' || typeof second !== 'number' || !Number.isInteger(first) || !Number.isInteger(second)) return undefined
	if (positive ? first <= 0 || second <= 0 : first < 0 || second < 0) return undefined
	return [first, second]
}
