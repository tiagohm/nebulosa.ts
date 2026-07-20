import { PIOVERTWO } from '../../core/constants'
import { validateFinite, validateInRange, validateVector } from '../../core/validation'
import { matFill, matTranspose, type MutMat3 } from '../../math/linear-algebra/mat3'
import { type MutVec3, vecFill, vecLength, type Vec3 } from '../../math/linear-algebra/vec3'
import { normalizeAngle, type Angle } from '../../math/units/angle'
import type { HorizontalCoordinate } from './coordinate'

// Pure rotations and vector conversions among apparent equatorial, Taki local-equatorial, and
// east-north-up frames. Angles are radians; no astrometric place corrections or refraction occur here.

// Relative horizontal magnitude below which azimuth is canonically reported as zero.
const SINGULAR_HORIZONTAL_EPSILON = 1e-15

// Converts north-through-east azimuth and altitude into a unit ENU direction.
export function horizontalToEnuVector(azimuth: Angle, altitude: Angle, out?: MutVec3): MutVec3 {
	validateFinite(azimuth)
	validateInRange(altitude, -PIOVERTWO, PIOVERTWO)
	const cosAltitude = Math.cos(altitude)
	return vecFill(out ?? [0, 0, 0], cosAltitude * Math.sin(azimuth), cosAltitude * Math.cos(azimuth), Math.sin(altitude))
}

// Converts a finite non-zero ENU direction into north-through-east azimuth and altitude.
// Azimuth is zero at the geometrically singular zenith and nadir.
export function enuVectorToHorizontal(vector: Vec3): HorizontalCoordinate {
	validateVector(vector)
	const length = vecLength(vector)
	if (length === 0) throw new RangeError('vector must be non-zero')

	const horizontal = Math.hypot(vector[0], vector[1])
	const azimuth = horizontal <= length * SINGULAR_HORIZONTAL_EPSILON ? 0 : normalizeAngle(Math.atan2(vector[0], vector[1]))
	const altitude = Math.atan2(vector[2], horizontal)
	return { azimuth, altitude }
}

// Builds the active apparent-equatorial-to-ENU rotation for geodetic latitude and local apparent
// sidereal time. Equatorial vectors follow eraS2c(rightAscension, declination).
export function equatorialToEnuMatrix(latitude: Angle, lst: Angle, out?: MutMat3): MutMat3 {
	validateInRange(latitude, -PIOVERTWO, PIOVERTWO)
	validateFinite(lst)
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const sinLst = Math.sin(lst)
	const cosLst = Math.cos(lst)

	return matFill(out ?? [0, 0, 0, 0, 0, 0, 0, 0, 0], -sinLst, cosLst, 0, -sinLatitude * cosLst, -sinLatitude * sinLst, cosLatitude, cosLatitude * cosLst, cosLatitude * sinLst, sinLatitude)
}

// Builds the inverse ENU-to-apparent-equatorial rotation as the exact transpose.
export function enuToEquatorialMatrix(latitude: Angle, lst: Angle, out?: MutMat3): MutMat3 {
	const matrix = equatorialToEnuMatrix(latitude, lst, out)
	return matTranspose(matrix, matrix)
}

// Builds the active Taki-local-equatorial-to-ENU rotation. Taki axes are meridian-south, east, and
// north celestial pole; a west-positive hour angle H has polar longitude -H in this frame.
export function takiToEnuMatrix(latitude: Angle, out?: MutMat3): MutMat3 {
	validateInRange(latitude, -PIOVERTWO, PIOVERTWO)
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	return matFill(out ?? [0, 0, 0, 0, 0, 0, 0, 0, 0], 0, 1, 0, -sinLatitude, 0, cosLatitude, cosLatitude, 0, sinLatitude)
}

// Builds the inverse ENU-to-Taki-local-equatorial rotation as the exact transpose.
export function enuToTakiMatrix(latitude: Angle, out?: MutMat3): MutMat3 {
	const matrix = takiToEnuMatrix(latitude, out)
	return matTranspose(matrix, matrix)
}
