import type { FitsHeader } from '../../io/formats/fits/fits'
import { sphericalSeparation } from '../../math/numerical/geometry'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import type { PlateSolution } from '../solvers/platesolver'
import { tanProject, tanUnproject } from './fits.wcs'

// Orientation of a solved image on the sky through the TAN/TAN-SIP transforms of fits.wcs: the position angle of the
// image top at a pixel. Pixels are FITS pixels, 1-based with integer centres ((1, 1) is the centre of the first pixel),
// +X along a row and +Y along the rows as stored; the image top is the direction of decreasing row (−Y), the frame drawn
// without a vertical flip. Directions are found by projecting points along the great circles that leave a sky position
// towards north and towards east, so they follow the rotation, parity, and distortion of the solution at that pixel.
// Sky positions are in the frame of the WCS (ICRS for a PlateSolution). Angles are radians. Pure: no I/O, no mutation,
// a few small allocations per call.

// Length of the great-circle steps along which north and east are projected, in local pixels: long enough that the
// rounding of the projection does not turn the directions, short enough to stay in the local distortion.
const DIRECTION_STEP = 10

// Equatorial unit vector, [x, y, z].
type UnitVector = readonly [number, number, number]

// FITS pixel, [x, y], 1-based with integer centres.
type Pixel = readonly [number, number]

// Returns the position angle, from north through east, of the image top (decreasing FITS row) at a FITS 1-based pixel
// (x, y), in the frame of the WCS of the header (ICRS for a PlateSolution), [0, 2π). North and east are the unit
// directions, in pixels, of the projections of points about DIRECTION_STEP local pixels along the great circles leaving
// the sky position of the pixel towards north and towards east; a step along a parallel would bend east towards north
// near a pole, while the great circles keep the true tangent directions at any declination, the pole included, where
// they are those of the meridian of the right ascension the WCS gives there. Both are measured from the projection of
// the sky position, not from (x, y): the inverse SIP of a solver may not close on the forward one by whole pixels, which
// over the step would turn the directions by tens of degrees. The angle is atan2(−east.y, −north.y), exact for a
// conformal (rotation, scale, and optional mirror) local transform. Undefined when the pixel cannot be unprojected or
// a direction cannot be projected (beyond the tangent plane, or a degenerate WCS).
export function imageTopPositionAngle(header: FitsHeader, x: number, y: number): Angle | undefined {
	const sky = tanUnproject(header, x, y)
	if (!sky) return undefined

	const step = pixelScaleAt(header, x, y, sky)
	const origin = step && tanProject(header, sky[0], sky[1])
	if (!step || !origin) return undefined

	const [ra, dec] = sky
	const delta = DIRECTION_STEP * step
	const cosRa = Math.cos(ra)
	const sinRa = Math.sin(ra)
	const cosDec = Math.cos(dec)
	const sinDec = Math.sin(dec)
	const position: UnitVector = [cosDec * cosRa, cosDec * sinRa, sinDec]
	const north = direction(origin, pixelAlong(header, position, [-sinDec * cosRa, -sinDec * sinRa, cosDec], delta))
	const east = direction(origin, pixelAlong(header, position, [-sinRa, cosRa, 0], delta))
	if (!north || !east) return undefined

	return normalizeAngle(Math.atan2(-east[1], -north[1]))
}

// Returns imageTopPositionAngle at the FITS pixel of an equatorial position (right ascension and declination, radians,
// in the frame of the solution), or at the image centre ((widthInPixels + 1) / 2, (heightInPixels + 1) / 2) when the
// position cannot be projected or projects outside the image, [0.5, widthInPixels + 0.5] × [0.5, heightInPixels + 0.5].
// [0, 2π); undefined when the angle is undefined at the chosen pixel.
export function imageTopPositionAngleAt(solution: PlateSolution, rightAscension: Angle, declination: Angle): Angle | undefined {
	const { widthInPixels, heightInPixels } = solution
	const pixel = tanProject(solution, rightAscension, declination)

	if (pixel && pixel[0] >= 0.5 && pixel[0] <= widthInPixels + 0.5 && pixel[1] >= 0.5 && pixel[1] <= heightInPixels + 0.5) {
		return imageTopPositionAngle(solution, pixel[0], pixel[1])
	}

	return imageTopPositionAngle(solution, (widthInPixels + 1) / 2, (heightInPixels + 1) / 2)
}

// Returns the angle one pixel spans at a FITS pixel (x, y) whose sky position [right ascension, declination] (radians)
// is already known, in radians per pixel: the mean separation of its neighbours one pixel along +X and one along +Y,
// so it follows the local distortion. Undefined when a neighbour cannot be unprojected or the scale is not positive.
function pixelScaleAt(header: FitsHeader, x: number, y: number, sky: readonly [Angle, Angle]): number | undefined {
	const right = tanUnproject(header, x + 1, y)
	const below = tanUnproject(header, x, y + 1)
	if (!right || !below) return undefined

	const scale = (sphericalSeparation(sky[0], sky[1], right[0], right[1]) + sphericalSeparation(sky[0], sky[1], below[0], below[1])) / 2
	return scale > 0 ? scale : undefined
}

// Returns the FITS pixel `angle` radians along the great circle that leaves a sky position (an equatorial unit vector)
// along a unit vector tangent to the sphere there, or undefined when it cannot be projected.
function pixelAlong(header: FitsHeader, position: UnitVector, tangent: UnitVector, angle: Angle): Pixel | undefined {
	const cos = Math.cos(angle)
	const sin = Math.sin(angle)
	const x = position[0] * cos + tangent[0] * sin
	const y = position[1] * cos + tangent[1] * sin
	const z = position[2] * cos + tangent[2] * sin
	return tanProject(header, Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y)))
}

// Returns the unit vector, in pixels, from one pixel towards another; undefined when the other is absent or coincident.
function direction(from: Pixel, to: Pixel | undefined): Pixel | undefined {
	if (!to) return undefined
	const dx = to[0] - from[0]
	const dy = to[1] - from[1]
	const length = Math.hypot(dx, dy)
	return length > 0 ? [dx / length, dy / length] : undefined
}
