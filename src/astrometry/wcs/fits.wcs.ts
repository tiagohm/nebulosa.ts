import { PI, RAD2DEG } from '../../core/constants'
import type { FitsHeader } from '../../io/formats/fits/fits'
import { hasKeyword, numericKeyword, textKeyword } from '../../io/formats/fits/util'
import { clamp } from '../../math/numerical/math'
import { type Angle, deg, normalizeAngle, normalizePI } from '../../math/units/angle'

// FITS WCS handling for the gnomonic (TAN / TAN-SIP) projection. Reads the CD/PC/CDELT+CROTA keyword
// variants into a unified row-major CD matrix, builds a compact tangent-plane descriptor (tanHeader),
// and provides forward/inverse sky↔pixel transforms (tanProject/tanUnproject) including SIP distortion
// polynomials, whose orders and coefficients are validated on every read (sipOrdersValid, sipKeywordsValid).
// Non-canonical forward constant/linear terms written by ASTAP are evaluated without changing the header.
// Angles are radians; FITS keyword values are in degrees and converted on read. References: FITS Standard 4.0
// §8, WCS Papers I/II (Greisen & Calabretta 2002; Calabretta & Greisen 2002) and the SIP convention.

// Matches direct CD-matrix keywords (CDi_j).
const DIRECT_CD_KEY_PATTERN = /^CD\d+_\d+$/
// Matches PC-matrix keywords (PCi_j).
const PC_KEY_PATTERN = /^PC\d+_\d+$/
// Captures one forward or inverse SIP coefficient and its polynomial powers.
const SIP_COEFFICIENT_KEY_PATTERN = /^(A|AP|B|BP)_(\d+)_(\d+)$/
// Matches every WCS keyword (including SIP terms) handled by this module.
const WCS_FITS_KEY_PATTERN = /^(?:WCSAXES|CUNIT\d+|CTYPE\d+|CRPIX\d+|CRVAL\d+|PS\d+_\d+|PV\d+_\d+|CD\d+_\d+|PC\d+_\d+|CDELT\d+|CROTA\d+|RADESYS|LONPOLE|LATPOLE|EQUINOX|A_\d+_\d+|AP_\d+_\d+|B_\d+_\d+|BP_\d+_\d+|A_ORDER|AP_ORDER|B_ORDER|BP_ORDER|A_DMAX|B_DMAX)$/
// Iteration cap for the fixed-point inversion of the forward SIP polynomial.
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

// Largest SIP polynomial order accepted, forward or reverse. It bounds the O(order²) evaluation of an order
// read from a file; astrometry.net writes at most SIP_MAXORDER - 1 = 9.
const SIP_MAX_ORDER = 9
// Smallest declared forward SIP order. Canonical SIP starts at degree 2; ASTAP's constant/linear terms are
// also preserved within a declared order of at least 2.
const SIP_MIN_FORWARD_ORDER = 2

// Projection a CTYPE pair declares: plain gnomonic, gnomonic with SIP distortion, or none of them.
type TanAxes = 'tan' | 'sip'

// Forward and reverse SIP polynomials of a validated TAN-SIP header, packed in one array: the A, B, AP and
// BP blocks follow each other from their offsets, each indexed p · (order + 1) + q for the term u^p · v^q and
// holding zero for every term the header omits. An absent reverse polynomial has order -1 and an empty block.
interface SipPolynomials {
	readonly aOrder: number
	readonly bOrder: number
	readonly apOrder: number
	readonly bpOrder: number
	readonly coefficients: Float64Array
	readonly bOffset: number
	readonly apOffset: number
	readonly bpOffset: number
}

// Tangent-plane descriptor with the SIP polynomials of a TAN-SIP header, read and validated together once per
// projection call. A FitsHeader is mutable, so nothing is cached across calls.
interface TanDescriptor {
	readonly tan: TanHeader
	readonly sip?: SipPolynomials
}

