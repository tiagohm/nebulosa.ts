import { expect, test } from 'bun:test'
import { analyzeFlat } from '../../../../src/imaging/analysis/flat/flat'
import { generateSyntheticFlatImage } from '../../../../src/imaging/synthetic/flat'

test('distinguishes effective clipping from inconclusive storage endpoints', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bias: 0, signal: 1000, vignetting: 0, lowerClip: 0, upperClip: 65535 })
	const storageOnly = analyzeFlat({ frame: { image } }, { criteria: { maximumClippedFraction: 0 } })
	expect(storageOnly.planes[0].clipping.lower).toMatchObject({ source: 'storage', status: 'unknown', count: 0 })
	expect(storageOnly.planes[0].clipping.upper).toMatchObject({ source: 'storage', status: 'unknown', count: 0 })
	expect(storageOnly.assessment.clipping.status).toBe('unknown')

	const effective = analyzeFlat({ frame: { image } }, { effectiveClip: { upper: 4095 }, criteria: { maximumClippedFraction: 0 } })
	expect(effective.planes[0].clipping.upper).toMatchObject({ source: 'effective', status: 'absent', count: 0 })
	expect(effective.assessment.clipping.status).toBe('pass')

	image.raw[0] = 4095
	const clipped = analyzeFlat({ frame: { image } }, { effectiveClip: { upper: 4095 }, criteria: { maximumClippedFraction: 0 } })
	expect(clipped.planes[0].clipping.upper).toMatchObject({ source: 'effective', status: 'present', count: 1, fraction: 0.25 })
	expect(clipped.assessment.verdict).toBe('rejected')

	image.raw[0] = 65535
	const storageClipped = analyzeFlat(
		{ frame: { image } },
		{
			criteria: {
				maximumClippedFraction: 0,
				targets: { mono: { levelMode: 'corrected', range: [900, 1100] } },
			},
		},
	)
	expect(storageClipped.planes[0].clipping.upper).toMatchObject({ source: 'storage', status: 'present', count: 1 })
	expect(storageClipped.assessment.target.status).toBe('unknown')
	expect(storageClipped.assessment.verdict).toBe('rejected')
})

test('evaluates RGB targets independently without hiding weak channels', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, channels: 3, bias: 0, signal: 100, vignetting: 0, channelResponse: [1, 0.5, 0.25] })
	const result = analyzeFlat(
		{ frame: { image } },
		{
			criteria: {
				targets: {
					red: { levelMode: 'observed', range: [90, 110] },
					green: { levelMode: 'observed', range: [90, 110] },
					blue: { levelMode: 'observed', range: [90, 110] },
				},
			},
		},
	)

	expect(result.planes.map((plane) => [plane.plane, plane.observed.median, plane.target.status])).toEqual([
		['red', 100, 'pass'],
		['green', 50, 'fail'],
		['blue', 25, 'fail'],
	])
	expect(result.assessment.target.status).toBe('fail')
	expect(result.assessment.verdict).toBe('rejected')
})

test('uses targetArea for signal but the full area for clipping', () => {
	const image = generateSyntheticFlatImage({ width: 3, height: 3, bias: 0, signal: 100, vignetting: 0 })
	image.raw[0] = 1000
	const result = analyzeFlat(
		{ frame: { image } },
		{
			targetArea: { left: 1, top: 1, right: 2, bottom: 2 },
			effectiveClip: { upper: 900 },
			criteria: { targets: { mono: { levelMode: 'observed', range: [90, 110] } }, maximumClippedFraction: 0 },
		},
	)

	expect(result.planes[0].observed).toMatchObject({ count: 1, median: 100 })
	expect(result.planes[0].target.status).toBe('pass')
	expect(result.planes[0].clipping.upper).toMatchObject({ count: 1, fraction: 1 / 9 })
	expect(result.assessment.verdict).toBe('rejected')
})

test('preserves local CFA phase and separate green planes through analysis', () => {
	const image = generateSyntheticFlatImage({
		width: 2,
		height: 2,
		bayer: 'RGGB',
		bias: 0,
		signal: 100,
		vignetting: 0,
		channelResponse: [1, 0.5, 0.25],
		sensor: { width: 4, height: 4, origin: { x: 1, y: 1 } },
	})
	const result = analyzeFlat({ frame: { image } })
	expect(result.planes.map((plane) => [plane.plane, plane.observed.median])).toEqual([
		['red', 100],
		['green1', 50],
		['green2', 50],
		['blue', 25],
	])
})

test('requires corrected targets to have a reference', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bias: 100, signal: 900, vignetting: 0 })
	const result = analyzeFlat({ frame: { image } }, { criteria: { targets: { mono: { levelMode: 'corrected', range: [850, 950] } } } })
	expect(result.planes[0].target.status).toBe('unknown')
	expect(result.assessment.verdict).toBe('inconclusive')
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'targetUnavailable')).toBeTrue()
})

test('rejects incompatible references and never scales a dark-flat', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bias: 100, signal: 900, vignetting: 0 })
	const wrongSize = generateSyntheticFlatImage({ width: 3, height: 2, bias: 100, signal: 0, vignetting: 0 })
	expect(() => analyzeFlat({ frame: { image }, reference: { kind: 'bias', image: wrongSize } })).toThrow('geometry')

	const darkFlat = generateSyntheticFlatImage({ width: 2, height: 2, bias: 100, signal: 0, vignetting: 0 })
	expect(() => analyzeFlat({ frame: { image, exposure: 1 }, reference: { kind: 'darkFlat', image: darkFlat, exposure: 2 } })).toThrow('without scaling')
	const matched = analyzeFlat({ frame: { image, exposure: 1 }, reference: { kind: 'darkFlat', image: darkFlat, exposure: 1 } })
	expect(matched.planes[0].corrected?.median).toBe(900)
	const rounded = analyzeFlat({ frame: { image, exposure: 0.008808594 }, reference: { kind: 'darkFlat', image: darkFlat, exposure: 0.008808 } })
	expect(rounded.planes[0].corrected?.median).toBe(900)

	const ranged = generateSyntheticFlatImage({ width: 2, height: 2, bias: 100, signal: 900, vignetting: 0, lowerClip: 0, upperClip: 65535 })
	const otherRange = generateSyntheticFlatImage({ width: 2, height: 2, bias: 100, signal: 0, vignetting: 0, lowerClip: 0, upperClip: 4095 })
	expect(() => analyzeFlat({ frame: { image: ranged }, reference: { kind: 'bias', image: otherRange } })).toThrow('digital range')
})

test('validates masks, regions, planes, and target versus effective clipping', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bias: 0, signal: 100, vignetting: 0 })
	expect(() => analyzeFlat({ frame: { image }, mask: new Uint8Array(3) })).toThrow('mask length')
	expect(() => analyzeFlat({ frame: { image } }, { targetArea: { left: 0, top: 0, right: 3, bottom: 2 } })).toThrow(RangeError)
	expect(() => analyzeFlat({ frame: { image } }, { planes: ['red'] })).toThrow('incompatible')
	expect(() => analyzeFlat({ frame: { image } }, { effectiveClip: { upper: 100 }, criteria: { targets: { mono: { levelMode: 'observed', range: [50, 100] } } } })).toThrow('below the effective upper clip')

	const ranged = generateSyntheticFlatImage({ width: 2, height: 2, bias: 0, signal: 100, vignetting: 0, lowerClip: 0, upperClip: 4095 })
	expect(() => analyzeFlat({ frame: { image: ranged } }, { effectiveClip: { upper: 65535 } })).toThrow('inside the storage range')
})
