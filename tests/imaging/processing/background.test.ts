import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { applyBackground, automaticBackgroundExtraction, backgroundExclusionMaskFromStars, evaluateBackgroundModel, fitBackgroundSurface } from '../../../src/imaging/processing/background'
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
	expect(Math.abs(after.mean - 0.1)).toBeLessThan(1e-3)

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

test('reports the output range and rescales instead of truncating', () => {
	const width = 96
	const height = 96
	const bg = (x: number) => 0.3 + 0.3 * (x / (width - 1))
	// Zero-mean deterministic noise remains after the smooth gradient is removed; with a zero pedestal
	// it drives roughly half the corrected pixels below 0, exercising the clipping modes.
	const noise = (x: number, y: number) => {
		const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
		return (s - Math.floor(s)) * 2 - 1
	}
	const makeNoisy = () => makeImage(width, height, 1, (x, y) => Math.max(0, Math.min(1, bg(x) + 0.05 * noise(x, y))))

	// truncate: the correction pushed values below 0, and the model reports that pre-clipping range.
	const truncated = automaticBackgroundExtraction(makeNoisy(), { degree: 1, gridSize: 12, targetBackground: 0, clipping: 'truncate' })
	expect(truncated.channels[0].outputMin!).toBeLessThan(0)
	// The low side is clamped to 0 by truncation.
	let clampedToZero = 0
	for (const v of truncated.image.raw) if (v === 0) clampedToZero++
	expect(clampedToZero).toBeGreaterThan(0)

	// rescale: the same out-of-range field is linearly mapped into [0, 1] instead of clipped.
	const rescaled = automaticBackgroundExtraction(makeNoisy(), { degree: 1, gridSize: 12, targetBackground: 0, clipping: 'rescale' })
	let rmin = Infinity
	let rmax = -Infinity
	for (const v of rescaled.image.raw) {
		rmin = Math.min(rmin, v)
		rmax = Math.max(rmax, v)
	}
	expect(rmin).toBeCloseTo(0, 3)
	expect(rmax).toBeCloseTo(1, 3)
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

test('rejects a non-finite gridSize instead of hanging', () => {
	// A non-finite gridSize would collapse the cell size to zero and produce infinite grid dimensions,
	// hanging the sampling loops. It must fail fast with a clear error instead.
	const image = makeImage(16, 16, 1, () => 0.2)
	expect(() => automaticBackgroundExtraction(image, { gridSize: Infinity })).toThrow()
	expect(() => automaticBackgroundExtraction(image, { gridSize: Number.NaN })).toThrow()
	expect(() => fitBackgroundSurface(image, { gridSize: Infinity })).toThrow()
})

test('keeps the reported accepted set consistent with the kept fit after a failed refit', () => {
	// A very tight residual threshold makes the first rejection pass drop the active set below the 6
	// terms of a degree-2 surface, so the refit is unsolvable. The accepted samples reinstated in that
	// pass must be restored, so the reported accepted count never falls below the coefficients actually
	// evaluated; otherwise the surface would be built from more samples than the result claims.
	const width = 60
	const height = 60
	// Mild cubic structure a degree-2 surface cannot fully capture, leaving a non-zero residual spread.
	const bg = (x: number, y: number) => {
		const u = x / (width - 1)
		const v = y / (height - 1)
		return 0.3 + 0.2 * u * u * u + 0.15 * v * v * v + 0.05 * u * v
	}
	const image = makeImage(width, height, 1, bg)

	const model = fitBackgroundSurface(image, { degree: 2, gridSize: 3, tolerance: 0, rejectionHigh: 0.01, rejectionLow: 0.01, rejectionIterations: 2 })
	const surface = model.surfaces[0]

	expect(surface.acceptedSamples).toBeGreaterThanOrEqual(surface.coefficients.length)
	for (const c of surface.coefficients) expect(Number.isFinite(c)).toBe(true)
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

test('reports zero smoothing for a polynomial model', () => {
	// Smoothing only applies to the thin-plate spline; a polynomial fit ignores it, so the reported
	// metadata must be 0 even when the smoothing option defaults to a non-zero value.
	const image = makeImage(48, 48, 1, (x, y) => 0.2 + 0.1 * (x / 47) + 0.05 * (y / 47))
	expect(fitBackgroundSurface(image, { model: 'polynomial', degree: 1 }).smoothing).toBe(0)
	// An explicit smoothing option is still ignored for the polynomial model.
	expect(fitBackgroundSurface(image, { model: 'polynomial', degree: 1, smoothing: 0.5 }).smoothing).toBe(0)
	// The thin-plate spline still reports its smoothing.
	expect(fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 8, smoothing: 0.3 }).smoothing).toBe(0.3)
})

test('normalizes a non-finite smoothing to a finite value', () => {
	// A NaN smoothing would otherwise leak into the model: fitThinPlateSpline would treat it as zero
	// (NaN > 0 is false) and interpolate, while evaluateBackgroundModel would still coarsen (NaN <= 0 is
	// false), producing an inconsistent, non-exact surface. It must be normalized to a finite smoothing.
	const image = makeImage(64, 64, 1, (x, y) => 0.2 + 0.1 * (x / 63) + 0.05 * (y / 63))
	const model = fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 8, smoothing: Number.NaN })

	expect(Number.isFinite(model.smoothing)).toBe(true)
	// The evaluated surface is well-defined everywhere (no NaN leaked through the fit or evaluation).
	const background = evaluateBackgroundModel(model, image).raw
	for (const v of background) expect(Number.isFinite(v)).toBe(true)
})

