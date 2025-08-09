import { describe, expect, test } from 'bun:test'
// biome-ignore format: too long!
import { type MutMat3, matClone, matDeterminant, matDivScalar, matFlipX, matFlipY, matIdentity, matMinus, matMinusScalar, matMul, matMulScalar, matMulVec, matPlus, matPlusScalar, matRotX, matRotY, matRotZ, matTranspose, matZero } from '../src/mat3'
import type { MutVec3 } from '../src/vec3'

describe('Mat3', () => {
	test('determinant', () => {
		expect(matDeterminant([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(0)
		expect(matDeterminant(matIdentity())).toBe(1)
		expect(matDeterminant([2, 3, 2, 3, 2, 3, 3, 4, 5])).toBe(-10)
	})

	test('rotX', () => {
		const m: MutMat3 = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		matRotX(0.3456789, m)

		expect(m[0]).toBeCloseTo(2, 12)
		expect(m[1]).toBeCloseTo(3, 12)
		expect(m[2]).toBeCloseTo(2, 12)
		expect(m[3]).toBeCloseTo(3.83904338823561246, 12)
		expect(m[4]).toBeCloseTo(3.237033249594111899, 12)
		expect(m[5]).toBeCloseTo(4.516714379005982719, 12)
		expect(m[6]).toBeCloseTo(1.806030415924501684, 12)
		expect(m[7]).toBeCloseTo(3.085711545336372503, 12)
		expect(m[8]).toBeCloseTo(3.687721683977873065, 12)

		expect(matRotX(0.3456789, matIdentity())).toEqual(matRotX(0.3456789))
	})

	test('rotY', () => {
		const m: MutMat3 = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		matRotY(0.3456789, m)

		expect(m[0]).toBeCloseTo(0.865184781897815993, 12)
		expect(m[1]).toBeCloseTo(1.467194920539316554, 12)
		expect(m[2]).toBeCloseTo(0.1875137911274457342, 12)
		expect(m[3]).toBeCloseTo(3, 12)
		expect(m[4]).toBeCloseTo(2, 12)
		expect(m[5]).toBeCloseTo(3, 12)
		expect(m[6]).toBeCloseTo(3.50020789285042733, 12)
		expect(m[7]).toBeCloseTo(4.77988902226229815, 12)
		expect(m[8]).toBeCloseTo(5.381899160903798712, 12)

		expect(matRotY(0.3456789, matIdentity())).toEqual(matRotY(0.3456789))
	})

	test('rotZ', () => {
		const m: MutMat3 = [2, 3, 2, 3, 2, 3, 3, 4, 5]
		matRotZ(0.3456789, m)

		expect(m[0]).toBeCloseTo(2.898197754208926769, 12)
		expect(m[1]).toBeCloseTo(3.50020789285042733, 12)
		expect(m[2]).toBeCloseTo(2.898197754208926769, 12)
		expect(m[3]).toBeCloseTo(2.144865911309686813, 12)
		expect(m[4]).toBeCloseTo(0.865184781897815993, 12)
		expect(m[5]).toBeCloseTo(2.144865911309686813, 12)
		expect(m[6]).toBeCloseTo(3, 12)
		expect(m[7]).toBeCloseTo(4, 12)
		expect(m[8]).toBeCloseTo(5, 12)

		expect(matRotZ(0.3456789, matIdentity())).toEqual(matRotZ(0.3456789))
	})

	test('clone', () => {
		const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = matClone(m)
		expect(n).toEqual(m)
		expect(m === n).toBe(false)
	})

	test('transpose', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matTranspose(m)
		expect(n).not.toEqual(m)
		expect(n).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9])
	})

	test('flipX', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matFlipX(m)
		expect(n).not.toEqual(m)
		expect(n).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3])
	})

	test('flipY', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matFlipY(m)
		expect(n).not.toEqual(m)
		expect(n).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7])
	})

	test('mulVec', () => {
		const m = [2, 3, 2, 3, 2, 3, 3, 4, 5] as const
		const v: MutVec3 = [2, 3, 2]
		const u = matMulVec(m, v)
		expect(u).not.toEqual(v)
		expect(u).toEqual([17, 18, 28])

		matMulVec(m, v, v)
		expect(v).toEqual(u)
	})

	test('plusScalar', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matPlusScalar(m, 1)
		expect(n).not.toEqual(m)
		expect(n).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])
	})

	test('minusScalar', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matMinusScalar(m, 1)
		expect(n).not.toEqual(m)
		expect(n).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
	})

	test('mulScalar', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matMulScalar(m, 2)
		expect(n).not.toEqual(m)
		expect(n).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
	})

	test('divScalar', () => {
		const m = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const n = matDivScalar(m, 2)
		expect(n).not.toEqual(m)
		expect(n).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5])
	})

	test('plus', () => {
		const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const u = matPlus(m, n)
		expect(u).not.toEqual(m)
		expect(u).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])

		matPlus(m, n, m)
		expect(m).toEqual(u)
	})

	test('minus', () => {
		const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const u = matMinus(m, n)
		expect(u).not.toEqual(m)
		expect(u).toEqual(matZero())

		matMinus(m, n, m)
		expect(m).toEqual(u)
	})

	test('mul', () => {
		const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
		const n = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const
		const u = matMul(m, n)
		expect(u).not.toEqual(m)
		expect(u).toEqual([30, 36, 42, 66, 81, 96, 102, 126, 150])

		// Aᵀ x A = symmetric matrix
		expect(matMul(matTranspose(m), n)).toEqual([66, 78, 90, 78, 93, 108, 90, 108, 126])

		matMul(m, n, m)
		expect(m).toEqual(u)
	})
})
