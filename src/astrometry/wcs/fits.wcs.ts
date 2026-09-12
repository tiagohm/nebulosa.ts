import { PI, RAD2DEG } from '../../core/constants'
import type { FitsHeader } from '../../io/formats/fits/fits'
import { hasKeyword, numericKeyword, textKeyword } from '../../io/formats/fits/util'
import { clamp } from '../../math/numerical/math'
import { type Angle, deg, normalizeAngle, normalizePI } from '../../math/units/angle'

// FITS WCS handling for the gnomonic (TAN / TAN-SIP) projection. Reads the CD/PC/CDELT+CROTA keyword
// variants into a unified row-major CD matrix, builds a compact tangent-plane descriptor (tanHeader),
// and provides forward/inverse sky↔pixel transforms (tanProject/tanUnproject) including SIP distortion
// polynomials. Angles are radians; FITS keyword values are in degrees and converted on read.

// Matches direct CD-matrix keywords (CDi_j).
const DIRECT_CD_KEY_PATTERN = /^CD\d+_\d+$/
// Matches PC-matrix keywords (PCi_j).
const PC_KEY_PATTERN = /^PC\d+_\d+$/
// Captures one forward or inverse SIP coefficient and its polynomial powers.
const SIP_COEFFICIENT_KEY_PATTERN = /^(A|AP|B|BP)_(\d+)_(\d+)$/
// Matches every WCS keyword (including SIP terms) handled by this module.
const WCS_FITS_KEY_PATTERN = /^(?:WCSAXES|CUNIT\d+|CTYPE\d+|CRPIX\d+|CRVAL\d+|PS\d+_\d+|PV\d+_\d+|CD\d+_\d+|PC\d+_\d+|CDELT\d+|CROTA\d+|RADESYS|LONPOLE|LATPOLE|EQUINOX|A_\d+_\d+|AP_\d+_\d+|B_\d+_\d+|BP_\d+_\d+|A_ORDER|AP_ORDER|B_ORDER|BP_ORDER|A_DMAX|B_DMAX)$/
// Iteration cap for the Newton inversion of the forward SIP polynomial.
const SIP_MAX_ITERATIONS = 20
// Pixel convergence tolerance for the SIP inversion.
const SIP_TOLERANCE = 1e-9

// Union of FITS WCS keyword names recognized by this module.
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
	| 'A_DMAX'
	| 'B_DMAX'

// Flat, precomputed tangent-plane descriptor packed for hot-path projection. Tuple order:
// crpix1, crpix2, crval1, crval2 (radians), cd11, cd12, cd21, cd22, determinant,
// cosPoleRotation, sinPoleRotation, aOrder, bOrder, apOrder, bpOrder.
export type TanHeader = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] // crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, determinant, cosPoleRotation, sinPoleRotation, aOrder, bOrder, apOrder, bpOrder

// Row-major 2x2 CD matrix [cd11, cd12, cd21, cd22] in degrees per pixel.
export type CDMatrix = readonly [number, number, number, number]

// Which keyword convention supplies the linear transform: direct CD, PC+CDELT, CDELT+CROTA, or none.
export type CDMatrixKind = 'cd' | 'pc' | 'crota' | 'none'

// Returns true when the header has any defined keyword matching the pattern.
function hasMatchingKeyword(header: FitsHeader, pattern: RegExp) {
	for (const key in header) if (header[key] !== undefined && pattern.test(key)) return true
	return false
}

// Detects which CD-matrix convention the header uses, preferring direct CD, then PC, then CROTA.
export function matrixKind(header: FitsHeader): CDMatrixKind {
	if (hasMatchingKeyword(header, DIRECT_CD_KEY_PATTERN)) return 'cd'
	const hasScale = hasKeyword(header, 'CDELT1') && hasKeyword(header, 'CDELT2')
	if (hasScale && hasMatchingKeyword(header, PC_KEY_PATTERN)) return 'pc'
	if (hasScale && hasKeyword(header, 'CROTA2')) return 'crota'
	return 'none'
}

