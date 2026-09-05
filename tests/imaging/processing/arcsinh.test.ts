import { expect, test } from 'bun:test'
import { approximateArcsinhStretchParameters, arcsinhStretch } from '../../../src/imaging/processing/arcsinh'
import { clone } from '../../../src/imaging/processing/arithmetic'
import { stf } from '../../../src/imaging/processing/stf'
import { makeImage, meanAbsoluteDifference } from './util'

test('approximateArcsinhStretchParameters returns identity for the default STF', () => {
	const parameters = approximateArcsinhStretchParameters()

	expect(parameters.stretchFactor).toBeCloseTo(1, 8)
	expect(parameters.blackPoint).toBeCloseTo(0, 8)
})

test('approximateArcsinhStretchParameters yields a close visual match to STF on a ramp', () => {
	const values = new Float32Array(257)

	for (let i = 0; i < values.length; i++) {
		values[i] = i / 256
	}

	const parameters = approximateArcsinhStretchParameters(0.18, 0.03, 0.97)
	const stfImage = makeImage(values.length, 1, 1, values)
	const arcsinhImage = makeImage(values.length, 1, 1, values)

	stf(stfImage, 0.18, 0.03, 0.97)
	arcsinhStretch(arcsinhImage, parameters)

	expect(parameters.blackPoint).toBeGreaterThanOrEqual(0)
	expect(parameters.blackPoint).toBeLessThanOrEqual(0.03)
	expect(parameters.stretchFactor).toBeGreaterThan(1)
	expect(meanAbsoluteDifference(stfImage, arcsinhImage)).toBeLessThan(0.025)
})

test('arcsinhStretch applies black point normalization on monochrome data', () => {
	const image = makeImage(3, 1, 1, [0.25, 0.5, 1])

	arcsinhStretch(image, { stretchFactor: 1, blackPoint: 0.25 })

	expect(image.raw[0]).toBeCloseTo(0, 8)
	expect(image.raw[1]).toBeCloseTo(1 / 3, 7)
	expect(image.raw[2]).toBeCloseTo(1, 8)
})

test('arcsinhStretch preserves RGB ratios above the black point', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.1, 0.05])

	arcsinhStretch(image, { stretchFactor: 12 })

	expect(image.raw[0] / image.raw[1]).toBeCloseTo(2, 6)
	expect(image.raw[1] / image.raw[2]).toBeCloseTo(2, 6)
})

test('arcsinhStretch protectHighlights rescales instead of clipping saturated channels', () => {
	const input = makeImage(1, 1, 3, [0.98, 0.25, 0.25])
	const unclipped = clone(input)
	const protectedImage = clone(input)

	arcsinhStretch(unclipped, { stretchFactor: 20, protectHighlights: false })
	arcsinhStretch(protectedImage, { stretchFactor: 20, protectHighlights: true })

	expect(unclipped.raw[0]).toBe(1)
	expect(protectedImage.raw[1]).toBeLessThan(unclipped.raw[1])
	expect(protectedImage.raw[0] / protectedImage.raw[1]).toBeCloseTo(input.raw[0] / input.raw[1], 6)
})

test('arcsinhStretch uses RGB working-space weights when requested', () => {
	const equalWeights = makeImage(1, 1, 3, [0.55, 0.1, 0.1])
	const workingSpace = makeImage(1, 1, 3, [0.55, 0.1, 0.1])

	arcsinhStretch(equalWeights, { stretchFactor: 8, useRgbWorkingSpace: false })
	arcsinhStretch(workingSpace, { stretchFactor: 8, useRgbWorkingSpace: true, rgbWorkingSpace: { red: 0.8, green: 0.1, blue: 0.1 } })

	expect(workingSpace.raw[0]).toBeLessThan(equalWeights.raw[0])
	expect(workingSpace.raw[1]).toBeLessThan(equalWeights.raw[1])
})
