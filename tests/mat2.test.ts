import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { type MutMat2, mat2Clone, mat2Copy, mat2Determinant, mat2DivScalar, mat2Fill, mat2FlipX, mat2FlipY, mat2Identity, mat2Minus, mat2MinusScalar, mat2Mul, mat2MulScalar, mat2MulTranspose, mat2MulVec, mat2Negate, mat2Plus, mat2PlusScalar, mat2Rot, mat2Trace, mat2Transpose, mat2TransposeMul, mat2TransposeMulTranspose, mat2TransposeMulVec, mat2Zero } from '../src/mat2'
import type { MutVec2 } from '../src/vec2'

test('zero', () => {
	const m: MutMat2 = [1, 2, 3, 4]
	expect(mat2Zero()).toEqual([0, 0, 0, 0])
	expect(mat2Zero(m)).toBe(m)
	expect(m).toEqual([0, 0, 0, 0])
})

test('identity', () => {
	const m: MutMat2 = [2, 3, 4, 5]
	expect(mat2Identity()).toEqual([1, 0, 0, 1])
	expect(mat2Identity(m)).toBe(m)
	expect(m).toEqual([1, 0, 0, 1])
})

test('fill', () => {
	const m: MutMat2 = [0, 0, 0, 0]
	expect(mat2Fill(m, 1, 2, 3, 4)).toBe(m)
	expect(m).toEqual([1, 2, 3, 4])
})

test('determinant', () => {
	expect(mat2Determinant([1, 2, 3, 4])).toBe(-2)
	expect(mat2Determinant(mat2Identity())).toBe(1)
	expect(mat2Determinant([1, 2, 2, 4])).toBe(0)
})

test('trace', () => {
	expect(mat2Trace([1, 2, 3, 4])).toBe(5)
})

test('rot', () => {
	const m: MutMat2 = [2, 3, 3, 2]
	mat2Rot(0.3456789, m)

	expect(m[0]).toBeCloseTo(2.898197754208927, 12)
	expect(m[1]).toBeCloseTo(3.500207892850427, 12)
	expect(m[2]).toBeCloseTo(2.144865911309687, 12)
	expect(m[3]).toBeCloseTo(0.865184781897816, 12)

	expect(mat2Rot(0.3456789, mat2Identity())).toEqual(mat2Rot(0.3456789))
})

test('clone', () => {
	const m: MutMat2 = [1, 2, 3, 4]
	const n = mat2Clone(m)
	expect(n).toEqual(m)
	expect(m === n).toBeFalse()
})

test('copy', () => {
	const m = [1, 2, 3, 4] as const
	const n: MutMat2 = [0, 0, 0, 0]
	expect(mat2Copy(m, n)).toBe(n)
	expect(n).toEqual([1, 2, 3, 4])
	expect(mat2Copy(n, n)).toBe(n)
	expect(n).toEqual([1, 2, 3, 4])
})

test('transpose', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2Transpose(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([1, 3, 2, 4])
})

test('flip x', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2FlipX(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([3, 4, 1, 2])
})

test('flip y', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2FlipY(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([2, 1, 4, 3])
})

test('negate', () => {
	const m: MutMat2 = [1, 2, 3, 4]
	const n = mat2Negate(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([-1, -2, -3, -4])

	mat2Negate(m, m)
	expect(m).toEqual(n)
})

test('mul vector', () => {
	const m = [2, 3, 3, 2] as const
	const v: MutVec2 = [2, 3]
	const u = mat2MulVec(m, v)
	expect(u).not.toEqual(v)
	expect(u).toEqual([13, 12])

	mat2MulVec(m, v, v)
	expect(v).toEqual(u)
})

test('transpose mul vector', () => {
	const m = [2, 3, 3, 2] as const
	const v: MutVec2 = [2, 3]
	const u = mat2TransposeMulVec(m, v)
	expect(u).not.toEqual(v)
	expect(u).toEqual([13, 12])

	mat2TransposeMulVec(m, v, v)
	expect(v).toEqual(u)
})

test('plus scalar', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2PlusScalar(m, 1)
	expect(n).not.toEqual(m)
	expect(n).toEqual([2, 3, 4, 5])
})

test('minus scalar', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2MinusScalar(m, 1)
	expect(n).not.toEqual(m)
	expect(n).toEqual([0, 1, 2, 3])
})

test('mul scalar', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2MulScalar(m, 2)
	expect(n).not.toEqual(m)
	expect(n).toEqual([2, 4, 6, 8])
})

test('div scalar', () => {
	const m = [1, 2, 3, 4] as const
	const n = mat2DivScalar(m, 2)
	expect(n).not.toEqual(m)
	expect(n).toEqual([0.5, 1, 1.5, 2])
})

test('plus', () => {
	const m: MutMat2 = [1, 2, 3, 4]
	const n = [1, 2, 3, 4] as const
	const u = mat2Plus(m, n)
	expect(u).not.toEqual(m)
	expect(u).toEqual([2, 4, 6, 8])

	mat2Plus(m, n, m)
	expect(m).toEqual(u)
})

test('minus', () => {
	const m: MutMat2 = [1, 2, 3, 4]
	const n = [1, 2, 3, 4] as const
	const u = mat2Minus(m, n)
	expect(u).not.toEqual(m)
	expect(u).toEqual(mat2Zero())

	mat2Minus(m, n, m)
	expect(m).toEqual(u)
})

test('mul', () => {
	const m: MutMat2 = [1, 2, 3, 4]
	const n = [1, 2, 3, 4] as const
	const u = mat2Mul(m, n)
	expect(u).not.toEqual(m)
	expect(u).toEqual([7, 10, 15, 22])

	// A^T x A = symmetric matrix
	expect(mat2Mul(mat2Transpose(m), n)).toEqual([10, 14, 14, 20])

	mat2Mul(m, n, m)
	expect(m).toEqual(u)
})

describe('mul transpose', () => {
	const m = [1, 2, 3, 4] as const

	test('AT * B', () => {
		expect(mat2TransposeMul(m, m)).toEqual([10, 14, 14, 20])
	})

	test('A * BT', () => {
		expect(mat2MulTranspose(m, m)).toEqual([5, 11, 11, 25])
	})

	test('AT * BT', () => {
		expect(mat2TransposeMulTranspose(m, m)).toEqual([7, 15, 10, 22])
	})
})
