import { describe, expect, test } from 'bun:test'
import type { DigitalImage, ImageRawType } from '../../../src/imaging/model/types'
import { calibrate, calibrationMasterImage } from '../../../src/imaging/processing/calibration'
import { type CalibrationCombination, CalibrationPlaneLevels, createCalibrationIntegrationDiagnostics, divideCalibrationPlanes, effectiveCalibrationCombination, integrateCalibrationRows, subtractCalibrationRows } from '../../../src/imaging/processing/calibration.integration'
import { makeImage } from './util'

// Deterministic mulberry32 generator, so each noise test sees the same samples on every run.
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// Returns a standard normal generator from the Box-Muller transform.
function gaussian(seed: number) {
	const uniform = random(seed)
	return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform())
}

function frames(count: number, samples: number, value: (frame: number, sample: number) => number) {
	return Array.from({ length: count }, (_, frame) => Float64Array.from({ length: samples }, (_, sample) => value(frame, sample)))
}

function integrate(rows: readonly ImageRawType[], method: CalibrationCombination = 'sigmaClip', options = {}) {
	const output = new Float64Array(rows[0].length)
	const diagnostics = createCalibrationIntegrationDiagnostics(rows.length)
	integrateCalibrationRows(rows, output.length, output, { method, ...options }, diagnostics)
	return { output, diagnostics }
}

function deviation(values: ArrayLike<number>, expected: number) {
	let sum = 0
	for (let i = 0; i < values.length; i++) sum += (values[i] - expected) ** 2
	return Math.sqrt(sum / values.length)
}

describe('dark integration', () => {
	test('recovers pedestal plus signal and reduces noise by the square root of the frames', () => {
		const noise = gaussian(1)
		const rows = frames(30, 4096, () => 1000 + 17 + 5 * noise())
		const { output } = integrate(rows)

		let mean = 0
		for (const value of output) mean += value
		expect(mean / output.length).toBeCloseTo(1017, 1)
		// A clipped mean of Gaussian noise is slightly noisier than the plain mean of 5 / sqrt(30) = 0.91 DN.
		expect(deviation(output, 1017)).toBeGreaterThan(0.8)
		expect(deviation(output, 1017)).toBeLessThan(1.05)
	})

	test('keeps a stable hot pixel and rejects a transient at the same coordinate of another pixel', () => {
		const noise = gaussian(2)
		const rows = frames(30, 16, (frame, sample) => {
			let value = 1000 + 4 * noise()
			if (sample === 3) value += 3000
			if (sample === 9 && frame === 7) value += 40000
			return value
		})
		const { output, diagnostics } = integrate(rows)

		expect(output[3]).toBeCloseTo(4000, -1)
		expect(output[9]).toBeCloseTo(1000, -1)
		expect(diagnostics.rejectedHigh).toBeGreaterThanOrEqual(1)
		expect(diagnostics.rejectedPerFrame[7]).toBeGreaterThanOrEqual(1)
	})

	test('keeps an amp glow gradient that a normalization would flatten', () => {
		const noise = gaussian(3)
		const rows = frames(20, 64, (_, sample) => 500 + sample * 10 + 3 * noise())
		const { output } = integrate(rows)

		for (let sample = 0; sample < 64; sample++) expect(Math.abs(output[sample] - (500 + sample * 10))).toBeLessThan(4)
	})

	test('stays finite on a quantized plateau with a zero MAD', () => {
		const neighbour = integrate(frames(30, 1, (frame) => (frame === 0 ? 101 : 100)))
		expect(neighbour.output[0]).toBeCloseTo(100 + 1 / 30, 8)
		expect(neighbour.diagnostics.rejectedHigh).toBe(0)

		const outlier = integrate(frames(30, 1, (frame) => (frame === 0 ? 9000 : 100)))
		expect(outlier.output[0]).toBe(100)
		expect(outlier.diagnostics.rejectedHigh).toBe(1)
	})

	test('never pretends to clip fewer than three frames', () => {
		expect(effectiveCalibrationCombination('sigmaClip', 1)).toBe('mean')
		expect(effectiveCalibrationCombination('sigmaClip', 2)).toBe('mean')
		expect(effectiveCalibrationCombination('sigmaClip', 3)).toBe('sigmaClip')
		expect(effectiveCalibrationCombination('median', 2)).toBe('median')

		const { output, diagnostics } = integrate(frames(2, 1, (frame) => (frame === 0 ? 100 : 30000)))
		expect(output[0]).toBe(15050)
		expect(diagnostics.rejectedHigh).toBe(0)
	})

	test('combines the sample mean and median without rejection', () => {
		const rows = frames(5, 1, (frame) => [1, 2, 3, 4, 100][frame])
		expect(integrate(rows, 'mean').output[0]).toBe(22)
		expect(integrate(rows, 'median').output[0]).toBe(3)
		expect(
			integrate(
				frames(4, 1, (frame) => [1, 2, 3, 100][frame]),
				'median',
			).output[0],
		).toBe(2.5)
	})

	test('ignores non-finite samples and refuses a pixel left without enough of them', () => {
		const { output, diagnostics } = integrate(
			frames(4, 2, (frame, sample) => (sample === 1 || frame === 0 ? Number.NaN : 100)),
			'sigmaClip',
			{ minimumSamples: 2 },
		)

		expect(output[0]).toBe(100)
		expect(output[1]).toBeNaN()
		expect(diagnostics.nonFinite).toBe(5)
		expect(diagnostics.undersampled).toBe(1)
	})

	test('never rejects more than half of the samples of a pixel', () => {
		const rows = frames(6, 1, (frame) => [0, 0, 0, 1000, 1000, 1000][frame])
		const { output, diagnostics } = integrate(rows, 'sigmaClip', { sigmaLow: 0.1, sigmaHigh: 0.1 })

		expect(output[0]).toBe(500)
		expect(diagnostics.clipLimited).toBe(1)
	})

	test('does not depend on how the image is split into rows', () => {
		const noise = gaussian(4)
		const rows = frames(9, 90, () => 700 + 6 * noise())
		const whole = integrate(rows).output
		const split = new Float64Array(90)
		const diagnostics = createCalibrationIntegrationDiagnostics(9)

		for (let start = 0; start < 90; start += 30) {
			const part = new Float64Array(30)
			integrateCalibrationRows(
				rows.map((row) => row.subarray(start, start + 30)),
				30,
				part,
				{ method: 'sigmaClip' },
				diagnostics,
			)
			split.set(part, start)
		}

		expect(split).toEqual(whole)
	})
})