test('normalizes non-finite numeric options to their defaults', () => {
	// A NaN in a threshold or count would silently disable a feature (x > NaN and x < -NaN are both
	// false) or poison the fit. Each such option must fall back to its default, so a NaN-riddled call
	// still behaves like the default run: a plain linear gradient is fitted and removed cleanly.
	const width = 96
	const height = 96
	const bg = (x: number, y: number) => 0.15 + 0.3 * (x / (width - 1)) + 0.2 * (y / (height - 1))
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const model = fitBackgroundSurface(image, {
		degree: Number.NaN,
		boxSize: Number.NaN,
		tolerance: Number.NaN,
		rejectionHigh: Number.NaN,
		rejectionLow: Number.NaN,
		rejectionIterations: Number.NaN,
	})

	// degree falls back to the default (4), not NaN, so the coefficient count is well-defined.
	expect(model.degree).toBe(4)
	expect(model.surfaces[0].coefficients).toHaveLength(((4 + 1) * (4 + 2)) / 2)

	const background = evaluateBackgroundModel(model, image).raw
	let maxError = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) maxError = Math.max(maxError, Math.abs(background[y * width + x] - bg(x, y)))
	}
	expect(maxError).toBeLessThan(1e-3)
})

test('explicit box sizes keep every sampled pixel in the statistics buffer', () => {
	const width = 30
	const height = 30
	const bg = (x: number, y: number) => 0.1 + 0.3 * (x / (width - 1)) + 0.2 * (y / (height - 1))
	const image = makeImage(width, height, 1, bg)

	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 10, boxSize: 4, tolerance: 0, rejectionIterations: 0, correction: 'none' })

	const model = result.background.raw
	let maxError = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) maxError = Math.max(maxError, Math.abs(model[y * width + x] - bg(x, y)))
	}

	expect(maxError).toBeLessThan(0.01)
})

test('fits a linear gradient exactly at the frame edges with a default box', () => {
	// With the default box, edge cells clip the sampling window asymmetrically. If a sample is recorded
	// at its unclipped cell center rather than the clipped box centroid, its median (drawn from a shifted
	// window) is attributed to the wrong coordinate, biasing the fit at the border (~0.057 off here). A
	// linear gradient must be reproduced to float precision everywhere, corners included.
	const width = 10
	const height = 10
	const bg = (x: number, y: number) => 0.1 + 0.4 * (x / (width - 1)) + 0.3 * (y / (height - 1))
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 10, tolerance: 0, rejectionIterations: 0 })
	const background = evaluateBackgroundModel(model, image).raw

	let maxError = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) maxError = Math.max(maxError, Math.abs(background[y * width + x] - bg(x, y)))
	}
	expect(maxError).toBeLessThan(1e-5)
})

test('an explicit boxSize samples exactly that many pixels per axis', () => {
	// boxSize is the sampled side length in pixels. A boxSize of 1 must sample a single pixel per box,
	// not a 2x2 window (which a real-valued half-size with inclusive floor/ceil bounds would produce for
	// fractional grid centers). With one pixel per box no box reaches the 4-pixel minimum, so every box
	// is skipped and the fit fails for lack of samples. A boxSize of 2 samples exactly a 2x2 = 4-pixel
	// box, which meets the minimum and yields one sample per grid cell.
	const image = makeImage(64, 64, 1, (x, y) => 0.2 + 0.1 * (x / 63) + 0.05 * (y / 63))

	expect(() => fitBackgroundSurface(image, { degree: 1, gridSize: 20, boxSize: 1, tolerance: 0, rejectionIterations: 0 })).toThrow()

	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 20, boxSize: 2, tolerance: 0, rejectionIterations: 0 })
	expect(model.surfaces[0].samples.length).toBe(20 * 20)
})

