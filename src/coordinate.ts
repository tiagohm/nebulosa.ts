import type { Angle } from './angle'
import type { Vector3 } from './vector'

// Representation of points in 3D spherical coordinates.
export type SphericalCoordinate = Vector3.Vector

// Representation of points in 3D cartesian coordinates.
export type CartesianCoordinate = Vector3.Vector

export function angularDistance(a: SphericalCoordinate, b: SphericalCoordinate): Angle {
	return Math.acos(Math.sin(a[1]) * Math.sin(b[1]) + Math.cos(a[1]) * Math.cos(b[1]) * Math.cos(a[0] - b[0]))
}
