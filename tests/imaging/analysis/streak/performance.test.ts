import { expect, test } from 'bun:test'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import { createStreakDetectionWorkspace } from '../../../../src/imaging/analysis/streak/workspace'
import type { Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'

function image(width: number, height: number): Image {
	const raw = new Float32Array(width * height).fill(0.1)
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

test('reuses every large workspace buffer with numerically stable output', () => {
	const frame = image(256, 160)
	renderSyntheticStreak(frame, { start: { x: 15, y: 25 }, end: { x: 240, y: 140 }, width: 3, intensity: 0.4 })
	const workspace = createStreakDetectionWorkspace(256, 160, { maximumEdgePoints: 4096 })
	const identities = [
		workspace.signal,
		workspace.mask,
		workspace.background,
		workspace.noise,
		workspace.edgeX,
		workspace.edgeY,
		workspace.edgeWeight,
		workspace.edgeAngleBin,
		workspace.edgeOrder,
		workspace.angleCounts,
		workspace.angleOffsets,
		workspace.rhoAccumulator,
		workspace.rhoNearest,
		workspace.scratch,
		workspace.longitudinalSignal,
		workspace.longitudinalOffset,
		workspace.longitudinalWeight,
		workspace.longitudinalSupported,
	]
	const first = detectStreaks(frame, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 }, workspace)
	const second = detectStreaks(frame, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 }, workspace)
	expect(second).toEqual(first)
	const repeated = [
		workspace.signal,
		workspace.mask,
		workspace.background,
		workspace.noise,
		workspace.edgeX,
		workspace.edgeY,
		workspace.edgeWeight,
		workspace.edgeAngleBin,
		workspace.edgeOrder,
		workspace.angleCounts,
		workspace.angleOffsets,
		workspace.rhoAccumulator,
		workspace.rhoNearest,
		workspace.scratch,
		workspace.longitudinalSignal,
		workspace.longitudinalOffset,
		workspace.longitudinalWeight,
		workspace.longitudinalSupported,
	]
	for (let index = 0; index < identities.length; index++) expect(repeated[index]).toBe(identities[index])
	expect(workspace.state.edgeCount).toBeLessThanOrEqual(workspace.maximumEdgePoints)
	expect(workspace.state.candidateCount).toBeLessThanOrEqual(workspace.maximumCandidates)
})

test('matches a fresh workspace and remains bounded under candidate pressure', () => {
	const frame = image(512, 384)
	for (let y = 12; y < 372; y += 12) for (let x = 12; x < 500; x += 12) frame.raw[y * 512 + x] = 1
	renderSyntheticStreak(frame, { start: { x: 15, y: 350 }, end: { x: 495, y: 35 }, width: 3, intensity: 0.5 })
	const options = { minLength: 120, maxWidth: 8, backgroundCellSize: 32, maxCandidates: 32 } as const
	const constrained = createStreakDetectionWorkspace(512, 384, { maximumCandidates: 32, maximumEdgePoints: 512 })
	const reused = detectStreaks(frame, options, constrained)
	const fresh = detectStreaks(frame, options, createStreakDetectionWorkspace(512, 384, { maximumCandidates: 32, maximumEdgePoints: 512 }))
	expect(reused).toEqual(fresh)
	expect(constrained.state.edgeCount).toBeLessThanOrEqual(512)
	expect(constrained.state.candidateCount).toBeLessThanOrEqual(32)
	expect(constrained.state.edgesTruncated).toBeTrue()
})
