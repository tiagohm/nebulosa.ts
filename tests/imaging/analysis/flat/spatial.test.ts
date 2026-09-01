import { expect, test } from 'bun:test'
import { analyzeFlat } from '../../../../src/imaging/analysis/flat/flat'
import { generateSyntheticFlatImage } from '../../../../src/imaging/synthetic/flat'

test('measures a uniform flat without inventing an illumination center', () => {
	const image = generateSyntheticFlatImage({ width: 96, height: 64, bias: 100, signal: 900, vignetting: 0 })
	const spatial = analyzeFlat({ frame: { image } }).planes[0].spatial

	expect(spatial.tiles.length).toBeGreaterThan(6)
	expect(spatial.uniformity).toBeCloseTo(1, 12)
	expect(spatial.centerLevel).toBeCloseTo(1000, 12)
	expect(spatial.edgeLevel).toBeCloseTo(1000, 12)
	expect(spatial.cornerLevel).toBeCloseTo(1000, 12)
	expect(spatial.edgeFalloff).toBeCloseTo(0, 12)
	expect(spatial.cornerFalloff).toBeCloseTo(0, 12)
	expect(spatial.gradient).toEqual({ x: 0, y: 0 })
	expect(spatial.model).toBeDefined()
	expect(spatial.illuminationCenter).toBeUndefined()
	expect(spatial.illuminationMap).toBeUndefined()
	expect(spatial.residualMap).toBeUndefined()
})

test('omits unsupported regional levels instead of exposing NaN', () => {
	const image = generateSyntheticFlatImage({ width: 16, height: 16, bias: 0, signal: 1000, vignetting: 0 })
	const spatial = analyzeFlat({ frame: { image } }).planes[0].spatial

	expect(spatial.uniformity).toBe(1)
	expect(spatial.centerLevel).toBeUndefined()
	expect(spatial.edgeLevel).toBeUndefined()
	expect(spatial.cornerLevel).toBeUndefined()
	expect(spatial.edgeFalloff).toBeUndefined()
	expect(spatial.cornerFalloff).toBeUndefined()
})

test('recovers signed gradients and leaves monotonic surfaces centerless', () => {
	const image = generateSyntheticFlatImage({ width: 97, height: 65, bias: 0, signal: 1000, vignetting: 0, gradient: { x: 0.2, y: -0.1 } })
	const spatial = analyzeFlat({ frame: { image } }).planes[0].spatial

	expect(spatial.gradient?.x).toBeCloseTo(0.2, 10)
	expect(spatial.gradient?.y).toBeCloseTo(-0.1, 10)
	expect(spatial.illuminationCenter).toBeUndefined()
})

test('locates a well-conditioned shifted quadratic illumination maximum', () => {
	const width = 121
	const height = 81
	const offset = { x: 0.2, y: -0.25 }
	const image = generateSyntheticFlatImage({ width, height, bias: 0, signal: 1000, vignetting: 0.35, centerOffset: offset })
	const spatial = analyzeFlat({ frame: { image } }).planes[0].spatial
	const expectedX = ((width - 1) * (1 + offset.x)) / 2
	const expectedY = ((height - 1) * (1 + offset.y)) / 2

	expect(spatial.model?.degree).toBe(2)
	expect(spatial.cornerFalloff).toBeGreaterThan(0)
	expect(spatial.illuminationCenter?.x).toBeCloseTo(expectedX, 2)
	expect(spatial.illuminationCenter?.y).toBeCloseTo(expectedY, 2)
	expect(spatial.illuminationCenterConfidence).toBeGreaterThan(0)
})

test('materializes requested full-area maps and marks CFA residual gaps', () => {
	const image = generateSyntheticFlatImage({ width: 64, height: 48, bayer: 'RGGB', bias: 0, signal: 1000, vignetting: 0.2 })
	const mask = new Uint8Array(image.metadata.pixelCount)
	mask[0] = 1
	image.raw[2] = Number.NaN
	const baseline = analyzeFlat({ frame: { image }, mask }, { planes: ['red'] }).planes[0].spatial
	const mapped = analyzeFlat({ frame: { image }, mask }, { planes: ['red'], maps: 'all' }).planes[0].spatial

	expect(mapped.uniformity).toBe(baseline.uniformity)
	expect(mapped.model?.coefficients).toEqual(baseline.model?.coefficients)
	expect(mapped.illuminationMap).toHaveLength(64 * 48)
	expect(mapped.residualMap).toHaveLength(64 * 48)
	expect(mapped.residualMapValidity).toHaveLength(64 * 48)
	expect(mapped.residualMapValidity?.[0]).toBe(0)
	expect(mapped.residualMapValidity?.[1]).toBe(0)
	expect(mapped.residualMapValidity?.[2]).toBe(0)
	expect(mapped.residualMapValidity?.[4]).toBe(1)
	expect(Array.from(mapped.illuminationMap!).every(Number.isFinite)).toBeTrue()
	expect(Array.from(mapped.residualMap!).every(Number.isFinite)).toBeTrue()
	expect(baseline.illuminationMap).toBeUndefined()
	expect(baseline.residualMap).toBeUndefined()
})