describe('flat integration', () => {
	const width = 8
	const height = 8
	const samples = width * height
	const pedestal = 1000
	const response = (sample: number) => (sample === 27 ? 0.7 : 1) * (1 - 0.002 * sample)

	// Master flat from raw frames with different brightness, along the workflow of a streaming caller.
	function masterFlat(mosaic: boolean, phaseGain: (sample: number) => number = () => 1) {
		const noise = gaussian(5)
		const raws = frames(12, samples, (frame, sample) => pedestal + (20000 + frame * 1500) * response(sample) * phaseGain(sample) + 2 * noise())
		const correction = new Float64Array(samples).fill(pedestal)

		for (const raw of raws) {
			subtractCalibrationRows(raw, correction, samples)
			const levels = new CalibrationPlaneLevels(mosaic ? 4 : 1, samples, mosaic)
			levels.push(raw, width, height, 0)
			divideCalibrationPlanes(
				raw,
				width,
				height,
				0,
				levels.levels().map(({ median }) => median),
				mosaic,
			)
		}

		const { output } = integrate(raws, 'sigmaClip', { scaleFloor: 1e-4 })
		const levels = new CalibrationPlaneLevels(mosaic ? 4 : 1, samples, mosaic)
		levels.push(output, width, height, 0)
		divideCalibrationPlanes(
			output,
			width,
			height,
			0,
			levels.levels().map(({ median }) => median),
			mosaic,
		)
		return output
	}

	test('removes frame brightness and keeps the vignette and dust structure', () => {
		const master = masterFlat(false)
		const reference = response(0) / master[0]

		for (let sample = 0; sample < samples; sample++) expect(response(sample) / master[sample]).toBeCloseTo(reference, 3)
		expect(master[27] / master[26]).toBeCloseTo(response(27) / response(26), 3)
	})

	test('normalizes each CFA phase on its own and preserves the mosaic', () => {
		const phaseGain = (sample: number) => [0.4, 1, 1, 0.6][((Math.trunc(sample / width) & 1) << 1) | ((sample % width) & 1)]
		const master = masterFlat(true, phaseGain)

		const levels = new CalibrationPlaneLevels(4, samples, true)
		levels.push(master, width, height, 0)
		for (const { median } of levels.levels()) expect(median).toBeCloseTo(1, 6)
		// The structure of one phase stays relative to that phase.
		expect(master[0]).toBeGreaterThan(master[2 * width + 2])
	})

	test('subtracting a master dark-flat removes pedestal and dark current exactly once', () => {
		const raw = Float64Array.from([1300, 2300])
		subtractCalibrationRows(raw, Float64Array.from([300, 300]), 2)
		expect(Array.from(raw)).toEqual([1000, 2000])
	})

	test('keeps negative corrected samples', () => {
		const raw = new Float32Array([90])
		subtractCalibrationRows(raw, new Float32Array([100]), 1)
		expect(raw[0]).toBe(-10)
	})
})

