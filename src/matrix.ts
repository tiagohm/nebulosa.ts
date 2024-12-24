import type { Mutable } from 'utility-types'
import type { Angle } from './angle'

// Rectangular array of numbers with three rows and three columns.
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

// Like Mat3 but mutable.
export type MutMat3 = Mutable<Mat3>

// Creates a new empty Matrix.
export function zero(): MutMat3 {
	return [0, 0, 0, 0, 0, 0, 0, 0, 0]
}

// Creates a new Identity Matrix.
export function identity(): MutMat3 {
	return [1, 0, 0, 0, 1, 0, 0, 0, 1]
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

		m[3] = d
		m[4] = e
		m[5] = f
		m[6] = g
		m[7] = h
		m[8] = i

		return m
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

		m[0] = a
		m[1] = b
		m[2] = c
		m[6] = g
		m[7] = h
		m[8] = i

		return m
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

		m[0] = a
		m[1] = b
		m[2] = c
		m[3] = d
		m[4] = e
		m[5] = f

		return m
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

export function trace(m: Mat3) {
	return m[0] + m[4] + m[8]
}

export function transpose(m: Mat3): MutMat3 {
	return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

export function flipX(m: Mat3): MutMat3 {
	return [m[6], m[7], m[8], m[3], m[4], m[5], m[0], m[1], m[2]]
}

export function flipY(m: Mat3): MutMat3 {
	return [m[2], m[1], m[0], m[5], m[4], m[3], m[8], m[7], m[6]]
}

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

export function transposeMut(m: MutMat3): MutMat3 {
	const [a, b, c, d, e, f, g, h, i] = m
	return fill(m, a, d, g, b, e, h, c, f, i)
}

export function flipXMut(m: MutMat3): MutMat3 {
	const [a, b, c, d, e, f, g, h, i] = m
	return fill(m, g, h, i, d, e, f, a, b, c)
}

export function flipYMut(m: MutMat3): MutMat3 {
	const [a, b, c, d, e, f, g, h, i] = m
	return fill(m, c, b, a, f, e, d, i, h, g)
}
