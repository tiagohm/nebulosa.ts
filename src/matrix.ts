import type { NumberArray } from './math'

export class Matrix {
	readonly data: NumberArray

	constructor(
		readonly rows: number,
		readonly cols: number,
		data?: Readonly<NumberArray>,
		copy: boolean = true,
	) {
		this.data = copy || data === undefined ? (data ? new Float64Array(data) : new Float64Array(rows * cols)) : data as never
	}

	// Gets the number of cells in the matrix.
	get size() {
		return this.data.length
	}

	// Checks if the matrix is square.
	get isSquare() {
		return this.rows === this.cols
	}

	// Checks if the matrix is identity.
	get isIdentity() {
		if (!this.isSquare) return false

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				if (i === j && this.get(i, j) !== 1) return false
				if (i !== j && this.get(i, j) !== 0) return false
			}
		}

		return true
	}

	// Checks if the matrix is filled with zeroes.
	get isZero() {
		if (!this.isSquare) return false

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				if (this.get(i, j) !== 0) return false
			}
		}

		return true
	}

	// Checks if the matrix is diagonal.
	get isDiagonal() {
		if (!this.isSquare) return false

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				if (i !== j && this.get(i, j) !== 0) return false
			}
		}

		return true
	}

	get isSymmetric() {
		if (!this.isSquare) return false

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				if (this.get(i, j) !== this.get(j, i)) return false
			}
		}

		return true
	}

	// Gets the transpose of the matrix.
	get transposed() {
		const m = new Matrix(this.cols, this.rows)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				m.set(j, i, this.get(i, j))
			}
		}

		return m
	}

	// Gets the value at the specified index (row-major order).
	at(index: number) {
		return this.data[index]
	}

	// Gets the value at the specified row and column.
	get(row: number, col: number) {
		return this.data[row * this.cols + col]
	}

	// Sets the value at the specified row and column.
	set(row: number, col: number, value: number) {
		this.data[row * this.cols + col] = value
	}

	// Fills the matrix with the given value.
	fill(value: number | 'identity'): this {
		if (value === 'identity') {
			this.data.fill(0)
			for (let i = 0; i < this.rows; i++) this.set(i, i, 1)
		} else {
			this.data.fill(value)
		}

		return this
	}

	// Returns a new instance of the matrix with the same data.
	clone() {
		return new Matrix(this.rows, this.cols, this.data)
	}

	copyInto(m: Matrix) {
		const n = Math.min(m.size, this.size)
		for (let i = 0; i < n; i++) m.data[i] = this.data[i]
		return m
	}

	// Computes the determinant of the matrix.
	// For 2x2 and 3x3 matrices, it uses a direct formula.
	// For larger matrices, it uses LU decomposition.
	get determinant() {
		if (!this.isSquare) {
			throw new Error('matrix must be square to compute determinant')
		} else if (this.size === 0) {
			return 1
		} else if (this.rows === 1) {
			return this.data[0]
		} else if (this.rows === 2) {
			return this.get(0, 0) * this.get(1, 1) - this.get(0, 1) * this.get(1, 0)
		} else if (this.rows === 3) {
			const a = this.get(0, 0) * (this.get(1, 1) * this.get(2, 2) - this.get(1, 2) * this.get(2, 1))
			const b = this.get(0, 1) * (this.get(1, 0) * this.get(2, 2) - this.get(1, 2) * this.get(2, 0))
			const c = this.get(0, 2) * (this.get(1, 0) * this.get(2, 1) - this.get(2, 0) * this.get(1, 1))
			return a - b + c
		} else {
			return new LuDecomposition(this).determinant
		}
	}

	// Checks if the matrix is singular (determinant is zero).
	// A singular matrix cannot be inverted.
	get isSingular() {
		return this.determinant === 0
	}

	// Computes the trace of the matrix.
	get trace() {
		if (!this.isSquare) {
			throw new Error('matrix must be square to compute trace')
		}

		let sum = 0
		for (let i = 0; i < this.rows; i++) sum += this.get(i, i)
		return sum
	}

	// Computes the inverse of the matrix.
	invert(o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		if (!this.isSquare) {
			throw new Error('matrix must be square to compute inverse')
		}

		const lu = new LuDecomposition(this)

		if (lu.determinant === 0) {
			throw new Error('matrix is singular and cannot be inverted')
		}

		return lu.invert(o)
	}

	// Computes the negation of the matrix.
	negate(o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, -this.get(i, j))
			}
		}

		return o
	}

	// Computes the sum of two matrices.
	plus(b: Matrix, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		if (this.rows !== b.rows || this.cols !== b.cols) {
			throw new Error('matrices must have the same dimensions to add')
		}

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, this.get(i, j) + b.get(i, j))
			}
		}

		return o
	}

	// Computes the subtraction of two matrices.
	minus(b: Matrix, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		if (this.rows !== b.rows || this.cols !== b.cols) {
			throw new Error('matrices must have the same dimensions to subtract')
		}

		if (this === b) {
			return o.fill(0)
		}

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, this.get(i, j) - b.get(i, j))
			}
		}

		return o
	}

	// Computes the sum of a matrix and a scalar.
	plusScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, this.get(i, j) + scalar)
			}
		}

		return o
	}

	// Computes the subtraction of a matrix and a scalar.
	minusScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, this.get(i, j) - scalar)
			}
		}

		return o
	}

	// Computes the multiplication of a matrix and a scalar.
	mulScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, this.get(i, j) * scalar)
			}
		}

		return o
	}

	// Computes the division of a matrix by a scalar.
	divScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				o.set(i, j, this.get(i, j) / scalar)
			}
		}

		return o
	}

	// Computes the product of two matrices, MxN and NxP.
	// The result is a new matrix MxP.
	mul(b: Matrix, o?: Matrix) {
		const m = this.rows
		const n = b.cols

		if (o === this || o === b) {
			throw new Error('invalid output matrix')
		}

		o ??= new Matrix(m, n)

		for (let i = 0; i < m; i++) {
			for (let j = 0; j < n; j++) {
				let s = 0

				for (let k = 0; k < this.cols; k++) {
					s += this.get(i, k) * b.get(k, j)
				}

				o.set(i, j, s)
			}
		}

		return o
	}

	mulVec(v: NumberArray) {
		const result = new Float64Array(this.rows)

		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols; j++) {
				result[i] += this.get(i, j) * v[j]
			}
		}

		return result
	}

	mulTransposedVec(v: NumberArray) {
		const result = new Float64Array(this.cols)

		for (let i = 0; i < this.cols; i++) {
			for (let j = 0; j < this.rows; j++) {
				result[i] += this.get(j, i) * v[j]
			}
		}

		return result
	}

	// Flips the matrix horizontally (along the X axis).
	flipX(): this {
		for (let i = 0; i < this.rows / 2; i++) {
			for (let j = 0; j < this.cols; j++) {
				const temp = this.get(i, j)
				this.set(i, j, this.get(this.rows - 1 - i, j))
				this.set(this.rows - 1 - i, j, temp)
			}
		}

		return this
	}

	// Flips the matrix vertically (along the Y axis).
	flipY(): this {
		for (let i = 0; i < this.rows; i++) {
			for (let j = 0; j < this.cols / 2; j++) {
				const temp = this.get(i, j)
				this.set(i, j, this.get(i, this.cols - 1 - j))
				this.set(i, this.cols - 1 - j, temp)
			}
		}

		return this
	}

	// Converts the matrix to array.
	toArray() {
		return Array.from(this.data)
	}

	// Creates a new identity matrix of the given size.
	static identity(size: number) {
		const m = new Matrix(size, size)
		for (let i = 0; i < size; i++) m.data[i * size + i] = 1
		return m
	}

	static square(size: number, data?: NumberArray) {
		if (data && data.length < size * size) {
			throw new Error(`data length must be ${size * size} for a square matrix of size ${size}`)
		}

		return new Matrix(size, size, data)
	}

	// Creates a row matrix from an array.
	static row(data: NumberArray | number) {
		return typeof data === 'number' ? new Matrix(1, data, undefined) : new Matrix(1, data.length, data)
	}

	// Creates a column matrix from an array.
	static column(data: NumberArray | number) {
		return typeof data === 'number' ? new Matrix(data, 1, undefined) : new Matrix(data.length, 1, data)
	}
}

