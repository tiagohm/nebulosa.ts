import type { Angle } from './angle'

// Rectangular array of numbers with three rows and three columns.
export class Mat3 extends Float64Array {
	constructor(a: number = 0, b: number = 0, c: number = 0, d: number = 0, e: number = 0, f: number = 0, g: number = 0, h: number = 0, i: number = 0) {
		super(9)

		this[0] = a
		this[1] = b
		this[2] = c
		this[3] = d
		this[4] = e
		this[5] = f
		this[6] = g
		this[7] = h
		this[8] = i
	}

	// Clones this matrix.
	clone() {
		const matrix = new Mat3()
		matrix.set(this)
		return matrix
	}

	// Rotates this matrix around X axis.
	rotX(angle: Angle): this {
		const ca = Math.cos(angle)
		const sa = Math.sin(angle)

		const m3 = ca * this[3] + sa * this[6]
		const m4 = ca * this[4] + sa * this[7]
		const m5 = ca * this[5] + sa * this[8]
		const m6 = -sa * this[3] + ca * this[6]
		const m7 = -sa * this[4] + ca * this[7]
		const m8 = -sa * this[5] + ca * this[8]

		this[3] = m3
		this[4] = m4
		this[5] = m5
		this[6] = m6
		this[7] = m7
		this[8] = m8

		return this
	}

	// Rotates this matrix around Y axis.
	rotY(angle: Angle): this {
		const ca = Math.cos(angle)
		const sa = Math.sin(angle)

		const m0 = ca * this[0] - sa * this[6]
		const m1 = ca * this[1] - sa * this[7]
		const m2 = ca * this[2] - sa * this[8]
		const m6 = sa * this[0] + ca * this[6]
		const m7 = sa * this[1] + ca * this[7]
		const m8 = sa * this[2] + ca * this[8]

		this[0] = m0
		this[1] = m1
		this[2] = m2
		this[6] = m6
		this[7] = m7
		this[8] = m8

		return this
	}

	// Rotates this matrix around Z axis.
	rotZ(angle: Angle): this {
		const ca = Math.cos(angle)
		const sa = Math.sin(angle)

		const m0 = ca * this[0] + sa * this[3]
		const m1 = ca * this[1] + sa * this[4]
		const m2 = ca * this[2] + sa * this[5]
		const m3 = -sa * this[0] + ca * this[3]
		const m4 = -sa * this[1] + ca * this[4]
		const m5 = -sa * this[2] + ca * this[5]

		this[0] = m0
		this[1] = m1
		this[2] = m2
		this[3] = m3
		this[4] = m4
		this[5] = m5

		return this
	}
}

// Creates a new Identity Matrix.
export function identity() {
	return new Mat3(1, 0, 0, 0, 1, 0, 0, 0, 1)
}

// Creates a new rotation matrix around X axis.
export function rotX(angle: Angle): Mat3 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)
	return new Mat3(1, 0, 0, 0, ca, sa, 0, -sa, ca)
}

// Creates a new rotation matrix around Y axis.
export function rotY(angle: Angle): Mat3 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)
	return new Mat3(ca, 0, -sa, 0, 1, 0, sa, 0, ca)
}

// Creates a new rotation matrix around Z axis.
export function rotZ(angle: Angle): Mat3 {
	const ca = Math.cos(angle)
	const sa = Math.sin(angle)
	return new Mat3(ca, sa, 0, -sa, ca, 0, 0, 0, 1)
}
