import { TAU } from './constants'
import type { NumberArray } from './math'

export type Random = () => number

// https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript

const MAX_INT = 0x100000000
const INV_MAX_INT = 1 / MAX_INT
const SPLITMIX32_INCREMENT = 0x9e3779b9
const UNIT_MAX_EXCLUSIVE = 1 - Number.EPSILON
const UNIT_MIN_EXCLUSIVE = Number.MIN_VALUE

// Returns a constant zero sampler for degenerate distribution parameters.
function zeroRandom() {
	return 0
}

// Returns a constant one sampler for degenerate distribution parameters.
function oneRandom() {
	return 1
}

// Returns a constant sampler for degenerate distribution parameters.
function constantRandom(value: number): Random {
	return () => value
}

// Keeps seeds in 32-bit space.
function normalizeSeed(seed: number) {
	return seed >>> 0
}

// Mixes one 32-bit state using the SplitMix32 integer finalizer.
function splitmix32Int(state: number) {
	let z = state | 0
	z ^= z >>> 16
	z = Math.imul(z, 0x21f0aaad)
	z ^= z >>> 15
	z = Math.imul(z, 0x735a2d97)
	z ^= z >>> 15
	return z >>> 0
}

// Clamps a unit random value to the [0, 1) interval.
function clampClosedOpen(value: number) {
	if (!(value >= 0)) return 0
	return value < 1 ? value : UNIT_MAX_EXCLUSIVE
}

// Clamps a unit random value to the (0, 1) interval.
function clampOpen(value: number) {
	if (!(value > 0)) return UNIT_MIN_EXCLUSIVE
	return value < 1 ? value : UNIT_MAX_EXCLUSIVE
}

// A simple 32-bit generator, but is extremely fast and has acceptable quality randomness
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
export function mulberry32(seed: number = Date.now()): Random {
	let state = normalizeSeed(seed)

	return () => {
		let z = (state += 0x6d2b79f5)
		z = Math.imul(z ^ (z >>> 15), z | 1)
		z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
		return ((z ^ (z >>> 14)) >>> 0) * INV_MAX_INT
	}
}

// Extremely simple and fast pseudorandom number generator.
export function xorshift32(seed: number = Date.now()): Random {
	let state = normalizeSeed(seed) || 0x6d2b79f5

	return () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		return (state >>> 0) * INV_MAX_INT
	}
}

// A fast, high-quality generator that is suitable for most applications
export function splitmix32(seed: number = Date.now()): Random {
	let state = normalizeSeed(seed)

	return () => {
		state = (state + SPLITMIX32_INCREMENT) | 0
		return splitmix32Int(state) * INV_MAX_INT
	}
}

// Small Fast Counter PRNG with a 128-bit state seeded through SplitMix32.
// https://pracrand.sourceforge.net/
export function sfc32(seed: number = Date.now()): Random {
	let state = normalizeSeed(seed)
	let a = splitmix32Int((state = (state + SPLITMIX32_INCREMENT) | 0))
	let b = splitmix32Int((state = (state + SPLITMIX32_INCREMENT) | 0))
	let c = splitmix32Int((state = (state + SPLITMIX32_INCREMENT) | 0))
	let d = splitmix32Int((state = (state + SPLITMIX32_INCREMENT) | 0))

	return () => {
		const t = (((a + b) | 0) + d) | 0
		d = (d + 1) | 0
		a = b ^ (b >>> 9)
		b = (c + (c << 3)) | 0
		c = ((c << 21) | (c >>> 11)) + t
		c |= 0
		return (t >>> 0) * INV_MAX_INT
	}
}

const N = 624
const M = 397
const UPPER_MASK = 0x80000000
const LOWER_MASK = 0x7fffffff
const MATRIX_A = 0x9908b0df

