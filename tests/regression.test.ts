import { describe, expect, test } from 'bun:test'
import { polynomialRegression, regressionScore, simpleLinearRegression, theilSenRegression } from '../src/regression'

test('simple linear', () => {
	const x = [80, 60, 10, 20, 30]
	const y = [20, 40, 30, 50, 60]
	const regression = simpleLinearRegression(x, y)

	expect(regression.slope).toBeCloseTo(-0.264706, 5)
	expect(regression.intercept).toBeCloseTo(50.588235, 5)
	expect(regression.predict(85)).toBeCloseTo(28.088235294117649, 10)
	expect(regression.x(28.088235294117649)).toBeCloseTo(85, 0)
})

// https://github.com/mljs/regression-polynomial/blob/main/src/__tests__/index.test.ts
describe('polynomial', () => {
	test('degree 1', () => {
		const x = new Array(1000).fill(0).map((_, i) => i)
		const y = new Array(1000).fill(1)
		const regression = polynomialRegression(x, y, 1)

		expect(regression.coefficients).toHaveLength(2)
		expect(regression.coefficients).toEqual(Float64Array.from([1, 0]))
	})

	test('degree 2', () => {
		const x = [-3, 0, 2, 4]
		const y = Float64Array.from([3, 1, 1, 3])
		const regression = polynomialRegression(x, y, 2)

		expect(regression.coefficients).toHaveLength(3)
		expect(regression.coefficients[0]).toBeCloseTo(0.850519, 5)
		expect(regression.coefficients[1]).toBeCloseTo(-0.192495, 5)
		expect(regression.coefficients[2]).toBeCloseTo(0.178462, 5)

		const score = regressionScore(regression, x, y)

		expect(score.r2).toBeGreaterThan(0.8)
		expect(score.chi2).toBeLessThan(0.1)
		expect(score.rmsd).toBeCloseTo(0.12, 2)
	})

	test('degree 5', () => {
		const x = Float64Array.from([50, 50, 50, 70, 70, 70, 80, 80, 80, 90, 90, 90, 100, 100, 100])
		const y = [3.3, 2.8, 2.9, 2.3, 2.6, 2.1, 2.5, 2.9, 2.4, 3, 3.1, 2.8, 3.3, 3.5, 3]
		const regression = polynomialRegression(x, y, 5)

		expect(regression.predict(80)).toBeCloseTo(2.6, 9)
		expect(regression.coefficients).toHaveLength(6)
		// Both Python and ml.js return different values, but the predict matches
		// expect(regression.coefficients[0]).toBeCloseTo(17.39552328011271, 12)
		// expect(regression.coefficients[1]).toBeCloseTo(-0.3916378430736305, 12)
		// expect(regression.coefficients[2]).toBeCloseTo(0.0001367602062643227, 12)
		// expect(regression.coefficients[3]).toBeCloseTo(-0.000001302280135149651, 12)
		// expect(regression.coefficients[4]).toBeCloseTo(3.837755337564968e-9, 12)
		// expect(regression.coefficients[5]).toBeCloseTo(3.837755337564968e-9, 12)
	})

	test('fit a parabola with origin on 0', () => {
		const x = new Float64Array([-4, 4, 2, 3, 1, 8, 5, 7])
		const y = new Float64Array([16.5, 16.5, 4.5, 9.5, 1.5, 64.5, 25.5, 49.5])
		const regression = polynomialRegression(x, y, 2, true)

		expect(regression.predict(0)).toBe(0)
		expect(regression.coefficients).toHaveLength(2)
		expect(regression.coefficients[0]).toBeCloseTo(0.018041553971009705, 5)
		expect(regression.coefficients[1]).toBeCloseTo(1.0095279075485593, 5)
	})

	test('fit a parabola with origin on 0 using degree array', () => {
		const x = new Float64Array([-4, 4, 2, 3, 1, 8, 5, 7])
		const y = new Float64Array([16.5, 16.5, 4.5, 9.5, 1.5, 64.5, 25.5, 49.5])
		const regression = polynomialRegression(x, y, [1, 2])

		expect(regression.predict(0)).toBe(0)
		expect(regression.coefficients).toHaveLength(2)
		expect(regression.coefficients[0]).toBeCloseTo(0.018041553971009705, 5)
		expect(regression.coefficients[1]).toBeCloseTo(1.0095279075485593, 5)
	})
})

// https://github.com/mljs/regression-theil-sen/blob/main/src/__tests__/index.test.js
describe('theil-sen', () => {
	test('simple', () => {
		const x = [1, 2, 3, 4, 5]
		const y = [2, 3, 4, 5, 6]
		const regression = theilSenRegression(x, y)

		expect(regression.slope).toBeCloseTo(1, 8)
		expect(regression.intercept).toBeCloseTo(1, 8)

		expect(regression.predict(85)).toBeCloseTo(86, 8)
		expect(regression.x(86)).toBeCloseTo(85, 8)
	})

	test('outlier', () => {
		const x = [1, 2, 3, 4, 10, 12, 18]
		const y = [10, 14, 180, 22, 46, 54, 78]
		const regression = theilSenRegression(x, y)

		expect(regression.slope).toBeCloseTo(4, 8)
		expect(regression.intercept).toBeCloseTo(6, 8)
	})

	test('constant', () => {
		const x = [0, 1, 2, 3]
		const y = [2, 2, 2, 2]
		const regression = theilSenRegression(x, y)

		expect(regression.slope).toBeCloseTo(0, 8)
		expect(regression.intercept).toBeCloseTo(2, 8)
		expect(regression.predict(1)).toBeCloseTo(2, 8)
	})
})

test('regression score', () => {
	// https://en.wikipedia.org/wiki/Simple_linear_regression#Numerical_example
	const x = [1.47, 1.5, 1.52, 1.55, 1.57, 1.6, 1.63, 1.65, 1.68, 1.7, 1.73, 1.75, 1.78, 1.8, 1.83]
	const y = [52.21, 53.12, 54.48, 55.84, 57.2, 58.57, 59.93, 61.29, 63.11, 64.47, 66.28, 68.1, 69.92, 72.19, 74.46]
	const regression = simpleLinearRegression(x, y)

	expect(regression.slope).toBeCloseTo(61.272, 3)
	expect(regression.intercept).toBeCloseTo(-39.062, 3)

	const score = regressionScore(regression, x, y)
	expect(score.r).toBeCloseTo(0.9946, 3)
	expect(score.r2).toBe(score.r * score.r)
	expect(score.chi2).toBeLessThan(1)
	expect(score.rmsd).toBeLessThan(1)
})
