import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../src/core/constants'
import { deg } from '../../../src/math/units/angle'
// oxfmt-ignore
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDistance, vecDiv, vecDivScalar, vecDot, vecLatitude, vecLength, vecLongitude, vecMinus, vecMinusScalar, vecMul, vecMulScalar, vecNegate, vecNormalize, vecNormalizeMut, vecPlane, vecPlus, vecPlusScalar, vecPolarAngle, vecRotateByRodrigues, vecRotX, vecRotY, vecRotZ, vecXAxis, vecYAxis, vecZAxis } from '../../../src/math/linear-algebra/vec3'

test('angle', () => {
	expect(vecAngle(vecXAxis(), vecYAxis())).toBe(PIOVERTWO)
	expect(vecAngle([1, 2, 3], [-1, -2, -3])).toBe(PI)
	expect(vecAngle([2, -3, 1], [4, -6, 2])).toBe(0)
	expect(vecAngle([3, 4, 5], [1, 2, 2])).toBeCloseTo(Math.acos(1.4 / Math.sqrt(2)), 14)
	expect(vecAngle([1, 1e-8, 0], [1, 0, 0])).toBeCloseTo(1e-8, 15)
	expect(vecAngle([0, 0, 0], [1, 0, 0])).toBe(0)
	expect(vecAngle([1, 0, 0], [1, 0, 0])).toBe(0)
	expect(vecAngle([1, 0, 0], [0, 1, 0])).toBe(PIOVERTWO)
	expect(vecAngle([1, 0, 0], [-1, 0, 0])).toBe(PI)
	expect(vecAngle([0, 0, 0], [1, 0, 0])).toBe(0)
	expect(vecAngle([1e308, 0, 0], [1e308, 0, 0])).toBe(0)
	expect(vecAngle([1e308, 0, 0], [0, 1e308, 0])).toBe(PIOVERTWO)
})

test('normalize', () => {
	expect(vecNormalize([3, 4, 0])).toEqual([0.6, 0.8, 0])
	expect(vecNormalize([0, 0, 0])).toEqual([0, 0, 0])

	const v: MutVec3 = [3, 4, 0]
	expect(vecNormalizeMut(v)).toBe(v)
	expect(v[0]).toBeCloseTo(0.6)
	expect(v[1]).toBeCloseTo(0.8)
	expect(v[2]).toBeCloseTo(0)
})

test('length', () => {
	expect(vecLength([3, 4, 0])).toBeCloseTo(5, 15)
	expect(vecLength([0, 0, 0])).toBe(0)
	expect(vecLength([2, 3, 6])).toBeCloseTo(7, 15)
})

test('distance', () => {
	expect(vecDistance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 15)
	expect(vecDistance([1, 2, 3], [1, 2, 3])).toBe(0)
	expect(vecDistance([1, 0, 0], [-1, 0, 0])).toBeCloseTo(2, 15)
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

	expect(vecCross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
	expect(vecCross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1])

	expect(vecDot(vecCross([1, 0, 0], [0, 1, 0]), [1, 0, 0])).toBe(0)
	expect(vecDot(vecCross([1, 0, 0], [0, 1, 0]), [0, 1, 0])).toBe(0)

	const a: MutVec3 = [1, 0, 0]
	expect(vecCross(a, [0, 1, 0], a)).toBe(a)
	expect(a).toEqual([0, 0, 1])

	const b: MutVec3 = [0, 1, 0]
	expect(vecCross([1, 0, 0], b, b)).toBe(b)
	expect(b).toEqual([0, 0, 1])
})

test('vecPolarAngle', () => {
	expect(vecPolarAngle([0, 0, 1])).toBe(0)
	expect(vecPolarAngle([0, 0, -1])).toBe(PI)
	expect(vecPolarAngle([1, 0, 0])).toBe(PIOVERTWO)
	// Must handle non-unit vectors (acos(2) would be NaN).
	expect(vecPolarAngle([0, 0, 2])).toBe(0)
	expect(vecPolarAngle([10, 0, 0])).toBe(PIOVERTWO)
})

