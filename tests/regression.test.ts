import { describe, expect, test } from 'bun:test'
import type { NumberArray } from '../src/math'
import { exponentialRegression, hyperbolicRegression, levenbergMarquardt, polynomialRegression, powerRegression, regressionScore, simpleLinearRegression, theilSenRegression, trendLineRegression } from '../src/regression'

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
		expect(regression.coefficients[0]).toBeCloseTo(1, 12)
		expect(regression.coefficients[1]).toBeCloseTo(0, 12)
	})

	test('degree 2', () => {
		const x = [-3, 0, 2, 4]
		const y = Float64Array.from([3, 1, 1, 3])
		const regression = polynomialRegression(x, y, 2)

		expect(regression.coefficients).toHaveLength(3)
		expect(regression.coefficients[0]).toBeCloseTo(0.850519, 5)
		expect(regression.coefficients[1]).toBeCloseTo(-0.192495, 5)
		expect(regression.coefficients[2]).toBeCloseTo(0.178462, 5)
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

describe('trend line regression', () => {
	describe('perfect v-curve with only one minimum point', () => {
		const x = [1, 2, 3, 4, 9, 8, 7, 6, 5]
		const y = [10, 8, 6, 4, 10, 8, 6, 4, 2]

		test('simple', () => {
			const regression = trendLineRegression(x, y)

			expect(regression.intersection[0]).toBeCloseTo(5, 8)
			expect(regression.intersection[1]).toBeCloseTo(2, 8)
		})

		test('theil-sen', () => {
			const regression = trendLineRegression(x, y, 'theil-sen')

			expect(regression.intersection[0]).toBeCloseTo(5, 8)
			expect(regression.intersection[1]).toBeCloseTo(2, 8)
		})
	})

	describe('perfect v-curve with flat tip with multiple points', () => {
		const x = [1, 2, 3, 4, 11, 10, 9, 8, 5, 6, 7]
		const y = [10, 8, 6, 4, 10, 8, 6, 4, 2.1, 2, 2.1]

		test('simple', () => {
			const regression = trendLineRegression(x, y)

			expect(regression.intersection[0]).toBeCloseTo(6, 8)
			expect(regression.intersection[1]).toBeCloseTo(0, 0)
		})

		test('theil-sen', () => {
			const regression = trendLineRegression(x, y, 'theil-sen')

			expect(regression.intersection[0]).toBeCloseTo(6, 8)
			expect(regression.intersection[1]).toBeCloseTo(0, 8)
		})
	})
})

test('exponential regression', () => {
	const x = [0, 1, 2, 3, 4]
	const y = [1.5, 2.5, 3.5, 5.0, 7.5]
	const regression = exponentialRegression(x, y)

	expect(regression.a).toBeCloseTo(0.3912023, 6)
	expect(regression.b).toBeCloseTo(1.5799091, 6)
	expect(regression.predict(2)).toBeCloseTo(3.454825, 6)
	expect(regression.x(3.454825)).toBeCloseTo(2, 6)
})

test('power regression', () => {
	const x = [17.6, 26, 31.9, 38.9, 45.8, 51.2, 58.1, 64.7, 66.7, 80.8, 82.9]
	const y = [159.9, 206.9, 236.8, 269.9, 300.6, 323.6, 351.7, 377.6, 384.1, 437.2, 444.7]
	const regression = powerRegression(x, y)

	expect(regression.a).toBeCloseTo(24.12989312, 6)
	expect(regression.b).toBeCloseTo(0.65949782, 6)
	expect(regression.predict(20)).toBeCloseTo(174.0130599, 6)
	expect(regression.x(174.0130599)).toBeCloseTo(20, 6)
})

test('hyperbolic regression', () => {
	const x = [29000, 29100, 29200, 29300, 29400, 29500, 29600, 29700, 29800, 29900, 30000, 30100, 30200, 30300, 30400, 30500, 30600, 30700, 30800, 30900, 31000]
	const y = [40.5, 36.2, 31.4, 28.6, 23.1, 21.2, 16.6, 13.7, 6.21, 4.21, 3.98, 4.01, 4.85, 11.1, 15.3, 22.1, 21.9, 27.4, 32.1, 36.5, 39.7]

	const regression = hyperbolicRegression(x, y)

	expect(Math.round(regression.minimum[0])).toBe(30009)
	expect(regression.minimum[1]).toBeCloseTo(2.23, 2)
	expect(regression.predict(30000)).toBeCloseTo(2.26, 2)
	expect(regression.x(23.1)).toBeCloseTo(29431, 0)
})

test('hyperbolic regression using ASCOM Sky Simulator (few points)', () => {
	const x = [6100, 6600, 7100, 7600, 8100, 8600, 9100, 9600, 10100]
	const y = [13.662644615384618, 12.428210576923071, 9.326303846153845, 5.063299489795917, 2.9738176470588247, 6.891483673469387, 10.640856213017754, 12.879208888888888, 13.892408928571431]

	const regression = hyperbolicRegression(x, y)

	expect(Math.round(regression.minimum[0])).toBe(8033)
	expect(regression.minimum[1]).toBeCloseTo(4.5849, 3)
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

// https://github.com/mljs/levenberg-marquardt/blob/main/src/__tests__/curve.test.js
describe('Levenberg-Marquardt regression', () => {
	test('line', () => {
		function line(x: number, [a, b]: NumberArray) {
			return a * x + b
		}

		const x = [0, 1, 2, 3, 4, 5, 6]
		const y = [-2, 0, 2, 4, 6, 8, 10]
		const result = levenbergMarquardt(x, y, line, [1, 0])

		expect(result[0]).toBeCloseTo(2, 8)
		expect(result[1]).toBeCloseTo(-2, 8)

		for (let i = 0; i < x.length; i++) {
			expect(line(x[i], result)).toBeCloseTo(y[i], 8)
		}
	})

	test('quadratic', () => {
		function quadratic(x: number, [a, b, c]: NumberArray) {
			return a * x * x + b * x + c
		}

		const x = [0, 1, 2, 3, 4, 5, 6]
		const y = [1, 2, 3, 4, 5, 6, 7]
		const result = levenbergMarquardt(x, y, quadratic, [1, 0, 0])

		expect(result[0]).toBeCloseTo(0, 6)
		expect(result[1]).toBeCloseTo(1, 6)
		expect(result[2]).toBeCloseTo(1, 6)

		for (let i = 0; i < x.length; i++) {
			expect(quadratic(x[i], result)).toBeCloseTo(y[i], 6)
		}
	})

	test('cubic', () => {
		function cubic(x: number, [a, b, c, d]: NumberArray) {
			return a * x * x * x + b * x * x + c * x + d
		}

		const x = [0, 1, 2, 3, 4, 5, 6]
		const y = [1, 2, 3, 4, 5, 6, 7]
		const result = levenbergMarquardt(x, y, cubic, [1, 0, 0, 0])

		expect(result[0]).toBeCloseTo(0, 6)
		expect(result[1]).toBeCloseTo(0, 6)
		expect(result[2]).toBeCloseTo(1, 6)
		expect(result[3]).toBeCloseTo(1, 6)

		for (let i = 0; i < x.length; i++) {
			expect(cubic(x[i], result)).toBeCloseTo(y[i], 6)
		}
	})

	test('exponential', () => {
		function exponential(x: number, [a, b]: NumberArray) {
			return a * Math.exp(b * x)
		}

		const x = [0, 1, 2, 3, 4, 5, 6]
		const y = [1, 2.718, 7.389, 20.085, 54.598, 148.413, 403.429]
		const result = levenbergMarquardt(x, y, exponential, [1, 1])

		expect(result[0]).toBeCloseTo(1, 5)
		expect(result[1]).toBeCloseTo(1, 5)

		for (let i = 0; i < x.length; i++) {
			expect(exponential(x[i], result)).toBeCloseTo(y[i], 2)
		}
	})

	test('sine', () => {
		function sine(x: number, [a, b, c]: NumberArray) {
			return a * Math.sin(b * x + c)
		}

		const x = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 2 * Math.PI]
		const y = [0, 1, 0, -1, 0]
		const result = levenbergMarquardt(x, y, sine, [1, 1, 0])

		expect(result[0]).toBeCloseTo(1, 8)
		expect(result[1]).toBeCloseTo(1, 8)
		expect(result[2]).toBeCloseTo(0, 8)

		expect(sine(Math.PI / 4, result)).toBeCloseTo(0.7071067811865475, 8)

		for (let i = 0; i < x.length; i++) {
			expect(sine(x[i], result)).toBeCloseTo(y[i], 8)
		}
	})

	test('logarithmic', () => {
		function logarithmic(x: number, [a, b]: NumberArray) {
			return a * Math.log(b * x)
		}

		const x = [1, 2, 3, 4, 5, 6]
		const y = [0, 0.693, 1.099, 1.386, 1.609, 1.792]
		const result = levenbergMarquardt(x, y, logarithmic, [1, 3])

		expect(result[0]).toBeCloseTo(1, 4)
		expect(result[1]).toBeCloseTo(1, 4)

		for (let i = 0; i < x.length; i++) {
			expect(logarithmic(x[i], result)).toBeCloseTo(y[i], 3)
		}
	})

	test('complex', () => {
		function complex(x: number, [a, b, c, d]: NumberArray) {
			return a + (b - a) / (1 + c ** d * x ** -d)
		}

		const x = [9.22e-12, 5.53e-11, 3.32e-10, 1.99e-9, 1.19e-8, 7.17e-8, 4.3e-7, 0.00000258, 0.0000155, 0.0000929]
		const y = [7.3, 8.61, 10.13, 11.88, 13.89, 16.18, 18.76, 21.64, 24.83, 28.32]
		const result = levenbergMarquardt(x, y, complex, [0, 100, 1, 0.1])

		expect(result[0]).toBeCloseTo(0, 1)
		expect(result[1]).toBeCloseTo(99.8, 1)
		expect(result[2]).toBeCloseTo(0.98, 1)
		expect(result[3]).toBeCloseTo(0.1, 1)

		for (let i = 0; i < x.length; i++) {
			expect(complex(x[i], result)).toBeCloseTo(y[i], 1)
		}
	})

	// https://github.com/accord-net/framework/blob/development/Unit%20Tests/Accord.Tests.Statistics/Models/Regression/LevenbergMarquardtTest.cs
	test('misra1a', () => {
		function misra1a(x: number, [a, b]: NumberArray) {
			return a * (1 - Math.exp(-b * x))
		}

		const x = [77.6, 114.9, 141.1, 190.8, 239.9, 289.0, 332.8, 378.4, 434.8, 477.3, 536.8, 593.1, 689.1, 760.0]
		const y = [10.07, 14.73, 17.94, 23.93, 29.61, 35.18, 40.02, 44.82, 50.76, 55.05, 61.01, 66.4, 75.47, 81.78]
		const result = levenbergMarquardt(x, y, misra1a, [250, 0.0005])

		expect(result[0]).toBeCloseTo(238.944658680792, 2)
		expect(result[1]).toBeCloseTo(0.00055014847409921093, 5)

		for (let i = 0; i < x.length; i++) {
			expect(misra1a(x[i], result)).toBeCloseTo(y[i], 0)
		}
	})

	// https://en.wikipedia.org/wiki/Gauss%E2%80%93Newton_algorithm
	test('biology experiment', () => {
		function biology(x: number, [a, b]: NumberArray) {
			return (a * x) / (b + x)
		}

		const x = [0.03, 0.1947, 0.425, 0.626, 1.253, 2.5, 3.74]
		const y = [0.05, 0.127, 0.094, 0.2122, 0.2729, 0.2665, 0.3317]
		const result = levenbergMarquardt(x, y, biology, [0.9, 0.2])

		expect(result[0]).toBeCloseTo(0.362, 3)
		expect(result[1]).toBeCloseTo(0.558, 3)

		for (let i = 0; i < x.length; i++) {
			expect(biology(x[i], result)).toBeCloseTo(y[i], 0)
		}
	})
})
