import { expect, test } from 'bun:test'
import { stf } from '../../../src/imaging/processing/stf'
import { expectImageValues, makeImage } from './processing.util'

test('stf applies the transfer function only to the selected RGB channel', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.4, 0.8])
	stf(image, 0.25, 0.2, 0.6, { channel: 'GREEN' })
	expectImageValues(image, [0.2, 0.75, 0.8], 6)
})

test('stf is a no-op with default parameters', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.5, 0.9])
	const before = new Float32Array(image.raw)

	expect(stf(image)).toBe(image)
	expectImageValues(image, before, 8)
})

test('stf clips values outside the shadow and highlight range', () => {
	const image = makeImage(3, 1, 1, [0.1, 0.4, 0.9])
	stf(image, 0.5, 0.2, 0.8)
	expectImageValues(image, [0, 1 / 3, 1], 6)
})
