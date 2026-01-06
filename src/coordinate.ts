import type { Angle } from './angle'
import { ECLIPTIC_J2000_MATRIX, GALACTIC_MATRIX, MILLIASEC2RAD, PI, PIOVERTWO, TAU } from './constants'
import { eraC2s, eraS2c } from './erfa'
import { localSiderealTime } from './location'
import { matMulVec, matRotX, matTransposeMulVec } from './mat3'
import { precessionNutationMatrix, type Time, timeNow, trueObliquity } from './time'
import type { Vec3 } from './vec3'

// Representation of points in 3D spherical coordinates.
export type SphericalCoordinate = Vec3

// Representation of points in 3D cartesian coordinates.
export type CartesianCoordinate = Vec3

export interface EquatorialCoordinate<T = Angle> {
	rightAscension: T
	declination: T
}

export interface EquatorialCoordinateJ2000<T = Angle> {
	rightAscensionJ2000: T
	declinationJ2000: T
}

export interface HorizontalCoordinate<T = Angle> {
	azimuth: T
	altitude: T
}

export interface EclipticCoordinate<T = Angle> {
	longitude: T // λ, measured eastward from the vernal equinox along the ecliptic
	latitude: T // β, measured north/south from the ecliptic
}

// The Sun as the center and the galactic plane (the Milky Way's disk) as the equator
export interface GalacticCoordinate<T = Angle> {
	longitude: T // The angle eastward from the Galactic Center (0°)
	latitude: T // The angle north or south of the plane (±90°)
}

export function angularDistance(a: SphericalCoordinate, b: SphericalCoordinate): Angle {
	return Math.acos(Math.sin(a[1]) * Math.sin(b[1]) + Math.cos(a[1]) * Math.cos(b[1]) * Math.cos(a[0] - b[0]))
}

export function equatorialFromJ2000(rightAscension: Angle, declination: Angle, time: Time = timeNow(true)) {
	const p = eraS2c(rightAscension, declination)
	return eraC2s(...matMulVec(precessionNutationMatrix(time), p, p))
}

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
	const altitude = Math.asin(sinAlt)
	// Avoid trigonometric function. Return value of asin is always in [-pi/2, pi/2] and in this domain cosine is always non-negative, so we can use this.
	const cosAlt = Math.sqrt(1 - sinAlt * sinAlt)
	const a = (sinDec - sinLat * sinAlt) / (cosLat * (cosAlt === 0 ? Math.cos(altitude) : cosAlt))
	let azimuth = a <= -1 ? PI : a >= 1 ? 0 : Math.acos(a)
	if (sinHA > 0 && azimuth !== 0) azimuth = TAU - azimuth
	return [azimuth, altitude]
}

export function equatorialToEclipticJ2000(rightAscension: Angle, declination: Angle): [Angle, Angle] {
	return eraC2s(...matMulVec(ECLIPTIC_J2000_MATRIX, eraS2c(rightAscension, declination)))
}

export function equatorialToEcliptic(rightAscension: Angle, declination: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	return eraC2s(...matMulVec(matRotX(trueObliquity(time)), eraS2c(rightAscension, declination)))
}

export function eclipticJ2000ToEquatorial(longitude: Angle, latitude: Angle): [Angle, Angle] {
	return eraC2s(...matTransposeMulVec(ECLIPTIC_J2000_MATRIX, eraS2c(longitude, latitude)))
}

export function eclipticToEquatorial(longitude: Angle, latitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	return eraC2s(...matTransposeMulVec(matRotX(trueObliquity(time)), eraS2c(longitude, latitude)))
}

export function galacticToEquatorial(longitude: Angle, latitude: Angle): [Angle, Angle] {
	return eraC2s(...matTransposeMulVec(GALACTIC_MATRIX, eraS2c(longitude, latitude)))
}

export function equatorialToGalatic(rightAscension: Angle, declination: Angle): [Angle, Angle] {
	return eraC2s(...matMulVec(GALACTIC_MATRIX, eraS2c(rightAscension, declination)))
}

export function zenith(longitude: Angle, latitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)
	return [lst, latitude]
}

export function meridianEquator(longitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)
	return [lst, 0]
}

export function meridianEcliptic(longitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)

	let declination = Math.sin(lst) * Math.sin(trueObliquity(time)) // initial approximation

	for (let i = 0; i < 10; i++) {
		const prev = declination
		const [lambda] = equatorialToEcliptic(lst, declination, time)
		declination = eclipticToEquatorial(lambda, 0, time)[1]

		if (Math.abs(prev - declination) <= MILLIASEC2RAD) {
			console.info(i)
			break
		}
	}

	return [lst, declination]
}

export function equatorEcliptic(longitude: Angle, time: Time = timeNow(true)): [Angle, Angle] {
	const lst = localSiderealTime(time, longitude, true)

	if (PI >= lst - PIOVERTWO && PI <= lst + PIOVERTWO) return [PI, 0]
	return [0, 0]
}
