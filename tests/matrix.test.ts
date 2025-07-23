import { describe, expect, test } from 'bun:test'
import { gaussianElimination, LuDecomposition, Mat3, mulMTxN, mulMxN, mulMxNT, QrDecomposition } from '../src/matrix'
import type { Vector3 } from '../src/vector'

describe('Mat3', () => {
	test('determinant', () => {
		expect(Mat3.determinant([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(0)
		expect(Mat3.determinant(Mat3.identity())).toBe(1)
		expect(Mat3.determinant([2, 3, 2, 3, 2, 3, 3, 4, 5])).toBe(-10)
	})

	test('rotX', () => {
		const m: Mat3.Matrix = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		Mat3.rotX(0.3456789, m)

		expect(m[0]).toBeCloseTo(2, 12)
		expect(m[1]).toBeCloseTo(3, 12)
		expect(m[2]).toBeCloseTo(2, 12)
		expect(m[3]).toBeCloseTo(3.83904338823561246, 12)
		expect(m[4]).toBeCloseTo(3.237033249594111899, 12)
		expect(m[5]).toBeCloseTo(4.516714379005982719, 12)
		expect(m[6]).toBeCloseTo(1.806030415924501684, 12)
		expect(m[7]).toBeCloseTo(3.085711545336372503, 12)
		expect(m[8]).toBeCloseTo(3.687721683977873065, 12)

		expect(Mat3.rotX(0.3456789, Mat3.identity())).toEqual(Mat3.rotX(0.3456789))
	})

	test('rotY', () => {
		const m: Mat3.Matrix = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		Mat3.rotY(0.3456789, m)

		expect(m[0]).toBeCloseTo(0.865184781897815993, 12)
		expect(m[1]).toBeCloseTo(1.467194920539316554, 12)
		expect(m[2]).toBeCloseTo(0.1875137911274457342, 12)
		expect(m[3]).toBeCloseTo(3, 12)
		expect(m[4]).toBeCloseTo(2, 12)
		expect(m[5]).toBeCloseTo(3, 12)
		expect(m[6]).toBeCloseTo(3.50020789285042733, 12)
		expect(m[7]).toBeCloseTo(4.77988902226229815, 12)
		expect(m[8]).toBeCloseTo(5.381899160903798712, 12)

		expect(Mat3.rotY(0.3456789, Mat3.identity())).toEqual(Mat3.rotY(0.3456789))
	})

	test('rotZ', () => {
		const m: Mat3.Matrix = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		Mat3.rotZ(0.3456789, m)

		expect(m[0]).toBeCloseTo(2.898197754208926769, 12)
		expect(m[1]).toBeCloseTo(3.50020789285042733, 12)
		expect(m[2]).toBeCloseTo(2.898197754208926769, 12)
		expect(m[3]).toBeCloseTo(2.144865911309686813, 12)
		expect(m[4]).toBeCloseTo(0.865184781897815993, 12)
		expect(m[5]).toBeCloseTo(2.144865911309686813, 12)
		expect(m[6]).toBeCloseTo(3, 12)
		expect(m[7]).toBeCloseTo(4, 12)
		expect(m[8]).toBeCloseTo(5, 12)

		expect(Mat3.rotZ(0.3456789, Mat3.identity())).toEqual(Mat3.rotZ(0.3456789))
	})

	test('clone', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.clone(m)
		expect(n).toEqual(m)
		expect(m === n).toBe(false)
	})

	test('transpose', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.transpose(m)
		expect(n).not.toEqual(m)
		expect(n).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9])
	})

	test('flipX', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.flipX(m)
		expect(n).not.toEqual(m)
		expect(n).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3])
	})

	test('flipY', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.flipY(m)
		expect(n).not.toEqual(m)
		expect(n).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7])
	})

	test('mulVec', () => {
		const m: Mat3.Matrix = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		const v: Vector3.Vector = [2, 3, 2]
		const u = Mat3.mulVec(m, v)
		expect(u).not.toEqual(v)
		expect(u).toEqual([17, 18, 28])

		Mat3.mulVec(m, v, v)
		expect(v).toEqual(u)
	})

	test('plusScalar', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.plusScalar(m, 1)
		expect(n).not.toEqual(m)
		expect(n).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
	})

	test('minusScalar', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.minusScalar(m, 1)
		expect(n).not.toEqual(m)
		expect(n).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
	})

	test('mulScalar', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.mulScalar(m, 2)
		expect(n).not.toEqual(m)
		expect(n).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
	})

	test('divScalar', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = Mat3.divScalar(m, 2)
		expect(n).not.toEqual(m)
		expect(n).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5])
	})

	test('plus', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const u = Mat3.plus(m, n)
		expect(u).not.toEqual(m)
		expect(u).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])

		Mat3.plus(m, n, m)
		expect(m).toEqual(u)
	})

	test('minus', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const u = Mat3.minus(m, n)
		expect(u).not.toEqual(m)
		expect(u).toEqual(Mat3.zero())

		Mat3.minus(m, n, m)
		expect(m).toEqual(u)
	})

	test('mul', () => {
		const m: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n: Mat3.Matrix = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const u = Mat3.mul(m, n)
		expect(u).not.toEqual(m)
		expect(u).toEqual([30, 36, 42, 66, 81, 96, 102, 126, 150])

		// Aᵀ x A = symmetric matrix
		expect(Mat3.mul(Mat3.transpose(m), n)).toEqual([66, 78, 90, 78, 93, 108, 90, 108, 126])

		Mat3.mul(m, n, m)
		expect(m).toEqual(u)
	})
})

