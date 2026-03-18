import { describe, expect, test } from 'bun:test'
import type { Rect } from '../src/geometry'
import { gaussian, mulberry32, type Random, shuffle } from '../src/random'
import { type DetectedStar, detectStars } from '../src/star.detector'
import { type AffineTransform, applyTransformToPoint, applyTransformToStars, canonicalTrianglePattern, fitAffineTransform, fitSimilarityTransform, invertSimilarityTransform, invertTransform, matchStars, type SimilarityTransform, type StarMatchingResult } from '../src/star.matching'
import { medianOf } from '../src/util'
import { vecDistance } from '../src/vec3'
import { downloadPerTag } from './download'
import { readImage } from './image.util'

await downloadPerTag('starmatching')

interface SyntheticStar extends DetectedStar {
	readonly id: number
}

interface ScenarioOptions {
	readonly seed: number
	readonly width?: number
	readonly height?: number
	readonly count?: number
	readonly minSeparation?: number
	readonly transform: SimilarityTransform | AffineTransform
	readonly noiseStd?: number
	readonly currentDropFraction?: number
	readonly referenceDropFraction?: number
	readonly currentOutliers?: number
	readonly referenceOutliers?: number
	readonly currentCrop?: Rect
	readonly addClosePairs?: boolean
}

interface Scenario {
	readonly reference: readonly SyntheticStar[]
	readonly current: readonly SyntheticStar[]
	readonly truth: SimilarityTransform | AffineTransform
	readonly sharedIds: readonly number[]
}

function similarity(scale: number, rotation: number, tx: number, ty: number, mirrored = false): SimilarityTransform {
	return { a: scale * Math.cos(rotation), b: scale * Math.sin(rotation), tx, ty, mirrored }
}

function affine(m00: number, m01: number, tx: number, m10: number, m11: number, ty: number): AffineTransform {
	return { m00, m01, tx, m10, m11, ty }
}

function randomRange(random: Random, min: number, max: number) {
	return min + (max - min) * random()
}

function createReferenceStars(seed: number, count: number, width: number, height: number, minSeparation: number, addClosePairs: boolean) {
	const random = mulberry32(seed)
	const stars: SyntheticStar[] = []
	const minSeparationSq = minSeparation * minSeparation
	let attempts = 0

	while (stars.length < count && attempts < count * 200) {
		attempts++
		const x = randomRange(random, 24, width - 24)
		const y = randomRange(random, 24, height - 24)
		let ok = true

		for (let i = 0; i < stars.length; i++) {
			const star = stars[i]
			const dx = star.x - x
			const dy = star.y - y
			if (dx * dx + dy * dy < minSeparationSq) {
				ok = false
				break
			}
		}

		if (!ok) continue
		stars.push(makeSyntheticStar(stars.length, x, y, random))
	}

	if (addClosePairs && stars.length >= 4) {
		for (let i = 0; i < 4; i++) {
			const source = stars[i]
			stars.push(makeSyntheticStar(stars.length, source.x + 0.8 + i * 0.15, source.y + 0.9 - i * 0.1, random))
		}
	}

	return stars
}

function makeSyntheticStar(id: number, x: number, y: number, random: Random): SyntheticStar {
	const snr = randomRange(random, 8, 60)
	const hfd = randomRange(random, 1.4, 5.8)
	const flux = randomRange(random, 500, 40000)
	return { id, x, y, snr, hfd, flux }
}