test('a boxSize larger than the frame does not oversize the sample buffers', () => {
	// The scratch buffers must be sized by the clipped box extents, not the requested side length: a box
	// can never span more than width pixels across or height pixels down. On this tall, narrow frame the
	// requested boxSize is far larger than the image, so buffers sized by boxSize squared (~70000^2)
	// would exhaust memory before any clipping. Sizing by the clipped extents keeps the allocation to the
	// frame, so the call completes and fails only for the expected reason (every box spans the whole
	// frame, collapsing all samples to one position).
	const image = makeImage(2, 70000, 1, (x, y) => 0.2 + 0.0001 * y)
	let error: unknown
	try {
		fitBackgroundSurface(image, { degree: 1, boxSize: 200000 })
	} catch (e) {
		error = e
	}
	expect(error).toBeInstanceOf(Error)
	// Reached the fit stage (a domain error about the surface fit) rather than dying on an oversized
	// allocation. Every box spans the whole frame, collapsing all samples onto one position.
	expect((error as Error).message).toContain('surface')
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

test('separable polynomial evaluation matches the full tensor-basis sum', () => {
	// evaluateChannelSurface factorizes the tensor Chebyshev basis per row (rowCoef[i] = Σ_j coef*T_j(v))
	// so the per-pixel loop is degree+1 multiplies instead of `terms`. This asserts the factorized result
	// equals a direct brute-force sum over every term at each pixel, within float32 storage precision.
	const width = 70
	const height = 55
	const degree = 6
	const image = makeImage(width, height, 1, (x, y) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.4 + 0.12 * u - 0.09 * v + 0.05 * u * v - 0.04 * (u * u - 1) + 0.03 * u * u * v
	})

	const model = fitBackgroundSurface(image, { degree, gridSize: 16, correction: 'none' } as const)
	const coef = model.surfaces[0].coefficients

	// Rebuild the tensor-basis exponents in fillBasisExponents order: ascending total degree d, ti = i,
	// tj = d - i, i from d down to 0.
	const ti: number[] = []
	const tj: number[] = []
	for (let d = 0; d <= degree; d++) {
		for (let i = d; i >= 0; i--) {
			ti.push(i)
			tj.push(d - i)
		}
	}
	const cheb = (n: number, t: number) => {
		let t0 = 1
		if (n === 0) return t0
		let t1 = t
		for (let d = 2; d <= n; d++) {
			const next = 2 * t * t1 - t0
			t0 = t1
			t1 = next
		}
		return t1
	}

	const evaluated = evaluateBackgroundModel(model, image).raw
	let maxError = 0
	for (let y = 0; y < height; y++) {
		const v = (y / (height - 1)) * 2 - 1
		for (let x = 0; x < width; x++) {
			const u = (x / (width - 1)) * 2 - 1
			let ref = 0
			for (let k = 0; k < ti.length; k++) ref += coef[k] * cheb(ti[k], u) * cheb(tj[k], v)
			maxError = Math.max(maxError, Math.abs(evaluated[y * width + x] - ref))
		}
	}
	expect(maxError).toBeLessThan(1e-5)
})

test('keeps dense-grid samples inside the fit domain', () => {
	// A grid dense enough that cells are narrower than 2 px (cellW = width / nx < 2). Naive centers at
	// (c + 0.5) * cellW push the last ones past width - 1, so their normalized u/v leave the [-1, 1]
	// Chebyshev domain while the evaluated surface only spans [-1, 1] — biasing the quadratic fit at the
	// edges. With the clamp, every sample stays in domain and the surface tracks the true corners.
	const width = 40
	const height = 40
	const bg = (x: number, y: number) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.3 + 0.12 * u + 0.09 * v + 0.05 * (u * u - 1) + 0.04 * (v * v - 1)
	}
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const model = fitBackgroundSurface(image, { degree: 2, gridSize: 60, tolerance: 0, rejectionIterations: 0 })
	const samples = model.surfaces[0].samples

	// Every sample must stay within the pixel-center span [0, width - 1] / [0, height - 1] so its
	// normalized u/v stays in [-1, 1]; without the clamp the last centers reach ~39.67 on a 40 px axis.
	let maxX = 0
	let maxY = 0
	for (const sample of samples) {
		expect(sample.x).toBeGreaterThanOrEqual(0)
		expect(sample.y).toBeGreaterThanOrEqual(0)
		expect(sample.x).toBeLessThanOrEqual(width - 1)
		expect(sample.y).toBeLessThanOrEqual(height - 1)
		maxX = Math.max(maxX, sample.x)
		maxY = Math.max(maxY, sample.y)
	}

	// The grid is dense enough (cells < 2 px) that the edge cells reach the frame border, confirming the
	// clamp is exercised rather than trivially satisfied by a sparse grid. Samples record the clipped box
	// centroid, so the extreme is a pixel or two inside the last column/row, not exactly width - 1.
	expect(maxX).toBeGreaterThan(width - 4)
	expect(maxY).toBeGreaterThan(height - 4)
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

test('rejects gross outliers on a flat frame where the residual MAD is zero', () => {
	// A flat 0.2 frame with four uniformly bright (0.8) sample boxes. The bright boxes have zero internal
	// dispersion, so they survive the box-dispersion prefilter (disabled here to isolate the residual
	// stage), and a symmetric linear surface stays constant, so nearly all residuals are identical and
	// the robust MAD degenerates to ~0. If rejection stops on that near-zero MAD, the four outliers stay
	// active and pull the constant model up to ~0.2375. The standard-deviation fallback must still catch
	// them, leaving the surface on the true flat background.
	const width = 80
	const height = 80
	// Four small bright patches, each covering a single sample box at gridSize 8 (cell = 10 px).
	const centers: ReadonlyArray<readonly [number, number]> = [
		[25, 25],
		[55, 25],
		[25, 55],
		[55, 55],
	]
	const bright = (x: number, y: number) => centers.some(([cx, cy]) => Math.abs(x - cx) <= 3 && Math.abs(y - cy) <= 3)
	const image = makeImage(width, height, 1, (x, y) => (bright(x, y) ? 0.8 : 0.2))

	const result = automaticBackgroundExtraction(image, { degree: 1, gridSize: 8, tolerance: 0, correction: 'none' })

	// The bright boxes are rejected, not absorbed into the surface.
	expect(result.channels[0].rejectedSamples).toBeGreaterThan(0)

	// The modeled background sits on the true flat level, not pulled up toward ~0.2375.
	const model = result.background.raw
	for (const [x, y] of [
		[5, 5],
		[75, 5],
		[5, 75],
		[75, 75],
		[40, 40],
	] as const) {
		expect(model[y * width + x]).toBeCloseTo(0.2, 3)
	}
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

test('fitBackgroundSurface fits without mutating the source', () => {
	const width = 64
	const height = 48
	const image = makeImage(width, height, 1, (x, y) => 0.15 + 0.2 * (x / (width - 1)) + 0.1 * (y / (height - 1)))
	const original = Float32Array.from(image.raw)

	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 8 })

	// The source pixels are untouched by fitting.
	expect(image.raw).toEqual(original)
	// Geometry and per-channel surfaces are reported.
	expect(model.width).toBe(width)
	expect(model.height).toBe(height)
	expect(model.channelCount).toBe(1)
	expect(model.degree).toBe(1)
	expect(model.surfaces).toHaveLength(1)
	expect(model.surfaces[0].coefficients).toHaveLength(3)
})

test('fit + evaluate + apply reproduces automaticBackgroundExtraction', () => {
	const width = 96
	const height = 80
	const bg = (x: number, y: number, c: number) => 0.1 + 0.02 * c + 0.25 * (x / (width - 1)) - 0.1 * (y / (height - 1))
	const options = { degree: 2, gridSize: 12, targetBackground: 0.1 } as const

	// One-shot orchestrator.
	const oneShot = automaticBackgroundExtraction(makeImage(width, height, 3, bg), options)

	// Composed pipeline on a fresh identical image.
	const composed = makeImage(width, height, 3, bg)
	const model = fitBackgroundSurface(composed, options)
	const background = evaluateBackgroundModel(model, composed)
	const ranges = applyBackground(composed, background, { correction: 'subtract', targetBackground: 0.1 })

	// Background models and corrected images match bit for bit.
	expect(background.raw).toEqual(oneShot.background.raw)
	expect(composed.raw).toEqual(oneShot.image.raw)
	// Output ranges match the orchestrator's per-channel diagnostics.
	for (let c = 0; c < 3; c++) {
		expect(ranges[c].min).toBeCloseTo(oneShot.channels[c].outputMin!, 6)
		expect(ranges[c].max).toBeCloseTo(oneShot.channels[c].outputMax!, 6)
	}
})

test('a fitted model can be reused to correct another frame of the same geometry', () => {
	const width = 80
	const height = 80
	const bg = (x: number, y: number) => 0.2 + 0.3 * (x / (width - 1)) + 0.15 * (y / (height - 1))

	// Fit the background on frame A.
	const frameA = makeImage(width, height, 1, bg)
	const model = fitBackgroundSurface(frameA, { degree: 1, gridSize: 10 })

	// Apply the same model to frame B, which shares the identical gradient.
	const frameB = makeImage(width, height, 1, bg)
	const background = evaluateBackgroundModel(model, frameB)
	applyBackground(frameB, background, { correction: 'subtract', targetBackground: 0.1 })

	// Frame B is flattened around the pedestal.
	let sum = 0
	let sumSq = 0
	for (const v of frameB.raw) {
		sum += v
		sumSq += v * v
	}
	const mean = sum / frameB.raw.length
	const std = Math.sqrt(Math.max(0, sumSq / frameB.raw.length - mean * mean))
	expect(mean).toBeCloseTo(0.1, 3)
	expect(std).toBeLessThan(1e-3)
})

test('evaluate and apply reject mismatched geometry', () => {
	const model = fitBackgroundSurface(
		makeImage(64, 64, 1, () => 0.2),
		{ degree: 1, gridSize: 8 },
	)

	// Evaluating against a differently sized image throws.
	expect(() =>
		evaluateBackgroundModel(
			model,
			makeImage(32, 64, 1, () => 0.2),
		),
	).toThrow()

	// Applying a mismatched background image throws.
	const image = makeImage(64, 64, 1, () => 0.2)
	const wrongBackground = makeImage(64, 32, 1, () => 0.2)
	expect(() => applyBackground(image, wrongBackground)).toThrow()
})

test('exposes the grid sample map for inspection', () => {
	const width = 128
	const height = 128
	const bg = (x: number) => 0.15 + 0.2 * (x / (width - 1))
	// A bright blob contaminates a few boxes, which should be reported as rejected samples.
	const image = makeImage(width, height, 1, (x, y) => {
		const d2 = (x - 40) * (x - 40) + (y - 40) * (y - 40)
		return Math.min(1, bg(x) + 0.7 * Math.exp(-d2 / 8))
	})

	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 16 })
	const samples = model.surfaces[0].samples

	// The sample list is non-empty and consistent with the accepted/rejected counters.
	expect(samples.length).toBe(model.surfaces[0].acceptedSamples + model.surfaces[0].rejectedSamples)
	expect(samples.some((s) => !s.accepted)).toBe(true)

	for (const s of samples) {
		// Positions fall inside the frame and weights are in (0, 1].
		expect(s.x).toBeGreaterThanOrEqual(0)
		expect(s.x).toBeLessThan(width)
		expect(s.y).toBeGreaterThanOrEqual(0)
		expect(s.y).toBeLessThan(height)
		expect(s.weight).toBeGreaterThan(0)
		expect(s.weight).toBeLessThanOrEqual(1)
	}

	// Samples sitting on the blob are rejected; those far from it are kept.
	const onBlob = samples.find((s) => Math.abs(s.x - 40) < 8 && Math.abs(s.y - 40) < 8)
	expect(onBlob?.accepted).toBe(false)
})

