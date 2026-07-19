import { expect, test } from 'bun:test'
import { adf, estimateBackground, histogram, median, medianAbsoluteDeviation, sigmaClip } from '../../../src/imaging/processing/computation'
import { makeImage } from './util'

// Focused regression coverage for image histogram, display statistics, and sigma clipping.

test('histogram preserves RGB grayscale binning on the identity fast path', () => {
	const image = makeImage(2, 1, 3, [1, 0, 0, 0, 1, 0])
	const result = histogram(image, { bits: 2 })

	expect(Array.from(result.histogram)).toEqual([1, 0, 1, 0])
})

test('histogram accepts only per-pixel masks for RGB images', () => {
	const image = makeImage(2, 1, 3, [1, 0, 0, 0, 1, 0])
	const perPixel = histogram(image, { bits: 2, sigmaClip: new Int8Array([1, 0]) })

	expect(Array.from(perPixel.histogram)).toEqual([0, 0, 1, 0])
	expect(() => histogram(image, { bits: 2, sigmaClip: new Int8Array([1, 0, 0, 0, 0, 0]) })).toThrow()
})

test('histogram clears and reuses an explicit bin buffer', () => {
	const image = makeImage(2, 1, 1, [0, 1])
	const bins = new Int32Array(4).fill(7)
	const result = histogram(image, { bits: bins })

	expect(result.histogram).toBe(bins)
	expect(Array.from(bins)).toEqual([1, 0, 0, 1])
})

test('histogram rejects unsafe bit depths and invalid buffers', () => {
	const image = makeImage(1, 1, 1, [0.5])

	for (const bits of [0, -1, 1.5, 25, Number.NaN]) expect(() => histogram(image, { bits })).toThrow()
	expect(() => histogram(image, { bits: new Int32Array(0) })).toThrow()
})

test('histogram rejects a mask that does not match the pixel count', () => {
	const image = makeImage(2, 1, 3, [1, 0, 0, 0, 1, 0])
	expect(() => histogram(image, { sigmaClip: new Int8Array(3) })).toThrow()
})

test('median absolute deviation reduces RGB to grayscale before measuring deviations', () => {
	const color = makeImage(2, 1, 3, [0, 1, 0, 1, 0, 0])
	const grayscale = makeImage(2, 1, 1, [0.7154, 0.2125])

	expect(medianAbsoluteDeviation(color, 0.5)).toBe(medianAbsoluteDeviation(grayscale, 0.5))
})

test('median absolute deviation honors transforms and normalization', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.2, 0.4])
	const raw = medianAbsoluteDeviation(image, 0.4, false, { transform: (value) => value * 2 })
	const normalized = medianAbsoluteDeviation(image, 0.4, true, { transform: (value) => value * 2 })

	expect(raw).toBeGreaterThan(0)
	expect(normalized).toBeCloseTo(raw * 1.482602218505602, 12)
})

test('adaptive display function validates and reuses histogram storage', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.2, 0.4])
	const bits = new Int32Array(16)
	const result = adf(image, { bits })

	expect(result.every(Number.isFinite)).toBe(true)
	expect(bits.some((count) => count !== 0)).toBe(true)
	expect(() => adf(image, { bits: 25 })).toThrow()
})

test('sigma clip preserves caller-provided seed rejections', () => {
	const image = makeImage(3, 1, 1, [0.2, 0.2, 0.2])
	const seed = new Int8Array([1, 0, 0])
	const result = sigmaClip(image, { mask: seed, maxIterations: 1 })

	expect(result).toBe(seed)
	expect(Array.from(result)).toEqual([1, 0, 0])
})

test('sigma clip applies the histogram transform during rejection', () => {
	const image = makeImage(4, 1, 1, [0, 0, 0, 0.2])
	const result = sigmaClip(image, { transform: (value) => 1 - value, sigmaLower: 1, sigmaUpper: 1, maxIterations: 1, tolerance: 0 })

	expect(Array.from(result)).toEqual([0, 0, 0, 1])
})

test('sigma clip performs rejection before considering near-one statistics converged', () => {
	const values = new Float32Array(1000).fill(1)
	values[999] = 0.5
	const result = sigmaClip(makeImage(1000, 1, 1, values))

	expect(result[999]).toBe(1)
})

test('sigma clip uses a per-pixel mask for RGB images', () => {
	const image = makeImage(2, 1, 3, [0.1, 0.1, 0.1, 0.2, 0.2, 0.2])
	const result = sigmaClip(image, { maxIterations: 0 })

	expect(result.length).toBe(image.metadata.pixelCount)
	expect(() => sigmaClip(image, { mask: new Int8Array(image.raw.length), maxIterations: 0 })).toThrow()
})

test('sigma clip validates thresholds and iteration limits', () => {
	const image = makeImage(1, 1, 1, [0.5])

	expect(() => sigmaClip(image, { sigmaLower: -1 })).toThrow()
	expect(() => sigmaClip(image, { sigmaUpper: Number.NaN })).toThrow()
	expect(() => sigmaClip(image, { tolerance: -1 })).toThrow()
	expect(() => sigmaClip(image, { maxIterations: 1.5 })).toThrow()
})

test('background estimation matches the median of the final clipped population', () => {
	const image = makeImage(7, 1, 1, [0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 1])
	const options = { sigmaLower: 2, sigmaUpper: 2, maxIterations: 5 }
	const mask = sigmaClip(image, { ...options, centerMethod: 'median', dispersionMethod: 'mad' })
	const expected = median(image, { ...options, sigmaClip: mask })

	expect(estimateBackground(image, options)).toBe(expected)
})
