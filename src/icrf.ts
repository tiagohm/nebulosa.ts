import { normalize, type Angle } from './angle'
import { AU_M, DAYSEC, SPEED_OF_LIGHT } from './constants'
import type { CartesianCoordinate, SphericalCoordinate } from './coordinate'
import type { Distance } from './distance'
import { eraP2s, eraS2p } from './erfa'
import type { Frame } from './frame'
import { rotationAt as itrsRotationAt } from './itrs'
import type { GeographicPosition } from './location'
import { mulVec, transpose, type Mat3 } from './matrix'
import { equationOfOrigins, precessionNutation, type Time } from './time'
import { angle, length, plus, zero, type MutVec3 } from './vector'

export type PositionAndVelocity = [MutVec3, MutVec3]

export type PositionAndVelocityOverTime = (time: Time) => PositionAndVelocity

// An |xyz| position and velocity oriented to the ICRF axes.
export interface ICRF {
	readonly [0]: MutVec3
	readonly [1]: MutVec3

	readonly center: number | GeographicPosition
	readonly target: number

	centerBarycentric?: ICRF
}

// Length of position component in AU.
export function distance(icrf: PositionAndVelocity): Distance {
	return length(icrf[0])
}

// Length of velocity component in AU.
export function speed(icrf: PositionAndVelocity) {
	return length(icrf[1])
}

// Length of position component in days of light travel time.
export function lightTime(icrf: PositionAndVelocity) {
	return distance(icrf) * (AU_M / SPEED_OF_LIGHT / DAYSEC)
}

// Computes the equatorial coordinates with respect to the fixed axes of the ICRF.
export function equatorial(icrf: PositionAndVelocity): SphericalCoordinate {
	return eraP2s(...icrf[0])
}

// Computes the equatorial coordinate referenced to the dynamical system defined by
// the Earth's true equator and equinox at specific time represented by its rotation matrix.
export function equatorialAtEpoch(icrf: PositionAndVelocity, m: Mat3): SphericalCoordinate {
	return eraP2s(...mulVec(m, icrf[0]))
}

// Computes the equatorial coordinates referenced to the dynamical system defined by
// the Earth's true equator and equinox at time.
export function equatorialAtTime(icrf: PositionAndVelocity, time: Time): SphericalCoordinate {
	return equatorialAtEpoch(icrf, precessionNutation(time))
}

// Computes the hour angle, declination, and distance at time.
// This only works for positions whose center is a geographic location,
// otherwise, there is no local meridian from which to measure the hour angle.
// Because this declination is measured from the plane of the Earth's physical geographic equator,
// it will be slightly different than the declination returned by equatorial.
// The coordinates are not adjusted for atmospheric refraction near the horizon.
export function hourAngle(icrf: ICRF, time: Time): SphericalCoordinate | undefined {
	if (typeof icrf.center === 'number') return undefined

	const r = itrsRotationAt(time)
	const [sublongitude, dec, distance] = mulVec(r, icrf[0])
	const ha = normalize(icrf.center.longitude - sublongitude)

	return [ha, dec, distance]
}

// Computes the deviation between zenith angle and north angle.
export function parallacticAngle(icrf: ICRF, time: Time): Angle | undefined {
	const ha = hourAngle(icrf, time)

	if (ha) {
		const phi = (icrf.center as GeographicPosition).latitude
		// A rare condition! Object exactly in zenith, avoid undefined result.
		return ha[0] === 0 && ha[1] - phi === 0 ? 0 : Math.atan2(Math.sin(ha[0]), Math.tan(phi) * Math.cos(ha[1]) - Math.sin(ha[1]) * Math.cos(ha[0]))
	} else {
		return undefined
	}
}

// Computes the cartesian CIRS coordinates at time.
export function cirs(icrf: PositionAndVelocity, time: Time): CartesianCoordinate {
	return mulVec(equationOfOrigins(time), icrf[0])
}

// Computes the spherical CIRS coordinates at time.
export function sphericalCirs(icrf: PositionAndVelocity, time: Time): SphericalCoordinate {
	return eraP2s(...cirs(icrf, time))
}

// Computes the angle between two positions.
export function separationFrom(a: PositionAndVelocity, b: PositionAndVelocity): Angle {
	return angle(a[0], b[0])
}

// Computes the new position and velocity in relation to a reference frame at time.
export function frame(icrf: PositionAndVelocity, f: Frame, time: Time): PositionAndVelocity {
	const r = f.rotationAt(time)
	const p = mulVec(r, icrf[0])
	const v = mulVec(r, icrf[1])

	const drdt = f.dRdtTimesRtAt?.(time)

	if (drdt) {
		plus(v, mulVec(drdt, p, r as unknown as MutVec3), v)
	}

	return [p, v]
}

// Computes the longitude, latitude and distance for the given frame at time.
export function equatorialAtFrame(icrf: PositionAndVelocity, f: Frame, time: Time): SphericalCoordinate {
	return eraP2s(...mulVec(f.rotationAt(time), icrf[0]))
}

export function icrf(ra: Angle, dec: Angle, distance: Distance = 1, center: number | GeographicPosition, target: number, equinox?: Time): ICRF {
	const position = eraS2p(ra, dec, distance)

	if (equinox) {
		mulVec(transpose(precessionNutation(equinox)), position, position)
	}

	return { 0: position, 1: zero(), center, target }
}
