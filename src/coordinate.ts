import type { Angle } from './angle'
import type { Distance } from './distance'

// Representation of points in 3D spherical coordinates.
export type SphericalCoordinate = [Angle, Angle, Distance]

// Representation of points in 3D cartesian coordinates.
export type CartesianCoordinate = [Distance, Distance, Distance]

export function angularDistance(a: SphericalCoordinate, b: SphericalCoordinate): Angle {
	return Math.acos(Math.sin(a[1]) * Math.sin(b[1]) + Math.cos(a[1]) * Math.cos(b[1]) * Math.cos(a[0] - b[0]))
}
