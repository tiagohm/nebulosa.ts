import { describe, expect, test } from 'bun:test'
import { PI } from 'nebulosa/src/core/constants'
import { DEFAULT_LIMB_TRACKING_OPTIONS, type LimbMeasurement, type LimbOutcome, type LimbSearch, type LimbTrackingOptions, locateBrightObject, measureLimb } from '../../../../src/imaging/analysis/tracking/limb'
import { SurfaceTrackingWorkspace } from '../../../../src/imaging/analysis/tracking/workspace'
import type { Rect } from '../../../../src/math/numerical/geometry'
import { addScenes, type DiskOptions, diskScene, type RenderOptions, renderScene, spotsScene, textureScene } from '../../../util/scene'

const SIZE = 256
const FULL: Rect = { left: 0, top: 0, right: SIZE, bottom: SIZE }
const BASE: RenderOptions = { gain: 0.6, offset: 0.1 }

function measure(disk: DiskOptions, render: RenderOptions = {}, search: LimbSearch = {}, options: Partial<LimbTrackingOptions> = {}, area: Rect = FULL, extra?: (x: number, y: number) => number) {
	const disc = diskScene(disk)
	const scene = extra === undefined ? disc : addScenes(disc, extra)
	const image = renderScene(SIZE, SIZE, scene, { ...BASE, ...render })
	return measureLimb(image, render.cfa === undefined ? 'mono' : 'green1', area, new SurfaceTrackingWorkspace(), { ...DEFAULT_LIMB_TRACKING_OPTIONS, ...options }, search)
}

function expectLimb(outcome: LimbOutcome, x: number, y: number, radius: number, tolerance: number): asserts outcome is { success: true; limb: LimbMeasurement } {
	if (!outcome.success) throw new Error(`limb failed: ${outcome.reason} ${JSON.stringify(outcome.rays)}`)
	const { limb } = outcome
	expect(Math.abs(limb.center[0] - x)).toBeLessThan(tolerance)
	expect(Math.abs(limb.center[1] - y)).toBeLessThan(tolerance)
	expect(Math.abs(limb.semiMajor - radius)).toBeLessThan(2 * tolerance)
	expect(Math.abs(limb.semiMinor - radius)).toBeLessThan(2 * tolerance)
	expect(limb.confidence).toBeGreaterThan(0)
	expect(limb.confidence).toBeLessThanOrEqual(1)
}

