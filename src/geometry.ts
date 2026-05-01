import { normalizeAngle } from './angle'
import { PI } from './constants'
import { eraS2c } from './erfa'
import { clamp } from './math'
import { type MutVec3, type Vec3, vecCross, vecDot, vecFill, vecNormalize, vecNormalizeMut } from './vec3'

export interface Point<T = number> {
	x: T
	y: T
}

export interface Size<T = number> {
	width: T
	height: T
}

export interface Rect<T = number> {
	left: T
	top: T
	right: T
	bottom: T
}

// Local orthonormal basis around one sky direction on the celestial sphere.
export interface SphericalTangentBasis {
	readonly origin: MutVec3
	readonly east: MutVec3
	readonly north: MutVec3
}

// Local gnomonic projection coordinates around one spherical tangent point.
export interface SphericalTangentOffset extends Point {
	denominator: number
}

// Local equatorial-mount frame around one sky direction and one polar axis.
export interface SphericalMountBasis {
	readonly origin: MutVec3
	readonly polarAxis: MutVec3
	readonly declinationAxis: MutVec3
	readonly hourAngleTangent: MutVec3
	readonly declinationTangent: MutVec3
}

const SPHERICAL_POLE_AXIS: Vec3 = [0, 0, 1]

// Computes the midpoint between two Cartesian 2D points.
export function midPoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

// Computes Euclidean squared distance between points.
export function euclideanSquaredDistance(a: Point, b: Point) {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return dx * dx + dy * dy
}

// Computes Euclidean distance between points.
export function euclideanDistance(a: Point, b: Point) {
	return Math.sqrt(euclideanSquaredDistance(a, b))
}

// https://dreamswork.github.io/qt4/qrect_8cpp_source.html

// Computes the axis-aligned rectangle intersection.
export function rectIntersection(a: Rect, b: Rect, out?: Rect) {
	let la = a.left
	let ra = a.left
	if (a.right < a.left) la = a.right
	else ra = a.right

	let lb = b.left
	let rb = b.left
	if (b.right < b.left) lb = b.right
	else rb = b.right

	if (la >= rb || lb >= ra) return undefined

	let ta = a.top
	let ba = a.top
	if (a.bottom < a.top) ta = a.bottom
	else ba = a.bottom

	let tb = b.top
	let bb = b.top
	if (b.bottom < b.top) tb = b.bottom
	else bb = b.bottom

	if (ta >= bb || tb >= ba) return undefined

	out ??= { left: 0, right: 0, top: 0, bottom: 0 }

	out.left = Math.max(la, lb)
	out.right = Math.min(ra, rb)
	out.top = Math.max(ta, tb)
	out.bottom = Math.min(ba, bb)

	return out
}

// Builds the exact orthonormal spherical basis at the given longitude and latitude.
export function sphericalCoordinateBasis(longitude: number, latitude: number, out?: SphericalTangentBasis): SphericalTangentBasis {
	const basis = out ?? { origin: [0, 0, 0], east: [0, 0, 0], north: [0, 0, 0] }
	const sinLongitude = Math.sin(longitude)
	const cosLongitude = Math.cos(longitude)
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)

	vecFill(basis.origin, cosLongitude * cosLatitude, sinLongitude * cosLatitude, sinLatitude)
	vecFill(basis.east, -sinLongitude, cosLongitude, 0)
	vecFill(basis.north, -cosLongitude * sinLatitude, -sinLongitude * sinLatitude, cosLatitude)

	return basis
}

