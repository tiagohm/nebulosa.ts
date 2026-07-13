import { expect, test } from 'bun:test'
import { characterizeSensor } from '../../../src/imaging/analysis/sensor.characterization'
import type { SensorCharacterizationInput, SensorFlatFrameSet } from '../../../src/imaging/analysis/sensor.types'
import type { DigitalImage } from '../../../src/imaging/model/types'

// End-to-end MVP tests use deterministic pair variances and a clipped response plateau.

// Creates an eight-pixel digital frame pair with exact mean and temporal variance.
function pairedFrames(mean: number, variance: number): readonly [DigitalImage, DigitalImage] {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(8)
	const second = new Float64Array(8)
	for (let i = 0; i < 8; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}

	// Wraps a synthetic raw buffer as a digital sensor image.
	function image(raw: Float64Array): DigitalImage {
		return {
			header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 2 },
			raw,
			metadata: { width: 4, height: 2, channels: 1, pixelCount: 8, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer: undefined },
			sampleScale: 'digital',
			digitalRange: [0, 65535],
			quantizationStep: 1,
		}
	}
	return [image(first), image(second)]
}

// Adds one CFA pattern and image-local Bayer offset to a digital frame pair.
function cfaFrames(frames: readonly [DigitalImage, DigitalImage], x: number, y: number): readonly [DigitalImage, DigitalImage] {
	return [
		{ ...frames[0], header: { ...frames[0].header, XBAYROFF: x, YBAYROFF: y }, metadata: { ...frames[0].metadata, bayer: 'RGGB' } },
		{ ...frames[1], header: { ...frames[1].header, XBAYROFF: x, YBAYROFF: y }, metadata: { ...frames[1].metadata, bayer: 'RGGB' } },
	]
}

// Creates a CFA pair whose temporal differences vary within every two-sample plane grid.
function cfaPairedFrames(mean: number, variance: number): readonly [DigitalImage, DigitalImage] {
	const width = 16
	const height = 16
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(width * height)
	const second = new Float64Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x
			const signed = (((x >>> 1) + (y >>> 1)) & 1) === 0 ? difference : -difference
			first[index] = mean + signed / 2
			second[index] = mean - signed / 2
		}
	}
	const header = { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height, XBAYROFF: 0, YBAYROFF: 0 }
	const metadata = { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer: 'RGGB' as const }
	return [
		{ header, metadata, raw: first, sampleScale: 'digital', digitalRange: [0, 65535], quantizationStep: 1 },
		{ header, metadata, raw: second, sampleScale: 'digital', digitalRange: [0, 65535], quantizationStep: 1 },
	]
}

// Removes image-local Bayer offsets while retaining the CFA metadata and pixel data.
function withoutCfaOffsets(frames: readonly [DigitalImage, DigitalImage]): readonly [DigitalImage, DigitalImage] {
	return [
		{ ...frames[0], header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: frames[0].metadata.width, NAXIS2: frames[0].metadata.height } },
		{ ...frames[1], header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: frames[1].metadata.width, NAXIS2: frames[1].metadata.height } },
	]
}

test('characterizes the temporal MVP and distinguishes observable capacity from digital range', () => {
	const biasFrames = pairedFrames(1000, 4)
	const flats: SensorFlatFrameSet[] = []
	for (let level = 1; level <= 10; level++) {
		const signal = Math.min(level * 100, 700)
		flats.push({ frames: pairedFrames(1000 + signal, 4 + signal * 0.5), darkFrames: pairedFrames(1000, 4), exposure: level })
	}
	const darks = [0, 10, 20, 30, 40, 50].map((exposure) => ({ frames: pairedFrames(1000 + 5 * exposure, 4 + 2.5 * exposure), exposure }))
	const input: SensorCharacterizationInput = {
		operatingPoint: { gain: 100, offset: 20, size: { width: 4, height: 2 } },
		bias: { frames: biasFrames, exposure: 0.001 },
		flats,
		darks,
		spatial: { dark: { frames: pairedFrames(1000, 4), exposure: 10 }, flat: { frames: pairedFrames(1500, 4), exposure: 10 } },
	}
	const result = characterizeSensor(input, { digitalClip: 1700, maps: 'defects' })

	expect(result.planes).toHaveLength(1)
	const plane = result.planes[0]
	expect(plane.gain?.system).toBeCloseTo(0.5, 10)
	expect(plane.saturation?.method).toBe('unclippedLevel')
	expect(plane.saturation?.signal).toBeCloseTo(600, 10)
	expect(plane.saturation?.capacity).toBeCloseTo(1200, 10)
	expect(plane.dynamicRange?.practical.ratio).toBeCloseTo(300, 10)
	expect(plane.linearity?.error).toBeCloseTo(0, 10)
	expect(plane.darkCurrent?.mean).toBeCloseTo(10, 10)
	expect(plane.darkCurrent?.variance).toBeCloseTo(10, 10)
	expect(plane.defects).toBeDefined()
	expect(plane.photonTransfer.at(-1)?.saturationFraction).toBeGreaterThan(1)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'tooManySaturatedPixels')).toBeTrue()
})

