import { expect, test } from 'bun:test'
import { spline, splineGivenEnds } from '../src/spline'

test('constant', () => {
	const c = Math.random() + 0.5
	const s = spline(0, 1, [c])

	expect(s.compute(8)).toBeCloseTo(c, 15)
})

test('degree 1', () => {
	const s = spline(0, 1, [1, 5])

	expect(s.compute(0.5)).toBeCloseTo(5.5, 15)
})

test('degree 2', () => {
	const s = spline(0, 1, [3, 8, 5])

	expect(s.compute(0.5)).toBeCloseTo(9.75, 15)
})

test('derivative', () => {
	const s = spline(0, 1, [3, 8, 5])
	const d = s.derivative()

	expect(d.coefficients).toHaveLength(2)
	expect(d.coefficients[0]).toBeCloseTo(6, 15)
	expect(d.coefficients[1]).toBeCloseTo(8, 15)
	expect(d.compute(0.5)).toBeCloseTo(11, 15)
})

test('derivative of derivative', () => {
	const s = spline(0, 1, [3, 8, 5])
	const d = s.derivative().derivative()

	expect(d.coefficients).toHaveLength(1)
	expect(d.coefficients[0]).toBeCloseTo(6, 15)
	expect(d.compute(0.5)).toBeCloseTo(6, 15)
})

test('derivative of constant', () => {
	const d = spline(-5, 4, [7]).derivative()

	expect(d.coefficients).toHaveLength(1)
	expect(d.coefficients[0]).toBeCloseTo(0, 15)
	expect(d.compute(2)).toBeCloseTo(0, 15)
})

test('integral', () => {
	const s = spline(2, 6, [3, 8, 5])
	const i = s.integral(-7)

	expect(i.coefficients).toHaveLength(4)
	expect(i.coefficients[0]).toBeCloseTo(4, 15)
	expect(i.coefficients[1]).toBeCloseTo(16, 15)
	expect(i.coefficients[2]).toBeCloseTo(20, 15)
	expect(i.coefficients[3]).toBeCloseTo(-7, 15)
	expect(i.compute(2)).toBeCloseTo(-7, 15)
	expect(i.compute(4)).toBeCloseTo(7.5, 15)
	expect(i.derivative().compute(4)).toBeCloseTo(s.compute(4), 15)
})

test('given ends', () => {
	const s = splineGivenEnds(2, 3, -0.5, 5, 11, 2)
	const d = s.derivative()

	expect(s.compute(2)).toBeCloseTo(3, 15)
	expect(s.compute(5)).toBeCloseTo(11, 15)
	expect(d.compute(2)).toBeCloseTo(-0.5, 15)
	expect(d.compute(5)).toBeCloseTo(2, 15)
})

test('invalid input', () => {
	expect(() => spline(1, 1, [2])).toThrow(RangeError)
	expect(() => spline(0, 1, [])).toThrow(RangeError)
})
