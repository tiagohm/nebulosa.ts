import { expect, test } from 'bun:test'
import { clone, determinant, flipX, flipXMut, flipY, flipYMut, identity, rotX, rotY, rotZ, transpose, transposeMut, type MutMat3 } from './matrix'

test('rotX', () => {
	const m: MutMat3 = [2, 3, 2, 3, 2, 3, 3, 4, 5]
	rotX(0.3456789, m)

	expect(m[0]).toBeCloseTo(2, 12)
	expect(m[1]).toBeCloseTo(3, 12)
	expect(m[2]).toBeCloseTo(2, 12)
	expect(m[3]).toBeCloseTo(3.83904338823561246, 12)
	expect(m[4]).toBeCloseTo(3.237033249594111899, 12)
	expect(m[5]).toBeCloseTo(4.516714379005982719, 12)
	expect(m[6]).toBeCloseTo(1.806030415924501684, 12)
	expect(m[7]).toBeCloseTo(3.085711545336372503, 12)
	expect(m[8]).toBeCloseTo(3.687721683977873065, 12)

	expect(rotX(0.3456789, identity())).toEqual(rotX(0.3456789))
})

test('rotY', () => {
	const m: MutMat3 = [2, 3, 2, 3, 2, 3, 3, 4, 5]
	rotY(0.3456789, m)

	expect(m[0]).toBeCloseTo(0.865184781897815993, 12)
	expect(m[1]).toBeCloseTo(1.467194920539316554, 12)
	expect(m[2]).toBeCloseTo(0.1875137911274457342, 12)
	expect(m[3]).toBeCloseTo(3, 12)
	expect(m[4]).toBeCloseTo(2, 12)
	expect(m[5]).toBeCloseTo(3, 12)
	expect(m[6]).toBeCloseTo(3.50020789285042733, 12)
	expect(m[7]).toBeCloseTo(4.77988902226229815, 12)
	expect(m[8]).toBeCloseTo(5.381899160903798712, 12)

	expect(rotY(0.3456789, identity())).toEqual(rotY(0.3456789))
})

test('rotZ', () => {
	const m: MutMat3 = [2, 3, 2, 3, 2, 3, 3, 4, 5]
	rotZ(0.3456789, m)

	expect(m[0]).toBeCloseTo(2.898197754208926769, 12)
	expect(m[1]).toBeCloseTo(3.50020789285042733, 12)
	expect(m[2]).toBeCloseTo(2.898197754208926769, 12)
	expect(m[3]).toBeCloseTo(2.144865911309686813, 12)
	expect(m[4]).toBeCloseTo(0.865184781897815993, 12)
	expect(m[5]).toBeCloseTo(2.144865911309686813, 12)
	expect(m[6]).toBeCloseTo(3, 12)
	expect(m[7]).toBeCloseTo(4, 12)
	expect(m[8]).toBeCloseTo(5, 12)

	expect(rotZ(0.3456789, identity())).toEqual(rotZ(0.3456789))
})

test('clone', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	const n = clone(m)
	expect(n).toEqual(m)
	expect(m === n).toBe(false)
})

test('transpose', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	const n = transpose(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9])
})

test('transposeMut', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	transposeMut(m)
	expect(m).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9])
})

test('flipX', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	const n = flipX(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3])
})

test('flipXMut', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	flipXMut(m)
	expect(m).toEqual([7, 8, 9, 4, 5, 6, 1, 2, 3])
})

test('flipY', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	const n = flipY(m)
	expect(n).not.toEqual(m)
	expect(n).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7])
})

test('flipYMut', () => {
	const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
	flipYMut(m)
	expect(m).toEqual([3, 2, 1, 6, 5, 4, 9, 8, 7])
})

test('determinant', () => {
	expect(determinant([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(0)
	expect(determinant(identity())).toBe(1)
	expect(determinant([2, 3, 2, 3, 2, 3, 3, 4, 5])).toBe(-10)
})