test('an exclusion mask keeps masked regions out of the fit', () => {
	const width = 128
	const height = 128
	const bg = (x: number, y: number) => 0.15 + 0.2 * (x / (width - 1)) + 0.1 * (y / (height - 1))
	// A large bright object the internal dispersion test cannot fully reject on its own.
	const object: readonly [number, number, number] = [40, 40, 18]
	const image = makeImage(width, height, 1, (x, y) => {
		const inside = (x - object[0]) * (x - object[0]) + (y - object[1]) * (y - object[1]) < object[2] * object[2]
		return Math.min(1, bg(x, y) + (inside ? 0.5 : 0))
	})

	// Mask out a disk covering the object.
	const mask = new Uint8Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const d2 = (x - object[0]) * (x - object[0]) + (y - object[1]) * (y - object[1])
			if (d2 < (object[2] + 4) * (object[2] + 4)) mask[y * width + x] = 1
		}
	}

	const masked = fitBackgroundSurface(image, { degree: 1, gridSize: 12, exclusionMask: mask })

	// The model tracks the true gradient even at the masked object's location.
	const bgImage = evaluateBackgroundModel(masked, image)
	expect(bgImage.raw[object[1] * width + object[0]]).toBeCloseTo(bg(object[0], object[1]), 2)

	// No accepted sample falls inside the masked disk.
	for (const s of masked.surfaces[0].samples) {
		if (!s.accepted) continue
		const d2 = (s.x - object[0]) * (s.x - object[0]) + (s.y - object[1]) * (s.y - object[1])
		expect(d2).toBeGreaterThan(object[2] * object[2])
	}
})

