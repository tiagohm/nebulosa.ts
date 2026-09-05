import { expect, test } from 'bun:test'
import { analyzeCollimation } from '../../../../src/imaging/analysis/collimation/collimation'
import { createCollimationWorkspace } from '../../../../src/imaging/analysis/collimation/preprocess'
import { summarizeCollimationSequence } from '../../../../src/imaging/analysis/collimation/sequence'
import type { CollimationAnalysis, CollimationAnalysisSuccess, CollimationSequence, CollimationSequenceSuccess } from '../../../../src/imaging/analysis/collimation/types'
import type { ImageAnalysisPlane } from '../../../../src/imaging/analysis/plane'
import { generateSyntheticCollimationImage } from '../../../../src/imaging/synthetic/collimation'
import { collimationFixture } from '../../../collimation.util'

function measurement(x: number, y: number, radius = 50, floor = 0.2, plane: ImageAnalysisPlane = 'mono'): CollimationAnalysisSuccess {
	return {
		success: true,
		area: { left: 0, top: 0, right: 160, bottom: 160 },
		plane,
		outer: { ellipse: { center: { x: 80, y: 80 }, semiMajor: radius, semiMinor: radius, theta: 0 }, equivalentRadius: radius, rms: 0.01, coverage: 1, maximumGap: 0, sectors: 360 },
		obstruction: { ellipse: { center: { x: 80 + x, y: 80 + y }, semiMajor: 20, semiMinor: 20, theta: 0 }, equivalentRadius: 20, rms: 0.01, coverage: 1, maximumGap: 0, sectors: 360 },
		geometry: { offset: { x, y }, distance: Math.hypot(x, y), normalizedDistance: Math.hypot(x, y) / radius, obstructionRatio: 20 / radius },
		quality: { background: 0.1, backgroundNoise: 0.001, signal: 0.6, signalToNoise: 600, invalidFraction: 0, field: 'unknown' },
		stability: { offsetSpread: 0.01, normalizedOffsetSpread: 0.01 / radius, resolutionFloor: floor },
		diagnostics: ['fieldReferenceMissing', 'saturationUnknown'],
	}
}

function success(result: CollimationSequence): CollimationSequenceSuccess {
	if (!result.success) throw new Error(result.reason)
	return result
}

for (const count of [0, 1, 4])
	test(`does not fabricate a summary from ${count} usable frames`, () => {
		const result = summarizeCollimationSequence(Array.from({ length: count }, () => measurement(0, 0)))
		expect(result).toMatchObject({ success: false, reason: 'insufficientFrames', usableCount: count })
		expect(result.entries).toHaveLength(count)
		expect('offset' in result).toBeFalse()
	})

test('retains all failure records when no frame is measurable', () => {
	const input: CollimationAnalysis[] = Array.from({ length: 5 }, () => ({ success: false, reason: 'patternNotFound', area: { left: 0, top: 0, right: 160, bottom: 160 }, diagnostics: [] }))
	const result = summarizeCollimationSequence(input)
	expect(result).toMatchObject({ success: false, reason: 'insufficientFrames', usableCount: 0 })
	expect(result.entries).toEqual(input.map((_, index) => ({ index, usable: false, reason: 'analysisFailed', analysisReason: 'patternNotFound' })))
	expect('offset' in result).toBeFalse()
})

test('preserves original exclusion reasons and ignores incompatible excluded frames', () => {
	const usable = Array.from({ length: 5 }, () => measurement(2, 1))
	const excluded = measurement(15, 0, 80, 0.4, 'green1')
	const input: CollimationAnalysis[] = [usable[0], { success: false, reason: 'cropped', area: usable[0].area, diagnostics: [] }, usable[1], { ...excluded, stability: undefined }, usable[2], { ...excluded, quality: { ...excluded.quality, field: 'outsideReference' } }, usable[3], usable[4]]
	const result = success(summarizeCollimationSequence(input))
	expect(result.usableCount).toBe(5)
	expect(result.offset).toEqual({ x: 2, y: 1 })
	expect(result.referenceRadius).toBe(50)
	expect(result.resolutionFloor).toBe(0.2)
	expect(result.entries).toEqual([
		{ index: 0, usable: true },
		{ index: 1, usable: false, reason: 'analysisFailed', analysisReason: 'cropped' },
		{ index: 2, usable: true },
		{ index: 3, usable: false, reason: 'stabilityUnavailable' },
		{ index: 4, usable: true },
		{ index: 5, usable: false, reason: 'outsideFieldReference' },
		{ index: 6, usable: true },
		{ index: 7, usable: true },
	])
	expect(summarizeCollimationSequence(input.slice(0, -1))).toMatchObject({ success: false, reason: 'insufficientFrames', usableCount: 4 })
})

