import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import type { GuideTrackerContext, GuideTrackingPhase } from '../../../src/observation/guiding/tracker'
import { SolarSystemTracker, type SolarSystemTrackerOptions, type SolarSystemTrackerResult, solarSystemTrackingOf } from '../../../src/observation/guiding/tracker.solarsystem'
import { addScenes, diskScene, moveScenePoint, type RenderOptions, renderScene, type Scene, type SceneMotion, seeingWarp, spotsScene, textureScene } from '../../util/scene'

const SIZE = 320
const CENTER = 159.5
const SURFACE = textureScene(21, SIZE, SIZE, 1400)
const PLANET_TEXTURE = textureScene(7, SIZE, SIZE, 500, 2, 6)
const EVOLVED = textureScene(33, SIZE, SIZE, 1400)

let frameId = 0

function context(phase: GuideTrackingPhase = 'guiding', extra: Partial<GuideTrackerContext> = {}): GuideTrackerContext {
	return { phase, allowAcquisition: true, preserveIdentity: true, ...extra }
}

function frame(image: Image | undefined, width: number = SIZE, height: number = SIZE) {
	return { image, width, height, timestamp: 1000 * ++frameId, frameId }
}

function render(scene: Scene, options: RenderOptions = {}) {
	return renderScene(SIZE, SIZE, scene, { gain: 0.6, offset: 0.1, noise: 0.003, seed: frameId + 1, ...options })
}

function track(tracker: SolarSystemTracker, image: Image | undefined, ctx: GuideTrackerContext = context(), commit: boolean = true) {
	const result = tracker.track(frame(image), ctx)
	if (commit && result.measurement !== undefined) tracker.commit()
	return result
}

function expectPoint(result: SolarSystemTrackerResult, x: number, y: number, tolerance: number) {
	if (result.measurement === undefined) throw new Error(`no measurement: ${JSON.stringify(result.rejectedReasons)} ${result.notes.join(',')}`)
	expect(Math.abs(result.measurement.x - x)).toBeLessThan(tolerance)
	expect(Math.abs(result.measurement.y - y)).toBeLessThan(tolerance)
}

function planet(x: number = 158.3, y: number = 161.7, rest: Partial<Parameters<typeof diskScene>[0]> = {}) {
	return diskScene({ x, y, radius: 55, limbDarkening: 0.4, texture: PLANET_TEXTURE, textureAmplitude: 0.15, ...rest })
}

function lunarTracker(options: Partial<SolarSystemTrackerOptions> = {}) {
	return new SolarSystemTracker({ mode: 'lunar', plane: 'mono', ...options })
}

describe('planetary', () => {
	test('objectCenter acquires the limb center and follows drift', () => {
		const tracker = new SolarSystemTracker({ mode: 'planetary' })
		const scene = planet()
		const first = track(tracker, render(scene), context('selected', { preserveIdentity: false }))
		expectPoint(first, 158.3, 161.7, 0.3)
		expect(first.notes).toContain('acquired')
		expect(first.solarSystem.targetMode).toBe('objectCenter')
		expect(first.solarSystem.limb).toBeDefined()
		expect(first.targetEnvelope).toBeDefined()

		for (let i = 1; i <= 6; i++) {
			const motion: SceneMotion = { dx: 0.7 * i, dy: -0.45 * i }
			const result = track(tracker, render(scene, { motion }))
			expectPoint(result, 158.3 + motion.dx, 161.7 + motion.dy, 0.35)
			expect(result.measurementMode).toBe('hybrid')
			expect(result.solarSystem.state).toBe('tracking')
			expect(result.solarSystem.surface?.acceptedPatches).toBeGreaterThan(2)
		}
	})

	test('rotating cloud texture does not move the object center', () => {
		const tracker = new SolarSystemTracker({ mode: 'planetary' })
		const scene = planet(160, 158)
		track(tracker, render(scene), context('selected', { preserveIdentity: false }))

		for (let i = 1; i <= 4; i++) {
			const result = track(tracker, render(scene, { motion: { dx: 0, dy: 0, rotation: 0.004 * i, centerX: 160, centerY: 158 } }))
			expectPoint(result, 160, 158, 0.35)
		}
	})

	test('ringed planet falls back to an apparent-object anchor and tracks motion', () => {
		const tracker = new SolarSystemTracker({ mode: 'planetary' })
		const scene = diskScene({ x: 160, y: 160, radius: 40, texture: PLANET_TEXTURE, textureAmplitude: 0.2, ring: { inner: 52, outer: 90, axisRatio: 0.35, brightness: 0.8 } })
		const first = track(tracker, render(scene), context('selected', { preserveIdentity: false }))
		expect(first.measurement).toBeDefined()
		expect(first.notes).toContain('apparent_object_anchor')
		const x0 = first.measurement!.x
		const y0 = first.measurement!.y

		const result = track(tracker, render(scene, { motion: { dx: 2.4, dy: -1.6 } }))
		expectPoint(result, x0 + 2.4, y0 - 1.6, 0.3)
		expect(result.measurementMode).toBe('surface')
	})

	test('a target near the detector edge is reported outside the envelope', () => {
		const tracker = new SolarSystemTracker({ mode: 'planetary' })
		const result = track(tracker, render(planet(58, 160)), context('selected', { preserveIdentity: false }))
		expectPoint(result, 58, 160, 0.4)
		expect(result.targetEnvelope!.minX).toBeGreaterThan(55)
		expect(result.notes).toContain('target_near_edge')
	})
})