test('mulMxN', () => {
	// biome-ignore format: matrix
	const m = mulMxN([[1, 2], [3, 4], [5, 6]], [[7, 8, 9], [10, 11, 12]])

	expect(m[0]).toEqual(Float64Array.from([27, 30, 33]))
	expect(m[1]).toEqual(Float64Array.from([61, 68, 75]))
	expect(m[2]).toEqual(Float64Array.from([95, 106, 117]))
})

test('mulMTxN', () => {
	// biome-ignore format: matrix
	const m = mulMTxN([[1, 2], [3, 4], [5, 6]], [[1, 2], [3, 4], [5, 6]])

	expect(m[0]).toEqual(Float64Array.from([35, 44]))
	expect(m[1]).toEqual(Float64Array.from([44, 56]))
})

test('mulMxNT', () => {
	// biome-ignore format: matrix
	const m = mulMxNT([[1, 2, 3], [4, 5, 6]], [[1, 2, 3], [4, 5, 6]])

	expect(m[0]).toEqual(Float64Array.from([14, 32]))
	expect(m[1]).toEqual(Float64Array.from([32, 77]))
})

describe('LU decomposition', () => {
	test('3x3', () => {
		const matrix = [2, 7, 1, 3, -2, 0, 1, 5, 3] as const
		const decomposition = new LuDecomposition(matrix)

		const det = decomposition.determinant
		expect(det).toBeCloseTo(-58, 12)
		expect(det).toBeCloseTo(Mat3.determinant(matrix), 12)

		const inv = decomposition.invert()

		expect(inv[0][0]).toBeCloseTo(3 / 29, 12)
		expect(inv[0][1]).toBeCloseTo(8 / 29, 12)
		expect(inv[0][2]).toBeCloseTo(-1 / 29, 12)
		expect(inv[1][0]).toBeCloseTo(9 / 58, 12)
		expect(inv[1][1]).toBeCloseTo(-5 / 58, 12)
		expect(inv[1][2]).toBeCloseTo(-3 / 58, 12)
		expect(inv[2][0]).toBeCloseTo(-17 / 58, 12)
		expect(inv[2][1]).toBeCloseTo(3 / 58, 12)
		expect(inv[2][2]).toBeCloseTo(25 / 58, 12)

		const x = decomposition.solve([1, 1, 1])

		expect(x[0]).toBeCloseTo(0.3448275862068966, 12)
		expect(x[1]).toBeCloseTo(0.017241379310344827, 12)
		expect(x[2]).toBeCloseTo(0.1896551724137931, 12)
	})

	test('4x4', () => {
		const matrix = [3 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 3 / 2] as const
		const decomposition = new LuDecomposition(matrix)

		expect(decomposition.determinant).toBeCloseTo(-2.1875, 12)

		const inv = decomposition.invert()

		expect(inv[0][0]).toBeCloseTo(0.74285714, 7)
		expect(inv[0][1]).toBeCloseTo(-0.11428571, 7)
		expect(inv[0][2]).toBeCloseTo(-0.68571429, 7)
		expect(inv[0][3]).toBeCloseTo(0.45714286, 7)
		expect(inv[1][0]).toBeCloseTo(-0.11428571, 7)
		expect(inv[1][1]).toBeCloseTo(0.17142857, 7)
		expect(inv[1][2]).toBeCloseTo(1.02857143, 7)
		expect(inv[1][3]).toBeCloseTo(-0.68571429, 7)
		expect(inv[2][0]).toBeCloseTo(-0.68571429, 7)
		expect(inv[2][1]).toBeCloseTo(1.02857143, 7)
		expect(inv[2][2]).toBeCloseTo(0.17142857, 7)
		expect(inv[2][3]).toBeCloseTo(-0.11428571, 7)
		expect(inv[3][0]).toBeCloseTo(0.45714286, 7)
		expect(inv[3][1]).toBeCloseTo(-0.68571429, 7)
		expect(inv[3][2]).toBeCloseTo(-0.11428571, 7)
		expect(inv[3][3]).toBeCloseTo(0.74285714, 7)

		const x = decomposition.solve([20001, 20003, 20005, 20007])

		expect(x[0]).toBeCloseTo(8000.1714, 4)
		expect(x[1]).toBeCloseTo(8000.7429, 4)
		expect(x[2]).toBeCloseTo(8002.45714, 4)
		expect(x[3]).toBeCloseTo(8003.02857, 4)
	})

	test('5x5', () => {
		// biome-ignore format: matrix
		const matrix = [[4, 2, 3, 1, 5], [6, 7, 2, 8, 1], [5, 9, 4, 3, 2], [8, 1, 7, 6, 5], [3, 4, 5, 2, 9]] as const
		const decomposition = new LuDecomposition(matrix)

		expect(decomposition.determinant).toBeCloseTo(5025, 11)

		const inv = decomposition.invert()

		expect(inv[0][0]).toBeCloseTo(457 / 1005, 12)
		expect(inv[0][1]).toBeCloseTo(26 / 1005, 12)
		expect(inv[0][2]).toBeCloseTo(-61 / 5025, 12)
		expect(inv[0][3]).toBeCloseTo(-41 / 1675, 12)
		expect(inv[0][4]).toBeCloseTo(-1202 / 5025, 12)
		expect(inv[1][0]).toBeCloseTo(-7 / 335, 12)
		expect(inv[1][1]).toBeCloseTo(4 / 335, 12)
		expect(inv[1][2]).toBeCloseTo(171 / 1675, 12)
		expect(inv[1][3]).toBeCloseTo(-122 / 1675, 12)
		expect(inv[1][4]).toBeCloseTo(47 / 1675, 12)
		expect(inv[2][0]).toBeCloseTo(-416 / 1005, 12)
		expect(inv[2][1]).toBeCloseTo(-193 / 1005, 12)
		expect(inv[2][2]).toBeCloseTo(878 / 5025, 12)
		expect(inv[2][3]).toBeCloseTo(343 / 1675, 12)
		expect(inv[2][4]).toBeCloseTo(496 / 5025, 12)
		expect(inv[3][0]).toBeCloseTo(-238 / 1005, 12)
		expect(inv[3][1]).toBeCloseTo(136 / 1005, 12)
		expect(inv[3][2]).toBeCloseTo(-551 / 5025, 12)
		expect(inv[3][3]).toBeCloseTo(69 / 1675, 12)
		expect(inv[3][4]).toBeCloseTo(593 / 5025, 12)
		expect(inv[4][0]).toBeCloseTo(47 / 335, 12)
		expect(inv[4][1]).toBeCloseTo(21 / 335, 12)
		expect(inv[4][2]).toBeCloseTo(-191 / 1675, 12)
		expect(inv[4][3]).toBeCloseTo(-138 / 1675, 12)
		expect(inv[4][4]).toBeCloseTo(163 / 1675, 12)

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
		// biome-ignore format: matrix
		const matrix = [[2, 7, 1], [3, -2, 0], [1, 5, 3]] as const
		const decomposition = new QrDecomposition(matrix)
		const x = decomposition.solve([1, 1, 1])

		expect(x[0]).toBeCloseTo(0.3448275862068966, 12)
		expect(x[1]).toBeCloseTo(0.017241379310344827, 12)
		expect(x[2]).toBeCloseTo(0.1896551724137931, 12)
	})

	test('4x4', () => {
		const matrix = [3 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 1 / 2, 1, 0, 0, 1, 3 / 2] as const
		const decomposition = new QrDecomposition(matrix, 4, 4)
		const x = decomposition.solve([20001, 20003, 20005, 20007])

		expect(x[0]).toBeCloseTo(8000.1714, 4)
		expect(x[1]).toBeCloseTo(8000.7429, 4)
		expect(x[2]).toBeCloseTo(8002.45714, 4)
		expect(x[3]).toBeCloseTo(8003.02857, 4)
	})

	test('5x5', () => {
		const matrix = [4, 2, 3, 1, 5, 6, 7, 2, 8, 1, 5, 9, 4, 3, 2, 8, 1, 7, 6, 5, 3, 4, 5, 2, 9] as const
		const decomposition = new QrDecomposition(matrix, 5, 5)
		const x = decomposition.solve([12, 25, 18, 30, 17])

		expect(x[0]).toBeCloseTo(1.084179104477611, 12)
		expect(x[1]).toBeCloseTo(0.17731343283582093, 12)
		expect(x[2]).toBeCloseTo(1.1982089552238815, 12)
		expect(x[3]).toBeCloseTo(1.8095522388059702, 12)
		expect(x[4]).toBeCloseTo(0.3808955223880599, 12)
	})

	test('5x2', () => {
		const matrix = [Float64Array.from([10000, 10001]), Float64Array.from([10002, 10003]), Float64Array.from([10004, 10001]), Float64Array.from([10002, 10003]), Float64Array.from([10004, 10005])] as const
		const decomposition = new QrDecomposition(matrix)
		const x = decomposition.solve([20001, 20003, 20005, 20007, 20009])

		expect(x[0]).toBeCloseTo(1, 12)
		expect(x[1]).toBeCloseTo(1, 12)
	})
})

// https://matrix.reshish.com/gauss-jordanElimination.php
test('gaussian elimination', () => {
	// biome-ignore format: matrix
	const a = [[2, 1, -1], [-3, -1, 2], [-2, 1, 2]]
	const b = [8, -11, -3]
	const x = gaussianElimination(a, b)

	expect(x[0]).toBeCloseTo(2, 12)
	expect(x[1]).toBeCloseTo(3, 12)
	expect(x[2]).toBeCloseTo(-1, 12)
})
