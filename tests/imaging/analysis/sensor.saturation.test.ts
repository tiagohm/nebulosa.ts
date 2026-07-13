import { expect, test } from 'bun:test'
import type { PhotonTransferPoint, SensorGain, SensorReadNoise } from '../../../src/imaging/analysis/sensor.ptc'
import { computeSensorDynamicRange, detectSensorSaturation } from '../../../src/imaging/analysis/sensor.saturation'

// Saturation and dynamic-range tests distinguish observed output capacity from representable range.

// Creates a valid PTC point with optional clipping.
function point(level: number, signal: number, variance: number, clippedFraction: number = 0): PhotonTransferPoint {
	return { level, exposure: level + 1, signal, variance, darkMean: 100, darkVariance: 4, clippedFraction, pairCount: 1, valid: true, selectedForGainFit: false, fitRejectionReasons: [] }
}

// Exact 2 e-/DN conversion-gain fixture.
const GAIN: SensorGain = { system: 0.5, conversion: 2, intercept: 0, range: [100, 400], fit: { r: 1, r2: 1, rss: 0, rmsd: 0, pointCount: 4, weighted: true } }

test('uses the last unbiased level before digital clipping as saturation capacity', () => {
	const result = detectSensorSaturation([point(0, 100, 50), point(1, 300, 150), point(2, 500, 250), point(3, 550, 200, 0.2)], GAIN)
	expect(result).toEqual({ signal: 500, capacity: 1000, index: 2, method: 'unclippedLevel', confidence: 0.95 })
})

test('detects variance collapse and uses digital range only as low-confidence fallback', () => {
	const variance = detectSensorSaturation([point(0, 100, 50), point(1, 300, 160), point(2, 500, 140), point(3, 600, 100)], GAIN)
	expect(variance?.method).toBe('variance')
	expect(variance?.signal).toBe(300)

	const fallback = detectSensorSaturation([point(0, 100, 50), point(1, 200, 100)], GAIN, 1000)
	expect(fallback).toEqual({ signal: 1000, capacity: 2000, index: -1, method: 'digitalRange', confidence: 0.2 })
})

test('computes practical RMS and EMVA sensitivity dynamic ranges separately', () => {
	const saturation = { signal: 500, capacity: 1000, index: 2, method: 'unclippedLevel', confidence: 0.95 } as const
	const readNoise: SensorReadNoise = { digital: 2, totalElectrons: 4, sensorElectrons: 3.9, pairCount: 2, deviation: 0.1 }
	const result = computeSensorDynamicRange(saturation, readNoise)!
	expect(result.practical.ratio).toBe(250)
	expect(result.practical.stops).toBeCloseTo(Math.log2(250), 12)
	expect(result.emva.ratio).toBeCloseTo(1000 / (Math.sqrt(16.25) + 0.5), 12)
})
