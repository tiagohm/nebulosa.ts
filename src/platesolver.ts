import { type Angle, deg } from './angle'
import type { EquatorialCoordinate } from './coordinate'
import type { FitsHeader } from './fits'
import { heightKeyword, numericKeyword, widthKeyword } from './fits.util'
import { cdMatrix } from './fits.wcs'

export type Parity = 'NORMAL' | 'FLIPPED'

export type PlateSolver = (input: string, options?: PlateSolveOptions, signal?: AbortSignal) => PlateSolution | undefined

export interface PlateSolveOptions {
	rightAscension?: Angle
	declination?: Angle
	radius?: Angle
	downsample?: number
	timeout?: number
}

export interface PlateSolution extends Readonly<FitsHeader>, Readonly<EquatorialCoordinate> {
	readonly orientation: Angle
	readonly scale: Angle
	readonly width: Angle
	readonly height: Angle
	readonly parity: Parity
	readonly radius: Angle
	readonly widthInPixels: number
	readonly heightInPixels: number
}

export const EMPTY_PLATE_SOLUTION: Readonly<PlateSolution> = {
	orientation: 0,
	scale: 0,
	rightAscension: 0,
	declination: 0,
	width: 0,
	height: 0,
	parity: 'NORMAL',
	radius: 0,
	widthInPixels: 0,
	heightInPixels: 0,
}

// Converts FITS WCS keywords into a compact plate-solution summary.
export function plateSolutionFrom(header: FitsHeader): PlateSolution | undefined {
	// https://www.aanda.org/articles/aa/full/2002/45/aah3859/aah3859.right.html
	const crval1 = deg(numericKeyword(header, 'CRVAL1', Number.NaN))
	if (Number.isNaN(crval1)) return undefined

	const crval2 = deg(numericKeyword(header, 'CRVAL2', Number.NaN))
	if (Number.isNaN(crval2)) return undefined

	const [cd11, cd12, cd21, cd22] = cdMatrix(header)
	const determinant = cd11 * cd22 - cd12 * cd21
	const cdelt1 = Math.hypot(cd11, cd21)
	const cdelt2 = Math.hypot(cd12, cd22)

	if (!Number.isFinite(determinant) || !(cdelt1 > 0) || !(cdelt2 > 0) || Math.abs(determinant) <= Number.EPSILON * cdelt1 * cdelt2) return undefined

	const parity = determinant >= 0 ? 'NORMAL' : 'FLIPPED'
	const orientation = Math.atan2(cd12, parity === 'NORMAL' ? cd22 : -cd22)
	const widthInPixels = widthKeyword(header, 0)
	const heightInPixels = heightKeyword(header, 0)
	const width = deg(cdelt1) * widthInPixels
	const height = deg(cdelt2) * heightInPixels

	return {
		...header,
		orientation,
		scale: deg(cdelt2),
		rightAscension: crval1,
		declination: crval2,
		width,
		height,
		radius: Math.hypot(width, height) / 2,
		parity,
		widthInPixels,
		heightInPixels,
	}
}
