import { expect, test } from 'bun:test'
import { Mat3 } from '../src/matrix'
import type { Vector3 } from '../src/vector'

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

	Mat3.mul(m, n, m)
	expect(m).toEqual(u)
})
