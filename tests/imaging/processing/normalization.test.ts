import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
// oxfmt-ignore
import { applyLocalNormalization, applyLocalNormalizationInPlace, fitLocalNormalization, fitLocalNormalizationRaw, isLocalNormalizationFallback, type LocalNormalizationOptions, localNormalization, resolveLocalNormalizationOptions, solveGlobalNormalization, solveGlobalNormalizationPlanes } from '../../../src/imaging/processing/normalization'
import { Bitpix } from '../../../src/io/formats/fits/fits'

const WIDTH = 192
const HEIGHT = 192

function rng(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0
		return state / 4294967296
	}
}

// A reference plane with a sky gradient, coarse structure, and noise, so every cell has real dynamic
// range and a realistic pixel-level dispersion.
function referencePlane(seed = 7, width = WIDTH, height = HEIGHT) {
	const random = rng(seed)
	const raw = new Float64Array(width * height)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sky = 0.1 + 0.05 * (x / width) + 0.03 * (y / height)
			const structure = 0.08 * Math.sin((x / width) * 6) * Math.cos((y / height) * 5)
			raw[y * width + x] = sky + structure + 0.01 * (random() - 0.5)
		}
	}

	return raw
}

// current = (reference - offset) / scale, so scale * current + offset reproduces the reference exactly.
function inverseTransform(reference: Float64Array, scale: (x: number, y: number) => number, offset: (x: number, y: number) => number, width = WIDTH, height = HEIGHT) {
	const raw = new Float64Array(reference.length)

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x
			raw[i] = (reference[i] - offset(x, y)) / scale(x, y)
		}
	}

	return raw
}

function interleave(planes: readonly Float64Array[], width = WIDTH, height = HEIGHT) {
	const channels = planes.length
	const raw = new Float64Array(width * height * channels)
	for (let p = 0; p < width * height; p++) {
		for (let c = 0; c < channels; c++) raw[p * channels + c] = planes[c][p]
	}
	return raw
}

function toImage(raw: Float64Array, channels: number, width = WIDTH, height = HEIGHT): Image {
	return {
		header: {},
		raw,
		metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined },
	}
}

function meanAbsoluteError(a: Float64Array, b: Float64Array, mask?: Uint8Array, channels = 1) {
	let sum = 0
	let count = 0
	for (let i = 0; i < a.length; i++) {
		if (mask !== undefined && mask[Math.floor(i / channels)] === 0) continue
		sum += Math.abs(a[i] - b[i])
		count++
	}
	return count === 0 ? 0 : sum / count
}

function maxAbsoluteError(a: Float64Array, b: Float64Array) {
	let max = 0
	for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
	return max
}

function options(overrides: LocalNormalizationOptions = {}) {
	return resolveLocalNormalizationOptions({ gridSize: 8, minSamplesPerCell: 64, ...overrides })
}

function fitMono(reference: Float64Array, current: Float64Array, overrides: LocalNormalizationOptions = {}, mask?: Uint8Array) {
	return fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 1, 'per-channel', mask, options(overrides))
}

// Applies only the global anchor, for comparison against the local correction.
function applyAnchor(raw: Float64Array, scale: number, offset: number) {
	const out = new Float64Array(raw.length)
	for (let i = 0; i < raw.length; i++) out[i] = raw[i] * scale + offset
	return out
}

describe('global normalization', () => {
	test('identity for empty distributions', () => {
		expect(solveGlobalNormalization([], [], 'background-scale')).toEqual({ scale: 1, offset: 0 })
		expect(solveGlobalNormalization([1, 2], [], 'scale')).toEqual({ scale: 1, offset: 0 })
	})

	test('scale matches the median ratio and creates no offset', () => {
		const current = [1, 2, 3, 4, 5]
		const reference = current.map((v) => v * 3)
		const solution = solveGlobalNormalization(reference, current, 'scale')

		expect(solution.scale).toBeCloseTo(3, 12)
		expect(solution.offset).toBe(0)
	})

	test('background-scale recovers a known affine transform', () => {
		const current: number[] = []
		for (let i = 0; i < 400; i++) current.push(i / 400)
		const reference = current.map((v) => 2.5 * v + 0.125)
		const solution = solveGlobalNormalization(reference, current, 'background-scale')

		expect(solution.scale).toBeCloseTo(2.5, 9)
		expect(solution.offset).toBeCloseTo(0.125, 9)
	})

	test('percentile recovers a known affine transform', () => {
		const current: number[] = []
		for (let i = 0; i < 400; i++) current.push(i / 400)
		const reference = current.map((v) => 0.4 * v - 0.05)
		const solution = solveGlobalNormalization(reference, current, 'percentile')

		expect(solution.scale).toBeCloseTo(0.4, 9)
		expect(solution.offset).toBeCloseTo(-0.05, 9)
	})

	test('a channel damaged on both sampling lattices still finds its transform', () => {
		const size = 512
		const pixels = size * size
		const reference = new Float64Array(pixels * 2)
		const current = new Float64Array(pixels * 2)

		for (let i = 0; i < pixels; i++) {
			const value = 0.1 + 0.8 * (i / pixels)
			reference[i * 2] = value
			reference[i * 2 + 1] = value
			current[i * 2] = (value - 0.05) / 2
			current[i * 2 + 1] = (value - 0.05) / 3
		}

		// The lattice scan walks every 5th pixel of a 512x512 frame and the dense fallback keeps every 32nd
		// valid pixel. Damaging channel 1 on both leaves 93% of it finite yet hides it from both scans.
		for (let y = 0; y < size; y += 5) {
			for (let x = 0; x < size; x += 5) current[(y * size + x) * 2 + 1] = Number.NaN
		}
		for (let i = 0; i < pixels; i += 32) current[i * 2 + 1] = Number.NaN

		const solved = solveGlobalNormalizationPlanes(current, undefined, reference, 2, size, size, 'background-scale', 'per-channel')

		expect(solved[0].scale).toBeCloseTo(2, 6)
		expect(solved[0].offset).toBeCloseTo(0.05, 6)
		expect(solved[1].scale).toBeCloseTo(3, 6)
		expect(solved[1].offset).toBeCloseTo(0.05, 6)
	})

	test('a degenerate current span falls back to unit scale', () => {
		const solution = solveGlobalNormalization([1, 2, 3, 4], [5, 5, 5, 5], 'scale')
		expect(solution.scale).toBeCloseTo(0.5, 12)
	})
})

describe('option resolution', () => {
	test('non-finite gridSize is rejected', () => {
		expect(() => resolveLocalNormalizationOptions({ gridSize: Number.NaN })).toThrow(TypeError)
		expect(() => resolveLocalNormalizationOptions({ gridSize: Infinity })).toThrow(TypeError)
	})

	test('an inverted relative scale range is rejected', () => {
		expect(() => resolveLocalNormalizationOptions({ relativeScaleRange: [2, 0.5] })).toThrow(RangeError)
		expect(() => resolveLocalNormalizationOptions({ relativeScaleRange: [0, 2] })).toThrow(RangeError)
		expect(() => resolveLocalNormalizationOptions({ relativeScaleRange: [1.2, 2] })).toThrow(RangeError)
	})

	test('non-finite numbers fall back to their defaults', () => {
		const resolved = resolveLocalNormalizationOptions({ smoothing: Number.NaN, rejectionSigma: Infinity, minValidFraction: Number.NaN })
		expect(resolved.smoothing).toBe(0.1)
		expect(resolved.rejectionSigma).toBe(3)
		expect(resolved.minValidFraction).toBe(0.25)
	})
})