// Builds an orthonormal tangent basis around the given sky direction.
export function sphericalTangentBasis(origin: Vec3, out?: SphericalTangentBasis): SphericalTangentBasis {
	const basis = out ?? { origin: [0, 0, 0], east: [0, 0, 0], north: [0, 0, 0] }

	vecNormalize(origin, basis.origin)

	if (basis.origin[0] === 0 && basis.origin[1] === 0 && basis.origin[2] === 0) {
		// Zero has no tangent plane, so return a deterministic canonical basis.
		vecFill(basis.east, 1, 0, 0)
		vecFill(basis.north, 0, 1, 0)
		return basis
	}

	// Use the celestial pole to preserve east/north orientation away from the polar singularity.
	if (Math.hypot(basis.origin[0], basis.origin[1]) > 1e-14) {
		vecCross(SPHERICAL_POLE_AXIS, basis.origin, basis.east)
		vecNormalizeMut(basis.east)
		vecCross(basis.origin, basis.east, basis.north)
		vecNormalizeMut(basis.north)
		return basis
	}

	// Near the poles longitude is ill-conditioned, so use a stable deterministic meridian fallback.
	vecFill(basis.east, 0, 1, 0)
	vecFill(basis.north, basis.origin[2] >= 0 ? -1 : 1, 0, 0)
	return basis
}

// Creates the local tangent unit vector with the given position angle, measured east of north.
export function sphericalDirectionVector(origin: Vec3, positionAngle: number, out?: MutVec3, basis?: SphericalTangentBasis): MutVec3 {
	const localBasis = sphericalTangentBasis(origin, basis)
	const sinPositionAngle = Math.sin(positionAngle)
	const cosPositionAngle = Math.cos(positionAngle)
	const x = localBasis.east[0] * sinPositionAngle + localBasis.north[0] * cosPositionAngle
	const y = localBasis.east[1] * sinPositionAngle + localBasis.north[1] * cosPositionAngle
	const z = localBasis.east[2] * sinPositionAngle + localBasis.north[2] * cosPositionAngle
	return vecNormalizeMut(vecFill(out ?? [0, 0, 0], x, y, z))
}

// Creates the unit great-circle pole for the local arc direction defined by origin and position angle.
export function sphericalPoleVector(origin: Vec3, positionAngle: number, out?: MutVec3, basis?: SphericalTangentBasis): MutVec3 {
	const localBasis = sphericalTangentBasis(origin, basis)
	const sinPositionAngle = Math.sin(positionAngle)
	const cosPositionAngle = Math.cos(positionAngle)
	const x = localBasis.north[0] * sinPositionAngle - localBasis.east[0] * cosPositionAngle
	const y = localBasis.north[1] * sinPositionAngle - localBasis.east[1] * cosPositionAngle
	const z = localBasis.north[2] * sinPositionAngle - localBasis.east[2] * cosPositionAngle
	return vecNormalizeMut(vecFill(out ?? [0, 0, 0], x, y, z))
}

// Creates the unit great-circle pole through two sky directions, or zero when the plane is degenerate.
export function sphericalGreatCirclePole(a: Vec3, b: Vec3, out?: MutVec3): MutVec3 {
	return vecNormalizeMut(vecCross(a, b, out ?? [0, 0, 0]))
}

// Creates the unit sky vector reached from origin by an angular offset along the given position angle.
export function sphericalOffsetVector(origin: Vec3, positionAngle: number, distance: number, out?: MutVec3, basis?: SphericalTangentBasis): MutVec3 {
	const localBasis = sphericalTangentBasis(origin, basis)
	const sinDistance = Math.sin(distance)
	const cosDistance = Math.cos(distance)
	const sinPositionAngle = Math.sin(positionAngle)
	const cosPositionAngle = Math.cos(positionAngle)
	const tangentX = localBasis.east[0] * sinPositionAngle + localBasis.north[0] * cosPositionAngle
	const tangentY = localBasis.east[1] * sinPositionAngle + localBasis.north[1] * cosPositionAngle
	const tangentZ = localBasis.east[2] * sinPositionAngle + localBasis.north[2] * cosPositionAngle
	const x = localBasis.origin[0] * cosDistance + tangentX * sinDistance
	const y = localBasis.origin[1] * cosDistance + tangentY * sinDistance
	const z = localBasis.origin[2] * cosDistance + tangentZ * sinDistance
	return vecNormalizeMut(vecFill(out ?? [0, 0, 0], x, y, z))
}

