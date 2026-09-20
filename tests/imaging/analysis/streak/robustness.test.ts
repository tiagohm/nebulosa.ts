import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../../src/core/constants'
import { detectStreaks } from '../../../../src/imaging/analysis/streak/detector'
import { streakAxialAngleDistance } from '../../../../src/imaging/analysis/streak/geometry'
import { preprocessStreakImage, STREAK_MASK_INVALID } from '../../../../src/imaging/analysis/streak/preprocess'
import type { Image } from '../../../../src/imaging/model/types'
import { renderSyntheticStreak } from '../../../../src/imaging/synthetic/streak'

function image(width: number, height: number, background: number = 0.1): Image {
	const raw = new Float32Array(width * height).fill(background)
	return { raw, header: {}, metadata: { width, height, channels: 1, stride: width, pixelCount: width * height, strideInBytes: width * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined } }
}

function addStar(frame: Image, centerX: number, centerY: number, sigma: number, intensity: number): void {
	const radius = Math.ceil(4 * sigma)
	for (let y = Math.max(0, Math.floor(centerY - radius)); y <= Math.min(frame.metadata.height - 1, Math.ceil(centerY + radius)); y++) {
		for (let x = Math.max(0, Math.floor(centerX - radius)); x <= Math.min(frame.metadata.width - 1, Math.ceil(centerX + radius)); x++) frame.raw[y * frame.metadata.width + x] += intensity * Math.exp(-((x - centerX) ** 2 + (y - centerY) ** 2) / (2 * sigma * sigma))
	}
}

function addGaussianNoise(frame: Image, sigma: number, seed: number = 0x6d2b79f5): void {
	let state = seed
	for (let index = 0; index < frame.raw.length; index += 2) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const first = Math.max(Number.EPSILON, (state >>> 0) / 0x1_0000_0000)
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const second = (state >>> 0) / 0x1_0000_0000
		const radius = sigma * Math.sqrt(-2 * Math.log(first))
		frame.raw[index] += radius * Math.cos(2 * PI * second)
		if (index + 1 < frame.raw.length) frame.raw[index + 1] += radius * Math.sin(2 * PI * second)
	}
}

test('does not systematically detect stars, isolated hot pixels, or smooth gradients', () => {
	const frame = image(160, 128)
	for (let y = 0; y < 128; y++) for (let x = 0; x < 160; x++) frame.raw[y * 160 + x] += x * 0.0005 + y * 0.0002
	expect(detectStreaks(frame, { minLength: 20, maxWidth: 8, backgroundCellSize: 32 })).toEqual([])
	frame.raw[10 * 160 + 10] = 2
	expect(detectStreaks(frame, { minLength: 20, maxWidth: 8, backgroundCellSize: 32 })).toEqual([])
	let state = 0x9e3779b9
	for (let index = 0; index < 40; index++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const x = 8 + ((state >>> 0) % 144)
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		const y = 8 + ((state >>> 0) % 112)
		addStar(frame, x, y, 1.2, 0.3 + (index % 5) * 0.08)
	}
	const detections = detectStreaks(frame, { minLength: 20, maxWidth: 8, backgroundCellSize: 32 })
	expect(detections.every((streak) => streak.length < 80)).toBeTrue()
	for (const streak of detections) expect(detections.filter((candidate) => streakAxialAngleDistance(streak.angle, candidate.angle) < PI / 90).length).toBeLessThanOrEqual(3)
})

test('keeps geometry stable through a bright crossing star and invalid samples', () => {
	const frame = image(192, 128)
	renderSyntheticStreak(frame, { start: { x: 15.25, y: 72.5 }, end: { x: 175.5, y: 54.25 }, width: 3, intensity: 0.35 })
	addStar(frame, 96, 63, 2, 50)
	for (let x = 70; x < 75; x++) frame.raw[64 * 192 + x] = Number.NaN
	const streaks = detectStreaks(frame, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 })
	expect(streaks.length).toBe(1)
	expect(streakAxialAngleDistance(streaks[0].angle, Math.atan2(54.25 - 72.5, 175.5 - 15.25))).toBeLessThan(PI / 60)
	expect(streaks[0].center.x).toBeCloseTo((15.25 + 175.5) / 2, 0)
})