test('fits a linear gradient exactly through a wide exclusion band', () => {
	// A wide vertical exclusion band clips whole columns from the boxes it overlaps, leaving a shifted
	// rectangular window. If the sample is recorded at the geometric box center instead of the centroid
	// of the pixels that actually contributed, the median from the unmasked edge is paired with the
	// masked band's center coordinate, biasing the fit. With the contributing-pixel centroid, an exactly
	// linear background must still be reproduced to numerical precision even across the band.
	const width = 128
	const height = 128
	const bg = (x: number, y: number) => 0.1 + 0.4 * (x / (width - 1)) + 0.3 * (y / (height - 1))
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const mask = new Uint8Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 50; x < 80; x++) mask[y * width + x] = 1
	}

	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 12, tolerance: 0, rejectionIterations: 0, exclusionMask: mask })
	const background = evaluateBackgroundModel(model, image).raw

	let maxError = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) maxError = Math.max(maxError, Math.abs(background[y * width + x] - bg(x, y)))
	}
	expect(maxError).toBeLessThan(1e-5)
})

test('backgroundExclusionMaskFromStars marks disks around stars', () => {
	const width = 64
	const height = 64
	const stars = [
		{ x: 20, y: 30, hfd: 4, fwhm: 3, snr: 50, flux: 1000 },
		{ x: 50, y: 12, hfd: 2, fwhm: 1.5, snr: 20, flux: 200 },
	]

	const mask = backgroundExclusionMaskFromStars(width, height, stars, { radiusScale: 1.5, minRadius: 4 })
	expect(mask).toHaveLength(width * height)

	// Star centers are masked.
	expect(mask[30 * width + 20]).toBe(1)
	expect(mask[12 * width + 50]).toBe(1)
	// A point far from every star is not.
	expect(mask[0]).toBe(0)

	// The first star's disk radius is max(4, 1.5*4) = 6: a pixel 5px away is masked, 8px away is not.
	expect(mask[30 * width + 25]).toBe(1)
	expect(mask[30 * width + (20 + 8)]).toBe(0)
})

test('fitBackgroundSurface rejects a wrongly sized exclusion mask', () => {
	const image = makeImage(64, 64, 1, () => 0.2)
	expect(() => fitBackgroundSurface(image, { degree: 1, gridSize: 8, exclusionMask: new Uint8Array(10) })).toThrow()
})

test('rejects an ill-conditioned thin-strip sample layout instead of extrapolating', () => {
	// A linear ramp with everything masked except one narrow vertical strip. The surviving sample boxes
	// share (almost) the same u, so the horizontal slope is undetermined: the QR is nominally full rank
	// (the pivot is non-zero only through floating-point noise) but the fit extrapolates to values far
	// outside the image range (~[-7, 9] here). The layout must be rejected rather than materialized.
	const width = 128
	const height = 128
	const bg = (x: number) => 0.1 + 0.8 * (x / (width - 1))
	const image = makeImage(width, height, 1, (x) => bg(x))

	// Keep only a strip aligned to a single box column (gridSize 16 -> box centers every 8 px at ...60).
	const mask = new Uint8Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) if (!(x >= 57 && x < 63)) mask[y * width + x] = 1
	}
	expect(() => fitBackgroundSurface(image, { degree: 1, gridSize: 16, exclusionMask: mask })).toThrow()

	// The same ramp without the mask fits cleanly and stays within the image value range.
	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 16 })
	const background = evaluateBackgroundModel(model, image).raw
	let min = Infinity
	let max = -Infinity
	for (const v of background) {
		min = Math.min(min, v)
		max = Math.max(max, v)
	}
	expect(min).toBeGreaterThan(0)
	expect(max).toBeLessThan(1)
})