// Reads a PCi_j element, defaulting to the identity (1 on the diagonal, 0 off it).
function pcKeyword(header: FitsHeader, i: number, j: number) {
	return numericKeyword(header, `PC${i}_${j}`, i === j ? 1 : 0)
}

// Returns the trimmed, upper-cased CTYPE axis-type string.
function tanAxisType(header: FitsHeader, key: 'CTYPE1' | 'CTYPE2') {
	return textKeyword(header, key, '').trim().toUpperCase()
}

// CTYPE value for a plain gnomonic right-ascension axis.
export const RA_TAN = 'RA---TAN'
// CTYPE value for a gnomonic right-ascension axis with SIP distortion.
export const RA_TAN_SIP = 'RA---TAN-SIP'
// CTYPE value for a plain gnomonic declination axis.
export const DEC_TAN = 'DEC--TAN'
// CTYPE value for a gnomonic declination axis with SIP distortion.
export const DEC_TAN_SIP = 'DEC--TAN-SIP'

// Returns true when both axes are gnomonic (TAN or TAN-SIP), treating empty CTYPEs as acceptable.
function hasTanAxes(header: FitsHeader) {
	const ctype1 = tanAxisType(header, 'CTYPE1')
	const ctype2 = tanAxisType(header, 'CTYPE2')
	return (!ctype1 || ctype1 === RA_TAN || ctype1 === RA_TAN_SIP) && (!ctype2 || ctype2 === DEC_TAN || ctype2 === DEC_TAN_SIP)
}

// Returns true when both axes declare SIP distortion (TAN-SIP).
function hasSipAxes(header: FitsHeader) {
	return tanAxisType(header, 'CTYPE1') === RA_TAN_SIP && tanAxisType(header, 'CTYPE2') === DEC_TAN_SIP
}

// Reads a SIP polynomial order keyword as a non-negative integer.
function sipOrder(header: FitsHeader, key: 'A_ORDER' | 'B_ORDER' | 'AP_ORDER' | 'BP_ORDER') {
	return Math.trunc(numericKeyword(header, key, 0))
}

// https://fits.gsfc.nasa.gov/registry/sip/SIP_distortion_v1_0.pdf

// Evaluates a SIP distortion polynomial sum(coeff_pq · u^p · v^q) for p+q ≤ order at pixel offset (u, v).
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

// Applies the forward SIP correction, mapping raw pixel offsets (u, v) to distortion-corrected (U, V).
function forwardSip(header: FitsHeader, u: number, v: number, aOrder: number, bOrder: number) {
	return [u + sipPolynomial(header, 'A_', aOrder, u, v), v + sipPolynomial(header, 'B_', bOrder, u, v)] as const
}

// Applies the inverse SIP polynomials (AP/BP), mapping corrected (U, V) back to raw pixel offsets.
function inverseSip(header: FitsHeader, U: number, V: number, apOrder: number, bpOrder: number) {
	return [U + sipPolynomial(header, 'AP_', apOrder, U, V), V + sipPolynomial(header, 'BP_', bpOrder, U, V)] as const
}

// Inverts the forward SIP map by fixed-point iteration when no AP/BP inverse polynomials are present.
// Returns undefined on non-finite iterates; otherwise stops at SIP_TOLERANCE or SIP_MAX_ITERATIONS.
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

// Builds the packed tangent-plane descriptor from a FITS header, or undefined when the axes are not
// gnomonic or the CD matrix is missing/degenerate. Reference values are converted to radians and the
// LONPOLE-derived pole rotation is precomputed for the projection hot path. When LONPOLE is omitted,
// TAN uses the FITS WCS Paper II default: 0° if CRVAL2 ≥ 90° (north celestial pole) and 180° otherwise.
export function tanHeader(header: FitsHeader): TanHeader | undefined {
	if (!hasTanAxes(header)) return undefined

	const crpix1 = numericKeyword(header, 'CRPIX1', Number.NaN)
	const crpix2 = numericKeyword(header, 'CRPIX2', Number.NaN)
	const crval1 = deg(numericKeyword(header, 'CRVAL1', Number.NaN))
	let crval2 = numericKeyword(header, 'CRVAL2', Number.NaN)
	// Zenithal TAN has φ0 = 0° and θ0 = 90°. Paper II sets omitted LONPOLE to φ0 when δ0 ≥ θ0.
	const lonpole = deg(numericKeyword(header, 'LONPOLE', crval2 >= 90 ? 0 : 180))
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

	crval2 = deg(crval2)

	return [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, determinant, cosPoleRotation, sinPoleRotation, aOrder, bOrder, apOrder, bpOrder]
}

