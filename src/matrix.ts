import type { Angle } from './angle'
import type { NumberArray } from './math'
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
	// Potentially less stable than using LU decomposition.
	export function determinant(m: Readonly<Matrix>) {
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
	export function mulVec(a: Readonly<Matrix>, b: Readonly<Vector3.Vector>, o?: Vector3.Vector): Vector3.Vector {
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

// https://en.wikipedia.org/wiki/LU_decomposition
export class LuDecomposition {
	private readonly A: Array<Float64Array>
	private readonly P: Int32Array

	constructor(matrix: Readonly<NumberArray>) {
		if (matrix.length === 0) throw new Error('Matrix is not square')

		const n = Math.trunc(Math.sqrt(matrix.length))

		if (n <= 1 || n * n !== matrix.length) throw new Error('Matrix is not square')

		const A = new Array<Float64Array>(n)

		for (let i = 0, p = 0; i < n; i++) {
			A[i] = new Float64Array(n)

			for (let k = 0; k < n; k++) {
				A[i][k] = matrix[p++]
			}
		}

		// Unit permutation matrix
		const P = new Int32Array(n + 1)
		for (let i = 0; i <= n; i++) P[i] = i

		for (let i = 0; i < n; i++) {
			let maxA = 0
			let maxI = i

			for (let k = i; k < n; k++) {
				const a = Math.abs(matrix[k * n + i])

				if (a > maxA) {
					maxA = a
					maxI = k
				}
			}

			// if (maxA < Tol) throw new Error('Matrix is degenerate')

			if (maxI !== i) {
				// Pivoting
				const j = P[i]
				P[i] = P[maxI]
				P[maxI] = j

				// Pivoting rows of A
				const p = A[i]
				A[i] = A[maxI]
				A[maxI] = p

				// Counting pivots starting from N (for determinant)
				P[n]++
			}

			for (let j = i + 1; j < n; j++) {
				A[j][i] /= A[i][i]

				for (let k = i + 1; k < n; k++) {
					A[j][k] -= A[j][i] * A[i][k]
				}
			}
		}

		this.A = A
		this.P = P
	}

	get singular() {
		const n = this.A.length

		for (let j = 0; j < n; j++) {
			if (this.A[j][j] === 0) {
				return true
			}
		}

		return false
	}

	get determinant() {
		const n = this.A.length
		let det = this.A[0][0]
		for (let i = 1; i < n; i++) det *= this.A[i][i]
		return (this.P[n] - n) % 2 === 0 ? det : -det
	}

	invert() {
		const n = this.A.length

		const I = new Array<Float64Array>(n)
		for (let i = 0; i < n; i++) I[i] = new Float64Array(n)

		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				I[i][j] = this.P[i] === j ? 1 : 0

				for (let k = 0; k < i; k++) {
					I[i][j] -= this.A[i][k] * I[k][j]
				}
			}

			for (let i = n - 1; i >= 0; i--) {
				for (let k = i + 1; k < n; k++) {
					I[i][j] -= this.A[i][k] * I[k][j]
				}

				I[i][j] /= this.A[i][i]
			}
		}

		return I
	}

	// Solves A*x=B
	solve(B: Readonly<NumberArray>) {
		const n = this.A.length
		const x = new Float64Array(n)

		for (let i = 0; i < n; i++) {
			x[i] = B[this.P[i]]

			for (let k = 0; k < i; k++) {
				x[i] -= this.A[i][k] * x[k]
			}
		}

		for (let i = n - 1; i >= 0; i--) {
			for (let k = i + 1; k < n; k++) {
				x[i] -= this.A[i][k] * x[k]
			}

			x[i] /= this.A[i][i]
		}

		return x
	}
}

// https://github.com/mljs/matrix/blob/main/src/dc/qr.js
export class QrDecomposition {
	private readonly QR: Float64Array[]
	private readonly rdiag: Float64Array

	constructor(
		matrix: Readonly<NumberArray>,
		private readonly rows: number,
		private readonly cols: number,
	) {
		const QR = new Array<Float64Array>(rows)
		const rdiag = new Float64Array(cols)

		for (let i = 0, p = 0; i < rows; i++) {
			QR[i] = new Float64Array(cols)

			for (let k = 0; k < cols; k++) {
				QR[i][k] = matrix[p++]
			}
		}

		for (let k = 0; k < cols; k++) {
			let nrm = 0

			for (let i = k; i < rows; i++) {
				nrm = hypotenuse(nrm, QR[i][k])
			}

			if (nrm !== 0) {
				if (QR[k][k] < 0) {
					nrm = -nrm
				}

				for (let i = k; i < rows; i++) {
					QR[i][k] /= nrm
				}

				QR[k][k]++

				for (let j = k + 1; j < cols; j++) {
					let s = 0

					for (let i = k; i < rows; i++) {
						s += QR[i][k] * QR[i][j]
					}

					s = -s / QR[k][k]

					for (let i = k; i < rows; i++) {
						QR[i][j] += s * QR[i][k]
					}
				}
			}

			rdiag[k] = -nrm
		}

		this.QR = QR
		this.rdiag = rdiag
	}

	get fullRank() {
		return this.rdiag.indexOf(0) < 0
	}

	solve(value: Readonly<NumberArray>) {
		if (value.length !== this.QR.length) {
			throw new Error('Matrix row dimensions must agree')
		}

		if (!this.fullRank) {
			throw new Error('Matrix is rank deficient')
		}

		const X = new Float64Array(value)

		for (let k = 0; k < this.cols; k++) {
			let s = 0

			for (let i = k; i < this.rows; i++) {
				s += this.QR[i][k] * X[i]
			}

			s = -s / this.QR[k][k]

			for (let i = k; i < this.rows; i++) {
				X[i] += s * this.QR[i][k]
			}
		}

		for (let k = this.cols - 1; k >= 0; k--) {
			X[k] /= this.rdiag[k]

			for (let i = 0; i < k; i++) {
				X[i] -= X[k] * this.QR[i][k]
			}
		}

		return X
	}
}

function hypotenuse(a: number, b: number) {
	const aa = Math.abs(a)
	const ab = Math.abs(b)

	if (aa > ab) {
		const r = b / a
		return aa * Math.sqrt(1 + r * r)
	} else if (b !== 0) {
		const r = a / b
		return ab * Math.sqrt(1 + r * r)
	} else {
		return 0
	}
}