test('uses the image digital range to reject clipped flats by default', () => {
	const clipped = pairedFrames(300, 152)
	clipped[0].raw.fill(65535)
	clipped[1].raw.fill(65535)
	const result = characterizeSensor(
		{
			operatingPoint: {},
			bias: { frames: pairedFrames(100, 2), exposure: 0 },
			flats: [
				{ frames: pairedFrames(200, 52), exposure: 1 },
				{ frames: pairedFrames(300, 102), exposure: 2 },
				{ frames: clipped, exposure: 3 },
			],
		},
		{ gainRange: [0, 1] },
	)
	const clippedPoint = result.planes[0].photonTransfer.find((point) => point.level === 2)!
	expect(clippedPoint.fitRejectionReasons).toContain('clipped')
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'tooManySaturatedPixels' && diagnostic.level === 2)).toBeTrue()
})

test('uses the lowest frame digital maximum to reject clipped flats', () => {
	const clipped = pairedFrames(300, 152)
	clipped[0].raw.fill(4095)
	clipped[1].raw.fill(4095)
	const clippedAtLowerRange = [
		{ ...clipped[0], digitalRange: [0, 4095] as const },
		{ ...clipped[1], digitalRange: [0, 4095] as const },
	] as const
	const result = characterizeSensor(
		{
			operatingPoint: {},
			bias: { frames: pairedFrames(100, 2), exposure: 0 },
			flats: [
				{ frames: pairedFrames(200, 52), exposure: 1 },
				{ frames: pairedFrames(300, 102), exposure: 2 },
				{ frames: clippedAtLowerRange, exposure: 3 },
			],
		},
		{ gainRange: [0, 1] },
	)

	expect(result.planes[0].photonTransfer.find((point) => point.level === 2)?.fitRejectionReasons).toContain('clipped')
})

test('returns structural diagnostics instead of plausible results for mixed dimensions', () => {
	const bias = pairedFrames(100, 2)
	const invalid = { ...bias[0], metadata: { ...bias[0].metadata, width: 8, height: 1, stride: 8 } }
	const input: SensorCharacterizationInput = {
		operatingPoint: {},
		bias: { frames: bias, exposure: 0 },
		flats: [{ frames: [invalid, invalid], exposure: 1 }],
	}
	const result = characterizeSensor(input)
	expect(result.planes).toHaveLength(0)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'mixedDimensions')).toBeTrue()
})

test('rejects conflicting frame-set operating points when the expected field is omitted', () => {
	const frames = pairedFrames(100, 2)
	const input: SensorCharacterizationInput = {
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { gain: 100 } },
		flats: [{ frames, exposure: 1, operatingPoint: { gain: 200 } }],
	}

	const result = characterizeSensor(input)

	expect(result.planes).toHaveLength(0)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'mixedOperatingPoint' && diagnostic.severity === 'error')).toBeTrue()
})

