import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../../src/core/constants'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import { streakAxialAngleDistance } from '../../../../src/imaging/analysis/streak/geometry'
import type { Image } from '../../../../src/imaging/model/types'

function image(width: number, height: number): Image {
	const raw = new Float32Array(width * height).fill(0.1)
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function renderLine(image: Image, startX: number, startY: number, endX: number, endY: number, fwhm: number, intensity: number): void {
	const dx = endX - startX
	const dy = endY - startY
	const squaredLength = dx * dx + dy * dy
	const sigma = fwhm / (2 * Math.sqrt(2 * Math.log(2)))
	for (let y = 0; y < image.metadata.height; y++) {
		for (let x = 0; x < image.metadata.width; x++) {
			const projection = Math.max(0, Math.min(1, ((x - startX) * dx + (y - startY) * dy) / squaredLength))
			const closestX = startX + projection * dx
			const closestY = startY + projection * dy
			const distanceSquared = (x - closestX) ** 2 + (y - closestY) ** 2
			image.raw[y * image.metadata.width + x] += intensity * Math.exp(-distanceSquared / (2 * sigma * sigma))
		}
	}
}

test('detects horizontal vertical and diagonal streak geometry', () => {
	for (const [startX, startY, endX, endY, angle] of [
		[20, 40, 100, 40, 0],
		[60, 20, 60, 100, PIOVERTWO],
		[25, 25, 95, 95, PIOVERFOUR],
	] as const) {
		const frame = image(128, 128)
		renderLine(frame, startX, startY, endX, endY, 3, 0.8)
		const detected = detectStreaks(frame, { minLength: 30, maxWidth: 8, minLinearity: 0.8, backgroundCellSize: 32, maxStreaks: 8 })
		expect(detected.length).toBeGreaterThan(0)
		const streak = detected[0]
		expect(streakAxialAngleDistance(streak.angle, angle)).toBeLessThan(PI / 90)
		expect(streak.center.x).toBeCloseTo((startX + endX) / 2, 0)
		expect(streak.center.y).toBeCloseTo((startY + endY) / 2, 0)
		expect(streak.length).toBeGreaterThan(70)
		expect(streak.width).toBeGreaterThan(1)
		expect(streak.width).toBeLessThan(5)
		expect(streak.snr).toBeUndefined()
	}
})

test('reports ROI border clipping and honors clipping rejection', () => {
	const frame = image(128, 128)
	renderLine(frame, 5, 64, 120, 64, 2.5, 0.8)
	const area = { left: 30, top: 20, right: 90, bottom: 110 }
	const detected = detectStreaks(frame, { area, minLength: 30, maxWidth: 8, backgroundCellSize: 32 })
	expect(detected.length).toBeGreaterThan(0)
	expect(detected[0].clippedAtBorder).toBeTrue()
	expect(detected[0].start.x).toBeGreaterThanOrEqual(area.left)
	expect(detected[0].end.x).toBeLessThan(area.right)
	expect(detectStreaks(frame, { area, minLength: 30, maxWidth: 8, backgroundCellSize: 32, allowBorderClipping: false })).toEqual([])
})

test('merges short collinear gaps but preserves separated fragments', () => {
	const joined = image(160, 96)
	renderLine(joined, 15, 48, 65, 48, 3, 0.8)
	renderLine(joined, 72, 48, 140, 48, 3, 0.8)
	const merged = detectStreaks(joined, { minLength: 20, maxWidth: 8, mergeGap: 12, backgroundCellSize: 32 })
	expect(merged.length).toBe(1)
	expect(merged[0].length).toBeGreaterThan(115)

	const separated = image(160, 96)
	renderLine(separated, 15, 48, 55, 48, 3, 0.8)
	renderLine(separated, 90, 48, 140, 48, 3, 0.8)
	const fragments = detectStreaks(separated, { minLength: 20, maxWidth: 8, mergeGap: 12, backgroundCellSize: 32 })
	expect(fragments.length).toBe(2)
})

test('preserves separated parallel and crossing streaks while removing duplicates', () => {
	const parallel = image(160, 128)
	renderLine(parallel, 15, 40, 140, 40, 3, 0.8)
	renderLine(parallel, 15, 75, 140, 75, 3, 0.7)
	const parallelDetections = detectStreaks(parallel, { minLength: 40, maxWidth: 8, backgroundCellSize: 32 })
	expect(parallelDetections.length).toBe(2)
	expect(Math.abs(parallelDetections[0].center.y - parallelDetections[1].center.y)).toBeGreaterThan(30)

	const crossing = image(160, 128)
	renderLine(crossing, 15, 64, 140, 64, 3, 0.8)
	renderLine(crossing, 80, 10, 80, 118, 3, 0.7)
	const crossingDetections = detectStreaks(crossing, { minLength: 40, maxWidth: 8, backgroundCellSize: 32 })
	expect(crossingDetections.length).toBe(2)
	expect(streakAxialAngleDistance(crossingDetections[0].angle, crossingDetections[1].angle)).toBeGreaterThan(PI / 3)
})
