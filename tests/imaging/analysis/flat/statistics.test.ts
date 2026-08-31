import { expect, test } from 'bun:test'
import { analyzeFlat } from '../../../../src/imaging/analysis/flat/flat'
import { ROBUST_SAMPLE_CAPACITY } from '../../../../src/imaging/analysis/robust'
import { generateSyntheticFlatImage } from '../../../../src/imaging/synthetic/flat'

test('computes exact mean, median, and MAD for a small constant flat', () => {
	const image = generateSyntheticFlatImage({ width: 4, height: 3, bias: 100, signal: 900, vignetting: 0 })
	const result = analyzeFlat({ frame: { image } })
	const statistics = result.planes[0].observed

	expect(statistics).toEqual({ count: 12, masked: 0, nonFinite: 0, minimum: 1000, maximum: 1000, mean: 1000, median: 1000, mad: 0, retainedSamples: 12, approximate: false })
	expect(result.planes[0].spatial).toEqual({ basis: 'observed', tiles: [] })
	expect(result.assessment.verdict).toBe('inconclusive')
})

test('keeps masked and non-finite counts disjoint', () => {
	const image = generateSyntheticFlatImage({ width: 3, height: 2, bias: 0, signal: 100, vignetting: 0 })
	image.raw[1] = Number.NaN
	const mask = new Uint8Array(6)
	mask[0] = 1
	const result = analyzeFlat({ frame: { image }, mask }, { criteria: { maximumNonFiniteFraction: 0.1 } })
	const statistics = result.planes[0].observed

	expect(statistics).toMatchObject({ count: 4, masked: 1, nonFinite: 1 })
	expect(result.assessment.finiteSamples).toMatchObject({ status: 'fail', value: 0.2 })
	expect(result.assessment.verdict).toBe('rejected')
})

test('subtracts a compatible reference in line without changing observed statistics', () => {
	const image = generateSyntheticFlatImage({ width: 3, height: 2, bias: 100, signal: 900, vignetting: 0 })
	const bias = generateSyntheticFlatImage({ width: 3, height: 2, bias: 100, signal: 0, vignetting: 0 })
	const result = analyzeFlat({ frame: { image }, reference: { kind: 'bias', image: bias } }, { criteria: { targets: { mono: { levelMode: 'corrected', range: [850, 950] } } } })

	expect(result.planes[0].observed.median).toBe(1000)
	expect(result.planes[0].corrected?.median).toBe(900)
	expect(result.planes[0].target.status).toBe('pass')
	expect(result.assessment.verdict).toBe('accepted')
})

test('bounds robust samples and marks large-image quantiles approximate', () => {
	const image = generateSyntheticFlatImage({ width: ROBUST_SAMPLE_CAPACITY + 1, height: 1, bias: 0, signal: 10, vignetting: 0 })
	const statistics = analyzeFlat({ frame: { image } }).planes[0].observed
	expect(statistics.count).toBe(ROBUST_SAMPLE_CAPACITY + 1)
	expect(statistics.retainedSamples).toBe(ROBUST_SAMPLE_CAPACITY)
	expect(statistics.approximate).toBeTrue()
})

test('omits numerical reductions instead of returning NaN for unsupported samples', () => {
	const image = generateSyntheticFlatImage({ width: 2, height: 2, bias: 0, signal: 1, vignetting: 0 })
	image.raw.fill(Number.NaN)
	const result = analyzeFlat({ frame: { image } }, { criteria: { maximumNonFiniteFraction: 1 } })
	const statistics = result.planes[0].observed

	expect(statistics).toEqual({ count: 0, masked: 0, nonFinite: 4, retainedSamples: 0, approximate: false })
	expect(result.assessment.finiteSamples.status).toBe('unknown')
	expect(result.assessment.verdict).toBe('inconclusive')
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'insufficientSamples')).toBeTrue()
})