function inside(rect: Rect, x: number, y: number) {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

function generateScenario(options: ScenarioOptions): Scenario {
	const width = options.width ?? 800
	const height = options.height ?? 600
	const count = options.count ?? 60
	const minSeparation = options.minSeparation ?? 18
	const random = mulberry32(options.seed ^ 0x9e3779b9)
	const referenceBase = createReferenceStars(options.seed, count, width, height, minSeparation, options.addClosePairs ?? false)
	const inverse = invertTransform(options.transform)
	if (inverse === undefined) throw new Error('transform must be invertible')

	const reference: SyntheticStar[] = []
	const current: SyntheticStar[] = []
	const currentCrop = options.currentCrop ?? { left: 0, top: 0, right: width, bottom: height }
	const sharedIds: number[] = []

	for (let i = 0; i < referenceBase.length; i++) {
		const ref = referenceBase[i]

		if (random() >= (options.referenceDropFraction ?? 0)) reference.push(makeSyntheticStar(ref.id, ref.x, ref.y, random))

		const currentPoint = applyTransformToPoint(ref.x, ref.y, inverse)
		if (!inside(currentCrop, currentPoint.x, currentPoint.y)) continue
		if (random() < (options.currentDropFraction ?? 0)) continue
		const gauss = gaussian(random, options.noiseStd ?? 0)
		const noisyX = currentPoint.x + gauss()
		const noisyY = currentPoint.y + gauss()
		current.push(makeSyntheticStar(ref.id, noisyX, noisyY, random))
		sharedIds.push(ref.id)
	}

	for (let i = 0; i < (options.referenceOutliers ?? 0); i++) {
		reference.push(makeSyntheticStar(-1 - i, randomRange(random, 0, width), randomRange(random, 0, height), random))
	}

	for (let i = 0; i < (options.currentOutliers ?? 0); i++) {
		current.push(makeSyntheticStar(-101 - i, randomRange(random, currentCrop.left, currentCrop.right), randomRange(random, currentCrop.top, currentCrop.bottom), random))
	}

	shuffle(reference, random)
	shuffle(current, random)

	return { reference, current, truth: options.transform, sharedIds }
}

function resultTransform(result: StarMatchingResult) {
	if (!result.success) return undefined

	if (result.model === 'similarity' && result.similarity !== undefined) {
		return result.similarity
	}

	if (result.model === 'affine' && result.affine !== undefined) {
		return result.affine
	}

	return undefined
}

function sharedResiduals(result: StarMatchingResult, reference: readonly SyntheticStar[], current: readonly SyntheticStar[]) {
	const transform = resultTransform(result)
	if (transform === undefined) return []
	const referenceById = new Map<number, SyntheticStar>()
	for (let i = 0; i < reference.length; i++) referenceById.set(reference[i].id, reference[i])
	const residuals: number[] = []

	for (let i = 0; i < current.length; i++) {
		const star = current[i]
		if (star.id < 0) continue
		const ref = referenceById.get(star.id)
		if (ref === undefined) continue
		const projected = applyTransformToPoint(star.x, star.y, transform)
		residuals.push(Math.hypot(projected.x - ref.x, projected.y - ref.y))
	}

	return residuals
}

function expectRecovered(result: StarMatchingResult, reference: readonly SyntheticStar[], current: readonly SyntheticStar[], minInliers: number, medianTolerancePx: number) {
	expect(result.success).toBeTrue()
	expect(result.inlierCount).toBeGreaterThanOrEqual(minInliers)
	const residuals = sharedResiduals(result, reference, current)
	expect(residuals.length).toBeGreaterThanOrEqual(minInliers)
	expect(medianOf(residuals.toSorted((a, b) => a - b))).toBeLessThan(medianTolerancePx)
}

function transformAgreement(expected: SimilarityTransform | AffineTransform, actual: SimilarityTransform | AffineTransform, current: readonly DetectedStar[]) {
	const residuals = new Float64Array(current.length)

	for (let i = 0; i < current.length; i++) {
		const star = current[i]
		const expectedPoint = applyTransformToPoint(star.x, star.y, expected)
		const actualPoint = applyTransformToPoint(star.x, star.y, actual)
		residuals[i] = Math.hypot(expectedPoint.x - actualPoint.x, expectedPoint.y - actualPoint.y)
	}

	return residuals.sort()
}

function expectTransformAgreement(expected: SimilarityTransform | AffineTransform, actual: SimilarityTransform | AffineTransform, current: readonly DetectedStar[]) {
	const agreement = transformAgreement(expected, actual!, current)
	expect(medianOf(agreement)).toBeLessThan(0.05)
	expect(agreement[agreement.length - 1]).toBeLessThan(0.25)
}

describe('triangle descriptors', () => {
	test('canonicalization is deterministic across permutations', () => {
		const points = [
			{ x: 10, y: 12 },
			{ x: 74, y: 25 },
			{ x: 21, y: 97 },
		] as const
		const config = { symmetricPatternTolerance: 0.004, minPatternAreaRatio: 0.01 }
		const canonical = canonicalTrianglePattern(points, [0, 1, 2], config)!
		const perms = [canonicalTrianglePattern([points[1], points[2], points[0]], [1, 2, 0], config)!, canonicalTrianglePattern([points[2], points[0], points[1]], [2, 0, 1], config)!, canonicalTrianglePattern([points[0], points[2], points[1]], [0, 2, 1], config)!]

		for (const permuted of perms) {
			expect(permuted.starIndices).toEqual(canonical.starIndices)
			expect(permuted.descriptor[0]).toBeCloseTo(canonical.descriptor[0], 12)
			expect(permuted.descriptor[1]).toBeCloseTo(canonical.descriptor[1], 12)
			expect(permuted.descriptor[2]).toBeCloseTo(canonical.descriptor[2], 12)
		}
	})

	test('degenerate triangles are rejected', () => {
		const degenerate = canonicalTrianglePattern(
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0.0001 },
				{ x: 20, y: 0.0002 },
			],
			[0, 1, 2],
			{ minPatternAreaRatio: 0.02 },
		)
		expect(degenerate).toBeUndefined()
	})

	test('descriptor distance separates close and unrelated shapes', () => {
		const config = { symmetricPatternTolerance: 0.004, minPatternAreaRatio: 0.01 }
		const base = canonicalTrianglePattern(
			[
				{ x: 10, y: 10 },
				{ x: 86, y: 24 },
				{ x: 27, y: 138 },
			],
			[0, 1, 2],
			config,
		)!
		const near = canonicalTrianglePattern(
			[
				{ x: 35, y: 18 },
				{ x: 130, y: 35.5 },
				{ x: 56.25, y: 178 },
			],
			[0, 1, 2],
			config,
		)!
		const far = canonicalTrianglePattern(
			[
				{ x: 10, y: 10 },
				{ x: 122, y: 14 },
				{ x: 46, y: 39 },
			],
			[0, 1, 2],
			{ symmetricPatternTolerance: 0.004, minPatternAreaRatio: 0.002 },
		)!
		expect(vecDistance(base.descriptor, near.descriptor)).toBeLessThan(1e-9)
		expect(vecDistance(base.descriptor, far.descriptor)).toBeGreaterThan(0.1)
	})
})