test('rejects different selected planes without concealing individual eligibility', () => {
	const input = Array.from({ length: 5 }, () => measurement(2, 1))
	input[4] = measurement(2, 1, 50, 0.2, 'green')
	const result = summarizeCollimationSequence(input)
	expect(result).toMatchObject({ success: false, reason: 'incompatibleMeasurements', usableCount: 5 })
	expect(result.entries.every((entry) => entry.usable)).toBeTrue()
	expect('offset' in result).toBeFalse()
})

test('enforces five percent radius compatibility and exposes the common normalization', () => {
	const radii = [47.5, 50, 50, 50, 52.5]
	const input = radii.map((radius) => measurement(2, 1, radius))
	const result = success(summarizeCollimationSequence(input))
	expect(result.referenceRadius).toBe(50)
	expect(result.normalizedOffset).toEqual({ x: 0.04, y: 0.02 })
	expect(result.normalizedDistance).toBeCloseTo(Math.sqrt(5) / 50, 14)
	input[4] = measurement(2, 1, 52.5001)
	expect(summarizeCollimationSequence(input)).toMatchObject({ success: false, reason: 'incompatibleMeasurements' })
	input[4] = measurement(2, 1, 47.4999)
	expect(summarizeCollimationSequence(input)).toMatchObject({ success: false, reason: 'incompatibleMeasurements' })
})

test('coincident offsets retain a resolution floor and optional direction', () => {
	const input = Array.from({ length: 5 }, (_, i) => measurement(2, -1, 50, i === 4 ? 0.4 : 0.2))
	const result = success(summarizeCollimationSequence(input))
	expect(result.offset).toEqual({ x: 2, y: -1 })
	expect(result.dispersion).toBe(0)
	expect(result.resolutionFloor).toBe(0.4)
	expect(result.direction).toBeCloseTo(2 * Math.PI - Math.atan(0.5), 14)
	expect(result.dispersionExceedsTolerance).toBeUndefined()
	expect(success(summarizeCollimationSequence(input, { tolerance: 0 })).dispersionExceedsTolerance).toBeFalse()
	const unresolved = success(summarizeCollimationSequence(Array.from({ length: 5 }, () => measurement(0.5, 0))))
	expect(unresolved.direction).toBeUndefined()
})

test('opposed vectors cancel without hiding dispersion or manufacturing angular agreement', () => {
	const input = [-3, -3, -3, 3, 3, 3].map((x) => measurement(x, 0))
	const result = success(summarizeCollimationSequence(input, { tolerance: 0.05 }))
	expect(result.offset).toEqual({ x: 0, y: 0 })
	expect(result.dispersion).toBe(3)
	expect(result.normalizedDispersion).toBeCloseTo(0.06, 14)
	expect(result.direction).toBeUndefined()
	expect(result.usableCount).toBe(6)
	expect(result.dispersionExceedsTolerance).toBeTrue()
	expect(success(summarizeCollimationSequence(input, { tolerance: 0.06 })).dispersionExceedsTolerance).toBeFalse()
	expect(success(summarizeCollimationSequence([...input, ...input])).dispersion).toBe(3)
})

test('moves off a coincident initializer that is not the geometric median', () => {
	// For [(0,0), (2,0) twice, (0,2) twice], symmetry and the distance derivative give t = 1 - 1/sqrt(15).
	const input = [
		[0, 0],
		[2, 0],
		[2, 0],
		[0, 2],
		[0, 2],
	].map(([x, y]) => measurement(x, y))
	const result = success(summarizeCollimationSequence(input))
	const t = 1 - 1 / Math.sqrt(15)
	expect(result.offset.x).toBeCloseTo(t, 7)
	expect(result.offset.y).toBeCloseTo(t, 7)
	expect(result.dispersion).toBeCloseTo(Math.hypot(t, 2 - t), 7)
})

for (const angle of [0.3, 1.8, 4.2])
	test(`keeps the Cartesian median equivariant under rotation ${angle}`, () => {
		const c = Math.cos(angle)
		const s = Math.sin(angle)
		const points = [
			[0, 0],
			[2, 0],
			[2, 0],
			[0, 2],
			[0, 2],
		]
		const input = points.map(([x, y]) => measurement(3 + 2 * (x * c - y * s), -2 + 2 * (x * s + y * c), 100, 0.4))
		const result = success(summarizeCollimationSequence(input))
		const t = 1 - 1 / Math.sqrt(15)
		expect(result.offset.x).toBeCloseTo(3 + 2 * t * (c - s), 7)
		expect(result.offset.y).toBeCloseTo(-2 + 2 * t * (s + c), 7)
		expect(result.dispersion).toBeCloseTo(2 * Math.hypot(t, 2 - t), 7)
	})

