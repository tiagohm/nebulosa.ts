import type { Mutable } from 'utility-types'
import type { Angle } from './angle'
import { PI } from './constants'

// Vector of numbers with three axis.
export type Vec3 = readonly [number, number, number]

// Like Vec3 but mutable.
export type MutVec3 = Mutable<Vec3>

// Computes the scalar product between the vectors.
export function dot(a: Vec3, b: Vec3) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// Fills the vector.
export function fillVec(v: MutVec3, a: number, b: number, c: number): MutVec3 {
	v[0] = a
	v[1] = b
	v[2] = c
	return v
}

// Cross product between the vectors.
export function cross(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	const c = a[1] * b[2] - a[2] * b[1]
	const d = a[2] * b[0] - a[0] * b[2]
	const e = a[0] * b[1] - a[1] * b[0]

	if (o) return fillVec(o, c, d, e)
	else return [c, d, e]
}

// Computes the length of the vector.
export function length(v: Vec3) {
	return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

// Computes the distance between the vectors.
export function distanceBetween(a: Vec3, b: Vec3) {
	const c = a[0] - b[0]
	const d = a[1] - b[1]
	const e = a[2] - b[2]
	return Math.sqrt(c * c + d * d + e * e)
}

// Creates a new mutable vector from the given vector.
export function cloneVec(v: Vec3): MutVec3 {
	return [...v]
}

// Computes the angle between the vectors.
export function angle(a: Vec3, b: Vec3): Angle {
	// https://people.eecs.berkeley.edu/~wkahan/Mindless.pdf
	// const c = mulScalar(a, length(b))
	// const d = mulScalar(b, length(a))
	// return 2 * Math.atan2(length(minus(c, d)), length(plus(c, d)))

	const d = dot(a, b)
	const v = d / (length(a) * length(b))
	if (Math.abs(v) > 1)
		if (v < 0) return PI
		else return 0
	else return Math.acos(v)
}

// Creates a new zeroed vector.
export function zeroVec(): MutVec3 {
	return [0, 0, 0]
}

// Creates a new x-axis vector.
export function xAxis(): MutVec3 {
	return [1, 0, 0]
}

// Creates a new y-axis vector.
export function yAxis(): MutVec3 {
	return [0, 1, 0]
}

// Creates a new z-axis vector.
export function zAxis(): MutVec3 {
	return [0, 0, 1]
}

export function latitude(v: Vec3) {
	return Math.acos(v[2])
}

export function longitude(v: Vec3) {
	return Math.atan2(v[1], v[0])
}

// Negates the vector.
export function negateVec(a: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, -a[0], -a[1], -a[2])
	else return [-a[0], -a[1], -a[2]]
}

// Computes the sum of the vector by scalar.
export function plusVecScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] + scalar, a[1] + scalar, a[2] + scalar)
	else return [a[0] + scalar, a[1] + scalar, a[2] + scalar]
}

// Computes the subtraction of the vector by scalar.
export function minusVecScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] - scalar, a[1] - scalar, a[2] - scalar)
	else return [a[0] - scalar, a[1] - scalar, a[2] - scalar]
}

// Computes the multiplication of the vector by scalar.
export function mulVecScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] * scalar, a[1] * scalar, a[2] * scalar)
	else return [a[0] * scalar, a[1] * scalar, a[2] * scalar]
}

// Computes the division of the vector by scalar.
export function divVecScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] / scalar, a[1] / scalar, a[2] / scalar)
	else return [a[0] / scalar, a[1] / scalar, a[2] / scalar]
}

// Computes the sum between the vectors.
export function plusVec(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] + b[0], a[1] + b[1], a[2] + b[2])
	else return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

// Computes the subtraction between the vectors.
export function minusVec(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] - b[0], a[1] - b[1], a[2] - b[2])
	else return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

// Computes the multiplication between the vectors.
export function mulVec(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] * b[0], a[1] * b[1], a[2] * b[2])
	else return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

// Computes the division between the vectors.
export function divVec(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fillVec(o, a[0] / b[0], a[1] / b[1], a[2] / b[2])
	else return [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
}

// Normalizes the vector.
export function normalizeVec(v: Vec3, o?: MutVec3): MutVec3 {
	const len = length(v)

	if (len === 0)
		if (o) return fillVec(o, ...v)
		else return cloneVec(v)
	else return divVecScalar(v, len, o)
}

// Normalizes the vector.
export function normalizeMutVec(v: MutVec3): MutVec3 {
	return normalizeVec(v, v)
}

// Efficient algorithm for rotating a vector in space, given an axis and angle of rotation.
export function rotateByRodrigues(v: Vec3, axis: Vec3, angle: Angle, o?: MutVec3): Vec3 {
	const cosa = Math.cos(angle)
	const b = zeroVec()
	const c = zeroVec()
	const k = normalizeVec(axis, o)
	mulVecScalar(cross(k, v, b), Math.sin(angle), b)
	mulVecScalar(k, dot(k, v), c)
	plusVec(mulVecScalar(v, cosa, k), b, b)
	return plusVec(b, mulVecScalar(c, 1 - cosa, c), o)
}

export function plane(a: Vec3, b: Vec3, c: Vec3, o?: MutVec3): MutVec3 {
	const d = minusVec(b, a, o)
	const e = minusVec(c, b)
	return cross(d, e, o)
}
