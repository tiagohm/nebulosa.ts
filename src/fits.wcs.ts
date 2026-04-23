import { type Angle, deg, normalizeAngle, normalizePI } from './angle'
import { PI, RAD2DEG } from './constants'
import type { FitsHeader } from './fits'
import { hasKeyword, numericKeyword, textKeyword } from './fits.util'
import { clamp } from './math'

const DIRECT_CD_KEY_PATTERN = /^CD\d+_\d+$/
const PC_KEY_PATTERN = /^PC\d+_\d+$/
const WCS_FITS_KEY_PATTERN = /^(?:WCSAXES|CUNIT\d+|CTYPE\d+|CRPIX\d+|CRVAL\d+|PS\d+_\d+|PV\d+_\d+|CD\d+_\d+|PC\d+_\d+|CDELT\d+|CROTA\d+|RADESYS|LONPOLE|LATPOLE|EQUINOX|A_\d+_\d+|AP_\d+_\d+|B_\d+_\d+|BP_\d+_\d+|A_ORDER|AP_ORDER|B_ORDER|BP_ORDER)$/
const SIP_MAX_ITERATIONS = 20
const SIP_TOLERANCE = 1e-9

export type WcsFitsKeywords =
	| 'WCSAXES'
	| `CUNIT${number}`
	| `CTYPE${number}`
	| `CRPIX${number}`
	| `CRVAL${number}`
	| `PS${number}_${number}`
	| `PV${number}_${number}`
	| `CD${number}_${number}`
	| `PC${number}_${number}`
	| `CDELT${number}`
	| `CROTA${number}`
	| 'RADESYS'
	| 'LONPOLE'
	| 'LATPOLE'
	| 'EQUINOX'
	| `A_${number}_${number}`
	| `AP_${number}_${number}`
	| `B_${number}_${number}`
	| `BP_${number}_${number}`
	| 'A_ORDER'
	| 'AP_ORDER'
	| 'B_ORDER'
	| 'BP_ORDER'

function hasMatchingKeyword(header: FitsHeader, pattern: RegExp) {
	for (const key in header) if (header[key] !== undefined && pattern.test(key)) return true
	return false
}

function matrixKind(header: FitsHeader) {
	if (hasMatchingKeyword(header, DIRECT_CD_KEY_PATTERN)) return 'cd'
	const hasScale = hasKeyword(header, 'CDELT1') && hasKeyword(header, 'CDELT2')
	if (hasScale && hasMatchingKeyword(header, PC_KEY_PATTERN)) return 'pc'
	if (hasScale && hasKeyword(header, 'CROTA2')) return 'crota'
	return 'none'
}

function pcKeyword(header: FitsHeader, i: number, j: number) {
	return numericKeyword(header, `PC${i}_${j}`, i === j ? 1 : 0)
}

function tanAxisType(header: FitsHeader, key: 'CTYPE1' | 'CTYPE2') {
	return textKeyword(header, key, '').trim().toUpperCase()
}

const RA_TAN = 'RA---TAN'
const RA_TAN_SIP = 'RA---TAN-SIP'
const DEC_TAN = 'DEC--TAN'
const DEC_TAN_SIP = 'DEC--TAN-SIP'

function hasTanAxes(header: FitsHeader) {
	const ctype1 = tanAxisType(header, 'CTYPE1')
	const ctype2 = tanAxisType(header, 'CTYPE2')
	return (!ctype1 || ctype1 === RA_TAN || ctype1 === RA_TAN_SIP) && (!ctype2 || ctype2 === DEC_TAN || ctype2 === DEC_TAN_SIP)
}

function hasSipAxes(header: FitsHeader) {
	return tanAxisType(header, 'CTYPE1') === RA_TAN_SIP && tanAxisType(header, 'CTYPE2') === DEC_TAN_SIP
}

function sipOrder(header: FitsHeader, key: 'A_ORDER' | 'B_ORDER' | 'AP_ORDER' | 'BP_ORDER') {
	return Math.trunc(numericKeyword(header, key, 0))
}

// https://fits.gsfc.nasa.gov/registry/sip/SIP_distortion_v1_0.pdf

function sipPolynomial(header: FitsHeader, prefix: 'A_' | 'B_' | 'AP_' | 'BP_', order: number, u: number, v: number) {
	if (order <= 0) return 0

	let value = 0
	let up = 1

	for (let p = 0; p <= order; p++) {
		let vq = 1

		for (let q = 0; p + q <= order; q++) {
			value += numericKeyword(header, `${prefix}${p}_${q}`, 0) * up * vq
			vq *= v
		}

		up *= u
	}

	return value
}