test('thin-plate spline follows a complex background a polynomial cannot', () => {
	const width = 128
	const height = 128
	// A non-monotonic sinusoidal background: too wiggly for a low-degree polynomial without oscillating.
	const bg = (x: number, y: number) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.4 + 0.12 * Math.sin(2.6 * u) * Math.cos(2.2 * v) + 0.05 * u
	}
	const image = () => makeImage(width, height, 1, (x, y) => bg(x, y))

	const errorFor = (raw: Float32Array | Float64Array) => {
		let maxError = 0
		for (let y = 0; y < height; y += 4) {
			for (let x = 0; x < width; x += 4) maxError = Math.max(maxError, Math.abs(raw[y * width + x] - bg(x, y)))
		}
		return maxError
	}

	const tps = fitBackgroundSurface(image(), { model: 'thinPlateSpline', gridSize: 16, smoothing: 0.05 })
	expect(tps.type).toBe('thinPlateSpline')
	expect(tps.surfaces[0].controlPoints).toBeDefined()
	expect(tps.surfaces[0].controlPoints!.length).toBe(tps.surfaces[0].acceptedSamples * 2)
	expect(tps.surfaces[0].residual).toBeLessThan(0.005)
	const tpsError = errorFor(evaluateBackgroundModel(tps, image()).raw)

	const poly = fitBackgroundSurface(image(), { model: 'polynomial', degree: 4, gridSize: 16 })
	const polyError = errorFor(evaluateBackgroundModel(poly, image()).raw)

	// The spline tracks the surface far more accurately than the polynomial on this background.
	expect(tpsError).toBeLessThan(0.02)
	expect(tpsError).toBeLessThan(polyError / 5)
})

test('thin-plate spline preserves a smooth localized dome through rejection', () => {
	// A smooth Gaussian light-pollution dome — the documented TPS use case. The default residual
	// rejection is tuned for a global polynomial, which cannot represent the dome, so running it here
	// would flag the dome samples as outliers and fit the spline only to the surrounding floor (the
	// center came out ~0.29 too low). Rejection must be skipped for TPS: the spline has to follow the
	// dome, with every clean sample retained.
	const width = 256
	const height = 256
	const cx = width / 2
	const cy = height / 2
	const sigma = 60
	const dome = (x: number, y: number) => {
		const dx = x - cx
		const dy = y - cy
		return 0.1 + 0.4 * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
	}
	const image = makeImage(width, height, 1, (x, y) => dome(x, y))

	const model = fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 24 })
	// No clean sample is rejected: the box-dispersion prefilter finds no star contamination here.
	expect(model.surfaces[0].acceptedSamples).toBe(model.surfaces[0].samples.length)

	const background = evaluateBackgroundModel(model, image).raw
	// The spline follows the dome to the center rather than the flanks; the peak is captured, not missed.
	expect(Math.abs(dome(cx, cy) - background[cy * width + cx])).toBeLessThan(0.01)

	let maxError = 0
	for (let y = 0; y < height; y += 4) {
		for (let x = 0; x < width; x += 4) maxError = Math.max(maxError, Math.abs(background[y * width + x] - dome(x, y)))
	}
	expect(maxError).toBeLessThan(0.015)
})

test('thin-plate spline extraction flattens a complex gradient', () => {
	const width = 96
	const height = 96
	const bg = (x: number, y: number) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.35 + 0.1 * Math.sin(2 * u) - 0.08 * v * v + 0.06 * u * v
	}
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const result = automaticBackgroundExtraction(image, { model: 'thinPlateSpline', gridSize: 14, smoothing: 0.05, targetBackground: 0.2 })
	const after = channelStdDev(result.image, 0)

	expect(result.background.raw).toBeDefined()
	expect(after.mean).toBeCloseTo(0.2, 2)
	expect(after.std).toBeLessThan(5e-3)
})

test('caps thin-plate spline control points on dense grids', () => {
	// A dense grid produces far more accepted samples than the TPS control-point cap (1024). The fit
	// must subsample the control points to stay tractable (the dense solve is O(k^3)) while still
	// reporting every accepted sample and following the background. The default grid stays under the cap.
	const width = 400
	const height = 400
	const bg = (x: number, y: number) => 0.3 + 0.15 * Math.sin(3 * (x / width)) * Math.cos(3 * (y / height)) + 0.1 * (x / width)
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const dense = fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 48, smoothing: 0.05 })
	const controlPoints = dense.surfaces[0].controlPoints!.length / 2
	// Far more samples survive than control points are kept, and the kept set honors the cap.
	expect(dense.surfaces[0].acceptedSamples).toBeGreaterThan(1024)
	expect(controlPoints).toBeLessThanOrEqual(1024)

	// The capped spline still tracks the background.
	const background = evaluateBackgroundModel(dense, image).raw
	let maxError = 0
	for (let y = 0; y < height; y += 4) {
		for (let x = 0; x < width; x += 4) maxError = Math.max(maxError, Math.abs(background[y * width + x] - bg(x, y)))
	}
	expect(maxError).toBeLessThan(0.03)

	// A default-density grid stays under the cap, so every accepted sample is a control point.
	const normal = fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 16, smoothing: 0.05 })
	expect(normal.surfaces[0].controlPoints!.length).toBe(normal.surfaces[0].acceptedSamples * 2)
}, 4000)

