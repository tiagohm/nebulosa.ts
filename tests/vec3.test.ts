import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PI, PIOVERTWO } from '../src/constants'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDiv, vecDivScalar, vecDot, vecMinus, vecMinusScalar, vecMul, vecMulScalar, vecNegate, vecNormalize, vecPlane, vecPlus, vecPlusScalar, vecRotateByRodrigues, vecRotX, vecRotY, vecRotZ, vecXAxis, vecYAxis, vecZAxis } from '../src/vec3'

test('angle', () => {
	expect(vecAngle(vecXAxis(), vecYAxis())).toBe(PIOVERTWO)
	expect(vecAngle([1, 2, 3], [-1, -2, -3])).toBe(PI)
	expect(vecAngle([2, -3, 1], [4, -6, 2])).toBe(0)
	expect(vecAngle([3, 4, 5], [1, 2, 2])).toBeCloseTo(Math.acos(1.4 / Math.sqrt(2)), 14)
})

test('normalize', () => {
	const a = Math.sqrt(14)
	expect(vecNormalize([3, 2, -1])).toEqual([3 / a, 2 / a, -1 / a])

	const o: MutVec3 = [0, 0, 0]
	expect(vecNormalize(o)).toEqual([0, 0, 0])

	vecNormalize([3, 2, -1], o)
	expect(o).not.toEqual(a)
	expect(o).toEqual([3 / a, 2 / a, -1 / a])
})

test('plus', () => {
	expect(vecPlusScalar([2, 3, 2], 2)).toEqual([4, 5, 4])
	expect(vecPlus([2, 3, 2], [2, 3, 2])).toEqual([4, 6, 4])
})

test('minus', () => {
	expect(vecMinusScalar([2, 3, 2], 2)).toEqual([0, 1, 0])
	expect(vecMinus([2, 3, 2], [-2, -3, -2])).toEqual([4, 6, 4])
})

test('mul', () => {
	expect(vecMulScalar([2, 3, 2], 2)).toEqual([4, 6, 4])
	expect(vecMul([2, 3, 2], [2, 3, 2])).toEqual([4, 9, 4])
})

test('div', () => {
	expect(vecDivScalar([2, 3, 2], 2)).toEqual([1, 1.5, 1])
	expect(vecDiv([2, 3, 2], [2, 3, 2])).toEqual([1, 1, 1])
})

test('dot', () => {
	expect(vecDot([2, 3, 2], [2, 3, 2])).toBe(17)
	expect(vecDot([2, 3, 2], vecNegate([2, 3, 2]))).toBe(-17)
})

test('cross', () => {
	expect(vecCross([2, 3, 2], [3, 2, 3])).toEqual([5, 0, -5])
})

test('rotate by rodrigues', () => {
	const x = vecXAxis()
	expect(vecRotateByRodrigues(x, x, PI)).toEqual(x)

	const y = vecYAxis()
	expect(vecRotateByRodrigues(y, y, PI)).toEqual(y)

	const z = vecZAxis()
	expect(vecRotateByRodrigues(z, z, PI)).toEqual(z)

	const v: Vec3 = [1, 2, 3]
	let u = vecRotateByRodrigues(v, x, PI / 4)
	expect(u[0]).toBeCloseTo(1, 15)
	expect(u[1]).toBeCloseTo(-0.7071067811865472, 15)
	expect(u[2]).toBeCloseTo(3.5355339059327378, 15)

	u = vecRotateByRodrigues(v, y, PI / 4)
	expect(u[0]).toBeCloseTo(2.82842712474619, 15)
	expect(u[1]).toBeCloseTo(2, 15)
	expect(u[2]).toBeCloseTo(1.4142135623730954, 15)

	u = vecRotateByRodrigues(v, z, PI / 4)
	expect(u[0]).toBeCloseTo(-0.7071067811865474, 15)
	expect(u[1]).toBeCloseTo(2.121320343559643, 15)
	expect(u[2]).toBeCloseTo(3, 15)

	const o: MutVec3 = [0, 0, 0]
	u = vecRotateByRodrigues(v, [3, 4, 5], deg(29.6512852), o)
	expect(o).not.toEqual(v)
	expect(u[0]).toBeCloseTo(1.2132585570946925, 15)
	expect(u[1]).toBeCloseTo(1.7306199385433279, 15)
	expect(u[2]).toBeCloseTo(3.087548914908522, 15)
})

test('plane', () => {
	expect(vecPlane([1, -2, 1], [4, -2, -2], [4, 1, 4])).toEqual([9, -18, 9])
})

test('rotate around X', () => {
	const v = vecRotX([0, 1, 0], PIOVERTWO)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(1, 15)
})

test('rotate around Y', () => {
	const v = vecRotY([1, 0, 0], PIOVERTWO)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(-1, 15)
})

test('rotate around Z', () => {
	const v = vecRotZ([0, 1, 0], PI)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(-1, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})
