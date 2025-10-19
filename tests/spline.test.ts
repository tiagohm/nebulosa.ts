import { expect, test } from 'bun:test'
import { spline } from '../src/spline'

test('constant', () => {
	const c = Math.random() + 0.5
	const s = spline(0, 1, [c])

	expect(s.compute(8)).toBe(c)
})

test('degree 1', () => {
	const s = spline(0, 1, [1, 5])

	expect(s.compute(0.5)).toBe(5.5)
})

test('degree 2', () => {
	const s = spline(0, 1, [3, 8, 5])

	expect(s.compute(0.5)).toBe(9.75)
})

test('derivative', () => {
	const s = spline(0, 1, [3, 8, 5])
	const d = s.derivative()

	expect(d.coefficients).toHaveLength(2)
	expect(d.coefficients[0]).toBe(6)
	expect(d.coefficients[1]).toBe(8)
	expect(d.compute(0.5)).toBe(11)
})

test('derivative of derivative', () => {
	const s = spline(0, 1, [3, 8, 5])
	const d = s.derivative().derivative()

	expect(d.coefficients).toHaveLength(1)
	expect(d.coefficients[0]).toBe(6)
	expect(d.compute(0.5)).toBe(6)
})