// MT19937: Mersenne Twister implementation
// The Mersenne Twister is a widely used pseudorandom number generator (PRNG) known for its high quality and long period.
// http://www.math.sci.hiroshima-u.ac.jp/~m-mat/MT/MT2002/CODES/mt19937ar.c
export function mt19937(seed: number = Date.now()): Random {
	const mt = new Uint32Array(N)
	let index = N

	mt[0] = normalizeSeed(seed)

	for (let i = 1; i < N; i++) {
		const s = mt[i - 1] ^ (mt[i - 1] >>> 30)
		mt[i] = (Math.imul(s, 1812433253) + i) >>> 0
	}

	return () => {
		if (index >= N) {
			for (let i = 0; i < N - M; i++) {
				const y = (mt[i] & UPPER_MASK) | (mt[i + 1] & LOWER_MASK)
				mt[i] = mt[i + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)
			}

			for (let i = N - M; i < N - 1; i++) {
				const y = (mt[i] & UPPER_MASK) | (mt[i + 1] & LOWER_MASK)
				mt[i] = mt[i + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)
			}

			const y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK)
			mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)
			index = 0
		}

		let y = mt[index++]

		y ^= y >>> 11
		y ^= (y << 7) & 0x9d2c5680
		y ^= (y << 15) & 0xefc60000
		y ^= y >>> 18

		return (y >>> 0) * INV_MAX_INT
	}
}

// https://github.com/transitive-bullshit/random/tree/master/src/distributions

// Generates a random number from the continuous uniform distribution
// The continuous uniform distribution is a probability distribution that has constant probability over a given interval [min, max]
// It is often used to model situations where all outcomes are equally likely within a certain range.
// https://en.wikipedia.org/wiki/Continuous_uniform_distribution
export function uniform(random: Random, min: number = 0, max: number = 1): Random {
	const range = max - min
	return () => min + range * clampClosedOpen(random())
}

// Generates a random number from the Bernoulli distribution
// The Bernoulli distribution is a discrete probability distribution for a random variable which takes the value 1 with probability p
// and the value 0 with probability 1 - p.
// It is a special case of the binomial distribution with n = 1.
// https://en.wikipedia.org/wiki/Bernoulli_distribution
// 0 <= p < 1
export function bernoulli(random: Random, p: number = 0.5): Random {
	if (!(p > 0)) return zeroRandom
	if (p >= 1) return oneRandom
	return () => (clampClosedOpen(random()) < p ? 1 : 0)
}

// Generates a random number from the Weibull distribution
// The Weibull distribution is often used to model the time until an event occurs, such as the time until a failure in a mechanical system
// or the time until a customer arrives at a service point.
// https://en.wikipedia.org/wiki/Weibull_distribution
// lambda > 0, k > 0
export function weibull(random: Random, lambda: number, k: number): Random {
	if (!(lambda > 0) || !(k > 0)) return zeroRandom

	const e = 1 / k
	return () => lambda * (-Math.log1p(-clampClosedOpen(random()))) ** e
}

// Generates a random number from the exponential distribution
// The exponential distribution is often used to model the time until an event occurs, such as the time until a radioactive particle decays
// or the time until a customer arrives at a service point.
// https://en.wikipedia.org/wiki/Exponential_distribution
// lambda > 0
export function exponential(random: Random, lambda: number = 1): Random {
	if (!(lambda > 0)) return zeroRandom
	return () => -Math.log1p(-clampClosedOpen(random())) / lambda
}

// Generates a random number from the geometric distribution
// The geometric distribution models the number of trials until the first success in a series of Bernoulli trials
// where each trial has a success probability of p.
// https://en.wikipedia.org/wiki/Geometric_distribution
// 0 < p < 1
export function geometric(random: Random, p: number = 0.5): Random {
	if (!(p > 0)) return constantRandom(Number.POSITIVE_INFINITY)
	if (p >= 1) return oneRandom

	const inv = 1 / Math.log1p(-p)
	return () => 1 + Math.floor(Math.log1p(-clampClosedOpen(random())) * inv)
}