describe('local normalization', () => {
	test('a constant residual field reproduces the global anchor exactly', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.25,
			() => 0.02,
		)
		const model = fitMono(reference, current)

		expect(model.global[0].scale).toBeCloseTo(1.25, 9)
		expect(model.global[0].offset).toBeCloseTo(0.02, 9)

		applyLocalNormalizationInPlace(current, undefined, model)
		expect(maxAbsoluteError(current, reference)).toBeLessThan(1e-12)
	})

	test('a smooth offset field is recovered far better than the global anchor', () => {
		const reference = referencePlane()
		const offset = (x: number, y: number) => 0.02 + 0.03 * (x / WIDTH) - 0.02 * (y / HEIGHT)
		const current = inverseTransform(reference, () => 1, offset)
		const model = fitMono(reference, current)

		const globalOnly = applyAnchor(current, model.global[0].scale, model.global[0].offset)
		applyLocalNormalizationInPlace(current, undefined, model)

		const localError = meanAbsoluteError(current, reference)
		const globalError = meanAbsoluteError(globalOnly, reference)

		expect(localError).toBeLessThan(globalError / 3)
		expect(localError).toBeLessThan(2e-3)
	})

	test('a smooth gain field is recovered far better than the global anchor', () => {
		const reference = referencePlane()
		const scale = (x: number, y: number) => 1.1 + 0.08 * (x / WIDTH) - 0.05 * (y / HEIGHT)
		const current = inverseTransform(reference, scale, () => 0)
		const model = fitMono(reference, current)

		expect(model.diagnostics[0].scaleCells).toBeGreaterThan(0)
		expect(model.scaleSurfaces[0]).toBeDefined()

		const globalOnly = applyAnchor(current, model.global[0].scale, model.global[0].offset)
		applyLocalNormalizationInPlace(current, undefined, model)

		expect(meanAbsoluteError(current, reference)).toBeLessThan(meanAbsoluteError(globalOnly, reference) / 3)
	})

	test('the gain field is supported only by the cells that constrained it', () => {
		// Structure in the left half, flat sky in the right, and independent noise in each frame as a real
		// pair has. Every cell yields an offset, but only the textured ones clear the dynamic-range gate,
		// so only they constrain the gain field. Weighting the gain by the wider offset support would
		// apply the extrapolated gain across a region that never constrained it.
		const referenceNoise = rng(11)
		const currentNoise = rng(29)
		const reference = new Float64Array(WIDTH * HEIGHT)
		const current = new Float64Array(WIDTH * HEIGHT)
		const gain = (x: number) => 1.1 + 0.12 * (x / WIDTH)

		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const i = y * WIDTH + x
				const signal = 0.1 + (x < WIDTH / 2 ? 0.09 * Math.sin(x / 5) * Math.cos(y / 6) : 0)
				reference[i] = signal + 0.004 * (referenceNoise() - 0.5)
				current[i] = signal / gain(x) + 0.004 * (currentNoise() - 0.5)
			}
		}

		// Splits this frame exactly down the middle; the default is stricter and gates every cell here.
		const model = fitMono(reference, current, { dynamicRangeSigma: 2 })
		const columns = model.offsetSupportGrids[0].columns
		const rows = model.offsetSupportGrids[0].rows

		expect(model.diagnostics[0].acceptedCells).toBe(columns * rows)
		expect(model.diagnostics[0].scaleCells).toBe((columns * rows) / 2)
		expect(model.scaleSurfaces[0]).toBeDefined()

		// Every cell produced an offset, so the offset field is supported everywhere.
		for (const value of model.offsetSupportGrids[0].values) expect(value).toBeCloseTo(1, 6)

		// The gain confidence follows the texture instead, high on the left and gone on the right.
		const gainSupport = model.scaleSupportGrids[0].values
		for (let r = 0; r < rows; r++) {
			expect(gainSupport[r * columns]).toBeGreaterThan(0.9)
			expect(gainSupport[r * columns + columns - 1]).toBeLessThan(0.1)
		}

		// Two constant probes isolate the applied gain from the offset field: it must sit closer to the
		// anchor on the unsupported side than on the side that actually constrained it.
		const low = new Float64Array(WIDTH * HEIGHT).fill(0)
		const high = new Float64Array(WIDTH * HEIGHT).fill(1)
		applyLocalNormalizationInPlace(low, undefined, model)
		applyLocalNormalizationInPlace(high, undefined, model)

		const anchor = model.global[0].scale
		const row = 100 * WIDTH
		const unsupported = Math.abs(high[row + WIDTH - 1] - low[row + WIDTH - 1] - anchor)
		const supported = Math.abs(high[row] - low[row] - anchor)

		expect(unsupported).toBeLessThan(supported / 10)
	})

	// A star field: high-frequency content, which is what registration resampling attenuates.
	function starField(seed: number) {
		const noise = rng(seed)
		const raw = new Float64Array(WIDTH * HEIGHT)
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) raw[y * WIDTH + x] = 0.1 + 0.02 * (x / WIDTH) + 0.01 * (noise() - 0.5)
		}

		const star = rng(seed * 7 + 1)
		for (let i = 0; i < 500; i++) {
			const cx = star() * WIDTH
			const cy = star() * HEIGHT
			const amplitude = 0.2 + 0.6 * star()
			const sigma = 1.1 + 0.6 * star()
			for (let y = Math.max(0, (cy | 0) - 5); y < Math.min(HEIGHT, (cy | 0) + 6); y++) {
				for (let x = Math.max(0, (cx | 0) - 5); x < Math.min(WIDTH, (cx | 0) + 6); x++) {
					raw[y * WIDTH + x] += amplitude * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma))
				}
			}
		}

		return raw
	}

	// Bilinear resampling through a rotation, exactly what registration applies to a frame.
	function rotate(src: Float64Array, degrees: number) {
		const out = new Float64Array(src.length)
		const theta = (degrees * Math.PI) / 180
		const ct = Math.cos(theta)
		const st = Math.sin(theta)
		const cx = (WIDTH - 1) / 2
		const cy = (HEIGHT - 1) / 2

		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const sx = cx + ct * (x - cx) - st * (y - cy)
				const sy = cy + st * (x - cx) + ct * (y - cy)
				const x0 = Math.floor(sx)
				const y0 = Math.floor(sy)
				const tx = sx - x0
				const ty = sy - y0
				const xa = clampIndex(x0, WIDTH)
				const xb = clampIndex(x0 + 1, WIDTH)
				const ya = clampIndex(y0, HEIGHT)
				const yb = clampIndex(y0 + 1, HEIGHT)
				const top = src[ya * WIDTH + xa] + (src[ya * WIDTH + xb] - src[ya * WIDTH + xa]) * tx
				const bottom = src[yb * WIDTH + xa] + (src[yb * WIDTH + xb] - src[yb * WIDTH + xa]) * tx
				out[y * WIDTH + x] = top + (bottom - top) * ty
			}
		}

		return out
	}

	function clampIndex(value: number, limit: number) {
		return Math.min(Math.max(value, 0), limit - 1)
	}

	test('a gain field with no residual degrees of freedom is suppressed', () => {
		// A 2x2 grid (degree 1 sets the per-axis cell floor) gives the gain surface three coefficients. With
		// exactly three gain-bearing
		// cells the fit interpolates them, so its residual is zero by construction and says nothing about
		// their scatter — reading that as "no noise" would let any three ratios become a spatial gain.
		const random = rng(23)
		const reference = new Float64Array(WIDTH * HEIGHT)
		const current = new Float64Array(WIDTH * HEIGHT)

		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const i = y * WIDTH + x
				// Three quadrants carry texture; the fourth is flat sky and fails the dynamic-range gate.
				const textured = x < WIDTH / 2 || y < HEIGHT / 2 ? 0.09 * Math.sin(x / 5) * Math.cos(y / 6) : 0
				const signal = 0.1 + textured
				reference[i] = signal + 0.004 * (random() - 0.5)
				current[i] = signal / 1.2 + 0.004 * (random() - 0.5)
			}
		}

		const model = fitMono(reference, current, { gridSize: 2, offsetDegree: 1, scaleDegree: 1, minSamplesPerCell: 64, dynamicRangeSigma: 2, scaleSignificance: 100 })

		expect(model.diagnostics[0].scaleCells).toBe(3)
		expect(model.scaleSurfaces[0]).toBeUndefined()

		// With no gain field the applied gain is the anchor everywhere.
		const low = new Float64Array(reference.length).fill(0)
		const high = new Float64Array(reference.length).fill(1)
		applyLocalNormalizationInPlace(low, undefined, model)
		applyLocalNormalizationInPlace(high, undefined, model)
		for (let i = 0; i < reference.length; i += 1013) expect(high[i] - low[i]).toBeCloseTo(model.global[0].scale, 9)
	})

	test('registration resampling alone never produces a gain field', () => {
		// Registration resamples the current frame, attenuating its high-frequency content by an amount
		// that depends on the subpixel phase and so varies across a rotated frame. Every second-moment
		// gain estimator reads that as a gain, and the dynamic-range gate cannot help: a star profile is
		// attenuated just like a noise sample. These frames differ by nothing but that resampling, so any
		// gain field at all is spurious and would rescale stars across the frame.
		const reference = starField(5)

		for (const degrees of [0.5, 2, 5]) {
			const current = rotate(rotate(reference, degrees), -degrees)
			const model = fitMono(reference, current)

			expect(model.diagnostics[0].scaleCells).toBeGreaterThan(0)
			expect(model.scaleSurfaces[0]).toBeUndefined()

			// With no gain field the applied gain is the anchor everywhere.
			const low = new Float64Array(reference.length).fill(0)
			const high = new Float64Array(reference.length).fill(1)
			applyLocalNormalizationInPlace(low, undefined, model)
			applyLocalNormalizationInPlace(high, undefined, model)
			for (let i = 0; i < reference.length; i += 977) expect(high[i] - low[i]).toBeCloseTo(model.global[0].scale, 9)
		}
	})

	test('a gain field large enough to be real still survives the significance test', () => {
		const reference = starField(5)
		const current = new Float64Array(reference.length)
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const i = y * WIDTH + x
				current[i] = reference[i] / (1.1 + 0.2 * (x / WIDTH))
			}
		}

		const model = fitMono(reference, current)
		expect(model.scaleSurfaces[0]).toBeDefined()
	})

	test('a subpixel-resampled frame with no photometric difference gets no gain field', () => {
		// Half-pixel bilinear resampling attenuates the noise, which a per-cell span ratio would read as a
		// gain and fit into a spurious field. Nothing here differs photometrically, so nothing must.
		const reference = referencePlane()
		const current = new Float64Array(reference.length)

		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const x1 = Math.min(WIDTH - 1, x + 1)
				const y1 = Math.min(HEIGHT - 1, y + 1)
				current[y * WIDTH + x] = 0.25 * (reference[y * WIDTH + x] + reference[y * WIDTH + x1] + reference[y1 * WIDTH + x] + reference[y1 * WIDTH + x1])
			}
		}

		const model = fitMono(reference, current)
		expect(model.scaleSurfaces[0]).toBeUndefined()

		const before = new Float64Array(current)
		applyLocalNormalizationInPlace(current, undefined, model)
		const globalOnly = applyAnchor(before, model.global[0].scale, model.global[0].offset)

		// The local correction must not be worse than simply applying the anchor.
		expect(meanAbsoluteError(current, reference)).toBeLessThanOrEqual(meanAbsoluteError(globalOnly, reference) * 1.05)
	})

	test('scale creates no offset field and no pivot', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			(x) => 1.2 + 0.1 * (x / WIDTH),
			() => 0,
		)
		const model = fitMono(reference, current, { estimator: 'scale' })

		expect(model.global[0].offset).toBe(0)
		expect(model.offsetSurfaces[0]).toBeUndefined()
		expect(model.pivots[0]).toBeUndefined()
		expect(model.diagnostics[0].offsetResidual).toBeUndefined()

		const flat = new Float64Array(reference.length).fill(0)
		applyLocalNormalizationInPlace(flat, undefined, model)
		expect(maxAbsoluteError(flat, new Float64Array(reference.length))).toBe(0)
	})

	test('local gains stay positive and inside the relative range', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			(x) => 1 + 2 * (x / WIDTH),
			() => 0,
		)
		const model = fitMono(reference, current, { estimator: 'scale', relativeScaleRange: [0.9, 1.1] })

		const [lo, hi] = model.scaleLogRanges[0]!
		expect(lo).toBeGreaterThanOrEqual(Math.log(0.9) - 1e-12)
		expect(hi).toBeLessThanOrEqual(Math.log(1.1) + 1e-12)
		expect(lo).toBeLessThanOrEqual(0)
		expect(hi).toBeGreaterThanOrEqual(0)

		const probe = new Float64Array(reference.length).fill(1)
		applyLocalNormalizationInPlace(probe, undefined, model)
		const anchor = model.global[0].scale
		for (const value of probe) {
			expect(value).toBeGreaterThan(0)
			expect(value).toBeGreaterThanOrEqual(anchor * 0.9 - 1e-9)
			expect(value).toBeLessThanOrEqual(anchor * 1.1 + 1e-9)
		}
	})

	test('both clamp ranges contain zero so a null residual reproduces the anchor', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.4,
			(x) => 0.05 + 0.02 * (x / WIDTH),
		)
		const model = fitMono(reference, current)

		const [olo, ohi] = model.offsetRanges[0]!
		expect(olo).toBeLessThanOrEqual(0)
		expect(ohi).toBeGreaterThanOrEqual(0)
	})

	test('an interior rejected cell does not create a step in the correction', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)

		// Fill one interior cell with a saturated blob so it fails the estimate.
		for (let y = 72; y < 96; y++) {
			for (let x = 72; x < 96; x++) current[y * WIDTH + x] = 1
		}

		const model = fitMono(reference, current)
		const support = model.offsetSupportGrids[0]

		// The hole is filled back to full confidence, so the whole interior stays fully supported.
		let interiorMinimum = 1
		for (let r = 1; r < support.rows - 1; r++) {
			for (let c = 1; c < support.columns - 1; c++) interiorMinimum = Math.min(interiorMinimum, support.values[r * support.columns + c])
		}
		expect(interiorMinimum).toBeGreaterThan(0.99)

		// The correction stays smooth across the hole: no row-to-row jump on a constant probe.
		const probe = new Float64Array(reference.length).fill(0.5)
		applyLocalNormalizationInPlace(probe, undefined, model)

		let maxJump = 0
		for (let y = 60; y < 110; y++) {
			for (let x = 60; x < 110; x++) maxJump = Math.max(maxJump, Math.abs(probe[y * WIDTH + x] - probe[y * WIDTH + x - 1]))
		}
		expect(maxJump).toBeLessThan(1e-3)
	})

	test('an accepted cell keeps full confidence even on a two-axis boundary', () => {
		// Confidence smoothing must soften the step outside the supported region, not eat into it. A cell
		// that produced an estimate constrained the surface directly, so attenuating it would scale the
		// correction down along the registration edge and leave a photometric seam there.
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)
		const mask = new Uint8Array(WIDTH * HEIGHT)
		for (let y = 0; y < HEIGHT / 2; y++) {
			for (let x = 0; x < WIDTH / 2; x++) mask[y * WIDTH + x] = 1
		}

		const model = fitMono(reference, current, {}, mask)
		const support = model.offsetSupportGrids[0]
		const { columns, rows, values } = support

		// Every cell that was accepted, including the two corner cells of the quadrant, reads exactly 1.
		let accepted = 0
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < columns; c++) {
				const centerX = support.originX + c * support.stepX
				const centerY = support.originY + r * support.stepY
				if (centerX >= WIDTH / 2 || centerY >= HEIGHT / 2) continue
				expect(values[r * columns + c]).toBe(1)
				accepted++
			}
		}
		expect(accepted).toBeGreaterThan(3)

		// Outside the quadrant the confidence still decays rather than stepping straight to zero.
		let ramp = 0
		for (const value of values) {
			if (value > 0 && value < 1) ramp++
		}
		expect(ramp).toBeGreaterThan(0)
	})

	test('cells without enough valid pixels are dropped and the region keeps the anchor', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.3,
			() => 0.02,
		)
		const mask = new Uint8Array(WIDTH * HEIGHT).fill(1)

		// Blank the right third of the frame.
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 128; x < WIDTH; x++) mask[y * WIDTH + x] = 0
		}

		const model = fitMono(reference, current, {}, mask)
		expect(model.diagnostics[0].rejectedCells).toBeGreaterThan(0)
		expect(model.diagnostics[0].fallback).toBe(false)

		const before = new Float64Array(current)
		applyLocalNormalizationInPlace(current, mask, model)

		// Masked pixels are untouched; valid ones are corrected.
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 128; x < WIDTH; x++) expect(current[y * WIDTH + x]).toBe(before[y * WIDTH + x])
		}
		expect(meanAbsoluteError(current, reference, mask)).toBeLessThan(1e-9)
	})

	test('a spatial outlier cell does not deform the field', () => {
		const reference = referencePlane()
		const offset = (x: number) => 0.02 + 0.03 * (x / WIDTH)
		const clean = inverseTransform(reference, () => 1, offset)
		const contaminated = new Float64Array(clean)

		for (let y = 24; y < 48; y++) {
			for (let x = 24; x < 48; x++) contaminated[y * WIDTH + x] += 0.4
		}

		const cleanModel = fitMono(reference, new Float64Array(clean))
		const dirtyModel = fitMono(reference, contaminated)

		const a = new Float64Array(clean)
		const b = new Float64Array(clean)
		applyLocalNormalizationInPlace(a, undefined, cleanModel)
		applyLocalNormalizationInPlace(b, undefined, dirtyModel)

		// Outside the contaminated corner the two corrections must agree closely.
		let maxDelta = 0
		for (let y = 96; y < HEIGHT; y++) {
			for (let x = 96; x < WIDTH; x++) maxDelta = Math.max(maxDelta, Math.abs(a[y * WIDTH + x] - b[y * WIDTH + x]))
		}
		expect(maxDelta).toBeLessThan(5e-3)
	})

	test('non-finite pixels never reach the result', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)
		current[100 * WIDTH + 100] = Number.NaN
		current[100 * WIDTH + 101] = Infinity

		const model = fitMono(reference, current)
		applyLocalNormalizationInPlace(current, undefined, model)

		for (let i = 0; i < current.length; i++) {
			if (i === 100 * WIDTH + 100 || i === 100 * WIDTH + 101) continue
			expect(Number.isFinite(current[i])).toBe(true)
		}
	})

	test('the pivot ignores pixels the fit itself excluded', () => {
		// A band of the reference is non-finite while the current frame there is finite and far brighter.
		// Those pairs feed nothing else in the fit, so letting them move the pivot would anchor the
		// reconstruction on a level the fit never saw.
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			(x) => 1.1 + 0.1 * (x / WIDTH),
			(x) => 0.01 + 0.02 * (x / WIDTH),
		)

		const clean = fitMono(reference, new Float64Array(current))

		const holed = new Float64Array(reference)
		const spiked = new Float64Array(current)
		for (let y = 0; y < 70; y++) {
			for (let x = 0; x < WIDTH; x++) {
				holed[y * WIDTH + x] = Number.NaN
				// Far below the finite range, so including it would drag the lower quantile the pivot uses.
				spiked[y * WIDTH + x] = -50
			}
		}

		const model = fitMono(holed, spiked)

		// The pivot is drawn from the same finite pairs the fit uses, so the unmatched band cannot move it.
		expect(model.pivots[0]).toBeGreaterThan(0)
		expect(model.pivots[0]).toBeLessThan(1)
		expect(model.pivots[0]).toBeCloseTo(clean.pivots[0]!, 2)

		// And the correction stays sane over the region the fit could actually see.
		applyLocalNormalizationInPlace(spiked, undefined, model)
		let worst = 0
		for (let y = 80; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) worst = Math.max(worst, Math.abs(spiked[y * WIDTH + x] - reference[y * WIDTH + x]))
		}
		expect(worst).toBeLessThan(0.05)
	})

	test('a mask aligned to the sampling lattice does not flatten the global anchor', () => {
		// The lattice is anchored at the origin, so a mask can miss it entirely while leaving nearly the
		// whole frame valid. The anchor every local residual is measured against would then come back as
		// identity, with nothing marking it: the fit reports no fallback and every cell as usable.
		const size = 512
		const random = rng(7)
		const reference = new Float64Array(size * size)
		const current = new Float64Array(size * size)

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const i = y * size + x
				const v = 0.1 + 0.05 * (x / size) + 0.08 * Math.sin((x / size) * 6) * Math.cos((y / size) * 5) + 0.01 * (random() - 0.5)
				current[i] = v
				reference[i] = 2 * v + 0.1
			}
		}

		// The stride the sampler picks for this frame; clearing exactly those positions costs 4% of it.
		const step = Math.max(1, Math.floor(Math.sqrt((size * size) / 8192)))
		const mask = new Uint8Array(size * size).fill(1)
		let cleared = 0
		for (let y = 0; y < size; y += step) {
			for (let x = 0; x < size; x += step) {
				mask[y * size + x] = 0
				cleared++
			}
		}
		expect(cleared / (size * size)).toBeLessThan(0.05)

		const model = fitLocalNormalizationRaw(reference, current, size, size, 1, 'per-channel', mask, resolveLocalNormalizationOptions({}))

		expect(model.global[0].scale).toBeCloseTo(2, 6)
		expect(model.global[0].offset).toBeCloseTo(0.1, 6)
		expect(model.pivots[0]).toBeGreaterThan(0)
	}, 20000)

	test('one channel finding lattice samples does not suppress recovery of another', () => {
		// The lattice is missed plane by plane: a channel can be non-finite exactly at the sampled
		// positions while another is finite everywhere. Judging the retry on the frame as a whole lets the
		// healthy channel speak for the starved one, which then keeps an identity anchor.
		const size = 512
		const channels = 2
		const random = rng(7)
		const reference = new Float64Array(size * size * channels)
		const current = new Float64Array(size * size * channels)
		const step = Math.max(1, Math.floor(Math.sqrt((size * size) / 8192)))

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const i = (y * size + x) * channels
				const v = 0.1 + 0.05 * (x / size) + 0.08 * Math.sin((x / size) * 6) * Math.cos((y / size) * 5) + 0.01 * (random() - 0.5)

				current[i] = v
				reference[i] = 2 * v + 0.1

				// Channel 1 satisfies the same relation everywhere except on the lattice itself.
				const onLattice = y % step === 0 && x % step === 0
				current[i + 1] = onLattice ? Number.NaN : v
				reference[i + 1] = onLattice ? Number.NaN : 2 * v + 0.1
			}
		}

		const model = fitLocalNormalizationRaw(reference, current, size, size, channels, 'per-channel', undefined, resolveLocalNormalizationOptions({}))

		for (let plane = 0; plane < channels; plane++) {
			expect(model.global[plane].scale).toBeCloseTo(2, 6)
			expect(model.global[plane].offset).toBeCloseTo(0.1, 6)
			expect(model.pivots[plane]).toBeGreaterThan(0)
		}
	}, 20000)

	test('a diagonal partial overlap is corrected as accurately at its boundary as inside', () => {
		// A diagonal overlap boundary leaves the boundary cells clipped, with centroids well off their
		// nominal grid centers, and every axis-aligned mask test above misses that case.
		const reference = referencePlane()
		const scale = (x: number, y: number) => 1.1 + 0.09 * (x / WIDTH) - 0.06 * (y / HEIGHT)
		const current = inverseTransform(reference, scale, (x) => 0.01 + 0.015 * (x / WIDTH))

		const mask = new Uint8Array(WIDTH * HEIGHT)
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				if (x + y > 96 && x + y < 300) mask[y * WIDTH + x] = 1
			}
		}

		const model = fitMono(reference, current, {}, mask)
		expect(model.diagnostics[0].fallback).toBe(false)

		applyLocalNormalizationInPlace(current, mask, model)

		// Boundary cells must be corrected as accurately as interior ones.
		let boundary = 0
		let boundaryCount = 0
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const s = x + y
				if (mask[y * WIDTH + x] === 0) continue
				if (s > 110 && s < 286) continue
				boundary += Math.abs(current[y * WIDTH + x] - reference[y * WIDTH + x])
				boundaryCount++
			}
		}

		expect(boundaryCount).toBeGreaterThan(1000)
		expect(boundary / boundaryCount).toBeLessThan(2e-3)
	})

	test('the correction stays bounded by the confidence in the transition band', () => {
		// Only a strip of the frame is valid, so the offset surface is fitted there and extrapolates
		// outside it, where the support has already decayed. A pixel in that band must receive at most
		// `support * range`: clamping the product instead would let the overshoot cancel the low
		// confidence and apply a full-range correction exactly where the fit is least trustworthy.
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.15,
			(x, y) => 0.01 + 0.05 * (x / WIDTH) - 0.04 * (y / HEIGHT),
		)
		const mask = new Uint8Array(WIDTH * HEIGHT).fill(1)
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				if (y < 40 || y > 110) mask[y * WIDTH + x] = 0
			}
		}

		const model = fitMono(reference, current, { offsetDegree: 3 }, mask)
		expect(model.diagnostics[0].fallback).toBe(false)

		const support = model.offsetSupportGrids[0]
		const [lo, hi] = model.offsetRanges[0]!
		const bound = Math.max(Math.abs(lo), Math.abs(hi))
		const { scale, offset } = model.global[0]

		// Probe a constant frame: the deviation from the anchor is exactly the applied offset residual.
		const probe = new Float64Array(WIDTH * HEIGHT).fill(0.3)
		const expected = 0.3 * scale + offset
		applyLocalNormalizationInPlace(probe, undefined, model)

		let violations = 0
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x += 7) {
				const w = sampleSupportAt(support, x, y)
				if (w > 0.9) continue
				const applied = Math.abs(probe[y * WIDTH + x] - expected)
				// The bound holds exactly at the evaluation nodes; between them both fields are interpolated,
				// so the slack is a small fraction of the field amplitude. Clamping the product instead of
				// the surface overshoots by a fraction of the bound itself, which is far larger.
				if (applied > w * bound + bound * 0.01) violations++
			}
		}

		expect(violations).toBe(0)
	})

	// Mirrors the module's own bilinear-plus-smoothstep confidence sampling.
	function sampleSupportAt(grid: { columns: number; rows: number; originX: number; originY: number; stepX: number; stepY: number; values: Float32Array }, x: number, y: number) {
		const fx = grid.columns > 1 ? (x - grid.originX) / grid.stepX : 0
		const fy = grid.rows > 1 ? (y - grid.originY) / grid.stepY : 0
		const i0 = Math.min(Math.max(Math.floor(fx), 0), Math.max(0, grid.columns - 2))
		const j0 = Math.min(Math.max(Math.floor(fy), 0), Math.max(0, grid.rows - 2))
		const i1 = Math.min(i0 + 1, grid.columns - 1)
		const j1 = Math.min(j0 + 1, grid.rows - 1)
		const tx = Math.min(Math.max(fx - i0, 0), 1)
		const ty = Math.min(Math.max(fy - j0, 0), 1)
		const r0 = j0 * grid.columns
		const r1 = j1 * grid.columns
		const top = grid.values[r0 + i0] + (grid.values[r0 + i1] - grid.values[r0 + i0]) * tx
		const bottom = grid.values[r1 + i0] + (grid.values[r1 + i1] - grid.values[r1 + i0]) * tx
		const w = top + (bottom - top) * ty
		return w * w * (3 - 2 * w)
	}

	test('the coarse node grid agrees with a dense one', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			(x, y) => 1.1 + 0.06 * (x / WIDTH) - 0.03 * (y / HEIGHT),
			(x) => 0.01 + 0.02 * (x / WIDTH),
		)

		const coarse = new Float64Array(current)
		const dense = new Float64Array(current)
		applyLocalNormalizationInPlace(coarse, undefined, fitMono(reference, current))
		applyLocalNormalizationInPlace(dense, undefined, fitMono(reference, current, { evaluationStepFraction: 0.01 }))

		// Well below the fit's own residual, which is of order 1e-3 for this frame. The bound is set by the
		// offset clamp, whose kink makes the interpolation error fall linearly rather than quadratically.
		expect(maxAbsoluteError(coarse, dense)).toBeLessThan(3e-4)
	})

	test('a very anisotropic frame still honors the per-cell sample budget', () => {
		// A single stride derived from the box area only honors the budget for a roughly square box; on a
		// 1-pixel-wide frame each cell would otherwise collect thousands of pairs against a cap of 1024,
		// sizing every buffer and the whole pixel scan by the aspect ratio instead of by the cap.
		const width = 1
		const height = 40000
		const reference = new Float64Array(width * height)
		const current = new Float64Array(width * height)
		const noise = rng(3)
		for (let i = 0; i < reference.length; i++) {
			reference[i] = 0.1 + 0.05 * (i / height) + 0.01 * (noise() - 0.5)
			current[i] = (reference[i] - 0.01) / 1.2
		}

		const resolved = resolveLocalNormalizationOptions({ maxSamplesPerCell: 1024 })
		const model = fitLocalNormalizationRaw(reference, current, width, height, 1, 'per-channel', undefined, resolved)

		// The layout has one cell column, so no 2D surface is possible and the plane falls back — but it
		// must reach that verdict without ever sizing a buffer past the budget.
		expect(model.diagnostics[0].fallback).toBe(true)

		// A frame this thin cannot support a surface; the point is that the fit completes promptly.
		const started = performance.now()
		fitLocalNormalizationRaw(reference, current, width, height, 1, 'per-channel', undefined, resolved)
		expect(performance.now() - started).toBeLessThan(2000)
	})

	test('a high-aspect frame keeps the cell rows its degree needs under the cell cap', () => {
		// Scaling the grid back to the cell budget must not take the short axis below the floor the surface
		// degree needs: a 40000x7 frame at this gridSize would otherwise land on 19352x3 cells, and three
		// coordinate bands cannot determine a degree-6 surface however many cells the long axis has.
		const width = 40000
		const height = 7
		const random = rng(31)
		const reference = new Float64Array(width * height)
		const current = new Float64Array(width * height)

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = y * width + x
				const signal = 0.1 + 0.05 * (x / width) + 0.03 * (y / height) + 0.02 * Math.sin(x / 700)
				reference[i] = signal + 0.004 * (random() - 0.5)
				current[i] = (signal - 0.01) / 1.2 + 0.004 * (random() - 0.5)
			}
		}

		const resolved = resolveLocalNormalizationOptions({ gridSize: width, offsetDegree: 6, minSamplesPerCell: 4 })
		const model = fitLocalNormalizationRaw(reference, current, width, height, 1, 'per-channel', undefined, resolved)
		const support = model.offsetSupportGrids[0]

		expect(support.rows).toBe(height)
		expect(support.columns * support.rows).toBeLessThanOrEqual(65536)
		expect(model.diagnostics[0].fallback).toBe(false)
	}, 20000)

	test('an extreme box and per-cell budget do not size the buffers by the image', () => {
		// The collection buffers are sized by the per-cell budget times the plane count. Unclamped, asking
		// for a full-frame box and a matching budget sizes them by the image instead - about 1.2 GB on a
		// 4096x4096 RGB frame - and rescans that whole box for every cell.
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)

		const resolved = resolveLocalNormalizationOptions({ boxSize: WIDTH, maxSamplesPerCell: 16_777_216 })
		expect(resolved.maxSamplesPerCell).toBe(65536)

		const started = performance.now()
		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 1, 'per-channel', undefined, resolved)
		expect(performance.now() - started).toBeLessThan(20000)
		expect(model.diagnostics[0].candidateCells).toBeGreaterThan(0)
	}, 30000)

	test('a spline field on a fine grid does not evaluate every node against every control', () => {
		// The node step comes from the cell side, so a fine grid drives it toward 1 and the node grid stops
		// being the cheap intermediate it exists to be. A spline field then evaluates every node against
		// every control point with a logarithm each: at this size that is over a billion evaluations, and
		// the bounded materialization in the surface module is not on this route to catch it.
		const size = 1024
		const random = rng(4)
		const reference = new Float64Array(size * size)
		const current = new Float64Array(size * size)

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const i = y * size + x
				const signal = 0.1 + 0.05 * (x / size) + 0.06 * Math.sin(x / 120) * Math.cos(y / 110) + 0.01 * (random() - 0.5)
				reference[i] = signal
				current[i] = (signal - 0.01) / 1.2
			}
		}

		const resolved = resolveLocalNormalizationOptions({ gridSize: 96, surfaceModel: 'thinPlateSpline', smoothing: 0.1, minSamplesPerCell: 16 })
		const model = fitLocalNormalizationRaw(reference, current, size, size, 1, 'per-channel', undefined, resolved)

		// The cap engaged, so a node grid at the model's own step would be the expensive case.
		expect(model.offsetSurfaces[0]!.controlPoints!.length / 2).toBe(1024)
		expect(model.evaluationStep).toBe(1)

		const started = performance.now()
		applyLocalNormalizationInPlace(current, undefined, model)
		const elapsed = performance.now() - started

		// Unbounded this takes about 28 seconds; the widened step brings it under two.
		expect(elapsed).toBeLessThan(12000)
		for (let i = 0; i < current.length; i += 7919) expect(Number.isFinite(current[i])).toBe(true)
	}, 60000)

	test('an extreme gridSize is scaled back to a tractable cell count', () => {
		// One cell per pixel is not a usable ceiling on a real frame: at this gridSize the grid would ask
		// for width*height cells, whose per-plane state alone runs to gigabytes on a large image. This
		// frame is deliberately past the budget (90000 pixels against 65536 cells) so the scaling engages.
		const size = 300
		const reference = referencePlane(3, size, size)
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
			size,
			size,
		)
		const model = fitLocalNormalizationRaw(reference, current, size, size, 1, 'per-channel', undefined, resolveLocalNormalizationOptions({ gridSize: 1_000_000 }))
		const support = model.offsetSupportGrids[0]

		expect(support.columns * support.rows).toBeLessThanOrEqual(65536)
		expect(support.columns * support.rows).toBeLessThan(size * size)
		expect(model.diagnostics[0].candidateCells).toBe(support.columns * support.rows)
		// The grid keeps its aspect ratio while being scaled back.
		expect(support.columns).toBe(support.rows)
	})

	test('a normal gridSize is unaffected by the cell budget', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)

		for (const gridSize of [4, 8, 16, 24]) {
			const support = fitMono(reference, current, { gridSize }).offsetSupportGrids[0]
			expect(support.columns).toBe(gridSize)
			expect(support.rows).toBe(gridSize)
		}
	})

	test('overlapping boxes are thinned to the aggregate sampling budget', () => {
		const size = 128
		const pixels = size * size
		const reference = new Float64Array(pixels)
		const current = new Float64Array(pixels)

		for (let i = 0; i < pixels; i++) {
			const value = 0.1 + 0.8 * (i / pixels)
			reference[i] = value
			current[i] = (value - 0.05) / 2
		}

		const overlapping = resolveLocalNormalizationOptions({ gridSize: size, boxSize: size, maxSamplesPerCell: 16384, minSamplesPerCell: 4 })
		const overlapped = fitLocalNormalizationRaw(reference, current, size, size, 1, 'per-channel', undefined, overlapping)

		expect(overlapped.diagnostics[0].candidateCells).toBe(pixels)
		expect(overlapped.diagnostics[0].acceptedCells).toBe(0)
		expect(isLocalNormalizationFallback(overlapped)).toBe(true)

		const tiling = resolveLocalNormalizationOptions({ gridSize: 8, maxSamplesPerCell: 16384, minSamplesPerCell: 4 })
		const tiled = fitLocalNormalizationRaw(reference, current, size, size, 1, 'per-channel', undefined, tiling)

		expect(tiled.diagnostics[0].acceptedCells).toBe(tiled.diagnostics[0].candidateCells)
		expect(isLocalNormalizationFallback(tiled)).toBe(false)
	})

	test('a cell holding one stray pair still retries the alternate phase', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			(x, y) => 0.01 + 0.02 * (x / WIDTH) + 0.015 * (y / HEIGHT),
		)

		const mask = new Uint8Array(WIDTH * HEIGHT).fill(1)
		for (let y = 0; y < HEIGHT; y += 2) {
			for (let x = 0; x < WIDTH; x += 2) {
				if (x % 24 === 0 && y % 24 === 0) continue
				mask[y * WIDTH + x] = 0
			}
		}

		const model = fitMono(reference, current, { maxSamplesPerCell: 144 }, mask)

		expect(model.diagnostics[0].fallback).toBe(false)
		expect(model.diagnostics[0].acceptedCells).toBe(model.diagnostics[0].candidateCells)

		const global = applyAnchor(current, model.global[0].scale, model.global[0].offset)
		applyLocalNormalizationInPlace(current, mask, model)
		expect(meanAbsoluteError(current, reference, mask)).toBeLessThan(meanAbsoluteError(global, reference, mask) / 3)
	})

	test('pairs split evenly between the two phases are pooled', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			(x, y) => 0.01 + 0.02 * (x / WIDTH) + 0.015 * (y / HEIGHT),
		)

		const mask = new Uint8Array(WIDTH * HEIGHT).fill(1)
		for (let y = 0; y < HEIGHT; y++) {
			if (Math.floor(y / 2) % 2 === 0) continue
			for (let x = 0; x < WIDTH; x++) mask[y * WIDTH + x] = 0
		}

		const model = fitMono(reference, current, { maxSamplesPerCell: 144, minSamplesPerCell: 100 }, mask)

		expect(model.diagnostics[0].fallback).toBe(false)
		expect(model.diagnostics[0].acceptedCells).toBe(model.diagnostics[0].candidateCells)

		const global = applyAnchor(current, model.global[0].scale, model.global[0].offset)
		applyLocalNormalizationInPlace(current, mask, model)
		expect(meanAbsoluteError(current, reference, mask)).toBeLessThan(meanAbsoluteError(global, reference, mask) / 3)
	})

	test('a mask aligned to the sampling lattice is recovered by the alternate phase', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			(x, y) => 0.01 + 0.02 * (x / WIDTH) + 0.015 * (y / HEIGHT),
		)

		// 24x24 cells strided down to 12x12 pairs, so the scan reads only the even pixels of each box.
		// Invalidating exactly those leaves three quarters of the frame usable and every sampled pixel
		// masked.
		const mask = new Uint8Array(WIDTH * HEIGHT).fill(1)
		for (let y = 0; y < HEIGHT; y += 2) {
			for (let x = 0; x < WIDTH; x += 2) mask[y * WIDTH + x] = 0
		}

		const model = fitMono(reference, current, { maxSamplesPerCell: 144 }, mask)

		expect(model.diagnostics[0].fallback).toBe(false)
		expect(model.diagnostics[0].acceptedCells).toBe(model.diagnostics[0].candidateCells)

		const global = applyAnchor(current, model.global[0].scale, model.global[0].offset)
		applyLocalNormalizationInPlace(current, mask, model)
		expect(meanAbsoluteError(current, reference, mask)).toBeLessThan(meanAbsoluteError(global, reference, mask) / 3)
	})
})

