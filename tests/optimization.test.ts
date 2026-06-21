import { describe, expect, test } from 'bun:test'
import type { NumberArray } from '../src/math'
import { bisection, brentMinimize, brentRoot, coordinateDescent, falsePositionRoot, goldenSectionSearch, levenbergMarquardt, nelderMead, powell, secantRoot } from '../src/optimization'

describe('root finding', () => {
	test('finds a bracketed root with bisection', () => {
		const result = bisection((x) => x * x - 2, 0, 2)

		expect(result.converged).toBe(true)
		expect(result.root).toBeCloseTo(Math.SQRT2, 10)
		expect(result.value).toBeCloseTo(0, 10)
	})

	test('finds a bracketed root with Brent method', () => {
		const result = brentRoot((x) => Math.cos(x) - x, 0, 1)

		expect(result.converged).toBe(true)
		expect(result.root).toBeCloseTo(0.7390851332151607, 10)
		expect(result.value).toBeCloseTo(0, 10)
	})

	test('finds an unbracketed root with secant method', () => {
		const result = secantRoot((x) => x * x * x - 8, 1, 3)

		expect(result.converged).toBe(true)
		expect(result.root).toBeCloseTo(2, 10)
		expect(result.value).toBeCloseTo(0, 10)
	})

	test('finds a bracketed root with false-position method', () => {
		const result = falsePositionRoot((x) => Math.exp(x) - 3, 0, 2)

		expect(result.converged).toBe(true)
		expect(result.root).toBeCloseTo(Math.log(3), 10)
		expect(result.value).toBeCloseTo(0, 10)
	})

	test('accepts a root at a bracket endpoint', () => {
		const result = brentRoot((x) => x * x - 4, 2, 5)

		expect(result.converged).toBe(true)
		expect(result.root).toBe(2)
		expect(result.value).toBe(0)
	})

	test('rejects root brackets without a sign change', () => {
		expect(() => brentRoot((x) => x * x + 1, -1, 1)).toThrow('root bracket endpoints must have opposite signs')
	})
})

describe('scalar minimization', () => {
	test('minimizes a scalar function with golden-section search', () => {
		const result = goldenSectionSearch((x) => (x - 3) ** 2 + 2, -4, 8)

		expect(result.converged).toBe(true)
		expect(result.minimum).toBeCloseTo(3, 7)
		expect(result.value).toBeCloseTo(2, 8)
	})

	test('minimizes a scalar function with Brent method', () => {
		const result = brentMinimize((x) => (x + 1.5) ** 2 - 4, -5, 2)

		expect(result.converged).toBe(true)
		expect(result.minimum).toBeCloseTo(-1.5, 7)
		expect(result.value).toBeCloseTo(-4, 8)
	})
})

describe('multivariate minimization', () => {
	test('minimizes a quadratic function with Nelder-Mead', () => {
		const result = nelderMead(([x, y]) => (x - 2) ** 2 + (y + 3) ** 2, [0, 0])

		expect(result.converged).toBe(true)
		expect(result.minimum[0]).toBeCloseTo(2, 6)
		expect(result.minimum[1]).toBeCloseTo(-3, 6)
		expect(result.value).toBeCloseTo(0, 8)
	})

	test('minimizes a separable function with coordinate descent', () => {
		const result = coordinateDescent(([x, y]) => (x - 4) ** 2 + (y + 2) ** 2, [0, 0])

		expect(result.converged).toBe(true)
		expect(result.minimum[0]).toBeCloseTo(4, 6)
		expect(result.minimum[1]).toBeCloseTo(-2, 6)
		expect(result.value).toBeCloseTo(0, 8)
	})

	test('coordinate descent refines through step reduction', () => {
		// A large initial step forces several non-improving passes that shrink the step before convergence.
		const result = coordinateDescent(([x, y]) => (x - 4) ** 2 + (y + 2) ** 2, [0, 0], { initialStep: 64, stepReduction: 0.25 })

		expect(result.converged).toBe(true)
		expect(result.iterations).toBeGreaterThan(1)
		expect(result.minimum[0]).toBeCloseTo(4, 6)
		expect(result.minimum[1]).toBeCloseTo(-2, 6)
	})

	test('minimizes a coupled function with Powell method', () => {
		const result = powell(([x, y]) => (1 - x) ** 2 + 100 * (y - x * x) ** 2, [-1.2, 1], { maxIterations: 1000, tolerance: 1e-8, initialStep: 0.5 })

		expect(result.converged).toBe(true)
		expect(result.minimum[0]).toBeCloseTo(1, 5)
		expect(result.minimum[1]).toBeCloseTo(1, 5)
		expect(result.value).toBeCloseTo(0, 8)
	})
})

// https://github.com/mljs/levenberg-marquardt/blob/main/src/__tests__/curve.test.js
describe('Levenberg-Marquardt optimization', () => {
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
		const y = [1, Math.E, 7.389, 20.085, 54.598, 148.413, 403.429]
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

		const x = [77.6, 114.9, 141.1, 190.8, 239.9, 289, 332.8, 378.4, 434.8, 477.3, 536.8, 593.1, 689.1, 760]
		const y = [10.07, 14.73, 17.94, 23.93, 29.61, 35.18, 40.02, 44.82, 50.76, 55.05, 61.01, 66.4, 75.47, 81.78]
		const result = levenbergMarquardt(x, y, misra1a, [250, 0.0005])

		expect(result[0]).toBeCloseTo(238.944658680792, 2)
		expect(result[1]).toBeCloseTo(0.00055014847409921093, 5)

		for (let i = 0; i < x.length; i++) {
			expect(misra1a(x[i], result)).toBeCloseTo(y[i], 0)
		}
	})

	// https://en.wikipedia.org/wiki/Gauss-Newton_algorithm
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