// https://en.wikipedia.org/wiki/LU_decomposition
export class LuDecomposition {
	private readonly A: Matrix
	private readonly P: Int32Array

	constructor(matrix: Matrix) {
		if (!matrix.isSquare) throw new Error('matrix is not square')

		const n = matrix.rows
		const A = matrix.clone()

		// Unit permutation matrix
		const P = new Int32Array(n + 1)
		for (let i = 0; i <= n; i++) P[i] = i

		for (let i = 0; i < n; i++) {
			let maxA = 0
			let maxI = i

			for (let k = i; k < n; k++) {
				const a = Math.abs(A.get(k, i))

				if (a > maxA) {
					maxA = a
					maxI = k
				}
			}

			// if (maxA < Tol) throw new Error('matrix is degenerate')

			if (maxI !== i) {
				// Pivoting
				const j = P[i]
				P[i] = P[maxI]
				P[maxI] = j

				// Pivoting rows of A
				for (let j = 0; j < n; j++) {
					const p = A.get(i, j)
					A.set(i, j, A.get(maxI, j))
					A.set(maxI, j, p)
				}

				// Counting pivots starting from N (for determinant)
				P[n]++
			}

			for (let j = i + 1; j < n; j++) {
				A.set(j, i, A.get(j, i) / A.get(i, i))

				for (let k = i + 1; k < n; k++) {
					A.set(j, k, A.get(j, k) - A.get(j, i) * A.get(i, k))
				}
			}
		}

		this.A = A
		this.P = P
	}