describe('calibration with an integrated master', () => {
	test('a calibrated normalized flat agrees with the raw flat branch of calibrate', () => {
		const flatValues = [0.42, 0.61, 0.37, 0.8]
		const pedestal = 0.02
		const corrected = flatValues.map((value) => value - pedestal)
		const mean = corrected.reduce((sum, value) => sum + value) / corrected.length
		const light = () => makeImage(2, 2, 1, [0.5, 0.45, 0.3, 0.7], { EXPTIME: 30 })
		const dark = makeImage(2, 2, 1, [0.03, 0.03, 0.04, 0.03], { EXPTIME: 30 })

		const raw = calibrate(light(), { dark, flat: makeImage(2, 2, 1, flatValues), bias: makeImage(2, 2, 1, [pedestal, pedestal, pedestal, pedestal]), darkScaling: 'none' })
		const master = calibrate(light(), {
			dark,
			flat: makeImage(
				2,
				2,
				1,
				corrected.map((value) => value / mean),
			),
			flatRepresentation: 'calibratedNormalized',
			darkScaling: 'none',
		})

		for (let i = 0; i < 4; i++) expect(master.raw[i]).toBeCloseTo(raw.raw[i], 5)
	})

	test('a calibrated normalized flat is never corrected again by a bias', () => {
		const light = makeImage(2, 1, 1, [0.5, 0.5])

		calibrate(light, { bias: makeImage(2, 1, 1, [0.1, 0.1]), flat: makeImage(2, 1, 1, [0.5, 2]), flatRepresentation: 'calibratedNormalized' })

		expect(light.raw[0]).toBeCloseTo(0.8, 6)
		expect(light.raw[1]).toBeCloseTo(0.2, 6)
	})

	test('a calibrated normalized flat refuses a dark-flat', () => {
		const flat = makeImage(1, 1, 1, [1])
		expect(() => calibrate(makeImage(1, 1, 1, [0.5]), { flat, darkFlat: makeImage(1, 1, 1, [0.1]), flatRepresentation: 'calibratedNormalized' })).toThrow('already includes')
	})

	test('an invalid flat response is rejected by default and passes through on request', () => {
		const flat = () => makeImage(2, 1, 1, [0, 2])

		expect(() => calibrate(makeImage(2, 1, 1, [0.5, 0.5]), { flat: flat(), flatRepresentation: 'calibratedNormalized' })).toThrow('finite and greater')

		const light = makeImage(2, 1, 1, [0.5, 0.5])
		calibrate(light, { flat: flat(), flatRepresentation: 'calibratedNormalized', invalidFlat: 'passthrough' })
		expect(light.raw[0]).toBe(0.5)
		expect(light.raw[1]).toBe(0.25)
	})

	test('a master in digital numbers calibrates a normalized light through its full scale', () => {
		const digital: DigitalImage = { sampleScale: 'digital', header: { EXPTIME: 30 }, metadata: makeImage(2, 1, 1, [0, 0]).metadata, raw: Float64Array.from([6553.5, 13107]) }
		const light = makeImage(2, 1, 1, [0.5, 0.5], { EXPTIME: 30 })

		calibrate(light, { dark: calibrationMasterImage(digital, 65535) })

		expect(light.raw[0]).toBeCloseTo(0.4, 6)
		expect(light.raw[1]).toBeCloseTo(0.3, 6)
	})
})
