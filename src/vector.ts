import type { Mutable } from 'utility-types'
import type { Angle } from './angle'
import { PI } from './constants'

// Vector of numbers with three axis.
export type Vec3 = readonly [number, number, number]

// Like Vec3 but mutable.
export type MutVec3 = Mutable<Vec3>

// Scalar product between the vectors a and b.
export function dot(a: Vec3, b: Vec3) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// Fills the vector.
export function fill(v: MutVec3, a: number, b: number, c: number): MutVec3 {
	v[0] = a
	v[1] = b
	v[2] = c
	return v
}

// Cross product between the vectors a and b.
export function cross(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	const c = a[1] * b[2] - a[2] * b[1]
	const d = a[2] * b[0] - a[0] * b[2]
	const e = a[0] * b[1] - a[1] * b[0]

	if (o) return fill(o, c, d, e)
	else return [c, d, e]
}

export function length(v: Vec3) {
	return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

export function distance(a: Vec3, b: Vec3) {
	const c = a[0] - b[0]
	const d = a[1] - b[1]
	const e = a[2] - b[2]
	return Math.sqrt(c * c + d * d + e * e)
}

// Creates a new mutable vector from the given vector.
export function clone(v: Vec3): MutVec3 {
	return [...v]
}

// Computes the angle between the vectors a and b.
export function angle(a: Vec3, b: Vec3): Angle {
	// https://people.eecs.berkeley.edu/~wkahan/Mindless.pdf
	// const c = mulScalar(a, length(b))
	// const d = mulScalar(b, length(a))
	// return 2 * Math.atan2(length(minus(c, d)), length(plus(c, d)))

	const d = dot(a, b)
	const v = d / (length(a) * length(b))
	if (Math.abs(v) > 1.0)
		if (v < 0.0) return PI
		else return 0
	else return Math.acos(v)
}

// Creates a new empty vector.
export function zero(): MutVec3 {
	return [0, 0, 0]
}

export function xAxis(): MutVec3 {
	return [1, 0, 0]
}

export function yAxis(): MutVec3 {
	return [0, 1, 0]
}

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
export function negate(a: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fill(o, -a[0], -a[1], -a[2])
	else return [-a[0], -a[1], -a[2]]
}

export function plusScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] + scalar, a[1] + scalar, a[2] + scalar)
	else return [a[0] + scalar, a[1] + scalar, a[2] + scalar]
}

export function minusScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] - scalar, a[1] - scalar, a[2] - scalar)
	else return [a[0] - scalar, a[1] - scalar, a[2] - scalar]
}

export function mulScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] * scalar, a[1] * scalar, a[2] * scalar)
	else return [a[0] * scalar, a[1] * scalar, a[2] * scalar]
}

export function divScalar(a: Vec3, scalar: number, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] / scalar, a[1] / scalar, a[2] / scalar)
	else return [a[0] / scalar, a[1] / scalar, a[2] / scalar]
}

export function plus(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2])
	else return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function minus(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2])
	else return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function mul(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] * b[0], a[1] * b[1], a[2] * b[2])
	else return [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

export function div(a: Vec3, b: Vec3, o?: MutVec3): MutVec3 {
	if (o) return fill(o, a[0] / b[0], a[1] / b[1], a[2] / b[2])
	else return [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
}

// Normalizes the vector.
export function normalize(v: Vec3, o?: MutVec3): MutVec3 {
	const len = length(v)

	if (len === 0)
		if (o) return fill(o, ...v)
		else return clone(v)
	else return divScalar(v, len, o)
}

// Efficient algorithm for rotating a vector in space, given an axis and angle of rotation.
export function rotateByRodrigues(v: Vec3, axis: Vec3, angle: Angle, o?: MutVec3): Vec3 {
	const cosa = Math.cos(angle)
	const b: MutVec3 = [0, 0, 0]
	const c: MutVec3 = [0, 0, 0]
	const k = normalize(axis, o)
	mulScalar(cross(k, v, b), Math.sin(angle), b)
	mulScalar(k, dot(k, v), c)
	plus(mulScalar(v, cosa, k), b, b)
	return plus(b, mulScalar(c, 1.0 - cosa, c), o)
}

export function plane(a: Vec3, b: Vec3, c: Vec3, o?: MutVec3): MutVec3 {
	const d = minus(b, a, o)
	const e = minus(c, b)
	return cross(d, e, o)
}
