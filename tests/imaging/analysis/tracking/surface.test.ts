import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { applyRigidTransform, composeRigidTransforms, createSurfaceReference, DEFAULT_SURFACE_TRACKING_OPTIONS, fitRigidTransform, IDENTITY_RIGID_TRANSFORM, invertRigidTransform, reacquireSurface, registerSurface, rigidTransformThrough, type SurfaceReference, type SurfaceRegistration, type SurfaceTrackingOptions, selectSurfacePlane, } from '../../../../src/imaging/analysis/tracking/surface'
import { TAU } from '../../../../src/core/constants'
import { SurfaceTrackingWorkspace } from '../../../../src/imaging/analysis/tracking/workspace'
import type { Rect } from '../../../../src/math/numerical/geometry'
import { moveScenePoint, type RenderOptions, renderScene, type Scene, type SceneMotion, seeingWarp, spotsScene, textureScene } from '../../../util/scene'

const SIZE = 256
const AREA: Rect = { left: 64, top: 64, right: 192, bottom: 192 }
const TEXTURE = textureScene(11, SIZE, SIZE, 900)
const BASE: RenderOptions = { gain: 0.15, offset: 0.4 }

function render(scene: Scene, options: RenderOptions = {}) {
	return renderScene(SIZE, SIZE, scene, { ...BASE, ...options })
}

function reference(scene: Scene = TEXTURE, options: Partial<SurfaceTrackingOptions> = {}, render0: RenderOptions = {}, area: Rect = AREA) {
	const workspace = new SurfaceTrackingWorkspace()
	const outcome = createSurfaceReference(render(scene, render0), area, 'mono', workspace, { ...DEFAULT_SURFACE_TRACKING_OPTIONS, ...options })
	if (!outcome.success) throw new Error(`reference failed: ${outcome.reason}`)
	return { reference: outcome.reference, workspace, options: { ...DEFAULT_SURFACE_TRACKING_OPTIONS, ...options } }
}

function register(context: { reference: SurfaceReference; workspace: SurfaceTrackingWorkspace; options: SurfaceTrackingOptions }, motion: SceneMotion, options: RenderOptions = {}, scene: Scene = TEXTURE) {
	return registerSurface(context.reference, render(scene, { motion, ...options }), IDENTITY_RIGID_TRANSFORM, context.workspace, context.options)
}

function expectMotion(
	result: ReturnType<typeof registerSurface>,
	motion: SceneMotion,
	tolerance: number,
	points: readonly (readonly [number, number])[] = [
		[128, 128],
		[80, 90],
		[170, 160],
	],
): asserts result is SurfaceRegistration {
	expect(result.success).toBeTrue()
	if (!result.success) return

	for (const [x, y] of points) {
		const [ex, ey] = moveScenePoint(motion, x, y)
		const [ax, ay] = applyRigidTransform(result.transform, x, y)
		expect(Math.abs(ax - ex)).toBeLessThan(tolerance)
		expect(Math.abs(ay - ey)).toBeLessThan(tolerance)
	}
}

describe('rigid transforms', () => {
	test('compose, invert and through are consistent', () => {
		const a = { rotation: 0.3, translation: [5, -2] as const }
		const b = { rotation: -0.1, translation: [1, 7] as const }
		const ab = composeRigidTransforms(a, b)
		const [x, y] = applyRigidTransform(b, 13, 4)
		const [ex, ey] = applyRigidTransform(a, x, y)
		const [cx, cy] = applyRigidTransform(ab, 13, 4)
		expect(cx).toBeCloseTo(ex, 12)
		expect(cy).toBeCloseTo(ey, 12)

		const identity = composeRigidTransforms(invertRigidTransform(a), a)
		expect(identity.rotation).toBeCloseTo(0, 14)
		expect(identity.translation[0]).toBeCloseTo(0, 12)
		expect(identity.translation[1]).toBeCloseTo(0, 12)

		const through = rigidTransformThrough(0.2, 10, 20, 3, -4)
		const [tx, ty] = applyRigidTransform(through, 10, 20)
		expect(tx).toBeCloseTo(13, 12)
		expect(ty).toBeCloseTo(16, 12)
	})

	test('robust fit rejects a gross outlier and recovers rotation', () => {
		const count = 8
		const px = new Float64Array(count)
		const py = new Float64Array(count)
		const qx = new Float64Array(count)
		const qy = new Float64Array(count)
		const weights = new Float64Array(count).fill(1)
		const truth = { rotation: 0.02, translation: [3, -1] as const }

		for (let i = 0; i < count; i++) {
			px[i] = 100 + 40 * Math.cos(i)
			py[i] = 100 + 40 * Math.sin(i * 1.7)
			const [x, y] = applyRigidTransform(truth, px[i], py[i])
			qx[i] = x + (i === 3 ? 9 : 0)
			qy[i] = y
		}

		const inliers = new Uint8Array(count)
		const fit = fitRigidTransform(px, py, qx, qy, weights, count, { model: 'rigid', rotation: 0, outlierThreshold: 4, minimumResidualScale: 0.05 }, new Float64Array(2 * count), inliers)!
		expect(fit.inliers).toBe(7)
		expect(inliers[3]).toBe(0)
		expect(fit.transform.rotation).toBeCloseTo(0.02, 8)
		expect(fit.transform.translation[0]).toBeCloseTo(3, 6)
		expect(fit.transform.translation[1]).toBeCloseTo(-1, 6)
		expect(fit.rms).toBeLessThan(1e-6)
	})
})