function forwardSip(header: FitsHeader, u: number, v: number, aOrder: number, bOrder: number) {
	return [u + sipPolynomial(header, 'A_', aOrder, u, v), v + sipPolynomial(header, 'B_', bOrder, u, v)] as const
}

function inverseSip(header: FitsHeader, U: number, V: number, apOrder: number, bpOrder: number) {
	return [U + sipPolynomial(header, 'AP_', apOrder, U, V), V + sipPolynomial(header, 'BP_', bpOrder, U, V)] as const
}

function invertForwardSip(header: FitsHeader, U: number, V: number, aOrder: number, bOrder: number) {
	let u = U
	let v = V

	for (let i = 0; i < SIP_MAX_ITERATIONS; i++) {
		const nextU = U - sipPolynomial(header, 'A_', aOrder, u, v)
		const nextV = V - sipPolynomial(header, 'B_', bOrder, u, v)

		if (!Number.isFinite(nextU) || !Number.isFinite(nextV)) return undefined
		if (Math.abs(nextU - u) <= SIP_TOLERANCE && Math.abs(nextV - v) <= SIP_TOLERANCE) return [nextU, nextV] as const

		u = nextU
		v = nextV
	}

	return [u, v] as const
}

function tanHeader(header: FitsHeader) {
	if (!hasTanAxes(header)) return undefined

	const crpix1 = numericKeyword(header, 'CRPIX1', Number.NaN)
	const crpix2 = numericKeyword(header, 'CRPIX2', Number.NaN)
	const crval1 = deg(numericKeyword(header, 'CRVAL1', Number.NaN))
	const crval2 = deg(numericKeyword(header, 'CRVAL2', Number.NaN))
	const lonpole = deg(numericKeyword(header, 'LONPOLE', 180))
	const [cd11, cd12, cd21, cd22] = cdMatrix(header)
	const scale = Math.max(Math.abs(cd11), Math.abs(cd12), Math.abs(cd21), Math.abs(cd22))
	const determinant = cd11 * cd22 - cd12 * cd21
	const poleRotation = normalizePI(lonpole - PI)
	const cosPoleRotation = Math.cos(poleRotation)
	const sinPoleRotation = Math.sin(poleRotation)
	const sip = hasSipAxes(header)
	const aOrder = sip ? sipOrder(header, 'A_ORDER') : 0
	const bOrder = sip ? sipOrder(header, 'B_ORDER') : 0
	const apOrder = sip ? sipOrder(header, 'AP_ORDER') : 0
	const bpOrder = sip ? sipOrder(header, 'BP_ORDER') : 0

	if (!Number.isFinite(crpix1) || !Number.isFinite(crpix2) || !Number.isFinite(crval1) || !Number.isFinite(crval2) || !Number.isFinite(determinant) || !(scale > 0) || Math.abs(determinant) <= Number.EPSILON * scale * scale) {
		return undefined
	}

	return [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, determinant, cosPoleRotation, sinPoleRotation, aOrder, bOrder, apOrder, bpOrder] as const
}

// Reports whether the header contains enough WCS terms to build a CD matrix directly.
export function hasCd(header: FitsHeader) {
	return matrixKind(header) !== 'none'
}

// Builds the 2x2 CD matrix in row-major order from FITS WCS keywords.
export function cdMatrix(header: FitsHeader) {
	switch (matrixKind(header)) {
		case 'cd':
			return [numericKeyword(header, 'CD1_1', 0), numericKeyword(header, 'CD1_2', 0), numericKeyword(header, 'CD2_1', 0), numericKeyword(header, 'CD2_2', 0)] as const
		case 'pc': {
			const a = numericKeyword(header, 'CDELT1', 0)
			const b = numericKeyword(header, 'CDELT2', 0)
			return pc2cd(pcKeyword(header, 1, 1), pcKeyword(header, 1, 2), pcKeyword(header, 2, 1), pcKeyword(header, 2, 2), a, b)
		}
		default: {
			const a = numericKeyword(header, 'CDELT1', 0)
			const b = numericKeyword(header, 'CDELT2', 0)
			const c = deg(numericKeyword(header, 'CROTA2', 0))
			return cdFromCdelt(a, b, c)
		}
	}
}

// Returns one element of the row-major 2x2 CD matrix using 1-based FITS indices.
export function cd(header: FitsHeader, i: number, j: number) {
	const matrix = cdMatrix(header)
	return matrix[(i - 1) * 2 + (j - 1)]
}