// Returns the projection the CTYPE pair declares. Only the exact pairs (RA---TAN, DEC--TAN) and
// (RA---TAN-SIP, DEC--TAN-SIP) are gnomonic; a mixed pair, a single declared axis or another projection is
// none. Two empty CTYPEs are read as plain TAN, the convention of the synthetic headers built internally,
// although FITS would make them linear axes; plateSolutionFrom requires them declared.
function tanAxes(header: FitsHeader): TanAxes | undefined {
	const ctype1 = tanAxisType(header, 'CTYPE1')
	const ctype2 = tanAxisType(header, 'CTYPE2')
	if (!ctype1 && !ctype2) return 'tan'
	if (ctype1 === RA_TAN && ctype2 === DEC_TAN) return 'tan'
	if (ctype1 === RA_TAN_SIP && ctype2 === DEC_TAN_SIP) return 'sip'
	return undefined
}

// Returns true when both axes declare SIP distortion (TAN-SIP).
function hasSipAxes(header: FitsHeader) {
	return tanAxisType(header, 'CTYPE1') === RA_TAN_SIP && tanAxisType(header, 'CTYPE2') === DEC_TAN_SIP
}

// Returns true when CUNIT1 and CUNIT2 are absent or degrees (trimmed, any case), the only unit the CRVAL and CD
// readers assume.
function hasDegreeUnits(header: FitsHeader) {
	return isDegreeUnit(header, 'CUNIT1') && isDegreeUnit(header, 'CUNIT2')
}

// Returns true when one CUNIT keyword is absent or degrees.
function isDegreeUnit(header: FitsHeader, key: 'CUNIT1' | 'CUNIT2') {
	return header[key] === undefined || textKeyword(header, key).trim().toLowerCase() === 'deg'
}

// Reads a SIP order keyword when it is an integer in [minimum, SIP_MAX_ORDER], otherwise undefined.
function sipOrderKeyword(header: FitsHeader, key: 'A_ORDER' | 'B_ORDER' | 'AP_ORDER' | 'BP_ORDER', minimum: number) {
	const value = header[key]
	return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= SIP_MAX_ORDER ? value : undefined
}

// Returns whether the SIP orders of a TAN-SIP header are usable, in O(1): A_ORDER and B_ORDER integers in
// [2, 9], and AP_ORDER and BP_ORDER both absent or both integers in [0, 9] (0 leaves the reverse map to the
// iterative inversion of the forward polynomial). The bound 9 keeps an order read from a file, such as
// A_ORDER = 1e6, from turning every projection into an unbounded polynomial evaluation.
// Convention: https://fits.gsfc.nasa.gov/registry/sip/SIP_distortion_v1_0.pdf (Shupe et al. 2005).
export function sipOrdersValid(header: FitsHeader) {
	if (sipOrderKeyword(header, 'A_ORDER', SIP_MIN_FORWARD_ORDER) === undefined || sipOrderKeyword(header, 'B_ORDER', SIP_MIN_FORWARD_ORDER) === undefined) return false
	if (header.AP_ORDER === undefined && header.BP_ORDER === undefined) return true
	return sipOrderKeyword(header, 'AP_ORDER', 0) !== undefined && sipOrderKeyword(header, 'BP_ORDER', 0) !== undefined
}

// Returns whether every SIP coefficient of a TAN-SIP header fits its declared order, after sipOrdersValid: one
// scan of the keys. A coefficient must be a finite number, its degree p + q at most the order of its
// polynomial, and a reverse coefficient needs a declared reverse order. Constant and linear terms are kept
// in both directions. ASTAP's non-canonical forward terms are evaluated before the CD matrix, not folded into
// CRPIX/CD or discarded. A malformed SIP is never read as plain TAN.
export function sipKeywordsValid(header: FitsHeader) {
	return sipOrdersValid(header) && sipPolynomials(header) !== undefined
}

// Upper bound of a decoded SIP power; a larger one is saturated, which is already above every accepted order.
const SIP_POWER_LIMIT = 1023

