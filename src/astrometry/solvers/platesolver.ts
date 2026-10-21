import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import type { FitsHeader } from '../../io/formats/fits/fits'
import { heightKeyword, numericKeyword, textKeyword, widthKeyword } from '../../io/formats/fits/util'
import { type Angle, deg } from '../../math/units/angle'
import { cdMatrix, DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP, tanUnproject } from '../wcs/fits.wcs'

// Shared plate-solution shapes. plateSolutionFrom distills a solved FITS WCS header into a compact
// PlateSolution (ICRS center of the image, scale, field size, orientation, parity), and only for an
// equatorial TAN/TAN-SIP solution with known dimensions. ASTAP, nova.astrometry.net, local solve-field, and
// libastrometry each have their own async entry point and hint rules; they are not implementations of one
// function type. Angles are radians.

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

// A solved field. Extends the source FITS header with derived geometry; angles are radians. rightAscension and
// declination are the ICRS center of the image, in [0, 2π) and [-π/2, π/2]; an FK5 J2000 solution is taken as
// ICRS, which it approximates to 0.03″. Width, height and scale are always positive.
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

// Converts a solved FITS WCS header into a compact plate-solution summary, or undefined unless it proves
// all of these (FITS Standard 4.0 §8; WCS Papers I/II, Greisen & Calabretta 2002 and Calabretta & Greisen 2002):
// - CTYPE1/CTYPE2 are exactly (RA---TAN, DEC--TAN) or (RA---TAN-SIP, DEC--TAN-SIP), trimmed and in any case; an
//   absent CTYPE is a linear axis, and other projections, galactic or ecliptic axes and mixed pairs are refused;
//   CUNIT1/CUNIT2 absent or degrees, and a TAN-SIP solution well formed (see sipOrdersValid and sipKeywordsValid);
// - the frame is ICRS: RADESYS = ICRS, FK5 with EQUINOX 2000 or absent, or no RADESYS with no EQUINOX (ICRS) or
//   EQUINOX = 2000 (FK5 J2000, taken as ICRS); FK4, other equinoxes and apparent frames are refused;
// - the image dimensions (NAXIS1/NAXIS2, else IMAGEW/IMAGEH) are finite and positive;
// - the center, tanUnproject of the central pixel ((W + 1) / 2, (H + 1) / 2) in FITS 1-based pixels with SIP
//   applied, is defined. It is never read from CRVAL, which only equals it when CRPIX is central.
export function plateSolutionFrom(header: FitsHeader): PlateSolution | undefined {
	if (!hasEquatorialTanAxes(header) || !hasIcrsFrame(header)) return undefined

	const widthInPixels = widthKeyword(header, 0)
	const heightInPixels = heightKeyword(header, 0)
	if (!(widthInPixels > 0 && heightInPixels > 0 && Number.isFinite(widthInPixels) && Number.isFinite(heightInPixels))) return undefined

	const center = tanUnproject(header, (widthInPixels + 1) / 2, (heightInPixels + 1) / 2)
	if (center === undefined || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) return undefined

	const [cd11, cd12, cd21, cd22] = cdMatrix(header)
	const determinant = cd11 * cd22 - cd12 * cd21
	const cdelt1 = Math.hypot(cd11, cd21)
	const cdelt2 = Math.hypot(cd12, cd22)

	if (!Number.isFinite(determinant) || !(cdelt1 > 0) || !(cdelt2 > 0) || Math.abs(determinant) <= Number.EPSILON * cdelt1 * cdelt2) return undefined

	const parity = determinant >= 0 ? 'NORMAL' : 'FLIPPED'
	const orientation = Math.atan2(cd12, parity === 'NORMAL' ? cd22 : -cd22)
	const width = deg(cdelt1) * widthInPixels
	const height = deg(cdelt2) * heightInPixels

	return {
		...header,
		orientation,
		// Geometric-mean plate scale: sqrt of the solid angle per pixel, robust to anisotropic or
		// sheared pixels. Equals cdelt1 = cdelt2 for square, unsheared images.
		scale: deg(Math.sqrt(Math.abs(determinant))),
		rightAscension: center[0],
		declination: center[1],
		width,
		height,
		radius: Math.hypot(width, height) / 2,
		parity,
		widthInPixels,
		heightInPixels,
	}
}

// Returns true when CTYPE1/CTYPE2 declare exactly an equatorial TAN or TAN-SIP pair.
function hasEquatorialTanAxes(header: FitsHeader) {
	const ctype1 = textKeyword(header, 'CTYPE1').trim().toUpperCase()
	const ctype2 = textKeyword(header, 'CTYPE2').trim().toUpperCase()
	return (ctype1 === RA_TAN && ctype2 === DEC_TAN) || (ctype1 === RA_TAN_SIP && ctype2 === DEC_TAN_SIP)
}

// Returns true when RADESYS and EQUINOX describe ICRS or FK5 J2000, with the FITS 4.0 §8 defaults: without
// RADESYS, no EQUINOX means ICRS and EQUINOX ≥ 1984 means FK5, of which only 2000 is accepted.
function hasIcrsFrame(header: FitsHeader) {
	const radesys = textKeyword(header, 'RADESYS').trim().toUpperCase()
	const equinox = numericKeyword(header, 'EQUINOX', undefined)
	if (radesys === 'ICRS') return true
	if (radesys === 'FK5' || radesys === '') return equinox === undefined || equinox === 2000
	return false
}
