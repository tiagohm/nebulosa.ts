import { describe, expect, test } from 'bun:test'
import { gaussianElimination, LuDecomposition, Matrix, QrDecomposition } from '../src/matrix'

test('is square', () => {
	const m = Matrix.square(3)
	expect(m.isSquare).toBe(true)
})

test('is not square', () => {
	const m = new Matrix(3, 4)
	expect(m.isSquare).toBe(false)
})

test('row', () => {
	const m = Matrix.row([1, 2, 3])

	expect(m.rows).toBe(1)
	expect(m.cols).toBe(3)
	expect(m.get(0, 0)).toBe(1)
	expect(m.get(0, 1)).toBe(2)
	expect(m.get(0, 2)).toBe(3)
})

test('column', () => {
	const m = Matrix.column([1, 2, 3])

	expect(m.rows).toBe(3)
	expect(m.cols).toBe(1)
	expect(m.get(0, 0)).toBe(1)
	expect(m.get(1, 0)).toBe(2)
	expect(m.get(2, 0)).toBe(3)
})

test('identity', () => {
	const a = Matrix.identity(3)
	expect(a.isIdentity).toBeTrue()

	const b = new Matrix(4, 4)
	b.fill('identity')
	expect(b.isIdentity).toBeTrue()
})

test('transposed', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	const n = m.transposed

	expect(n.get(0, 0)).toBe(1)
	expect(n.get(0, 1)).toBe(4)
	expect(n.get(0, 2)).toBe(7)
	expect(n.get(1, 0)).toBe(2)
	expect(n.get(1, 1)).toBe(5)
	expect(n.get(1, 2)).toBe(8)
	expect(n.get(2, 0)).toBe(3)
	expect(n.get(2, 1)).toBe(6)
	expect(n.get(2, 2)).toBe(9)
})

test('trace', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.trace).toBe(15)
})

describe('determinant', () => {
	test('2x2', () => {
		const m = new Matrix(2, 2, [1, 2, 3, 4])
		expect(m.determinant).toBe(-2)
	})

	test('3x3', () => {
		const a = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect(a.determinant).toBe(0) // Singular matrix

		const b = Matrix.square(3, [2, 3, 2, 3, 2, 3, 3, 4, 5])
		expect(b.determinant).toBe(-10)
		expect(b.transposed.determinant).toBe(-10)

		const c = Matrix.identity(3)
		expect(c.determinant).toBe(1)
	})

	test('4x4', () => {
		const m = new Matrix(4, 4, [1, 2, 5, 1, 4, 8, 9, 4, 8, 7, 2, 0, 0, 4, 4, 5])
		expect(m.determinant).toBeCloseTo(-143, 12)
	})
})

test('negate', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.negate().toArray()).toEqual([-1, -2, -3, -4, -5, -6, -7, -8, -9])
})

test('plusScalar', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.plusScalar(1).toArray()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('minusScalar', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.minusScalar(1).toArray()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
})

test('mulScalar', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.mulScalar(2).toArray()).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
})

test('divScalar', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.divScalar(2).toArray()).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5])
})

test('plus', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	const n = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.plus(n).toArray()).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
})

test('minus', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	const n = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	expect(m.minus(n).toArray()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
	expect(m.minus(m).toArray()).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
})

test('multiply', () => {
	const a = new Matrix(2, 3, [1, 2, 3, 4, 5, 6])
	const b = new Matrix(3, 2, [7, 8, 9, 10, 11, 12])
	const c = a.mul(b)

	expect(c.rows).toBe(2)
	expect(c.cols).toBe(2)
	expect(c.toArray()).toEqual([58, 64, 139, 154])
})

test('multiply transposed by', () => {
	const a = new Matrix(3, 2, [1, 2, 3, 4, 5, 6])
	const b = new Matrix(3, 2, [1, 2, 3, 4, 5, 6])
	const m = a.transposed.mul(b)

	expect(m.at(0)).toBe(35)
	expect(m.at(1)).toBe(44)
	expect(m.at(2)).toBe(44)
	expect(m.at(3)).toBe(56)
})

test('multiply by transposed', () => {
	const a = new Matrix(2, 3, [1, 2, 3, 4, 5, 6])
	const b = new Matrix(2, 3, [1, 2, 3, 4, 5, 6])
	const m = a.mul(b.transposed)

	expect(m.at(0)).toBe(14)
	expect(m.at(1)).toBe(32)
	expect(m.at(2)).toBe(32)
	expect(m.at(3)).toBe(77)
})

test('symmetric', () => {
	const a = Matrix.square(3, [1, 2, 3, 2, 4, 5, 3, 5, 6])
	const b = a.transposed
	const c = a.mul(b)

	expect(c.rows).toBe(3)
	expect(c.cols).toBe(3)
	expect(c.toArray()).toEqual([14, 25, 31, 25, 45, 56, 31, 56, 70])
	expect(c.isSymmetric).toBe(true)
})

