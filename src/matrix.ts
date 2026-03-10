import type { NumberArray } from './math'

export class Matrix {
	readonly data: NumberArray

	constructor(
		readonly rows: number,
		readonly cols: number,
		data?: Readonly<NumberArray>,
		copy: boolean = true,
	) {
		const size = rows * cols

		if (data !== undefined && data.length !== size) {
			throw new Error(`data length must be ${size} for a ${rows}x${cols} matrix`)
		}

		this.data = copy || data === undefined ? (data ? new Float64Array(data) : new Float64Array(size)) : (data as NumberArray)
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

		const data = this.data
		const cols = this.cols

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * cols

			for (let j = 0; j < cols; j++) {
				const value = data[rowOffset + j]
				if (i === j ? value !== 1 : value !== 0) return false
			}
		}

		return true
	}

	// Checks if the matrix is filled with zeroes.
	get isZero() {
		for (let i = 0; i < this.data.length; i++) {
			if (this.data[i] !== 0) return false
		}

		return true
	}

	// Checks if the matrix is diagonal.
	get isDiagonal() {
		if (!this.isSquare) return false

		const data = this.data

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * this.cols

			for (let j = 0; j < this.cols; j++) {
				if (i !== j && data[rowOffset + j] !== 0) return false
			}
		}

		return true
	}

	get isSymmetric() {
		if (!this.isSquare) return false

		const data = this.data
		const cols = this.cols

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * cols

			for (let j = i + 1; j < cols; j++) {
				if (data[rowOffset + j] !== data[j * cols + i]) return false
			}
		}

		return true
	}

	// Gets the transpose of the matrix.
	get transposed() {
		const m = new Matrix(this.cols, this.rows)
		const source = this.data
		const output = m.data

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * this.cols

			for (let j = 0; j < this.cols; j++) {
				output[j * this.rows + i] = source[rowOffset + j]
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
			for (let i = 0, n = Math.min(this.rows, this.cols); i < n; i++) this.data[i * this.cols + i] = 1
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
		checkMatrixShape(m, this.rows, this.cols)
		for (let i = 0; i < this.size; i++) m.data[i] = this.data[i]
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
			const data = this.data
			return data[0] * data[3] - data[1] * data[2]
		} else if (this.rows === 3) {
			const data = this.data
			const a = data[0] * (data[4] * data[8] - data[5] * data[7])
			const b = data[1] * (data[3] * data[8] - data[5] * data[6])
			const c = data[2] * (data[3] * data[7] - data[6] * data[4])
			return a - b + c
		} else {
			return new LuDecomposition(this).determinant
		}
	}

	// Checks if the matrix is singular (determinant is zero).
	// A singular matrix cannot be inverted.
	get isSingular() {
		return this.isSquare && new LuDecomposition(this).isSingular
	}

	// Computes the trace of the matrix.
	get trace() {
		if (!this.isSquare) {
			throw new Error('matrix must be square to compute trace')
		}

		let sum = 0
		for (let i = 0; i < this.rows; i++) sum += this.data[i * this.cols + i]
		return sum
	}

	// Computes the inverse of the matrix.
	invert(o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		if (!this.isSquare) {
			throw new Error('matrix must be square to compute inverse')
		}

		const lu = new LuDecomposition(this)

		if (lu.isSingular) {
			throw new Error('matrix is singular and cannot be inverted')
		}

		return lu.invert(o)
	}

	// Computes the negation of the matrix.
	negate(o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		const data = this.data
		const output = o.data

		for (let i = 0; i < data.length; i++) {
			output[i] = -data[i]
		}

		return o
	}

	// Computes the sum of two matrices.
	plus(b: Matrix, o?: Matrix) {
		if (this.rows !== b.rows || this.cols !== b.cols) {
			throw new Error('matrices must have the same dimensions to add')
		}

		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		const aData = this.data
		const bData = b.data
		const output = o.data

		for (let i = 0; i < aData.length; i++) {
			output[i] = aData[i] + bData[i]
		}

		return o
	}

	// Computes the subtraction of two matrices.
	minus(b: Matrix, o?: Matrix) {
		if (this.rows !== b.rows || this.cols !== b.cols) {
			throw new Error('matrices must have the same dimensions to subtract')
		}

		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		if (this === b) {
			return o.fill(0)
		}

		const aData = this.data
		const bData = b.data
		const output = o.data

		for (let i = 0; i < aData.length; i++) {
			output[i] = aData[i] - bData[i]
		}

		return o
	}

	// Computes the sum of a matrix and a scalar.
	plusScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		const data = this.data
		const output = o.data

		for (let i = 0; i < data.length; i++) {
			output[i] = data[i] + scalar
		}

		return o
	}

	// Computes the subtraction of a matrix and a scalar.
	minusScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		const data = this.data
		const output = o.data

		for (let i = 0; i < data.length; i++) {
			output[i] = data[i] - scalar
		}

		return o
	}

	// Computes the multiplication of a matrix and a scalar.
	mulScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		const data = this.data
		const output = o.data

		for (let i = 0; i < data.length; i++) {
			output[i] = data[i] * scalar
		}

		return o
	}

	// Computes the division of a matrix by a scalar.
	divScalar(scalar: number, o?: Matrix) {
		o ??= new Matrix(this.rows, this.cols)
		checkMatrixShape(o, this.rows, this.cols)

		const data = this.data
		const output = o.data

		for (let i = 0; i < data.length; i++) {
			output[i] = data[i] / scalar
		}

		return o
	}

	// Computes the product of two matrices, MxN and NxP.
	// The result is a new matrix MxP.
	mul(b: Matrix, o?: Matrix) {
		const m = this.rows
		const n = b.cols
		const shared = this.cols

		if (o === this || o === b) {
			throw new Error('invalid output matrix')
		}

		if (shared !== b.rows) {
			throw new Error('matrix columns must match matrix rows to multiply')
		}

		o ??= new Matrix(m, n)
		checkMatrixShape(o, m, n)

		const aData = this.data
		const bData = b.data
		const output = o.data
		const bCols = b.cols

		for (let i = 0; i < m; i++) {
			const aRowOffset = i * shared
			const oRowOffset = i * n

			for (let j = 0; j < n; j++) output[oRowOffset + j] = 0

			for (let k = 0; k < shared; k++) {
				const aValue = aData[aRowOffset + k]
				if (aValue === 0) continue
				const bRowOffset = k * bCols

				for (let j = 0; j < n; j++) {
					output[oRowOffset + j] += aValue * bData[bRowOffset + j]
				}
			}
		}

		return o
	}

	mulVec(v: NumberArray) {
		if (v.length !== this.cols) {
			throw new Error('vector length must match matrix columns')
		}

		const result = new Float64Array(this.rows)
		const data = this.data
		const cols = this.cols

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * cols
			let s = 0

			for (let j = 0; j < cols; j++) s += data[rowOffset + j] * v[j]
			result[i] = s
		}

		return result
	}

	mulTransposedVec(v: NumberArray) {
		if (v.length !== this.rows) {
			throw new Error('vector length must match matrix rows')
		}

		const result = new Float64Array(this.cols)
		const data = this.data
		const cols = this.cols

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * cols
			const value = v[i]

			for (let j = 0; j < cols; j++) {
				result[j] += data[rowOffset + j] * value
			}
		}

		return result
	}

	// Flips the matrix horizontally (along the X axis).
	flipX(): this {
		const data = this.data
		const cols = this.cols

		for (let i = 0, top = 0, bottom = (this.rows - 1) * cols; i < this.rows / 2; i++, top += cols, bottom -= cols) {
			for (let j = 0; j < this.cols; j++) {
				const topIndex = top + j
				const bottomIndex = bottom + j
				const temp = data[topIndex]
				data[topIndex] = data[bottomIndex]
				data[bottomIndex] = temp
			}
		}

		return this
	}

	// Flips the matrix vertically (along the Y axis).
	flipY(): this {
		const data = this.data
		const cols = this.cols

		for (let i = 0; i < this.rows; i++) {
			const rowOffset = i * cols

			for (let j = 0; j < cols / 2; j++) {
				const leftIndex = rowOffset + j
				const rightIndex = rowOffset + cols - 1 - j
				const temp = data[leftIndex]
				data[leftIndex] = data[rightIndex]
				data[rightIndex] = temp
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
		const data = A.data

		// Unit permutation matrix
		const P = new Int32Array(n + 1)
		for (let i = 0; i <= n; i++) P[i] = i

		for (let i = 0; i < n; i++) {
			let maxA = 0
			let maxI = i

			for (let k = i; k < n; k++) {
				const a = Math.abs(data[k * n + i])

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
				const iOffset = i * n
				const maxOffset = maxI * n

				for (let j = 0; j < n; j++) {
					const p = data[iOffset + j]
					data[iOffset + j] = data[maxOffset + j]
					data[maxOffset + j] = p
				}

				// Counting pivots starting from N (for determinant)
				P[n]++
			}

			const iOffset = i * n
			const pivot = data[iOffset + i]
			if (pivot === 0) continue

			for (let j = i + 1; j < n; j++) {
				const jOffset = j * n
				const scale = data[jOffset + i] / pivot
				data[jOffset + i] = scale

				for (let k = i + 1; k < n; k++) {
					data[jOffset + k] -= scale * data[iOffset + k]
				}
			}
		}

		this.A = A
		this.P = P
	}

	get isSingular() {
		const n = this.A.rows
		const data = this.A.data

		for (let j = 0; j < n; j++) {
			if (data[j * n + j] === 0) {
				return true
			}
		}

		return false
	}

	get determinant() {
		const n = this.A.rows
		const data = this.A.data
		let det = data[0]
		for (let i = 1; i < n; i++) det *= data[i * n + i]
		return (this.P[n] - n) % 2 === 0 ? det : -det
	}

	invert(o?: Matrix) {
		const n = this.A.rows
		const aData = this.A.data

		o ??= new Matrix(n, n)
		checkMatrixShape(o, n, n)

		if (this.isSingular) {
			throw new Error('matrix is singular and cannot be inverted')
		}

		const output = o.data

		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				const ij = i * n + j
				let value = this.P[i] === j ? 1 : 0

				for (let k = 0; k < i; k++) {
					value -= aData[i * n + k] * output[k * n + j]
				}

				output[ij] = value
			}

			for (let i = n - 1; i >= 0; i--) {
				let value = output[i * n + j]

				for (let k = i + 1; k < n; k++) {
					value -= aData[i * n + k] * output[k * n + j]
				}

				output[i * n + j] = value / aData[i * n + i]
			}
		}

		return o
	}

	// Solves the system of linear equations A*x = B, where A is the matrix and B is the right-hand side vector.
	solve(B: Readonly<NumberArray>) {
		const n = this.A.rows
		if (B.length !== n) throw new Error('right-hand side length must match matrix rows')
		if (this.isSingular) throw new Error('matrix is singular and cannot be solved')

		const aData = this.A.data
		const x = new Float64Array(n)

		for (let i = 0; i < n; i++) {
			x[i] = B[this.P[i]]

			for (let k = 0; k < i; k++) {
				x[i] -= aData[i * n + k] * x[k]
			}
		}

		for (let i = n - 1; i >= 0; i--) {
			for (let k = i + 1; k < n; k++) {
				x[i] -= aData[i * n + k] * x[k]
			}

			x[i] /= aData[i * n + i]
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
	if (!A.isSquare) {
		throw new Error('matrix must be square')
	}

	const n = A.rows
	const x = o ?? new Float64Array(n)

	if (B.length !== n) {
		throw new Error('right-hand side length must match matrix rows')
	}

	if (x.length !== n) {
		throw new Error('output vector length must match matrix rows')
	}

	const data = A.data

	for (let i = 0; i < n; i++) {
		// Pivot
		let maxRow = i
		let maxValue = Math.abs(data[i * n + i])

		for (let k = i + 1; k < n; k++) {
			const value = Math.abs(data[k * n + i])

			if (value > maxValue) {
				maxValue = value
				maxRow = k
			}
		}

		if (maxValue === 0) {
			for (let k = 0; k < n; k++) x[k] = Number.NaN
			return x
		}

		// Swap rows in matrix A
		if (maxRow !== i) {
			const iOffset = i * n
			const maxOffset = maxRow * n

			for (let j = 0; j < n; j++) {
				const temp = data[maxOffset + j]
				data[maxOffset + j] = data[iOffset + j]
				data[iOffset + j] = temp
			}

			// Swap entries in vector B
			const tempB = B[maxRow]
			B[maxRow] = B[i]
			B[i] = tempB
		}

		const iOffset = i * n
		const divisor = data[iOffset + i]
		for (let j = i; j < n; j++) data[iOffset + j] /= divisor
		B[i] /= divisor

		for (let k = i + 1; k < n; k++) {
			const kOffset = k * n
			const factor = data[kOffset + i]
			for (let j = i; j < n; j++) data[kOffset + j] -= factor * data[iOffset + j]
			B[k] -= factor * B[i]
		}
	}

	for (let i = n - 1; i >= 0; i--) {
		let sum = 0
		const iOffset = i * n

		for (let k = i + 1; k < A.cols; k++) {
			sum += data[iOffset + k] * x[k]
		}

		x[i] = B[i] - sum
	}

	return x
}

// Computes the product of two matrices, transpose of MxN (NxM) and MxP.
// The result is a new matrix NxP.
export function mulMTxN(a: Readonly<Readonly<NumberArray>[]>, b: Readonly<Readonly<NumberArray>[]>): NumberArray[] {
	if (a.length === 0 || b.length === 0) {
		throw new Error('matrices must not be empty')
	}

	if (a.length !== b.length) {
		throw new Error('matrix row dimensions must agree')
	}

	const m = a[0].length
	const n = b[0].length

	for (let i = 0; i < a.length; i++) {
		if (a[i].length !== m || b[i].length !== n) {
			throw new Error('matrices must be rectangular')
		}
	}

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
	if (a.length === 0 || b.length === 0) {
		throw new Error('matrices must not be empty')
	}

	const m = a.length
	const n = b.length
	const shared = a[0].length

	if (shared !== b[0].length) {
		throw new Error('matrix column dimensions must agree')
	}

	for (let i = 0; i < m; i++) {
		if (a[i].length !== shared) {
			throw new Error('left matrix must be rectangular')
		}
	}

	for (let i = 0; i < n; i++) {
		if (b[i].length !== shared) {
			throw new Error('right matrix must be rectangular')
		}
	}

	const o = new Array<Float64Array>(m)
	for (let i = 0; i < m; i++) o[i] = new Float64Array(n)

	for (let i = 0; i < m; i++) {
		const ai = a[i]

		for (let j = 0; j < n; j++) {
			const bj = b[j]
			let s = 0

			for (let k = 0; k < shared; k++) {
				s += ai[k] * bj[k]
			}

			o[i][j] = s
		}
	}

	return o
}

// Validates that an output matrix matches the expected shape.
function checkMatrixShape(matrix: Matrix, rows: number, cols: number) {
	if (matrix.rows !== rows || matrix.cols !== cols) {
		throw new Error(`output matrix must be ${rows}x${cols}`)
	}
}