// Decodes a SIP coefficient key `{A|B|AP|BP}_p_q` (the keys SIP_COEFFICIENT_KEY_PATTERN matches) into
// prefix · 2^20 + p · 2^10 + q, prefix 0 to 3 for A, B, AP and BP and the powers saturated at SIP_POWER_LIMIT,
// or -1 for any other key. Decoded by hand because a regular expression per key dominated the cost of a
// projection, which validates every coefficient on each call.
function sipCoefficientKey(key: string) {
	const first = key.charCodeAt(0)
	let prefix = first === 65 ? 0 : first === 66 ? 1 : -1 // A, B
	if (prefix < 0) return -1

	let i = 1

	if (key.charCodeAt(1) === 80) {
		// P
		prefix += 2
		i = 2
	}

	if (key.charCodeAt(i++) !== 95) return -1 // _

	let p = 0
	let start = i

	for (; i < key.length; i++) {
		const digit = key.charCodeAt(i) - 48
		if (!(digit >= 0 && digit <= 9)) break
		p = Math.min(p * 10 + digit, SIP_POWER_LIMIT)
	}

	if (i === start || key.charCodeAt(i++) !== 95) return -1 // _

	let q = 0
	start = i

	for (; i < key.length; i++) {
		const digit = key.charCodeAt(i) - 48
		if (!(digit >= 0 && digit <= 9)) return -1
		q = Math.min(q * 10 + digit, SIP_POWER_LIMIT)
	}

	return i === start ? -1 : prefix * 1048576 + p * 1024 + q
}

// Reads the SIP polynomials of a header whose orders passed sipOrdersValid, validating every coefficient as
// sipKeywordsValid describes; undefined when one is malformed. Allocates the packed coefficient array.
function sipPolynomials(header: FitsHeader): SipPolynomials | undefined {
	const aOrder = header.A_ORDER as number
	const bOrder = header.B_ORDER as number
	const apOrder = header.AP_ORDER === undefined ? -1 : (header.AP_ORDER as number)
	const bpOrder = header.BP_ORDER === undefined ? -1 : (header.BP_ORDER as number)
	const bOffset = (aOrder + 1) * (aOrder + 1)
	const apOffset = bOffset + (bOrder + 1) * (bOrder + 1)
	const bpOffset = apOffset + (apOrder + 1) * (apOrder + 1)
	const coefficients = new Float64Array(bpOffset + (bpOrder + 1) * (bpOrder + 1))

	for (const key in header) {
		const code = sipCoefficientKey(key)
		if (code < 0) continue

		const value = header[key]
		if (value === undefined) continue
		if (typeof value !== 'number' || !Number.isFinite(value)) return undefined

		const prefix = code >> 20
		const p = (code >> 10) & SIP_POWER_LIMIT
		const q = code & SIP_POWER_LIMIT
		const order = prefix === 0 ? aOrder : prefix === 1 ? bOrder : prefix === 2 ? apOrder : bpOrder

		if (!(p + q <= order)) return undefined

		const offset = prefix === 0 ? 0 : prefix === 1 ? bOffset : prefix === 2 ? apOffset : bpOffset
		coefficients[offset + p * (order + 1) + q] = value
	}

	return { aOrder, bOrder, apOrder, bpOrder, coefficients, bOffset, apOffset, bpOffset }
}

// Evaluates a SIP polynomial sum(coeff_pq · u^p · v^q) for p + q ≤ order at the pixel offset (u, v), from the
// block of `coefficients` starting at `offset`.
function sipPolynomial(coefficients: Float64Array, offset: number, order: number, u: number, v: number) {
	if (order <= 0) return 0

	const stride = order + 1
	let value = 0
	let up = 1

	for (let p = 0; p <= order; p++) {
		let vq = 1

		for (let q = 0; p + q <= order; q++) {
			value += coefficients[offset + p * stride + q] * up * vq
			vq *= v
		}

		up *= u
	}

	return value
}

// Applies the forward SIP correction, mapping raw pixel offsets (u, v) to distortion-corrected (U, V).
function forwardSip(sip: SipPolynomials | undefined, u: number, v: number) {
	if (sip === undefined) return [u, v] as const
	return [u + sipPolynomial(sip.coefficients, 0, sip.aOrder, u, v), v + sipPolynomial(sip.coefficients, sip.bOffset, sip.bOrder, u, v)] as const
}

// Applies the inverse SIP polynomials (AP/BP), mapping corrected (U, V) back to raw pixel offsets.
function inverseSip(sip: SipPolynomials, U: number, V: number) {
	return [U + sipPolynomial(sip.coefficients, sip.apOffset, sip.apOrder, U, V), V + sipPolynomial(sip.coefficients, sip.bpOffset, sip.bpOrder, U, V)] as const
}