describe('surface registration', () => {
	test('selects distributed patches', () => {
		const { reference: r } = reference()
		expect(r.patches.length).toBeGreaterThanOrEqual(8)
		expect(r.patches.length).toBeLessThanOrEqual(DEFAULT_SURFACE_TRACKING_OPTIONS.maximumPatches)
		let cells = 0
		for (let b = r.coverageCells; b !== 0; b &= b - 1) cells++
		expect(cells).toBe(9)
		expect(r.coarse).toBeDefined()
	})

	test('translation', () => {
		const context = reference()
		const motion = { dx: 3.4, dy: -2.7 }
		const result = register(context, motion)
		expectMotion(result, motion, 0.05)
		expect(result.acceptedPatches).toBe(result.candidatePatches)
		expect(result.confidence).toBeGreaterThan(0.8)
	})
})

describe('surface robustness', () => {
	const OTHER = textureScene(99, SIZE, SIZE, 900)

	// Replaces reference content inside squares centered on the given image points (changed features).
	function corrupt(centers: readonly (readonly [number, number])[], half: number = 14): Scene {
		return (x, y) => {
			for (const [cx, cy] of centers) if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half) return OTHER(x, y)
			return TEXTURE(x, y)
		}
	}

	test('translation with small rotation', () => {
		const context = reference()
		const motion = { dx: 2.2, dy: 1.1, rotation: 0.01, centerX: 128, centerY: 128 }
		const result = register(context, motion)
		expectMotion(result, motion, 0.06)
		expect(result.model).toBe('rigid')
		expect(result.transform.rotation).toBeCloseTo(0.01, 3)
	})

	test('rotation around a selected target transports that point', () => {
		const context = reference()
		const motion = { dx: 1, dy: 0.5, rotation: 0.015, centerX: 100, centerY: 140 }
		const result = register(context, motion)
		expectMotion(result, motion, 0.06, [[100, 140]])
	})

	test('one corrupted patch is rejected by consensus', () => {
		const context = reference()
		const patch = context.reference.patches[0]
		const motion = { dx: -1.6, dy: 2.3 }
		const result = register(context, motion, {}, corrupt([[patch.x, patch.y]]))
		expectMotion(result, motion, 0.06)
		expect(result.acceptedPatches).toBeLessThan(result.candidatePatches)
	})

	test('25% corrupted patches do not bias the transform', () => {
		const context = reference()
		const patches = context.reference.patches
		const corrupted = patches.slice(0, Math.ceil(patches.length / 4)).map((p) => [p.x, p.y] as const)
		const motion = { dx: 0.7, dy: -3.2 }
		const result = register(context, motion, {}, corrupt(corrupted))
		expectMotion(result, motion, 0.08)
		expect(result.acceptedPatches).toBeLessThanOrEqual(patches.length - corrupted.length + 1)
	})

	test('obscured quadrant keeps tracking with reduced coverage', () => {
		const context = reference()
		const motion = { dx: 1.3, dy: 0.4 }
		const result = register(context, motion, { invalid: (x, y) => x < 128 && y < 128 })
		expectMotion(result, motion, 0.06, [
			[128, 128],
			[170, 160],
		])
		expect(result.spatialCoverage).toBeLessThan(1)
		expect(result.spatialCoverage).toBeGreaterThanOrEqual(0.5)
	})

	test('local seeing warp is averaged by the rigid fit', () => {
		const context = reference()
		const motion = { dx: 2.5, dy: -1.5 }
		const result = register(context, motion, { warp: seeingWarp(0.4, 45, 0.3) })
		expectMotion(result, motion, 0.3)
		expect(result.deformationRms).toBeGreaterThan(0.05)
	})

	test('global tip-tilt plus local deformation follows the global shift', () => {
		const context = reference()
		const motion = { dx: 4.2, dy: 3.1 }
		const result = register(context, motion, { warp: seeingWarp(0.25, 30, 1.1) })
		expectMotion(result, motion, 0.25)
	})

	test('photometric gradient and gain change are tolerated', () => {
		const context = reference()
		const motion = { dx: -2.4, dy: -0.8 }
		expectMotion(register(context, motion, { gradient: [0.0012, -0.0009] }), motion, 0.06)
		expectMotion(register(context, motion, { gain: 0.08, offset: 0.25 }), motion, 0.06)
	})

	test('noise keeps sub-tenth-pixel accuracy', () => {
		const context = reference()
		const motion = { dx: 1.8, dy: 2.6 }
		const result = register(context, motion, { noise: 0.004, seed: 7 })
		expectMotion(result, motion, 0.1)
		expect(result.uncertainty).toBeLessThan(0.2)
	})

	test('saturated samples are excluded', () => {
		const options = { saturationLevel: 0.55 }
		const context = reference(TEXTURE, options, { clip: 0.55 })
		const motion = { dx: 1.1, dy: -1.9 }
		const result = register(context, motion, { clip: 0.55 })
		expectMotion(result, motion, 0.08)
	})

	test('partial clipping by the image edge keeps enough support', () => {
		const area = { left: 0, top: 64, right: 128, bottom: 192 }
		const context = reference(TEXTURE, {}, {}, area)
		const motion = { dx: -7, dy: 1.5 }
		const result = register(context, motion)
		expectMotion(result, motion, 0.08, [[64, 128]])
	})

	test('repeated texture is rejected as ambiguous', () => {
		const periodic: Scene = (x, y) => Math.sin((TAU * x) / 6) * Math.sin((TAU * y) / 6)
		const context = reference(periodic)
		const result = register(context, { dx: 1, dy: 0 }, {}, periodic)
		expect(result.success).toBeFalse()
		expect(result.rejectedReasons.correlationAmbiguous).toBeGreaterThan(0)
	})

	test('support confined to one corner fails coverage', () => {
		const context = reference()
		const result = register(context, { dx: 1, dy: 1 }, { invalid: (x, y) => !(x < 110 && y < 110) })
		expect(result.success).toBeFalse()
		if (!result.success) expect(['insufficient_spatial_coverage', 'insufficient_inliers']).toContain(result.reason)
	})

	test('collinear features fall back to translation', () => {
		const spots: [number, number, number, number][] = []
		for (let x = 66; x <= 190; x += 14) spots.push([x, 128, 2.2, 3])
		const line = spotsScene(spots)
		const context = reference(line, { minimumInliers: 2, minimumSpatialCoverage: 0.3 })
		const motion = { dx: 1.7, dy: -0.6 }
		const result = register(context, motion, {}, line)
		expectMotion(result, motion, 0.08, [[128, 128]])
		expect(result.model).toBe('translation')
		expect(result.transform.rotation).toBe(0)
	})

	test('flat ROI cannot create a reference', () => {
		const outcome = createSurfaceReference(
			render(() => 0),
			AREA,
			'mono',
			new SurfaceTrackingWorkspace(),
		)
		expect(outcome.success).toBeFalse()
		if (!outcome.success) expect(outcome.reason).toBe('low_structure')
	})

	test('bad predictor is recovered by coarse phase correlation', () => {
		const context = reference()
		const motion = { dx: 21.3, dy: -16.6 }
		const image = render(TEXTURE, { motion })
		const direct = registerSurface(context.reference, image, IDENTITY_RIGID_TRANSFORM, context.workspace, context.options)
		expect(direct.success && Math.hypot(direct.transform.translation[0] - 21.3, direct.transform.translation[1] + 16.6) < 0.2).toBeFalse()

		const result = reacquireSurface(context.reference, image, IDENTITY_RIGID_TRANSFORM, context.workspace, context.options)
		expectMotion(result, motion, 0.08)
		expect(result.reacquired).toBeTrue()
	})

	test('CFA plane coordinates map to full-frame pixels', () => {
		const cfa = { pattern: 'RGGB', gains: [0.7, 1, 0.5] } as const
		const area = { left: 32, top: 32, right: 224, bottom: 224 }
		const workspace = new SurfaceTrackingWorkspace()
		const options = { ...DEFAULT_SURFACE_TRACKING_OPTIONS, patchSize: 24 }
		const outcome = createSurfaceReference(render(TEXTURE, { cfa }), area, 'green1', workspace, options)
		expect(outcome.success).toBeTrue()
		if (!outcome.success) return
		expect(outcome.reference.step).toBe(2)
		const motion = { dx: 3.3, dy: -2.1 }
		const result = registerSurface(outcome.reference, render(TEXTURE, { cfa, motion }), IDENTITY_RIGID_TRANSFORM, workspace, options)
		expectMotion(result, motion, 0.12)
	})

	test('automatic plane selection prefers the highest-contrast channel', () => {
		const image = render(TEXTURE, { rgb: [0.2, 1, 0.05], noise: 0.003 })
		expect(selectSurfacePlane(image, AREA, new SurfaceTrackingWorkspace())).toBe('green')
		const mono = render(TEXTURE)
		expect(selectSurfacePlane(mono, AREA, new SurfaceTrackingWorkspace())).toBe('mono')
	})

	test('steady-state registration is deterministic', () => {
		const context = reference()
		const motion = { dx: 0.9, dy: 0.3 }
		const image = render(TEXTURE, { motion })
		const a = registerSurface(context.reference, image, IDENTITY_RIGID_TRANSFORM, context.workspace, context.options)
		const b = registerSurface(context.reference, image, IDENTITY_RIGID_TRANSFORM, context.workspace, context.options)
		expect(a).toEqual(b)
	})
})
