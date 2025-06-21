import { expect, test } from 'bun:test'
import { angularSizeOfPixel } from '../src/util'

test('angularSizeOfPixel', () => {
	expect(angularSizeOfPixel(1000, 3.75)).toBeCloseTo(0.773, 3)
})
