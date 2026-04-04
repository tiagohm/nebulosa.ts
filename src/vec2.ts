import { type Angle, normalizeAngle } from './angle'

// Mutable vector of numbers with two axis.
export type MutVec2 = [number, number]

// Vector of numbers with two axis.
export type Vec2 = Readonly<MutVec2>

// Computes the scalar product between the vectors.
export function vec2Dot(a: Vec2, b: Vec2) {
	return a[0] * b[0] + a[1] * b[1]
}

// Fills the vector with the given values.
export function vec2Fill(v: MutVec2, a: number, b: number): MutVec2 {
	v[0] = a
	v[1] = b
	return v
}

// Fills the vector with the given value.
export function vec2FillWith(v: MutVec2, value: number): MutVec2 {
	v.fill(value)
	return v
}

// Computes the 2D cross product z-component.
export function vec2Cross(a: Vec2, b: Vec2) {
	return a[0] * b[1] - a[1] * b[0]
}

// Computes the length of the vector.
export function vec2Length(v: Vec2) {
	return Math.sqrt(v[0] * v[0] + v[1] * v[1])
}

// Computes the distance between the vectors.
export function vec2Distance(a: Vec2, b: Vec2) {
	const c = a[0] - b[0]
	const d = a[1] - b[1]
	return Math.sqrt(c * c + d * d)
}

// Creates a new mutable vector from the given vector.
export function vec2Clone(v: Vec2): MutVec2 {
	return [...v]
}

// Computes the angle between the vectors.
export function vec2Angle(a: Vec2, b: Vec2): Angle {
	const alen = vec2Length(a)
	const blen = vec2Length(b)

	if (alen === 0 || blen === 0) return 0

	// Kahan's formula avoids the precision loss of acos near parallel and anti-parallel vectors.
	const ax = a[0] * blen
	const ay = a[1] * blen
	const bx = b[0] * alen
	const by = b[1] * alen
	const cx = ax - bx
	const cy = ay - by
	const dx = ax + bx
	const dy = ay + by

	return 2 * Math.atan2(Math.sqrt(cx * cx + cy * cy), Math.sqrt(dx * dx + dy * dy))
}

// Creates a new zeroed vector.
export function vec2Zero(): MutVec2 {
	return [0, 0]
}

// Creates a new x-axis vector.
export function vec2XAxis(): MutVec2 {
	return [1, 0]
}

// Creates a new y-axis vector.
export function vec2YAxis(): MutVec2 {
	return [0, 1]
}

// Computes the normalized polar angle from the positive x-axis.
export function vec2Longitude(v: Vec2): Angle {
	return normalizeAngle(Math.atan2(v[1], v[0]))
}

// Negates the vector.
export function vec2Negate(a: Vec2, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, -a[0], -a[1])
	else return [-a[0], -a[1]]
}

// Negates the vector in place.
export function vec2NegateMut(a: MutVec2): MutVec2 {
	return vec2Negate(a, a)
}

// Computes the sum of the vector by scalar.
export function vec2PlusScalar(a: Vec2, scalar: number, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] + scalar, a[1] + scalar)
	else return [a[0] + scalar, a[1] + scalar]
}

// Computes the subtraction of the vector by scalar.
export function vec2MinusScalar(a: Vec2, scalar: number, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] - scalar, a[1] - scalar)
	else return [a[0] - scalar, a[1] - scalar]
}

// Computes the multiplication of the vector by scalar.
export function vec2MulScalar(a: Vec2, scalar: number, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] * scalar, a[1] * scalar)
	else return [a[0] * scalar, a[1] * scalar]
}

// Computes the division of the vector by scalar.
export function vec2DivScalar(a: Vec2, scalar: number, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] / scalar, a[1] / scalar)
	else return [a[0] / scalar, a[1] / scalar]
}

// Computes the sum between the vectors.
export function vec2Plus(a: Vec2, b: Vec2, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] + b[0], a[1] + b[1])
	else return [a[0] + b[0], a[1] + b[1]]
}

// Computes the subtraction between the vectors.
export function vec2Minus(a: Vec2, b: Vec2, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] - b[0], a[1] - b[1])
	else return [a[0] - b[0], a[1] - b[1]]
}

// Computes the multiplication between the vectors.
export function vec2Mul(a: Vec2, b: Vec2, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] * b[0], a[1] * b[1])
	else return [a[0] * b[0], a[1] * b[1]]
}

// Computes the division between the vectors.
export function vec2Div(a: Vec2, b: Vec2, o?: MutVec2): MutVec2 {
	if (o) return vec2Fill(o, a[0] / b[0], a[1] / b[1])
	else return [a[0] / b[0], a[1] / b[1]]
}

// Normalizes the vector.
export function vec2Normalize(v: Vec2, o?: MutVec2): MutVec2 {
	const len = vec2Length(v)
	if (len === 0) return o ? vec2Fill(o, ...v) : vec2Clone(v)
	else return vec2DivScalar(v, len, o)
}

// Normalizes the vector in place.
export function vec2NormalizeMut(v: MutVec2): MutVec2 {
	return vec2Normalize(v, v)
}

// Rotates the vector around the origin.
export function vec2Rot(v: Vec2, angle: Angle, o?: MutVec2): MutVec2 {
	const ct = Math.cos(angle)
	const st = Math.sin(angle)
	if (o) return vec2Fill(o, ct * v[0] - st * v[1], st * v[0] + ct * v[1])
	else return [ct * v[0] - st * v[1], st * v[0] + ct * v[1]]
}

// Rotates the vector around the origin in place.
export function vec2RotMut(v: MutVec2, angle: Angle): MutVec2 {
	return vec2Rot(v, angle, v)
}

// Computes the division of the vector by scalar in place.
export function vec2DivScalarMut(v: MutVec2, scalar: number): MutVec2 {
	return vec2DivScalar(v, scalar, v)
}

// Computes the absolute 2D cross product value without allocating.
export function vec2CrossLength(a: Vec2, b: Vec2) {
	return Math.abs(a[0] * b[1] - a[1] * b[0])
}
