import { describe, expect, test } from 'bun:test'
import { PI } from '../../../../src/core/constants'
import { estimateBackground } from '../../../../src/imaging/analysis/background'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import { streakAxialAngleDistance } from '../../../../src/imaging/analysis/streak/geometry'
import type { Streak } from '../../../../src/imaging/analysis/streak/types'
import { readImageFromPath } from '../../../../src/imaging/model/image'
import type { CfaPattern, Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'
import type { Point } from '../../../../src/math/numerical/geometry'
import { mulberry32, normal } from '../../../../src/math/numerical/random'
import { download } from '../../../download'

await Promise.all([download('LIGHT.fit'), download('NGC3372-16.1.fit'), download('NGC3372-16.3.fit'), download('GRBG-16.1.fit')])

const NOISE = 0.002

function blank(width: number, height: number, channels: 1 | 3 = 1, bayer?: CfaPattern): Image {
	const raw = new Float32Array(width * height * channels).fill(0.1)
	return { raw, header: {}, metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * 4, pixelSizeInBytes: 4, bitpix: -32, bayer } }
}

// Sky with Gaussian noise and Gaussian stars (FWHM 3 px), deterministic for a seed.
function sky(width: number, height: number, seed: number, stars = 400, channels: 1 | 3 = 1, bayer?: CfaPattern): Image {
	const image = blank(width, height, channels, bayer)
	const random = mulberry32(seed)
	const noise = normal(random, 0, NOISE)
	for (let i = 0; i < image.raw.length; i++) image.raw[i] += noise()

	for (let i = 0; i < stars; i++) {
		const x = random() * width
		const y = random() * height
		const peak = NOISE * (3 + 400 * random() ** 4)
		const sigma = 3 / 2.3548

		for (let yy = Math.max(0, Math.floor(y - 12)); yy <= Math.min(height - 1, Math.ceil(y + 12)); yy++) {
			for (let xx = Math.max(0, Math.floor(x - 12)); xx <= Math.min(width - 1, Math.ceil(x + 12)); xx++) {
				const value = peak * Math.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma * sigma))
				for (let c = 0; c < channels; c++) image.raw[(yy * width + xx) * channels + c] += value
			}
		}
	}

	return image
}

function trail(image: Image, start: Point, end: Point, intensity: number, width = 3) {
	renderSyntheticStreak(image, { start, end, width, intensity })
}

// Distance of a point from the segment of a detected streak, in pixels.
function distanceToStreak(streak: Streak, point: Point) {
	const dx = streak.end.x - streak.start.x
	const dy = streak.end.y - streak.start.y
	const t = Math.max(0, Math.min(1, ((point.x - streak.start.x) * dx + (point.y - streak.start.y) * dy) / (dx * dx + dy * dy)))
	return Math.hypot(point.x - streak.start.x - t * dx, point.y - streak.start.y - t * dy)
}

// Whether the streak joins the two points within a tolerance, in either direction.
function expectSegment(streak: Streak, start: Point, end: Point, tolerance: number) {
	const direct = Math.max(Math.hypot(streak.start.x - start.x, streak.start.y - start.y), Math.hypot(streak.end.x - end.x, streak.end.y - end.y))
	const reverse = Math.max(Math.hypot(streak.start.x - end.x, streak.start.y - end.y), Math.hypot(streak.end.x - start.x, streak.end.y - start.y))
	expect(Math.min(direct, reverse)).toBeLessThan(tolerance)
	expect(streakAxialAngleDistance(streak.angle, Math.atan2(end.y - start.y, end.x - start.x))).toBeLessThan(PI / 180)
}