describe('color handling', () => {
	test('per-channel fits one model per channel', () => {
		const planes = [referencePlane(1), referencePlane(2), referencePlane(3)]
		const currents = planes.map((plane, index) =>
			inverseTransform(
				plane,
				() => 1.1 + 0.1 * index,
				() => 0.01 * index,
			),
		)
		const reference = interleave(planes)
		const current = interleave(currents)

		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 3, 'per-channel', undefined, options())

		expect(model.global).toHaveLength(3)
		expect(model.diagnostics).toHaveLength(3)
		for (let c = 0; c < 3; c++) expect(model.global[c].scale).toBeCloseTo(1.1 + 0.1 * c, 6)

		applyLocalNormalizationInPlace(current, undefined, model)
		expect(maxAbsoluteError(current, reference)).toBeLessThan(1e-9)
	})

	test('luminance fits one shared plane and applies it to every channel', () => {
		const plane = referencePlane()
		const currentPlane = inverseTransform(
			plane,
			() => 1.3,
			() => 0.02,
		)
		const reference = interleave([plane, plane, plane])
		const current = interleave([currentPlane, currentPlane, currentPlane])

		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 3, 'luminance', undefined, options())

		expect(model.global).toHaveLength(1)
		expect(model.diagnostics).toHaveLength(1)
		expect(model.offsetSupportGrids).toHaveLength(1)
		expect(model.scaleSupportGrids).toHaveLength(1)

		applyLocalNormalizationInPlace(current, undefined, model)
		for (let p = 0; p < WIDTH * HEIGHT; p++) {
			expect(current[p * 3]).toBeCloseTo(current[p * 3 + 1], 12)
			expect(current[p * 3 + 1]).toBeCloseTo(current[p * 3 + 2], 12)
		}
		expect(maxAbsoluteError(current, reference)).toBeLessThan(1e-9)
	})

	test('more than three channels is supported through the direct API', () => {
		const planes = [referencePlane(1), referencePlane(2), referencePlane(3), referencePlane(4), referencePlane(5)]
		const currents = planes.map((plane, index) =>
			inverseTransform(
				plane,
				() => 1.05 + 0.05 * index,
				() => 0,
			),
		)
		const reference = interleave(planes)
		const current = interleave(currents)

		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 5, 'per-channel', undefined, options())
		expect(model.global).toHaveLength(5)
		expect(model.diagnostics).toHaveLength(5)

		applyLocalNormalizationInPlace(current, undefined, model)
		expect(maxAbsoluteError(current, reference)).toBeLessThan(1e-9)
	})

	test('a non-finite channel does not suppress the healthy channels', () => {
		const planes = [referencePlane(1), referencePlane(2), referencePlane(3)]
		const currents = planes.map((plane, index) =>
			inverseTransform(
				plane,
				() => 1.1 + 0.1 * index,
				(x, y) => 0.01 + 0.02 * (x / WIDTH) + 0.015 * (y / HEIGHT),
			),
		)
		for (let p = 0; p < WIDTH * HEIGHT; p++) currents[2][p] = Number.NaN

		const reference = interleave(planes)
		const current = interleave(currents)

		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 3, 'per-channel', undefined, options())

		expect(model.diagnostics[0].fallback).toBe(false)
		expect(model.diagnostics[1].fallback).toBe(false)
		expect(model.diagnostics[2].fallback).toBe(true)
		expect(model.diagnostics[0].acceptedCells).toBeGreaterThan(0)
		expect(model.diagnostics[1].acceptedCells).toBeGreaterThan(0)
		expect(model.diagnostics[2].acceptedCells).toBe(0)

		const anchored = new Float64Array(current.length)
		for (let c = 0; c < 3; c++) {
			const { scale, offset } = model.global[c]
			for (let p = 0; p < WIDTH * HEIGHT; p++) anchored[p * 3 + c] = current[p * 3 + c] * scale + offset
		}

		applyLocalNormalizationInPlace(current, undefined, model)

		for (let c = 0; c < 2; c++) {
			let local = 0
			let global = 0
			for (let p = 0; p < WIDTH * HEIGHT; p++) {
				local += Math.abs(current[p * 3 + c] - reference[p * 3 + c])
				global += Math.abs(anchored[p * 3 + c] - reference[p * 3 + c])
			}
			expect(local).toBeLessThan(global / 3)
		}
	})

	test('a channel damaged on both sampling lattices still finds its pivot', () => {
		const size = 512
		const pixels = size * size
		const planes = [referencePlane(1, size, size), referencePlane(2, size, size)]
		const currents = planes.map((plane, index) =>
			inverseTransform(
				plane,
				() => 1.5 + 0.5 * index,
				() => 0.02,
				size,
				size,
			),
		)

		for (let y = 0; y < size; y += 5) {
			for (let x = 0; x < size; x += 5) currents[1][y * size + x] = Number.NaN
		}
		for (let i = 0; i < pixels; i += 32) currents[1][i] = Number.NaN

		const reference = interleave(planes, size, size)
		const current = interleave(currents, size, size)
		const model = fitLocalNormalizationRaw(reference, current, size, size, 2, 'per-channel', undefined, options())

		const clean = fitLocalNormalizationRaw(
			reference,
			interleave(
				planes.map((plane, index) =>
					inverseTransform(
						plane,
						() => 1.5 + 0.5 * index,
						() => 0.02,
						size,
						size,
					),
				),
				size,
				size,
			),
			size,
			size,
			2,
			'per-channel',
			undefined,
			options(),
		)

		expect(model.pivots[0]).toBeCloseTo(clean.pivots[0]!, 6)
		expect(model.pivots[1]).toBeCloseTo(clean.pivots[1]!, 2)
	})

	test('a channel with no finite pair reports no overlap of its own', () => {
		const planes = [referencePlane(1), referencePlane(2)]
		const currents = planes.map((plane, index) =>
			inverseTransform(
				plane,
				() => 1.1 + 0.1 * index,
				() => 0.01,
			),
		)
		for (let q = 0; q < WIDTH * HEIGHT; q++) currents[1][q] = Number.NaN

		const model = fitLocalNormalizationRaw(interleave(planes), interleave(currents), WIDTH, HEIGHT, 2, 'per-channel', undefined, options())

		expect(model.diagnostics[0].fallback).toBe(false)
		expect(model.diagnostics[1].fallback).toBe(true)
		expect(model.diagnostics[1].reason).toBe('no-valid-overlap')
	})

	test('each channel retries the alternate sampling phase on its own', () => {
		const planes = [referencePlane(1), referencePlane(2)]
		const currents = planes.map((plane, index) =>
			inverseTransform(
				plane,
				() => 1.1 + 0.1 * index,
				(x, y) => 0.01 + 0.02 * (x / WIDTH) + 0.015 * (y / HEIGHT),
			),
		)

		// Channel 0 is finite on the phase-0 lattice, channel 1 only on the alternate one. A shared
		// "something was collected" flag lets channel 0 cancel the retry that channel 1 needs.
		for (let y = 0; y < HEIGHT; y += 2) {
			for (let x = 0; x < WIDTH; x += 2) currents[1][y * WIDTH + x] = Number.NaN
		}

		const reference = interleave(planes)
		const current = interleave(currents)

		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 2, 'per-channel', undefined, options({ maxSamplesPerCell: 144 }))

		for (let c = 0; c < 2; c++) {
			expect(model.diagnostics[c].fallback).toBe(false)
			expect(model.diagnostics[c].acceptedCells).toBe(model.diagnostics[c].candidateCells)
		}

		const anchored = new Float64Array(current.length)
		for (let c = 0; c < 2; c++) {
			const { scale, offset } = model.global[c]
			for (let q = 0; q < WIDTH * HEIGHT; q++) anchored[q * 2 + c] = current[q * 2 + c] * scale + offset
		}

		applyLocalNormalizationInPlace(current, undefined, model)

		for (let c = 0; c < 2; c++) {
			let local = 0
			let global = 0
			for (let q = 0; q < WIDTH * HEIGHT; q++) {
				const value = current[q * 2 + c]
				if (!Number.isFinite(value)) continue
				local += Math.abs(value - reference[q * 2 + c])
				global += Math.abs(anchored[q * 2 + c] - reference[q * 2 + c])
			}
			expect(local).toBeLessThan(global / 3)
		}
	})

	test('luminance falls back to per-channel for non-RGB images', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0,
		)
		const model = fitLocalNormalizationRaw(reference, current, WIDTH, HEIGHT, 1, 'luminance', undefined, options())

		expect(model.global).toHaveLength(1)
		expect(model.diagnostics).toHaveLength(1)
	})
})

