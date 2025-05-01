import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PI, PIOVERTWO } from '../src/constants'
import { type MutVec3, type Vec3, angleBetween, cross, divVec, divVecScalar, dot, minusVec, minusVecScalar, mulVec, mulVecScalar, negateVec, normalizeVec, plane, plusVec, plusVecScalar, rotateByRodrigues, xAxis, yAxis, zAxis } from '../src/vector'

test('angleBetween', () => {
	expect(angleBetween(xAxis(), yAxis())).toBe(PIOVERTWO)
	expect(angleBetween([1, 2, 3], [-1, -2, -3])).toBe(PI)
	expect(angleBetween([2, -3, 1], [4, -6, 2])).toBe(0)
	expect(angleBetween([3, 4, 5], [1, 2, 2])).toBeCloseTo(Math.acos(1.4 / Math.sqrt(2)), 14)
})

test('normalize', () => {
	const a = Math.sqrt(14)
	expect(normalizeVec([3, 2, -1])).toEqual([3 / a, 2 / a, -1 / a])

	const o: MutVec3 = [0, 0, 0]
	expect(normalizeVec(o)).toEqual([0, 0, 0])

	normalizeVec([3, 2, -1], o)
	expect(o).not.toEqual(a)
	expect(o).toEqual([3 / a, 2 / a, -1 / a])
})

test('plus', () => {
	expect(plusVecScalar([2, 3, 2], 2)).toEqual([4, 5, 4])
	expect(plusVec([2, 3, 2], [2, 3, 2])).toEqual([4, 6, 4])
})

test('minus', () => {
	expect(minusVecScalar([2, 3, 2], 2)).toEqual([0, 1, 0])
	expect(minusVec([2, 3, 2], [-2, -3, -2])).toEqual([4, 6, 4])
})

test('mul', () => {
	expect(mulVecScalar([2, 3, 2], 2)).toEqual([4, 6, 4])
	expect(mulVec([2, 3, 2], [2, 3, 2])).toEqual([4, 9, 4])
})

test('div', () => {
	expect(divVecScalar([2, 3, 2], 2)).toEqual([1, 1.5, 1])
	expect(divVec([2, 3, 2], [2, 3, 2])).toEqual([1, 1, 1])
})

test('dot', () => {
	expect(dot([2, 3, 2], [2, 3, 2])).toBe(17)
	expect(dot([2, 3, 2], negateVec([2, 3, 2]))).toBe(-17)
})

test('cross', () => {
	expect(cross([2, 3, 2], [3, 2, 3])).toEqual([5, 0, -5])
})

test('rotateByRodrigues', () => {
	const x = xAxis()
	expect(rotateByRodrigues(x, x, PI)).toEqual(x)

	const y = yAxis()
	expect(rotateByRodrigues(y, y, PI)).toEqual(y)

	const z = zAxis()
	expect(rotateByRodrigues(z, z, PI)).toEqual(z)

	const v: Vec3 = [1, 2, 3]
	let u = rotateByRodrigues(v, x, PI / 4)
	expect(u[0]).toBeCloseTo(1, 15)
	expect(u[1]).toBeCloseTo(-0.7071067811865472, 15)
	expect(u[2]).toBeCloseTo(3.5355339059327378, 15)

	u = rotateByRodrigues(v, y, PI / 4)
	expect(u[0]).toBeCloseTo(2.82842712474619, 15)
	expect(u[1]).toBeCloseTo(2, 15)
	expect(u[2]).toBeCloseTo(1.4142135623730954, 15)

	u = rotateByRodrigues(v, z, PI / 4)
	expect(u[0]).toBeCloseTo(-0.7071067811865474, 15)
	expect(u[1]).toBeCloseTo(2.121320343559643, 15)
	expect(u[2]).toBeCloseTo(3, 15)

	const o: MutVec3 = [0, 0, 0]
	u = rotateByRodrigues(v, [3, 4, 5], deg(29.6512852), o)
	expect(o).not.toEqual(v)
	expect(u[0]).toBeCloseTo(1.2132585570946925, 15)
	expect(u[1]).toBeCloseTo(1.7306199385433279, 15)
	expect(u[2]).toBeCloseTo(3.087548914908522, 15)
})

test('plane', () => {
	expect(plane([1, -2, 1], [4, -2, -2], [4, 1, 4])).toEqual([9, -18, 9])
})
