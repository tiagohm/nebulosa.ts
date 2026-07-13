import { expect, test } from 'bun:test'
import { measureSensorDefects, SENSOR_DEFECT_COLD, SENSOR_DEFECT_HOT, SENSOR_DEFECT_NOISY, SENSOR_DEFECT_UNSTABLE } from '../../../src/imaging/analysis/sensor.defects'
import type { SensorFrameSet } from '../../../src/imaging/analysis/sensor.types'
import type { DigitalImage } from '../../../src/imaging/model/types'

// Defect tests inject persistent, temporal, and structural anomalies into deterministic stacks.

// Wraps a mono raw plane as a digital image.
function image(raw: Float64Array, width: number): DigitalImage {
	const height = raw.length / width
	return {
		header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height },
		raw,
		metadata: { width, height, channels: 1, pixelCount: raw.length, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer: undefined },
		sampleScale: 'digital',
		digitalRange: [0, 65535],
		quantizationStep: 1,
	}
}

// Creates a fixed-exposure stack from frame buffers.
function stack(frames: readonly Float64Array[], width: number): SensorFrameSet {
	if (frames.length < 2) throw new RangeError('test stack requires two frames')
	const images = frames.map((raw) => image(raw, width))
	return { frames: [images[0], images[1], ...images.slice(2)], exposure: 10 }
}

// Builds dark/flat stacks containing a hot row, cold column, noisy pixel, and RTS-like pixel.
function defectiveStacks(): readonly [SensorFrameSet, SensorFrameSet, number, number] {
	const width = 12
	const height = 10
	const frames = 16
	const dark: Float64Array[] = []
	const flat: Float64Array[] = []
	const noisyIndex = 3 * width + 8
	const unstableIndex = 7 * width + 9
	const gaussianLike = [-22, -15, -11.5, -9, -6.5, -4.5, -2.5, -0.8, 0.8, 2.5, 4.5, 6.5, 9, 11.5, 15, 22]
	for (let frame = 0; frame < frames; frame++) {
		const darkRaw = new Float64Array(width * height).fill(100)
		const flatRaw = new Float64Array(width * height).fill(1100)
		for (let x = 0; x < width; x++) {
			darkRaw[width + x] += 40
			flatRaw[width + x] += 40
		}
		for (let y = 0; y < height; y++) flatRaw[y * width + 4] = 400
		darkRaw[noisyIndex] += gaussianLike[frame]
		darkRaw[unstableIndex] += (frame & 1) === 0 ? -30 : 30
		dark.push(darkRaw)
		flat.push(flatRaw)
	}
	return [stack(dark, width), stack(flat, width), noisyIndex, unstableIndex]
}

test('classifies injected pixels and structural row/column defects', () => {
	const [dark, flat, noisyIndex, unstableIndex] = defectiveStacks()
	const result = measureSensorDefects(dark, flat, { maps: 'defects' })!
	expect(result.hot).toBe(12)
	expect(result.cold).toBe(10)
	expect(result.noisy).toBe(2)
	expect(result.unstable).toBe(1)
	expect(result.rows).toContain(1)
	expect(result.columns).toContain(4)
	expect(result.mask![width + 2] & SENSOR_DEFECT_HOT).toBe(SENSOR_DEFECT_HOT)
	expect(result.mask![5 * width + 4] & SENSOR_DEFECT_COLD).toBe(SENSOR_DEFECT_COLD)
	expect(result.mask![noisyIndex] & SENSOR_DEFECT_NOISY).toBe(SENSOR_DEFECT_NOISY)
	expect(result.mask![unstableIndex] & SENSOR_DEFECT_UNSTABLE).toBe(SENSOR_DEFECT_UNSTABLE)
})

// Width of the synthetic plane used by mask-index assertions.
const width = 12

test('requires reusable spatial buffers when maps are disabled', () => {
	const [dark, flat] = defectiveStacks()
	expect(measureSensorDefects(dark, flat, { maps: 'none' })).toBeUndefined()
	const capacity = width * 10
	const buffers = { mean: new Float64Array(capacity), variance: new Float64Array(capacity), mask: new Uint8Array(capacity) }
	const result = measureSensorDefects(dark, flat, { maps: 'none', spatialBuffers: buffers })!
	expect(result.mask).toBeUndefined()
	expect(result.hot).toBe(12)
	expect(buffers.mask.some((value) => value !== 0)).toBeTrue()
})

test('classifies cold pixels from dark-subtracted response instead of raw flat level', () => {
	const width = 8
	const darkRaw = new Float64Array(width * width).fill(100)
	const flatRaw = new Float64Array(width * width).fill(1100)
	darkRaw[10] = -100
	flatRaw[10] = 900
	const dark = stack([darkRaw, darkRaw], width)
	const flat = stack([flatRaw, flatRaw], width)
	const result = measureSensorDefects(dark, flat, { maps: 'defects' })!
	expect(result.mask![10] & SENSOR_DEFECT_COLD).toBe(0)
})

test('does not promote one isolated cold pixel to a structural row or column when profile MAD is zero', () => {
	const width = 4
	const darkRaw = new Float64Array(width * width).fill(100)
	const flatRaw = new Float64Array(width * width).fill(1100)
	flatRaw[1] = 1099
	const result = measureSensorDefects(stack([darkRaw, darkRaw], width), stack([flatRaw, flatRaw], width), { maps: 'defects' })!
	expect(result.cold).toBe(1)
	expect(result.rows).toHaveLength(0)
	expect(result.columns).toHaveLength(0)
})