for (const [name, profile] of [
	['linear', { type: 'linear', start: 0.15, end: 1.8 }],
	['gaussian', { type: 'gaussian', center: 0.5, sigma: 0.28 }],
	[
		'unequal segments',
		{
			type: 'segments',
			intervals: [
				{ start: 0, end: 0.44, intensity: 0.25 },
				{ start: 0.48, end: 1, intensity: 1.5 },
			],
		},
	],
] as const) {
	test(`keeps a ${name} longitudinal profile through a narrow flare`, () => {
		const frame = image(192, 112)
		renderSyntheticStreak(frame, { start: { x: 12, y: 70 }, end: { x: 180, y: 42 }, width: 3, intensity: 0.5, profile })
		addStar(frame, 105, 54, 0.8, 30)
		const streaks = detectStreaks(frame, { minLength: 90, maxWidth: 8, mergeGap: 12, backgroundCellSize: 32 })
		expect(streaks.length).toBeGreaterThan(0)
		expect(streaks[0].length).toBeGreaterThan(140)
	})
}

test('reports known saturation but leaves it absent when unknown', () => {
	const known = image(128, 96)
	renderSyntheticStreak(known, { start: { x: 12, y: 48 }, end: { x: 116, y: 48 }, width: 3, intensity: 2, saturationLevel: 1 })
	const saturated = detectStreaks(known, { minLength: 40, maxWidth: 8, saturationLevel: 1, backgroundCellSize: 32 })
	expect(saturated.length).toBe(1)
	expect(saturated[0].saturationFraction).toBeGreaterThan(0)
	const unknown = image(128, 96)
	renderSyntheticStreak(unknown, { start: { x: 12, y: 48 }, end: { x: 116, y: 48 }, width: 3, intensity: 2, saturationLevel: 1 })
	expect(detectStreaks(unknown, { minLength: 40, maxWidth: 8, backgroundCellSize: 32 })[0].saturationFraction).toBeUndefined()
})

test('detects a long low-surface-brightness segmented trail in deterministic noise', () => {
	const frame = image(256, 128)
	let state = 0x12345678
	for (let index = 0; index < frame.raw.length; index++) {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5
		frame.raw[index] += ((state >>> 0) / 0x1_0000_0000 - 0.5) * 0.02
	}
	renderSyntheticStreak(frame, {
		start: { x: 15, y: 30 },
		end: { x: 240, y: 100 },
		width: 3,
		intensity: 0.055,
		profile: {
			type: 'segments',
			intervals: [
				{ start: 0, end: 0.46 },
				{ start: 0.5, end: 1 },
			],
		},
	})
	const streaks = detectStreaks(frame, { minLength: 120, maxWidth: 8, thresholdSigma: 2, gradientSigma: 1, mergeGap: 16, backgroundCellSize: 32 })
	expect(streaks.length).toBeGreaterThan(0)
	expect(streaks[0].length).toBeGreaterThan(200)
})

test('does not turn wider support corridors into streaks in Gaussian noise', () => {
	for (const maxWidth of [8, 16, 32]) {
		const frame = image(128, 96)
		addGaussianNoise(frame, 0.01)
		expect(detectStreaks(frame, { minLength: 50, maxWidth, backgroundCellSize: 24 })).toEqual([])
	}
})

