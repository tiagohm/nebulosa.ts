import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
// oxfmt-ignore
import { applyLocalNormalization, applyLocalNormalizationInPlace, fitLocalNormalization, fitLocalNormalizationRaw, isLocalNormalizationFallback, type LocalNormalizationOptions, localNormalization, resolveLocalNormalizationOptions, solveGlobalNormalization } from '../../../src/imaging/processing/normalization'
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
		const support = model.supportGrids[0]

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

		// Well below the fit's own residual, which is of order 1e-3 for this frame.
		expect(maxAbsoluteError(coarse, dense)).toBeLessThan(1.5e-4)
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
		expect(model.supportGrids).toHaveLength(1)

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