describe('lunar', () => {
	test('surfacePoint follows translation and rotation without a limb', () => {
		const tracker = lunarTracker()
		const point = [151.2, 166.8] as const
		const first = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4 }), context('selected', { preserveIdentity: false, searchPosition: point }))
		expectPoint(first, point[0], point[1], 1e-9)
		expect(first.solarSystem.targetMode).toBe('surfacePoint')

		for (let i = 1; i <= 5; i++) {
			const motion: SceneMotion = { dx: 1.3 * i, dy: 0.9 * i, rotation: 0.003 * i, centerX: CENTER, centerY: CENTER }
			const [x, y] = moveScenePoint(motion, point[0], point[1])
			const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion }))
			expectPoint(result, x, y, 0.2)
			expect(result.solarSystem.rotation).toBeCloseTo(0.003 * i, 3)
			expect(result.solarSystem.limb).toBeUndefined()
		}
	})

	test('differential seeing is absorbed by the robust rigid fit', () => {
		const tracker = lunarTracker()
		const point = [160, 160] as const
		track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4 }), context('selected', { preserveIdentity: false, searchPosition: point }))
		const motion: SceneMotion = { dx: -2.2, dy: 1.7 }
		const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion, warp: seeingWarp(0.6, 70, 0.4) }))
		const [x, y] = moveScenePoint(motion, point[0], point[1])
		expectPoint(result, x, y, 0.35)
		expect(result.solarSystem.surface!.deformationRms).toBeGreaterThan(0)
	})

	test('keyframes are promoted, bounded and stay consistent with the anchor', () => {
		const tracker = lunarTracker({ reference: { keyframeInterval: 2, keyframeIntervalTime: 0, maximumKeyframes: 2, anchorCheckInterval: 3, anchorCheckIntervalTime: 0 } })
		const point = [160, 160] as const
		track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4 }), context('selected', { preserveIdentity: false, searchPosition: point }))
		let generation = 0
		let checked = false

		for (let i = 1; i <= 10; i++) {
			const motion: SceneMotion = { dx: 1.1 * i, dy: -0.6 * i }
			const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion }))
			const [x, y] = moveScenePoint(motion, point[0], point[1])
			expectPoint(result, x, y, 0.25)
			const reference = result.solarSystem.reference!
			expect(reference.bankSize).toBeLessThanOrEqual(3)
			generation = Math.max(generation, reference.generation)
			checked ||= reference.directAnchorCheck
		}

		expect(generation).toBeGreaterThan(1)
		expect(checked).toBeTrue()
	})

	test('a jump beyond the patch search radius is reacquired', () => {
		const tracker = lunarTracker()
		const point = [160, 160] as const
		track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4 }), context('selected', { preserveIdentity: false, searchPosition: point }))
		const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 31.4, dy: -22.6 } }), context('lostLock'))
		expectPoint(result, 191.4, 137.4, 0.25)
		expect(result.measurementMode).toBe('surfaceReacquired')
	})

	test('calibration widens the search to the calibrator jump budget', () => {
		const tracker = lunarTracker()
		const point = [160, 160] as const
		track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4 }), context('selected', { preserveIdentity: false, searchPosition: point }))
		const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 11.3, dy: 0 } }), context('calibrating', { maxMeasurementJumpPx: 14, allowAcquisition: false }))
		expectPoint(result, 171.3, 160, 0.2)
		expect(result.measurementMode).toBe('surface')
	})
})

