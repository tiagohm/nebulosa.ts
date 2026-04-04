import type { Angle } from './angle'
import { ECLIPTIC_J2000_MATRIX, GALACTIC_MATRIX, PI, PIOVERTWO, TAU } from './constants'
import { eraC2s, eraS2c } from './erfa'
import { localSiderealTime } from './location'
import { matMulVec, matRotX, matTransposeMulVec } from './mat3'
import { clamp } from './math'
import { precessionNutationMatrix, type Time, timeNow, trueObliquity } from './time'
import type { Vec3 } from './vec3'

// Representation of points in 3D spherical coordinates.
export type SphericalCoordinate = Vec3

// Representation of points in 3D cartesian coordinates.
export type CartesianCoordinate = Vec3

// Right ascension and declination in the current equatorial frame.
export interface EquatorialCoordinate<T = Angle> {
	rightAscension: T
	declination: T
}

// Right ascension and declination in the J2000 equatorial frame.
export interface EquatorialCoordinateJ2000<T = Angle> {
	rightAscensionJ2000: T
	declinationJ2000: T
}

// Local azimuth and altitude.
export interface HorizontalCoordinate<T = Angle> {
	azimuth: T
	altitude: T
}

// Ecliptic longitude and latitude.
export interface EclipticCoordinate<T = Angle> {
	longitude: T // λ, measured eastward from the vernal equinox along the ecliptic
	latitude: T // β, measured north/south from the ecliptic
}

// The Sun as the center and the galactic plane (the Milky Way's disk) as the equator
export interface GalacticCoordinate<T = Angle> {
	longitude: T // The angle eastward from the Galactic Center (0°)
	latitude: T // The angle north or south of the plane (±90°)
}

// Computes the angular separation between two equatorial coordinates.
export function angularDistance(ra0: Angle, dec0: Angle, ra1: Angle, dec1: Angle): Angle {
	const sinDec0 = Math.sin(dec0)
	const cosDec0 = Math.cos(dec0)
	const sinDec1 = Math.sin(dec1)
	const cosDec1 = Math.cos(dec1)
	const deltaRightAscension = ra0 - ra1
	const sinDeltaRightAscension = Math.sin(deltaRightAscension)
	const cosDeltaRightAscension = Math.cos(deltaRightAscension)
	// Use a stable atan2 form to preserve tiny separations near zero.
	const x = cosDec1 * sinDeltaRightAscension
	const y = cosDec0 * sinDec1 - sinDec0 * cosDec1 * cosDeltaRightAscension
	const z = sinDec0 * sinDec1 + cosDec0 * cosDec1 * cosDeltaRightAscension
	return Math.atan2(Math.sqrt(x * x + y * y), z)
}

// Converts J2000 equatorial coordinates to current equatorial coordinates.
export function equatorialFromJ2000(rightAscension: Angle, declination: Angle, time: Time = timeNow(true)) {
	const p = eraS2c(rightAscension, declination)
	return eraC2s(...matMulVec(precessionNutationMatrix(time), p, p))
}

// Converts current equatorial coordinates to J2000 equatorial coordinates.
export function equatorialToJ2000(rightAscension: Angle, declination: Angle, time: Time = timeNow(true)) {
	const p = eraS2c(rightAscension, declination)
	return eraC2s(...matTransposeMulVec(precessionNutationMatrix(time), p, p))
}

// Converts equatorial coordinates (right ascension and declination) to horizontal coordinates (azimuth and altitude) using just trigonometry (no refraction).
export function equatorialToHorizontal(rightAscension: Angle, declination: Angle, latitude: Angle, lst: Angle): [Angle, Angle] {
	const ha = lst - rightAscension
	const sinDec = Math.sin(declination)
	const cosDec = Math.cos(declination)
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const cosHA = Math.cos(ha)
	const sinHA = Math.sin(ha)
	const sinAlt = sinDec * sinLat + cosDec * cosLat * cosHA
	const altitude = Math.asin(clamp(sinAlt, -1, 1))
	// Resolve azimuth with atan2 so zenith and pole cases stay finite.
	const x = sinDec * cosLat - cosDec * sinLat * cosHA
	const y = -cosDec * sinHA
	const azimuth = Math.atan2(y, x)
	if (azimuth >= 0) return [azimuth, altitude]
	return [azimuth + TAU, altitude]
}

// Converts J2000 equatorial coordinates to J2000 ecliptic coordinates.
export function equatorialToEclipticJ2000(rightAscension: Angle, declination: Angle): [Angle, Angle] {
	return eraC2s(...matMulVec(ECLIPTIC_J2000_MATRIX, eraS2c(rightAscension, declination)))
}

// Converts current equatorial coordinates to current ecliptic coordinates.
export function equatorialToEcliptic(rightAscension: Angle, declination: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	return eraC2s(...matMulVec(matRotX(trueObliquity(time)), eraS2c(rightAscension, declination)))
}

// Converts J2000 ecliptic coordinates to J2000 equatorial coordinates.
export function eclipticJ2000ToEquatorial(longitude: Angle, latitude: Angle): [Angle, Angle] {
	return eraC2s(...matTransposeMulVec(ECLIPTIC_J2000_MATRIX, eraS2c(longitude, latitude)))
}

// Converts current ecliptic coordinates to current equatorial coordinates.
export function eclipticToEquatorial(longitude: Angle, latitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	return eraC2s(...matTransposeMulVec(matRotX(trueObliquity(time)), eraS2c(longitude, latitude)))
}

// Converts J2000 Galactic coordinates to J2000 equatorial coordinates.
export function galacticToEquatorial(longitude: Angle, latitude: Angle): [Angle, Angle] {
	return eraC2s(...matTransposeMulVec(GALACTIC_MATRIX, eraS2c(longitude, latitude)))
}

// Converts J2000 equatorial coordinates to J2000 Galactic coordinates.
export function equatorialToGalatic(rightAscension: Angle, declination: Angle): [Angle, Angle] {
	return eraC2s(...matMulVec(GALACTIC_MATRIX, eraS2c(rightAscension, declination)))
}

// Computes the current equatorial coordinates of the local zenith.
export function zenith(longitude: Angle, latitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)
	return [lst, latitude]
}

// Computes the current equatorial coordinates of the local meridian intersection with the celestial equator.
export function meridianEquator(longitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)
	return [lst, 0]
}

// Computes the current equatorial coordinates of the local meridian intersection with the ecliptic.
export function meridianEcliptic(longitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)
	const obliquity = trueObliquity(time)
	// Solve tan(dec) = sin(ra) * tan(epsilon) directly for the ecliptic point on the meridian.
	return [lst, Math.atan2(Math.sin(lst) * Math.sin(obliquity), Math.cos(obliquity))]
}

// Returns the nearer equinox node where the celestial equator crosses the ecliptic.
export function equatorEcliptic(longitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)

	if (PI >= lst - PIOVERTWO && PI <= lst + PIOVERTWO) return [PI, 0]
	return [0, 0]
}