test('keeps photometry approximately invariant across orientation', () => {
	const fluxes: number[] = []
	const signalToNoise: number[] = []
	for (const angle of [0, PI / 6, PIOVERFOUR, PI / 3, PIOVERTWO]) {
		const frame = image(144, 144)
		addGaussianNoise(frame, 0.004)
		const dx = Math.cos(angle) * 96 * 0.5
		const dy = Math.sin(angle) * 96 * 0.5
		renderSyntheticStreak(frame, { start: { x: 72 - dx, y: 72 - dy }, end: { x: 72 + dx, y: 72 + dy }, width: 3, intensity: 0.35 })
		const streak = detectStreaks(frame, { minLength: 60, maxWidth: 8, backgroundCellSize: 24 })[0]
		expect(streak).toBeDefined()
		fluxes.push(streak.flux)
		signalToNoise.push(streak.snr ?? 0)
		const prepared = preprocessStreakImage(frame, { backgroundCellSize: 24 })
		const tangentX = Math.cos(streak.angle)
		const tangentY = Math.sin(streak.angle)
		const forward = (streak.end.x - streak.start.x) * tangentX + (streak.end.y - streak.start.y) * tangentY >= 0
		const start = forward ? streak.start : streak.end
		const length = streak.length
		const radius = Math.ceil(streak.width * 1.5) + 0.5
		let positivePixels = 0
		for (let y = 0; y < frame.metadata.height; y++) {
			for (let x = 0; x < frame.metadata.width; x++) {
				const offsetX = x - start.x
				const offsetY = y - start.y
				const longitudinal = offsetX * tangentX + offsetY * tangentY
				const normal = -offsetX * tangentY + offsetY * tangentX
				const index = y * frame.metadata.width + x
				if (longitudinal >= -0.5 && longitudinal <= length + 0.5 && Math.abs(normal) <= radius && (prepared.workspace.mask[index] & STREAK_MASK_INVALID) === 0 && prepared.workspace.signal[index] > 0) positivePixels++
			}
		}
		expect(streak.supportPixels).toBe(positivePixels)
	}
	expect(Math.max(...fluxes) / Math.min(...fluxes)).toBeLessThan(1.2)
	expect(Math.max(...signalToNoise) / Math.min(...signalToNoise)).toBeLessThan(1.25)
})

test('uses measured width and residual local noise for final photometry', () => {
	const plain = image(176, 112)
	const gradient = image(176, 112)
	addGaussianNoise(plain, 0.005, 1234)
	addGaussianNoise(gradient, 0.005, 1234)
	for (let y = 0; y < 112; y++) for (let x = 0; x < 176; x++) gradient.raw[y * 176 + x] += x * 0.001 + y * 0.0005
	for (const frame of [plain, gradient]) renderSyntheticStreak(frame, { start: { x: 12, y: 25 }, end: { x: 164, y: 88 }, width: 3, intensity: 0.3 })
	const narrow = detectStreaks(plain, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 })[0]
	const wide = detectStreaks(plain, { minLength: 80, maxWidth: 16, backgroundCellSize: 32 })[0]
	const sloped = detectStreaks(gradient, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 })[0]
	expect(narrow).toBeDefined()
	expect(wide).toBeDefined()
	expect(sloped).toBeDefined()
	expect(Math.abs(narrow.flux - wide.flux) / narrow.flux).toBeLessThan(0.05)
	expect(Math.abs((narrow.snr ?? 0) - (wide.snr ?? 0)) / (narrow.snr ?? 1)).toBeLessThan(0.05)
	expect(Math.abs((narrow.snr ?? 0) - (sloped.snr ?? 0)) / (narrow.snr ?? 1)).toBeLessThan(0.2)

	const noiselessGradient = image(176, 112)
	for (let y = 0; y < 112; y++) for (let x = 0; x < 176; x++) noiselessGradient.raw[y * 176 + x] += x * 0.001 + y * 0.0005
	renderSyntheticStreak(noiselessGradient, { start: { x: 12, y: 25 }, end: { x: 164, y: 88 }, width: 3, intensity: 0.3 })
	expect(detectStreaks(noiselessGradient, { minLength: 80, maxWidth: 8, backgroundCellSize: 32 })[0].snr).toBeUndefined()
})
