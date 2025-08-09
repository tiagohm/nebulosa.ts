import type { Angle } from './angle'
import { PI } from './constants'

// Mutable vector of numbers with three axis.
export type MutVec3 = [number, number, number]

// Vector of numbers with three axis.
export type Vec3 = Readonly<MutVec3>

// Computes the scalar product between the vectors.
export function vecDot(a: Vec3, b: Vec3) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// Fills the vector with the given values.
export function vecFill(v: MutVec3, a: number, b: number, c: number): MutVec3 {
	v[0] = a
	v[1] = b
	v[2] = c
	return v
}

// Fills the vector with the given value.
export function vecFillWith(v: MutVec3, value: number): MutVec3 {
	v.fill(value)
	return v
}

// Cross product between the vectors.
export function vecCross(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	const c = a[1] * b[2] - a[2] * b[1]
	const d = a[2] * b[0] - a[0] * b[2]
	const e = a[0] * b[1] - a[1] * b[0]

	if (o) return vecFill(o, c, d, e)
	else return [c, d, e]
}

// Computes the length of the vector.
export function vecLength(v: Vec3) {
	return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

// Computes the distance between the vectors.
export function vecDistance(a: Vec3, b: Vec3) {
	const c = a[0] - b[0]
	const d = a[1] - b[1]
	const e = a[2] - b[2]
	return Math.sqrt(c * c + d * d + e * e)
}

// Creates a new mutable vector from the given vector.
export function vecClone(v: Vec3): MutVec3 {
	return [...v]
}

// Computes the angle between the vectors.
export function vecAngle(a: Vec3, b: Vec3): Angle {
	// https://people.eecs.berkeley.edu/~wkahan/Mindless.pdf
	// const c = mulScalar(a, length(b))
	// const d = mulScalar(b, length(a))
	// return 2 * Math.atan2(length(minus(c, d)), length(plus(c, d)))

	const d = vecDot(a, b)
	const v = d / (vecLength(a) * vecLength(b))
	if (Math.abs(v) > 1) return v < 0 ? PI : 0
	else return Math.acos(v)
}

// Creates a new zeroed vector.
export function vecZero(): MutVec3 {
	return [0, 0, 0]
}

// Creates a new x-axis vector.
export function vecXAxis(): MutVec3 {
	return [1, 0, 0]
}

// Creates a new y-axis vector.
export function vecYAxis(): MutVec3 {
	return [0, 1, 0]
}

// Creates a new z-axis vector.
export function vecZAxis(): MutVec3 {
	return [0, 0, 1]
}

export function vecLatitude(v: Vec3) {
	return Math.acos(v[2])
}

export function vecLongitude(v: Vec3) {
	return Math.atan2(v[1], v[0])
}

// Negates the vector.
export function vecNegate(a: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, -a[0], -a[1], -a[2])
	else return [-a[0], -a[1], -a[2]]
}

// Computes the sum of the vector by scalar.
export function vecPlusScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] + scalar, a[1] + scalar, a[2] + scalar)
	else return [a[0] + scalar, a[1] + scalar, a[2] + scalar]
}

// Computes the subtraction of the vector by scalar.
export function vecMinusScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] - scalar, a[1] - scalar, a[2] - scalar)
	else return [a[0] - scalar, a[1] - scalar, a[2] - scalar]
}

// Computes the multiplication of the vector by scalar.
export function vecMulScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] * scalar, a[1] * scalar, a[2] * scalar)
	else return [a[0] * scalar, a[1] * scalar, a[2] * scalar]
}

// Computes the division of the vector by scalar.
export function vecDivScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] / scalar, a[1] / scalar, a[2] / scalar)
	else return [a[0] / scalar, a[1] / scalar, a[2] / scalar]
}

// Computes the sum between the vectors.
export function vecPlus(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2])
	else return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

// Computes the subtraction between the vectors.
export function vecMinus(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2])
	else return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

// Computes the multiplication between the vectors.
export function vecMul(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] * b[0], a[1] * b[1], a[2] * b[2])
	else return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

// Computes the division between the vectors.
export function vecDiv(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return vecFill(o, a[0] / b[0], a[1] / b[1], a[2] / b[2])
	else return [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
}

// Normalizes the vector.
export function vecNormalize(v: Vec3, o?: MutVec3): MutVec3 {
	const len = vecLength(v)
	if (len === 0) return o ? vecFill(o, ...v) : vecClone(v)
	else return vecDivScalar(v, len, o)
}

// Efficient algorithm for rotating a vector in space, given an axis and angle of rotation.
export function vecRotateByRodrigues(v: Vec3, axis: Vec3, angle: Angle, o?: MutVec3): Vec3 {
	const cosa = Math.cos(angle)
	const b: MutVec3 = [0, 0, 0]
	const c: MutVec3 = [0, 0, 0]
	const k = vecNormalize(axis, o)
	vecMulScalar(vecCross(k, v, b), Math.sin(angle), b)
	vecMulScalar(k, vecDot(k, v), c)
	vecPlus(vecMulScalar(v, cosa, k), b, b)
	return vecPlus(b, vecMulScalar(c, 1 - cosa, c), o)
}

export function vecPlane(a: Vec3, b: Vec3, c: Vec3, o?: MutVec3): MutVec3 {
	const d = vecMinus(b, a, o)
	const e = vecMinus(c, b)
	return vecCross(d, e, o)
}
