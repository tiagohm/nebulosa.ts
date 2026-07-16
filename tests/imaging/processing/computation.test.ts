import { expect, test } from 'bun:test'
import { histogram } from '../../../src/imaging/processing/computation'
import { makeImage } from './util'

// Focused regression coverage for image histogram, display statistics, and sigma clipping.

test('histogram preserves RGB grayscale binning on the identity fast path', () => {
	const image = makeImage(2, 1, 3, [1, 0, 0, 0, 1, 0])
	const result = histogram(image, { bits: 2 })

	expect(Array.from(result.histogram)).toEqual([1, 0, 1, 0])
})

test('histogram accepts per-pixel and raw-layout masks for RGB images', () => {
	const image = makeImage(2, 1, 3, [1, 0, 0, 0, 1, 0])
	const perPixel = histogram(image, { bits: 2, sigmaClip: new Int8Array([1, 0]) })
	const rawLayout = histogram(image, { bits: 2, sigmaClip: new Int8Array([1, 0, 0, 0, 0, 0]) })

	expect(Array.from(perPixel.histogram)).toEqual([0, 0, 1, 0])
	expect(Array.from(rawLayout.histogram)).toEqual([0, 0, 1, 0])
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

test('histogram rejects a mask that matches neither supported layout', () => {
	const image = makeImage(2, 1, 3, [1, 0, 0, 0, 1, 0])
	expect(() => histogram(image, { sigmaClip: new Int8Array(3) })).toThrow()
})
