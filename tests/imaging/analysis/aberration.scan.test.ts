import { expect, test } from 'bun:test'
import { inspectAberrationFocusScan } from '../../../src/imaging/analysis/aberration.scan'
import type { StarProfile } from '../../../src/imaging/stars/profile'

// Creates a valid synthetic moments profile at a normalized sensor location.
function profile(u: number, v: number, value: number): StarProfile {
	return {
		x: (u + 0.5) * 100,
		y: (v + 0.5) * 100,
		valid: true,
		flux: 1,
		snr: 30,
		hfd: value,
		fwhm: value,
		major: value * 1.1,
		minor: value,
		eccentricity: 0.3,
		elongation: 1.1,
		theta: 0,
		background: 0,
		deviation: 0.01,
		peak: 0.5,
		quality: 1,
		model: 'moments',
		flags: [],
	}
}

// Creates one profiles-only scan frame whose fixed-sensor regional minima form a known plane.
function frame(position: number): { readonly position: number; readonly profiles: readonly StarProfile[]; readonly width: number; readonly height: number } {
	const profiles: StarProfile[] = []
	for (const v of [-0.4, 0, 0.4]) {
		for (const u of [-0.4, 0, 0.4]) {
			const bestFocus = 100 + 10 * u - 4 * v
			const value = 2 + ((position - bestFocus) * (position - bestFocus)) / 25
			for (let sample = 0; sample < 3; sample++) profiles.push(profile(u, v, value))
		}
	}
	return { position, profiles, width: 101, height: 101 }
}

// Fits fixed-sensor regional curves and recovers their planar best-focus surface without registration.
test('inspects a regional profiles-only focus scan', () => {
	const frames = [80, 90, 95, 100, 105, 110, 120].map(frame)
	const result = inspectAberrationFocusScan(frames, { regions: { layout: 'grid', columns: 3, rows: 3 }, curve: { minimumPoints: 5 }, surface: { model: 'plane' } })

	expect(result.width).toBe(101)
	expect(result.height).toBe(101)
	expect(result.quality.usedFrameCount).toBe(7)
	expect(result.regions).toHaveLength(9)
	expect(result.regions.every((region) => region.curve.success)).toBeTrue()
	expect(result.surface?.success).toBeTrue()
	if (!result.surface?.success) return
	expect(result.surface.coefficients.c).toBeCloseTo(100, 6)
	expect(result.surface.coefficients.ax).toBeCloseTo(10, 6)
	expect(result.surface.coefficients.ay).toBeCloseTo(-4, 6)
	expect(result.plane?.effect).toBeCloseTo(14, 6)
})

// Preserves rejected-frame order and identity when dimensions do not match the accepted scan.
test('rejects inconsistent focus-scan frame dimensions', () => {
	const frames = [...[90, 95, 100, 105, 110].map(frame), { ...frame(115), id: 'wrong-size', width: 99 }]
	const result = inspectAberrationFocusScan(frames, { regions: { layout: 'grid', columns: 3, rows: 3 } })

	expect(result.frames).toHaveLength(6)
	expect(result.frames[5].status).toBe('rejected')
	expect(result.frames[5].id).toBe('wrong-size')
	expect(result.frames[5].rejectionReasons).toContain('inconsistentDimensions')
})