// Reports whether the header contains enough WCS terms to build a CD matrix directly.
export function hasCd(header: FitsHeader) {
	return matrixKind(header) !== 'none'
}

// Builds the 2x2 CD matrix in row-major order from FITS WCS keywords.
export function cdMatrix(header: FitsHeader, kind: CDMatrixKind = matrixKind(header)): CDMatrix {
	switch (kind) {
		case 'cd':
			return [numericKeyword(header, 'CD1_1', 0), numericKeyword(header, 'CD1_2', 0), numericKeyword(header, 'CD2_1', 0), numericKeyword(header, 'CD2_2', 0)]
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
// Uses the canonical WCS Paper II conversion (eqs. 186-189): CD1_1 = CDELT1·cos, CD1_2 = -CDELT2·sin,
// CD2_1 = CDELT1·sin, CD2_2 = CDELT2·cos. A flip negates the corresponding axis scale. This is valid
// for every sign combination of the CDELTs; a sign/abs formulation mirrors the rotation when both
// CDELTs share a sign.
export function cdFromCdelt(cdelt1: number, cdelt2: number, crota: Angle, flipH: boolean = false, flipV: boolean = false): CDMatrix {
	const cos0 = Math.cos(crota)
	const sin0 = Math.sin(crota)
	const scale1 = flipH ? -cdelt1 : cdelt1
	const scale2 = flipV ? -cdelt2 : cdelt2
	const cd11 = scale1 * cos0
	const cd12 = -scale2 * sin0
	const cd21 = scale1 * sin0
	const cd22 = scale2 * cos0
	return [cd11, cd12, cd21, cd22]
}

// Applies CDELT scaling to a row-major PC matrix to produce a row-major CD matrix.
export function pc2cd(pc11: number, pc12: number, pc21: number, pc22: number, cdelt1: number, cdelt2: number): CDMatrix {
	return [cdelt1 * pc11, cdelt1 * pc12, cdelt2 * pc21, cdelt2 * pc22]
}

// Reflects a FITS WCS in place across either image axis. Dimensions and CRPIX use FITS one-based
// coordinates. CD, PC+CDELT, CDELT+CROTA, and forward/inverse SIP terms remain equivalent at the
// mirrored pixel coordinates. Returns the same header object.
export function reflectFitsWcs(header: FitsHeader, width: number, height: number, horizontal: boolean, vertical: boolean) {
	if (!Number.isInteger(width) || !(width > 0)) throw new RangeError(`WCS reflection width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || !(height > 0)) throw new RangeError(`WCS reflection height must be a positive integer: ${height}`)
	if (!horizontal && !vertical) return header

	const sx = horizontal ? -1 : 1
	const sy = vertical ? -1 : 1
	const crpix1 = numericKeyword(header, 'CRPIX1', Number.NaN)
	const crpix2 = numericKeyword(header, 'CRPIX2', Number.NaN)
	if (horizontal && Number.isFinite(crpix1)) header.CRPIX1 = width + 1 - crpix1
	if (vertical && Number.isFinite(crpix2)) header.CRPIX2 = height + 1 - crpix2

	switch (matrixKind(header)) {
		case 'cd': {
			const [cd11, cd12, cd21, cd22] = cdMatrix(header, 'cd')
			header.CD1_1 = sx * cd11
			header.CD1_2 = sy * cd12
			header.CD2_1 = sx * cd21
			header.CD2_2 = sy * cd22
			break
		}
		case 'pc': {
			const pc11 = pcKeyword(header, 1, 1)
			const pc12 = pcKeyword(header, 1, 2)
			const pc21 = pcKeyword(header, 2, 1)
			const pc22 = pcKeyword(header, 2, 2)
			header.PC1_1 = sx * pc11
			header.PC1_2 = sy * pc12
			header.PC2_1 = sx * pc21
			header.PC2_2 = sy * pc22
			break
		}
		default:
			if (horizontal && hasKeyword(header, 'CDELT1')) header.CDELT1 = -numericKeyword(header, 'CDELT1', 0)
			if (vertical && hasKeyword(header, 'CDELT2')) header.CDELT2 = -numericKeyword(header, 'CDELT2', 0)
	}

	for (const key in header) {
		const match = SIP_COEFFICIENT_KEY_PATTERN.exec(key)
		if (!match || typeof header[key] !== 'number') continue
		const prefix = match[1]
		const p = +match[2]
		const q = +match[3]
		const axisSign = prefix === 'B' || prefix === 'BP' ? sy : sx
		const xPowerSign = sx < 0 && (p & 1) !== 0 ? -1 : 1
		const yPowerSign = sy < 0 && (q & 1) !== 0 ? -1 : 1
		header[key] *= axisSign * xPowerSign * yPowerSign
	}

	return header
}

// Primary/alternate solution terms, including pixel distortion conventions that cannot be resized.
const RESIZED_WCS_KEY_PATTERN =
	/^(?:(?:WCSAXES|WCSNAME|CUNIT\d+|CTYPE\d+|CRPIX\d+|CRVAL\d+|PS\d+_\d+|PV\d+_\d+|CD\d+_\d+|PC\d+_\d+|CDELT\d+|CROTA\d+|RADESYS|LONPOLE|LATPOLE|EQUINOX|A_\d+_\d+|AP_\d+_\d+|B_\d+_\d+|BP_\d+_\d+|A_ORDER|AP_ORDER|B_ORDER|BP_ORDER|A_DMAX|B_DMAX)[A-Z]?|(?:CPDIS|CQDIS|D2IMDIS|DET2IM)\d+[A-Z]?|(?:DP|DQ|D2IM)\d+(?:\..*)?)$/

// Explicit primary axis declarations distinguish a WCS using implicit defaults from observation-only metadata.
const RESIZED_WCS_AXIS_PATTERN = /^(?:WCSAXES|CUNIT\d+|CTYPE\d+|CRPIX\d+|CRVAL\d+|CD\d+_\d+|PC\d+_\d+|CDELT\d+|CROTA\d+)$/

// Resizes/crops a cloned FITS header in place and returns it. scaleX/Y are positive output samples per
// input pixel; left/top are crop offsets in the enlarged grid. CRPIX uses FITS base-1 centers.
// Supports a primary two-axis linear WCS and TAN-SIP, including optional AP/BP. Alternate solutions
// and unsupported/malformed pixel distortions are removed completely, never presented as linear TAN.
// FITS 4.0 section 8.2 defaults apply to declared axes: CRPIX/CRVAL=0, CDELT=1 and PC=identity.
// Headers without axis declarations do not acquire a synthetic solution.
export function scaleAndCropFitsWcs(header: FitsHeader, scaleX: number, scaleY: number, left: number, top: number) {
	for (const key in header) {
		if (/[A-Z]$/.test(key) && RESIZED_WCS_KEY_PATTERN.test(key) && RESIZED_WCS_KEY_PATTERN.test(key.slice(0, -1))) delete header[key]
	}

	const hasAxes = hasMatchingKeyword(header, RESIZED_WCS_AXIS_PATTERN)
	// Materialize scale defaults for the shared CD/PC/CROTA reader. The canonical CD output below
	// removes these cards again; no additional header clone is needed.
	if (hasAxes) {
		header.CDELT1 ??= 1
		header.CDELT2 ??= 1
	}

	const [a, b, c, d] = cdMatrix(header)
	const crpix1 = numericKeyword(header, 'CRPIX1', 0)
	const crpix2 = numericKeyword(header, 'CRPIX2', 0)
	const crval1 = numericKeyword(header, 'CRVAL1', 0)
	const crval2 = numericKeyword(header, 'CRVAL2', 0)
	const sip = hasSipAxes(header)

	let supported = hasAxes && Number.isFinite(crpix1) && Number.isFinite(crpix2) && Number.isFinite(crval1) && Number.isFinite(crval2) && Number.isFinite(a * d - b * c) && a * d - b * c !== 0 && numericKeyword(header, 'WCSAXES', 2) === 2
	if (tanAxisType(header, 'CTYPE1').includes('-SIP') || tanAxisType(header, 'CTYPE2').includes('-SIP')) supported &&= sip

	for (const key in header) {
		if (header[key] === undefined) continue
		if (/^(?:(?:CPDIS|CQDIS|D2IMDIS|DET2IM)\d|(?:DP|DQ|D2IM)\d|(?:PV|PS)\d+_)/.test(key)) supported = false
		const matrixAxis = /^(?:CD|PC)(\d+)_(\d+)$/.exec(key)
		const scalarAxis = /^(?:CTYPE|CRPIX|CRVAL|CDELT|CUNIT|CROTA)(\d+)$/.exec(key)
		if ((matrixAxis && !(+matrixAxis[1] >= 1 && +matrixAxis[1] <= 2 && +matrixAxis[2] >= 1 && +matrixAxis[2] <= 2)) || (scalarAxis && !(+scalarAxis[1] >= 1 && +scalarAxis[1] <= 2))) supported = false
		if (/^CTYPE[12]$/.test(key) && /(?:-TAB|-TPV|-TNX|-ZPX|-DSS)/.test(String(header[key]))) supported = false
		if (SIP_COEFFICIENT_KEY_PATTERN.test(key) || /^(?:A|B|AP|BP)_(?:ORDER|DMAX)$/.test(key)) {
			if (!sip || typeof header[key] !== 'number' || !Number.isFinite(header[key])) supported = false
		}
	}

	if (sip) {
		for (const prefix of ['A', 'B', 'AP', 'BP']) {
			const order = header[`${prefix}_ORDER`]
			const required = prefix === 'A' || prefix === 'B'
			if (required || order !== undefined) supported &&= typeof order === 'number' && Number.isInteger(order) && order >= 0
		}

		if ((header.AP_ORDER === undefined) !== (header.BP_ORDER === undefined)) supported = false

		for (const key in header) {
			if (header[key] === undefined) continue
			const match = SIP_COEFFICIENT_KEY_PATTERN.exec(key)
			if (match && !(+match[2] + +match[3] <= numericKeyword(header, `${match[1]}_ORDER`, -1))) supported = false
		}
	}

	if (!supported) {
		for (const key in header) if (RESIZED_WCS_KEY_PATTERN.test(key)) delete header[key]
		return header
	}

	header.CRPIX1 = (crpix1 - 0.5) * scaleX + 0.5 - left
	header.CRPIX2 = (crpix2 - 0.5) * scaleY + 0.5 - top
	header.CRVAL1 = crval1
	header.CRVAL2 = crval2
	header.CD1_1 = a / scaleX
	header.CD1_2 = b / scaleY
	header.CD2_1 = c / scaleX
	header.CD2_2 = d / scaleY

	for (const key in header) {
		if (/^(?:PC[12]_[12]|CDELT[12]|CROTA[12])$/.test(key)) delete header[key]

		const match = SIP_COEFFICIENT_KEY_PATTERN.exec(key)

		if (match && header[key] !== undefined) {
			const xAxis = match[1] === 'A' || match[1] === 'AP'
			header[key] = numericKeyword(header, key, 0) * scaleX ** ((xAxis ? 1 : 0) - +match[2]) * scaleY ** ((xAxis ? 0 : 1) - +match[3])
		}
	}

	if (typeof header.A_DMAX === 'number') header.A_DMAX *= scaleX
	if (typeof header.B_DMAX === 'number') header.B_DMAX *= scaleY

	return header
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
