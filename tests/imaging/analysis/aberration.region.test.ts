import { expect, test } from 'bun:test'
import { assignAberrationRegion, buildAberrationField, createAberrationRegions, summarizeAberrationRegions } from '../../../src/imaging/analysis/aberration.region'
import type { AberrationStar } from '../../../src/imaging/analysis/aberration.types'
import type { StarProfile } from '../../../src/imaging/stars/profile'

// Creates a valid synthetic profile whose values are suitable for spatial aggregation tests.
function profile(x: number, y: number, hfd: number = 2, theta: number = 0, eccentricity: number = 0.4): StarProfile {
	return {
		x,
		y,
		valid: true,
		flux: 1,
		snr: 30,
		hfd,
		fwhm: hfd,
		major: hfd * 1.2,
		minor: hfd,
		eccentricity,
		elongation: 1.2,
		theta,
		background: 0,
		deviation: 0.01,
		peak: 0.5,
		quality: 1,
		model: 'moments',
		flags: [],
	}
}

// Creates an already-selected synthetic star in normalized sensor coordinates.
function star(u: number, v: number, hfd: number = 2, theta: number = 0): AberrationStar {
	return { profile: profile(u, v, hfd, theta), u, v, weight: 1, selected: true, selectionReasons: [], rejections: [] }
}

// Generates non-overlapping layouts with deterministic border assignment.
test('creates and assigns non-overlapping aberration regions', () => {
	const grid = createAberrationRegions({ layout: 'grid', columns: 3, rows: 3 })

	expect(grid).toHaveLength(9)
	expect(assignAberrationRegion(-0.5, -0.5, grid)).toBe(0)
	expect(assignAberrationRegion(0.5, 0.5, grid)).toBe(8)
	expect(assignAberrationRegion(-1 / 6, -1 / 6, grid)).toBe(4)
	expect(assignAberrationRegion(0.51, 0, grid)).toBe(-1)
	expect(createAberrationRegions({ layout: 'centerAndCorners' })).toHaveLength(5)
	expect(createAberrationRegions({ layout: 'centerAndEdges' })).toHaveLength(5)
	expect(createAberrationRegions({ layout: 'octagonal' })).toHaveLength(8)
	expect(() =>
		createAberrationRegions({
			regions: [
				{ id: 'a', left: -0.5, top: -0.5, right: 0, bottom: 0 },
				{ id: 'b', left: -0.25, top: -0.25, right: 0.25, bottom: 0.25 },
			],
		}),
	).toThrow(RangeError)
})

// Aggregates robust medians and axial directions across the PI wrap without treating directions as vectors.
test('summarizes scalar metrics and axial orientation by region', () => {
	const regions = createAberrationRegions({ layout: 'custom', regions: [{ id: 'all', left: -0.5, top: -0.5, right: 0.5, bottom: 0.5 }] })
	const stars = [star(-0.2, -0.2, 2, 0.01), star(0.1, -0.2, 2.1, Math.PI - 0.01), star(-0.1, 0.1, 1.9, 0.02), star(0.2, 0.2, 20, 0)]

	const [summary] = summarizeAberrationRegions(stars, regions)

	expect(summary.inputStarCount).toBe(4)
	expect(summary.usedStarCountByMetric.hfd).toBe(4)
	expect(summary.medianHFD).toBeCloseTo(2.05, 6)
	expect(summary.orientation).toBeCloseTo(0, 1)
	expect(summary.orientationCoherence).toBeGreaterThan(0.99)
	expect(summary.confidence).toBeGreaterThan(0)
})

// Builds non-interpolated field cells from selected metric values and honors metric-specific exclusions.
test('builds a regular scalar field without using rejected metric values', () => {
	const rejected: AberrationStar = { ...star(-0.25, -0.25, 20), rejections: [{ metric: 'hfd', reason: 'outlier' }] }
	const cells = buildAberrationField([star(-0.25, -0.25, 2), rejected, star(0.25, 0.25, 4)], 'hfd', { columns: 2, rows: 2, minimumStars: 1 })

	expect(cells).toHaveLength(4)
	expect(cells[0].value).toBe(2)
	expect(cells[3].value).toBe(4)
	expect(cells[1].value).toBeUndefined()
})
