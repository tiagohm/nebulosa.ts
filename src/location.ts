import { type Angle, normalizeAngle, normalizePI } from './angle'
import { EARTH_ANGULAR_VELOCITY_VECTOR, ELLIPSOID_PARAMETERS } from './constants'
import type { Distance } from './distance'
import { eraGc2Gde, eraSp00 } from './erfa'
import type { Frame } from './frame'
import { type Mat3, type MutMat3, matFlipX, matMul, matMulVec, matRotX, matRotY, matRotZ } from './mat3'
import { gcrsToItrsRotationMatrix, greenwichApparentSiderealTime, greenwichMeanSiderealTime, pmAngles, type Time, tt } from './time'
import type { Vec3 } from './vec3'

// An Earth ellipsoid that maps latitudes and longitudes to |xyz| positions.
export enum Ellipsoid {
	GRS80,
	WGS72,
	// World Geodetic System 1984. Used by the GPS system.
	WGS84,
	// International Earth Rotation Service 2010.
	IERS2010,
}

export interface EllipsoidParameters {
	readonly radius: Distance
	readonly flattening: number
}

export interface GeographicCoordinate<T = Angle, D = Distance> {
	latitude: T
	longitude: T
	elevation: D
}

export interface GeographicPosition extends Readonly<GeographicCoordinate> {
	readonly ellipsoid: Ellipsoid

	itrs?: Vec3
	rLat?: Mat3
	rLatLon?: Mat3
	rhoCosPhi?: number
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

function rLat(location: GeographicPosition) {
	if (location.rLat) return location.rLat
	const m = matRotY(-location.latitude)
	location.rLat = matFlipX(m, m)
	return location.rLat
}

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
		return Math.atan2(r[1], r[0])
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
	const m = gcrsToItrsRotationMatrix(time) as MutMat3
	return matMul(rLatLon(location), m, m)
}

// The Geocentric Celestial Reference System (GCRS) at location.
export function gcrs(location: GeographicPosition): Frame {
	return {
		rotationAt: (time) => gcrsRotationAt(location, time),
		dRdtTimesRtAt: () => {
			// TODO: taking the derivative of the instantaneous angular velocity would provide a more accurate transform.
			const [x, y, z] = matMulVec(rLat(location), EARTH_ANGULAR_VELOCITY_VECTOR)
			return [0, -z, y, z, 0, -x, -y, x, 0]
		},
	}
}

// The Earth's polar radius.
export function polarRadius(ellipsoid: Ellipsoid): Distance {
	const { radius, flattening: inverseFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	return radius * (1 - inverseFlattening)
}

// Term needed for calculation of parallax effect.
// Taken from from PAWC, p.66.
export function rhoCosPhi(location: GeographicPosition) {
	if (location.rhoCosPhi) return location.rhoCosPhi
	const { latitude, elevation, ellipsoid } = location
	const u = Math.atan(0.99664719 * Math.tan(latitude))
	const r = ELLIPSOID_PARAMETERS[ellipsoid].radius
	location.rhoCosPhi = Math.cos(u) + (elevation / r) * Math.cos(latitude)
	return location.rhoCosPhi
}

// Term needed for calculation of parallax effect.
// Taken from from PAWC, p.66.
export function rhoSinPhi(location: GeographicPosition) {
	if (location.rhoSinPhi) return location.rhoSinPhi
	const { latitude, elevation, ellipsoid } = location
	const u = Math.atan(0.99664719 * Math.tan(latitude))
	const r = ELLIPSOID_PARAMETERS[ellipsoid].radius
	location.rhoSinPhi = 0.99664719 * Math.sin(u) + (elevation / r) * Math.sin(latitude)
	return location.rhoSinPhi
}

// Computes Earth latitude and longitude beneath a celestial position at time.
export function subpoint(geocentric: Vec3, time: Time, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	const itrs = matMulVec(gcrsToItrsRotationMatrix(time), geocentric)
	const [x, y, z] = itrs

	const r = Math.hypot(x, y)
	const longitude = normalizePI(Math.atan2(y, x))
	let latitude = Math.atan2(z, r)

	const { radius, flattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const e2 = 2 * flattening - flattening * flattening
	let c = 0

	for (let i = 0; i < 3; i++) {
		const sLat = Math.sin(latitude)
		const sLatE2 = sLat * e2
		c = radius / Math.sqrt(1 - sLatE2 * sLat)
		latitude = Math.atan2(z + c * sLatE2, r)
	}

	const elevation = r / Math.cos(latitude) - radius * c

	return { longitude, latitude, elevation: elevation * radius, ellipsoid, itrs }
}