describe('solar', () => {
	const sun = addScenes(
		diskScene({ x: 161.4, y: 158.2, radius: 120, limbDarkening: 0.6, texture: SURFACE, textureAmplitude: 0.15 }),
		spotsScene([
			[140, 150, 4, -0.5],
			[185, 170, 3, -0.6],
			[160, 120, 2.5, -0.4],
		]),
	)

	test('objectCenter measures the full-disk limb center', () => {
		const tracker = new SolarSystemTracker({ mode: 'solar', targetMode: 'objectCenter', acquisition: { maximumAreaSize: 320 } })
		const first = track(tracker, render(sun, { gain: 0.5, offset: 0.2 }), context('selected', { preserveIdentity: false }))
		expectPoint(first, 161.4, 158.2, 0.3)
		const result = track(tracker, render(sun, { gain: 0.5, offset: 0.2, motion: { dx: 1.5, dy: 1.1 } }))
		expectPoint(result, 162.9, 159.3, 0.35)
	})

	test('surfacePoint on a sunspot selects the strongest color plane automatically', () => {
		const tracker = new SolarSystemTracker({ mode: 'solar' })
		const options: RenderOptions = { gain: 0.5, offset: 0.2, rgb: [1, 0.5, 0.15], noise: 0.01 }
		const first = track(tracker, render(sun, options), context('selected', { preserveIdentity: false, searchPosition: [150, 155] }))
		expect(first.measurement).toBeDefined()
		expect(first.solarSystem.plane).toBe('red')
		const motion: SceneMotion = { dx: -1.8, dy: 2.3 }
		const result = track(tracker, render(sun, { ...options, motion }))
		expectPoint(result, 148.2, 157.3, 0.25)
	})

	test('prominences beyond the limb do not bias the center', () => {
		const prominences = spotsScene([
			[161.4 + 128, 158.2, 3, 0.4],
			[161.4, 158.2 - 129, 2.5, 0.5],
		])
		const tracker = new SolarSystemTracker({ mode: 'solar', targetMode: 'objectCenter', acquisition: { maximumAreaSize: 320 } })
		const result = track(tracker, render(addScenes(sun, prominences), { gain: 0.5, offset: 0.2 }), context('selected', { preserveIdentity: false }))
		expectPoint(result, 161.4, 158.2, 0.35)
	})
})

describe('lifecycle', () => {
	const image0 = render(SURFACE, { gain: 0.15, offset: 0.4 })

	test('uncommitted frames do not advance identity', () => {
		const tracker = lunarTracker()
		track(tracker, image0, context('selected', { preserveIdentity: false, searchPosition: [160, 160] }))
		const staged = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 6, dy: 0 } }), context(), false)
		expectPoint(staged, 166, 160, 0.2)
		// The next frame is predicted from the committed state, not the staged one.
		const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 0.5, dy: 0 } }))
		expectPoint(result, 160.5, 160, 0.2)
		expect(result.solarSystem.predictedTarget![0]).toBeCloseTo(160, 6)
	})

	test('missing images and disabled acquisition publish no measurement', () => {
		const tracker = lunarTracker()
		const missing = track(tracker, undefined)
		expect(missing.measurement).toBeUndefined()
		expect(missing.rejectedReasons.image_unavailable).toBe(1)
		const disabled = track(tracker, image0, context('guiding', { allowAcquisition: false }))
		expect(disabled.measurement).toBeUndefined()
		expect(disabled.notes).toContain('acquisition_disabled')
	})

	test('failures degrade and then lose the target without moving identity', () => {
		const tracker = lunarTracker({ acquisition: { lostAfter: 2 } })
		track(tracker, image0, context('selected', { preserveIdentity: false, searchPosition: [160, 160] }))
		const flat = renderScene(SIZE, SIZE, () => 0, { offset: 0.4, noise: 0.003, seed: 5 })
		expect(track(tracker, flat).solarSystem.state).toBe('degraded')
		expect(track(tracker, flat).solarSystem.state).toBe('lost')
		const result = track(tracker, render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 1, dy: 1 } }))
		expectPoint(result, 161, 161, 0.2)
		expect(result.solarSystem.state).toBe('tracking')
	})

	test('reset and geometry changes force reacquisition', () => {
		const tracker = lunarTracker()
		track(tracker, image0, context('selected', { preserveIdentity: false, searchPosition: [160, 160] }))
		tracker.reset()
		expect(tracker.lastResult).toBeUndefined()
		expect(track(tracker, image0, context('selected', { searchPosition: [150, 150] })).notes).toContain('acquired')
		const small = renderScene(256, 256, SURFACE, { gain: 0.15, offset: 0.4 })
		const result = tracker.track(frame(small, 256, 256), context('guiding', { searchPosition: [128, 128] }))
		expect(result.notes).toContain('acquired')
	})

	test('select is non-mutating and honors the envelope', () => {
		const tracker = new SolarSystemTracker({ mode: 'planetary' })
		const result = track(tracker, render(planet()), context('selected', { preserveIdentity: false }))
		const last = tracker.lastResult
		const center = tracker.select(result)!
		expect(center[0]).toBeCloseTo(result.solarSystem.limb!.center[0], 9)
		expect(tracker.select(result, [170, 150])).toEqual([result.solarSystem.limb!.center[0], result.solarSystem.limb!.center[1]])
		expect(tracker.select(result, [300, 20])).toBeUndefined()
		expect(tracker.select(result, [240, 200])).toEqual([240, 200])
		expect(tracker.lastResult).toBe(last)
		expect(solarSystemTrackingOf({ candidateCount: 0, acceptedCount: 0, qualityScore: 0, rejectedReasons: {}, notes: [] })).toBeUndefined()
	})
})

