import { type Angle, deg, parseAngle } from './angle'
import type { BitpixOrZero, FitsCompressionType, FitsHeader, FitsHeaderCard, FitsHeaderKey, FitsHeaderValue } from './fits'
import type { CfaPattern } from './image.types'
import { parseTemporal } from './temporal'

export function hasKeyword(header: FitsHeader, key: FitsHeaderKey) {
	return key in header && header[key] !== undefined
}

export function numericKeyword<T extends number | undefined = number>(header: FitsHeader, key: FitsHeaderKey, defaultValue: NoInfer<T>) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value
	else if (typeof value === 'boolean') return value ? 1 : 0
	else return parseFloat(value)
}

export function booleanKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: boolean = false) {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'number') return value !== 0
	else if (typeof value === 'string') return value === 'T' || value.toLowerCase() === 'true'
	else return value
}

export function textKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: string = '') {
	const value = header[key]
	if (value === undefined) return defaultValue
	else if (typeof value === 'string') return value
	else return `${value}`
}

export function numberOfAxesKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T>(header, 'NAXIS', defaultValue)
}

export function widthKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'NAXIS1', undefined) ?? numericKeyword<T>(header, 'IMAGEW', defaultValue)
}

export function heightKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'NAXIS2', undefined) ?? numericKeyword<T>(header, 'IMAGEH', defaultValue)
}

export function numberOfChannelsKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T>(header, 'NAXIS3', defaultValue)
}

export function bitpixKeyword<T extends BitpixOrZero | undefined = BitpixOrZero>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T>(header, 'BITPIX', defaultValue) as T
}

export function exposureTimeKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'EXPTIME', undefined) ?? numericKeyword<T>(header, 'EXPOSURE', defaultValue)
}

export function cfaPatternKeyword(header: FitsHeader) {
	return textKeyword(header, 'BAYERPAT') as CfaPattern | undefined
}

export function rightAscensionKeyword<T extends Angle | undefined = Angle>(header: FitsHeader, defaultValue: NoInfer<T>) {
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

export function declinationKeyword<T extends Angle | undefined = Angle>(header: FitsHeader, defaultValue: NoInfer<T>) {
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

export function observationDateKeyword(header: FitsHeader) {
	const date = textKeyword(header, 'DATE-OBS') || textKeyword(header, 'DATE-END') || textKeyword(header, 'DATE')
	if (!date) return undefined
	return parseTemporal(date, 'YYYY-MM-DDTHH:mm:ss.SSS')
}

export function bitpixInBytes(bitpix: BitpixOrZero) {
	return Math.abs(bitpix) >>> 3
}

// https://fits.gsfc.nasa.gov/registry/tilecompression/tilecompression2.2.pdf

export function compressionTypeKeyword(header: FitsHeader): FitsCompressionType | undefined {
	return (textKeyword(header, 'ZCMPTYPE', '').trim().toUpperCase() as FitsCompressionType) || undefined
}

// The value of the NAXIS1 keywords in the uncompressed FITS image
export function uncompressedWidthKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'ZNAXIS1', undefined) ?? widthKeyword<T>(header, defaultValue)
}

// The value of the NAXIS2 keywords in the uncompressed FITS image
export function uncompressedHeightKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'ZNAXIS2', undefined) ?? heightKeyword<T>(header, defaultValue)
}

// The value of the NAXIS3 keywords in the uncompressed FITS image
export function uncompressedNumberOfChannelsKeyword<T extends number | undefined = number>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return numericKeyword<T | undefined>(header, 'ZNAXIS3', undefined) ?? numberOfChannelsKeyword<T>(header, defaultValue)
}

// The value of the BITPIX keyword in the uncompressed FITS image
export function uncompressedBitpixKeyword<T extends BitpixOrZero | undefined = BitpixOrZero>(header: FitsHeader, defaultValue: NoInfer<T>) {
	return (numericKeyword<T | undefined>(header, 'ZBITPIX', undefined) ?? bitpixKeyword(header, defaultValue)) as T
}

export function isCompressedImageHeader(header: FitsHeader) {
	return booleanKeyword(header, 'ZIMAGE', false)
}

export const RICE_1_COMPRESSION_TYPE = 'RICE_1'

export function isRiceCompressedImageHeader(header: FitsHeader) {
	return isCompressedImageHeader(header) && compressionTypeKeyword(header) === RICE_1_COMPRESSION_TYPE
}

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

export function formatFitsHeaderValue(value: FitsHeaderValue) {
	if (typeof value === 'boolean') return value ? 'T' : 'F'
	if (typeof value === 'number') return `${value}`
	return `'${escapeQuotedText(value ?? '')}'`
}

export function escapeQuotedText(text: string) {
	return text.replaceAll("'", "''")
}

export function unescapeQuotedText(text: string) {
	return text.replaceAll("''", "'")
}

const NO_VALUE_KEYWORDS = new Set(['COMMENT', 'HISTORY', 'END'])

export function isCommentKeyword(keyword: string) {
	return NO_VALUE_KEYWORDS.has(keyword)
}

export function isCommentStyleCard(card: Readonly<FitsHeaderCard>) {
	return isCommentKeyword(card[0])
}