test('an exact thin-plate spline interpolates every accepted sample past the control-point cap', () => {
	// With smoothing 0 the spline is an exact interpolant, but a dense grid exceeds the control-point
	// cap. Samples the cap drops must be marked rejected, not left accepted, so the reported accepted set
	// equals the interpolated control set — otherwise evaluation (which treats a zero-smoothing model as
	// exact) would fail to reproduce the medians of accepted-but-dropped samples.
	const width = 400
	const height = 400
	const bg = (x: number, y: number) => 0.3 + 0.15 * Math.sin(3 * (x / width)) * Math.cos(3 * (y / height)) + 0.1 * (x / width)
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	const model = fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 48, smoothing: 0 })
	const surface = model.surfaces[0]
	const controlPoints = surface.controlPoints!.length / 2

	// The cap engaged (more samples survived than are kept) and the accepted set is exactly the control
	// set, so nothing is claimed interpolated that the spline does not pass through.
	expect(controlPoints).toBeLessThanOrEqual(1024)
	expect(surface.acceptedSamples).toBe(controlPoints)
	expect(surface.rejectedSamples).toBeGreaterThan(0)

	// Every accepted sample is reproduced by the fitted spline to float precision.
	const coef = surface.coefficients
	const cp = surface.controlPoints!
	const k = cp.length / 2
	const tps = (u: number, v: number) => {
		let sum = coef[0] + coef[1] * u + coef[2] * v
		for (let c = 0; c < k; c++) {
			const du = u - cp[2 * c]
			const dv = v - cp[2 * c + 1]
			const sq = du * du + dv * dv
			if (sq > 0) sum += coef[3 + c] * (0.5 * sq * Math.log(sq))
		}
		return sum
	}
	let maxInterpError = 0
	for (const sample of surface.samples) {
		if (!sample.accepted) continue
		const u = (sample.x / (width - 1)) * 2 - 1
		const v = (sample.y / (height - 1)) * 2 - 1
		maxInterpError = Math.max(maxInterpError, Math.abs(tps(u, v) - sample.value))
	}
	expect(maxInterpError).toBeLessThan(1e-9)
}, 4000)

test('a thin-plate spline model reuses across frames and evaluate rejects mismatched geometry', () => {
	const width = 80
	const height = 80
	const bg = (x: number, y: number) => 0.3 + 0.15 * Math.sin(3 * (x / (width - 1))) + 0.1 * (y / (height - 1))

	const model = fitBackgroundSurface(makeImage(width, height, 1, bg), { model: 'thinPlateSpline', gridSize: 12, smoothing: 0.05 })

	// Reuse on a second identical frame.
	const frameB = makeImage(width, height, 1, bg)
	const background = evaluateBackgroundModel(model, frameB)
	applyBackground(frameB, background, { correction: 'subtract', targetBackground: 0.1 })
	const after = channelStdDev(frameB, 0)
	expect(after.mean).toBeCloseTo(0.1, 2)
	expect(after.std).toBeLessThan(5e-3)

	// Geometry validation still applies to spline models.
	expect(() =>
		evaluateBackgroundModel(
			model,
			makeImage(40, 80, 1, () => 0.3),
		),
	).toThrow()
})

test('luminance color mode shares one surface and preserves color', () => {
	const width = 96
	const height = 96
	// Achromatic gradient (identical shape in every channel) plus a fixed per-channel color offset.
	const grad = (x: number, y: number) => 0.2 * (x / (width - 1)) + 0.1 * (y / (height - 1))
	const offsets = [0.05, 0.12, 0.2]
	const bg = (x: number, y: number, c: number) => offsets[c] + grad(x, y)

	const model = fitBackgroundSurface(makeImage(width, height, 3, bg), { degree: 1, colorMode: 'luminance' })
	expect(model.colorMode).toBe('luminance')
	expect(model.surfaces).toHaveLength(1)

	const result = automaticBackgroundExtraction(makeImage(width, height, 3, bg), { degree: 1, colorMode: 'luminance' })
	// One result entry per image channel, all sharing the same fitted surface.
	expect(result.channels).toHaveLength(3)
	expect(result.channels[1].coefficients).toBe(result.channels[0].coefficients)

	// Each channel is flattened and keeps its own mean (color preserved, not grayed).
	const gradMean = 0.5 * 0.2 + 0.5 * 0.1
	for (let c = 0; c < 3; c++) {
		const after = channelStdDev(result.image, c)
		expect(after.std).toBeLessThan(1e-3)
		expect(after.mean).toBeCloseTo(offsets[c] + gradMean, 3)
	}
})

