import { parseTemporal } from '../../../astronomy/time/temporal'
import type { CfaPattern } from '../../../imaging/model/types'
import { type Angle, deg, parseAngle } from '../../../math/units/angle'
import type { BitpixOrZero, FitsCompressionType, FitsHeader, FitsHeaderCard, FitsHeaderKey, FitsHeaderValue } from './fits'

// Typed accessors and helpers for reading well-known values out of a FITS header. Each accessor coerces
// the raw card value to the requested type, falls back to a default when the keyword is absent, and -
// where the same datum appears under several conventions - tries the alternative keywords in priority
// order (e.g. RA / OBJCTRA / RA_OBJ / CRVAL1). Also covers tile-compression (ZIMAGE/ZCMPTYPE) detection,
// HDU data-size computation, and header-card value formatting/escaping. Angles are returned in radians.

// Returns true when `key` is present in the header with a defined value.
export function hasKeyword(header: FitsHeader, key: FitsHeaderKey) {
	return key in header && header[key] !== undefined
}

// Reads `key` as a number (parsing strings and mapping booleans to 1/0), or `defaultValue` when absent.
export function numericKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, key: FitsHeaderKey, defaultValue: D) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value as D | T
	else if (typeof value === 'boolean') return (value ? 1 : 0) as D | T
	else return Number.parseFloat(value) as D | T
}

// Reads `key` as a boolean (numbers: non-zero is true; strings: 'T'/'true'), or `defaultValue` when absent.
export function booleanKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: boolean = false) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value !== 0
	else if (typeof value === 'string') return value === 'T' || value.toLowerCase() === 'true'
	else return value
}

// Reads `key` as a string (stringifying numbers/booleans), or `defaultValue` when absent.
export function textKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: string = '') {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'string') return value
	else return `${value}`
}

// Number of data axes (NAXIS).
export function numberOfAxesKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'NAXIS', defaultValue)
}

// Image width in pixels (NAXIS1, falling back to IMAGEW).
export function widthKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'NAXIS1', undefined) ?? numericKeyword(header, 'IMAGEW', defaultValue)
}

// Image height in pixels (NAXIS2, falling back to IMAGEH).
export function heightKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'NAXIS2', undefined) ?? numericKeyword(header, 'IMAGEH', defaultValue)
}

// Number of channels / third axis length (NAXIS3).
export function numberOfChannelsKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'NAXIS3', defaultValue)
}

// Pixel data type code (BITPIX); see BitpixOrZero for the value meanings.
export function bitpixKeyword<T extends BitpixOrZero = BitpixOrZero, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'BITPIX', defaultValue)
}

// Exposure duration in seconds (EXPTIME, falling back to EXPOSURE).
export function exposureTimeKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'EXPTIME', undefined) ?? numericKeyword(header, 'EXPOSURE', defaultValue)
}

// Bayer/CFA mosaic pattern (BAYERPAT), or undefined for monochrome data.
export function cfaPatternKeyword(header: FitsHeader) {
	return textKeyword(header, 'BAYERPAT') as CfaPattern | undefined
}

// Right ascension in radians, trying RA, OBJCTRA (sexagesimal hours), RA_OBJ, then CRVAL1 in order.
export function rightAscensionKeyword<T extends Angle = Angle, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	if (hasKeyword(header, 'RA')) {
		const value = deg(numericKeyword(header, 'RA', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'OBJCTRA')) {
		const value = parseAngle(textKeyword(header, 'OBJCTRA', ''), true)
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'RA_OBJ')) {
		const value = deg(numericKeyword(header, 'RA_OBJ', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'CRVAL1')) {
		const value = deg(numericKeyword(header, 'CRVAL1', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	return defaultValue
}

// Declination in radians, trying DEC, OBJCTDEC (sexagesimal degrees), DEC_OBJ, then CRVAL2 in order.
export function declinationKeyword<T extends Angle = Angle, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	if (hasKeyword(header, 'DEC')) {
		const value = deg(numericKeyword(header, 'DEC', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'OBJCTDEC')) {
		const value = parseAngle(textKeyword(header, 'OBJCTDEC', ''))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'DEC_OBJ')) {
		const value = deg(numericKeyword(header, 'DEC_OBJ', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'CRVAL2')) {
		const value = deg(numericKeyword(header, 'CRVAL2', 0))
		if (value !== undefined && Number.isFinite(value) && value !== defaultValue) return value
	}

	return defaultValue
}

// Parses the observation timestamp from DATE-OBS, DATE-END, or DATE, or undefined if none is present.
export function observationDateKeyword(header: FitsHeader) {
	const date = textKeyword(header, 'DATE-OBS') || textKeyword(header, 'DATE-END') || textKeyword(header, 'DATE')
	if (!date) return undefined
	return parseTemporal(date, 'YYYY-MM-DDTHH:mm:ss.SSS')
}

// Converts a BITPIX code to the number of bytes per pixel (|bitpix| / 8).
export function bitpixInBytes(bitpix: BitpixOrZero) {
	return Math.abs(bitpix) >>> 3
}

// https://fits.gsfc.nasa.gov/registry/tilecompression/tilecompression2.2.pdf

// Tile-compression algorithm name (ZCMPTYPE), normalized to upper case, or undefined when absent.
export function compressionTypeKeyword(header: FitsHeader): FitsCompressionType | undefined {
	return (textKeyword(header, 'ZCMPTYPE', '').trim().toUpperCase() as FitsCompressionType) || undefined
}

// The value of the NAXIS1 keywords in the uncompressed FITS image
export function uncompressedWidthKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'ZNAXIS1', undefined) ?? widthKeyword(header, defaultValue)
}

// The value of the NAXIS2 keywords in the uncompressed FITS image
export function uncompressedHeightKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'ZNAXIS2', undefined) ?? heightKeyword(header, defaultValue)
}