describe('transform fitting', () => {
	test('similarity fit recovers known transform and invert works', () => {
		const transform = similarity(1.04, 0.37, 120, -35)
		const inverse = invertTransform(transform)
		const reference = [
			{ x: 10, y: 15 },
			{ x: 65, y: 40 },
			{ x: 80, y: 120 },
			{ x: 20, y: 100 },
		]
		const current = reference.map((point) => applyTransformToPoint(point.x, point.y, inverse!))
		const fitted = fitSimilarityTransform(current, reference)!
		expect(fitted.a).toBeCloseTo(transform.a, 10)
		expect(fitted.b).toBeCloseTo(transform.b, 10)
		expect(fitted.tx).toBeCloseTo(transform.tx, 10)
		expect(fitted.ty).toBeCloseTo(transform.ty, 10)

		for (const point of current) {
			const projected = applyTransformToPoint(point.x, point.y, fitted)
			const back = applyTransformToPoint(projected.x, projected.y, invertTransform(fitted)!)
			expect(back.x).toBeCloseTo(point.x, 10)
			expect(back.y).toBeCloseTo(point.y, 10)
		}
	})

	test('affine fit recovers known transform', () => {
		const transform = affine(1.02, 0.03, 18, -0.02, 0.97, 24)
		const inverse = invertTransform(transform)
		const reference = [
			{ x: 12, y: 18 },
			{ x: 60, y: 44 },
			{ x: 20, y: 110 },
			{ x: 140, y: 95 },
		]
		const current = reference.map((point) => applyTransformToPoint(point.x, point.y, inverse!))
		const fitted = fitAffineTransform(current, reference)!
		expect(fitted.m00).toBeCloseTo(transform.m00, 10)
		expect(fitted.m01).toBeCloseTo(transform.m01, 10)
		expect(fitted.tx).toBeCloseTo(transform.tx, 10)
		expect(fitted.m10).toBeCloseTo(transform.m10, 10)
		expect(fitted.m11).toBeCloseTo(transform.m11, 10)
		expect(fitted.ty).toBeCloseTo(transform.ty, 10)
	})

	test('mirrored similarity fit is recovered', () => {
		const transform = similarity(0.98, -0.52, 70, 90, true)
		const inverse = invertSimilarityTransform(transform)
		const reference = [
			{ x: 5, y: 10 },
			{ x: 90, y: 20 },
			{ x: 25, y: 70 },
			{ x: 60, y: 110 },
		]
		const current = reference.map((point) => applyTransformToPoint(point.x, point.y, inverse!))
		const fitted = fitSimilarityTransform(current, reference, true)!
		expect(fitted.mirrored).toBeTrue()
		expect(fitted.a).toBeCloseTo(transform.a, 10)
		expect(fitted.b).toBeCloseTo(transform.b, 10)
	})
})

