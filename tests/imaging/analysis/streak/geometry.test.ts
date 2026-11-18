import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { canonicalizeStreakEndpoints, normalizeStreakAngle, streakAxialAngleDistance, streakLineDistance, streakSegmentProjectionRelation } from '../../../../src/imaging/analysis/streak/geometry'

test('normalizes axial angles and measures across the wrap', () => {
	expect(normalizeStreakAngle(-0.1)).toBeCloseTo(PI - 0.1, 14)
	expect(normalizeStreakAngle(PI)).toBe(0)
	expect(streakAxialAngleDistance(0.01, PI - 0.01)).toBeCloseTo(0.02, 14)
	expect(streakAxialAngleDistance(0, PIOVERTWO)).toBeCloseTo(PIOVERTWO, 14)
})

test('computes line distance and projection relation', () => {
	const first = { start: { x: 0, y: 2 }, end: { x: 10, y: 2 }, angle: 0, width: 2 }
	const adjacent = { start: { x: 12, y: 2.5 }, end: { x: 20, y: 2.5 }, angle: 0.01, width: 2.2 }
	const overlapping = { start: { x: 6, y: 2 }, end: { x: 16, y: 2 }, angle: 0, width: 2 }
	expect(streakLineDistance({ x: 4, y: 5 }, 0, 2)).toBeCloseTo(3, 14)
	expect(streakSegmentProjectionRelation(first, adjacent, 0)).toEqual({ gap: 2, overlap: 0 })
	expect(streakSegmentProjectionRelation(first, overlapping, 0)).toEqual({ gap: 0, overlap: 4 })
})

test('canonicalizes endpoint direction', () => {
	expect(canonicalizeStreakEndpoints({ x: 5, y: 1 }, { x: 2, y: 1 })).toEqual([
		{ x: 2, y: 1 },
		{ x: 5, y: 1 },
	])
	expect(canonicalizeStreakEndpoints({ x: 2, y: 5 }, { x: 2, y: 1 })).toEqual([
		{ x: 2, y: 1 },
		{ x: 2, y: 5 },
	])
})
