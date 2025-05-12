import { expect, test } from 'bun:test'
import { Histogram } from '../src/statistics'

function histogram(data: number[], mode: readonly [number, number], count: number, mean: number, variance: number, stdev: number, median: number) {
	const hist = new Histogram(data)

	expect(hist.mode()).toEqual(mode)
	expect(hist.count()).toBeCloseTo(count, 4)
	expect(hist.mean()).toBeCloseTo(mean, 4)
	expect(hist.variance()).toBeCloseTo(variance, 4)
	expect(hist.standardDeviation()).toBeCloseTo(stdev, 4)
	expect(hist.median()).toBeCloseTo(median, 4)
}

test('histogram', () => {
	histogram([5, 8, 12, 10], [2, 12], 35, 1.7714, 1.03346, 1.01659, 2.375)
	histogram([2, 2], [0, 2], 4, 0.5, 0.25, 0.5, 1)
	histogram([2, 0, 2], [0, 2], 4, 1, 1, 1, 1)
	histogram([5, 0, 0, 0, 0, 0, 0, 10], [7, 10], 15, 4.66666, 10.88888, 3.29983, 7.25)
})
