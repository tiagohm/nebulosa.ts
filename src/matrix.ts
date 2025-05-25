import type { Angle } from './angle'
import { Vector3 } from './vector'

export namespace Mat3 {
	// Rectangular array of numbers with three rows and three columns.
	export type Matrix = [number, number, number, number, number, number, number, number, number]

	// Creates or fills a matrix with zeroes.
	export function zero(o?: Matrix): Matrix {
		if (o) return fillWith(o, 0)
		else return [0, 0, 0, 0, 0, 0, 0, 0, 0]
	}

	// Creates or fills an identity matrix.
	export function identity(o?: Matrix): Matrix {
		if (o) return fill(o, 1, 0, 0, 0, 1, 0, 0, 0, 1)
		else return [1, 0, 0, 0, 1, 0, 0, 0, 1]
	}

	// Fills the matrix.
	export function fill(m: Matrix, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): Matrix {
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

	// Fills the matrix with a value.
	export function fillWith(m: Matrix, v: number): Matrix {
		m.fill(v)
		return m
	}

	// Creates a new rotation matrix around X axis.
	export function rotX(angle: Angle, m?: Matrix): Matrix {
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
	export function rotY(angle: Angle, m?: Matrix): Matrix {
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
	export function rotZ(angle: Angle, m?: Matrix): Matrix {
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
	export function clone(m: Readonly<Matrix>): Matrix {
		return [...m]
	}

	// Copies the matrix into another matrix.
	export function copy(m: Readonly<Matrix>, o: Matrix): Matrix {
		if (m !== o) for (let i = 0; i < 9; i++) o[i] = m[i]
		return o
	}

	// Computes the determinant of the matrix.
	export function determinant(m: Readonly<Matrix>) {
		// TODO: Potentially less stable than using LU decomposition
		const a = m[0] * (m[4] * m[8] - m[5] * m[7])
		const b = m[1] * (m[3] * m[8] - m[5] * m[6])
		const c = m[2] * (m[3] * m[7] - m[6] * m[4])
		return a - b + c
	}

	// Computes the trace of the matrix.
	export function trace(m: Readonly<Matrix>) {
		return m[0] + m[4] + m[8]
	}

	// Transposes the matrix.
	export function transpose(m: Readonly<Matrix>, o?: Matrix): Matrix {
		if (o) return fill(o, m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8])
		return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
	}

	// Flips the matrix around x-axis.
	export function flipX(m: Readonly<Matrix>, o?: Matrix): Matrix {
		if (o) return fill(o, m[6], m[7], m[8], m[3], m[4], m[5], m[0], m[1], m[2])
		return [m[6], m[7], m[8], m[3], m[4], m[5], m[0], m[1], m[2]]
	}

	// Flips the matrix around y-axis.
	export function flipY(m: Readonly<Matrix>, o?: Matrix): Matrix {
		if (o) return fill(o, m[2], m[1], m[0], m[5], m[4], m[3], m[8], m[7], m[6])
		return [m[2], m[1], m[0], m[5], m[4], m[3], m[8], m[7], m[6]]
	}

	// Negates the matrix.
	export function negate(m: Readonly<Matrix>, o?: Matrix): Matrix {
		if (o) return fill(o, -m[0], -m[1], -m[2], -m[3], -m[4], -m[5], -m[6], -m[7], -m[8])
		return [-m[0], -m[1], -m[2], -m[3], -m[4], -m[5], -m[6], -m[7], -m[8]]
	}

	// Computes the sum of the matrix by scalar.
	export function plusScalar(m: Readonly<Matrix>, scalar: number, o?: Matrix): Matrix {
		if (o) return fill(o, m[0] + scalar, m[1] + scalar, m[2] + scalar, m[3] + scalar, m[4] + scalar, m[5] + scalar, m[6] + scalar, m[7] + scalar, m[8] + scalar)
		return [m[0] + scalar, m[1] + scalar, m[2] + scalar, m[3] + scalar, m[4] + scalar, m[5] + scalar, m[6] + scalar, m[7] + scalar, m[8] + scalar]
	}

	// Computes the subtraction of the matrix by scalar.
	export function minusScalar(m: Readonly<Matrix>, scalar: number, o?: Matrix): Matrix {
		if (o) return fill(o, m[0] - scalar, m[1] - scalar, m[2] - scalar, m[3] - scalar, m[4] - scalar, m[5] - scalar, m[6] - scalar, m[7] - scalar, m[8] - scalar)
		return [m[0] - scalar, m[1] - scalar, m[2] - scalar, m[3] - scalar, m[4] - scalar, m[5] - scalar, m[6] - scalar, m[7] - scalar, m[8] - scalar]
	}

	// Multiplies the matrix by scalar.
	export function mulScalar(m: Readonly<Matrix>, scalar: number, o?: Matrix): Matrix {
		if (o) return fill(o, m[0] * scalar, m[1] * scalar, m[2] * scalar, m[3] * scalar, m[4] * scalar, m[5] * scalar, m[6] * scalar, m[7] * scalar, m[8] * scalar)
		return [m[0] * scalar, m[1] * scalar, m[2] * scalar, m[3] * scalar, m[4] * scalar, m[5] * scalar, m[6] * scalar, m[7] * scalar, m[8] * scalar]
	}

	// Computes the division of the matrix by scalar.
	export function divScalar(m: Readonly<Matrix>, scalar: number, o?: Matrix): Matrix {
		if (o) return fill(o, m[0] / scalar, m[1] / scalar, m[2] / scalar, m[3] / scalar, m[4] / scalar, m[5] / scalar, m[6] / scalar, m[7] / scalar, m[8] / scalar)
		return [m[0] / scalar, m[1] / scalar, m[2] / scalar, m[3] / scalar, m[4] / scalar, m[5] / scalar, m[6] / scalar, m[7] / scalar, m[8] / scalar]
	}

	// Computes the sum between the matrices.
	export function plus(a: Readonly<Matrix>, b: Readonly<Matrix>, o?: Matrix): Matrix {
		if (o) return fill(o, a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5], a[6] + b[6], a[7] + b[7], a[8] + b[8])
		return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5], a[6] + b[6], a[7] + b[7], a[8] + b[8]]
	}