test('returns operating-point metadata accumulated from frame sets', () => {
	const frames = pairedFrames(100, 2)
	const successful = characterizeSensor({
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { gain: 100 } },
		flats: [{ frames: pairedFrames(200, 20), exposure: 1, operatingPoint: { gain: 100 } }],
	})
	const invalid = { ...frames[0], metadata: { ...frames[0].metadata, width: 8, height: 1, stride: 8 } }
	const structural = characterizeSensor({
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { gain: 100 } },
		flats: [{ frames: [invalid, invalid], exposure: 1, operatingPoint: { gain: 100 } }],
	})

	expect(successful.operatingPoint.gain).toBe(100)
	expect(structural.planes).toHaveLength(0)
	expect(structural.operatingPoint.gain).toBe(100)
})

test('accepts frame-set temperature drift within the configured tolerance', () => {
	const frames = pairedFrames(100, 2)
	const result = characterizeSensor({
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { temperature: -10 } },
		flats: [{ frames: pairedFrames(200, 20), exposure: 1, operatingPoint: { temperature: -9.9 } }],
	})

	expect(result.planes).toHaveLength(1)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'mixedOperatingPoint')).toBeFalse()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'temperatureDrift')).toBeFalse()
})

test('rejects top-level frame temperatures outside the expected operating point', () => {
	const frames = pairedFrames(100, 2)
	const result = characterizeSensor({
		operatingPoint: { temperature: -10 },
		bias: { frames, exposure: 0, temperature: -5 },
		flats: [{ frames: pairedFrames(200, 20), exposure: 1, temperature: -5 }],
	})

	expect(result.planes).toHaveLength(0)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'mixedOperatingPoint' && diagnostic.severity === 'error')).toBeTrue()
})

test('rejects non-finite frame-set operating temperatures before merging', () => {
	const frames = pairedFrames(100, 2)
	const result = characterizeSensor({
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { temperature: Number.NaN } },
		flats: [{ frames: pairedFrames(200, 20), exposure: 1 }],
	})

	expect(result.planes).toHaveLength(0)
	expect(result.operatingPoint.temperature).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'mixedOperatingPoint' && diagnostic.severity === 'error')).toBeTrue()
})

test('rejects non-finite numeric fields in expected and frame-set operating points', () => {
	const frames = pairedFrames(100, 2)
	const invalidFrameSet = characterizeSensor({
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { gain: Number.NaN } },
		flats: [{ frames: pairedFrames(200, 20), exposure: 1 }],
	})
	const invalidExpected = characterizeSensor({
		operatingPoint: { temperature: Number.NaN },
		bias: { frames, exposure: 0 },
		flats: [{ frames: pairedFrames(200, 20), exposure: 1 }],
	})

	expect(invalidFrameSet.planes).toHaveLength(0)
	expect(invalidFrameSet.operatingPoint.gain).toBeUndefined()
	expect(invalidExpected.planes).toHaveLength(0)
	expect(invalidFrameSet.diagnostics.some((diagnostic) => diagnostic.code === 'mixedOperatingPoint')).toBeTrue()
	expect(invalidExpected.diagnostics.some((diagnostic) => diagnostic.code === 'mixedOperatingPoint')).toBeTrue()
})

test('rejects inconsistent Bayer offsets across CFA frame sets', () => {
	const input: SensorCharacterizationInput = {
		operatingPoint: {},
		bias: { frames: cfaFrames(pairedFrames(100, 2), 0, 0), exposure: 0 },
		flats: [{ frames: cfaFrames(pairedFrames(200, 4), 1, 0), exposure: 1 }],
	}

	const result = characterizeSensor(input)

	expect(result.planes).toHaveLength(0)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'unknownCfaOrigin' && diagnostic.severity === 'error')).toBeTrue()
})

test('rejects binned CFA data declared only by frame sets', () => {
	const frames = cfaFrames(pairedFrames(100, 2), 0, 0)
	const result = characterizeSensor({
		operatingPoint: {},
		bias: { frames, exposure: 0, operatingPoint: { binning: [2, 2] } },
		flats: [{ frames: cfaFrames(pairedFrames(200, 20), 0, 0), exposure: 1, operatingPoint: { binning: [2, 2] } }],
	})

	expect(result.planes).toHaveLength(0)
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'unknownCfaOrigin' && diagnostic.severity === 'error')).toBeTrue()
})