	get isSingular() {
		const n = this.A.rows

		for (let j = 0; j < n; j++) {
			if (this.A.get(j, j) === 0) {
				return true
			}
		}

		return false
	}

	get determinant() {
		const n = this.A.rows
		let det = this.A.get(0, 0)
		for (let i = 1; i < n; i++) det *= this.A.get(i, i)
		return (this.P[n] - n) % 2 === 0 ? det : -det
	}

	invert(o?: Matrix) {
		const n = this.A.rows

		o ??= new Matrix(n, n)

		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				o.set(i, j, this.P[i] === j ? 1 : 0)

				for (let k = 0; k < i; k++) {
					o.set(i, j, o.get(i, j) - this.A.get(i, k) * o.get(k, j))
				}
			}

			for (let i = n - 1; i >= 0; i--) {
				for (let k = i + 1; k < n; k++) {
					o.set(i, j, o.get(i, j) - this.A.get(i, k) * o.get(k, j))
				}

				o.set(i, j, o.get(i, j) / this.A.get(i, i))
			}
		}

		return o
	}

	// Solves the system of linear equations A*x = B, where A is the matrix and B is the right-hand side vector.
	solve(B: Readonly<NumberArray>) {
		const n = this.A.rows
		const x = new Float64Array(n)

		for (let i = 0; i < n; i++) {
			x[i] = B[this.P[i]]

			for (let k = 0; k < i; k++) {
				x[i] -= this.A.get(i, k) * x[k]
			}
		}

		for (let i = n - 1; i >= 0; i--) {
			for (let k = i + 1; k < n; k++) {
				x[i] -= this.A.get(i, k) * x[k]
			}

			x[i] /= this.A.get(i, i)
		}

		return x
	}
}

// https://github.com/mljs/matrix/blob/main/src/dc/qr.js
export class QrDecomposition {
	private readonly QR: Matrix
	private readonly rdiag: Float64Array

	constructor(matrix: Matrix) {
		const QR = matrix.clone()
		const rdiag = new Float64Array(matrix.cols)

		for (let k = 0; k < matrix.cols; k++) {
			let nrm = 0

			for (let i = k; i < matrix.rows; i++) {
				nrm = hypotenuse(nrm, QR.get(i, k))
			}

			if (nrm !== 0) {
				if (QR.get(k, k) < 0) {
					nrm = -nrm
				}

				for (let i = k; i < matrix.rows; i++) {
					QR.set(i, k, QR.get(i, k) / nrm)
				}

				QR.set(k, k, QR.get(k, k) + 1)

				for (let j = k + 1; j < matrix.cols; j++) {
					let s = 0

					for (let i = k; i < matrix.rows; i++) {
						s += QR.get(i, k) * QR.get(i, j)
					}

					s = -s / QR.get(k, k)

					for (let i = k; i < matrix.rows; i++) {
						QR.set(i, j, QR.get(i, j) + s * QR.get(i, k))
					}
				}
			}

			rdiag[k] = -nrm
		}

		this.QR = QR
		this.rdiag = rdiag
	}

