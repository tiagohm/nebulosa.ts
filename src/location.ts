import { type Angle } from './angle'
import { meter, type Distance } from './distance'
import { EARTH_ANGULAR_VELOCITY_VECTOR, rotationAt as itrsRotationAt } from './itrs'
import { flipXMut, mul, mulVec, rotY, rotZ, type Mat3, type MutMat3 } from './matrix'
import { type Time } from './time'
import { type Vec3 } from './vector'

// An Earth ellipsoid that maps latitudes and longitudes to |xyz| positions.
export enum GeoId {
	GRS80,
	WGS72,
	// World Geodetic System 1984. Used by the GPS system.
	WGS84,
	// International Earth Rotation Service 2010.
	IERS2010,
}

export interface GeoIdParameters {
	readonly radius: Distance
	readonly inverseFlattening: number
	readonly oneMinusFlatteningSquared: number // pow((inverseFlattening - 1.0) / inverseFlattening, 2)
}

export const GEO_ID_PARAMETERS: Readonly<Record<GeoId, GeoIdParameters>> = {
	[GeoId.GRS80]: {
		radius: meter(6378137),
		inverseFlattening: 298.257222101,
		oneMinusFlatteningSquared: 0.99330561997709921237464088529694,
	},
	[GeoId.WGS72]: {
		radius: meter(6378135),
		inverseFlattening: 298.26,
		oneMinusFlatteningSquared: 0.99330568222173327802877197816852,
	},
	[GeoId.WGS84]: {
		radius: meter(6378137),
		inverseFlattening: 298.257223563,
		oneMinusFlatteningSquared: 0.99330562000985868300386276645996,
	},
	[GeoId.IERS2010]: {
		radius: meter(6378136.6),
		inverseFlattening: 298.25642,
		oneMinusFlatteningSquared: 0.99330560200413421509187591765606,
	},
}

export interface Location {
	readonly longitude: Angle
	readonly latitude: Angle
	readonly elevation: Distance
    readonly model: GeoId

	itrs?: Vec3
	rLat?: Mat3
	rLatLon?: Mat3
}

export function location(longitude: Angle = 0, latitude: Angle = 0, elevation: Distance = 0, model: GeoId = GeoId.IERS2010): Location {
	return { longitude, latitude, elevation, model }
}

function rLat(location: Location) {
	if (location.rLat) return location.rLat
	location.rLat = flipXMut(rotY(-location.latitude))
	return location.rLat
}

function rLatLon(location: Location) {
	if (location.rLatLon) return location.rLatLon
	const m = rotZ(location.longitude)
	location.rLatLon = mul(rLat(location), m, m)
	return location.rLatLon
}

// Computes rotation from GCRS to this location's altazimuth system.
export function rotationAt(location: Location, time: Time): MutMat3 {
	return mul(rLatLon(location), itrsRotationAt(time))
}

export function dRdtTimesRtAt(location: Location, time: Time): MutMat3 {
	// TODO: taking the derivative of the instantaneous angular velocity would provide a more accurate transform.
	const [x, y, z] = mulVec(rLat(location), EARTH_ANGULAR_VELOCITY_VECTOR)
	return [0, -z, y, z, 0, -x, -y, x, 0]
}

// The Earth's polar radius.
export function polarRadius(model: GeoId): Distance {
	const { radius, inverseFlattening } = GEO_ID_PARAMETERS[model]
	return radius * (1 - 1 / inverseFlattening)
}
