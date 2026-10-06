import { describe, expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import type { GuideTrackerContext, GuideTrackingPhase } from '../../../src/observation/guiding/tracker'
import { SolarSystemTracker, type SolarSystemTrackerOptions, type SolarSystemTrackerResult, solarSystemTrackingOf } from '../../../src/observation/guiding/tracker.solarsystem'
import { addScenes, diskScene, moveScenePoint, type RenderOptions, renderScene, type Scene, type SceneMotion, seeingWarp, spotsScene, textureScene } from '../../util/scene'

const SIZE = 320
const CENTER = 159.5
const SURFACE = textureScene(21, SIZE, SIZE, 1400)
const PLANET_TEXTURE = textureScene(7, SIZE, SIZE, 500, 2, 6)

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
		const tracker = lunarTracker({ reference: { keyframeInterval: 2, maximumKeyframes: 2, anchorCheckInterval: 3 } })
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