	get isFullRank() {
		return this.rdiag.indexOf(0) < 0
	}

	// Solves the system of linear equations A*x = B, where A is the matrix and B is the right-hand side vector.
	solve(value: Readonly<NumberArray>) {
		if (value.length !== this.QR.rows) {
			throw new Error('matrix row dimensions must agree')
		}

		if (!this.isFullRank) {
			throw new Error('matrix is rank deficient')
		}

		const X = new Float64Array(value)

		for (let k = 0; k < this.QR.cols; k++) {
			let s = 0

			for (let i = k; i < this.QR.rows; i++) {
				s += this.QR.get(i, k) * X[i]
			}

			s = -s / this.QR.get(k, k)

			for (let i = k; i < this.QR.rows; i++) {
				X[i] += s * this.QR.get(i, k)
			}
		}

		for (let k = this.QR.cols - 1; k >= 0; k--) {
			X[k] /= this.rdiag[k]

			for (let i = 0; i < k; i++) {
				X[i] -= X[k] * this.QR.get(i, k)
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

// Solves a system of linear equations using Gaussian elimination
// A is a matrix of coefficients, b is a vector of constants
// https://en.wikipedia.org/wiki/Gaussian_elimination
export function gaussianElimination(A: Matrix, B: NumberArray, o?: NumberArray) {
	const n = A.rows

	for (let i = 0; i < n; i++) {
		// Pivot
		let maxRow = i

		for (let k = i + 1; k < n; k++) {
			if (Math.abs(A.get(k, i)) > Math.abs(A.get(maxRow, i))) maxRow = k
		}

		// Swap rows in matrix A
		for (let j = 0; j < n; j++) {
			const temp = A.get(maxRow, j)
			A.set(maxRow, j, A.get(i, j))
			A.set(i, j, temp)
		}

		// Swap entries in vector B
		const tempB = B[maxRow]
		B[maxRow] = B[i]
		B[i] = tempB

		const divisor = A.get(i, i)
		for (let j = i; j < n; j++) A.set(i, j, A.get(i, j) / divisor)
		B[i] /= divisor

		for (let k = i + 1; k < n; k++) {
			const factor = A.get(k, i)
			for (let j = i; j < n; j++) A.set(k, j, A.get(k, j) - factor * A.get(i, j))
			B[k] -= factor * B[i]
		}
	}

	const x = o ?? new Float64Array(n)

	for (let i = n - 1; i >= 0; i--) {
		let sum = 0

		for (let k = i + 1; k < A.cols; k++) {
			sum += A.get(i, k) * x[k]
		}

		x[i] = B[i] - sum
	}

	return x
}

// Computes the product of two matrices, transpose of MxN (NxM) and MxP.
// The result is a new matrix NxP.
export function mulMTxN(a: Readonly<Readonly<NumberArray>[]>, b: Readonly<Readonly<NumberArray>[]>): NumberArray[] {
	const m = a[0].length
	const n = b[0].length

	const o = new Array<Float64Array>(m)
	for (let i = 0; i < m; i++) o[i] = new Float64Array(n)

	for (let i = 0; i < m; i++) {
		for (let j = 0; j < n; j++) {
			let s = 0

			for (let k = 0; k < a.length; k++) {
				s += a[k][i] * b[k][j]
			}

			o[i][j] = s
		}
	}

	return o
}

// Computes the product of two matrices, MxN and transpose of PxN (NxP).
// The result is a new matrix MxP.
export function mulMxNT(a: Readonly<Readonly<NumberArray>[]>, b: Readonly<Readonly<NumberArray>[]>): NumberArray[] {
	const m = a.length
	const n = b.length

	const o = new Array<Float64Array>(m)
	for (let i = 0; i < m; i++) o[i] = new Float64Array(n)

	for (let i = 0; i < m; i++) {
		for (let j = 0; j < n; j++) {
			let s = 0

			for (let k = 0; k < b[i].length; k++) {
				s += a[i][k] * b[j][k]
			}

			o[i][j] = s
		}
	}

	return o
}