test('keeps corrected non-positive spatial data unavailable instead of falling back to observed levels', () => {
	const image = generateSyntheticFlatImage({ width: 64, height: 48, bias: 100, signal: 20, vignetting: 0.1 })
	const reference = generateSyntheticFlatImage({ width: 64, height: 48, bias: 130, signal: 0, vignetting: 0 })
	const result = analyzeFlat({ frame: { image }, reference: { kind: 'bias', image: reference } }, { maps: 'all' })
	const spatial = result.planes[0].spatial

	expect(spatial.basis).toBe('corrected')
	expect(spatial.model).toBeUndefined()
	expect(spatial.illuminationMap).toBeUndefined()
	expect(spatial.residualMap).toBeUndefined()
	expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'illuminationFitFailed')).toBeTrue()
})

test('rejects bilateral tile outliers from the smooth illumination model', () => {
	const image = generateSyntheticFlatImage({ width: 96, height: 96, bias: 0, signal: 1000, vignetting: 0.1 })
	for (let y = 8; y < 16; y++) {
		for (let x = 8; x < 16; x++) image.raw[y * 96 + x] *= 0.5
		for (let x = 72; x < 80; x++) image.raw[y * 96 + x] *= 1.5
	}
	const spatial = analyzeFlat({ frame: { image } }, { tile: { width: 8, height: 8 }, rejectionSigma: 3 }).planes[0].spatial

	expect(spatial.model).toBeDefined()
	expect(spatial.model!.rejectedSamples).toBeGreaterThanOrEqual(2)
})

test('lets a localized clipped tile fail a criterion hidden by the full-frame fraction', () => {
	const image = generateSyntheticFlatImage({ width: 64, height: 64, bias: 0, signal: 100, vignetting: 0 })
	for (let y = 0; y < 16; y++) for (let x = 0; x < 2; x++) image.raw[y * 64 + x] = 1000
	const result = analyzeFlat(
		{ frame: { image } },
		{
			tile: { width: 16, height: 16 },
			effectiveClip: { upper: 900 },
			criteria: { maximumClippedFraction: 0.05 },
		},
	)

	expect(result.planes[0].clipping.upper?.fraction).toBeCloseTo(32 / 4096, 12)
	expect(result.planes[0].spatial.tiles[0].clipping.upper?.fraction).toBeCloseTo(32 / 256, 12)
	expect(result.assessment.clipping).toMatchObject({ status: 'fail', value: 0.125 })
	expect(result.assessment.verdict).toBe('rejected')
})

test('covers supported non-divisible edges and discards only the undersupported corner', () => {
	const image = generateSyntheticFlatImage({ width: 35, height: 27, bias: 0, signal: 100, vignetting: 0 })
	const spatial = analyzeFlat({ frame: { image } }, { tile: { width: 8, height: 8 } }).planes[0].spatial

	expect(spatial.tiles).toHaveLength(19)
	expect(spatial.tiles.at(-1)?.area).toEqual({ left: 24, top: 24, right: 32, bottom: 27 })
})

test('retains local non-finite evidence when a tile has too few finite samples for fitting', () => {
	const image = generateSyntheticFlatImage({ width: 96, height: 96, bias: 0, signal: 100, vignetting: 0 })
	for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) image.raw[y * 96 + x] = Number.NaN

	const result = analyzeFlat({ frame: { image } }, { tile: { width: 32, height: 32 }, criteria: { maximumNonFiniteFraction: 0.2 } })

	expect(result.planes[0].spatial.tiles).toHaveLength(8)
	expect(result.assessment.finiteSamples).toMatchObject({ status: 'fail', value: 1 })
	expect(result.assessment.verdict).toBe('rejected')

	const mask = new Uint8Array(image.metadata.pixelCount)
	for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) mask[y * 96 + x] = 1
	const masked = analyzeFlat({ frame: { image }, mask }, { tile: { width: 32, height: 32 }, criteria: { maximumNonFiniteFraction: 0.2 } })
	expect(masked.assessment.finiteSamples).toMatchObject({ status: 'pass', value: 0 })
	expect(masked.assessment.verdict).toBe('accepted')
})

test('bounds explicit tile allocation before constructing tile objects', () => {
	const image = generateSyntheticFlatImage({ width: 257, height: 257, bias: 0, signal: 100, vignetting: 0 })
	expect(() => analyzeFlat({ frame: { image } }, { tile: { width: 1, height: 1 } })).toThrow('tile allocation limit')
})
