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
