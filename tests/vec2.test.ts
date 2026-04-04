import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../src/constants'
import { type MutVec2, vec2Angle, vec2Cross, vec2CrossLength, vec2Distance, vec2Div, vec2DivScalar, vec2Dot, vec2Longitude, vec2Minus, vec2MinusScalar, vec2Mul, vec2MulScalar, vec2Negate, vec2Normalize, vec2Plus, vec2PlusScalar, vec2Rot, vec2XAxis, vec2YAxis } from '../src/vec2'

test('angle', () => {
	expect(vec2Angle(vec2XAxis(), vec2YAxis())).toBeCloseTo(PIOVERTWO, 15)
	expect(vec2Angle([1, 2], [-1, -2])).toBeCloseTo(PI, 15)
	expect(vec2Angle([2, -3], [4, -6])).toBeCloseTo(0, 15)
	expect(vec2Angle([3, 4], [1, 2])).toBeCloseTo(Math.acos(11 / Math.sqrt(125)), 15)
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

test('rotate', () => {
	const v = vec2Rot([0, 1], PI)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(-1, 15)

	const o: MutVec2 = [0, 0]
	vec2Rot([1, 0], PIOVERTWO, o)
	expect(o[0]).toBeCloseTo(0, 15)
	expect(o[1]).toBeCloseTo(1, 15)
})