test('vecLatitude', () => {
	expect(vecLatitude([0, 0, 1])).toBe(PIOVERTWO)
	expect(vecLatitude([1, 0, 0])).toBe(0)
	expect(vecLatitude([0, 0, -1])).toBe(-PIOVERTWO)
	expect(vecLatitude([0, 0, 2])).toBe(PIOVERTWO)
	expect(vecLatitude([10, 0, 0])).toBe(0)
	expect(vecLatitude([0, 0, -5])).toBe(-PIOVERTWO)
})

test('vecLongitude', () => {
	expect(vecLongitude([1, 0, 0])).toBe(0)
	expect(vecLongitude([0, 1, 0])).toBe(PIOVERTWO)
	expect(vecLongitude([-1, 0, 0])).toBe(PI)
	expect(vecLongitude([0, -1, 0])).toBe((3 * PI) / 2)
})

test('rotate by rodrigues', () => {
	const x = vecXAxis()
	expect(vecRotateByRodrigues(x, x, PI)).toEqual(x)

	const y = vecYAxis()
	expect(vecRotateByRodrigues(y, y, PI)).toEqual(y)

	const z = vecZAxis()
	expect(vecRotateByRodrigues(z, z, PI)).toEqual(z)

	const v: Vec3 = [1, 2, 3]
	let u = vecRotateByRodrigues(v, x, PIOVERFOUR)
	expect(u[0]).toBeCloseTo(1, 15)
	expect(u[1]).toBeCloseTo(-0.7071067811865472, 15)
	expect(u[2]).toBeCloseTo(3.5355339059327378, 15)

	u = vecRotateByRodrigues(v, y, PIOVERFOUR)
	expect(u[0]).toBeCloseTo(2.82842712474619, 15)
	expect(u[1]).toBeCloseTo(2, 15)
	expect(u[2]).toBeCloseTo(1.4142135623730954, 15)

	u = vecRotateByRodrigues(v, z, PIOVERFOUR)
	expect(u[0]).toBeCloseTo(-0.7071067811865474, 15)
	expect(u[1]).toBeCloseTo(2.121320343559643, 15)
	expect(u[2]).toBeCloseTo(3, 15)

	const o: MutVec3 = [0, 0, 0]
	u = vecRotateByRodrigues(v, [3, 4, 5], deg(29.6512852), o)
	expect(o).not.toEqual(v)
	expect(u[0]).toBeCloseTo(1.2132585570946925, 15)
	expect(u[1]).toBeCloseTo(1.7306199385433279, 15)
	expect(u[2]).toBeCloseTo(3.087548914908522, 15)

	expect(vecRotateByRodrigues(v, [0, 0, 0], PI / 3)).toEqual([1, 2, 3])
})

test('plane', () => {
	expect(vecPlane([1, -2, 1], [4, -2, -2], [4, 1, 4])).toEqual([9, -18, 9])

	expect(vecPlane([0, 0, 0], [1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
	expect(vecPlane([0, 0, 0], [0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1])

	{
		const a: MutVec3 = [0, 0, 0]
		const b: MutVec3 = [1, 0, 0]
		const c: MutVec3 = [0, 1, 0]

		expect(vecPlane(a, b, c, a)).toBe(a)
		expect(a).toEqual([0, 0, 1])
	}

	{
		const a: MutVec3 = [0, 0, 0]
		const b: MutVec3 = [1, 0, 0]
		const c: MutVec3 = [0, 1, 0]

		expect(vecPlane(a, b, c, b)).toBe(b)
		expect(b).toEqual([0, 0, 1])
	}

	{
		const a: MutVec3 = [0, 0, 0]
		const b: MutVec3 = [1, 0, 0]
		const c: MutVec3 = [0, 1, 0]

		expect(vecPlane(a, b, c, c)).toBe(c)
		expect(c).toEqual([0, 0, 1])
	}
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