test('uses the sensor origin accumulated from CFA frame sets', () => {
	const operatingPoint = { sensorOrigin: [2, 4] as const }
	const result = characterizeSensor(
		{
			operatingPoint: {},
			bias: { frames: withoutCfaOffsets(cfaPairedFrames(100, 4)), exposure: 0, operatingPoint },
			flats: [
				{ frames: withoutCfaOffsets(cfaPairedFrames(200, 54)), exposure: 1, operatingPoint },
				{ frames: withoutCfaOffsets(cfaPairedFrames(300, 104)), exposure: 2, operatingPoint },
				{ frames: withoutCfaOffsets(cfaPairedFrames(500, 204)), exposure: 3, operatingPoint },
			],
		},
		{ planes: ['red'] },
	)

	expect(result.planes).toHaveLength(1)
	expect(result.operatingPoint.sensorOrigin).toEqual([2, 4])
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'unknownCfaOrigin')).toBeFalse()
})

test('retains independent defect masks for each CFA plane when reusing buffers', () => {
	const bias = cfaPairedFrames(100, 4)
	const flats: SensorFlatFrameSet[] = [
		{ frames: cfaPairedFrames(200, 54), darkFrames: cfaPairedFrames(100, 4), exposure: 1 },
		{ frames: cfaPairedFrames(300, 104), darkFrames: cfaPairedFrames(100, 4), exposure: 2 },
		{ frames: cfaPairedFrames(500, 204), darkFrames: cfaPairedFrames(100, 4), exposure: 3 },
	]
	const planeCapacity = 8 * 8
	const spatialBuffers = { mean: new Float64Array(planeCapacity), variance: new Float64Array(planeCapacity), mask: new Uint8Array(planeCapacity) }
	const result = characterizeSensor(
		{
			operatingPoint: {},
			bias: { frames: bias, exposure: 0 },
			flats,
			spatial: { dark: { frames: cfaPairedFrames(100, 4), exposure: 1 }, flat: { frames: cfaPairedFrames(500, 20), exposure: 1 } },
		},
		{ maps: 'defects', planes: ['red', 'blue'], spatialBuffers, tile: { width: 4, height: 4 } },
	)

	expect(result.planes).toHaveLength(2)
	const redMask = result.planes[0].defects?.mask
	const blueMask = result.planes[1].defects?.mask
	expect(redMask).toBeDefined()
	expect(blueMask).toBeDefined()
	expect(redMask!.buffer).not.toBe(blueMask!.buffer)
	expect(redMask!.buffer).not.toBe(spatialBuffers.mask.buffer)
})

test('classifies spatial defects when temporal gain is unavailable', () => {
	const spatialDark = pairedFrames(100, 0)
	spatialDark[0].raw[3] = 1000
	spatialDark[1].raw[3] = 1000
	const result = characterizeSensor(
		{
			operatingPoint: {},
			bias: { frames: pairedFrames(100, 2), exposure: 0 },
			flats: [{ frames: pairedFrames(500, 20), exposure: 1 }],
			spatial: { dark: { frames: spatialDark, exposure: 1 }, flat: { frames: pairedFrames(500, 0), exposure: 1 } },
		},
		{ maps: 'defects' },
	)

	expect(result.planes).toHaveLength(1)
	expect(result.planes[0].gain).toBeUndefined()
	expect(result.planes[0].defects?.hot).toBe(1)
})

test('preserves temporal characterization when optional dark-current analysis fails', () => {
	const flats: SensorFlatFrameSet[] = []
	for (let level = 1; level <= 4; level++) flats.push({ frames: pairedFrames(1000 + level * 100, 4 + level * 50), darkFrames: pairedFrames(1000, 4), exposure: level })
	const duplicateExposureDarks = [1, 1, 2].map((exposure) => ({ frames: pairedFrames(1000 + 5 * exposure, 4), exposure }))
	const result = characterizeSensor({ operatingPoint: {}, bias: { frames: pairedFrames(1000, 4), exposure: 0 }, flats, darks: duplicateExposureDarks })
	expect(result.planes).toHaveLength(1)
	expect(result.planes[0].gain).toBeDefined()
	expect(result.planes[0].darkCurrent).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'insufficientDarkLevels')).toBeTrue()
})
