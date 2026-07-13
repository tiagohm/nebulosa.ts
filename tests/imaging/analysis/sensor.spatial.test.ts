import { expect, test } from 'bun:test'
import { measureSensorSpatial } from '../../../src/imaging/analysis/sensor.spatial'
import type { SensorFrameSet } from '../../../src/imaging/analysis/sensor.types'
import type { DigitalImage } from '../../../src/imaging/model/types'

// Spatial tests use repeated deterministic frames so temporal residual correction is exactly zero.

// Wraps a mono or CFA raw plane as a digital image.
function image(raw: Float64Array, width: number, bayer?: DigitalImage['metadata']['bayer']): DigitalImage {
	const height = raw.length / width
	return {
		header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height, BAYERPAT: bayer },
		raw,
		metadata: { width, height, channels: 1, pixelCount: raw.length, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer },
		sampleScale: 'digital',
		digitalRange: [0, 65535],
		quantizationStep: 1,
	}
}

// Creates a two-frame fixed-exposure stack sharing the same spatial signal.
function stack(raw: Float64Array, width: number, exposure: number = 10, bayer?: DigitalImage['metadata']['bayer']): SensorFrameSet {
	return { frames: [image(raw.slice(), width, bayer), image(raw.slice(), width, bayer)], exposure }
}

test('recovers high-frequency DSNU without retaining full-resolution workspaces', () => {
	const width = 32
	const darkRaw = new Float64Array(width * width)
	const flatRaw = new Float64Array(width * width)
	for (let y = 0; y < width; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x
			const dsnu = ((x + y) & 1) === 0 ? 2 : -2
			darkRaw[index] = 100 + dsnu
			flatRaw[index] = darkRaw[index] + 1000
		}
	}
	const result = measureSensorSpatial(stack(darkRaw, width), stack(flatRaw, width), 2, { tile: { width: 8, height: 8 }, maps: 'none' })
	expect(result.dsnu.overall).toBeCloseTo(4, 2)
	expect(result.prnu.emva.overall).toBeCloseTo(0, 8)
	expect(result.dsnu.map).toBeUndefined()
	expect(result.sampleCount).toBe(width * width)
})

test('recovers PRNU after a smooth illumination gradient and fills optional maps and buffers', () => {
	const width = 32
	const darkRaw = new Float64Array(width * width)
	const flatRaw = new Float64Array(width * width)
	for (let y = 0; y < width; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x
			const model = 1000 + 5 * x + 3 * y
			const response = ((x + y) & 1) === 0 ? 1.02 : 0.98
			darkRaw[index] = 100
			flatRaw[index] = 100 + model * response
		}
	}
	const mean = new Float64Array(width * width)
	const variance = new Float64Array(width * width)
	const mask = new Uint8Array(width * width)
	const result = measureSensorSpatial(stack(darkRaw, width), stack(flatRaw, width), 2, {
		tile: { width: 8, height: 8 },
		spatialDetrend: 'plane',
		maps: 'all',
		spatialBuffers: { mean, variance, mask },
	})

	expect(result.prnu.corrected?.overall).toBeCloseTo(0.02, 3)
	expect(result.prnu.undetrended.overall).toBeGreaterThan(result.prnu.corrected!.overall)
	expect(result.prnu.map).toHaveLength(width * width)
	expect(result.dsnu.map).toHaveLength(width * width)
	expect(mean[0]).toBeCloseTo(1020, 12)
	expect(mask.every((value) => value === 0)).toBeTrue()
})

test('analyzes a CFA plane on its dense plane grid with sensor-origin phase', () => {
	const width = 16
	const darkRaw = new Float64Array(width * width).fill(100)
	const flatRaw = new Float64Array(width * width).fill(1100)
	const result = measureSensorSpatial(stack(darkRaw, width, 10, 'RGGB'), stack(flatRaw, width, 10, 'RGGB'), 2, { plane: 'red', cfaOffset: [0, 0], tile: { width: 4, height: 4 } })
	expect(result.sampleCount).toBe(64)
	expect(result.prnu.rowProfile).toHaveLength(8)
	expect(result.prnu.columnProfile).toHaveLength(8)
})
