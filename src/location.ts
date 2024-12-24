import { ANGVEL, type Angle } from './angle'
import { DAYSEC } from './constants'
import { meter, type Distance } from './distance'
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

const EARTH_ANGULAR_VELOCITY: Vec3 = [0, 0, DAYSEC * ANGVEL]

export interface Location {
	readonly longitude: Angle
	readonly latitude: Angle
	readonly elevation: Distance

	itrs?: Record<GeoId, Vec3 | undefined>
}

export function location(longitude: Angle = 0, latitude: Angle = 0, elevation: Distance = 0): Location {
	return { longitude, latitude, elevation }
}

// An |xyz| position in the Earth-centered Earth-fixed (ECEF) ITRS frame.
export function itrs(location: Location, model: GeoId = GeoId.IERS2010): Vec3 {
	if (location.itrs?.[model]) return location.itrs[model]

	const sinphi = Math.sin(location.latitude)
	const cosphi = Math.cos(location.latitude)
	const { radius, oneMinusFlatteningSquared } = GEO_ID_PARAMETERS[model]

	const c = 1.0 / Math.sqrt(cosphi * cosphi + sinphi * sinphi * oneMinusFlatteningSquared)
	const s = oneMinusFlatteningSquared * c

	const xy = (radius * c + location.elevation) * cosphi
	const x = xy * Math.cos(location.longitude)
	const y = xy * Math.sin(location.longitude)
	const z = (radius * s + location.elevation) * sinphi

	const itrs: Vec3 = [x, y, z]
	location.itrs ??= { 0: undefined, 1: undefined, 2: undefined, 3: undefined }
	location.itrs[model] = itrs

	return itrs
}

// The Earth's polar radius.
export function polarRadius(model: GeoId): Distance {
	const { radius, inverseFlattening } = GEO_ID_PARAMETERS[model]
	return radius * (1 - 1 / inverseFlattening)
}
