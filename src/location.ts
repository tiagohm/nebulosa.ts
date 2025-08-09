import { type Angle, normalizeAngle } from './angle'
import { type Distance, meter } from './distance'
import { eraGc2Gde, eraSp00 } from './erfa'
import { itrsRotationAt } from './itrs'
import { type Mat3, matFlipX, matMul, matRotX, matRotY, matRotZ } from './mat3'
import { greenwichApparentSiderealTime, greenwichMeanSiderealTime, pmAngles, type Time, tt } from './time'
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

// Creates a geographic position from longitude, latitude, elevation, and ellipsoid.
export function geodeticLocation(longitude: Angle = 0, latitude: Angle = 0, elevation: Distance = 0, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	return { longitude, latitude, elevation, ellipsoid }
}

// Creates a geographic position from a geocentric (Cartesian) coordinate.
export function geocentricLocation(x: number, y: number, z: number, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): GeographicPosition {
	const itrs = [x, y, z] as const
	const params = ELLIPSOID_PARAMETERS[ellipsoid]
	const [longitude, latitude, elevation] = eraGc2Gde(params.radius, params.flattening, x, y, z)
	return { longitude, latitude, elevation, ellipsoid, itrs }
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
export function localSiderealTime(time: Time, location: GeographicPosition = time.location!, mean: boolean = false, tio: boolean | 'sp' = false) {
	const theta = mean ? greenwichMeanSiderealTime(time) : greenwichApparentSiderealTime(time)

	if (tio === true) {
		const [sprime, xp, yp] = pmAngles(time)
		// The order of operation must be reversed in relation to astropy?
		const r = matRotZ(location.longitude, matRotX(-yp, matRotY(-xp, matRotZ(theta + sprime))))
		return Math.atan2(r[1], r[0])
	} else if (tio === 'sp') {
		const t = tt(time)
		const sprime = eraSp00(t.day, t.fraction)
		return normalizeAngle(theta + location.longitude + sprime)
	} else {
		// NOTE: astropy don't apply sprime (edit code to apply it)
		return normalizeAngle(theta + location.longitude)
	}
}

// Computes rotation from GCRS to this location's altazimuth system.
export function gcrsRotationAt(location: GeographicPosition, time: Time) {
	return matMul(rLatLon(location), itrsRotationAt(time))
}

// The Earth's polar radius.
export function polarRadius(ellipsoid: Ellipsoid): Distance {
	const { radius, flattening: inverseFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	return radius * (1 - inverseFlattening)
}