describe('fallback', () => {
	// A frame with no usable overlap at all.
	function emptyOverlapModel(fallback: 'global' | 'identity' | 'reject') {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.5,
			() => 0.03,
		)
		const mask = new Uint8Array(WIDTH * HEIGHT)
		return { reference, current, mask, model: fitMono(reference, current, { fallback }, mask) }
	}

	test('fully overlapping frames whose cells are all too small report unusable cells', () => {
		// A 64x64 pair under the default 16x16 grid gives 4x4 cells, far below `minSamplesPerCell`. The
		// frames overlap completely, so the reason must be about the cells, not about the overlap.
		const size = 64
		const reference = referencePlane(3, size, size)
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
			size,
			size,
		)
		const model = fitLocalNormalizationRaw(reference, current, size, size, 1, 'per-channel', undefined, resolveLocalNormalizationOptions({}))

		expect(model.diagnostics[0].acceptedCells).toBe(0)
		expect(model.diagnostics[0].reason).toBe('insufficient-valid-cells')
	})

	test('no valid pixels at all still reports absent overlap', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)
		const model = fitMono(reference, current, {}, new Uint8Array(WIDTH * HEIGHT))

		expect(model.diagnostics[0].reason).toBe('no-valid-overlap')
	})

	test('global falls back to the anchor and reports the reason', () => {
		const { model } = emptyOverlapModel('global')

		expect(isLocalNormalizationFallback(model)).toBe(true)
		expect(model.diagnostics[0].reason).toBe('no-valid-overlap')
		expect(model.scaleSurfaces[0]).toBeUndefined()
		expect(model.offsetSurfaces[0]).toBeUndefined()
	})

	test('identity leaves the plane untouched', () => {
		const { model } = emptyOverlapModel('identity')
		const probe = new Float64Array(16).fill(0.3)

		// Applying to a fully valid buffer of the right size must be a no-op under identity.
		const raw = new Float64Array(WIDTH * HEIGHT).fill(0.3)
		applyLocalNormalizationInPlace(raw, undefined, model)
		for (const value of raw) expect(value).toBeCloseTo(0.3, 12)
		expect(probe[0]).toBe(0.3)
	})

	test('global fallback applies the anchor transform', () => {
		const { model } = emptyOverlapModel('global')
		const raw = new Float64Array(WIDTH * HEIGHT).fill(0.3)
		applyLocalNormalizationInPlace(raw, undefined, model)

		const { scale, offset } = model.global[0]
		for (const value of raw) expect(value).toBeCloseTo(0.3 * scale + offset, 12)
	})

	test('reject reports the failure without throwing', () => {
		const { model } = emptyOverlapModel('reject')
		expect(model.fallback).toBe('reject')
		expect(isLocalNormalizationFallback(model)).toBe(true)
		expect(model.diagnostics[0].reason).toBe('no-valid-overlap')
	})

	test('a narrow valid band cannot support the surface and falls back', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.2,
			() => 0.01,
		)
		const mask = new Uint8Array(WIDTH * HEIGHT)

		// Leave only a narrow horizontal band valid: at most two cell rows, so a degree-3 surface has far
		// too few distinct coordinate bands to be determined.
		for (let y = 90; y < 102; y++) {
			for (let x = 0; x < WIDTH; x++) mask[y * WIDTH + x] = 1
		}

		const model = fitMono(reference, current, {}, mask)
		expect(model.diagnostics[0].fallback).toBe(true)
		expect(['insufficient-valid-cells', 'insufficient-spatial-coverage', 'surface-fit-failed']).toContain(model.diagnostics[0].reason!)

		// The frame still gets the global anchor, and masked pixels stay untouched.
		const before = new Float64Array(current)
		applyLocalNormalizationInPlace(current, mask, model)
		const { scale, offset } = model.global[0]
		for (let x = 0; x < WIDTH; x++) {
			expect(current[95 * WIDTH + x]).toBeCloseTo(before[95 * WIDTH + x] * scale + offset, 12)
			expect(current[10 * WIDTH + x]).toBe(before[10 * WIDTH + x])
		}
	})

	test('a gain field suppressed as insignificant is not a failure', () => {
		// `scale` has no offset field, so the gain field is the whole model. A frame that needs no local
		// gain correction still fits one; it is only suppressed as insignificant, which must stay a
		// successful global-anchor result rather than a fallback.
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.35,
			() => 0,
		)

		for (const fallback of ['global', 'identity', 'reject'] as const) {
			const model = fitMono(reference, current, { estimator: 'scale', scaleSignificance: 1e9, fallback })

			expect(model.diagnostics[0].scaleCells).toBeGreaterThan(0)
			expect(model.scaleSurfaces[0]).toBeUndefined()
			expect(model.diagnostics[0].fallback).toBe(false)
			expect(model.diagnostics[0].reason).toBeUndefined()
			expect(isLocalNormalizationFallback(model)).toBe(false)

			// The global exposure correction is still applied, under every fallback policy.
			const probe = new Float64Array(reference.length).fill(0.4)
			applyLocalNormalizationInPlace(probe, undefined, model)
			for (const value of probe) expect(value).toBeCloseTo(0.4 * model.global[0].scale, 9)
		}
	})

	test('a gain field that cannot be fitted at all is still a failure', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.35,
			() => 0,
		)
		const mask = new Uint8Array(WIDTH * HEIGHT)
		const model = fitMono(reference, current, { estimator: 'scale' }, mask)

		expect(model.diagnostics[0].fallback).toBe(true)
		expect(model.diagnostics[0].reason).toBeDefined()
	})
})

