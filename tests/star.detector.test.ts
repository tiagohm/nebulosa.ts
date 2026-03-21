import { describe, expect, test } from 'bun:test'
import { Bitpix } from '../src/fits'
import { type AstronomicalImageNoiseConfig, DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG, generateNoiseImage } from '../src/image.generator'
import type { Image } from '../src/image.types'
import { detectStars, excludeStarsFitWithinRegion, mergeVeryCloseStars, StarList } from '../src/star.detector'
import { plotStar } from '../src/star.generator'
import { medianOf } from '../src/util'
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

describe('detect stars', () => {
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
	const flux = stars.map((e) => e.flux).sort()
	const snr = stars.map((e) => e.snr).sort()
	const hfd = stars.map((e) => e.hfd).sort()
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
