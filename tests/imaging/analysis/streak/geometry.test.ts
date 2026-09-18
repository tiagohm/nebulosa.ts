import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../../src/core/constants'
import { areStreakSegmentsMergeCompatible, canonicalizeStreakEndpoints, clipStreakLineToArea, fitWeightedStreakLine, normalizeStreakAngle, streakAxialAngleDistance, streakLineDistance, streakPlanePointToImage, streakSegmentProjectionRelation } from '../../../../src/imaging/analysis/streak/geometry'

test('normalizes axial angles and measures across the wrap', () => {
	expect(normalizeStreakAngle(-0.1)).toBeCloseTo(PI - 0.1, 14)
	expect(normalizeStreakAngle(PI)).toBe(0)
	expect(streakAxialAngleDistance(0.01, PI - 0.01)).toBeCloseTo(0.02, 14)
	expect(streakAxialAngleDistance(0, PIOVERTWO)).toBeCloseTo(PIOVERTWO, 14)
})

test('clips normal-form horizontal vertical and diagonal lines', () => {
	const area = { left: 10, top: 20, right: 15, bottom: 25 }
	expect(clipStreakLineToArea(0, 22, area)).toEqual([
		{ x: 10, y: 22 },
		{ x: 14, y: 22 },
	])
	const vertical = clipStreakLineToArea(PIOVERTWO, -12, area)
	expect(vertical?.[0].x).toBeCloseTo(12, 14)
	expect(vertical?.[0].y).toBe(20)
	expect(vertical?.[1].x).toBeCloseTo(12, 14)
	expect(vertical?.[1].y).toBe(24)
	const diagonal = clipStreakLineToArea(PIOVERFOUR, Math.sqrt(50), area)
	expect(diagonal?.[0].x).toBeCloseTo(10, 14)
	expect(diagonal?.[0].y).toBeCloseTo(20, 14)
	expect(diagonal?.[1].x).toBeCloseTo(14, 14)
	expect(diagonal?.[1].y).toBeCloseTo(24, 14)
})

test('fits horizontal vertical and diagonal weighted lines', () => {
	const horizontal = fitWeightedStreakLine([
		{ x: 0, y: 3, weight: 1 },
		{ x: 5, y: 3, weight: 2 },
		{ x: 10, y: 3, weight: 1 },
	])
	expect(horizontal?.center).toEqual({ x: 5, y: 3 })
	expect(horizontal?.angle).toBeCloseTo(0, 14)
	expect(horizontal?.linearity).toBeCloseTo(1, 14)
	expect(horizontal?.rmsResidual).toBeCloseTo(0, 14)

	const vertical = fitWeightedStreakLine([
		{ x: 4, y: 0, weight: 1 },
		{ x: 4, y: 5, weight: 1 },
		{ x: 4, y: 10, weight: 1 },
	])
	expect(vertical?.angle).toBeCloseTo(PIOVERTWO, 14)
	const diagonal = fitWeightedStreakLine([
		{ x: 1, y: 2, weight: 1 },
		{ x: 4, y: 5, weight: 1 },
		{ x: 7, y: 8, weight: 1 },
	])
	expect(diagonal?.angle).toBeCloseTo(PIOVERFOUR, 14)
	expect(
		fitWeightedStreakLine([
			{ x: 1, y: 1, weight: 1 },
			{ x: 1, y: 1, weight: 1 },
		]),
	).toBeUndefined()
})

test('computes line distance projection relation and merge compatibility', () => {
	const first = { start: { x: 0, y: 2 }, end: { x: 10, y: 2 }, angle: 0, width: 2 }
	const adjacent = { start: { x: 12, y: 2.5 }, end: { x: 20, y: 2.5 }, angle: 0.01, width: 2.2 }
	const parallel = { start: { x: 0, y: 9 }, end: { x: 10, y: 9 }, angle: 0, width: 2 }
	expect(streakLineDistance({ x: 4, y: 5 }, 0, 2)).toBeCloseTo(3, 14)
	expect(streakSegmentProjectionRelation(first, adjacent, 0)).toEqual({ gap: 2, overlap: 0 })
	expect(areStreakSegmentsMergeCompatible(first, adjacent, { angle: 0.02, gap: 3, distance: 1 })).toBeTrue()
	expect(areStreakSegmentsMergeCompatible(first, parallel, { angle: 0.02, gap: 3, distance: 2 })).toBeFalse()
	const wrapped = { start: { x: 12, y: 1.8 }, end: { x: 20, y: 1.6 }, angle: PI - 0.01, width: 2 }
	expect(areStreakSegmentsMergeCompatible(first, wrapped, { angle: 0.02, gap: 3, distance: 1 })).toBeTrue()
})

test('maps plane coordinates and canonicalizes endpoint direction', () => {
	expect(streakPlanePointToImage({ x: 3, y: 4 }, 11, 13, 2)).toEqual({ x: 17, y: 21 })
	expect(canonicalizeStreakEndpoints({ x: 5, y: 1 }, { x: 2, y: 1 })).toEqual([
		{ x: 2, y: 1 },
		{ x: 5, y: 1 },
	])
	expect(canonicalizeStreakEndpoints({ x: 2, y: 5 }, { x: 2, y: 1 })).toEqual([
		{ x: 2, y: 1 },
		{ x: 2, y: 5 },
	])
})
