import { expect, test } from 'bun:test'
import { aggregateSensorPairs, measureSensorPair } from '../../../src/imaging/analysis/sensor.pair'
import type { DigitalImage } from '../../../src/imaging/model/types'

// Deterministic paired-frame tests for population variance, ROI/CFA selection, masking, and clipping.

// Creates a mono or CFA digital image backed by the supplied samples.
function digitalImage(raw: readonly number[], width: number, bayer?: DigitalImage['metadata']['bayer']): DigitalImage {
	const height = raw.length / width
	return {
		header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height, BAYERPAT: bayer },
		raw: Float64Array.from(raw),
		metadata: { width, height, channels: 1, pixelCount: raw.length, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer },
		sampleScale: 'digital',
		digitalRange: [0, 65535],
		quantizationStep: 1,
	}
}

test('recovers known paired population variance without allocating a difference image', () => {
	const statistics = measureSensorPair(digitalImage([10, 12, 14, 16], 2), digitalImage([8, 12, 12, 18], 2))
	expect(statistics.mean).toBeCloseTo(12.75, 12)
	expect(statistics.variance).toBeCloseTo(1.375, 12)
	expect(statistics.drift).toBeCloseTo(0.5, 12)
	expect(statistics.sampleCount).toBe(4)
	expect(statistics.rejectedCount).toBe(0)
})

test('selects CFA plane inside ROI while rejecting mask and non-finite samples', () => {
	const first = digitalImage([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, Number.NaN, 120, 130, 140, 150, 160], 4, 'RGGB')
	const second = digitalImage([8, 18, 28, 38, 48, 58, 68, 78, 88, 98, 108, 118, 128, 138, 148, 158], 4, 'RGGB')
	const mask = new Uint8Array(16)
	mask[6] = 1

	const red = measureSensorPair(first, second, { plane: 'red', area: { left: 0, top: 0, right: 4, bottom: 4 }, digitalClip: 80 })
	expect(red.sampleCount).toBe(3)
	expect(red.rejectedCount).toBe(1)
	expect(red.saturatedCount).toBe(1)
	expect(red.clippedFraction).toBeCloseTo(1 / 3, 12)

	const green2 = measureSensorPair(first, second, { plane: 'green2', area: { left: 0, top: 0, right: 4, bottom: 4 }, mask })
	expect(green2.sampleCount).toBe(3)
	expect(green2.rejectedCount).toBe(1)
})

test('rejects incompatible structure, invalid ROI, mask, and empty samples', () => {
	const mono = digitalImage([1, 2, 3, 4], 2)
	expect(() => measureSensorPair(mono, digitalImage([1, 2, 3, 4, 5, 6], 3))).toThrow()
	expect(() => measureSensorPair(mono, mono, { area: { left: 1, top: 1, right: 1, bottom: 2 } })).toThrow()
	expect(() => measureSensorPair(mono, mono, { mask: new Uint8Array(3) })).toThrow()
	expect(() => measureSensorPair(digitalImage([Number.NaN], 1), digitalImage([1], 1))).toThrow()
	expect(() => measureSensorPair(digitalImage([1, 2, 3, 4], 2, 'RGGB'), digitalImage([1, 2, 3, 4], 2, 'RGGB'))).toThrow()
})

test('aggregates pairs by valid samples and preserves between-pair scatter', () => {
	const aggregate = aggregateSensorPairs([
		{ mean: 10, variance: 2, drift: 1, clippedFraction: 0.1, sampleCount: 10, rejectedCount: 1, saturatedCount: 1 },
		{ mean: 20, variance: 6, drift: -1, clippedFraction: 0.2, sampleCount: 30, rejectedCount: 2, saturatedCount: 6 },
	])
	expect(aggregate.mean).toBe(17.5)
	expect(aggregate.variance).toBe(5)
	expect(aggregate.drift).toBe(-0.5)
	expect(aggregate.clippedFraction).toBe(0.175)
	expect(aggregate.meanScatter).toBe(18.75)
	expect(aggregate.varianceScatter).toBe(3)
	expect(aggregate.pairCount).toBe(2)
})
