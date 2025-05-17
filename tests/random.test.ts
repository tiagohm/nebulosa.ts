import { describe, expect, test } from 'bun:test'
import { type Random, bernoulli, exponential, geometric, mulberry32, normal, pareto, uniform, weibull } from '../src/random'

test('mulberry32', () => {
	const random = mulberry32(1066)

	expect(random()).toBeCloseTo(0.2090558789204806, 14)
	expect(random()).toBeCloseTo(0.20585522265173495, 14)
	expect(random()).toBeCloseTo(0.6966334171593189, 14)
})

function mean(random: Random, expected: number, n: number = 10000) {
	let sum = 0
	for (let i = 0; i < n; i++, sum += random());
	expect(sum / n).toBeCloseTo(expected, 1)
}

describe('uniform', () => {
	test('Math.random', () => {
		mean(uniform(Math.random), 0.5)
	})

	test('mulberry32', () => {
		mean(uniform(mulberry32(1)), 0.5)
	})
})

// mean = p
describe('bernoulli', () => {
	test('Math.random', () => {
		mean(bernoulli(Math.random, 0.7), 0.7)
	})

	test('mulberry32', () => {
		mean(bernoulli(mulberry32(1), 0.7), 0.7)
	})
})

// mean = lambda * Γ(1 + 1 / k)
// Online Gamma function: https://planetcalc.com/4520/
describe('weibull', () => {
	test('Math.random', () => {
		mean(weibull(Math.random, 1, 5), 0.92)
	})

	test('mulberry32', () => {
		mean(weibull(mulberry32(1), 1, 5), 0.92)
	})
})

// mean = 1 / lambda
describe('exponential', () => {
	test('Math.random', () => {
		mean(exponential(Math.random, 2), 0.5)
	})

	test('mulberry32', () => {
		mean(exponential(mulberry32(1), 2), 0.5)
	})
})

// mean = 1 / p
describe('geometric', () => {
	test('Math.random', () => {
		mean(geometric(Math.random, 0.5), 2)
	})

	test('mulberry32', () => {
		mean(geometric(mulberry32(1), 0.5), 2)
	})
})

// mean = alpha / (alpha - 1)
describe('pareto', () => {
	test('Math.random', () => {
		mean(pareto(Math.random, 5), 1.25)
	})

	test('mulberry32', () => {
		mean(pareto(mulberry32(1), 5), 1.25)
	})
})

// mean = mu
describe('normal', () => {
	test('Math.random', () => {
		mean(normal(Math.random, 0.8), 0.8)
	})

	test('mulberry32', () => {
		mean(normal(mulberry32(1), 0.8), 0.8)
	})
})