// Generates a random number from the Pareto distribution
// The Pareto distribution is a power-law probability distribution that is used to describe phenomena with heavy tails
// such as wealth distribution, city population sizes, and more.
// https://en.wikipedia.org/wiki/Pareto_distribution
// alpha > 0
export function pareto(random: Random, alpha: number = 1): Random {
	if (!(alpha > 0)) return constantRandom(Number.POSITIVE_INFINITY)

	const inv = 1 / alpha
	return () => Math.exp(-Math.log1p(-clampClosedOpen(random())) * inv)
}

// Generates a normally distributed random number using Marsaglia's polar method.
// The normal distribution, also known as the Gaussian distribution, is a continuous probability distribution
// that is symmetric about the mean, showing that data near the mean are more frequent in occurrence than data far from the mean.
// https://en.wikipedia.org/wiki/Marsaglia_polar_method
// https://en.wikipedia.org/wiki/Normal_distribution
// mu = mean, sigma = standard deviation, sigma² = variance
export function normal(random: Random, mu: number = 0, sigma: number = 1): Random {
	if (!(sigma > 0)) return constantRandom(mu)

	let spare = 0
	let hasSpare = false

	return () => {
		if (hasSpare) {
			hasSpare = false
			return mu + sigma * spare
		}

		for (let i = 0; i < 64; i++) {
			const x = clampClosedOpen(random()) * 2 - 1
			const y = clampClosedOpen(random()) * 2 - 1
			const r = x * x + y * y
			if (r <= 0 || r >= 1) continue

			const scale = Math.sqrt((-2 * Math.log(r)) / r)
			spare = y * scale
			hasSpare = true
			return mu + sigma * x * scale
		}

		const radius = Math.sqrt(-2 * Math.log(clampOpen(random())))
		const angle = TAU * clampClosedOpen(random())
		spare = radius * Math.sin(angle)
		hasSpare = true
		return mu + sigma * radius * Math.cos(angle)
	}
}

// Generates a zero-mean normal sample with the requested standard deviation.
export function gaussian(random: Random, sigma: number): Random {
	return normal(random, 0, sigma)
}

// Generates a random number from the triangular distribution.
// https://en.wikipedia.org/wiki/Triangular_distribution
export function triangular(random: Random, min: number = 0, max: number = 1, mode: number = (min + max) * 0.5): Random {
	const lo = Math.min(min, max)
	const hi = Math.max(min, max)
	const range = hi - lo
	if (!(range > 0)) return constantRandom(lo)

	const peak = Math.max(lo, Math.min(mode, hi))
	const split = (peak - lo) / range
	const leftScale = range * (peak - lo)
	const rightScale = range * (hi - peak)

	return () => {
		const u = clampClosedOpen(random())
		if (u < split) return lo + Math.sqrt(u * leftScale)
		return hi - Math.sqrt((1 - u) * rightScale)
	}
}

// Generates a random number from the Rayleigh distribution.
// https://en.wikipedia.org/wiki/Rayleigh_distribution
export function rayleigh(random: Random, sigma: number = 1): Random {
	if (!(sigma > 0)) return zeroRandom

	const scale = Math.SQRT2 * sigma
	return () => scale * Math.sqrt(-Math.log1p(-clampClosedOpen(random())))
}

// Generates a random number from the log-normal distribution.
// https://en.wikipedia.org/wiki/Log-normal_distribution
export function logNormal(random: Random, mu: number = 0, sigma: number = 1): Random {
	const gaussianRandom = normal(random, mu, sigma)
	return () => Math.exp(gaussianRandom())
}

// Generates a random number from the Cauchy distribution.
// https://en.wikipedia.org/wiki/Cauchy_distribution
export function cauchy(random: Random, x0: number = 0, gamma: number = 1): Random {
	if (!(gamma > 0)) return constantRandom(x0)
	return () => x0 + gamma * Math.tan((clampOpen(random()) - 0.5) * TAU * 0.5)
}

// Shuffles the array using a random.
export function shuffle(items: unknown[] | NumberArray, random: Random) {
	for (let i = items.length - 1; i > 0; i--) {
		const k = Math.floor(clampClosedOpen(random()) * (i + 1))
		const value = items[i]
		items[i] = items[k]
		items[k] = value
	}
}
