import { expect, test } from 'bun:test'
import { plotBahtinovSpikes } from '../../../src/imaging/stars/bahtinov'
import { colorIndexToRgbWeights } from '../../../src/imaging/stars/generator'

test('plotBahtinovSpikes adds only diffraction signal to an existing mono buffer', () => {
	const width = 101
	const height = 101
	const baseline = 0.125
	const raw = new Float64Array(width * height)
	raw.fill(baseline)

	expect(plotBahtinovSpikes(raw, width, height, 1, 50, 50, 300, 0, undefined, { halfLength: 30, taperLength: 5 })).toBeTrue()
	expect(raw.some((sample) => sample > baseline)).toBeTrue()
	expect(raw.every((sample) => sample >= baseline && Number.isFinite(sample))).toBeTrue()
	expect(raw[0]).toBe(baseline)
})

test('plotBahtinovSpikes encodes the requested signed central-line error', () => {
	for (const error of [-4, 0, 3]) {
		const width = 101
		const height = 101
		const raw = new Float64Array(width * height)
		expect(
			plotBahtinovSpikes(raw, width, height, 1, 50, 50, 100, error, undefined, {
				normalAngles: [Math.PI / 4, 0, (Math.PI * 3) / 4],
				central: 1,
				fwhm: 1.5,
				halfLength: 25,
				taperLength: 5,
				strengths: [0, 1, 0],
			}),
		).toBeTrue()

		let weightedX = 0
		let total = 0
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const sample = raw[y * width + x]
				weightedX += x * sample
				total += sample
			}
		}
		const measuredDistance = weightedX / total
		const measuredError = 50 - measuredDistance
		expect(measuredError).toBeCloseTo(error, 12)
	}
})

test('plotBahtinovSpikes does not renormalize a spike clipped along its length', () => {
	const options = {
		normalAngles: [Math.PI / 4, 0, (Math.PI * 3) / 4] as const,
		central: 1 as const,
		fwhm: 2,
		halfLength: 30,
		taperLength: 5,
		strengths: [0, 1, 0] as const,
	}
	const centered = new Float64Array(101 * 101)
	const clipped = new Float64Array(101 * 101)
	expect(plotBahtinovSpikes(centered, 101, 101, 1, 50, 50, 100, 0, undefined, options)).toBeTrue()
	expect(plotBahtinovSpikes(clipped, 101, 101, 1, 50, 5, 100, 0, undefined, options)).toBeTrue()
	expect(Math.max(...clipped)).toBeCloseTo(Math.max(...centered), 14)
	expect(clipped.reduce((sum, sample) => sum + sample, 0)).toBeLessThan(centered.reduce((sum, sample) => sum + sample, 0))
})

test('plotBahtinovSpikes applies the same RGB color weights as plotStar', () => {
	const raw = new Float32Array(51 * 51 * 3)
	const colorIndex = 1.2
	expect(plotBahtinovSpikes(raw, 51, 51, 3, 25, 25, 100, 0, colorIndex, { halfLength: 15, taperLength: 3 })).toBeTrue()
	const [red, green, blue] = colorIndexToRgbWeights(colorIndex)
	let redFlux = 0
	let greenFlux = 0
	let blueFlux = 0
	for (let index = 0; index < raw.length; index += 3) {
		redFlux += raw[index]
		greenFlux += raw[index + 1]
		blueFlux += raw[index + 2]
	}
	const total = redFlux + greenFlux + blueFlux
	expect(redFlux / total).toBeCloseTo(red, 6)
	expect(greenFlux / total).toBeCloseTo(green, 6)
	expect(blueFlux / total).toBeCloseTo(blue, 6)
})

test('plotBahtinovSpikes rejects invalid options without adding image effects', () => {
	const raw = new Float32Array(25)
	expect(plotBahtinovSpikes(raw, 5, 5, 1, 2, 2, 0, 0)).toBeFalse()
	expect(plotBahtinovSpikes(raw, 5, 5, 1, Number.NaN, 2, 10, 0)).toBeFalse()
	expect(() => plotBahtinovSpikes(raw, 5, 5, 1, 2, 2, 10, Number.NaN)).toThrow(RangeError)
	expect(() => plotBahtinovSpikes(raw, 5, 5, 1, 2, 2, 10, 0, undefined, { strengths: [0, 0, 0] })).toThrow(RangeError)
	expect(Array.from(raw)).toEqual(new Array(25).fill(0))
})
