import { expect, test } from 'bun:test'
import { linearLeastSquares, predictLinearLeastSquares, robustLinearLeastSquares } from '../src/least.squares'

test('linear least squares', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3])]
	const target = new Float64Array([1, 3, 5, 7])
	const fit = linearLeastSquares(design, target)

	expect(fit.coefficients[0]).toBeCloseTo(1, 8)
	expect(fit.coefficients[1]).toBeCloseTo(2, 8)
	expect(fit.rankDeficient).toBeFalse()
	expect(fit.conditionNumber).toBeGreaterThan(1)
	expect(predictLinearLeastSquares(fit.coefficients, new Float64Array([1, 4]))).toBeCloseTo(9, 8)
})

test('robust linear least squares resists outliers', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1]), new Float64Array([1, 2]), new Float64Array([1, 3]), new Float64Array([1, 4])]
	const target = new Float64Array([1, 3, 5, 7, 100])
	const plain = linearLeastSquares(design, target)
	const robust = robustLinearLeastSquares(design, target, { method: 'tukey' })

	expect(Math.abs(plain.coefficients[1] - 2)).toBeGreaterThan(Math.abs(robust.coefficients[1] - 2))
	expect(robust.weights[4]).toBeLessThan(1)
})

test('linear least squares rejects invalid weights', () => {
	const design = [new Float64Array([1, 0]), new Float64Array([1, 1])]
	const target = new Float64Array([1, 3])

	expect(() => linearLeastSquares(design, target, { weights: new Float64Array([1, -1]) })).toThrow('weight at index 1 must be finite and non-negative')
	expect(() => linearLeastSquares(design, target, { weights: new Float64Array([1, Number.NaN]) })).toThrow('weight at index 1 must be finite and non-negative')
})