// Projects a sky direction into gnomonic tangent-plane coordinates around the given origin.
export function sphericalProjectTangentPlane(direction: Vec3, origin: Vec3, out?: SphericalTangentOffset, basis?: SphericalTangentBasis): SphericalTangentOffset | false {
	const localBasis = sphericalTangentBasis(origin, basis)
	const denominator = vecDot(direction, localBasis.origin)

	if (denominator <= 0) return false

	const tangent = out ?? { x: 0, y: 0, denominator: 0 }
	tangent.x = vecDot(direction, localBasis.east) / denominator
	tangent.y = vecDot(direction, localBasis.north) / denominator
	tangent.denominator = denominator

	return tangent
}

// Unprojects gnomonic tangent-plane coordinates into a unit sky direction.
export function sphericalUnprojectTangentPlane(x: number, y: number, origin: Vec3, out?: MutVec3, basis?: SphericalTangentBasis) {
	const localBasis = sphericalTangentBasis(origin, basis)
	return vecNormalizeMut(vecFill(out ?? [0, 0, 0], localBasis.origin[0] + x * localBasis.east[0] + y * localBasis.north[0], localBasis.origin[1] + x * localBasis.east[1] + y * localBasis.north[1], localBasis.origin[2] + x * localBasis.east[2] + y * localBasis.north[2]))
}

// Creates the local mount polar axis vector from site latitude plus azimuth/altitude polar errors.
export function sphericalMountPolarAxisVector(latitude: number, azimuthError: number = 0, altitudeError: number = 0, out?: MutVec3) {
	const isNorthern = latitude >= 0
	const azimuth = isNorthern ? normalizeAngle(azimuthError) : normalizeAngle(PI + azimuthError)
	const altitude = Math.abs(latitude) + (isNorthern ? altitudeError : -altitudeError)
	return eraS2c(azimuth, altitude, out)
}

// Builds the local equatorial-mount basis around the given pointing direction and polar axis.
export function sphericalMountBasis(origin: Vec3, polarAxis: Vec3 = SPHERICAL_POLE_AXIS, out?: SphericalMountBasis, basis?: SphericalTangentBasis): SphericalMountBasis {
	const mountBasis = out ?? { origin: [0, 0, 0], polarAxis: [0, 0, 0], declinationAxis: [0, 0, 0], hourAngleTangent: [0, 0, 0], declinationTangent: [0, 0, 0] }

	vecNormalize(origin, mountBasis.origin)
	vecNormalize(polarAxis, mountBasis.polarAxis)

	if (mountBasis.polarAxis[0] === 0 && mountBasis.polarAxis[1] === 0 && mountBasis.polarAxis[2] === 0) {
		vecFill(mountBasis.polarAxis, SPHERICAL_POLE_AXIS[0], SPHERICAL_POLE_AXIS[1], SPHERICAL_POLE_AXIS[2])
	}

	if (mountBasis.origin[0] === 0 && mountBasis.origin[1] === 0 && mountBasis.origin[2] === 0) {
		// Zero has no hour-angle/declination frame, so return a deterministic canonical mount basis.
		vecFill(mountBasis.declinationAxis, 0, -1, 0)
		vecFill(mountBasis.hourAngleTangent, 0, 1, 0)
		vecFill(mountBasis.declinationTangent, -1, 0, 0)
		return mountBasis
	}

	vecCross(mountBasis.origin, mountBasis.polarAxis, mountBasis.declinationAxis)

	if (Math.hypot(mountBasis.declinationAxis[0], mountBasis.declinationAxis[1], mountBasis.declinationAxis[2]) > 1e-14) {
		vecNormalizeMut(mountBasis.declinationAxis)
		vecCross(mountBasis.polarAxis, mountBasis.origin, mountBasis.hourAngleTangent)
		vecNormalizeMut(mountBasis.hourAngleTangent)
		vecCross(mountBasis.declinationAxis, mountBasis.origin, mountBasis.declinationTangent)
		vecNormalizeMut(mountBasis.declinationTangent)
		return mountBasis
	}

	// Near the mount pole the declination axis is underconstrained, so reuse a deterministic sky tangent basis.
	const localBasis = sphericalTangentBasis(mountBasis.origin, basis)
	vecFill(mountBasis.declinationAxis, -localBasis.east[0], -localBasis.east[1], -localBasis.east[2])
	vecFill(mountBasis.hourAngleTangent, localBasis.east[0], localBasis.east[1], localBasis.east[2])
	vecFill(mountBasis.declinationTangent, localBasis.north[0], localBasis.north[1], localBasis.north[2])

	return mountBasis
}

