import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { automaticBackgroundExtraction } from '../../../src/imaging/processing/background'
import { Bitpix } from '../../../src/io/formats/fits/fits'

// Builds a synthetic floating-point image from a per-pixel generator.
function makeImage(width: number, height: number, channels: number, pixel: (x: number, y: number, channel: number) => number): Image {
	const raw = new Float32Array(width * height * channels)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const base = (y * width + x) * channels
			for (let channel = 0; channel < channels; channel++) raw[base + channel] = pixel(x, y, channel)
		}
	}

	return {
		header: {},
		raw,
		metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 4, pixelSizeInBytes: 4, bitpix: Bitpix.FLOAT, bayer: undefined },
	}
}

// Population standard deviation of one channel plane, ignoring pixels flagged by `skip`.
function channelStdDev(image: Image, channel: number, skip?: (x: number, y: number) => boolean) {
	const { width, height, channels } = image.metadata
	const { raw } = image
	let sum = 0
	let sumSq = 0
	let n = 0

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (skip?.(x, y)) continue
			const p = raw[(y * width + x) * channels + channel]
			sum += p
			sumSq += p * p
			n++
		}
	}

	const mean = sum / n
	return { mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) }
}

test('removes a smooth linear gradient by subtraction', () => {
	const width = 128
	const height = 96
	// Background = pedestal + horizontal + vertical ramp.
	const bg = (x: number, y: number) => 0.1 + 0.35 * (x / (width - 1)) + 0.2 * (y / (height - 1))
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const before = channelStdDev(image, 0)
	expect(before.std).toBeGreaterThan(0.1)

	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 12, targetBackground: 0.1 })

	// The corrected plane should be nearly flat around the requested pedestal.
	const after = channelStdDev(result.image, 0)
	expect(after.std).toBeLessThan(1e-3)
	expect(after.mean).toBeCloseTo(0.1, 3)

	// The fitted model should reproduce the injected gradient across the frame.
	const model = result.background.raw
	for (const [x, y] of [
		[0, 0],
		[width - 1, 0],
		[0, height - 1],
		[width - 1, height - 1],
		[64, 48],
	] as const) {
		expect(model[y * width + x]).toBeCloseTo(bg(x, y), 2)
	}

	expect(result.channels[0].acceptedSamples).toBeGreaterThan(0)
})

test('fits the background under bright stars without being pulled up', () => {
	const width = 128
	const height = 128
	const bg = (x: number, y: number) => 0.12 + 0.25 * (x / (width - 1))
	const stars: ReadonlyArray<readonly [number, number]> = [
		[20, 20],
		[64, 40],
		[100, 90],
		[30, 110],
	]

	const image = makeImage(width, height, 1, (x, y) => {
		let v = bg(x, y)
		// Add compact bright stars (a few pixels wide) on top of the gradient.
		for (const [sx, sy] of stars) {
			const d2 = (x - sx) * (x - sx) + (y - sy) * (y - sy)
			v += 0.8 * Math.exp(-d2 / 4)
		}
		return Math.min(1, v)
	})

	const result = automaticBackgroundExtraction(image, { degree: 2, gridSize: 16, targetBackground: 0.12 })

	// The model must track the gradient, not the stars: sample the model far from every star.
	const model = result.background.raw
	const nearStar = (x: number, y: number) => stars.some(([sx, sy]) => (x - sx) * (x - sx) + (y - sy) * (y - sy) < 100)
	for (const [x, y] of [
		[10, 64],
		[64, 100],
		[118, 20],
	] as const) {
		expect(model[y * width + x]).toBeCloseTo(bg(x, y), 2)
	}

	// Corrected background (away from stars) is flat around the pedestal.
	const after = channelStdDev(result.image, 0, (x, y) => nearStar(x, y))
	expect(after.std).toBeLessThan(5e-3)
	expect(after.mean).toBeCloseTo(0.12, 2)
	expect(result.channels[0].rejectedSamples).toBeGreaterThan(0)
})

test('removes multiplicative vignetting by division', () => {
	const width = 96
	const height = 96
	const cx = (width - 1) / 2
	const cy = (height - 1) / 2
	const signal = 0.5
	// Radial falloff to ~0.6 at the corners.
	const vignette = (x: number, y: number) => {
		const r2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (cx * cx + cy * cy)
		return 1 - 0.4 * r2
	}
	const image = makeImage(width, height, 1, (x, y) => signal * vignette(x, y))

	const before = channelStdDev(image, 0)
	const result = automaticBackgroundExtraction(image, { degree: 4, gridSize: 14, correction: 'divide' })
	const after = channelStdDev(result.image, 0)

	// Division by the modeled flat should flatten the field substantially.
	expect(after.std).toBeLessThan(before.std / 10)
})

test('models every channel of an RGB image independently', () => {
	const width = 80
	const height = 80
	const bg = (x: number, y: number, c: number) => 0.1 + 0.02 * c + 0.2 * (c === 0 ? x / (width - 1) : c === 1 ? y / (height - 1) : (x + y) / (width + height - 2))
	const image = makeImage(width, height, 3, bg)

	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 10 })
	expect(result.channels).toHaveLength(3)

	for (let c = 0; c < 3; c++) {
		const after = channelStdDev(result.image, c)
		expect(after.std).toBeLessThan(2e-3)
	}
})

