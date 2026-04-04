import { expect, test } from 'bun:test'
import { Histogram } from '../src/statistics'

// Verifies all cached histogram statistics against expected values.
function histogram(data: number[], mode: readonly [number, number], count: readonly [number, number], mean: number, variance: number, stdev: number, median: number) {
	const hist = new Histogram(data, 0)

	expect(hist.mode).toEqual(mode)
	expect(hist.count[0]).toBeCloseTo(count[0], 4)
	expect(hist.count[1]).toBeCloseTo(count[1], 4)
	expect(hist.mean).toBeCloseTo(mean, 4)
	expect(hist.variance).toBeCloseTo(variance, 4)
	expect(hist.standardDeviation).toBeCloseTo(stdev, 4)
	expect(hist.median).toBeCloseTo(median, 4)
}

test('histogram', () => {
	histogram([5, 8, 12, 10], [2, 12], [35, 12], 1.7714, 1.03346, 1.01659, 2.375)
	histogram([2, 2], [0, 2], [4, 2], 0.5, 0.25, 0.5, 1)
	histogram([2, 0, 2], [0, 2], [4, 2], 1, 1, 1, 1)
	histogram([5, 0, 0, 0, 0, 0, 0, 10], [7, 10], [15, 10], 4.66666, 10.88888, 3.29983, 7.25)
})

test('histogram maximum returns the last populated bin', () => {
	const hist = new Histogram([2, 0, 5], 2)
	expect(hist.maximum).toEqual([1, 5])
})

test('empty histogram statistics fall back to zero', () => {
	const hist = new Histogram([], 0)
	expect(hist.mode).toEqual([0, 0])
	expect(hist.count).toEqual([0, 0])
	expect(hist.mean).toBe(0)
	expect(hist.variance).toBe(0)
	expect(hist.standardDeviation).toBe(0)
	expect(hist.median).toBe(0)
	expect(hist.minimum).toEqual([0, 0])
	expect(hist.maximum).toEqual([0, 0])

	hist.reset()

	expect(hist.mean).toBe(0)
	expect(hist.median).toBe(0)
})

test('all-zero histogram statistics fall back to zero', () => {
	const hist = new Histogram([0, 0, 0], 2)
	expect(hist.mode).toEqual([0, 0])
	expect(hist.count).toEqual([0, 0])
	expect(hist.mean).toBe(0)
	expect(hist.variance).toBe(0)
	expect(hist.standardDeviation).toBe(0)
	expect(hist.median).toBe(0)
	expect(hist.minimum).toEqual([0, 0])
	expect(hist.maximum).toEqual([0, 0])
})
