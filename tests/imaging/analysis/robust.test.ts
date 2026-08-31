import { expect, test } from 'bun:test'
import { ROBUST_SAMPLE_CAPACITY, RobustReservoir } from '../../../src/imaging/analysis/robust'

test('retains small finite populations exactly and exposes robust counts', () => {
	const reservoir = new RobustReservoir(8)
	for (const value of [1, Number.NaN, 2, Number.POSITIVE_INFINITY, 3, 4]) reservoir.push(value)

	expect(reservoir.seenCount).toBe(4)
	expect(reservoir.retainedCount).toBe(4)
	expect(reservoir.approximate).toBeFalse()
	expect(reservoir.median()).toBe(2.5)
	expect(reservoir.mad()).toBe(1)
	expect(reservoir.robustStandardDeviation()).toBeCloseTo(Math.sqrt(1.25), 12)
})

test('uses deterministic bounded sampling for large populations', () => {
	const first = new RobustReservoir(ROBUST_SAMPLE_CAPACITY + 1000)
	const second = new RobustReservoir(ROBUST_SAMPLE_CAPACITY + 1000)
	for (let i = 0; i < ROBUST_SAMPLE_CAPACITY + 1000; i++) {
		first.push(i)
		second.push(i)
	}

	expect(first.seenCount).toBe(ROBUST_SAMPLE_CAPACITY + 1000)
	expect(first.retainedCount).toBe(ROBUST_SAMPLE_CAPACITY)
	expect(first.approximate).toBeTrue()
	expect(first.median()).toBe(second.median())
	expect(first.mad()).toBe(second.mad())
})

test('reports empty reductions and rejects allocation-unsafe capacities', () => {
	const empty = new RobustReservoir(0)
	expect(empty.retainedCount).toBe(0)
	expect(empty.median()).toBeNaN()
	expect(empty.mad()).toBeNaN()
	expect(empty.robustStandardDeviation()).toBeNaN()
	expect(() => new RobustReservoir(-1)).toThrow(RangeError)
	expect(() => new RobustReservoir(Number.POSITIVE_INFINITY)).toThrow(RangeError)
})

test('keeps even finite medians finite at floating-point extremes', () => {
	const reservoir = new RobustReservoir(2)
	reservoir.push(Number.MAX_VALUE)
	reservoir.push(Number.MAX_VALUE)
	expect(reservoir.median()).toBe(Number.MAX_VALUE)
})