// Creates the local declination-axis unit vector for one pointing direction and one polar axis.
export function sphericalMountDeclinationAxisVector(origin: Vec3, polarAxis: Vec3 = SPHERICAL_POLE_AXIS, out?: MutVec3, basis?: SphericalTangentBasis): MutVec3 {
	const axis = out ?? [0, 0, 0]
	const originLength = Math.hypot(origin[0], origin[1], origin[2])

	if (originLength === 0) return vecFill(axis, 0, -1, 0)

	let polarAxisX = polarAxis[0]
	let polarAxisY = polarAxis[1]
	let polarAxisZ = polarAxis[2]
	const polarAxisLength = Math.hypot(polarAxisX, polarAxisY, polarAxisZ)

	if (polarAxisLength === 0) {
		polarAxisX = SPHERICAL_POLE_AXIS[0]
		polarAxisY = SPHERICAL_POLE_AXIS[1]
		polarAxisZ = SPHERICAL_POLE_AXIS[2]
	} else {
		const invPolarAxisLength = 1 / polarAxisLength
		polarAxisX *= invPolarAxisLength
		polarAxisY *= invPolarAxisLength
		polarAxisZ *= invPolarAxisLength
	}

	const invOriginLength = 1 / originLength
	const originX = origin[0] * invOriginLength
	const originY = origin[1] * invOriginLength
	const originZ = origin[2] * invOriginLength
	const declinationAxisX = originY * polarAxisZ - originZ * polarAxisY
	const declinationAxisY = originZ * polarAxisX - originX * polarAxisZ
	const declinationAxisZ = originX * polarAxisY - originY * polarAxisX
	const declinationAxisLength = Math.hypot(declinationAxisX, declinationAxisY, declinationAxisZ)

	if (declinationAxisLength > 1e-14) {
		const invDeclinationAxisLength = 1 / declinationAxisLength
		return vecFill(axis, declinationAxisX * invDeclinationAxisLength, declinationAxisY * invDeclinationAxisLength, declinationAxisZ * invDeclinationAxisLength)
	}

	const localBasis = sphericalTangentBasis(origin, basis)
	return vecFill(axis, -localBasis.east[0], -localBasis.east[1], -localBasis.east[2])
}

// Computes distance to intersections of a line and a sphere.
// Given a line through the origin (0,0,0) and an |xyz| endpoint,
// and a sphere with the |xyz| center and radius,
// return the distance from the origin to their two intersections.
// If the line is tangent to the sphere, the two intersections will be
// at the same distance. If the line does not intersect the sphere,
// two NaNs values will be returned.
// http://paulbourke.net/geometry/circlesphere/index.html#linesphere
export function intersectLineAndSphere(endpoint: Vec3, center: Vec3, radius: number): readonly [number, number] | false {
	const minusB = vecDot(endpoint, center) * 2
	const c = vecDot(center, center) - radius * radius
	const discriminant = minusB * minusB - 4 * c
	if (discriminant < 0) return false
	const dsqrt = Math.sqrt(discriminant)
	return [(minusB - dsqrt) / 2, (minusB + dsqrt) / 2]
}

// Computes the angular distance between two points on the unit sphere.
export function sphericalSeparation(longitudeA: number, latitudeA: number, longitudeB: number, latitudeB: number) {
	const dLongitude = longitudeB - longitudeA
	const sinLatitudeA = Math.sin(latitudeA)
	const cosLatitudeA = Math.cos(latitudeA)
	const sinLatitudeB = Math.sin(latitudeB)
	const cosLatitudeB = Math.cos(latitudeB)
	const sinDLongitude = Math.sin(dLongitude)
	const cosDLongitude = Math.cos(dLongitude)
	const x = cosLatitudeB * sinDLongitude
	const y = cosLatitudeA * sinLatitudeB - sinLatitudeA * cosLatitudeB * cosDLongitude
	const z = sinLatitudeA * sinLatitudeB + cosLatitudeA * cosLatitudeB * cosDLongitude
	return Math.atan2(Math.hypot(x, y), z)
}