	// Computes the subtraction between the matrices.
	export function minus(a: Readonly<Matrix>, b: Readonly<Matrix>, o?: Matrix): Matrix {
		if (o) return fill(o, a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5], a[6] - b[6], a[7] - b[7], a[8] - b[8])
		return [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3], a[4] - b[4], a[5] - b[5], a[6] - b[6], a[7] - b[7], a[8] - b[8]]
	}

	// Multiplies two matrices.
	export function mul(a: Readonly<Matrix>, b: Readonly<Matrix>, o?: Matrix): Matrix {
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

	// Multiplies the matrix by a vector.
	export function mulVec3(a: Readonly<Matrix>, b: Readonly<Vector3.Vector>, o?: Vector3.Vector): Vector3.Vector {
		const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
		const d = a[3] * b[0] + a[4] * b[1] + a[5] * b[2]
		const e = a[6] * b[0] + a[7] * b[1] + a[8] * b[2]

		if (o) return Vector3.fill(o, c, d, e)
		return [c, d, e]
	}

	// Multiplies the transposed matrix by a vector.
	export function mulTransposeVec3(a: Readonly<Matrix>, b: Readonly<Vector3.Vector>, o?: Vector3.Vector): Vector3.Vector {
		const c = a[0] * b[0] + a[3] * b[1] + a[6] * b[2]
		const d = a[1] * b[0] + a[4] * b[1] + a[7] * b[2]
		const e = a[2] * b[0] + a[5] * b[1] + a[8] * b[2]

		if (o) return Vector3.fill(o, c, d, e)
		return [c, d, e]
	}
}
