import { expect, test } from 'bun:test'
import { characterizeSensorTemporal, fitPhotonTransferGain, type PhotonTransferPoint } from '../../../src/imaging/analysis/sensor.ptc'
import type { SensorFlatFrameSet, SensorFrameSet } from '../../../src/imaging/analysis/sensor.types'
import type { DigitalImage } from '../../../src/imaging/model/types'

// Exact synthetic PTC tests with prescribed pair means and temporal population variances.

// Creates an eight-pixel digital frame pair around a mean with exact temporal variance.
function pairedFrames(mean: number, variance: number, width: number = 4): readonly [DigitalImage, DigitalImage] {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(8)
	const second = new Float64Array(8)
	for (let i = 0; i < first.length; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}

	// Wraps one raw buffer as an immutable digital image contract.
	function image(raw: Float64Array): DigitalImage {
		const height = raw.length / width
		return {
			header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height },
			raw,
			metadata: { width, height, channels: 1, pixelCount: 8, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer: undefined },
			sampleScale: 'digital',
			digitalRange: [0, 65535],
			quantizationStep: 1,
		}
	}

	return [image(first), image(second)]
}

test('recovers system gain, conversion gain, and read noise from exact paired levels', () => {
	const bias: SensorFrameSet = { frames: pairedFrames(1000, 4), exposure: 0.001 }
	const signals = [100, 200, 400, 600, 800]
	const flats: SensorFlatFrameSet[] = signals.map((signal, index) => ({
		frames: pairedFrames(1000 + signal, 4 + 0.5 * signal),
		darkFrames: pairedFrames(1000, 4),
		exposure: index + 1,
	}))
	const result = characterizeSensorTemporal(bias, flats)

	expect(result.bias.mean).toBeCloseTo(1000, 12)
	expect(result.gain).toBeDefined()
	expect(result.gain!.system).toBeCloseTo(0.5, 12)
	expect(result.gain!.conversion).toBeCloseTo(2, 12)
	expect(result.gain!.intercept).toBeCloseTo(0, 10)
	expect(result.gain!.fit.r2).toBeCloseTo(1, 12)
	expect(result.gain!.fit.pointCount).toBe(3)
	expect(result.readNoise.digital).toBeCloseTo(2, 12)
	expect(result.readNoise.totalElectrons).toBeCloseTo(4, 12)
	expect(result.readNoise.sensorElectrons).toBeCloseTo(Math.sqrt(4 - 1 / 12) * 2, 12)
	for (let i = 0; i < signals.length; i++) expect(result.photonTransfer[i].variance).toBeCloseTo(signals[i] * 0.5, 10)
})

test('marks nonpositive and clipped PTC levels instead of fitting them', () => {
	const bias: SensorFrameSet = { frames: pairedFrames(100, 2), exposure: 0 }
	const flats: SensorFlatFrameSet[] = [
		{ frames: pairedFrames(90, 1), exposure: 1 },
		{ frames: pairedFrames(200, 20), exposure: 2 },
	]
	const result = characterizeSensorTemporal(bias, flats, { digitalClip: 150 })
	expect(result.gain).toBeUndefined()
	expect(result.photonTransfer[0].fitRejectionReasons).toContain('nonPositiveSignal')
	expect(result.photonTransfer[1].fitRejectionReasons).toContain('clipped')
})

test('keeps partially calibrated flat stimuli on the relative exposure-intensity scale', () => {
	const bias: SensorFrameSet = { frames: pairedFrames(100, 2), exposure: 0 }
	const flats: SensorFlatFrameSet[] = [
		{ frames: pairedFrames(200, 20), exposure: 10, intensity: 2, photons: 500 },
		{ frames: pairedFrames(300, 40), exposure: 10, intensity: 3 },
	]
	const result = characterizeSensorTemporal(bias, flats, { gainRange: [0, 1] })
	expect(result.photonTransfer.find((point) => point.level === 0)?.stimulus).toBe(20)
	expect(result.photonTransfer.find((point) => point.level === 1)?.stimulus).toBe(30)
})

test('uses calibrated photons when every flat level defines them', () => {
	const bias: SensorFrameSet = { frames: pairedFrames(100, 2), exposure: 0 }
	const flats: SensorFlatFrameSet[] = [
		{ frames: pairedFrames(200, 20), exposure: 10, intensity: 2, photons: 500 },
		{ frames: pairedFrames(300, 40), exposure: 10, intensity: 3, photons: 700 },
	]
	const result = characterizeSensorTemporal(bias, flats, { gainRange: [0, 1] })
	expect(result.photonTransfer.find((point) => point.level === 0)?.stimulus).toBe(500)
	expect(result.photonTransfer.find((point) => point.level === 1)?.stimulus).toBe(700)
})

test('rejects temporal flat levels with mismatched dimensions', () => {
	const bias: SensorFrameSet = { frames: pairedFrames(100, 2), exposure: 0 }
	const flats: SensorFlatFrameSet[] = [{ frames: pairedFrames(200, 20, 8), exposure: 1 }]

	expect(() => characterizeSensorTemporal(bias, flats)).toThrow('temporal frame sets must share dimensions and CFA pattern')
})

test('returns annotated points without gain when selected signals are duplicated', () => {
	const points: PhotonTransferPoint[] = [1, 2].map((variance, level) => ({
		level,
		exposure: level + 1,
		signal: 100,
		variance,
		darkMean: 10,
		darkVariance: 1,
		clippedFraction: 0,
		pairCount: 1,
		valid: true,
		selectedForGainFit: false,
		fitRejectionReasons: [],
	}))
	const [annotated, gain] = fitPhotonTransferGain(points, [0, 1])
	expect(gain).toBeUndefined()
	expect(annotated.every((point) => point.selectedForGainFit)).toBeTrue()
})