describe('star matching synthetic registration', () => {
	test('recovers pure translation', () => {
		const scenario = generateScenario({ seed: 1, transform: similarity(1, 0, 48, -26), noiseStd: 0.08 })
		const result = matchStars(scenario.reference, scenario.current)
		expectRecovered(result, scenario.reference, scenario.current, 20, 0.7)
		expect(result.model).toBe('similarity')
	})

	test('recovers translation rotation and scale with ranking changes', () => {
		const scenario = generateScenario({ seed: 2, transform: similarity(1.035, 0.63, -70, 55), noiseStd: 0.12 })
		const result = matchStars(scenario.reference, scenario.current, { maxScaleRatio: 1.1, minScaleRatio: 0.9, finalMatchRadius: 2 })
		expectRecovered(result, scenario.reference, scenario.current, 15, 0.9)
		expect(result.model).toBe('similarity')
	})

	test('recovers mirrored data', () => {
		const scenario = generateScenario({ seed: 3, transform: similarity(1.01, 0.44, 130, 42, true), noiseStd: 0.12 })
		const result = matchStars(scenario.reference, scenario.current, { allowMirror: true })
		expectRecovered(result, scenario.reference, scenario.current, 12, 1.0)
		expect(result.similarity?.mirrored).toBeTrue()
	})

	test('handles partial overlap, missing stars, outliers, and centroid noise', () => {
		const scenario = generateScenario({ seed: 4, transform: similarity(0.99, -0.38, 95, 28), noiseStd: 0.35, currentDropFraction: 0.35, referenceDropFraction: 0.15, currentOutliers: 18, referenceOutliers: 8, currentCrop: { left: 40, top: 30, right: 620, bottom: 520 } })
		const result = matchStars(scenario.reference, scenario.current, { maxStars: 120, finalMatchRadius: 3, initialMatchRadius: 12, minInliers: 10 })
		expectRecovered(result, scenario.reference, scenario.current, 10, 1.6)
	})

	test('handles repeated close stars by preprocessing deduplication', () => {
		const scenario = generateScenario({ seed: 5, transform: similarity(1.01, 0.28, 72, 34), addClosePairs: true, noiseStd: 0.1 })
		const result = matchStars(scenario.reference, scenario.current, { maxStars: 100, minInliers: 8 })
		expectRecovered(result, scenario.reference, scenario.current, 8, 1.1)
	})

	test('fails cleanly on insufficient evidence', () => {
		const reference: SyntheticStar[] = [
			{ id: 0, x: 20, y: 20, snr: 10, flux: 1000, hfd: 2 },
			{ id: 1, x: 40, y: 40, snr: 11, flux: 1200, hfd: 2.2 },
		]
		const current: SyntheticStar[] = [
			{ id: 0, x: 120, y: 50, snr: 10, flux: 1000, hfd: 2 },
			{ id: 2, x: 150, y: 70, snr: 12, flux: 1300, hfd: 2.1 },
		]

		const result = matchStars(reference, current, { minStars: 3, minInliers: 3 })
		expect(result.success).toBeFalse()
		expect(result.failureReason).toBeDefined()
	})

	test('supports exact minimal three-star similarity registration', () => {
		const reference: readonly DetectedStar[] = [
			{ x: 20, y: 30, snr: 18, flux: 2400, hfd: 2.1 },
			{ x: 95, y: 42, snr: 21, flux: 3100, hfd: 2.4 },
			{ x: 36, y: 128, snr: 17, flux: 2600, hfd: 2.3 },
		]
		const expected = similarity(1.02, 0.28, 14, -9)
		const inverse = invertTransform(expected)!
		const current = applyTransformToStars(reference, inverse)
		const result = matchStars(reference, current, { maxStars: 3, minStars: 3, minInliers: 3, allowAffineFallback: false, initialMatchRadius: 4, finalMatchRadius: 0.5, maxResidual: 0.5 })
		expect(result.success).toBeTrue()
		expect(result.model).toBe('similarity')
		expect(result.inlierCount).toBe(3)
		expectTransformAgreement(expected, resultTransform(result)!, current)
	})

	test('supports exact minimal three-star mirrored registration', () => {
		const reference: readonly DetectedStar[] = [
			{ x: 20, y: 30, snr: 18, flux: 2400, hfd: 2.1 },
			{ x: 95, y: 42, snr: 21, flux: 3100, hfd: 2.4 },
			{ x: 36, y: 128, snr: 17, flux: 2600, hfd: 2.3 },
		]
		const expected = similarity(0.98, -0.41, 11, 7, true)
		const inverse = invertTransform(expected)!
		const current = applyTransformToStars(reference, inverse)
		const result = matchStars(reference, current, { maxStars: 3, minStars: 3, minInliers: 3, allowMirror: true, allowAffineFallback: false, initialMatchRadius: 4, finalMatchRadius: 0.5, maxResidual: 0.5 })
		expect(result.success).toBeTrue()
		expect(result.model).toBe('similarity')
		expect(result.similarity?.mirrored).toBeTrue()
		expect(result.inlierCount).toBe(3)
		expectTransformAgreement(expected, resultTransform(result)!, current)
	})

	test('uses affine fallback only when enabled', () => {
		const scenario = generateScenario({ seed: 6, transform: affine(1.01, 0.045, 22, -0.02, 0.97, 31), noiseStd: 0.08, currentDropFraction: 0.1, currentOutliers: 6 })
		const similarityOnly = matchStars(scenario.reference, scenario.current, { allowAffineFallback: false, minInliers: 12 })
		const withAffine = matchStars(scenario.reference, scenario.current, { allowAffineFallback: true, minInliers: 12 })
		expect(similarityOnly.success).toBeTrue()
		expect(withAffine.success).toBeTrue()
		expect(withAffine.model).toBe('affine')
		expect(withAffine.rmsError ?? Infinity).toBeLessThan((similarityOnly.rmsError ?? Infinity) * 0.8)
	})
})