test('accepts a coincident point optimum without dropping distant measurements', () => {
	const result = success(
		summarizeCollimationSequence(
			[
				[2, 1],
				[2, 1],
				[2, 1],
				[-5, -3],
				[15, 0],
			].map(([x, y]) => measurement(x, y)),
		),
	)
	expect(result.offset).toEqual({ x: 2, y: 1 })
	expect(result.dispersion).toBeCloseTo(Math.sqrt(170), 14)
	expect(result.direction).toBeUndefined()
	expect(result.entries.every((entry) => entry.usable)).toBeTrue()
})

for (const points of [
	[
		[1.1082694437354803, -0.8598943082615733],
		[1.3708127960562706, 1.1136274551972747],
		[1.6841341350227594, 0.31537065003067255],
		[-0.7244858033955097, 0.21237498056143522],
		[0.40879091434180737, -0.3590333117172122],
		[1.021085798740387, -0.21657976601272821],
	],
	[
		[-0.9082497209310532, 0.0014438478252850474],
		[1.264824928715825, 0.00414685650030151],
		[-0.5292623601853848, -0.003714539215434343],
		[-0.41075644828379154, -0.003582019216846675],
		[0.7295032069087029, 0.0031743789999745787],
		[-1.7737550344318151, 0.0033639606856741013],
		[-0.3915994353592396, 0.004735326382797211],
		[0.6032021027058363, 0.004810695808846504],
	],
])
	test(`converges for ${points.length} nearly singular or nearly coincident offsets`, () => {
		const result = success(summarizeCollimationSequence(points.map(([x, y]) => measurement(x, y))))
		let gx = 0
		let gy = 0
		let coincident = 0
		for (const [x, y] of points) {
			const dx = x - result.offset.x
			const dy = y - result.offset.y
			const distance = Math.hypot(dx, dy)
			if (distance < 1e-10) coincident++
			else {
				gx += dx / distance
				gy += dy / distance
			}
		}
		// The convex sum of distances is minimized exactly when the noncoincident gradient lies
		// inside the ball contributed by coincident points; this checks the objective independently.
		expect(Math.hypot(gx, gy)).toBeLessThanOrEqual(coincident + 1e-7)
	})

test('bounds sequence work and preserves inputs and previous results', () => {
	const input = Array.from({ length: 5 }, (_, i) => measurement(2 + 0.01 * i, 1, 48 + i))
	const before = JSON.stringify(input)
	const first = success(summarizeCollimationSequence(input))
	const serialized = JSON.stringify(first)
	summarizeCollimationSequence(input.toReversed())
	expect(JSON.stringify(input)).toBe(before)
	expect(JSON.stringify(first)).toBe(serialized)
	expect(first.offset).not.toBe(input[2].geometry.offset)
	expect(success(summarizeCollimationSequence(Array.from({ length: 1024 }, () => input[0]))).usableCount).toBe(1024)
	expect(() => summarizeCollimationSequence(Array.from({ length: 1025 }, () => input[0]))).toThrow(RangeError)
})

// Five full analyses each include 24 paired stability fits; allow their combined CPU budget.
test('summarizes five independently rendered frames with one reused workspace', () => {
	const workspace = createCollimationWorkspace(160, 160)
	const results: CollimationAnalysis[] = []
	for (let i = 0; i < 5; i++) {
		const image = generateSyntheticCollimationImage(collimationFixture({ noise: 0.001, seed: 41 + i, signal: 3000 + 50 * i }))
		results.push(analyzeCollimation({ image, area: { left: i, top: i, right: 160, bottom: 160 }, center: { x: 81, y: 81 } }, { workspace }))
	}
	const result = success(summarizeCollimationSequence(results, { tolerance: 0.01 }))
	expect(result.usableCount).toBe(5)
	expect(Math.hypot(result.offset.x - 2, result.offset.y - 1)).toBeLessThan(0.2)
	expect(result.dispersion).toBeLessThan(0.2)
	expect(result.direction).toBeCloseTo(Math.atan(0.5), 1)
	expect(result.dispersionExceedsTolerance).toBeFalse()
}, 5000)
