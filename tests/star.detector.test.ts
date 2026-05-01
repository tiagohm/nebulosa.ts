import { describe, expect, test } from 'bun:test'
import { Bitpix } from '../src/fits'
import { type AstronomicalImageNoiseConfig, type AstronomicalImageStar, DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG, generateNoiseImage, generateStarImage } from '../src/image.generator'
import type { Image } from '../src/image.types'
import { mulberry32 } from '../src/random'
import { detectStars, excludeStarsFitWithinRegion, mergeVeryCloseStars, StarList } from '../src/star.detector'
import { type PlotStarOptions, plotStar } from '../src/star.generator'
import { medianOf, NumberComparator } from '../src/util'
import { downloadPerTag } from './download'
import { readImage } from './image.util'

await downloadPerTag('stardetector')

test('star list', () => {
	const list = new StarList(5)

	expect(list.array().map((e) => e.h)).toEqual([])

	list.add(0, 0, 1)
	expect(list.size).toBe(1)
	expect(list.array().map((e) => e.h)).toEqual([1])

	list.add(0, 0, 2)
	expect(list.size).toBe(2)
	expect(list.array().map((e) => e.h)).toEqual([1, 2])

	list.add(0, 0, 1.5)
	expect(list.size).toBe(3)
	expect(list.array().map((e) => e.h)).toEqual([1, 1.5, 2])

	list.add(0, 0, 0.5)
	expect(list.size).toBe(4)
	expect(list.array().map((e) => e.h)).toEqual([0.5, 1, 1.5, 2])

	list.add(0, 0, 0.2)
	expect(list.size).toBe(5)
	expect(list.array().map((e) => e.h)).toEqual([0.2, 0.5, 1, 1.5, 2])

	list.add(0, 0, 1.7)
	expect(list.size).toBe(5)
	expect(list.array().map((e) => e.h)).toEqual([0.5, 1, 1.5, 1.7, 2])

	list.delete(list.array()[1])
	expect(list.size).toBe(4)
	expect(list.array().map((e) => e.h)).toEqual([0.5, 1.5, 1.7, 2])

	list.delete(list.array()[3])
	expect(list.size).toBe(3)
	expect(list.array().map((e) => e.h)).toEqual([0.5, 1.5, 1.7])

	list.delete(list.array()[0])
	expect(list.size).toBe(2)
	expect(list.array().map((e) => e.h)).toEqual([1.5, 1.7])

	list.delete(list.array()[1])
	expect(list.size).toBe(1)
	expect(list.array().map((e) => e.h)).toEqual([1.5])

	list.add(0, 0, 1.6)
	expect(list.size).toBe(2)
	expect(list.array().map((e) => e.h)).toEqual([1.5, 1.6])
})

test('merge stars & exclusion', () => {
	const list = new StarList()

	list.add(100, 100, 50)
	list.add(100, 102, 4)
	list.add(103, 102, 1)

	list.add(800, 100, 50)

	list.add(100, 800, 1)
	list.add(102, 803, 50)

	list.add(800, 800, 5)
	list.add(801, 800, 7)
	list.add(799, 803, 900)
	list.add(798, 804, 1)

	expect(list.size).toBe(10)

	mergeVeryCloseStars(list)

	expect(list.size).toBe(4)
	let array = list.array()
	expect(array.map((e) => e.h)).toEqual([50, 50, 50, 900])
	expect(array.map((e) => e.x)).toEqual([100, 800, 102, 799])
	expect(array.map((e) => e.y)).toEqual([100, 100, 803, 803])

	excludeStarsFitWithinRegion(list, 1000)

	expect(list.size).toBe(1)
	array = list.array()
	expect(array.map((e) => e.h)).toEqual([900])
	expect(array.map((e) => e.x)).toEqual([799])
	expect(array.map((e) => e.y)).toEqual([803])
})

describe('detect stars I', () => {
	const width = 400
	const height = 200
	const raw = new Float32Array(width * height)

	test('low noise', () => {
		raw.fill(0)

		// Plot 5 stars
		plotStar(raw, width, height, 1, width / 2, height / 2, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 50, 50, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 50, 150, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 350, 50, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 350, 150, 0.5, 3, 100, 0)

		const noise: AstronomicalImageNoiseConfig = {
			...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG,
			sky: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky, enabled: false },
			moon: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon, enabled: false },
			lightPollution: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution, enabled: false },
			sensor: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor, readNoise: 0, biasElectrons: 0, blackLevelElectrons: 0, channelBiasElectrons: [0, 0, 0] },
		}

		generateNoiseImage(raw, width, height, 1, noise)

		const image: Image = { raw, header: {}, metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 8, bitpix: -64, stride: width, strideInBytes: width * 8, bayer: undefined } }
		const stars = detectStars(image, { maxStars: 2000 })
		expect(stars.find((s) => s.x === 200 && s.y === 100)).toBeDefined()
		expect(stars.find((s) => s.x === 50 && s.y === 50)).toBeDefined()
		expect(stars.find((s) => s.x === 50 && s.y === 150)).toBeDefined()
		expect(stars.find((s) => s.x === 350 && s.y === 50)).toBeDefined()
		expect(stars.find((s) => s.x === 350 && s.y === 150)).toBeDefined()
		expect(stars.length).toBe(5)
	})

	test('high noise', () => {
		raw.fill(0)

		// Plot 5 stars
		plotStar(raw, width, height, 1, width / 2, height / 2, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 50, 50, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 50, 150, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 350, 50, 0.5, 3, 100, 0)
		plotStar(raw, width, height, 1, 350, 150, 0.5, 3, 100, 0)

		const noise: AstronomicalImageNoiseConfig = {
			...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG,
			sky: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky, enabled: true },
			moon: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon, enabled: true },
			lightPollution: { ...DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution, enabled: true },
		}

		generateNoiseImage(raw, width, height, 1, noise)

		const image: Image = { raw, header: {}, metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 8, bitpix: -64, stride: width, strideInBytes: width * 8, bayer: undefined } }
		const stars = detectStars(image, { maxStars: 2000 })
		expect(stars.find((s) => s.x === 200 && s.y === 100)).toBeDefined()
		expect(stars.find((s) => s.x === 50 && s.y === 50)).toBeDefined()
		expect(stars.find((s) => s.x === 50 && s.y === 150)).toBeDefined()
		expect(stars.find((s) => s.x === 350 && s.y === 50)).toBeDefined()
		expect(stars.find((s) => s.x === 350 && s.y === 150)).toBeDefined()
		expect(stars.length).toBe(5)
	})
})

