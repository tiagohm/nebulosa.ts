import { expect, test } from 'bun:test'
import { analyzeFlat } from '../../../../src/imaging/analysis/flat/flat'
import { readImageFromPath } from '../../../../src/imaging/model/image'
import { exposureTimeKeyword } from '../../../../src/io/formats/fits/util'
import { download } from '../../../download'

await Promise.all([download('FLAT.fit'), download('BIAS.fit'), download('DARKFLAT.fit')])

test('analyzes the real flat, bias, and rounded-exposure dark-flat fixtures in digital scale', async () => {
	const [flat, bias, darkFlat] = await Promise.all([readImageFromPath('data/FLAT.fit', { sampleScale: 'digital' }), readImageFromPath('data/BIAS.fit', { sampleScale: 'digital' }), readImageFromPath('data/DARKFLAT.fit', { sampleScale: 'digital' })])
	expect(flat).toBeDefined()
	expect(bias).toBeDefined()
	expect(darkFlat).toBeDefined()
	expect(flat!.sampleScale).toBe('digital')
	expect(flat!.metadata.bayer).toBeUndefined()
	expect([bias!.metadata.width, bias!.metadata.height]).toEqual([flat!.metadata.width, flat!.metadata.height])
	expect([darkFlat!.metadata.width, darkFlat!.metadata.height]).toEqual([flat!.metadata.width, flat!.metadata.height])

	const biasCorrected = analyzeFlat({ frame: { image: flat! }, reference: { kind: 'bias', image: bias! } }, { artifacts: { profiles: true } })
	const darkExposure = exposureTimeKeyword(darkFlat!.header, undefined)
	expect(darkExposure).toBeDefined()
	const darkCorrected = analyzeFlat({ frame: { image: flat! }, reference: { kind: 'darkFlat', image: darkFlat!, exposure: darkExposure! } })
	for (const result of [biasCorrected, darkCorrected]) {
		const plane = result.planes[0]
		expect(plane.plane).toBe('mono')
		expect(plane.observed.median).toBeGreaterThan(plane.corrected!.median!)
		expect(plane.corrected!.median).toBeGreaterThan(0)
		expect(plane.spatial.uniformity).toBeGreaterThan(0)
		expect(plane.spatial.uniformity).toBeLessThanOrEqual(1)
		expect(plane.spatial.model?.coefficients.every(Number.isFinite)).toBeTrue()
	}
	expect(biasCorrected.planes[0].spatial.profiles?.row.strength).toBeFinite()
	expect(biasCorrected.planes[0].spatial.profiles?.column.strength).toBeFinite()
}, 15_000)
