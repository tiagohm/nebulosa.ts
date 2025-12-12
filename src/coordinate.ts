import type { Angle } from './angle'
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

export function angularDistance(a: SphericalCoordinate, b: SphericalCoordinate): Angle {
	return Math.acos(Math.sin(a[1]) * Math.sin(b[1]) + Math.cos(a[1]) * Math.cos(b[1]) * Math.cos(a[0] - b[0]))
}
