import { expect, test } from 'bun:test'
import { analyzeFlat } from '../../../../src/imaging/analysis/flat/flat'
import { generateSyntheticFlatImage } from '../../../../src/imaging/synthetic/flat'

test('keeps static detrended profiles opt-in and reports robust row and column strength', () => {
	const image = generateSyntheticFlatImage({
		width: 128,
		height: 96,
		bias: 0,
		signal: 1000,
		vignetting: 0.15,
		rowBanding: { amplitude: 0.04, period: 16 },
		columnBanding: { amplitude: 0.03, period: 20 },
	})
	const baselineResult = analyzeFlat({ frame: { image } })
	const profiledResult = analyzeFlat({ frame: { image } }, { artifacts: { profiles: true } })
	const baseline = baselineResult.planes[0].spatial
	const profiled = profiledResult.planes[0].spatial

	expect(baseline.profiles).toBeUndefined()
	expect(baseline.dustCandidates).toBeUndefined()
	expect(profiled.residualMap).toBeUndefined()
	expect(profiled.profiles?.row.values).toHaveLength(96)
	expect(profiled.profiles?.column.values).toHaveLength(128)
	expect(profiled.profiles?.row.validity.every((value) => value === 1)).toBeTrue()
	expect(profiled.profiles?.column.validity.every((value) => value === 1)).toBeTrue()
	expect(profiled.profiles?.row.strength).toBeGreaterThan(0.03)
	expect(profiled.profiles?.column.strength).toBeGreaterThan(0.02)
	expect(Array.from(profiled.profiles!.row.values).every(Number.isFinite)).toBeTrue()
	expect(profiledResult.assessment).toEqual(baselineResult.assessment)

	const mask = new Uint8Array(128 * 96)
	mask.fill(1, 0, 128)
	const masked = analyzeFlat({ frame: { image }, mask }, { artifacts: { profiles: true } }).planes[0].spatial.profiles!
	expect(masked.row.validity[0]).toBe(0)
	expect(masked.row.values[0]).toBe(0)
	expect(Array.from(masked.row.values).every(Number.isFinite)).toBeTrue()
})

test('finds circular and elliptical smooth-depression candidates without assigning a cause', () => {
	const image = generateSyntheticFlatImage({
		width: 256,
		height: 192,
		bias: 0,
		signal: 1000,
		vignetting: 0.2,
		dustMotes: [
			{ center: { x: 80, y: 80 }, sigmaX: 7, sigmaY: 7, contrast: 0.25 },
			{ center: { x: 180, y: 110 }, sigmaX: 12, sigmaY: 5, angle: 0.5, contrast: 0.2 },
		],
	})
	const baseline = analyzeFlat({ frame: { image } })
	const detected = analyzeFlat({ frame: { image } }, { artifacts: { dust: true } })
	const spatial = detected.planes[0].spatial
	const candidates = spatial.dustCandidates!
	const circular = candidates.find((candidate) => Math.hypot(candidate.center.x - 80, candidate.center.y - 80) < 2)
	const elliptical = candidates.find((candidate) => Math.hypot(candidate.center.x - 180, candidate.center.y - 110) < 2)

	expect(candidates).toHaveLength(2)
	expect(circular).toBeDefined()
	expect(circular!.contrast).toBeGreaterThan(0.2)
	expect(circular!.semiMajor / circular!.semiMinor).toBeLessThan(1.1)
	expect(elliptical).toBeDefined()
	expect(elliptical!.semiMajor / elliptical!.semiMinor).toBeGreaterThan(2)
	expect(elliptical!.angle).toBeCloseTo(0.5, 1)
	expect(spatial.residualMap).toBeUndefined()
	expect(spatial.residualMapValidity).toBeUndefined()
	expect(detected.assessment).toEqual(baseline.assessment)
	const strongest = analyzeFlat({ frame: { image } }, { artifacts: { dust: { maximumCandidates: 1 } } }).planes[0].spatial.dustCandidates!
	expect(strongest).toHaveLength(1)
	expect(Math.hypot(strongest[0].center.x - 80, strongest[0].center.y - 80)).toBeLessThan(2)
})

