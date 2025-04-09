import { type Angle, deg } from './angle'
import { type FitsHeader, numeric } from './fits'
import { cdMatrix } from './wcs'

export type Parity = 'NORMAL' | 'FLIPPED'

export interface PlateSolution extends FitsHeader {
	solved: boolean
	orientation: Angle
	scale: Angle
	rightAscension: Angle
	declination: Angle
	width: Angle
	height: Angle
	parity: Parity
	radius: Angle
	widthInPixels: number
	heightInPixels: number
}

const EMPTY_PLATE_SOLUTION: PlateSolution = {
	solved: false,
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

export function plateSolutionFrom(header: FitsHeader): PlateSolution {
	const solution = { ...header, ...EMPTY_PLATE_SOLUTION }

	// https://www.aanda.org/articles/aa/full/2002/45/aah3859/aah3859.right.html
	const crval1 = deg(numeric(header, 'CRVAL1', NaN))
	if (Number.isNaN(crval1)) return solution

	const crval2 = deg(numeric(header, 'CRVAL2', NaN))
	if (Number.isNaN(crval2)) return solution

	const [cd11, cd12, cd21, cd22] = cdMatrix(header)
	if (cd11 === 0 && cd12 === 0) return solution
	const crota2 = deg(numeric(header, 'CROTA2', NaN)) || Math.atan2(cd12, cd11)
	const parity = cd11 * cd22 - cd12 * cd21 >= 0 ? 'NORMAL' : 'FLIPPED'

	// https://danmoser.github.io/notes/gai_fits-imgs.html
	// CDELT has 1.0 deg as default value (ignore it)
	let cdelt1 = numeric(header, 'CDELT1', NaN)
	cdelt1 = cdelt1 === 1 || Number.isNaN(cdelt1) ? deg(cd11 / Math.cos(crota2)) : deg(cdelt1)
	let cdelt2 = numeric(header, 'CDELT2', NaN)
	cdelt2 = cdelt2 === 1 || Number.isNaN(cdelt2) ? deg(cd22 / Math.cos(crota2)) : deg(cdelt2)

	const width = numeric(header, 'NAXIS1') || numeric(header, 'IMAGEW')
	const height = numeric(header, 'NAXIS2') || numeric(header, 'IMAGEH')

	solution.solved = true
	solution.orientation = crota2
	solution.scale = Math.abs(cdelt2)
	solution.rightAscension = crval1
	solution.declination = crval2
	solution.width = Math.abs(cdelt1 * width)
	solution.height = Math.abs(cdelt2 * height)
    solution.radius = Math.hypot(solution.width, solution.height) / 2
	solution.parity = parity
	solution.widthInPixels = width
	solution.heightInPixels = height

	return solution
}
