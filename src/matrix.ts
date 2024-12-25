import type { Mutable } from 'utility-types'
import type { Angle } from './angle'
import { type MutVec3, type Vec3, fill as fillVec } from './vector'

// Rectangular array of numbers with three rows and three columns.
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

// Like Mat3 but mutable.
export type MutMat3 = Mutable<Mat3>

// Creates a new zeroed matrix.
export function zero(): MutMat3 {
	return [0, 0, 0, 0, 0, 0, 0, 0, 0]
}

// Creates a new identity matrix.
export function identity(): MutMat3 {
	return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

// Fills the matrix.
export function fill(m: MutMat3, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): MutMat3 {
	m[0] = a
	m[1] = b
	m[2] = c
	m[3] = d
	m[4] = e
	m[5] = f
	m[6] = g
	m[7] = h
	m[8] = i
	return m
}

// Creates a new rotation matrix around X axis.
export function rotX(angle: Angle, m?: MutMat3): MutMat3 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)

	if (m) {
		const d = ca * m[3] + sa * m[6]
		const e = ca * m[4] + sa * m[7]
		const f = ca * m[5] + sa * m[8]
		const g = -sa * m[3] + ca * m[6]
		const h = -sa * m[4] + ca * m[7]
		const i = -sa * m[5] + ca * m[8]

		return fill(m, m[0], m[1], m[2], d, e, f, g, h, i)
	} else {
		return [1, 0, 0, 0, ca, sa, 0, -sa, ca]
	}
}

// Creates a new rotation matrix around Y axis.
export function rotY(angle: Angle, m?: MutMat3): MutMat3 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)

	if (m) {
		const a = ca * m[0] - sa * m[6]
		const b = ca * m[1] - sa * m[7]
		const c = ca * m[2] - sa * m[8]
		const g = sa * m[0] + ca * m[6]
		const h = sa * m[1] + ca * m[7]
		const i = sa * m[2] + ca * m[8]

		return fill(m, a, b, c, m[3], m[4], m[5], g, h, i)
	} else {
		return [ca, 0, -sa, 0, 1, 0, sa, 0, ca]
	}
}

// Creates a new rotation matrix around Z axis.
export function rotZ(angle: Angle, m?: MutMat3): MutMat3 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)

	if (m) {
		const a = ca * m[0] + sa * m[3]
		const b = ca * m[1] + sa * m[4]
		const c = ca * m[2] + sa * m[5]
		const d = -sa * m[0] + ca * m[3]
		const e = -sa * m[1] + ca * m[4]
		const f = -sa * m[2] + ca * m[5]

		return fill(m, a, b, c, d, e, f, m[6], m[7], m[8])
	} else {
		return [ca, sa, 0, -sa, ca, 0, 0, 0, 1]
	}
}

// Creates a new mutable Matrix from the given matrix.
export function clone(m: Mat3): MutMat3 {
	return [...m]
}

// Computes the determinant of the matrix.
export function determinant(m: Mat3) {
	// TODO: Potentially less stable than using LU decomposition
	const a = m[0] * (m[4] * m[8] - m[5] * m[7])
	const b = m[1] * (m[3] * m[8] - m[5] * m[6])
	const c = m[2] * (m[3] * m[7] - m[6] * m[4])
	return a - b + c
}

// Computes the trace of the matrix.
export function trace(m: Mat3) {
	return m[0] + m[4] + m[8]
}

// Transposes the matrix.
export function transpose(m: Mat3, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8])
	return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

// Flips the matrix around x-axis.
export function flipX(m: Mat3, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[6], m[7], m[8], m[3], m[4], m[5], m[0], m[1], m[2])
	return [m[6], m[7], m[8], m[3], m[4], m[5], m[0], m[1], m[2]]
}

// Flips the matrix around y-axis.
export function flipY(m: Mat3, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[2], m[1], m[0], m[5], m[4], m[3], m[8], m[7], m[6])
	return [m[2], m[1], m[0], m[5], m[4], m[3], m[8], m[7], m[6]]
}

// Negates the matrix.
export function negate(m: Mat3, o?: MutMat3): MutMat3 {
	if (o) return fill(o, -m[0], -m[1], -m[2], -m[3], -m[4], -m[5], -m[6], -m[7], -m[8])
	return [-m[0], -m[1], -m[2], -m[3], -m[4], -m[5], -m[6], -m[7], -m[8]]
}

// Computes the sum of the matrix by scalar.
export function plusScalar(m: Mat3, scalar: number, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[0] + scalar, m[1] + scalar, m[2] + scalar, m[3] + scalar, m[4] + scalar, m[5] + scalar, m[6] + scalar, m[7] + scalar, m[8] + scalar)
	return [m[0] + scalar, m[1] + scalar, m[2] + scalar, m[3] + scalar, m[4] + scalar, m[5] + scalar, m[6] + scalar, m[7] + scalar, m[8] + scalar]
}