// Converts CDELT and CROTA2 keywords into a row-major CD matrix, optionally flipping axes.
export function cdFromCdelt(cdelt1: number, cdelt2: number, crota: Angle, flipH: boolean = false, flipV: boolean = false) {
	const cos0 = Math.cos(crota)
	const sin0 = Math.sin(crota)
	const cd11 = (flipH ? -cdelt1 : cdelt1) * cos0
	const cd12 = (flipV ? -Math.abs(cdelt2) : Math.abs(cdelt2)) * Math.sign(cdelt1) * sin0
	const cd21 = (flipH ? Math.abs(cdelt1) : -Math.abs(cdelt1)) * Math.sign(cdelt2) * sin0
	const cd22 = (flipV ? -cdelt2 : cdelt2) * cos0
	return [cd11, cd12, cd21, cd22] as const
}

// Applies CDELT scaling to a row-major PC matrix to produce a row-major CD matrix.
export function pc2cd(pc11: number, pc12: number, pc21: number, pc22: number, cdelt1: number, cdelt2: number) {
	return [cdelt1 * pc11, cdelt1 * pc12, cdelt2 * pc21, cdelt2 * pc22] as const
}

// Projects equatorial coordinates onto FITS TAN pixel coordinates using the header WCS.
export function tanProject(header: FitsHeader, rightAscension: Angle, declination: Angle) {
	const tan = tanHeader(header)
	if (!tan) return undefined

	const [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, determinant, cosPoleRotation, sinPoleRotation, aOrder, bOrder, apOrder, bpOrder] = tan
	const deltaRa = normalizePI(rightAscension - crval1)
	const sinDec = Math.sin(declination)
	const cosDec = Math.cos(declination)
	const sinDec0 = Math.sin(crval2)
	const cosDec0 = Math.cos(crval2)
	const sinDeltaRa = Math.sin(deltaRa)
	const cosDeltaRa = Math.cos(deltaRa)
	const denominator = sinDec0 * sinDec + cosDec0 * cosDec * cosDeltaRa
	if (denominator <= 0) return undefined

	const xi = (cosDec * sinDeltaRa) / denominator
	const eta = (cosDec0 * sinDec - sinDec0 * cosDec * cosDeltaRa) / denominator
	const xIntermediate = (xi * cosPoleRotation - eta * sinPoleRotation) * RAD2DEG
	const yIntermediate = (xi * sinPoleRotation + eta * cosPoleRotation) * RAD2DEG
	const U = (cd22 * xIntermediate - cd12 * yIntermediate) / determinant
	const V = (-cd21 * xIntermediate + cd11 * yIntermediate) / determinant
	const distorted = apOrder > 0 && bpOrder > 0 ? inverseSip(header, U, V, apOrder, bpOrder) : invertForwardSip(header, U, V, aOrder, bOrder)
	if (!distorted) return undefined
	return [crpix1 + distorted[0], crpix2 + distorted[1]] as const
}

// Unprojects FITS TAN pixel coordinates into equatorial coordinates using the header WCS.
export function tanUnproject(header: FitsHeader, x: number, y: number) {
	const tan = tanHeader(header)
	if (!tan) return undefined

	const [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, , cosPoleRotation, sinPoleRotation, aOrder, bOrder] = tan
	const [U, V] = forwardSip(header, x - crpix1, y - crpix2, aOrder, bOrder)
	const xIntermediate = deg(cd11 * U + cd12 * V)
	const yIntermediate = deg(cd21 * U + cd22 * V)
	const xi = xIntermediate * cosPoleRotation + yIntermediate * sinPoleRotation
	const eta = -xIntermediate * sinPoleRotation + yIntermediate * cosPoleRotation
	const rho = Math.hypot(xi, eta)
	if (rho === 0) return [normalizeAngle(crval1), crval2] as const

	const c = Math.atan(rho)
	const sinC = Math.sin(c)
	const cosC = Math.cos(c)
	const sinDec0 = Math.sin(crval2)
	const cosDec0 = Math.cos(crval2)
	const declination = Math.asin(clamp(cosC * sinDec0 + (eta * sinC * cosDec0) / rho, -1, 1))
	const rightAscension = normalizeAngle(crval1 + Math.atan2(xi * sinC, rho * cosDec0 * cosC - eta * sinDec0 * sinC))
	return [rightAscension, declination] as const
}

// Checks whether a FITS header key belongs to the WCS keyword set handled by this module.
export function isWcsFitsKeyword(key: keyof FitsHeader): key is WcsFitsKeywords {
	return WCS_FITS_KEY_PATTERN.test(key)
}
