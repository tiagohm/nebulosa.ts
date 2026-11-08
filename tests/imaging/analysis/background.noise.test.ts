import { expect, test } from 'bun:test'
import { BACKGROUND_NOISE_VERSION, estimateBackgroundNoise } from '../../../src/imaging/analysis/background.noise'
import { analyzeImageStatistics } from '../../../src/imaging/analysis/statistics'
import type { Image } from '../../../src/imaging/model/types'
import { Bitpix } from '../../../src/io/formats/fits/fits'

function image(width: number, height: number, value: (x: number, y: number) => number): Image {
	const raw = new Float64Array(width * height)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = value(x, y)
	return { header: {}, raw, metadata: { width, height, channels: 1, pixelCount: width * height, stride: width, strideInBytes: width * 8, pixelSizeInBytes: 8, bitpix: Bitpix.DOUBLE, bayer: undefined } }
}

function noise(seed: number) {
	let state = seed >>> 0
	const next = () => {
		state = (state * 1664525 + 1013904223) >>> 0
		return (state + 0.5) / 0x100000000
	}
	return () => Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next())
}

test('recovers the level and sigma of a clean sky', () => {
	const gauss = noise(1)
	const result = estimateBackgroundNoise(image(512, 384, () => 0.1 + 0.01 * gauss()))
	expect(result.status).toBe('measured')
	expect(result.level!).toBeCloseTo(0.1, 3)
	expect(Math.abs(result.noiseSigma! / 0.01 - 1)).toBeLessThan(0.05)
	expect(result.usedTiles).toBe(result.totalTiles)
	expect(result.totalTiles).toBeLessThanOrEqual(256)
	expect(result.warnings).toEqual([])
	expect(result.method).toBe('localRobustResidualMad')
	expect(result.version).toBe(BACKGROUND_NOISE_VERSION)
})

test('stars and hot pixels do not inflate the noise', () => {
	const gauss = noise(2)
	const stars = new Set<number>()
	for (let i = 0; i < 400; i++) stars.add((i * 7919) % (512 * 384))
	const result = estimateBackgroundNoise(image(512, 384, (x, y) => 0.1 + 0.01 * gauss() + (stars.has(y * 512 + x) ? 0.5 : 0)))
	expect(result.status).toBe('measured')
	expect(Math.abs(result.noiseSigma! / 0.01 - 1)).toBeLessThan(0.05)
})

test('a smooth gradient is detrended instead of counted as noise', () => {
	const gauss = noise(3)
	const sky = image(512, 384, (x, y) => 0.1 + 0.2 * (x / 512) + 0.1 * (y / 384) + 0.005 * gauss())
	const result = estimateBackgroundNoise(sky)
	const global = analyzeImageStatistics(sky).planes[0].standardDeviation!
	expect(Math.abs(result.noiseSigma! / 0.005 - 1)).toBeLessThan(0.05)
	expect(global / 0.005).toBeGreaterThan(10)
	expect(result.warnings).toContain('strongGradient')
})

test('sparse contamination is rejected while extended or half-frame structure is flagged', () => {
	const gauss = noise(4)
	let state = 9
	const clump = () => {
		state = (state * 1103515245 + 12345) >>> 0
		return state / 0x100000000 < 0.6
	}
	const sparse = estimateBackgroundNoise(image(256, 256, () => 0.1 + 0.01 * gauss() + (clump() && clump() ? 0.05 + 0.1 * Math.abs(gauss()) : 0)))
	expect(sparse.status).toBe('measured')
	expect(Math.abs(sparse.noiseSigma! / 0.01 - 1)).toBeLessThan(0.1)

	const nebula = estimateBackgroundNoise(image(256, 256, (x, y) => 0.1 + 0.002 * gauss() + 0.05 * (1 + Math.sin(x / 4) * Math.sin(y / 4))))
	expect(nebula.warnings).toContain('correlatedNoisePossible')

	const half = estimateBackgroundNoise(image(256, 256, (x) => 0.1 + 0.01 * gauss() + (x < 160 && clump() ? 0.05 + 0.1 * Math.abs(gauss()) : 0)))
	expect(half.status).toBe('uncertain')
	expect(half.warnings).toContain('strongStructure')
})

test('CFA phase offsets are not mistaken for noise', () => {
	const gauss = noise(5)
	const levels = [0.3, 0.15, 0.16, 0.05]
	const mosaic = image(512, 384, (x, y) => levels[((y & 1) << 1) | (x & 1)] + 0.004 * gauss())
	const { planes } = analyzeImageStatistics(mosaic, { cfa: 'RGGB' })
	for (let i = 0; i < 4; i++) {
		expect(planes[i].background!.level!).toBeCloseTo(levels[i], 3)
		expect(Math.abs(planes[i].background!.noiseSigma! / 0.004 - 1)).toBeLessThan(0.08)
	}
	const mono = estimateBackgroundNoise(mosaic)
	expect(mono.status !== 'measured' || mono.noiseSigma! > 0.02).toBeTrue()
})

test('a small area is unavailable instead of a precise-looking value', () => {
	const gauss = noise(6)
	const result = estimateBackgroundNoise(
		image(128, 128, () => 0.1 + 0.01 * gauss()),
		{ area: { left: 10, top: 10, right: 40, bottom: 40 } },
	)
	expect(result.status).toBe('unavailable')
	expect(result.level).toBeUndefined()
	expect(result.noiseSigma).toBeUndefined()
	expect(result.warnings).toContain('insufficientBackground')
})

test('a constant frame has zero noise flagged as constant', () => {
	const result = estimateBackgroundNoise(image(256, 256, () => 0.2))
	expect(result.status).toBe('measured')
	expect(result.level).toBe(0.2)
	expect(result.noiseSigma).toBe(0)
	expect(result.warnings).toEqual(['constant'])
})

test('smoothed noise is flagged as correlated', () => {
	const gauss = noise(7)
	const white = image(514, 384, () => gauss())
	const smoothed = image(512, 384, (x, y) => 0.1 + (0.01 * (white.raw[y * 514 + x] + white.raw[y * 514 + x + 1] + white.raw[y * 514 + x + 2])) / 3)
	expect(estimateBackgroundNoise(smoothed).warnings).toContain('correlatedNoisePossible')
})

test('known numeric limits are excluded and heavy clipping is flagged', () => {
	const gauss = noise(8)
	const result = estimateBackgroundNoise(
		image(256, 256, (x) => (x < 40 ? 1 : 0.1 + 0.01 * gauss())),
		{ numericLimits: true },
	)
	expect(result.warnings).toContain('heavyClipping')
	expect(Math.abs(result.noiseSigma! / 0.01 - 1)).toBeLessThan(0.1)
})