// Computes the subtraction of the matrix by scalar.
export function minusScalar(m: Mat3, scalar: number, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[0] - scalar, m[1] - scalar, m[2] - scalar, m[3] - scalar, m[4] - scalar, m[5] - scalar, m[6] - scalar, m[7] - scalar, m[8] - scalar)
	return [m[0] - scalar, m[1] - scalar, m[2] - scalar, m[3] - scalar, m[4] - scalar, m[5] - scalar, m[6] - scalar, m[7] - scalar, m[8] - scalar]
}

// Computes the multiplication of the matrix by scalar.
export function mulScalar(m: Mat3, scalar: number, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[0] * scalar, m[1] * scalar, m[2] * scalar, m[3] * scalar, m[4] * scalar, m[5] * scalar, m[6] * scalar, m[7] * scalar, m[8] * scalar)
	return [m[0] * scalar, m[1] * scalar, m[2] * scalar, m[3] * scalar, m[4] * scalar, m[5] * scalar, m[6] * scalar, m[7] * scalar, m[8] * scalar]
}

// Computes the division of the matrix by scalar.
export function divScalar(m: Mat3, scalar: number, o?: MutMat3): MutMat3 {
	if (o) return fill(o, m[0] / scalar, m[1] / scalar, m[2] / scalar, m[3] / scalar, m[4] / scalar, m[5] / scalar, m[6] / scalar, m[7] / scalar, m[8] / scalar)
	return [m[0] / scalar, m[1] / scalar, m[2] / scalar, m[3] / scalar, m[4] / scalar, m[5] / scalar, m[6] / scalar, m[7] / scalar, m[8] / scalar]
}

// Computes the sum between the matrices.
export function plus(a: Mat3, b: Mat3, o?: MutMat3): MutMat3 {
	if (o) return fill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5], a[6] + b[6], a[7] + b[7], a[8] + b[8])
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5], a[6] + b[6], a[7] + b[7], a[8] + b[8]]
}

// Computes the subtraction between the matrices.
export function minus(a: Mat3, b: Mat3, o?: MutMat3): MutMat3 {
	if (o) return fill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5], a[6] - b[6], a[7] - b[7], a[8] - b[8])
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5], a[6] - b[6], a[7] - b[7], a[8] - b[8]]
}

// Computes the multiplication between the matrices.
export function mul(a: Mat3, b: Mat3, o?: MutMat3): MutMat3 {
	const c = a[0] * b[0] + a[1] * b[3] + a[2] * b[6]
	const d = a[0] * b[1] + a[1] * b[4] + a[2] * b[7]
	const e = a[0] * b[2] + a[1] * b[5] + a[2] * b[8]
	const f = a[3] * b[0] + a[4] * b[3] + a[5] * b[6]
	const g = a[3] * b[1] + a[4] * b[4] + a[5] * b[7]
	const h = a[3] * b[2] + a[4] * b[5] + a[5] * b[8]
	const i = a[6] * b[0] + a[7] * b[3] + a[8] * b[6]
	const j = a[6] * b[1] + a[7] * b[4] + a[8] * b[7]
	const k = a[6] * b[2] + a[7] * b[5] + a[8] * b[8]

	if (o) return fill(o, c, d, e, f, g, h, i, j, k)
	return [c, d, e, f, g, h, i, j, k]
}

// Computes the multiplication of the matrix by a vector.
export function mulVec(a: Mat3, b: Vec3, o?: MutVec3): MutVec3 {
	const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
	const d = a[3] * b[0] + a[4] * b[1] + a[5] * b[2]
	const e = a[6] * b[0] + a[7] * b[1] + a[8] * b[2]

	if (o) return fillVec(o, c, d, e)
	return [c, d, e]
}

// Transposes the matrix.
export function transposeMut(m: MutMat3): MutMat3 {
	return transpose(m, m)
}

// Flips the matrix around x-axis.
export function flipXMut(m: MutMat3): MutMat3 {
	return flipX(m, m)
}

// Flips the matrix around y-axis.
export function flipYMut(m: MutMat3): MutMat3 {
	return flipY(m, m)
}

// Negates the matrix.
export function negateMut(m: MutMat3): MutMat3 {
	return negate(m, m)
}

// Computes the sum of the matrix by scalar.
export function plusScalarMut(m: MutMat3, scalar: number): MutMat3 {
	return plusScalar(m, scalar, m)
}

// Computes the subtraction of the matrix by scalar.
export function minusScalarMut(m: MutMat3, scalar: number): MutMat3 {
	return minusScalar(m, scalar, m)
}

// Computes the multiplication of the matrix by scalar.
export function mulScalarMut(m: MutMat3, scalar: number): MutMat3 {
	return mulScalar(m, scalar, m)
}

// Computes the division of the matrix by scalar.
export function divScalarMut(m: MutMat3, scalar: number): MutMat3 {
	return divScalar(m, scalar, m)
}
