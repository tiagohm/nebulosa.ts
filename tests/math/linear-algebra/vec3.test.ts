import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../src/core/constants'
import { deg } from '../../../src/math/units/angle'
// oxfmt-ignore
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDistance, vecDiv, vecDivScalar, vecDot, vecLatitude, vecLength, vecLongitude, vecMidpoint, vecMinus, vecMinusScalar, vecMul, vecMulScalar, vecNegate, vecNormalize, vecNormalizeMut, vecPlane, vecPlus, vecPlusScalar, vecPolarAngle, vecPositionAngle, vecRotateByRodrigues, vecRotX, vecRotY, vecRotZ, vecX, vecY, vecZ, vecZero } from '../../../src/math/linear-algebra/vec3'

test('angle', () => {
	expect(vecAngle(vecX(), vecY())).toBe(PIOVERTWO)
	expect(vecAngle([1, 2, 3], [-1, -2, -3])).toBe(PI)
	expect(vecAngle([2, -3, 1], [4, -6, 2])).toBe(0)
	expect(vecAngle([3, 4, 5], [1, 2, 2])).toBeCloseTo(Math.acos(1.4 / Math.sqrt(2)), 14)
	expect(vecAngle([1, 1e-8, 0], vecX())).toBeCloseTo(1e-8, 15)
	expect(vecAngle(vecZero(), vecX())).toBe(0)
	expect(vecAngle(vecX(), vecX())).toBe(0)
	expect(vecAngle(vecX(), vecY())).toBe(PIOVERTWO)
	expect(vecAngle(vecX(), vecX(-1))).toBe(PI)
	expect(vecAngle(vecZero(), vecX())).toBe(0)
	expect(vecAngle(vecX(1e308), vecX(1e308))).toBe(0)
	expect(vecAngle(vecX(1e308), vecY(1e308))).toBe(PIOVERTWO)
})

test('normalize', () => {
	expect(vecNormalize([3, 4, 0])).toEqual([0.6, 0.8, 0])
	expect(vecNormalize(vecZero())).toEqual(vecZero())

	const v: MutVec3 = [3, 4, 0]
	expect(vecNormalizeMut(v)).toBe(v)
	expect(v[0]).toBeCloseTo(0.6)
	expect(v[1]).toBeCloseTo(0.8)
	expect(v[2]).toBeCloseTo(0)
})

test('length', () => {
	expect(vecLength([3, 4, 0])).toBeCloseTo(5, 15)
	expect(vecLength(vecZero())).toBe(0)
	expect(vecLength([2, 3, 6])).toBeCloseTo(7, 15)
})

test('distance', () => {
	expect(vecDistance(vecZero(), [3, 4, 0])).toBeCloseTo(5, 15)
	expect(vecDistance([1, 2, 3], [1, 2, 3])).toBe(0)
	expect(vecDistance(vecX(), vecX(-1))).toBeCloseTo(2, 15)
})

test('plus', () => {
	expect(vecPlusScalar([2, 3, 2], 2)).toEqual([4, 5, 4])
	expect(vecPlus([2, 3, 2], [2, 3, 2])).toEqual([4, 6, 4])
})

test('minus', () => {
	expect(vecMinusScalar([2, 3, 2], 2)).toEqual(vecY())
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

	expect(vecCross(vecX(), vecY())).toEqual(vecZ())
	expect(vecCross(vecY(), vecX())).toEqual(vecZ(-1))

	expect(vecDot(vecCross(vecX(), vecY()), vecX())).toBe(0)
	expect(vecDot(vecCross(vecX(), vecY()), vecY())).toBe(0)

	const a = vecX()
	expect(vecCross(a, vecY(), a)).toBe(a)
	expect(a).toEqual(vecZ())

	const b = vecY()
	expect(vecCross(vecX(), b, b)).toBe(b)
	expect(b).toEqual(vecZ())
})

test('vecPolarAngle', () => {
	expect(vecPolarAngle(vecZ())).toBe(0)
	expect(vecPolarAngle(vecZ(-1))).toBe(PI)
	expect(vecPolarAngle(vecX())).toBe(PIOVERTWO)
	// Must handle non-unit vectors (acos(2) would be NaN).
	expect(vecPolarAngle(vecZ(2))).toBe(0)
	expect(vecPolarAngle(vecX(10))).toBe(PIOVERTWO)
})

test('vecLatitude', () => {
	expect(vecLatitude(vecZ())).toBe(PIOVERTWO)
	expect(vecLatitude(vecX())).toBe(0)
	expect(vecLatitude(vecZ(-1))).toBe(-PIOVERTWO)
	expect(vecLatitude(vecZ(2))).toBe(PIOVERTWO)
	expect(vecLatitude(vecX(10))).toBe(0)
	expect(vecLatitude(vecZ(-5))).toBe(-PIOVERTWO)
})

test('vecLongitude', () => {
	expect(vecLongitude(vecX())).toBe(0)
	expect(vecLongitude(vecY())).toBe(PIOVERTWO)
	expect(vecLongitude(vecX(-1))).toBe(PI)
	expect(vecLongitude(vecY(-1))).toBe((3 * PI) / 2)
})

