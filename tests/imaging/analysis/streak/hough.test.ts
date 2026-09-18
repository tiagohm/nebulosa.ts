import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../../src/core/constants'
import { streakAxialAngleDistance } from '../../../../src/imaging/analysis/streak/geometry'
import { collectStreakEdges, detectStreakHoughCandidates, MAX_STREAK_HOUGH_RHO_WORK, MAX_STREAK_LOCAL_ANGLE_VOTES, type StreakEdgePoints } from '../../../../src/imaging/analysis/streak/hough'
import { preprocessStreakImage } from '../../../../src/imaging/analysis/streak/preprocess'
import { createStreakDetectionWorkspace } from '../../../../src/imaging/analysis/streak/workspace'
import type { Image } from '../../../../src/imaging/model/types'

function image(raw: Float32Array, width: number, height: number): Image {
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function edges(lines: readonly { readonly angle: number; readonly rho: number; readonly weight?: number }[], width: number, height: number, angleCount: number = 180): StreakEdgePoints {
	const x: number[] = []
	const y: number[] = []
	const weight: number[] = []
	const angleBin: number[] = []
	const step = PI / angleCount
	for (const line of lines) {
		const tangentX = Math.cos(line.angle)
		const tangentY = Math.sin(line.angle)
		const normalX = -tangentY
		const normalY = tangentX
		for (let t = -80; t <= 80; t++) {
			const px = normalX * line.rho + tangentX * t + width / 2
			const py = normalY * line.rho + tangentY * t + height / 2
			if (px < 1 || px >= width - 1 || py < 1 || py >= height - 1) continue
			x.push(px)
			y.push(py)
			weight.push(line.weight ?? 1)
			angleBin.push(Math.floor((((line.angle % PI) + PI) % PI) / step) % angleCount)
		}
	}
	return { count: x.length, x: Float32Array.from(x), y: Float32Array.from(y), weight: Float32Array.from(weight), angleBin: Uint16Array.from(angleBin), angleCount, angleStep: step }
}

test('detects horizontal vertical and diagonal edge fixtures', () => {
	for (const angle of [0, PIOVERTWO, PIOVERFOUR]) {
		const workspace = createStreakDetectionWorkspace(128, 128, { angleStep: PI / 180, maximumEdgePoints: 1024 })
		const candidates = detectStreakHoughCandidates(edges([{ angle, rho: 5 }], 128, 128), 128, 128, workspace, { angleStep: PI / 180, maximumCandidates: 8 })
		expect(candidates.length).toBeGreaterThan(0)
		expect(streakAxialAngleDistance(candidates[0].angle, angle)).toBeLessThan(PI / 180)
	}
})

test('keeps separated parallel lines and crossing angles', () => {
	const workspace = createStreakDetectionWorkspace(160, 160, { angleStep: PI / 180, maximumEdgePoints: 2048 })
	const parallel = detectStreakHoughCandidates(
		edges(
			[
				{ angle: 0, rho: -8 },
				{ angle: 0, rho: 8 },
			],
			160,
			160,
		),
		160,
		160,
		workspace,
		{ maximumCandidates: 8 },
	)
	expect(parallel.some((candidate) => candidate.rho < 75)).toBeTrue()
	expect(parallel.some((candidate) => candidate.rho > 85)).toBeTrue()
	const crossed = detectStreakHoughCandidates(
		edges(
			[
				{ angle: 0, rho: 0 },
				{ angle: PIOVERTWO, rho: 0 },
			],
			160,
			160,
		),
		160,
		160,
		workspace,
		{ maximumCandidates: 8 },
	)
	expect(crossed.some((candidate) => streakAxialAngleDistance(candidate.angle, 0) < PI / 90)).toBeTrue()
	expect(crossed.some((candidate) => streakAxialAngleDistance(candidate.angle, PIOVERTWO) < PI / 90)).toBeTrue()
})

test('respects candidate capacity and is deterministic without theta-rho storage', () => {
	const workspace = createStreakDetectionWorkspace(128, 128, { angleStep: PI / 180, maximumCandidates: 3, maximumEdgePoints: 1024 })
	const fixture = edges(
		[
			{ angle: 0, rho: -20 },
			{ angle: 0, rho: 0 },
			{ angle: 0, rho: 20 },
			{ angle: PIOVERFOUR, rho: 0 },
		],
		128,
		128,
	)
	const first = detectStreakHoughCandidates(fixture, 128, 128, workspace, { maximumCandidates: 3 })
	const second = detectStreakHoughCandidates(fixture, 128, 128, workspace, { maximumCandidates: 3 })
	expect(first).toEqual(second)
	expect(first.length).toBeLessThanOrEqual(3)
	expect(workspace.rhoAccumulator.length).toBe(workspace.rhoCapacity)
	expect(workspace.rhoAccumulator.length).toBeLessThan(workspace.angleCapacity * workspace.rhoCapacity)
})

test('stratifies extracted edges deterministically under fixed capacity', () => {
	const raw = new Float32Array(64 * 64).fill(0.1)
	for (let x = 8; x < 56; x++) raw[30 * 64 + x] = 1
	for (let y = 8; y < 56; y++) raw[y * 64 + 20] = 1
	const workspace = createStreakDetectionWorkspace(64, 64, { maximumEdgePoints: 16 })
	const prepared = preprocessStreakImage(image(raw, 64, 64), { backgroundCellSize: 16 }, workspace)
	const first = collectStreakEdges(prepared)
	const signature = Array.from({ length: first.count }, (_, index) => [first.x[index], first.y[index], first.angleBin[index]])
	expect(first.count).toBeLessThanOrEqual(16)
	expect(workspace.state.edgesTruncated).toBeTrue()
	const angles = Array.from({ length: first.count }, (_, index) => first.angleBin[index] * first.angleStep)
	expect(angles.some((angle) => streakAxialAngleDistance(angle, 0) <= first.angleStep)).toBeTrue()
	expect(angles.some((angle) => streakAxialAngleDistance(angle, PIOVERTWO) <= first.angleStep)).toBeTrue()
	const repeated = collectStreakEdges(prepared)
	expect(Array.from({ length: repeated.count }, (_, index) => [repeated.x[index], repeated.y[index], repeated.angleBin[index]])).toEqual(signature)
})

test('supports angular scratch capacity on a minimal Sobel plane', () => {
	const raw = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0])
	const workspace = createStreakDetectionWorkspace(3, 3)
	const prepared = preprocessStreakImage(image(raw, 3, 3), { backgroundCellSize: 8 }, workspace)
	expect(() => collectStreakEdges(prepared)).not.toThrow()
	expect(workspace.rhoNearest.length).toBeGreaterThanOrEqual(workspace.angleCapacity)
})

