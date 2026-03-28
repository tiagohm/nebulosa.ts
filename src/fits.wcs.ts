import { type Angle, deg } from './angle'
import type { FitsHeader } from './fits'
import { hasKeyword, numericKeyword } from './fits.util'

const DIRECT_CD_KEY_PATTERN = /^CD\d+_\d+$/
const PC_KEY_PATTERN = /^PC\d+_\d+$/
const WCS_FITS_KEY_PATTERN = /^(?:WCSAXES|CUNIT\d+|CTYPE\d+|CRPIX\d+|CRVAL\d+|PS\d+_\d+|PV\d+_\d+|CD\d+_\d+|PC\d+_\d+|CDELT\d+|CROTA\d+|RADESYS|LONPOLE|LATPOLE|EQUINOX|A_\d+_\d+|AP_\d+_\d+|B_\d+_\d+|BP_\d+_\d+|A_ORDER|AP_ORDER|B_ORDER|BP_ORDER)$/

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

// Checks whether a FITS header key belongs to the WCS keyword set handled by this module.
export function isWcsFitsKeyword(key: keyof FitsHeader): key is WcsFitsKeywords {
	return WCS_FITS_KEY_PATTERN.test(key)
}
