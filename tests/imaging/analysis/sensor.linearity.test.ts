import { expect, test } from 'bun:test'
import { measureSensorLinearity } from '../../../src/imaging/analysis/sensor.linearity'
import type { PhotonTransferPoint, SensorGain } from '../../../src/imaging/analysis/sensor.ptc'
import type { SensorFlatFrameSet } from '../../../src/imaging/analysis/sensor.types'
import type { DigitalImage } from '../../../src/imaging/model/types'

// Relative and photon-calibrated linearity tests use scalar PTC fixtures without rereading pixels.

// Minimal digital image used only to satisfy flat-set acquisition contracts.
const IMAGE = {
	header: { SIMPLE: true, BITPIX: 16 },
	raw: new Float64Array(1),
	metadata: { width: 1, height: 1, channels: 1, pixelCount: 1, pixelSizeInBytes: 2, strideInBytes: 2, stride: 1, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
} as const satisfies DigitalImage

// Creates one positive PTC level for linearity fitting.
function point(level: number, signal: number): PhotonTransferPoint {
	return { level, exposure: level + 1, signal, variance: signal * 0.5, darkMean: 100, darkVariance: 4, clippedFraction: 0, pairCount: 1, valid: true, selectedForGainFit: true, fitRejectionReasons: [] }
}

// Creates a photon-calibrated flat-set placeholder.
function flat(photons: number, wavelength?: number): SensorFlatFrameSet {
	return { frames: [IMAGE, IMAGE], exposure: photons / 250, photons, wavelength }
}

test('recovers photon responsivity, quantum efficiency, and relative residuals', () => {
	const points = [point(0, 100), point(1, 300), point(2, 500), point(3, 700), point(4, 900)]
	const flats = [flat(250, 550), flat(750, 550), flat(1250, 550), flat(1750, 550), flat(2250, 550)]
	const gain: SensorGain = { system: 0.5, conversion: 2, intercept: 0, range: [100, 700], fit: { r: 1, r2: 1, rss: 0, rmsd: 0, pointCount: 4, weighted: true } }
	const result = measureSensorLinearity(points, flats, { signal: 1000, capacity: 2000, index: 4, method: 'response', confidence: 0.8 }, gain)

	expect(result.linearity?.slope).toBeCloseTo(0.4, 12)
	expect(result.linearity?.error).toBeCloseTo(0, 12)
	expect(result.responsivity).toBeCloseTo(0.4, 12)
	expect(result.quantumEfficiency).toBeCloseTo(0.8, 12)
})

test('requires a recorded spectral condition before reporting quantum efficiency', () => {
	const points = [point(0, 100), point(1, 300), point(2, 500)]
	const gain: SensorGain = { system: 0.5, conversion: 2, intercept: 0, range: [100, 500], fit: { r: 1, r2: 1, rss: 0, rmsd: 0, pointCount: 3, weighted: true } }
	const result = measureSensorLinearity(points, [flat(250), flat(750), flat(1250)], { signal: 600, index: 2, method: 'response', confidence: 0.8 }, gain, [0, 1])
	expect(result.responsivity).toBeCloseTo(0.4, 12)
	expect(result.quantumEfficiency).toBeUndefined()
	expect(result.quantumEfficiencyUnavailable).toBe('missingSpectralCalibration')
})

test('reports compression as a nonzero relative linearity error', () => {
	const points = [point(0, 100), point(1, 300), point(2, 500), point(3, 650), point(4, 760)]
	const flats = [flat(250), flat(750), flat(1250), flat(1750), flat(2250)]
	const result = measureSensorLinearity(points, flats, { signal: 800, index: 4, method: 'response', confidence: 0.8 }, undefined, [0.05, 1])
	expect(result.linearity).toBeDefined()
	expect(result.linearity!.error).toBeGreaterThan(0.01)
	expect(result.quantumEfficiency).toBeUndefined()
})

test('does not mix photon and exposure axes when calibration metadata is incomplete', () => {
	const points = [point(0, 100), point(1, 200)]
	const flats: SensorFlatFrameSet[] = [
		{ frames: [IMAGE, IMAGE], exposure: 1, photons: 250 },
		{ frames: [IMAGE, IMAGE], exposure: 2 },
	]
	const result = measureSensorLinearity(points, flats, { signal: 250, index: 1, method: 'response', confidence: 0.8 }, undefined, [0, 1])
	expect(result.linearity?.slope).toBeCloseTo(100, 12)
	expect(result.responsivity).toBeUndefined()
})

test('excludes flat- and dark-clipped levels from the linearity fit', () => {
	const flatClipped = { ...point(1, 120), clippedFraction: 0.01 }
	const darkClipped = { ...point(2, 180), darkClippedFraction: 0.01 }
	const points = [point(0, 100), flatClipped, darkClipped, point(3, 400)]
	const flats = [flat(1), flat(2), flat(3), flat(4)]
	const result = measureSensorLinearity(points, flats, { signal: 400, index: 3, method: 'response', confidence: 0.8 }, undefined, [0, 1])

	expect(result.linearity?.fit.pointCount).toBe(2)
	expect(result.linearity?.slope).toBeCloseTo(100, 12)
	expect(result.linearity?.error).toBeCloseTo(0, 12)
})
