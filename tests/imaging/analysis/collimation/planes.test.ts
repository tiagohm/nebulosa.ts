import { expect, test } from 'bun:test'
import { analyzeCollimation } from '../../../../src/imaging/analysis/collimation/collimation'
import { generateSyntheticCollimationImage } from '../../../../src/imaging/synthetic/collimation'
import { collimationFixture } from '../../../collimation.util'

for (const bayer of ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG'] as const)
	for (let parity = 0; parity < 4; parity++)
		for (const plane of ['green1', 'green2'] as const)
			test(`${bayer} ${plane} crop parity ${parity} returns received-image coordinates`, () => {
				const base = collimationFixture()
				const left = parity & 1
				const top = parity >>> 1
				const fixture = {
					...base,
					width: 320,
					height: 320,
					bayer,
					outer: { ...base.outer, center: { x: 159.4, y: 160.2 }, semiMajor: 96, semiMinor: 96, softness: 1.5 },
					obstruction: { ...base.obstruction, center: { x: 163.4, y: 162.2 }, semiMajor: 40, semiMinor: 40, softness: 1.5 },
					signal: base.signal * 4,
					crop: { left, top, right: 319, bottom: 319 },
				}
				const image = generateSyntheticCollimationImage(fixture)
				const localPattern = image.metadata.bayer!
				const first = localPattern.indexOf('G')
				const slot = plane === 'green1' ? first : localPattern.indexOf('G', first + 1)
				const { width, height } = image.metadata
				for (let y = 0; y < height; y++)
					for (let x = 0; x < width; x++) {
						const index = y * width + x
						if ((x & 1) + 2 * (y & 1) !== slot) image.raw[index] = Number.NaN
						else image.raw[index] *= plane === 'green1' ? 0.8 : 0.4
					}
				const result = analyzeCollimation({ image, area: { left: 7, top: 9, right: width - 6, bottom: height - 8 } }, { plane })
				if (!result.success) throw new Error(result.reason)
				expect(result.plane).toBe(plane)
				expect(Math.hypot(result.outer.ellipse.center.x - (fixture.outer.center.x - left), result.outer.ellipse.center.y - (fixture.outer.center.y - top))).toBeLessThan(0.2)
				expect(Math.hypot(result.geometry.offset.x - 4, result.geometry.offset.y - 2)).toBeLessThan(0.4)
				expect(result.stability?.resolutionFloor).toBe(0.4)
				expect(result.quality.invalidFraction).toBe(0)
			})

for (const plane of ['red', 'green', 'blue'] as const)
	test(`RGB ${plane} ignores other channels and defaults to green`, () => {
		const image = generateSyntheticCollimationImage(collimationFixture({ channels: 3, channelWeights: [0.2, 0.5, 0.3] }))
		const channel = plane === 'red' ? 0 : plane === 'green' ? 1 : 2
		for (let i = 0; i < image.raw.length; i++) if (i % 3 !== channel) image.raw[i] = i % 2 ? Number.NaN : 5
		const result = analyzeCollimation({ image, area: { left: 0, top: 0, right: 160, bottom: 160 } }, { plane: plane === 'green' ? undefined : plane, saturationLevel: 1 })
		if (!result.success) throw new Error(result.reason)
		expect(result.plane).toBe(plane)
		expect(Math.hypot(result.geometry.offset.x - 2, result.geometry.offset.y - 1)).toBeLessThan(0.2)
		expect(result.quality.invalidFraction).toBe(0)
		expect(result.quality.saturatedFraction).toBe(0)
	})

test('anisotropic 2x1 binning transforms the vector and changes the normalized grid metric', () => {
	const base = collimationFixture()
	const original = { ...base, outer: { ...base.outer, center: { x: 80, y: 80 }, semiMajor: 40, semiMinor: 40 }, obstruction: { ...base.obstruction, center: { x: 84, y: 80 }, semiMajor: 16, semiMinor: 16 } }
	const fixture = { ...original, width: 80, signal: original.signal / 2, outer: { ...original.outer, center: { x: 40, y: 80 }, semiMajor: 20 }, obstruction: { ...original.obstruction, center: { x: 42, y: 80 }, semiMajor: 8 } }
	const image = generateSyntheticCollimationImage(fixture)
	const result = analyzeCollimation({ image, area: { left: 0, top: 0, right: 80, bottom: 160 }, center: fixture.obstruction.center })
	if (!result.success) throw new Error(result.reason)
	expect(result.geometry.offset.x).toBeCloseTo(2, 1)
	expect(result.geometry.offset.y).toBeCloseTo(0, 1)
	expect(result.geometry.normalizedDistance).toBeCloseTo(0.07071, 2)
	expect(result.stability).toBeUndefined()
})
