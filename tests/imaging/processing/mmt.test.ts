import { expect, test } from 'bun:test'
import { multiscaleMedianTransform } from '../../../src/imaging/processing/mmt'
import { exactMedianFilter, expectImageValues, makeImage } from './processing.util'

test('multiscaleMedianTransform reconstructs the original image with default settings', () => {
	const image = makeImage(2, 2, 3, [0.1, 0.2, 0.3, 0.9, 0.8, 0.7, 0.4, 0.5, 0.6, 0.2, 0.3, 0.4])
	const before = new Float32Array(image.raw)

	expect(multiscaleMedianTransform(image)).toBe(image)
	expectImageValues(image, before, 6)
})

test('multiscaleMedianTransform can suppress the first detail layer entirely', () => {
	const values = new Float32Array(25)
	values[12] = 1
	const image = makeImage(5, 5, 1, values)

	multiscaleMedianTransform(image, { layers: 1, detailLayers: [{ bias: -1 }] })

	expectImageValues(image, new Float32Array(25), 8)
})

test('multiscaleMedianTransform bias amplifies retained detail coefficients', () => {
	const values = new Float32Array(25)
	values[12] = 1
	const image = makeImage(5, 5, 1, values)

	multiscaleMedianTransform(image, { layers: 1, detailLayers: [{ bias: 1 }] })

	expect(image.raw[12]).toBeCloseTo(2, 8)

	for (let i = 0; i < image.raw.length; i++) {
		if (i !== 12) expect(image.raw[i]).toBeCloseTo(0, 8)
	}
})

test('multiscaleMedianTransform thresholding removes weak coefficients while preserving strong ones', () => {
	const values = new Float32Array(25)
	values[6] = 0.1
	values[18] = 1
	const image = makeImage(5, 5, 1, values)

	multiscaleMedianTransform(image, { layers: 1, detailLayers: [{ threshold: 0.75, amount: 1 }] })

	expect(image.raw[6]).toBeCloseTo(0, 8)
	expect(image.raw[18]).toBeCloseTo(1, 8)
})

test('multiscaleMedianTransform collapses tiny images toward the global median at large scales', () => {
	const image = makeImage(2, 2, 1, [0, 1, 2, 3])
	multiscaleMedianTransform(image, { layers: 3, detailLayers: [{ bias: -1 }, { bias: -1 }, { bias: -1 }] })
	expectImageValues(image, [1.5, 1.5, 1.5, 1.5], 8)
})

test('multiscaleMedianTransform median layer stays close to the exact sorted-window median', () => {
	const values = [0.1, 0.9, 0.3, 0.8, 0.2, 0.4, 0.7, 0.6, 0.5, 0.3, 0.9, 0.2, 0.1, 0.8, 0.4, 0.5, 0.3, 0.7, 0.2, 0.6]
	const image = makeImage(5, 4, 1, values)
	const expected = exactMedianFilter(5, 4, values, 1)

	multiscaleMedianTransform(image, { layers: 1, detailLayers: [{ bias: -1 }] })

	expectImageValues(image, expected, 3)
})
