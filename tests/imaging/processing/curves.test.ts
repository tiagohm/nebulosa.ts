import { expect, test } from 'bun:test'
import { curvesTransformation } from '../../../src/imaging/processing/curves'
import { expectImageValues, makeImage } from './util'

test('curvesTransformation is a no-op by default', () => {
	const image = makeImage(2, 1, 3, [0.1, 0.3, 0.5, 0.7, 0.2, 0.9])
	const before = new Float32Array(image.raw)

	expect(curvesTransformation(image)).toBe(image)
	expectImageValues(image, before, 8)
})

test('curvesTransformation applies the RGB curve through the configured LUT', () => {
	const midpoint = 128 / 255
	const quarter = 64 / 255
	const image = makeImage(1, 1, 3, [midpoint, 0, 1])

	curvesTransformation(image, { bits: 8, curves: [{ channel: 'RED', x: [0, midpoint, 1], y: [0, quarter, 1] }] })
	expectImageValues(image, [quarter, 0, 1], 6)
})

test('curvesTransformation lifts pure-black RGB pixels for RGB/K curves', () => {
	const quarter = 64 / 255
	const image = makeImage(1, 1, 3, [0, 0, 0])

	curvesTransformation(image, { bits: 8, curves: [{ channel: 'GRAY', x: [0, 1], y: [quarter, 1] }] })
	expectImageValues(image, [quarter, quarter, quarter], 6)
})

test('curvesTransformation can use Akima interpolation', () => {
	const midpoint = 128 / 255
	const quarter = 64 / 255
	const image = makeImage(1, 1, 3, [midpoint, 0, 1])

	curvesTransformation(image, { bits: 8, interpolation: 'akima', curves: [{ channel: 'RED', x: [0, midpoint, 1], y: [0, quarter, 1] }] })
	expectImageValues(image, [quarter, 0, 1], 6)
})

test('curvesTransformation can use Catmull-Rom interpolation', () => {
	const midpoint = 128 / 255
	const quarter = 64 / 255
	const image = makeImage(1, 1, 3, [midpoint, 0, 1])

	curvesTransformation(image, { bits: 8, interpolation: 'catmullRom', curves: [{ channel: 'RED', x: [0, midpoint, 1], y: [0, quarter, 1] }] })
	expectImageValues(image, [quarter, 0, 1], 6)
})

test('curvesTransformation can use natural cubic interpolation', () => {
	const midpoint = 128 / 255
	const quarter = 64 / 255
	const image = makeImage(1, 1, 3, [midpoint, 0, 1])

	curvesTransformation(image, { bits: 8, interpolation: 'naturalCubic', curves: [{ channel: 'RED', x: [0, midpoint, 1], y: [0, quarter, 1] }] })
	expectImageValues(image, [quarter, 0, 1], 6)
})

test('curvesTransformation rejects mismatched control point arrays', () => {
	const image = makeImage(1, 1, 1, [0.5])

	expect(() => curvesTransformation(image, { curves: [{ channel: 'GRAY', x: [0, 1], y: [0] }] })).toThrow('curves transformation x and y arrays must have the same length')
})

test('curvesTransformation rejects NaN control points before clamping', () => {
	const image = makeImage(1, 1, 1, [0.5])

	expect(() => curvesTransformation(image, { curves: [{ channel: 'GRAY', x: [Number.NaN, 1], y: [0, 1] }] })).toThrow('curves transformation control points must be finite')
})

test('curvesTransformation rejects infinite control points before clamping', () => {
	const image = makeImage(1, 1, 1, [0.5])

	expect(() => curvesTransformation(image, { curves: [{ channel: 'GRAY', x: [0, 1], y: [Number.POSITIVE_INFINITY, 1] }] })).toThrow('curves transformation control points must be finite')
})
