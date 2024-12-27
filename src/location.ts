import { normalize, type Angle } from './angle'
import { meter, type Distance } from './distance'
import { eraGc2Gde, eraSp00 } from './erfa'
import { xy } from './iers'
import { EARTH_ANGULAR_VELOCITY_VECTOR, rotationAt as itrsRotationAt } from './itrs'
import { flipXMut, mul, mulVec, rotX, rotY, rotZ, type Mat3, type MutMat3 } from './matrix'
import { gast, gmst, pmAngles, tt, type Time } from './time'
import { type Vec3 } from './vector'

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

export const ELLIPSOID_PARAMETERS: Readonly<Record<Ellipsoid, EllipsoidParameters>> = {
	[Ellipsoid.GRS80]: {
		radius: meter(6378137),
		flattening: 1 / 298.257222101,
	},
	[Ellipsoid.WGS72]: {
		radius: meter(6378135),
		flattening: 1 / 298.26,
	},
	[Ellipsoid.WGS84]: {
		radius: meter(6378137),
		flattening: 1 / 298.257223563,
	},
	[Ellipsoid.IERS2010]: {
		radius: meter(6378136.6),
		flattening: 1 / 298.25642,
	},
}

export interface GeographicPosition {
	readonly longitude: Angle
	readonly latitude: Angle
	readonly elevation: Distance
	readonly ellipsoid: Ellipsoid

	itrs?: Vec3
	rLat?: Mat3
	rLatLon?: Mat3
}

export function geodetic(longitude: Angle = 0, latitude: Angle = 0, elevation: Distance = 0, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	return { longitude, latitude, elevation, ellipsoid }
}

export function geocentric(x: number, y: number, z: number, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	const itrs: Vec3 = [x, y, z]
	const params = ELLIPSOID_PARAMETERS[ellipsoid]
	const [longitude, latitude, elevation] = eraGc2Gde(params.radius, params.flattening, x, y, z)
	return { longitude, latitude, elevation, ellipsoid, itrs }
}

function rLat(location: GeographicPosition) {
	if (location.rLat) return location.rLat
	location.rLat = flipXMut(rotY(-location.latitude))
	return location.rLat
}

function rLatLon(location: GeographicPosition) {
	if (location.rLatLon) return location.rLatLon
	const m = rotZ(location.longitude)
	location.rLatLon = mul(rLat(location), m, m)
	return location.rLatLon
}

// Local Sidereal Time at location and time.
export function lst(location: GeographicPosition, time: Time, mean: boolean = false, tio: boolean | 'sp' = false) {
	const theta = mean ? gmst(time) : gast(time)

	if (tio === true) {
		const [sprime, xp, yp] = pmAngles(xy, time)
		// The order of operation must be reversed in relation to astropy?
		const r = rotZ(location.longitude, rotX(-yp, rotY(-xp, rotZ(theta + sprime))))
		return Math.atan2(r[1], r[0])
	} else if (tio === 'sp') {
		const t = tt(time)
		const sprime = eraSp00(t.day, t.fraction)
		return normalize(theta + location.longitude + sprime)
	} else {
		// NOTE: astropy don't apply sprime (edit code to apply it)
		return normalize(theta + location.longitude)
	}
}

// Computes rotation from GCRS to this location's altazimuth system.
export function rotationAt(location: GeographicPosition, time: Time): MutMat3 {
	return mul(rLatLon(location), itrsRotationAt(time))
}

export function dRdtTimesRtAt(location: GeographicPosition, time: Time): MutMat3 {
	// TODO: taking the derivative of the instantaneous angular velocity would provide a more accurate transform.
	const [x, y, z] = mulVec(rLat(location), EARTH_ANGULAR_VELOCITY_VECTOR)
	return [0, -z, y, z, 0, -x, -y, x, 0]
}

// The Earth's polar radius.
export function polarRadius(ellipsoid: Ellipsoid): Distance {
	const { radius, flattening: inverseFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	return radius * (1 - inverseFlattening)
}
