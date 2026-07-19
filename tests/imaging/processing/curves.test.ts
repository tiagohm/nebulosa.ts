import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
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

test('curvesTransformation reaches lifted RGB/K luminance without clipping saturated channels', () => {
	const image = makeImage(1, 1, 3, [1, 0.2, 0.2])
	const inputLuminance = 0.2126 + 0.7152 * 0.2 + 0.0722 * 0.2
	const expectedLuminance = 0.5 + 0.5 * inputLuminance

	curvesTransformation(image, { bits: 16, curves: [{ channel: 'GRAY', x: [0, 1], y: [0.5, 1] }] })

	const outputLuminance = 0.2126 * image.raw[0] + 0.7152 * image.raw[1] + 0.0722 * image.raw[2]
	expect(outputLuminance).toBeCloseTo(expectedLuminance, 6)
	expect(image.raw[0]).toBe(1)
	expect(image.raw[1]).toBeGreaterThan(0.2)
	expect(image.raw[1]).toBeLessThan(1)
	expect(image.raw[2]).toBeCloseTo(image.raw[1], 7)
})

test('curvesTransformation preserves RGB ratios while darkening luminance', () => {
	const image = makeImage(1, 1, 3, [1, 0.2, 0.2])
	const inputLuminance = 0.2126 + 0.7152 * 0.2 + 0.0722 * 0.2

	curvesTransformation(image, { bits: 16, curves: [{ channel: 'GRAY', x: [0, 1], y: [0, 0.5] }] })

	const outputLuminance = 0.2126 * image.raw[0] + 0.7152 * image.raw[1] + 0.0722 * image.raw[2]
	expect(outputLuminance).toBeCloseTo(0.5 * inputLuminance, 7)
	expect(image.raw[0] / image.raw[1]).toBeCloseTo(5, 6)
	expect(image.raw[1]).toBeCloseTo(image.raw[2], 7)
})