test('retains multiscale support for small, large, and overlapping depressions', () => {
	const image = generateSyntheticFlatImage({
		width: 320,
		height: 240,
		bias: 0,
		signal: 1000,
		vignetting: 0.1,
		dustMotes: [
			{ center: { x: 80, y: 80 }, sigmaX: 3, sigmaY: 3, contrast: 0.3 },
			{ center: { x: 220, y: 140 }, sigmaX: 20, sigmaY: 15, contrast: 0.2 },
			{ center: { x: 150, y: 170 }, sigmaX: 9, sigmaY: 9, contrast: 0.2 },
			{ center: { x: 160, y: 170 }, sigmaX: 9, sigmaY: 9, contrast: 0.2 },
		],
	})
	const candidates = analyzeFlat({ frame: { image } }, { artifacts: { dust: { scales: [1, 4, 12], minimumContrast: 0.05 } } }).planes[0].spatial.dustCandidates!

	expect(candidates).toHaveLength(3)
	expect(candidates.some((candidate) => Math.hypot(candidate.center.x - 80, candidate.center.y - 80) < 2)).toBeTrue()
	expect(candidates.some((candidate) => Math.hypot(candidate.center.x - 220, candidate.center.y - 140) < 3)).toBeTrue()
	expect(candidates.some((candidate) => Math.hypot(candidate.center.x - 155, candidate.center.y - 170) < 3)).toBeTrue()
})

test('rejects isolated pixels, lines, and border-truncated depressions', () => {
	const hotPixel = generateSyntheticFlatImage({ width: 256, height: 192, bias: 0, signal: 1000, vignetting: 0.1 })
	hotPixel.raw[96 * 256 + 128] = 0
	expect(analyzeFlat({ frame: { image: hotPixel } }, { artifacts: { dust: true } }).planes[0].spatial.dustCandidates).toEqual([])

	const line = generateSyntheticFlatImage({ width: 256, height: 192, bias: 0, signal: 1000, vignetting: 0.1 })
	for (let x = 20; x < 236; x++) line.raw[96 * 256 + x] = 700
	expect(analyzeFlat({ frame: { image: line } }, { artifacts: { dust: true } }).planes[0].spatial.dustCandidates).toEqual([])

	const border = generateSyntheticFlatImage({ width: 256, height: 192, bias: 0, signal: 1000, vignetting: 0.1, dustMotes: [{ center: { x: 5, y: 80 }, sigmaX: 7, sigmaY: 7, contrast: 0.3 }] })
	expect(analyzeFlat({ frame: { image: border } }, { artifacts: { dust: true } }).planes[0].spatial.dustCandidates).toEqual([])
})

test('reports anisotropically binned candidate axes in output image pixels', () => {
	const image = generateSyntheticFlatImage({
		width: 128,
		height: 192,
		bias: 0,
		signal: 1000,
		vignetting: 0.1,
		sensor: { width: 512, height: 384, binning: [4, 2] },
		dustMotes: [{ center: { x: 256, y: 192 }, sigmaX: 40, sigmaY: 40, contrast: 0.25 }],
	})
	const candidate = analyzeFlat({ frame: { image } }, { artifacts: { dust: true } }).planes[0].spatial.dustCandidates?.[0]

	expect(candidate).toBeDefined()
	expect(candidate!.center.x).toBeCloseTo(63.6, 0)
	expect(candidate!.center.y).toBeCloseTo(95.7, 0)
	expect(candidate!.semiMajor / candidate!.semiMinor).toBeGreaterThan(2)
	expect(candidate!.angle).toBeCloseTo(Math.PI / 2, 1)
})

test('uses the selected CFA grid while preserving candidate image coordinates', () => {
	const image = generateSyntheticFlatImage({
		width: 256,
		height: 192,
		bayer: 'RGGB',
		bias: 0,
		signal: 1000,
		vignetting: 0.1,
		dustMotes: [{ center: { x: 120, y: 90 }, sigmaX: 10, sigmaY: 7, contrast: 0.25 }],
	})
	const spatial = analyzeFlat({ frame: { image } }, { area: { left: 32, top: 24, right: 224, bottom: 168 }, planes: ['red'], artifacts: { profiles: true, dust: true } }).planes[0].spatial
	const candidate = spatial.dustCandidates?.[0]

	expect(spatial.profiles?.row.values).toHaveLength(72)
	expect(spatial.profiles?.column.values).toHaveLength(96)
	expect(candidate?.center.x).toBeCloseTo(120, 0)
	expect(candidate?.center.y).toBeCloseTo(90, 0)
})

test('validates optional artifact policy before allocating residual work', () => {
	const image = generateSyntheticFlatImage({ width: 64, height: 48, bias: 0, signal: 1000, vignetting: 0 })
	expect(() => analyzeFlat({ frame: { image } }, { artifacts: { dust: { scales: [1, 1, 2] } } })).toThrow('strictly increasing')
	expect(() => analyzeFlat({ frame: { image } }, { artifacts: { dust: { minimumContrast: 0 } } })).toThrow('minimum contrast')
	expect(() => analyzeFlat({ frame: { image } }, { artifacts: { dust: { minimumArea: 0 } } })).toThrow('minimum area')
	expect(() => analyzeFlat({ frame: { image } }, { artifacts: { dust: { maximumCandidates: 100000 } } })).toThrow('maximum candidates')
})