test('rotate by rodrigues', () => {
	const x = vecX()
	expect(vecRotateByRodrigues(x, x, PI)).toEqual(x)

	const y = vecY()
	expect(vecRotateByRodrigues(y, y, PI)).toEqual(y)

	const z = vecZ()
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

	const o = vecZero()
	u = vecRotateByRodrigues(v, [3, 4, 5], deg(29.6512852), o)
	expect(o).not.toEqual(v)
	expect(u[0]).toBeCloseTo(1.2132585570946925, 15)
	expect(u[1]).toBeCloseTo(1.7306199385433279, 15)
	expect(u[2]).toBeCloseTo(3.087548914908522, 15)

	expect(vecRotateByRodrigues(v, vecZero(), PI / 3)).toEqual([1, 2, 3])
})

test('plane', () => {
	expect(vecPlane([1, -2, 1], [4, -2, -2], [4, 1, 4])).toEqual([9, -18, 9])

	expect(vecPlane(vecZero(), vecX(), vecY())).toEqual(vecZ())
	expect(vecPlane(vecZero(), vecY(), vecX())).toEqual(vecZ(-1))

	{
		const a = vecZero()
		const b = vecX()
		const c = vecY()

		expect(vecPlane(a, b, c, a)).toBe(a)
		expect(a).toEqual(vecZ())
	}

	{
		const a = vecZero()
		const b = vecX()
		const c = vecY()

		expect(vecPlane(a, b, c, b)).toBe(b)
		expect(b).toEqual(vecZ())
	}

	{
		const a = vecZero()
		const b = vecX()
		const c = vecY()

		expect(vecPlane(a, b, c, c)).toBe(c)
		expect(c).toEqual(vecZ())
	}
})

test('rotate around X', () => {
	const v = vecRotX(vecY(), PIOVERTWO)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(1, 15)
})

test('rotate around Y', () => {
	const v = vecRotY(vecX(), PIOVERTWO)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(-1, 15)
})

test('rotate around Z', () => {
	const v = vecRotZ(vecY(), PI)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(-1, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('position angle', () => {
	expect(vecPositionAngle([1, 0.1, 0.2], [-3, 1e-3, 0.2])).toBeCloseTo(0.3671514267841113674, 13)
})

test('normalized midpoint and output aliasing', () => {
	const a = vecX()
	const b = vecY()
	const result = vecMidpoint(a, b)
	expect(result).not.toBe(a)
	expect(result).not.toBe(b)
	expect(result[0]).toBeCloseTo(Math.SQRT1_2, 15)
	expect(result[1]).toBeCloseTo(Math.SQRT1_2, 15)
	expect(Math.hypot(...result)).toBeCloseTo(1, 15)
	expect(vecAngle(a, result)).toBeCloseTo(PIOVERFOUR, 15)
	expect(vecAngle(b, result)).toBeCloseTo(PIOVERFOUR, 15)
	const out = vecZero()
	expect(vecMidpoint(a, b, out)).toBe(out)
	expect(out).toEqual(result)
	expect(vecMidpoint(a, b, a)).toBe(a)
	expect(a).toEqual(result)
	expect(vecMidpoint(vecX(), b, b)).toBe(b)
	expect(b).toEqual(result)
})

test('midpoint degeneracies and extreme finite magnitudes', () => {
	expect(vecMidpoint(vecZero(), vecZero())).toEqual(vecZero())
	expect(vecMidpoint([1, 2, 0], [-1, -2, 0])).toEqual(vecZero())
	expect(vecMidpoint(vecZero(), [3, 4, 0])).toEqual([0.6, 0.8, 0])
	expect(vecMidpoint(vecX(), [-1, Number.MIN_VALUE, 0])).toEqual(vecY())
	for (const magnitude of [1, 1e-300, Number.MIN_VALUE, 1e308, Number.MAX_VALUE]) {
		const same = vecMidpoint([magnitude, magnitude, 0], [magnitude, magnitude, 0])
		expect(same[0]).toBeCloseTo(Math.SQRT1_2, 15)
		expect(same[1]).toBeCloseTo(Math.SQRT1_2, 15)
		expect(Math.hypot(...same)).toBeCloseTo(1, 15)
	}
	const residual = vecMidpoint([Number.MAX_VALUE, 1, 0], [-Number.MAX_VALUE, 1, 0])
	expect(residual).toEqual(vecY())
})

test('midpoint uses all three components', () => {
	const a: Vec3 = vecX()
	const b: Vec3 = vecZ()
	const result = vecMidpoint(a, b)
	expect(result[0]).toBeCloseTo(Math.SQRT1_2, 15)
	expect(result[1]).toBe(0)
	expect(result[2]).toBeCloseTo(Math.SQRT1_2, 15)
	for (const magnitude of [Number.MIN_VALUE, Number.MAX_VALUE]) {
		const diagonal = vecMidpoint([magnitude, magnitude, magnitude], [magnitude, magnitude, magnitude])
		for (const component of diagonal) expect(component).toBeCloseTo(1 / Math.sqrt(3), 15)
	}
	expect(vecMidpoint(vecX(), [-1, 0, Number.MIN_VALUE])).toEqual(vecZ())
	const unequal = vecMidpoint(vecX(2), vecZ())
	expect(unequal[0]).toBeCloseTo(2 / Math.sqrt(5), 15)
	expect(unequal[2]).toBeCloseTo(1 / Math.sqrt(5), 15)
})