test('curvesTransformation reaches luminance for normalized custom weights', () => {
	const weights = { red: 0.5, green: 0.25, blue: 0.25 }
	const image = makeImage(1, 1, 3, [1, 0.2, 0.4])
	const inputLuminance = weights.red + weights.green * 0.2 + weights.blue * 0.4
	const expectedLuminance = 0.25 + 0.75 * inputLuminance

	curvesTransformation(image, { bits: 16, curves: [{ channel: weights, x: [0, 1], y: [0.25, 1] }] })

	const outputLuminance = weights.red * image.raw[0] + weights.green * image.raw[1] + weights.blue * image.raw[2]
	expect(outputLuminance).toBeCloseTo(expectedLuminance, 6)
	for (const value of image.raw) {
		expect(value).toBeGreaterThanOrEqual(0)
		expect(value).toBeLessThanOrEqual(1)
	}
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

test('curvesTransformation ignores absent color channels in mono images', () => {
	for (const channel of ['RED', 'GREEN', 'BLUE'] as const) {
		const image = makeImage(1, 1, 1, [0.25])
		expect(curvesTransformation(image, { bits: 8, curves: [{ channel, x: [0, 1], y: [1, 0] }] })).toBe(image)
		expectImageValues(image, [0.25], 8)
	}

	const gray = makeImage(1, 1, 1, [0.25])
	curvesTransformation(gray, { bits: 8, curves: [{ channel: 'GRAY', x: [0, 1], y: [1, 0] }] })
	expectImageValues(gray, [0.75], 7)
})

test('curvesTransformation evaluates normalized integer codes without downward LUT bias', () => {
	const max = 65535
	const raw = new Float32Array(max + 1)
	for (let i = 0; i <= max; i++) raw[i] = i / max
	const image = makeImage(max + 1, 1, 1, raw)

	curvesTransformation(image, { bits: 16, curves: [{ channel: 'GRAY', x: [0, 1], y: [1, 0] }] })

	let maximumError = 0
	for (let i = 0; i <= max; i++) maximumError = Math.max(maximumError, Math.abs(image.raw[i] - (1 - i / max)))
	expect(image.raw[1]).toBeCloseTo(1 - 1 / max, 7)
	expect(maximumError).toBeLessThan(6e-8)
})

test('curvesTransformation caps dense LUT storage while retaining high-bit continuous sampling', () => {
	const a = makeImage(5, 1, 1, [0.123456, 0.25, 0.5, 0.75, 0.987654])
	const b = makeImage(5, 1, 1, a.raw.slice())
	const curve = { channel: 'GRAY', x: [0, 0.2, 0.65, 1], y: [0.05, 0.4, 0.8, 0.95] } as const

	curvesTransformation(a, { bits: 16, curves: [curve] })
	curvesTransformation(b, { bits: 24, curves: [curve] })

	expect(b.raw).toEqual(a.raw)
})

test('curvesTransformation keeps monotonic control curves order-preserving for every interpolation', () => {
	const width = 4097
	const input = new Float32Array(width)
	for (let i = 0; i < width; i++) input[i] = i / (width - 1)
	const curve = { channel: 'GRAY', x: [0, 0.2, 0.4, 0.6, 0.8, 1], y: [0, 0.4566976190544665, 0.9133023099512029, 0.9139800948430841, 0.9271990390529644, 1] } as const

	for (const interpolation of ['cubicHermite', 'akima', 'catmullRom', 'naturalCubic'] as const) {
		const image = makeImage(width, 1, 1, input.slice())
		curvesTransformation(image, { bits: 12, interpolation, curves: [curve] })
		for (let i = 1; i < width; i++) expect(image.raw[i]).toBeGreaterThanOrEqual(image.raw[i - 1])
	}
})

test('curvesTransformation preserves explicitly nonmonotonic control curves', () => {
	const image = makeImage(5, 1, 1, [0, 0.25, 0.5, 0.75, 1])
	curvesTransformation(image, { bits: 12, curves: [{ channel: 'GRAY', x: [0, 0.5, 1], y: [0, 1, 0] }] })
	expect(image.raw[2]).toBeGreaterThan(image.raw[1])
	expect(image.raw[2]).toBeGreaterThan(image.raw[3])
})

test('curvesTransformation defaults to monotone cubic Hermite interpolation', () => {
	const values = [0.1, 0.3, 0.55, 0.8]
	const curve = { channel: 'GRAY', x: [0, 0.25, 0.7, 1], y: [0, 0.6, 0.75, 1] } as const
	const implicit = makeImage(4, 1, 1, values)
	const explicit = makeImage(4, 1, 1, values)
	curvesTransformation(implicit, { bits: 12, curves: [curve] })
	curvesTransformation(explicit, { bits: 12, interpolation: 'cubicHermite', curves: [curve] })
	expect(implicit.raw).toEqual(explicit.raw)
})

test('curvesTransformation validates interpolation and every channel before mutation', () => {
	const scenarios = [
		{ interpolation: 'linear' },
		{ curves: [{ channel: 'INVALID', x: [0, 1], y: [0.2, 1] }] },
		{ curves: [{ channel: null, x: [0, 1], y: [0.2, 1] }] },
		{ curves: [{ channel: { red: Number.NaN, green: 0, blue: 1 }, x: [0, 1], y: [0.2, 1] }] },
		{ curves: [{ channel: { red: -0.1, green: 0.5, blue: 0.6 }, x: [0, 1], y: [0.2, 1] }] },
		{ curves: [{ channel: { red: 0.2, green: 0.3, blue: 0.4 }, x: [0, 1], y: [0.2, 1] }] },
	] as const

	for (const options of scenarios) {
		const image = makeImage(1, 1, 3, [0.25, 0.5, 0.75])
		const before = image.raw.slice()
		expect(() => curvesTransformation(image, { bits: 8, curves: [{ channel: 'RED', x: [0, 1], y: [1, 0] }], ...options } as never)).toThrow()
		expect(image.raw).toEqual(before)
	}
})

test('curvesTransformation rejects malformed dense layouts before mutation', () => {
	const valid = makeImage(1, 1, 3, [0.25, 0.5, 0.75])
	const malformed: Image[] = [
		{ ...valid, metadata: { ...valid.metadata, width: 0 } },
		{ ...valid, metadata: { ...valid.metadata, height: 0 } },
		makeImage(1, 1, 2, [0.25, 0.5]),
		{ ...valid, metadata: { ...valid.metadata, pixelCount: 2 } },
		{ ...valid, metadata: { ...valid.metadata, stride: 2 } },
		makeImage(1, 1, 3, [0.25, 0.5]),
	]

	for (const image of malformed) {
		const before = image.raw.slice()
		expect(() => curvesTransformation(image, { bits: 8, curves: [{ channel: 'GRAY', x: [0, 1], y: [1, 0] }] })).toThrow()
		expect(image.raw).toEqual(before)
	}
})