// Appended last: every rendered frame advances the shared noise seed of later tests.
describe('identity evolution', () => {
	test('a surface-only apparent anchor is promoted to a converging limb anchor', () => {
		const tracker = new SolarSystemTracker({ mode: 'planetary' })
		// Unusable pixels right of x = 175 (clipping, an obstruction) leave a limb gap wider than the limb gate
		// and pull the apparent-object anchor about 14 px off the true center, while the texture still registers.
		const clipped = render(planet(), { invalid: (x) => x > 175 })
		const first = track(tracker, clipped, context('selected', { preserveIdentity: false }))
		expect(first.notes).toContain('apparent_object_anchor')
		expect(first.measurementMode).toBe('surface')
		const initialOffset = 158.3 - first.measurement!.x
		expect(initialOffset).toBeGreaterThan(5)
		let promoted = 0

		for (let i = 1; i <= 30; i++) {
			const result = track(tracker, render(planet()))
			if (result.measurement === undefined) throw new Error(`no measurement: ${JSON.stringify(result.rejectedReasons)}`)
			if (result.notes.includes('limb_anchored')) promoted++
			expect(result.measurementMode).toBe('hybrid')
			// Fusion moves the surface-transported point by only the limb-gain fraction of its limb offset.
			const raw = result.solarSystem.rawTarget!
			const limb = result.solarSystem.limb!.center
			const step = Math.hypot(result.measurement.x - raw[0], result.measurement.y - raw[1])
			expect(step).toBeLessThan(0.1 * Math.hypot(limb[0] - raw[0], limb[1] - raw[1]) + 1e-9)
		}

		expect(promoted).toBe(1)
		// The surface anchor is kept and the target has converged onto the limb center: 0.9^30 of the offset remains.
		const last = tracker.lastResult!
		expect(last.solarSystem.reference!.bankSize).toBeGreaterThan(0)
		expectPoint(last, 158.3, 161.7, 0.1 * initialOffset + 0.3)
		expect(last.solarSystem.state).toBe('tracking')
	})

	test('a limb-only identity gains a surface anchor once structure appears', () => {
		// The structure floor rejects the curvature of a featureless limb but not cloud bands.
		const tracker = new SolarSystemTracker({ mode: 'planetary', surface: { minimumStructure: 20 }, reference: { anchorCheckInterval: 2, anchorCheckIntervalTime: 0 } })
		const smooth = planet(158.3, 161.7, { texture: undefined })
		const textured = planet(158.3, 161.7, { textureAmplitude: 0.3 })
		const first = track(tracker, render(smooth), context('selected', { preserveIdentity: false }))
		expectPoint(first, 158.3, 161.7, 0.3)
		expect(first.measurementMode).toBe('limb')
		expect(first.solarSystem.reference!.bankSize).toBe(0)

		expect(track(tracker, render(smooth, { motion: { dx: 0.4, dy: 0 } })).measurementMode).toBe('limb')
		let anchored: SolarSystemTrackerResult | undefined
		let dx = 0.4

		for (let i = 2; i <= 4 && anchored === undefined; i++) {
			dx = 0.4 * i
			const result = track(tracker, render(textured, { motion: { dx, dy: 0 } }))
			expectPoint(result, 158.3 + dx, 161.7, 0.3)
			if (result.notes.includes('surface_anchored')) anchored = result
		}

		expect(anchored).toBeDefined()
		expect(anchored!.measurementMode).toBe('limb')
		expect(anchored!.solarSystem.reference!.bankSize).toBe(1)
		// The anchor is tied to the published point: an unchanged scene keeps the target where it was.
		const anchorTarget = anchored!.measurement!
		const still = track(tracker, render(textured, { motion: { dx, dy: 0 } }))
		expect(still.measurementMode).toBe('hybrid')
		expect(Math.abs(still.measurement!.x - anchorTarget.x)).toBeLessThan(0.1)
		expect(Math.abs(still.measurement!.y - anchorTarget.y)).toBeLessThan(0.1)

		for (let i = 1; i <= 3; i++) {
			const result = track(tracker, render(textured, { motion: { dx: dx + 0.7 * i, dy: 0 } }))
			expect(result.measurementMode).toBe('hybrid')
			expectPoint(result, anchorTarget.x + 0.7 * i, anchorTarget.y, 0.15)
		}
	})

	// Adjacent frames stay correlated while the anchor texture fades into a second texture that slides 0.1 px
	// per frame, so every keyframe generation inherits a small systematic bias the anchor can no longer check.
	function evolving(i: number): Scene {
		const weight = Math.min(1, i / 16)
		const shift = 0.1 * i
		return (x, y) => (1 - weight) * SURFACE(x, y) + weight * EVOLVED(x - shift, y)
	}

	function unverifiedChain(maximumAnchorCheckFailures: number, frames: number) {
		const tracker = lunarTracker({ reference: { keyframeInterval: 2, keyframeIntervalTime: 0, maximumKeyframes: 2, anchorCheckInterval: 3, anchorCheckIntervalTime: 0, maximumAnchorCheckFailures }, acquisition: { lostAfter: 3 } })
		track(tracker, render(evolving(0), { gain: 0.15, offset: 0.4 }), context('selected', { preserveIdentity: false, searchPosition: [160, 160] }))
		return Array.from({ length: frames }, (_, i) => track(tracker, render(evolving(i + 1), { gain: 0.15, offset: 0.4 })))
	}

	test('failed direct anchor checks degrade, freeze promotion and then withhold the drifting chain', () => {
		const results = unverifiedChain(2, 20)
		let maximumError = 0
		let promotedWhileUnverified = false

		for (const result of results) {
			if (result.measurement !== undefined) maximumError = Math.max(maximumError, Math.hypot(result.measurement.x - 160, result.measurement.y - 160))
			const unverified = result.solarSystem.reference !== undefined && result.solarSystem.reference.anchorCheckFailures > 0
			if (unverified) expect(result.solarSystem.state).toBe('degraded')
			promotedWhileUnverified ||= unverified && result.notes.includes('keyframe_staged')
		}

		expect(results.some((result) => result.solarSystem.state === 'degraded' && result.notes.includes('anchor_unverified') && result.measurement !== undefined)).toBeTrue()
		expect(promotedWhileUnverified).toBeFalse()
		expect(maximumError).toBeLessThan(0.75)
		const last = results.at(-1)!
		expect(last.measurement).toBeUndefined()
		expect(last.rejectedReasons.anchor_unverified).toBe(1)
		expect(last.solarSystem.state).toBe('lost')

		// Control: without the limit the same unverified chain keeps publishing and walks off the feature.
		const unlimited = unverifiedChain(Number.POSITIVE_INFINITY, 26).at(-1)!
		expect(unlimited.measurement!.x - 160).toBeGreaterThan(1.2)
		expect(unlimited.solarSystem.state).toBe('degraded')
	})

	test('time-based maintenance throttles high-rate streams', () => {
		const tracker = lunarTracker({ reference: { keyframeInterval: 2, keyframeIntervalTime: 2000, maximumKeyframes: 2 } })
		const point = [160, 160] as const
		const at = (image: Image, ms: number, ctx: GuideTrackerContext = context()) => {
			const result = tracker.track({ image, width: SIZE, height: SIZE, timestamp: 5e6 + ms, captureMonotonic: ms, frameId: ++frameId }, ctx)
			if (result.measurement !== undefined) tracker.commit()
			return result
		}

		at(render(SURFACE, { gain: 0.15, offset: 0.4 }), 0, context('selected', { preserveIdentity: false, searchPosition: point }))
		let staged = 0

		// 100 frames/s: the frame count is reached every second frame, but only the elapsed capture time promotes.
		for (let i = 1; i <= 30; i++) {
			const result = at(render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 0.01 * i, dy: 0 } }), 10 * i)
			if (result.notes.includes('keyframe_staged')) staged++
		}

		expect(staged).toBe(0)
		const later = at(render(SURFACE, { gain: 0.15, offset: 0.4, motion: { dx: 0.3, dy: 0 } }), 2010)
		expect(later.notes).toContain('keyframe_staged')
	})
})
