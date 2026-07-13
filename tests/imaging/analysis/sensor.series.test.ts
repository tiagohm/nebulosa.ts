import { expect, test } from 'bun:test'
import type { SensorCharacterization } from '../../../src/imaging/analysis/sensor.characterization'
import { characterizeSensorSeries } from '../../../src/imaging/analysis/sensor.series'
import type { SensorOperatingPoint } from '../../../src/imaging/analysis/sensor.types'

// Series tests use minimal valid characterization reports with controlled measured system gains.

// Creates one mono characterization at a configured and measured gain.
function profile(configuredGain: number, systemGain: number, operatingPoint: Partial<SensorOperatingPoint> = {}): SensorCharacterization {
	return {
		operatingPoint: {
			gain: configuredGain,
			offset: 20,
			temperature: -10,
			readoutMode: 'lowNoise',
			bitDepth: 16,
			binning: [1, 1],
			sensorOrigin: [0, 0],
			size: { width: 100, height: 80 },
			camera: 'synthetic',
			...operatingPoint,
		},
		planes: [
			{
				plane: 'mono',
				bias: { mean: 100, drift: 0, sampleCount: 100 },
				gain: { system: systemGain, conversion: 1 / systemGain, intercept: 0, fit: { r: 1, r2: 1, rss: 0, rmsd: 0, pointCount: 4, weighted: false }, range: [10, 1000] },
				readNoise: { digital: 2, totalElectrons: 2 / systemGain, pairCount: 2, deviation: 0 },
				photonTransfer: [],
			},
		],
		acquisition: { width: 100, height: 80, roi: { left: 0, top: 0, right: 100, bottom: 80 }, biasFrames: 2, flatLevels: 4, darkLevels: 0, temperatures: [-10, -10] },
		diagnostics: [],
	}
}

test('sorts compatible profiles and interpolates a bracketed unity gain', () => {
	const result = characterizeSensorSeries([profile(100, 1.5), profile(0, 0.5)])
	expect(result.profiles.map((item) => item.operatingPoint.gain)).toEqual([0, 100])
	expect(result.unityGain?.configuredGain).toBeCloseTo(50, 12)
	expect(result.unityGain?.lower.gain).toBe(0)
	expect(result.unityGain?.upper.gain).toBe(100)
	expect(result.diagnostics).toHaveLength(0)
})

test('does not extrapolate when measured points do not bracket unity', () => {
	const result = characterizeSensorSeries([profile(0, 0.4), profile(100, 0.8)])
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'unityGainNotBracketed')).toBeTrue()
})

test('refuses to compare profiles from different readout regimes', () => {
	const result = characterizeSensorSeries([profile(0, 0.5), profile(100, 1.5, { readoutMode: 'highSpeed' })])
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'incompatibleProfiles')).toBeTrue()
})

test('refuses to compare profiles measured over different acquisition ROIs', () => {
	const cropped = profile(100, 1.5)
	const result = characterizeSensorSeries([profile(0, 0.5), { ...cropped, acquisition: { ...cropped.acquisition, roi: { left: 10, top: 0, right: 100, bottom: 80 } } }])
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'incompatibleProfiles')).toBeTrue()
})

test('uses the complete temperature span when checking series compatibility', () => {
	const result = characterizeSensorSeries([profile(0, 0.5, { temperature: -10 }), profile(50, 1, { temperature: -9.6 }), profile(100, 1.5, { temperature: -10.4 })], { temperatureTolerance: 0.5 })
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'incompatibleProfiles')).toBeTrue()
})

test('uses acquisition temperature spans when operating-point temperatures are absent', () => {
	const cold = profile(0, 0.5, { temperature: undefined })
	const warm = profile(100, 1.5, { temperature: undefined })
	const result = characterizeSensorSeries([cold, { ...warm, acquisition: { ...warm.acquisition, temperatures: [0, 0] } }], { temperatureTolerance: 0.5 })
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'incompatibleProfiles')).toBeTrue()
})

test('rejects a non-monotonic measured gain curve', () => {
	const result = characterizeSensorSeries([profile(0, 0.5), profile(50, 1.2), profile(100, 0.9)])
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'nonMonotonicGainSeries')).toBeTrue()
})

test('rejects a non-monotonic curve even when one point measures exact unity', () => {
	const result = characterizeSensorSeries([profile(0, 0.5), profile(50, 1), profile(100, 0.4)])
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'nonMonotonicGainSeries')).toBeTrue()
})

test('does not interpolate across an abrupt slope regime change', () => {
	const result = characterizeSensorSeries([profile(0, 0.5), profile(50, 0.55), profile(51, 1.4), profile(100, 1.45)])
	expect(result.unityGain).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'regimeChangeDetected')).toBeTrue()
})

test('returns an exact measured unity operating point without interpolation', () => {
	const exact = profile(60, 1)
	const result = characterizeSensorSeries([exact])
	expect(result.unityGain?.configuredGain).toBe(60)
	expect(result.unityGain?.lower).toBe(exact.operatingPoint)
	expect(result.unityGain?.upper).toBe(exact.operatingPoint)
})