// The value of the NAXIS3 keywords in the uncompressed FITS image
export function uncompressedNumberOfChannelsKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'ZNAXIS3', undefined) ?? numberOfChannelsKeyword(header, defaultValue)
}

// The value of the BITPIX keyword in the uncompressed FITS image
export function uncompressedBitpixKeyword<T extends BitpixOrZero = BitpixOrZero, D extends T | undefined = T>(header: FitsHeader, defaultValue: D) {
	return numericKeyword(header, 'ZBITPIX', undefined) ?? bitpixKeyword(header, defaultValue)
}

// Physical sample multiplier, falling back to ZSCALE only for a compressed image.
export function uncompressedScaleKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D): T | D {
	const scale = numericKeyword<T, undefined>(header, 'BSCALE', undefined)
	if (scale !== undefined) return scale
	return isCompressedImageHeader(header) ? numericKeyword<T, D>(header, 'ZSCALE', defaultValue) : defaultValue
}

// Physical sample zero point, falling back to ZZERO only for a compressed image.
export function uncompressedZeroKeyword<T extends number = number, D extends T | undefined = T>(header: FitsHeader, defaultValue: D): T | D {
	const zero = numericKeyword<T, undefined>(header, 'BZERO', undefined)
	if (zero !== undefined) return zero
	return isCompressedImageHeader(header) ? numericKeyword<T, D>(header, 'ZZERO', defaultValue) : defaultValue
}

// True when the HDU holds a tile-compressed image (ZIMAGE = T).
export function isCompressedImageHeader(header: FitsHeader) {
	return booleanKeyword(header, 'ZIMAGE', false)
}

// ZCMPTYPE value identifying the Rice tile-compression algorithm.
export const RICE_1_COMPRESSION_TYPE = 'RICE_1'

// True when the HDU is a Rice-compressed tile image.
export function isRiceCompressedImageHeader(header: FitsHeader) {
	return isCompressedImageHeader(header) && compressionTypeKeyword(header) === RICE_1_COMPRESSION_TYPE
}

// Computes the HDU data segment size in bytes (before padding): row*rows+PCOUNT for tables, otherwise
// width*height*channels*bytesPerPixel for images.
export function computeHduDataSize(header: FitsHeader) {
	const extension = textKeyword(header, 'XTENSION', '').trim().toUpperCase()

	if (extension === 'BINTABLE' || extension === 'TABLE') {
		const rowSize = widthKeyword(header, 0)
		const rows = heightKeyword(header, 0)
		const pcount = numericKeyword(header, 'PCOUNT', 0)
		return rowSize * rows + pcount
	}

	return widthKeyword(header, 0) * heightKeyword(header, 0) * numberOfChannelsKeyword(header, 1) * bitpixInBytes(bitpixKeyword(header, 0))
}

// Formats a header value for a card: booleans as T/F, numbers verbatim, strings single-quoted and escaped.
export function formatFitsHeaderValue(value: FitsHeaderValue) {
	if (typeof value === 'boolean') return value ? 'T' : 'F'
	if (typeof value === 'number') return `${value}`
	return `'${escapeQuotedText(value ?? '')}'`
}

// Escapes a string for a quoted FITS card by doubling embedded single quotes.
export function escapeQuotedText(text: string) {
	return text.replaceAll("'", "''")
}

// Reverses escapeQuotedText, collapsing doubled single quotes back to one.
export function unescapeQuotedText(text: string) {
	return text.replaceAll("''", "'")
}

// Keywords that carry no value field (commentary cards and the END marker).
const NO_VALUE_KEYWORDS = new Set(['COMMENT', 'HISTORY', 'END'])

// True for a keyword that has no value field (COMMENT, HISTORY, END).
export function isCommentKeyword(keyword: string) {
	return NO_VALUE_KEYWORDS.has(keyword)
}

// True when the card's keyword is a commentary/valueless keyword.
export function isCommentStyleCard(card: Readonly<FitsHeaderCard>) {
	return isCommentKeyword(card[0])
}
