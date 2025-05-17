export type Random = () => number

export function mulberry32(seed: number): Random {
	return () => {
		let z = (seed += 0x6d2b79f5)
		z = Math.imul(z ^ (z >>> 15), z | 1)
		z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
		return ((z ^ (z >>> 14)) >>> 0) / 4294967296
	}
}

// https://github.com/transitive-bullshit/random/tree/master/src/distributions

// https://en.wikipedia.org/wiki/Continuous_uniform_distribution
export function uniform(random: Random, min: number = 0, max: number = 1): Random {
	const range = max - min
	return () => min + range * random()
}

// https://en.wikipedia.org/wiki/Bernoulli_distribution
// 0 <= p < 1
export function bernoulli(random: Random, p: number = 0.5): Random {
	return () => Math.floor(random() + p)
}

// https://en.wikipedia.org/wiki/Weibull_distribution
// lambda > 0, k > 0
export function weibull(random: Random, lambda: number, k: number): Random {
	const e = 1 / k
	return () => lambda * (-Math.log(1 - random())) ** e
}

// https://en.wikipedia.org/wiki/Exponential_distribution
// lambda > 0
export function exponential(random: Random, lambda: number = 1): Random {
	return () => -Math.log(1 - random()) / lambda
}

// https://en.wikipedia.org/wiki/Geometric_distribution
// 0 < p < 1
export function geometric(random: Random, p: number = 0.5): Random {
	const inv = 1 / Math.log(1 - p)
	return () => Math.floor(1 + Math.log(random()) * inv)
}

// https://en.wikipedia.org/wiki/Pareto_distribution
// alpha > 0
export function pareto(random: Random, alpha: number = 1): Random {
	const inv = 1 / alpha
	return () => 1 / (1 - random()) ** inv
}

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