test('flipY', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	m.flipY()
	expect(m.toArray()).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7])
})

test('flipX', () => {
	const m = Matrix.square(3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
	m.flipX()
	expect(m.toArray()).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3])
})

describe('LU decomposition', () => {
	test('3x3', () => {
		const matrix = Matrix.square(3, [2, 7, 1, 3, -2, 0, 1, 5, 3])
		const decomposition = new LuDecomposition(matrix)

		const det = decomposition.determinant
		expect(det).toBeCloseTo(-58, 12)

		const inv = decomposition.invert()

		expect(inv.get(0, 0)).toBeCloseTo(3 / 29, 12)
		expect(inv.get(0, 1)).toBeCloseTo(8 / 29, 12)
		expect(inv.get(0, 2)).toBeCloseTo(-1 / 29, 12)
		expect(inv.get(1, 0)).toBeCloseTo(9 / 58, 12)
		expect(inv.get(1, 1)).toBeCloseTo(-5 / 58, 12)
		expect(inv.get(1, 2)).toBeCloseTo(-3 / 58, 12)
		expect(inv.get(2, 0)).toBeCloseTo(-17 / 58, 12)
		expect(inv.get(2, 1)).toBeCloseTo(3 / 58, 12)
		expect(inv.get(2, 2)).toBeCloseTo(25 / 58, 12)

		const x = decomposition.solve([1, 1, 1])

		expect(x[0]).toBeCloseTo(0.3448275862068966, 12)
		expect(x[1]).toBeCloseTo(0.017241379310344827, 12)
		expect(x[2]).toBeCloseTo(0.1896551724137931, 12)
	})

	test('4x4', () => {
		const matrix = new Matrix(4, 4, [3 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 3 / 2])
		const decomposition = new LuDecomposition(matrix)

		expect(decomposition.determinant).toBeCloseTo(-2.1875, 12)

		const inv = decomposition.invert()

		expect(inv.get(0, 0)).toBeCloseTo(0.74285714, 7)
		expect(inv.get(0, 1)).toBeCloseTo(-0.11428571, 7)
		expect(inv.get(0, 2)).toBeCloseTo(-0.68571429, 7)
		expect(inv.get(0, 3)).toBeCloseTo(0.45714286, 7)
		expect(inv.get(1, 0)).toBeCloseTo(-0.11428571, 7)
		expect(inv.get(1, 1)).toBeCloseTo(0.17142857, 7)
		expect(inv.get(1, 2)).toBeCloseTo(1.02857143, 7)
		expect(inv.get(1, 3)).toBeCloseTo(-0.68571429, 7)
		expect(inv.get(2, 0)).toBeCloseTo(-0.68571429, 7)
		expect(inv.get(2, 1)).toBeCloseTo(1.02857143, 7)
		expect(inv.get(2, 2)).toBeCloseTo(0.17142857, 7)
		expect(inv.get(2, 3)).toBeCloseTo(-0.11428571, 7)
		expect(inv.get(3, 0)).toBeCloseTo(0.45714286, 7)
		expect(inv.get(3, 1)).toBeCloseTo(-0.68571429, 7)
		expect(inv.get(3, 2)).toBeCloseTo(-0.11428571, 7)
		expect(inv.get(3, 3)).toBeCloseTo(0.74285714, 7)

		const x = decomposition.solve([20001, 20003, 20005, 20007])

		expect(x[0]).toBeCloseTo(8000.1714, 4)
		expect(x[1]).toBeCloseTo(8000.7429, 4)
		expect(x[2]).toBeCloseTo(8002.45714, 4)
		expect(x[3]).toBeCloseTo(8003.02857, 4)
	})

	test('5x5', () => {
		const matrix = new Matrix(5, 5, [4, 2, 3, 1, 5, 6, 7, 2, 8, 1, 5, 9, 4, 3, 2, 8, 1, 7, 6, 5, 3, 4, 5, 2, 9])
		const decomposition = new LuDecomposition(matrix)

		expect(decomposition.determinant).toBeCloseTo(5025, 11)

		const inv = decomposition.invert()

		expect(inv.get(0, 0)).toBeCloseTo(457 / 1005, 12)
		expect(inv.get(0, 1)).toBeCloseTo(26 / 1005, 12)
		expect(inv.get(0, 2)).toBeCloseTo(-61 / 5025, 12)
		expect(inv.get(0, 3)).toBeCloseTo(-41 / 1675, 12)
		expect(inv.get(0, 4)).toBeCloseTo(-1202 / 5025, 12)
		expect(inv.get(1, 0)).toBeCloseTo(-7 / 335, 12)
		expect(inv.get(1, 1)).toBeCloseTo(4 / 335, 12)
		expect(inv.get(1, 2)).toBeCloseTo(171 / 1675, 12)
		expect(inv.get(1, 3)).toBeCloseTo(-122 / 1675, 12)
		expect(inv.get(1, 4)).toBeCloseTo(47 / 1675, 12)
		expect(inv.get(2, 0)).toBeCloseTo(-416 / 1005, 12)
		expect(inv.get(2, 1)).toBeCloseTo(-193 / 1005, 12)
		expect(inv.get(2, 2)).toBeCloseTo(878 / 5025, 12)
		expect(inv.get(2, 3)).toBeCloseTo(343 / 1675, 12)
		expect(inv.get(2, 4)).toBeCloseTo(496 / 5025, 12)
		expect(inv.get(3, 0)).toBeCloseTo(-238 / 1005, 12)
		expect(inv.get(3, 1)).toBeCloseTo(136 / 1005, 12)
		expect(inv.get(3, 2)).toBeCloseTo(-551 / 5025, 12)
		expect(inv.get(3, 3)).toBeCloseTo(69 / 1675, 12)
		expect(inv.get(3, 4)).toBeCloseTo(593 / 5025, 12)
		expect(inv.get(4, 0)).toBeCloseTo(47 / 335, 12)
		expect(inv.get(4, 1)).toBeCloseTo(21 / 335, 12)
		expect(inv.get(4, 2)).toBeCloseTo(-191 / 1675, 12)
		expect(inv.get(4, 3)).toBeCloseTo(-138 / 1675, 12)
		expect(inv.get(4, 4)).toBeCloseTo(163 / 1675, 12)

		const x = decomposition.solve([12, 25, 18, 30, 17])

		expect(x[0]).toBeCloseTo(1.084179104477611, 12)
		expect(x[1]).toBeCloseTo(0.17731343283582093, 12)
		expect(x[2]).toBeCloseTo(1.1982089552238815, 12)
		expect(x[3]).toBeCloseTo(1.8095522388059702, 12)
		expect(x[4]).toBeCloseTo(0.3808955223880599, 12)
	})
})

