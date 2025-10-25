export type Random = () => number

// https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript

const MAX_INT = 4294967296

// A simple 32-bit generator, but is extremely fast and has acceptable quality randomness
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
export function mulberry32(seed: number = Date.now()): Random {
	return () => {
		let z = (seed += 0x6d2b79f5)
		z = Math.imul(z ^ (z >>> 15), z | 1)
		z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
		return ((z ^ (z >>> 14)) >>> 0) / MAX_INT
	}
}

// Extremely simple and fast pseudorandom number generator.
export function xorshift32(seed: number = Date.now()): Random {
	return () => {
		seed ^= seed << 13
		seed ^= seed >> 17
		seed ^= seed << 5
		return (seed >>> 0) / MAX_INT
	}
}

// A fast, high-quality generator that is suitable for most applications
export function splitmix32(seed: number = Date.now()) {
	return () => {
		seed |= 0
		seed = (seed + 0x9e3779b9) | 0
		let t = seed ^ (seed >>> 16)
		t = Math.imul(t, 0x21f0aaad)
		t = t ^ (t >>> 15)
		t = Math.imul(t, 0x735a2d97)
		return ((t = t ^ (t >>> 15)) >>> 0) / MAX_INT
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
	let index = N + 1

	mt[0] = seed >>> 0

	for (let i = 1; i < N; i++) {
		const s = mt[i - 1] ^ (mt[i - 1] >>> 30)
		const m = ((((s & 0xffff0000) >>> 16) * 1812433253) << 16) + (s & 0x0000ffff) * 1812433253 + i
		mt[i] = m >>> 0
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

		return (y >>> 0) / MAX_INT
	}
}

// https://github.com/transitive-bullshit/random/tree/master/src/distributions

// Generates a random number from the continuous uniform distribution
// The continuous uniform distribution is a probability distribution that has constant probability over a given interval [min, max]
// It is often used to model situations where all outcomes are equally likely within a certain range.
// https://en.wikipedia.org/wiki/Continuous_uniform_distribution
export function uniform(random: Random, min: number = 0, max: number = 1): Random {
	const range = max - min
	return () => min + range * random()
}

// Generates a random number from the Bernoulli distribution
// The Bernoulli distribution is a discrete probability distribution for a random variable which takes the value 1 with probability p
// and the value 0 with probability 1 - p.
// It is a special case of the binomial distribution with n = 1.
// https://en.wikipedia.org/wiki/Bernoulli_distribution
// 0 <= p < 1
export function bernoulli(random: Random, p: number = 0.5): Random {
	return () => Math.floor(random() + p)
}

// Generates a random number from the Weibull distribution
// The Weibull distribution is often used to model the time until an event occurs, such as the time until a failure in a mechanical system
// or the time until a customer arrives at a service point.
// https://en.wikipedia.org/wiki/Weibull_distribution
// lambda > 0, k > 0
export function weibull(random: Random, lambda: number, k: number): Random {
	const e = 1 / k
	return () => lambda * (-Math.log(1 - random())) ** e
}

// Generates a random number from the exponential distribution
// The exponential distribution is often used to model the time until an event occurs, such as the time until a radioactive particle decays
// or the time until a customer arrives at a service point.
// https://en.wikipedia.org/wiki/Exponential_distribution
// lambda > 0
export function exponential(random: Random, lambda: number = 1): Random {
	return () => -Math.log(1 - random()) / lambda
}

// Generates a random number from the geometric distribution
// The geometric distribution models the number of trials until the first success in a series of Bernoulli trials
// where each trial has a success probability of p.
// https://en.wikipedia.org/wiki/Geometric_distribution
// 0 < p < 1
export function geometric(random: Random, p: number = 0.5): Random {
	const inv = 1 / Math.log(1 - p)
	return () => Math.floor(1 + Math.log(random()) * inv)
}

// Generates a random number from the Pareto distribution
// The Pareto distribution is a power-law probability distribution that is used to describe phenomena with heavy tails
// such as wealth distribution, city population sizes, and more.
// https://en.wikipedia.org/wiki/Pareto_distribution
// alpha > 0
export function pareto(random: Random, alpha: number = 1): Random {
	const inv = 1 / alpha
	return () => 1 / (1 - random()) ** inv
}

// Generates a normally distributed random number using the Box-Muller transform
// The normal distribution, also known as the Gaussian distribution, is a continuous probability distribution
// that is symmetric about the mean, showing that data near the mean are more frequent in occurrence than data far from the mean.
// https://en.wikipedia.org/wiki/Box%E2%80%93Muller_transform
// https://en.wikipedia.org/wiki/Normal_distribution
// mu = mean, sigma = standard deviation, sigma² = variance
export function normal(random: Random, mu: number = 0, sigma: number = 1): Random {
	return () => {
		let r = 0
		let y = 0

		do {
			const x = random() * 2 - 1
			y = random() * 2 - 1
			r = x * x + y * y
		} while (r === 0 || r > 1)

		return mu + sigma * y * Math.sqrt((-2 * Math.log(r)) / r)
	}
}
