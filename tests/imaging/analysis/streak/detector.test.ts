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
