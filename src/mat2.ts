import type { Angle } from './angle'
import { type MutVec2, type Vec2, vec2Fill } from './vec2'

// Mutable rectangular array of numbers with two rows and two columns.
export type MutMat2 = [number, number, number, number]

// Rectangular array of numbers with two rows and two columns.
export type Mat2 = Readonly<MutMat2>

// Creates or fills a matrix with zeroes.
export function mat2Zero(o?: MutMat2): MutMat2 {
	if (o) return o.fill(0)
	else return [0, 0, 0, 0]
}

// Creates or fills an identity matrix.
export function mat2Identity(o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, 1, 0, 0, 1)
	else return [1, 0, 0, 1]
}

// Fills the matrix.
export function mat2Fill(m: MutMat2, a: number, b: number, c: number, d: number) {
	m[0] = a
	m[1] = b
	m[2] = c
	m[3] = d
	return m
}

// Creates a new rotation matrix.
export function mat2Rot(angle: Angle, m?: MutMat2): MutMat2 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)

	if (m) {
		const a = ca * m[0] + sa * m[2]
		const b = ca * m[1] + sa * m[3]
		const c = -sa * m[0] + ca * m[2]
		const d = -sa * m[1] + ca * m[3]

		return mat2Fill(m, a, b, c, d)
	} else {
		return [ca, sa, -sa, ca]
	}
}

// Creates a new mutable Matrix from the given matrix.
export function mat2Clone(m: Mat2): MutMat2 {
	return [...m]
}

// Copies the matrix into another matrix.
export function mat2Copy(m: Mat2, o: MutMat2): MutMat2 {
	if (m !== o) for (let i = 0; i < 4; i++) o[i] = m[i]
	return o
}

// Computes the determinant of the matrix.
export function mat2Determinant(m: Mat2) {
	return m[0] * m[3] - m[1] * m[2]
}

// Computes the trace of the matrix.
export function mat2Trace(m: Mat2) {
	return m[0] + m[3]
}

// Transposes the matrix.
export function mat2Transpose(m: Mat2, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[0], m[2], m[1], m[3])
	return [m[0], m[2], m[1], m[3]]
}

// Flips the matrix around x-axis.
export function mat2FlipX(m: Mat2, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[2], m[3], m[0], m[1])
	return [m[2], m[3], m[0], m[1]]
}

// Flips the matrix around y-axis.
export function mat2FlipY(m: Mat2, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[1], m[0], m[3], m[2])
	return [m[1], m[0], m[3], m[2]]
}

// Negates the matrix.
export function mat2Negate(m: Mat2, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, -m[0], -m[1], -m[2], -m[3])
	return [-m[0], -m[1], -m[2], -m[3]]
}

// Computes the sum of the matrix by scalar.
export function mat2PlusScalar(m: Mat2, scalar: number, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[0] + scalar, m[1] + scalar, m[2] + scalar, m[3] + scalar)
	return [m[0] + scalar, m[1] + scalar, m[2] + scalar, m[3] + scalar]
}

// Computes the subtraction of the matrix by scalar.
export function mat2MinusScalar(m: Mat2, scalar: number, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[0] - scalar, m[1] - scalar, m[2] - scalar, m[3] - scalar)
	return [m[0] - scalar, m[1] - scalar, m[2] - scalar, m[3] - scalar]
}

// Multiplies the matrix by scalar.
export function mat2MulScalar(m: Mat2, scalar: number, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[0] * scalar, m[1] * scalar, m[2] * scalar, m[3] * scalar)
	return [m[0] * scalar, m[1] * scalar, m[2] * scalar, m[3] * scalar]
}

// Computes the division of the matrix by scalar.
export function mat2DivScalar(m: Mat2, scalar: number, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, m[0] / scalar, m[1] / scalar, m[2] / scalar, m[3] / scalar)
	return [m[0] / scalar, m[1] / scalar, m[2] / scalar, m[3] / scalar]
}

// Computes the sum between the matrices.
export function mat2Plus(a: Mat2, b: Mat2, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3])
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

// Computes the subtraction between the matrices.
export function mat2Minus(a: Mat2, b: Mat2, o?: MutMat2): MutMat2 {
	if (o) return mat2Fill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3])
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]]
}

// Multiplies two matrices.
export function mat2Mul(a: Mat2, b: Mat2, o?: MutMat2): MutMat2 {
	const c = a[0] * b[0] + a[1] * b[2]
	const d = a[0] * b[1] + a[1] * b[3]
	const e = a[2] * b[0] + a[3] * b[2]
	const f = a[2] * b[1] + a[3] * b[3]

	if (o) return mat2Fill(o, c, d, e, f)
	return [c, d, e, f]
}

// Multiplies the transpose of the matrix to other matrix.
export function mat2TransposeMul(a: Mat2, b: Mat2, o?: MutMat2): MutMat2 {
	const c = a[0] * b[0] + a[2] * b[2]
	const d = a[0] * b[1] + a[2] * b[3]
	const e = a[1] * b[0] + a[3] * b[2]
	const f = a[1] * b[1] + a[3] * b[3]

	if (o) return mat2Fill(o, c, d, e, f)
	return [c, d, e, f]
}

// Multiplies a matrix to the transpose of other matrix.
export function mat2MulTranspose(a: Mat2, b: Mat2, o?: MutMat2): MutMat2 {
	const c = a[0] * b[0] + a[1] * b[1]
	const d = a[0] * b[2] + a[1] * b[3]
	const e = a[2] * b[0] + a[3] * b[1]
	const f = a[2] * b[2] + a[3] * b[3]

	if (o) return mat2Fill(o, c, d, e, f)
	return [c, d, e, f]
}

// Multiplies the transpose of two matrices.
export function mat2TransposeMulTranspose(a: Mat2, b: Mat2, o?: MutMat2): MutMat2 {
	const c = a[0] * b[0] + a[2] * b[1]
	const d = a[0] * b[2] + a[2] * b[3]
	const e = a[1] * b[0] + a[3] * b[1]
	const f = a[1] * b[2] + a[3] * b[3]

	if (o) return mat2Fill(o, c, d, e, f)
	return [c, d, e, f]
}

// Multiplies the matrix by a vector.
export function mat2MulVec(a: Mat2, b: Vec2, o?: MutVec2): MutVec2 {
	const c = a[0] * b[0] + a[1] * b[1]
	const d = a[2] * b[0] + a[3] * b[1]

	if (o) return vec2Fill(o, c, d)
	return [c, d]
}

// Multiplies the transpose of the matrix by a vector.
export function mat2TransposeMulVec(a: Mat2, b: Vec2, o?: MutVec2): MutVec2 {
	const c = a[0] * b[0] + a[2] * b[1]
	const d = a[1] * b[0] + a[3] * b[1]

	if (o) return vec2Fill(o, c, d)
	return [c, d]
}
