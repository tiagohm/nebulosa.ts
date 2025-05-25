import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PI, PIOVERTWO } from '../src/constants'
import { Vector3 } from '../src/vector'

test('angle', () => {
	expect(Vector3.angle(Vector3.xAxis(), Vector3.yAxis())).toBe(PIOVERTWO)
	expect(Vector3.angle([1, 2, 3], [-1, -2, -3])).toBe(PI)
	expect(Vector3.angle([2, -3, 1], [4, -6, 2])).toBe(0)
	expect(Vector3.angle([3, 4, 5], [1, 2, 2])).toBeCloseTo(Math.acos(1.4 / Math.sqrt(2)), 14)
})

test('normalize', () => {
	const a = Math.sqrt(14)
	expect(Vector3.normalize([3, 2, -1])).toEqual([3 / a, 2 / a, -1 / a])

	const o: Vector3.Vector = [0, 0, 0]
	expect(Vector3.normalize(o)).toEqual([0, 0, 0])

	Vector3.normalize([3, 2, -1], o)
	expect(o).not.toEqual(a)
	expect(o).toEqual([3 / a, 2 / a, -1 / a])
})

test('plus', () => {
	expect(Vector3.plusScalar([2, 3, 2], 2)).toEqual([4, 5, 4])
	expect(Vector3.plus([2, 3, 2], [2, 3, 2])).toEqual([4, 6, 4])
})

test('minus', () => {
	expect(Vector3.minusScalar([2, 3, 2], 2)).toEqual([0, 1, 0])
	expect(Vector3.minus([2, 3, 2], [-2, -3, -2])).toEqual([4, 6, 4])
})

test('mul', () => {
	expect(Vector3.mulScalar([2, 3, 2], 2)).toEqual([4, 6, 4])
	expect(Vector3.mul([2, 3, 2], [2, 3, 2])).toEqual([4, 9, 4])
})

test('div', () => {
	expect(Vector3.divScalar([2, 3, 2], 2)).toEqual([1, 1.5, 1])
	expect(Vector3.div([2, 3, 2], [2, 3, 2])).toEqual([1, 1, 1])
})

test('dot', () => {
	expect(Vector3.dot([2, 3, 2], [2, 3, 2])).toBe(17)
	expect(Vector3.dot([2, 3, 2], Vector3.negate([2, 3, 2]))).toBe(-17)
})

test('cross', () => {
	expect(Vector3.cross([2, 3, 2], [3, 2, 3])).toEqual([5, 0, -5])
})

test('rotateByRodrigues', () => {
	const x = Vector3.xAxis()
	expect(Vector3.rotateByRodrigues(x, x, PI)).toEqual(x)

	const y = Vector3.yAxis()
	expect(Vector3.rotateByRodrigues(y, y, PI)).toEqual(y)

	const z = Vector3.zAxis()
	expect(Vector3.rotateByRodrigues(z, z, PI)).toEqual(z)

	const v: Vector3.Vector = [1, 2, 3]
	let u = Vector3.rotateByRodrigues(v, x, PI / 4)
	expect(u[0]).toBeCloseTo(1, 15)
	expect(u[1]).toBeCloseTo(-0.7071067811865472, 15)
	expect(u[2]).toBeCloseTo(3.5355339059327378, 15)

	u = Vector3.rotateByRodrigues(v, y, PI / 4)
	expect(u[0]).toBeCloseTo(2.82842712474619, 15)
	expect(u[1]).toBeCloseTo(2, 15)
	expect(u[2]).toBeCloseTo(1.4142135623730954, 15)

	u = Vector3.rotateByRodrigues(v, z, PI / 4)
	expect(u[0]).toBeCloseTo(-0.7071067811865474, 15)
	expect(u[1]).toBeCloseTo(2.121320343559643, 15)
	expect(u[2]).toBeCloseTo(3, 15)

	const o: Vector3.Vector = [0, 0, 0]
	u = Vector3.rotateByRodrigues(v, [3, 4, 5], deg(29.6512852), o)
	expect(o).not.toEqual(v)
	expect(u[0]).toBeCloseTo(1.2132585570946925, 15)
	expect(u[1]).toBeCloseTo(1.7306199385433279, 15)
	expect(u[2]).toBeCloseTo(3.087548914908522, 15)
})

test('plane', () => {
	expect(Vector3.plane([1, -2, 1], [4, -2, -2], [4, 1, 4])).toEqual([9, -18, 9])
})
