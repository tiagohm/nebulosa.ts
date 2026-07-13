import { expect, test } from 'bun:test'
import { measureSensorDarkCurrent } from '../../../src/imaging/analysis/sensor.dark'
import type { SensorFrameSet } from '../../../src/imaging/analysis/sensor.types'
import type { DigitalImage } from '../../../src/imaging/model/types'

// Synthetic dark stacks prescribe mean and variance slopes independently in digital-number units.

// Wraps a 4x4 raw buffer as a digital mono or CFA image.
function image(raw: Float64Array, bayer?: 'RGGB'): DigitalImage {
	return {
		header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 4, BAYERPAT: bayer },
		raw,
		metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer },
		sampleScale: 'digital',
		digitalRange: [0, 65535],
		quantizationStep: 1,
	}
}

// Creates a uniform pair with exact temporal variance.
function uniformPair(mean: number, variance: number, bayer?: 'RGGB'): readonly [DigitalImage, DigitalImage] {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(16)
	const second = new Float64Array(16)
	for (let i = 0; i < 16; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}
	return [image(first, bayer), image(second, bayer)]
}

test('recovers dark current independently from mean and temporal variance slopes', () => {
	const darks: SensorFrameSet[] = [0, 10, 20, 40, 80, 120].map((exposure) => ({ frames: uniformPair(100 + 5 * exposure, 4 + 2.5 * exposure), exposure, temperature: -10 }))
	const result = measureSensorDarkCurrent(darks, 2, { tile: { width: 2, height: 2 } })

	expect(result.mean).toBeCloseTo(10, 10)
	expect(result.variance).toBeCloseTo(10, 10)
	expect(result.meanFit.r2).toBeCloseTo(1, 12)
	expect(result.varianceFit?.r2).toBeCloseTo(1, 12)
	expect(result.temperature).toBe(-10)
	expect(result.ampGlow?.ratio).toBeCloseTo(1, 12)
})

test('resolves localized amp glow from per-tile exposure slopes', () => {
	const darks: SensorFrameSet[] = [0, 10, 20, 40].map((exposure) => {
		const first = new Float64Array(16)
		const second = new Float64Array(16)
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) {
				const index = y * 4 + x
				const slope = x >= 2 && y < 2 ? 20 : 5
				const signed = (index & 1) === 0 ? 2 : -2
				first[index] = 100 + slope * exposure + signed
				second[index] = 100 + slope * exposure - signed
			}
		}
		return { frames: [image(first), image(second)], exposure }
	})
	const result = measureSensorDarkCurrent(darks, 2, { tile: { width: 2, height: 2 } })
	expect(result.ampGlow?.current).toEqual(Float32Array.from([10, 40, 10, 10]))
	expect(result.ampGlow?.median).toBe(10)
	expect(result.ampGlow?.ratio).toBe(4)
})

test('excludes empty CFA tiles from amp-glow statistics', () => {
	const darks: SensorFrameSet[] = [0, 10, 20, 40].map((exposure) => ({ frames: uniformPair(100 + 5 * exposure, 4, 'RGGB'), exposure }))
	const result = measureSensorDarkCurrent(darks, 2, { plane: 'red', cfaOffset: [0, 0], tile: { width: 1, height: 1 } })
	const ampGlow = result.ampGlow!

	expect(ampGlow.median).toBeCloseTo(10, 12)
	expect(ampGlow.maximum).toBeCloseTo(10, 12)
	expect(ampGlow.excess).toBeCloseTo(0, 12)
	expect(ampGlow.ratio).toBeCloseTo(1, 12)
	expect(ampGlow.current.filter(Number.isFinite)).toEqual(Float32Array.from([10, 10, 10, 10]))
	expect(ampGlow.current.filter(Number.isNaN)).toHaveLength(12)
})

test('requires three distinct dark exposure times', () => {
	const pair = uniformPair(100, 4)
	expect(() =>
		measureSensorDarkCurrent(
			[
				{ frames: pair, exposure: 1 },
				{ frames: pair, exposure: 1 },
				{ frames: pair, exposure: 2 },
			],
			2,
		),
	).toThrow()
})

test('limits amp-glow tiles to the requested measurement ROI', () => {
	const darks: SensorFrameSet[] = [0, 10, 20].map((exposure) => ({ frames: uniformPair(100 + 5 * exposure, 4), exposure }))
	const result = measureSensorDarkCurrent(darks, 2, { area: { left: 2, top: 0, right: 4, bottom: 2 }, tile: { width: 2, height: 2 } })
	expect(result.ampGlow?.columns).toBe(1)
	expect(result.ampGlow?.rows).toBe(1)
	expect(result.ampGlow?.current).toHaveLength(1)
})