describe('synthetic frames', () => {
	test('measures a noiseless trail', () => {
		const image = blank(256, 192)
		const start = { x: 30, y: 40 }
		const end = { x: 220, y: 150 }
		trail(image, start, end, 0.4)
		const streaks = detectStreaks(image)
		expect(streaks).toHaveLength(1)
		expectSegment(streaks[0], start, end, 3)
		expect(streaks[0].width).toBeGreaterThan(2)
		expect(streaks[0].width).toBeLessThan(4)
		expect(streaks[0].clippedAtBorder).toBeFalse()
		expect(streaks[0].confidence).toBeGreaterThan(0.9)
		expect(streaks[0].saturationFraction).toBeUndefined()
	})

	test('finds a faint trail crossing a star field without reporting anything else', () => {
		const image = sky(640, 480, 1)
		const start = { x: 60, y: 420 }
		const end = { x: 580, y: 70 }
		// Peak of 1.2 noise sigmas: invisible pixel by pixel, obvious along 600 pixels.
		trail(image, start, end, 1.2 * NOISE)
		const streaks = detectStreaks(image)
		expect(streaks).toHaveLength(1)
		expectSegment(streaks[0], start, end, 15)
		expect(streaks[0].rmsResidual).toBeLessThan(1)
	})

	test('reports crossing trails once each and keeps the input unchanged', () => {
		const image = sky(512, 512, 2)
		trail(image, { x: 20, y: 60 }, { x: 490, y: 440 }, 6 * NOISE)
		trail(image, { x: 40, y: 470 }, { x: 470, y: 30 }, 3 * NOISE)
		const copy = image.raw.slice()
		const streaks = detectStreaks(image)
		expect(streaks).toHaveLength(2)
		expect(streaks[0].snr ?? 0).toBeGreaterThan(streaks[1].snr ?? 0)
		expectSegment(streaks[0], { x: 20, y: 60 }, { x: 490, y: 440 }, 6)
		expectSegment(streaks[1], { x: 40, y: 470 }, { x: 470, y: 30 }, 6)
		expect(image.raw).toEqual(copy)
	})

	test('extends a trail that leaves the frame to the border', () => {
		const image = sky(400, 300, 3)
		trail(image, { x: -20, y: 40 }, { x: 300, y: 330 }, 5 * NOISE)
		const [streak] = detectStreaks(image)
		expect(streak.clippedAtBorder).toBeTrue()
		expect(Math.min(streak.start.x, streak.start.y, 299 - streak.end.y)).toBeLessThan(2)
	})

	test('does not report noise, stars, or a chain of aligned stars', () => {
		for (let seed = 10; seed < 14; seed++) expect(detectStreaks(sky(512, 384, seed, 800))).toEqual([])
		const chain = sky(512, 384, 20, 100)
		for (let i = 0; i < 20; i++) trail(chain, { x: 40 + 22 * i, y: 50 + 14 * i }, { x: 40.5 + 22 * i, y: 50.3 + 14 * i }, 40 * NOISE)
		expect(detectStreaks(chain)).toEqual([])
	})

	test('does not report edges, gradients, or sensor rows and columns', () => {
		const image = sky(512, 384, 30)
		// A bright half-plane edge, a strong gradient, a hot partial row, and a bright column at the border.
		for (let y = 0; y < 384; y++) {
			for (let x = 0; x < 512; x++) {
				const i = y * 512 + x
				if (x + 0.4 * y > 400) image.raw[i] += 20 * NOISE
				image.raw[i] += (x / 512) * 10 * NOISE
				if (y === 200 && x > 300) image.raw[i] += 4 * NOISE
				if (x === 1) image.raw[i] += 10 * NOISE
			}
		}
		expect(detectStreaks(image)).toEqual([])
	})

	test('honors the minimum length', () => {
		const image = sky(320, 240, 40)
		trail(image, { x: 100, y: 100 }, { x: 125, y: 120 }, 15 * NOISE)
		expect(detectStreaks(image)).toEqual([])
		expect(detectStreaks(image, { minLength: 16 })).toHaveLength(1)
	})

	test('measures RGB and CFA frames in received-image pixels', () => {
		const rgb = sky(400, 300, 50, 300, 3)
		trail(rgb, { x: 40, y: 260 }, { x: 360, y: 50 }, 3 * NOISE)
		const [color] = detectStreaks(rgb)
		expectSegment(color, { x: 40, y: 260 }, { x: 360, y: 50 }, 6)

		const cfa = sky(800, 600, 51, 500, 1, 'RGGB')
		trail(cfa, { x: 80, y: 520 }, { x: 720, y: 100 }, 3 * NOISE, 5)
		const [mosaic] = detectStreaks(cfa)
		expectSegment(mosaic, { x: 80, y: 520 }, { x: 720, y: 100 }, 8)
	})

	test('measures the saturated fraction against a given level', () => {
		const image = blank(256, 192)
		renderSyntheticStreak(image, { start: { x: 30, y: 40 }, end: { x: 220, y: 150 }, width: 3, intensity: 2, saturationLevel: 1 })
		const [streak] = detectStreaks(image, { saturationLevel: 1 })
		expect(streak.saturationFraction).toBeGreaterThan(0.9)
	})
})

describe('real frames', () => {
	test('reports nothing on a star field, a nebula, an RGB frame, or a CFA mosaic', async () => {
		for (const name of ['LIGHT.fit', 'NGC3372-16.1.fit', 'NGC3372-16.3.fit', 'GRBG-16.1.fit']) {
			const image = (await readImageFromPath(`data/${name}`))!
			expect(detectStreaks(image)).toEqual([])
		}
	})

	test('finds a faint trail added to a real star field', async () => {
		const image = (await readImageFromPath('data/LIGHT.fit'))!
		const { noise } = estimateBackground(image)
		const start = { x: 300, y: 1200 }
		const end = { x: 1700, y: 250 }
		trail(image, start, end, 1.5 * noise)
		const streaks = detectStreaks(image)
		expect(streaks).toHaveLength(1)
		expectSegment(streaks[0], start, end, 20)
		expect(distanceToStreak(streaks[0], { x: 1000, y: 725 })).toBeLessThan(1.5)
	})
})
