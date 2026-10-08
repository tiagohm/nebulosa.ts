import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../src/core/constants'
import { type MutVec2, vec2Angle, vec2Cross, vec2CrossLength, vec2Distance, vec2Div, vec2DivScalar, vec2Dot, vec2Longitude, vec2Midpoint, vec2Minus, vec2MinusScalar, vec2Mul, vec2MulScalar, vec2Negate, vec2Normalize, vec2Plus, vec2PlusScalar, vec2Rot, vec2XAxis, vec2YAxis } from '../../../src/math/linear-algebra/vec2'

test('angle', () => {
	expect(vec2Angle(vec2XAxis(), vec2YAxis())).toBeCloseTo(PIOVERTWO, 15)
	expect(vec2Angle([1, 2], [-1, -2])).toBeCloseTo(PI, 15)
	expect(vec2Angle([2, -3], [4, -6])).toBeCloseTo(0, 15)
	expect(vec2Angle([3, 4], [1, 2])).toBeCloseTo(Math.acos(11 / Math.sqrt(125)), 15)
	expect(vec2Angle([1, 1e-8], [1, 0])).toBeCloseTo(1e-8, 15)
	expect(vec2Angle([1e308, 0], [1e308, 0])).toBe(0)
	expect(vec2Angle([1e308, 0], [0, 1e308])).toBe(PIOVERTWO)
	expect(vec2Angle([1e200, 1e200], [1e200, 1e199])).toBeCloseTo(0.685729510906286, 12)
	expect(vec2Angle([1e-200, 0], [1e-200, 1e-200])).toBeCloseTo(PIOVERFOUR, 15)
})

test('normalize', () => {
	const a = Math.sqrt(13)
	expect(vec2Normalize([3, 2])).toEqual([3 / a, 2 / a])

	const o: MutVec2 = [0, 0]
	expect(vec2Normalize(o)).toEqual([0, 0])

	vec2Normalize([3, 2], o)
	expect(o[0]).toBeCloseTo(3 / a, 15)
	expect(o[1]).toBeCloseTo(2 / a, 15)
})

test('plus', () => {
	expect(vec2PlusScalar([2, 3], 2)).toEqual([4, 5])
	expect(vec2Plus([2, 3], [2, 3])).toEqual([4, 6])
})

test('minus', () => {
	expect(vec2MinusScalar([2, 3], 2)).toEqual([0, 1])
	expect(vec2Minus([2, 3], [-2, -3])).toEqual([4, 6])
})

test('mul', () => {
	expect(vec2MulScalar([2, 3], 2)).toEqual([4, 6])
	expect(vec2Mul([2, 3], [2, 3])).toEqual([4, 9])
})

test('div', () => {
	expect(vec2DivScalar([2, 3], 2)).toEqual([1, 1.5])
	expect(vec2Div([2, 3], [2, 3])).toEqual([1, 1])
})

test('dot', () => {
	expect(vec2Dot([2, 3], [2, 3])).toBe(13)
	expect(vec2Dot([2, 3], vec2Negate([2, 3]))).toBe(-13)
})

test('cross', () => {
	expect(vec2Cross([2, 3], [3, 2])).toBe(-5)
	expect(vec2CrossLength([2, 3], [3, 2])).toBe(5)
})

test('distance', () => {
	expect(vec2Distance([3, 4], [0, 0])).toBeCloseTo(5, 15)
})

test('longitude', () => {
	expect(vec2Longitude(vec2XAxis())).toBeCloseTo(0, 15)
	expect(vec2Longitude(vec2YAxis())).toBeCloseTo(PIOVERTWO, 15)
	expect(vec2Longitude([0, -1])).toBeCloseTo((3 * PI) / 2, 15)
})

test('arithmetic operations write into and return the output vector', () => {
	const o: MutVec2 = [0, 0]

	expect(vec2Plus([2, 3], [4, 5], o)).toBe(o)
	expect(o).toEqual([6, 8])

	const a: MutVec2 = [2, 3]
	// In-place accumulation: output aliasing the first input must be correct.
	vec2Mul(a, [2, 2], a)
	expect(a).toEqual([4, 6])
})

test('rotate', () => {
	const v = vec2Rot([0, 1], PI)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(-1, 15)

	const o: MutVec2 = [0, 0]
	vec2Rot([1, 0], PIOVERTWO, o)
	expect(o[0]).toBeCloseTo(0, 15)
	expect(o[1]).toBeCloseTo(1, 15)

	const a: MutVec2 = [1, 0]
	expect(vec2Rot(a, PIOVERTWO, a)).toBe(a)
	expect(a[0]).toBeCloseTo(0, 15)
	expect(a[1]).toBeCloseTo(1, 15)
})

test('normalized midpoint and output aliasing', () => {
	const a: MutVec2 = [1, 0]
	const b: MutVec2 = [0, 1]
	const result = vec2Midpoint(a, b)
	expect(result).not.toBe(a)
	expect(result).not.toBe(b)
	expect(result[0]).toBeCloseTo(Math.SQRT1_2, 15)
	expect(result[1]).toBeCloseTo(Math.SQRT1_2, 15)
	expect(Math.hypot(...result)).toBeCloseTo(1, 15)
	expect(vec2Angle(a, result)).toBeCloseTo(PIOVERFOUR, 15)
	expect(vec2Angle(b, result)).toBeCloseTo(PIOVERFOUR, 15)
	const out: MutVec2 = [0, 0]
	expect(vec2Midpoint(a, b, out)).toBe(out)
	expect(out).toEqual(result)
	expect(vec2Midpoint(a, b, a)).toBe(a)
	expect(a).toEqual(result)
	expect(vec2Midpoint([1, 0], b, b)).toBe(b)
	expect(b).toEqual(result)
})

test('midpoint degeneracies and extreme finite magnitudes', () => {
	expect(vec2Midpoint([0, 0], [0, 0])).toEqual([0, 0])
	expect(vec2Midpoint([1, 2], [-1, -2])).toEqual([0, 0])
	expect(vec2Midpoint([0, 0], [3, 4])).toEqual([0.6, 0.8])
	expect(vec2Midpoint([1, 0], [-1, Number.MIN_VALUE])).toEqual([0, 1])
	for (const magnitude of [1, 1e-300, Number.MIN_VALUE, 1e308, Number.MAX_VALUE]) {
		const same = vec2Midpoint([magnitude, magnitude], [magnitude, magnitude])
		expect(same[0]).toBeCloseTo(Math.SQRT1_2, 15)
		expect(same[1]).toBeCloseTo(Math.SQRT1_2, 15)
		expect(Math.hypot(...same)).toBeCloseTo(1, 15)
	}
	const residual = vec2Midpoint([Number.MAX_VALUE, 1], [-Number.MAX_VALUE, 1])
	expect(residual).toEqual([0, 1])
})
