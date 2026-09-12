import { expect, test } from 'bun:test'
import { adf, estimateBackground, histogram, median, medianAbsoluteDeviation, sigmaClip } from '../../../src/imaging/processing/computation'
import { STANDARD_DEVIATION_SCALE } from '../../../src/math/numerical/statistics'
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

	expect(() => histogram(image, { bits: 25 })).toThrow()
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
	expect(normalized).toBeCloseTo(raw * STANDARD_DEVIATION_SCALE, 12)
})

test('adaptive display function validates and reuses histogram storage', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.2, 0.4])
	const bits = new Int32Array(16)
	const result = adf(image, { bits })

	expect(result.every(Number.isFinite)).toBe(true)
	expect(bits.some((count) => count !== 0)).toBe(true)
	expect(() => adf(image, { bits: 25 })).toThrow()
})

test('adaptive display function is identity for a constant dark image', () => {
	const [midtone, shadow, highlight] = adf(makeImage(8, 8, 1, new Float32Array(64).fill(0.25)))

	expect(midtone).toBeCloseTo(0.5, 4)
	expect(shadow).toBe(0)
	expect(highlight).toBe(1)
})

test('adaptive display function uses the zero-MAD clipping path for a constant bright image', () => {
	const [midtone, shadow, highlight] = adf(makeImage(8, 8, 1, new Float32Array(64).fill(0.9)))

	expect(shadow).toBe(0)
	expect(highlight).toBe(1)
	expect(midtone).toBeCloseTo(0.75, 3)
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

test('sigma clip rejects a non-finite iteration cap that would never terminate', () => {
	const image = makeImage(1, 1, 1, [0.5])

	expect(() => sigmaClip(image, { maxIterations: Number.POSITIVE_INFINITY })).toThrow()
})

test('sigma clip restricts moments and rejection to the requested area', () => {
	const values = new Float32Array(100).fill(0.1)
	for (let i = 90; i < 100; i++) values[i] = 0.8
	const image = makeImage(100, 1, 1, values)
	const area = { left: 90, right: 99 }

	const meanStd = sigmaClip(image, { area })
	expect(Array.from(meanStd)).toEqual(new Array(100).fill(0))

	const medianMad = sigmaClip(image, { area, centerMethod: 'median', dispersionMethod: 'mad' })
	expect(Array.from(medianMad)).toEqual(new Array(100).fill(0))

	const mixed = new Float32Array(100).fill(0.1)
	for (let i = 90; i < 99; i++) mixed[i] = 0.2
	mixed[99] = 0.9
	const mixedMask = sigmaClip(makeImage(100, 1, 1, mixed), { area, sigmaLower: 1, sigmaUpper: 1, maxIterations: 1, tolerance: 0 })
	expect(Array.from(mixedMask.slice(0, 90))).toEqual(new Array(90).fill(0))
	expect(mixedMask[99]).toBe(1)

	const rows = new Float32Array(20).fill(0.1)
	for (let i = 10; i < 20; i++) rows[i] = 0.8
	const bottomMask = sigmaClip(makeImage(10, 2, 1, rows), { area: { top: 1, bottom: 1, left: 0, right: 9 }, centerMethod: 'median', dispersionMethod: 'mad' })
	expect(Array.from(bottomMask.slice(0, 10))).toEqual(new Array(10).fill(0))
	expect(Array.from(bottomMask.slice(10))).toEqual(new Array(10).fill(0))
})

test('background estimation matches the median of the final clipped population', () => {
	const image = makeImage(7, 1, 1, [0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 1])
	const options = { sigmaLower: 2, sigmaUpper: 2, maxIterations: 5 }
	const mask = sigmaClip(image, { ...options, centerMethod: 'median', dispersionMethod: 'mad' })
	const expected = median(image, { ...options, sigmaClip: mask })

	expect(estimateBackground(image, options)).toBe(expected)
})