test('rejects local-angle and edge-vote combinations beyond the Hough work budget', () => {
	const angleStep = PI / 4096
	const workspace = createStreakDetectionWorkspace(128, 128, { angleStep, maximumEdgePoints: 1024 })
	const fixture = edges([{ angle: 0, rho: 0 }], 128, 128, 4096)
	const maximumTolerance = angleStep * ((MAX_STREAK_LOCAL_ANGLE_VOTES - 1) / 2)
	expect(() => detectStreakHoughCandidates(fixture, 128, 128, workspace, { orientationTolerance: maximumTolerance, maximumCandidates: 8 })).not.toThrow()
	expect(() => detectStreakHoughCandidates(fixture, 128, 128, workspace, { orientationTolerance: maximumTolerance + angleStep, maximumCandidates: 8 })).toThrow('bounded work budget')
})

test('rejects sparse inputs whose angle-rho raster exceeds the Hough work budget', () => {
	const angleCount = 4096
	const angleStep = PI / angleCount
	const distanceStep = 1 / 16
	const workspace = createStreakDetectionWorkspace(1024, 1024, { angleStep, distanceStep, maximumEdgePoints: 1 })
	const fixture: StreakEdgePoints = { count: 1, x: new Float32Array([512]), y: new Float32Array([512]), weight: new Float32Array([1]), angleBin: new Uint16Array([0]), angleCount, angleStep }
	expect(() => detectStreakHoughCandidates(fixture, 1024, 1024, workspace, { distanceStep, orientationTolerance: angleStep, maximumCandidates: 1 })).toThrow('rho scan exceeds')
	expect(3 * angleCount * (Math.ceil((2 * Math.hypot(1023, 1023)) / distanceStep) + 3)).toBeGreaterThan(MAX_STREAK_HOUGH_RHO_WORK)
	expect(workspace.state.houghActiveAngles).toBe(0)
})

test('skips unsupported angles without changing the sparse line candidate', () => {
	const fineAngleCount = 4096
	const fineAngleStep = PI / fineAngleCount
	const fineWorkspace = createStreakDetectionWorkspace(128, 128, { angleStep: fineAngleStep, maximumEdgePoints: 1024 })
	const fine = detectStreakHoughCandidates(edges([{ angle: 0, rho: 5 }], 128, 128, fineAngleCount), 128, 128, fineWorkspace, { orientationTolerance: 0, maximumCandidates: 8 })
	const coarseWorkspace = createStreakDetectionWorkspace(128, 128, { angleStep: PI / 180, maximumEdgePoints: 1024 })
	const coarse = detectStreakHoughCandidates(edges([{ angle: 0, rho: 5 }], 128, 128), 128, 128, coarseWorkspace, { orientationTolerance: 0, maximumCandidates: 8 })
	expect(fineWorkspace.state.houghActiveAngles).toBe(1)
	expect(fineWorkspace.state.houghActiveAngles).toBeLessThan(fineAngleCount)
	expect(fine.length).toBeGreaterThan(0)
	expect(streakAxialAngleDistance(fine[0].angle, coarse[0].angle)).toBeLessThan(PI / 180)
	expect(Math.abs(fine[0].rho - coarse[0].rho)).toBeLessThan(1)
})
