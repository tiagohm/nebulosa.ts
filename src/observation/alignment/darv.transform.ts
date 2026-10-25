import { tanUnproject } from '../../astrometry/wcs/fits.wcs'
import type { FitsHeader } from '../../io/formats/fits/fits'
import type { Point } from '../../math/numerical/geometry'
import { type Angle, normalizePI } from '../../math/units/angle'
import { applyCalibration, type CalibrationMatrix } from '../guiding/guider'

// Local image-to-sky adapters for DARV. Image coordinates are zero-based pixel centers, +X right
// and +Y down; sky offsets are east (increasing RA × cos DEC) and north (increasing DEC), radians.
// Callbacks are evaluated when used, allowing a current WCS or guiding calibration after a flip.

// Locally linear, oriented angular mapping, including camera parity and anisotropic pixel scales.
export interface DarvImageTransform {
	// Maps a pixel offset at an optional source-frame origin into [east, north] radians. Origins let
	// a WCS adapter evaluate each star's local Jacobian. The tuple is newly allocated; undefined
	// means the supplied external sky solution cannot represent this position.
	readonly imageOffsetToSky: (dx: number, dy: number, origin?: Readonly<Point>) => readonly [Angle, Angle] | undefined
}

// Creates an explicit row-major [eastX, eastY, northX, northY] mapping in radians/pixel. Matrix must
// be nonsingular. It is read on every call and may represent a rotated or reflected camera.
export class DarvMatrixTransform implements DarvImageTransform {
	// Retains the supplied row-major angular matrix without copying it.
	constructor(private readonly matrix: readonly [number, number, number, number]) {}

	// Maps dx/dy pixels to a newly allocated [east, north] radian displacement.
	imageOffsetToSky(dx: number, dy: number): readonly [Angle, Angle] {
		const matrix = this.matrix
		return [matrix[0] * dx + matrix[1] * dy, matrix[2] * dx + matrix[3] * dy]
	}
}

// Adapts the current image-to-axis guiding matrix. axisRadians gives SIGNED radians per calibrated
// RA/DEC unit, positive for celestial east/north respectively; this is not necessarily radians/pixel
// when calibration units are pulse milliseconds. Both callbacks are evaluated at measurement time.
export class DarvCalibrationTransform implements DarvImageTransform {
	// Retains providers for the current image-to-axis matrix and signed radians per axis unit.
	constructor(
		private readonly calibration: () => CalibrationMatrix,
		private readonly axisRadians: () => readonly [Angle, Angle],
	) {}

	// Reads the current calibration and maps dx/dy pixels to [east, north] radians.
	imageOffsetToSky(dx: number, dy: number): readonly [Angle, Angle] {
		const offset = applyCalibration(this.calibration(), dx, dy)
		const scale = this.axisRadians()
		return [offset.ra * scale[0], offset.dec * scale[1]]
	}
}

// Adapts a current TAN/TAN-SIP FITS header, using a one-pixel central-difference local Jacobian.
// reference is a zero-based pixel center used when no per-star origin is supplied; the FITS +1
// offset is applied internally. An unusable WCS returns undefined for the analyzer to diagnose. Over a trail
// the WCS must be locally linear (small field); SIP and RA wrap are included in the derivative.
export class DarvWcsTransform implements DarvImageTransform {
	// Retains the current FITS-header provider and default zero-based pixel reference position.
	constructor(
		private readonly header: () => FitsHeader,
		private readonly reference: Readonly<Point>,
	) {}

	// Maps dx/dy pixels at origin (or the stored reference) to [east, north] radians with local SIP.
	imageOffsetToSky(dx: number, dy: number, origin: Readonly<Point> = this.reference): readonly [Angle, Angle] | undefined {
		const current = this.header()
		const center = tanUnproject(current, origin.x + 1, origin.y + 1)
		const left = tanUnproject(current, origin.x + 0.5, origin.y + 1)
		const right = tanUnproject(current, origin.x + 1.5, origin.y + 1)
		const top = tanUnproject(current, origin.x + 1, origin.y + 0.5)
		const bottom = tanUnproject(current, origin.x + 1, origin.y + 1.5)
		if (!center || !left || !right || !top || !bottom) return undefined
		const cos = Math.cos(center[1])
		return [(normalizePI(right[0] - left[0]) * dx + normalizePI(bottom[0] - top[0]) * dy) * cos, (right[1] - left[1]) * dx + (bottom[1] - top[1]) * dy]
	}
}