describe('property-style randomized recovery', () => {
	for (const seed of [11, 12, 13, 14]) {
		test(`recovers moderate random similarity for seed ${seed}`, () => {
			const random = mulberry32(seed)
			const transform = similarity(randomRange(random, 0.94, 1.06), randomRange(random, -1.2, 1.2), randomRange(random, -120, 120), randomRange(random, -90, 90))
			const scenario = generateScenario({ seed, transform, count: seed % 2 === 0 ? 80 : 35, minSeparation: seed % 2 === 0 ? 14 : 24, noiseStd: randomRange(random, 0.05, 0.3), currentDropFraction: randomRange(random, 0.05, 0.25), currentOutliers: 6 })
			const result = matchStars(scenario.reference, scenario.current, { maxStars: 120, minInliers: 8, allowMirror: true })
			expectRecovered(result, scenario.reference, scenario.current, 8, 1.4)
		})
	}
})

describe('real stars dataset', async () => {
	const [image] = await readImage(16, 1)
	const stars = detectStars(image, { maxStars: 100 })
	const minInliers = Math.max(12, Math.floor(stars.length * 0.6))

	describe('recovers a comprehensive similarity transform set with full matching', () => {
		const cases = [
			{
				name: 'similarity identity',
				model: 'similarity',
				transform: similarity(1, 0, 0, 0),
				config: { allowAffineFallback: false },
			},
			{
				name: 'similarity translation',
				model: 'similarity',
				transform: similarity(1, 0, 37.5, -22.25),
				config: { allowAffineFallback: false },
			},
			{
				name: 'similarity small rotation',
				model: 'similarity',
				transform: similarity(1, 0.18, 24, -18),
				config: { allowAffineFallback: false },
			},
			{
				name: 'similarity ninety degrees',
				model: 'similarity',
				transform: similarity(1, Math.PI / 2, 42, 18),
				config: { allowAffineFallback: false, maxRotation: null },
			},
			{
				name: 'similarity one eighty degrees',
				model: 'similarity',
				transform: similarity(1, Math.PI, -16, 28),
				config: { allowAffineFallback: false, maxRotation: null },
			},
			{
				name: 'similarity scaled rotated',
				model: 'similarity',
				transform: similarity(1.06, -0.34, 33, 21),
				config: { allowAffineFallback: false, minScaleRatio: 0.9, maxScaleRatio: 1.1 },
			},
			{
				name: 'similarity mirrored',
				model: 'similarity',
				transform: similarity(0.97, 0.41, 58, -26, true),
				config: { allowMirror: true, allowAffineFallback: false, minScaleRatio: 0.85, maxScaleRatio: 1.1 },
			},
		] as const

		for (const entry of cases) {
			test(entry.name, () => {
				const inverse = invertTransform(entry.transform)
				expect(inverse).toBeDefined()
				const current = applyTransformToStars(stars, inverse!)
				const result = matchStars(stars, current, { maxStars: stars.length, minStars: 12, minInliers, initialMatchRadius: 12, finalMatchRadius: 1.5, refineIterations: 5, maxResidual: 1.5, ...entry.config })

				expect(result.success).toBeTrue()
				expect(result.model).toBe(entry.model)
				expect(result.inlierCount).toBeGreaterThanOrEqual(minInliers)

				const actual = resultTransform(result)
				expect(actual).toBeDefined()
				expectTransformAgreement(entry.transform, actual!, current)

				if (entry.model === 'similarity') {
					expect(result.similarity?.mirrored).toBe((entry.transform as SimilarityTransform).mirrored)
				} else {
					expect(result.rmsError ?? Infinity).toBeLessThan(0.05)
				}
			})
		}
	})

	describe('recovers a comprehensive similarity and affine transform set with exact correspondences', () => {
		const cases = [
			{
				name: 'similarity identity',
				model: 'similarity',
				transform: similarity(1, 0, 0, 0),
			},
			{
				name: 'similarity translation',
				model: 'similarity',
				transform: similarity(1, 0, 37.5, -22.25),
			},
			{
				name: 'similarity small rotation',
				model: 'similarity',
				transform: similarity(1, 0.18, 24, -18),
			},
			{
				name: 'similarity ninety degrees',
				model: 'similarity',
				transform: similarity(1, Math.PI / 2, 42, 18),
			},
			{
				name: 'similarity one eighty degrees',
				model: 'similarity',
				transform: similarity(1, Math.PI, -16, 28),
			},
			{
				name: 'similarity scaled rotated',
				model: 'similarity',
				transform: similarity(1.06, -0.34, 33, 21),
			},
			{
				name: 'similarity mirrored',
				model: 'similarity',
				transform: similarity(0.97, 0.41, 58, -26, true),
			},
			{
				name: 'affine mild shear x',
				model: 'affine',
				transform: affine(1, 0.035, 18, 0, 1, -12),
			},
			{
				name: 'affine mild shear y',
				model: 'affine',
				transform: affine(1, 0, -14, -0.03, 1, 20),
			},
			{
				name: 'affine anisotropic scale',
				model: 'affine',
				transform: affine(1.04, 0.012, 28, -0.015, 0.96, 14),
			},
			{
				name: 'affine full mild warp',
				model: 'affine',
				transform: affine(0.99, 0.04, 22, -0.025, 1.03, -18),
			},
		] as const

		for (const entry of cases) {
			test(entry.name, () => {
				const inverse = invertTransform(entry.transform)
				expect(inverse).toBeDefined()
				const current = applyTransformToStars(stars, inverse!)

				if (entry.model === 'similarity') {
					const fitted = fitSimilarityTransform(current, stars, entry.transform.mirrored)
					expect(fitted).toBeDefined()
					expectTransformAgreement(entry.transform, fitted!, current)
					expect(fitted?.mirrored).toBe(entry.transform.mirrored)
				} else {
					const fitted = fitAffineTransform(current, stars)
					expect(fitted).toBeDefined()
					expectTransformAgreement(entry.transform, fitted!, current)
				}
			})
		}
	})
})