// Inverts the forward SIP map by fixed-point iteration when no AP/BP inverse polynomials are present.
// Returns undefined on non-finite iterates; otherwise stops at SIP_TOLERANCE or SIP_MAX_ITERATIONS.
function invertForwardSip(sip: SipPolynomials, U: number, V: number) {
	let u = U
	let v = V

	for (let i = 0; i < SIP_MAX_ITERATIONS; i++) {
		const nextU = U - sipPolynomial(sip.coefficients, 0, sip.aOrder, u, v)
		const nextV = V - sipPolynomial(sip.coefficients, sip.bOffset, sip.bOrder, u, v)

		if (!Number.isFinite(nextU) || !Number.isFinite(nextV)) return undefined
		if (Math.abs(nextU - u) <= SIP_TOLERANCE && Math.abs(nextV - v) <= SIP_TOLERANCE) return [nextU, nextV] as const

		u = nextU
		v = nextV
	}

	return [u, v] as const
}

// Builds the packed tangent-plane descriptor from a FITS header, or undefined when the axes are not
// gnomonic, a CUNIT is not degrees, the SIP of a TAN-SIP pair is malformed (see sipOrdersValid and
// sipKeywordsValid) or the CD matrix is missing/degenerate. Reference values are converted to radians and
// the LONPOLE-derived pole rotation is precomputed for the projection hot path. When LONPOLE is omitted,
// TAN uses the FITS WCS Paper II default: 0° if CRVAL2 ≥ 90° (north celestial pole) and 180° otherwise.
// An absent reverse SIP order is packed as 0.
export function tanHeader(header: FitsHeader): TanHeader | undefined {
	return tanDescriptor(header)?.tan
}

// Builds the tangent-plane descriptor and, for a TAN-SIP pair, its validated polynomials (see tanHeader).
function tanDescriptor(header: FitsHeader): TanDescriptor | undefined {
	const axes = tanAxes(header)
	if (axes === undefined || !hasDegreeUnits(header)) return undefined

	let sip: SipPolynomials | undefined

	if (axes === 'sip') {
		if (!sipOrdersValid(header)) return undefined
		sip = sipPolynomials(header)
		if (sip === undefined) return undefined
	}

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

	if (!Number.isFinite(crpix1) || !Number.isFinite(crpix2) || !Number.isFinite(crval1) || !Number.isFinite(crval2) || !Number.isFinite(determinant) || !(scale > 0) || Math.abs(determinant) <= Number.EPSILON * scale * scale) {
		return undefined
	}

	crval2 = deg(crval2)

	const tan: TanHeader = [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, determinant, cosPoleRotation, sinPoleRotation, sip?.aOrder ?? 0, sip?.bOrder ?? 0, Math.max(0, sip?.apOrder ?? 0), Math.max(0, sip?.bpOrder ?? 0)]
	return { tan, sip }
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

	// The same SIP rules as every projection, so a resized header is never one tanHeader would refuse.
	if (sip) supported &&= sipKeywordsValid(header)

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
// Undefined when tanHeader refuses the header or the coordinate is on the far hemisphere.
export function tanProject(header: FitsHeader, rightAscension: Angle, declination: Angle) {
	const descriptor = tanDescriptor(header)
	if (!descriptor) return undefined

	const { tan, sip } = descriptor
	const [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, determinant, cosPoleRotation, sinPoleRotation, , , apOrder, bpOrder] = tan
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
	const distorted = sip === undefined ? ([U, V] as const) : apOrder > 0 && bpOrder > 0 ? inverseSip(sip, U, V) : invertForwardSip(sip, U, V)
	if (!distorted) return undefined
	return [crpix1 + distorted[0], crpix2 + distorted[1]] as const
}

// Unprojects FITS TAN pixel coordinates into equatorial coordinates using the header WCS.
// Undefined when tanHeader refuses the header.
export function tanUnproject(header: FitsHeader, x: number, y: number) {
	const descriptor = tanDescriptor(header)
	if (!descriptor) return undefined

	const { tan, sip } = descriptor
	const [crpix1, crpix2, crval1, crval2, cd11, cd12, cd21, cd22, , cosPoleRotation, sinPoleRotation] = tan
	const [U, V] = forwardSip(sip, x - crpix1, y - crpix2)
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
