import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import type { FitsHeader } from '../../io/formats/fits/fits'
import { heightKeyword, numericKeyword, widthKeyword } from '../../io/formats/fits/util'
import { type Angle, deg } from '../../math/units/angle'
import { cdMatrix } from '../wcs/fits.wcs'

// Shared plate-solution shapes. plateSolutionFrom distills a solved FITS WCS header into a compact
// PlateSolution (center, scale, field size, orientation, parity). ASTAP, nova.astrometry.net, local
// solve-field, and libastrometry each have their own async entry point and hint rules; they are not
// implementations of one function type. Angles are radians.

// Image handedness relative to the sky: NORMAL keeps east-left, FLIPPED is mirror-imaged.
export type Parity = 'NORMAL' | 'FLIPPED'

// Optional hints a backend may use to constrain the search. Each solver decides which fields it
// sends and whether a radius requires a center. See the backend function for that rule.
export interface PlateSolveOptions {
	// Search-center right ascension hint (radians).
	rightAscension?: Angle
	// Search-center declination hint (radians).
	declination?: Angle
	// Search-radius hint (radians). ASTAP may use this without a center. nova sends it independently
	// of RA/Dec. Local solve-field and libastrometry apply a window only when RA, Dec, and radius are all set.
	radius?: Angle
	// Image downsampling factor applied before solving.
	downsample?: number
	// Maximum solve time, in milliseconds.
	timeout?: number
}

// A solved field. Extends the source FITS header with derived geometry; angles are radians.
export interface PlateSolution extends Readonly<FitsHeader>, Readonly<EquatorialCoordinate> {
	// Field rotation from the WCS CD matrix (radians).
	readonly orientation: Angle
	// Geometric-mean plate scale, in radians per pixel.
	readonly scale: Angle
	// Field width (radians).
	readonly width: Angle
	// Field height (radians).
	readonly height: Angle
	// Image parity.
	readonly parity: Parity
	// Half-diagonal field radius (radians).
	readonly radius: Angle
	// Image width, in pixels.
	readonly widthInPixels: number
	// Image height, in pixels.
	readonly heightInPixels: number
}

// Zeroed plate solution used as a neutral default before solving.
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
		// Geometric-mean plate scale: sqrt of the solid angle per pixel, robust to anisotropic or
		// sheared pixels. Equals cdelt1 = cdelt2 for square, unsheared images.
		scale: deg(Math.sqrt(Math.abs(determinant))),
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
