import { expect, test } from 'bun:test'
import { regressionScore, simpleLinearRegression } from '../src/regression'

test('simple linear regression', () => {
	const x = [80, 60, 10, 20, 30]
	const y = [20, 40, 30, 50, 60]
	const regression = simpleLinearRegression(x, y)

	expect(regression.slope).toBeCloseTo(-0.264706, 5)
	expect(regression.intercept).toBeCloseTo(50.588235, 5)
	expect(regression.predict(85)).toBeCloseTo(28.088235294117649, 10)
	expect(regression.x(28.088235294117649)).toBeCloseTo(85, 0)
})

test('simple linear regression score', () => {
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
