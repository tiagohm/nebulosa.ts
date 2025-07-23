import { describe, expect, test } from 'bun:test'
import { bernoulli, exponential, geometric, mt19937, mulberry32, normal, pareto, type Random, splitmix32, uniform, weibull, xorshift32 } from '../src/random'

test('mulberry32', () => {
	const random = mulberry32(1066)

	expect(random()).toBeCloseTo(0.2090558789204806, 14)
	expect(random()).toBeCloseTo(0.20585522265173495, 14)
	expect(random()).toBeCloseTo(0.6966334171593189, 14)
})

test('xorshift32', () => {
	const random = xorshift32(1066)

	expect(random()).toBeCloseTo(0.0631986502557993, 14)
	expect(random()).toBeCloseTo(0.5355930868536234, 14)
	expect(random()).toBeCloseTo(0.7390806321054697, 14)
})

test('splitmix32', () => {
	const random = splitmix32(1066)

	expect(random()).toBeCloseTo(0.048834215151146054, 14)
	expect(random()).toBeCloseTo(0.7997270019259304, 14)
	expect(random()).toBeCloseTo(0.8385824684519321, 14)
})

test('mt19937', () => {
	const random = mt19937(1066)

	expect(random()).toBeCloseTo(0.357017719885334373, 14)
	expect(random()).toBeCloseTo(0.988986714044585824, 14)
	expect(random()).toBeCloseTo(0.566655429778620601, 14)
})

const ALGORITHMS = [Math.random, mulberry32(1), xorshift32(1), splitmix32(1), mt19937(1)]

function mean(random: Random, expected: number, n: number = 10000) {
	let sum = 0
	for (let i = 0; i < n; i++, sum += random());
	expect(sum / n).toBeCloseTo(expected, 1)
}

test('uniform', () => {
	for (const random of ALGORITHMS) {
		mean(uniform(random), 0.5)
	}
})

// mean = p
test('bernoulli', () => {
	for (const random of ALGORITHMS) {
		mean(bernoulli(random, 0.7), 0.7)
	}
})

// mean = lambda * Γ(1 + 1 / k)
// Online Gamma function: https://planetcalc.com/4520/
test('weibull', () => {
	for (const random of ALGORITHMS) {
		mean(weibull(random, 1, 5), 0.92)
	}
})

// mean = 1 / lambda
test('exponential', () => {
	for (const random of ALGORITHMS) {
		mean(exponential(random, 2), 0.5)
	}
})

// mean = 1 / p
test('geometric', () => {
	for (const random of ALGORITHMS) {
		mean(geometric(random, 0.5), 2)
	}
})

// mean = alpha / (alpha - 1)
describe('pareto', () => {
	for (const random of ALGORITHMS) {
		mean(pareto(random, 5), 1.25)
	}
})

// mean = mu
describe('normal', () => {
	for (const random of ALGORITHMS) {
		mean(normal(random, 0.8), 0.8)
	}
})