test('luminance + divide applies one achromatic gain and preserves color ratios', () => {
	const width = 96
	const height = 96
	const cx = (width - 1) / 2
	const cy = (height - 1) / 2
	// Achromatic vignette multiplying fixed per-channel color levels.
	const vignette = (x: number, y: number) => 1 - 0.35 * (((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (cx * cx + cy * cy))
	const levels = [0.5, 0.4, 0.3]
	const image = makeImage(width, height, 3, (x, y, c) => levels[c] * vignette(x, y))

	const before = [channelStdDev(image, 0).std, channelStdDev(image, 1).std, channelStdDev(image, 2).std]
	const result = automaticBackgroundExtraction(image, { degree: 4, colorMode: 'luminance', correction: 'divide' })

	// Every channel is flattened (vignette removed) and the color ratios are preserved.
	const meanR = channelStdDev(result.image, 0).mean
	const meanG = channelStdDev(result.image, 1).mean
	for (let c = 0; c < 3; c++) expect(channelStdDev(result.image, c).std).toBeLessThan(before[c] / 8)
	expect(meanR / meanG).toBeCloseTo(levels[0] / levels[1], 2)
})

test('luminance mode falls back to per-channel for single-channel images', () => {
	const image = makeImage(48, 48, 1, (x) => 0.2 + 0.1 * (x / 47))
	const model = fitBackgroundSurface(image, { degree: 1, gridSize: 8, colorMode: 'luminance' })
	expect(model.colorMode).toBe('perChannel')
	expect(model.surfaces).toHaveLength(1)
})

test('coarse-grid TPS evaluation matches direct evaluation', () => {
	const width = 256
	const height = 256
	const bg = (x: number, y: number) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.4 + 0.12 * Math.sin(2.6 * u) * Math.cos(2.2 * v) + 0.05 * u
	}
	const model = fitBackgroundSurface(
		makeImage(width, height, 1, (x, y) => bg(x, y)),
		{ model: 'thinPlateSpline', gridSize: 24, smoothing: 0.05 },
	)
	const surface = model.surfaces[0]
	const coef = surface.coefficients
	const cp = surface.controlPoints!
	const k = cp.length / 2

	// Direct reference evaluation of the exact TPS at every pixel (documented coefficient layout).
	const direct = (u: number, v: number) => {
		let sum = coef[0] + coef[1] * u + coef[2] * v
		for (let c = 0; c < k; c++) {
			const du = u - cp[2 * c]
			const dv = v - cp[2 * c + 1]
			const sq = du * du + dv * dv
			if (sq > 0) sum += coef[3 + c] * (0.5 * sq * Math.log(sq))
		}
		return sum
	}

	const evaluated = evaluateBackgroundModel(
		model,
		makeImage(width, height, 1, () => 0),
	).raw
	let maxError = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const ref = direct((x / (width - 1)) * 2 - 1, (y / (height - 1)) * 2 - 1)
			maxError = Math.max(maxError, Math.abs(evaluated[y * width + x] - ref))
		}
	}

	// Bilinear upsampling of the smooth surface stays far below the fit/noise accuracy.
	expect(maxError).toBeLessThan(1e-3)
}, 2000)

test('a zero or negligibly-smoothed thin-plate spline is evaluated exactly, without coarsening', () => {
	// With smoothing 0 — or a value so small the spline still effectively interpolates — evaluation must
	// materialize the true surface per pixel. The coarse-grid bilinear approximation used for smoothing
	// splines would deviate from it (here up to ~1e-4), breaking the exact-interpolation contract and
	// leaving residual background after correction. This asserts the evaluated image matches a direct
	// per-pixel TPS evaluation to within float32 storage precision for zero and near-zero smoothing,
	// while a genuine smoothing spline over the same data still takes the coarse path.
	const width = 256
	const height = 256
	const bg = (x: number, y: number) => {
		const u = (x / (width - 1)) * 2 - 1
		const v = (y / (height - 1)) * 2 - 1
		return 0.4 + 0.12 * Math.sin(3 * u) * Math.cos(3 * v)
	}
	const image = makeImage(width, height, 1, (x, y) => bg(x, y))

	// Max deviation of the evaluated model from a direct per-pixel evaluation of its own TPS.
	const maxCoarseningError = (smoothing: number) => {
		const model = fitBackgroundSurface(image, { model: 'thinPlateSpline', gridSize: 16, smoothing })
		const coef = model.surfaces[0].coefficients
		const cp = model.surfaces[0].controlPoints!
		const k = cp.length / 2
		const direct = (u: number, v: number) => {
			let sum = coef[0] + coef[1] * u + coef[2] * v
			for (let c = 0; c < k; c++) {
				const du = u - cp[2 * c]
				const dv = v - cp[2 * c + 1]
				const sq = du * du + dv * dv
				if (sq > 0) sum += coef[3 + c] * (0.5 * sq * Math.log(sq))
			}
			return sum
		}
		const evaluated = evaluateBackgroundModel(model, image).raw
		let maxError = 0
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const ref = direct((x / (width - 1)) * 2 - 1, (y / (height - 1)) * 2 - 1)
				maxError = Math.max(maxError, Math.abs(evaluated[y * width + x] - ref))
			}
		}
		return maxError
	}

	// Exact for zero and negligibly-small smoothing: within float32 storage precision. A genuine
	// smoothing value is visibly coarsened, well above that floor.
	expect(maxCoarseningError(0)).toBeLessThan(1e-6)
	expect(maxCoarseningError(1e-12)).toBeLessThan(1e-6)
	expect(maxCoarseningError(0.05)).toBeGreaterThan(1e-6)
}, 3000)
