import { ELLIPSOID_PARAMETERS } from '../../core/constants'
import { type Mat3, matFlipX, matMul, matMulVec, matRotX, matRotY, matRotZ } from '../../math/linear-algebra/mat3'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { eraGc2Gde, eraSp00 } from '../coordinates/erfa/erfa'
import type { Frame } from '../coordinates/frame'
import { gcrsToItrsRotationMatrix, greenwichApparentSiderealTime, greenwichMeanSiderealTime, instantaneousEarthAngularVelocity, pmAngles, type Time, tt } from '../time/time'

// Observer location on the Earth and the geodetic geometry around it: building a position from geodetic
// (lat/lon/elevation) or geocentric Cartesian coordinates on a reference ellipsoid, the GCRS->altazimuth
// rotation and its rotating-frame velocity operator, local sidereal time, the parallax terms rho·cos φ
// and rho·sin φ, and the sub-point beneath a celestial direction. Angles are radians, distances AU.
// Geometry derived per position (ITRS vector, rotation matrices, parallax terms) is memoized on it.

// An Earth ellipsoid that maps latitudes and longitudes to |xyz| positions.
export enum Ellipsoid {
	// Geodetic Reference System 1980.
	GRS80,
	// World Geodetic System 1972.
	WGS72,
	// World Geodetic System 1984. Used by the GPS system.
	WGS84,
	// International Earth Rotation Service 2010.
	IERS2010,
}

// Geometric parameters of a reference ellipsoid.
export interface EllipsoidParameters {
	// Equatorial radius in AU.
	readonly radius: Distance
	// Flattening f (dimensionless).
	readonly flattening: number
	// Precomputed 1 - f, the recurring factor in geodetic conversions.
	readonly oneMinusFlattening: number
}

// Geodetic coordinates, generic over the angle and distance representations.
export interface GeographicCoordinate<T = Angle, D = Distance> {
	// Geodetic latitude (radians by default), north-positive.
	latitude: T
	// Geodetic longitude (radians by default), east-positive.
	longitude: T
	// Height above the ellipsoid (AU by default).
	elevation: D
}

// A resolved observer position on a specific ellipsoid, with memoized derived geometry.
export interface GeographicPosition extends Readonly<GeographicCoordinate> {
	// Reference ellipsoid the coordinates are defined on.
	readonly ellipsoid: Ellipsoid

	// Cached geocentric ITRS position vector (AU).
	itrs?: Vec3
	// Cached latitude rotation (ITRS axes to local meridian).
	rLat?: Mat3
	// Cached combined latitude+longitude rotation to the local altazimuth axes.
	rLatLon?: Mat3
	// Cached rho·cos φ parallax term.
	rhoCosPhi?: number
	// Cached rho·sin φ parallax term.
	rhoSinPhi?: number
}

// Creates a geographic position from longitude, latitude, elevation, and ellipsoid.
export function geodeticLocation(longitude: Angle = 0, latitude: Angle = 0, elevation: Distance = 0, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	return { longitude, latitude, elevation, ellipsoid }
}

// Creates a geographic position from a geocentric (Cartesian) coordinate.
export function geocentricLocation(x: number, y: number, z: number, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const [longitude, latitude, elevation] = eraGc2Gde(radius, flattening, x, y, z)
	return { longitude, latitude, elevation, ellipsoid }
}

// Latitude rotation taking ITRS axes to a meridian-aligned frame; memoized on the location.
function rLat(location: GeographicPosition) {
	if (location.rLat) return location.rLat
	const m = matRotY(-location.latitude)
	location.rLat = matFlipX(m, m)
	return location.rLat
}

// Combined longitude-then-latitude rotation to the local altazimuth axes; memoized on the location.
function rLatLon(location: GeographicPosition) {
	if (location.rLatLon) return location.rLatLon
	const m = matRotZ(location.longitude)
	location.rLatLon = matMul(rLat(location), m, m)
	return location.rLatLon
}

// Local Sidereal Time at location and time.
export function localSiderealTime(time: Time, location: GeographicCoordinate | Angle = time.location!, mean: boolean = false, tio: boolean | 'sp' = false) {
	const theta = mean ? greenwichMeanSiderealTime(time) : greenwichApparentSiderealTime(time)
	const longitude = typeof location === 'number' ? location : location.longitude

	if (tio === true) {
		const [sprime, xp, yp] = pmAngles(time)
		// The order of operation must be reversed in relation to astropy?
		const r = matRotZ(longitude, matRotX(-yp, matRotY(-xp, matRotZ(theta + sprime))))
		return normalizeAngle(Math.atan2(r[1], r[0]))
	} else if (tio === 'sp') {
		const t = tt(time)
		const sprime = eraSp00(t.day, t.fraction)
		return normalizeAngle(theta + longitude + sprime)
	} else {
		// NOTE: astropy don't apply sprime (edit code to apply it)
		return normalizeAngle(theta + longitude)
	}
}

// Computes rotation from GCRS to this location's altazimuth system.
export function gcrsRotationAt(location: GeographicPosition, time: Time) {
	// gcrsToItrsRotationMatrix returns a matrix cached on `time`; multiply into a
	// fresh matrix instead of in place so the shared GCRS->ITRS cache is preserved
	// (instantaneousEarthAngularVelocity and other consumers read it afterwards).
	const m = gcrsToItrsRotationMatrix(time)
	return matMul(rLatLon(location), m)
}

// The Geocentric Celestial Reference System (GCRS) at location.
export function gcrs(location: GeographicPosition): Frame {
	return {
		rotationAt: (time) => gcrsRotationAt(location, time),
		dRdtTimesRtAt: (time) => {
			const [x, y, z] = matMulVec(rLatLon(location), instantaneousEarthAngularVelocity(time))
			return [0, -z, y, z, 0, -x, -y, x, 0]
		},
	}
}

// The Earth's polar radius.
export function polarRadius(ellipsoid: Ellipsoid): Distance {
	const { radius, oneMinusFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	return radius * oneMinusFlattening
}

// Term needed for calculation of parallax effect.
// Taken from from PAWC, p.66.
export function rhoCosPhi(location: GeographicPosition) {
	const cached = location.rhoCosPhi
	if (cached !== undefined) return cached
	const { latitude, elevation, ellipsoid } = location
	const { radius, oneMinusFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const u = Math.atan(oneMinusFlattening * Math.tan(latitude))
	location.rhoCosPhi = Math.cos(u) + (elevation / radius) * Math.cos(latitude)
	return location.rhoCosPhi
}

// Term needed for calculation of parallax effect.
// Taken from from PAWC, p.66.
export function rhoSinPhi(location: GeographicPosition) {
	const cached = location.rhoSinPhi
	if (cached !== undefined) return cached
	const { latitude, elevation, ellipsoid } = location
	const { radius, oneMinusFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const u = Math.atan(oneMinusFlattening * Math.tan(latitude))
	location.rhoSinPhi = oneMinusFlattening * Math.sin(u) + (elevation / radius) * Math.sin(latitude)
	return location.rhoSinPhi
}

// Computes Earth latitude and longitude beneath a celestial position at time.
export function subpoint(geocentric: Vec3, time: Time, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	const itrs = matMulVec(gcrsToItrsRotationMatrix(time), geocentric)
	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const [longitude, latitude, elevation] = eraGc2Gde(radius, flattening, ...itrs)
	return { longitude: normalizePI(longitude), latitude, elevation, ellipsoid, itrs }
}