describe('QR decomposition', () => {
	test('3x3', () => {
		const matrix = Matrix.square(3, [2, 7, 1, 3, -2, 0, 1, 5, 3])
		const decomposition = new QrDecomposition(matrix)
		const x = decomposition.solve([1, 1, 1])

		expect(x[0]).toBeCloseTo(0.3448275862068966, 12)
		expect(x[1]).toBeCloseTo(0.017241379310344827, 12)
		expect(x[2]).toBeCloseTo(0.1896551724137931, 12)
	})

	test('4x4', () => {
		const matrix = new Matrix(4, 4, [3 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 3 / 2])
		const decomposition = new QrDecomposition(matrix)
		const x = decomposition.solve([20001, 20003, 20005, 20007])

		expect(x[0]).toBeCloseTo(8000.1714, 4)
		expect(x[1]).toBeCloseTo(8000.7429, 4)
		expect(x[2]).toBeCloseTo(8002.45714, 4)
		expect(x[3]).toBeCloseTo(8003.02857, 4)
	})

	test('5x5', () => {
		const matrix = new Matrix(5, 5, [4, 2, 3, 1, 5, 6, 7, 2, 8, 1, 5, 9, 4, 3, 2, 8, 1, 7, 6, 5, 3, 4, 5, 2, 9])
		const decomposition = new QrDecomposition(matrix)
		const x = decomposition.solve([12, 25, 18, 30, 17])

		expect(x[0]).toBeCloseTo(1.084179104477611, 12)
		expect(x[1]).toBeCloseTo(0.17731343283582093, 12)
		expect(x[2]).toBeCloseTo(1.1982089552238815, 12)
		expect(x[3]).toBeCloseTo(1.8095522388059702, 12)
		expect(x[4]).toBeCloseTo(0.3808955223880599, 12)
	})

	test('5x2', () => {
		const matrix = new Matrix(5, 2, [10000, 10001, 10002, 10003, 10004, 10001, 10002, 10003, 10004, 10005])
		const decomposition = new QrDecomposition(matrix)
		const x = decomposition.solve([20001, 20003, 20005, 20007, 20009])

		expect(x[0]).toBeCloseTo(1, 12)
		expect(x[1]).toBeCloseTo(1, 12)
	})
})

// https://matrix.reshish.com/gauss-jordanElimination.php
test('gaussian elimination', () => {
	const a = Matrix.square(3, [2, 1, -1, -3, -1, 2, -2, 1, 2])
	const b = [8, -11, -3]
	const x = gaussianElimination(a, b)

	expect(x[0]).toBeCloseTo(2, 12)
	expect(x[1]).toBeCloseTo(3, 12)
	expect(x[2]).toBeCloseTo(-1, 12)
})