describe('image API', () => {
	test('fit and apply mutate the current image and keep the reference intact', () => {
		const reference = referencePlane()
		const referenceCopy = new Float64Array(reference)
		const current = inverseTransform(
			reference,
			() => 1.25,
			() => 0.02,
		)

		const referenceImage = toImage(reference, 1)
		const currentImage = toImage(current, 1)
		const result = localNormalization(referenceImage, currentImage, { gridSize: 8, minSamplesPerCell: 64 })

		expect(result.image).toBe(currentImage)
		expect(Array.from(reference)).toEqual(Array.from(referenceCopy))
		expect(maxAbsoluteError(currentImage.raw as Float64Array, reference)).toBeLessThan(1e-12)
	})

	test('reject leaves the image untouched instead of applying the anchor', () => {
		const size = 64
		const reference = referencePlane(3, size, size)
		const current = inverseTransform(
			reference,
			() => 1.5,
			() => 0.03,
			size,
			size,
		)
		const currentCopy = new Float64Array(current)
		const currentImage = toImage(current, 1, size, size)

		const result = localNormalization(toImage(reference, 1, size, size), currentImage, { fallback: 'reject' })

		expect(isLocalNormalizationFallback(result.model)).toBe(true)
		expect(Array.from(currentImage.raw as Float64Array)).toEqual(Array.from(currentCopy))
		expect(result.image).toBe(currentImage)
		expect(result.applied).toBe(false)
	})

	test('a fitted plane is applied and reported as applied', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.25,
			() => 0.02,
		)

		const result = localNormalization(toImage(reference, 1), toImage(current, 1), { gridSize: 8, minSamplesPerCell: 64, fallback: 'reject' })

		expect(isLocalNormalizationFallback(result.model)).toBe(false)
		expect(result.applied).toBe(true)
		expect(maxAbsoluteError(result.image.raw as Float64Array, reference)).toBeLessThan(1e-12)
	})

	test('applying a model to a mismatched geometry throws', () => {
		const reference = referencePlane()
		const current = inverseTransform(
			reference,
			() => 1.1,
			() => 0,
		)
		const model = fitLocalNormalization(toImage(reference, 1), toImage(current, 1), { gridSize: 8, minSamplesPerCell: 64 })

		expect(() => applyLocalNormalization(toImage(new Float64Array(64 * 64), 1, 64, 64), model)).toThrow(/does not match/)
		expect(() => applyLocalNormalization(toImage(new Float64Array(WIDTH * HEIGHT * 3), 3), model)).toThrow(/does not match/)
		expect(() => applyLocalNormalization(toImage(new Float64Array(WIDTH * HEIGHT), 1), model)).not.toThrow()
	})
})
