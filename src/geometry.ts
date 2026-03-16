import { normalizeAngle } from './angle'
import { PI } from './constants'
import { type Vec3, vecDot } from './vec3'

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
	const clampedDot = dot <= -1 ? -1 : dot >= 1 ? 1 : dot
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
