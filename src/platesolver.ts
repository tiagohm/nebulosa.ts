import { type Angle, deg } from './angle'
import { type FitsHeader, heightKeyword, numericKeyword, widthKeyword } from './fits'
import { cdMatrix } from './wcs'

export type Parity = 'NORMAL' | 'FLIPPED'

export type PlateSolver = (input: string, options?: PlateSolveOptions, signal?: AbortSignal) => PlateSolution | undefined

export interface PlateSolveOptions {
	ra?: Angle
	dec?: Angle
	radius?: Angle
	downsample?: number
	timeout?: number
}

export interface PlateSolution extends Readonly<FitsHeader> {
	readonly orientation: Angle
	readonly scale: Angle
	readonly rightAscension: Angle
	readonly declination: Angle
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

export function plateSolutionFrom(header: FitsHeader): PlateSolution | undefined {
	// https://www.aanda.org/articles/aa/full/2002/45/aah3859/aah3859.right.html
	const crval1 = deg(numericKeyword(header, 'CRVAL1', NaN))
	if (Number.isNaN(crval1)) return undefined

	const crval2 = deg(numericKeyword(header, 'CRVAL2', NaN))
	if (Number.isNaN(crval2)) return undefined

	const [cd11, cd12, cd21, cd22] = cdMatrix(header)
	if (cd11 === 0 && cd12 === 0) return undefined
	const crota2 = deg(numericKeyword(header, 'CROTA2', NaN)) || Math.atan2(cd12, cd11)
	const parity = cd11 * cd22 - cd12 * cd21 >= 0 ? 'NORMAL' : 'FLIPPED'

	// https://danmoser.github.io/notes/gai_fits-imgs.html
	// CDELT has 1.0 deg as default value (ignore it)
	let cdelt1 = numericKeyword(header, 'CDELT1', NaN)
	cdelt1 = cdelt1 === 1 || Number.isNaN(cdelt1) ? deg(cd11 / Math.cos(crota2)) : deg(cdelt1)
	let cdelt2 = numericKeyword(header, 'CDELT2', NaN)
	cdelt2 = cdelt2 === 1 || Number.isNaN(cdelt2) ? deg(cd22 / Math.cos(crota2)) : deg(cdelt2)

	const widthInPixels = widthKeyword(header)
	const heightInPixels = heightKeyword(header)
	const w = Math.abs(cdelt1 * widthInPixels)
	const h = Math.abs(cdelt2 * heightInPixels)

	return {
		...header,
		orientation: crota2,
		scale: Math.abs(cdelt2),
		rightAscension: crval1,
		declination: crval2,
		width: w,
		height: h,
		radius: Math.hypot(w, h) / 2,
		parity: parity,
		widthInPixels,
		heightInPixels,
	}
}
