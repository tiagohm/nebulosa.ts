import { expect, test } from 'bun:test'
import { bernoulli, cauchy, exponential, gaussian, geometric, logNormal, mt19937, mulberry32, normal, pareto, type Random, rayleigh, sfc32, shuffle, splitmix32, triangular, uniform, weibull, xorshift32 } from '../src/random'

interface RandomCase {
	readonly name: string
	readonly random: Random
}

// Builds a deterministic suite of PRNG instances for moment checks.
function makeRandomCases(seed: number): RandomCase[] {
	return [
		{ name: 'Math.random', random: Math.random },
		{ name: 'mulberry32', random: mulberry32(seed) },
		{ name: 'xorshift32', random: xorshift32(seed) },
		{ name: 'splitmix32', random: splitmix32(seed) },
		{ name: 'sfc32', random: sfc32(seed) },
		{ name: 'mt19937', random: mt19937(seed) },
	]
}

// Creates a cyclic deterministic sampler for boundary-condition tests.
function sequenceRandom(values: readonly number[]): Random {
	let index = 0
	return () => {
		const value = values[index]
		index = (index + 1) % values.length
		return value
	}
}

// Checks the sample mean against the analytical expectation.
function expectMean(create: (random: Random) => Random, expected: number, precision: number = 1, n: number = 20000) {
	for (const { name, random } of makeRandomCases(1)) {
		const sample = create(random)
		let sum = 0
		for (let i = 0; i < n; i++) sum += sample()
		expect(sum / n, name).toBeCloseTo(expected, precision)
	}
}

// Checks the sample median against the analytical expectation.
function expectMedian(create: (random: Random) => Random, expected: number, tolerance: number = 0.1, n: number = 20001) {
	for (const { name, random } of makeRandomCases(1)) {
		const sample = create(random)
		const values = new Float64Array(n)
		for (let i = 0; i < n; i++) values[i] = sample()
		values.sort()
		expect(values[(n - 1) >> 1], name).toBeCloseTo(expected, 0)
		expect(Math.abs(values[(n - 1) >> 1] - expected), name).toBeLessThan(tolerance)
	}
}

test('mulberry32', () => {
	const random = mulberry32(1066)

	expect(random()).toBeCloseTo(0.2090558789204806, 14)
	expect(random()).toBeCloseTo(0.20585522265173495, 14)
	expect(random()).toBeCloseTo(0.6966334171593189, 14)
})

test('xorshift32', () => {
	const random = xorshift32(1066)

	expect(random()).toBeCloseTo(0.0631986502557993, 14)
	expect(random()).toBeCloseTo(0.5354481283575296, 14)
	expect(random()).toBeCloseTo(0.29987499467097223, 14)
})

test('xorshift32 keeps a non-zero state when seeded with zero', () => {
	const random = xorshift32(0)

	expect(random()).toBeGreaterThan(0)
	expect(random()).toBeGreaterThan(0)
})

test('splitmix32', () => {
	const random = splitmix32(1066)

	expect(random()).toBeCloseTo(0.048834215151146054, 14)
	expect(random()).toBeCloseTo(0.7997270019259304, 14)
	expect(random()).toBeCloseTo(0.8385824684519321, 14)
})

test('sfc32', () => {
	const random = sfc32(1066)

	expect(random()).toBeCloseTo(0.3160732591059059, 14)
	expect(random()).toBeCloseTo(0.8149970294907689, 14)
	expect(random()).toBeCloseTo(0.9720777503680438, 14)
})

test('mt19937', () => {
	const random = mt19937(1066)

	expect(random()).toBeCloseTo(0.357017719885334373, 14)
	expect(random()).toBeCloseTo(0.988986714044585824, 14)
	expect(random()).toBeCloseTo(0.566655429778620601, 14)
})

test('uniform', () => {
	expectMean((random) => uniform(random), 0.5)
})

// mean = p
test('bernoulli', () => {
	expectMean((random) => bernoulli(random, 0.7), 0.7)
})

// mean = lambda * Gamma(1 + 1 / k)
test('weibull', () => {
	expectMean((random) => weibull(random, 1, 5), 0.9181687423997606)
})

// mean = 1 / lambda
test('exponential', () => {
	expectMean((random) => exponential(random, 2), 0.5)
})

// mean = 1 / p
test('geometric', () => {
	expectMean((random) => geometric(random, 0.5), 2)
})

// mean = alpha / (alpha - 1)
test('pareto', () => {
	expectMean((random) => pareto(random, 5), 1.25)
})

// mean = mu
test('normal', () => {
	expectMean((random) => normal(random, 0.8), 0.8)
})

test('normal rejects the unit-circle boundary in the Marsaglia sampler', () => {
	const sample = normal(sequenceRandom([0, 0.5, 0.75, 0.5]))

	expect(sample()).toBeGreaterThan(1)
})

test('gaussian', () => {
	expectMean((random) => gaussian(random, 2), 0)
})

// mean = (min + max + mode) / 3
test('triangular', () => {
	expectMean((random) => triangular(random, -2, 4, 1), 1)
})

// mean = sigma * sqrt(pi / 2)
test('rayleigh', () => {
	expectMean((random) => rayleigh(random, 2), 2.5066282746310002)
})

// mean = exp(mu + sigma^2 / 2)
test('logNormal', () => {
	expectMean((random) => logNormal(random, 0.2, 0.3), 1.2776213132048866)
})

// median = x0
test('cauchy', () => {
	expectMedian((random) => cauchy(random, 2, 0.5), 2)
})

test('inverse-transform samplers stay finite at unit endpoints', () => {
	const zeros = sequenceRandom([0])
	const ones = sequenceRandom([1])
	const values = [1, 2, 3]

	expect(uniform(ones, -1, 1)()).toBeLessThan(1)
	expect(bernoulli(ones, 0.5)()).toBe(0)
	expect(Number.isFinite(weibull(zeros, 2, 3)())).toBeTrue()
	expect(Number.isFinite(exponential(ones, 2)())).toBeTrue()
	expect(Number.isFinite(geometric(ones, 0.5)())).toBeTrue()
	expect(Number.isFinite(pareto(ones, 3)())).toBeTrue()
	expect(Number.isFinite(normal(ones, 0, 1)())).toBeTrue()
	expect(Number.isFinite(rayleigh(ones, 2)())).toBeTrue()
	expect(Number.isFinite(cauchy(zeros, 0, 1)())).toBeTrue()

	shuffle(values, ones)
	expect(values).toEqual([1, 2, 3])
})

test('shuffle', () => {
	const random = mulberry32(5)
	const values = [1, 2, 3, 4, 5]
	shuffle(values, random)

	expect(values).toEqual([3, 2, 1, 5, 4])
})

test('shuffle typed arrays', () => {
	const random = mulberry32(5)
	const values = new Float64Array([1, 2, 3, 4, 5])
	shuffle(values, random)

	expect([...values]).toEqual([3, 2, 1, 5, 4])
})
