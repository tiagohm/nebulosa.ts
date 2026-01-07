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