describe('limb', () => {
	test('clean disk with fractional center', () => {
		const outcome = measure({ x: 127.37, y: 131.81, radius: 60 })
		expectLimb(outcome, 127.37, 131.81, 60, 0.1)
		expect(outcome.limb.coverage).toBe(1)
		expect(outcome.limb.rms).toBeLessThan(0.1)
		expect(outcome.limb.confidence).toBeGreaterThan(0.8)
	})

	test('noise, limb darkening, gain and offset', () => {
		const outcome = measure({ x: 120.6, y: 135.2, radius: 55, limbDarkening: 0.6 }, { gain: 0.3, offset: 0.25, noise: 0.01, seed: 3 })
		expectLimb(outcome, 120.6, 135.2, 55, 0.3)
	})

	test('elliptical planetary disk', () => {
		const outcome = measure({ x: 128.4, y: 126.9, radius: 50, axisRatio: 0.92, theta: 0.4 })
		if (!outcome.success) throw new Error(`limb failed: ${outcome.reason}`)
		expect(outcome.limb.center[0]).toBeCloseTo(128.4, 1)
		expect(outcome.limb.center[1]).toBeCloseTo(126.9, 1)
		expect(outcome.limb.semiMajor).toBeCloseTo(50, 0)
		expect(outcome.limb.semiMinor / outcome.limb.semiMajor).toBeCloseTo(0.92, 2)
		expect(outcome.limb.theta).toBeCloseTo(0.4, 1)
	})

	test('textured disk with sunspots', () => {
		const spots = spotsScene([
			[110, 120, 3, -0.6],
			[140, 140, 4, -0.5],
			[150, 105, 2.5, -0.7],
		])
		const outcome = measure({ x: 128.2, y: 127.7, radius: 60, limbDarkening: 0.5, texture: textureScene(5, SIZE, SIZE, 400), textureAmplitude: 0.1 }, { noise: 0.005 }, {}, {}, FULL, spots)
		expectLimb(outcome, 128.2, 127.7, 60, 0.3)
	})

	test('prominences outside the limb are rejected as outliers', () => {
		const prominences = spotsScene([
			[128.2 + 66, 127.7, 3, 0.5],
			[128.2, 127.7 - 67, 2.5, 0.6],
		])
		const outcome = measure({ x: 128.2, y: 127.7, radius: 60 }, { noise: 0.005 }, {}, {}, FULL, prominences)
		expectLimb(outcome, 128.2, 127.7, 60, 0.3)
	})

	test('gibbous terminator leaves the bright limb measurable', () => {
		const outcome = measure({ x: 126.3, y: 129.6, radius: 60, terminator: { angle: 0.3, offset: 0.75 } }, { noise: 0.005 })
		expectLimb(outcome, 126.3, 129.6, 60, 0.5)
		expect(outcome.limb.coverage).toBeLessThan(1)
	})

	test('crescent phase fails the angular-gap gate', () => {
		const outcome = measure({ x: 128, y: 128, radius: 60, terminator: { angle: 0, offset: -0.6 } }, { noise: 0.005 }, { prior: { center: [128, 128], semiMajor: 60, semiMinor: 60, theta: 0 } })
		expect(outcome.success).toBeFalse()
		if (!outcome.success) expect(['limb_low_coverage', 'limb_large_gap']).toContain(outcome.reason)
	})

	test('ring system does not produce an accepted limb', () => {
		const outcome = measure({ x: 128, y: 128, radius: 40, ring: { inner: 52, outer: 90, axisRatio: 0.35, brightness: 0.8 } }, { noise: 0.005 })
		expect(outcome.success).toBeFalse()
	})

	test('moderate image-edge clipping still fits the visible limb', () => {
		const outcome = measure({ x: 40.3, y: 128.6, radius: 60 }, { noise: 0.005 })
		expectLimb(outcome, 40.3, 128.6, 60, 0.4)
		expect(outcome.limb.rays.cropped).toBeGreaterThan(0)
	})

	test('a large limb-darkened disk near the ROI border keeps truncated rays', () => {
		const outcome = measure({ x: 128.6, y: 127.3, radius: 105, limbDarkening: 0.6 }, { noise: 0.005 })
		expectLimb(outcome, 128.6, 127.3, 105, 0.3)
		expect(outcome.limb.coverage).toBeGreaterThan(0.9)
	})

	test('excessive image-edge clipping fails', () => {
		const outcome = measure({ x: -20, y: 128, radius: 60 }, { noise: 0.005 })
		expect(outcome.success).toBeFalse()
	})

	test('saturated plateaus keep their geometric edge', () => {
		const outcome = measure({ x: 129.1, y: 126.4, radius: 58, limbDarkening: 0.4 }, { clip: 0.55 })
		expectLimb(outcome, 129.1, 126.4, 58, 0.3)
	})

	test('continuity prior tracks the same limb', () => {
		const prior = { center: [126, 130] as const, semiMajor: 60.5, semiMinor: 60.5, theta: 0 }
		const outcome = measure({ x: 127.2, y: 129.1, radius: 60 }, { noise: 0.005 }, { prior, continuity: true })
		expectLimb(outcome, 127.2, 129.1, 60, 0.2)
	})

	test('continuity prior rejects a radius jump', () => {
		const prior = { center: [128, 128] as const, semiMajor: 54, semiMinor: 54, theta: 0 }
		const outcome = measure({ x: 128, y: 128, radius: 60 }, { noise: 0.005 }, { prior, continuity: true })
		expect(outcome).toMatchObject({ success: false, reason: 'limb_geometry_jump' })
	})

	test('a missing quadrant is reported as an angular gap', () => {
		const invalid = (x: number, y: number) => x > 128 && y > 128
		const outcome = measure({ x: 128, y: 128, radius: 60 }, { invalid }, {}, { maximumGap: PI / 3 })
		expect(outcome).toMatchObject({ success: false, reason: 'limb_large_gap' })
		const tolerant = measure({ x: 128, y: 128, radius: 60 }, { invalid })
		expectLimb(tolerant, 128, 128, 60, 0.2)
		expect(tolerant.limb.maximumGap).toBeGreaterThan(1.3)
	})

	test('a short visible arc is rejected', () => {
		const invalid = (x: number, y: number) => x > 100 || y > 110
		const outcome = measure({ x: 128, y: 128, radius: 60 }, { invalid }, { prior: { center: [128, 128], semiMajor: 60, semiMinor: 60, theta: 0 } })
		expect(outcome.success).toBeFalse()
		if (!outcome.success) expect(['limb_low_coverage', 'limb_large_gap']).toContain(outcome.reason)
	})

	test('flat frames have no limb', () => {
		const outcome = measure({ x: 128, y: 128, radius: 60, brightness: 0 }, { noise: 0.01 })
		expect(outcome).toMatchObject({ success: false, reason: 'limb_not_found' })
	})

	test('CFA green plane maps to image pixels', () => {
		const outcome = measure({ x: 129.3, y: 126.8, radius: 60 }, { cfa: { pattern: 'RGGB', gains: [0.8, 1, 0.6] }, noise: 0.003 })
		expectLimb(outcome, 129.3, 126.8, 60, 0.3)
	})

	test('ROI and seed select the requested object', () => {
		const second = diskScene({ x: 200, y: 200, radius: 20, brightness: 1 })
		const area: Rect = { left: 0, top: 0, right: 180, bottom: 180 }
		const outcome = measure({ x: 90.4, y: 88.7, radius: 50 }, { noise: 0.005 }, { seed: [90, 89] }, {}, area, second)
		expectLimb(outcome, 90.4, 88.7, 50, 0.3)
	})

	test('seed selects its own object among several in the ROI', () => {
		// A larger, brighter disk 62 pixels away would pull a whole-ROI moment window off the small one.
		const small = { x: 88.6, y: 127.4, radius: 20 } as const
		const large = { x: 150.6, y: 127.4, radius: 30 } as const
		const image = renderScene(SIZE, SIZE, addScenes(diskScene(small), diskScene({ ...large, brightness: 1.3 })), { ...BASE, noise: 0.003 })
		const workspace = new SurfaceTrackingWorkspace()

		for (const [target, seed] of [
			[small, [92, 125]],
			[large, [146, 131]],
		] as const) {
			const object = locateBrightObject(image, 'mono', FULL, workspace, DEFAULT_LIMB_TRACKING_OPTIONS, seed)!
			expect(Math.hypot(object.center[0] - target.x, object.center[1] - target.y)).toBeLessThan(0.5)
			// Equivalent-area radius of the selected component only; merged disks would exceed it by far.
			expect(Math.abs(object.radius - target.radius)).toBeLessThan(1)
			expectLimb(measureLimb(image, 'mono', FULL, workspace, DEFAULT_LIMB_TRACKING_OPTIONS, { seed }), target.x, target.y, target.radius, 0.3)
		}

		// A seed in the dark gap selects the nearer object; without a seed the larger one is dominant.
		expectLimb(measureLimb(image, 'mono', FULL, workspace, DEFAULT_LIMB_TRACKING_OPTIONS, { seed: [112, 127] }), small.x, small.y, small.radius, 0.3)
		expectLimb(measureLimb(image, 'mono', FULL, workspace), large.x, large.y, large.radius, 0.3)
	})
})