test('detect stars from real image', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const stars = detectStars(image, { maxStars: 500 })

	expect(stars).toHaveLength(500)
	const flux = stars.map((e) => e.flux).sort(NumberComparator)
	const snr = stars.map((e) => e.snr).sort(NumberComparator)
	const hfd = stars.map((e) => e.hfd).sort(NumberComparator)
	const carina = stars.find((e) => e.x === 564 && e.y === 544)
	expect(carina).toBeDefined()
	expect(carina!.x).toBe(564)
	expect(carina!.y).toBe(544)
	expect(carina!.flux).toBeGreaterThan(0)
	expect(carina!.snr).toBeGreaterThan(0)
	expect(carina!.hfd).toBeGreaterThan(0)
	expect(medianOf(flux)).toBeGreaterThan(0)
	expect(medianOf(snr)).toBeGreaterThan(0)
	expect(medianOf(hfd)).toBeGreaterThanOrEqual(1.5)
})

const BASE_NOISE_CONFIG: AstronomicalImageNoiseConfig = {
	seed: 487537239,
	quality: 'balanced',
	exposure: { exposureTime: 1, analogGain: 1.5, digitalGain: 1, electronsPerAdu: 0.85 },
	sky: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky,
	moon: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon,
	lightPollution: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution,
	atmosphere: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere,
	sensor: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor,
	artifacts: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts,
	output: DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output,
}

const BASE_PLOT_OPTIONS: PlotStarOptions = {
	background: 0,
	saturationLevel: 1,
	focusStep: 50000,
	bestFocus: 50000,
	maxFocusStep: 100000,
	peakScale: 1,
	ellipticity: 0,
	theta: 0,
	softCore: 0,
	psfModel: 'gaussian',
	beta: 2.5,
	haloStrength: 0,
	haloScale: 2.8,
	jitterX: 0,
	jitterY: 0,
	gain: 1,
	gammaCompensation: 2.2,
	additiveNoiseHint: 0,
	minPlotRadius: 2,
	maxPlotRadius: 24,
	cutoffSigma: 4.25,
}

describe('detect stars II', () => {
	const width = 600
	const height = 480
	const count = 48

	function generateStars(seed: number, hfd: number, flux: number, snr: number) {
		const random = mulberry32(seed)
		const stars: AstronomicalImageStar[] = []
		const minSeparation = Math.max(18, Math.ceil(hfd * 5))
		const minSeparationSq = minSeparation * minSeparation

		while (stars.length < count) {
			const x = 24 + Math.round(random() * (width - 48))
			const y = 24 + Math.round(random() * (height - 48))
			let separated = true

			for (let i = 0; i < stars.length; i++) {
				const star = stars[i]
				const dx = star.x - x
				const dy = star.y - y

				if (dx * dx + dy * dy < minSeparationSq) {
					separated = false
					break
				}
			}

			if (separated) {
				stars.push({ hfd, flux, snr, x, y })
			}
		}

		return stars
	}

	const scenarios = [
		{ name: 'compact bright high snr', seed: 2, hfd: 1.8, flux: 1.2, snr: 90 },
		{ name: 'compact nominal', seed: 3, hfd: 2.2, flux: 0.8, snr: 45 },
		{ name: 'nominal medium', seed: 4, hfd: 3.2, flux: 0.6, snr: 30 },
		{ name: 'diffuse medium', seed: 5, hfd: 4.5, flux: 0.7, snr: 35 },
		{ name: 'diffuse bright', seed: 6, hfd: 5.5, flux: 1.1, snr: 70 },
		{ name: 'faint but high snr', seed: 7, hfd: 2.8, flux: 0.28, snr: 70 },
		{ name: 'bright low snr', seed: 8, hfd: 3.1, flux: 1.2, snr: 12 },
		{ name: 'faint low snr', seed: 9, hfd: 3.4, flux: 0.18, snr: 8 },
		{ name: 'compact faint medium snr', seed: 10, hfd: 1.6, flux: 0.22, snr: 20 },
	] as const

	for (const scenario of scenarios) {
		test(scenario.name, () => {
			const raw = new Float32Array(width * height)
			const stars = generateStars(scenario.seed, scenario.hfd, scenario.flux, scenario.snr)
			expect(stars).toHaveLength(count)

			generateStarImage(raw, width, height, 1, stars, 1.2, BASE_NOISE_CONFIG, BASE_PLOT_OPTIONS)
			const image: Image = { raw, header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height }, metadata: { width, height, channels: 1, pixelCount: width * height, pixelSizeInBytes: 4, bitpix: -32, stride: width, strideInBytes: width * 4, bayer: undefined } }
			const detectedStars = detectStars(image, { maxStars: 500 })
			expect(detectedStars).toHaveLength(stars.length)
		})
	}
})
