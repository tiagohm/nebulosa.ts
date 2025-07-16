import { type Angle, deg, parseAngle } from './angle'
import type { BitpixOrZero, FitsHeader, FitsHeaderKey } from './fits'
import type { CfaPattern } from './image'

export const FITS_IMAGE_MIME_TYPE = 'image/fits'
export const FITS_APPLICATION_MIME_TYPE = 'application/fits'

export function hasKeyword(header: FitsHeader, key: FitsHeaderKey) {
	return key in header && header[key] !== undefined
}

export function numericKeyword(header: FitsHeader, key: FitsHeaderKey, defaultValue: number = 0) {
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

export function naxis(header: FitsHeader, defaultValue: number = 0) {
	return numericKeyword(header, 'NAXIS', defaultValue)
}

export function width(header: FitsHeader, defaultValue: number = 0) {
	return numericKeyword(header, 'NAXIS1') || numericKeyword(header, 'IMAGEW', defaultValue)
}

export function height(header: FitsHeader, defaultValue: number = 0) {
	return numericKeyword(header, 'NAXIS2') || numericKeyword(header, 'IMAGEH', defaultValue)
}

export function numberOfChannels(header: FitsHeader, defaultValue: number = 1) {
	return numericKeyword(header, 'NAXIS3', defaultValue)
}

export function bitpix(header: FitsHeader, defaultValue: BitpixOrZero = 0): BitpixOrZero {
	return numericKeyword(header, 'BITPIX', defaultValue)
}

export function exposureTime(header: FitsHeader, defaultValue: number = 0) {
	if (hasKeyword(header, 'EXPTIME')) return numericKeyword(header, 'EXPTIME', defaultValue)
	else return numericKeyword(header, 'EXPOSURE', defaultValue)
}

export function cfaPattern(header: FitsHeader) {
	return textKeyword(header, 'BAYERPAT') as CfaPattern | undefined
}

export function rightAscension(header: FitsHeader, defaultValue: Angle = 0) {
	if (hasKeyword(header, 'RA')) {
		const value = deg(numericKeyword(header, 'RA', defaultValue))
		if (value && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'OBJCTRA')) {
		const value = parseAngle(textKeyword(header, 'OBJCTRA', ''), { isHour: true })
		if (value && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'RA_OBJ')) {
		const value = deg(numericKeyword(header, 'RA_OBJ', defaultValue))
		if (value && value !== defaultValue) return value
	}

	return defaultValue
}

export function declination(header: FitsHeader, defaultValue: Angle = 0) {
	if (hasKeyword(header, 'DEC')) {
		const value = deg(numericKeyword(header, 'DEC', defaultValue))
		if (value && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'OBJCTDEC')) {
		const value = parseAngle(textKeyword(header, 'OBJCTDEC', ''))
		if (value && value !== defaultValue) return value
	}

	if (hasKeyword(header, 'DEC_OBJ')) {
		const value = deg(numericKeyword(header, 'DEC_OBJ', defaultValue))
		if (value && value !== defaultValue) return value
	}

	return defaultValue
}

export function bitpixInBytes(bitpix: BitpixOrZero) {
	return Math.trunc(Math.abs(bitpix) / 8)
}