// Computes the spherical position angle from the first point to the second, measured east of north.
export function sphericalPositionAngle(longitudeA: number, latitudeA: number, longitudeB: number, latitudeB: number) {
	const dLongitude = longitudeB - longitudeA
	const cosLatitudeB = Math.cos(latitudeB)
	const y = Math.sin(dLongitude) * cosLatitudeB
	const x = Math.cos(latitudeA) * Math.sin(latitudeB) - Math.sin(latitudeA) * cosLatitudeB * Math.cos(dLongitude)
	return normalizeAngle(Math.atan2(y, x))
}

// Computes the point reached from a spherical point by applying an angular offset along a position angle.
export function sphericalDestination(longitude: number, latitude: number, positionAngle: number, distance: number) {
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const sinDistance = Math.sin(distance)
	const cosDistance = Math.cos(distance)
	const sinPositionAngle = Math.sin(positionAngle)
	const cosPositionAngle = Math.cos(positionAngle)
	const nextSinLatitude = sinLatitude * cosDistance + cosLatitude * sinDistance * cosPositionAngle
	const nextLatitude = nextSinLatitude <= -1 ? -PI / 2 : nextSinLatitude >= 1 ? PI / 2 : Math.asin(nextSinLatitude)
	const y = sinPositionAngle * sinDistance * cosLatitude
	const x = cosDistance - sinLatitude * nextSinLatitude
	return [normalizeAngle(longitude + Math.atan2(y, x)), nextLatitude] as const
}

// Interpolates along the great-circle arc between two spherical points.
export function sphericalInterpolate(longitudeA: number, latitudeA: number, longitudeB: number, latitudeB: number, fraction: number) {
	const cosLatitudeA = Math.cos(latitudeA)
	const ax = cosLatitudeA * Math.cos(longitudeA)
	const ay = cosLatitudeA * Math.sin(longitudeA)
	const az = Math.sin(latitudeA)
	const cosLatitudeB = Math.cos(latitudeB)
	const bx = cosLatitudeB * Math.cos(longitudeB)
	const by = cosLatitudeB * Math.sin(longitudeB)
	const bz = Math.sin(latitudeB)
	const dot = ax * bx + ay * by + az * bz
	const clampedDot = clamp(dot, -1, 1)
	const omega = Math.acos(clampedDot)
	const sinOmega = Math.sin(omega)

	let x: number
	let y: number
	let z: number

	if (Math.abs(sinOmega) > Number.EPSILON) {
		const a = Math.sin((1 - fraction) * omega) / sinOmega
		const b = Math.sin(fraction * omega) / sinOmega
		x = a * ax + b * bx
		y = a * ay + b * by
		z = a * az + b * bz
	} else if (clampedDot > 0) {
		x = ax
		y = ay
		z = az
	} else {
		// Chooses a deterministic orthogonal arc when the endpoints are antipodal.
		let ox: number
		let oy: number
		let oz: number
		const absX = Math.abs(ax)
		const absY = Math.abs(ay)
		const absZ = Math.abs(az)

		if (absX <= absY && absX <= absZ) {
			ox = 0
			oy = -az
			oz = ay
		} else if (absY <= absZ) {
			ox = az
			oy = 0
			oz = -ax
		} else {
			ox = -ay
			oy = ax
			oz = 0
		}

		const orthogonalLength = Math.hypot(ox, oy, oz)
		const scale = orthogonalLength === 0 ? 0 : 1 / orthogonalLength
		ox *= scale
		oy *= scale
		oz *= scale

		const angle = PI * fraction
		const cosAngle = Math.cos(angle)
		const sinAngle = Math.sin(angle)
		x = ax * cosAngle + ox * sinAngle
		y = ay * cosAngle + oy * sinAngle
		z = az * cosAngle + oz * sinAngle
	}

	const invLength = 1 / Math.hypot(x, y, z)
	x *= invLength
	y *= invLength
	z *= invLength

	return [normalizeAngle(Math.atan2(y, x)), Math.atan2(z, Math.hypot(x, y))] as const
}