test('leaves the source untouched when correction is none', () => {
	const width = 64
	const height = 64
	const image = makeImage(width, height, 1, (x, y) => 0.1 + 0.2 * (x / (width - 1)) + 0.1 * (y / (height - 1)))
	const original = Float32Array.from(image.raw)

	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 8, correction: 'none' })

	expect(result.image.raw).toEqual(original)
	// The background model still tracks the gradient.
	expect(result.background.raw[0]).toBeCloseTo(0.1, 2)
	expect(result.background.raw[width - 1]).toBeCloseTo(0.3, 2)
})

test('throws when there are too few clean samples for the degree', () => {
	// A 3x3 grid yields at most 9 samples, fewer than the 28 terms of a degree-6 surface.
	const image = makeImage(48, 48, 1, () => 0.2)
	expect(() => automaticBackgroundExtraction(image, { degree: 6, gridSize: 3 })).toThrow()
})

test('exposes exactly (degree+1)(degree+2)/2 coefficients regardless of sample count', () => {
	const width = 96
	const height = 96
	const image = makeImage(width, height, 1, (x, y) => 0.1 + 0.2 * (x / (width - 1)) + 0.1 * (y / (height - 1)))

	// A dense grid produces far more samples than terms; coefficients must be cropped to the term count.
	for (const degree of [1, 2, 3, 4] as const) {
		const result = automaticBackgroundExtraction(image, { degree, gridSize: 16, correction: 'none' })
		const terms = ((degree + 1) * (degree + 2)) / 2
		expect(result.channels[0].acceptedSamples).toBeGreaterThan(terms)
		expect(result.channels[0].coefficients).toHaveLength(terms)
	}
})

test('fits a high-degree surface accurately (Chebyshev conditioning)', () => {
	const width = 160
	const height = 160
	// A smooth non-monotonic polynomial background that only a high degree can capture. The orthogonal
	// Chebyshev basis keeps the degree-6 least-squares fit well conditioned, where raw monomials would
	// lose precision. Residual rejection is disabled so the surface is judged on approximation alone.
	const bg = (x: number, y: number) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.4 + 0.1 * u + 0.08 * v - 0.05 * u * v + 0.02 * (u * u - 1) + 0.03 * u * u * v
	}
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const result = automaticBackgroundExtraction(image, { degree: 6, gridSize: 24, correction: 'none', rejectionIterations: 0 })
	expect(result.channels[0].coefficients).toHaveLength(28)

	// The evaluated model should track the true surface everywhere, including the frame corners.
	const model = result.background.raw
	let maxError = 0
	for (let y = 0; y < height; y += 8) {
		for (let x = 0; x < width; x += 8) {
			maxError = Math.max(maxError, Math.abs(model[y * width + x] - bg(x, y)))
		}
	}
	expect(maxError).toBeLessThan(4e-3)
})

test('rejects bright structure but keeps faint dark sky (asymmetric rejection)', () => {
	const width = 128
	const height = 128
	const bg = (x: number, y: number) => 0.2 + 0.15 * (x / (width - 1))
	// One bright blob (structure, above the surface) and one faint dark dip (clean sky, below it).
	const blob: readonly [number, number] = [40, 40]
	const dip: readonly [number, number] = [90, 90]

	const image = makeImage(width, height, 1, (x, y) => {
		let v = bg(x, y)
		const db2 = (x - blob[0]) * (x - blob[0]) + (y - blob[1]) * (y - blob[1])
		v += 0.6 * Math.exp(-db2 / 8)
		const dd2 = (x - dip[0]) * (x - dip[0]) + (y - dip[1]) * (y - dip[1])
		v -= 0.03 * Math.exp(-dd2 / 8)
		return Math.max(0, Math.min(1, v))
	})

	// A tight high sigma removes the blob; a very loose low sigma keeps the shallow dip in the fit.
	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 16, rejectionHigh: 2, rejectionLow: 100, correction: 'none' })

	// The model tracks the underlying gradient, unperturbed by the rejected bright blob.
	const model = result.background.raw
	for (const [x, y] of [
		[10, 64],
		[64, 64],
		[118, 64],
	] as const) {
		expect(model[y * width + x]).toBeCloseTo(bg(x, y), 2)
	}
	expect(result.channels[0].rejectedSamples).toBeGreaterThan(0)
})

test('down-weights noisy boxes so biased samples do not tilt the fit', () => {
	const width = 96
	const height = 96
	const bg = (x: number, y: number) => 0.2 + 0.2 * (x / (width - 1))
	// Deterministic pseudo-noise in [0, 1) for reproducibility.
	const noise = (x: number, y: number) => {
		const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
		return s - Math.floor(s)
	}
	// The left band is biased strongly upward with high internal dispersion; reliable low-dispersion
	// boxes elsewhere should dominate the weighted fit and keep the plane on the true gradient.
	const image = makeImage(width, height, 1, (x, y) => {
		let v = bg(x, y)
		if (x < 24) v += 0.1 + 0.25 * noise(x, y)
		return Math.max(0, Math.min(1, v))
	})

	// Rejection is disabled (tolerance 0, no residual iterations) to isolate the weighting effect.
	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 12, tolerance: 0, rejectionIterations: 0, correction: 'none' })
	const model = result.background.raw

	// Without weighting the biased band would visibly lift the left side of the degree-1 plane; the
	// weighted fit stays within a percent of the true gradient across the frame, including that band.
	for (const [x, y] of [
		[10, 48],
		[48, 48],
		[85, 48],
	] as const) {
		expect(Math.abs(model[y * width + x] - bg(x, y))).toBeLessThan(0.01)
	}
})
