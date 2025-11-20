import { expect, test } from 'bun:test'
import { Bitpix } from '../src/fits'
import { detectStars, excludeStarsFitWithinRegion, mergeVeryCloseStars, StarList } from '../src/stardetector'
import { readImage } from './image.util'

test('star list', () => {
	const list = new StarList(5)

	expect(list.toArray().map((e) => e.h)).toEqual([])

	list.add(0, 0, 1)
	expect(list.size).toBe(1)
	expect(list.toArray().map((e) => e.h)).toEqual([1])

	list.add(0, 0, 2)
	expect(list.size).toBe(2)
	expect(list.toArray().map((e) => e.h)).toEqual([1, 2])

	list.add(0, 0, 1.5)
	expect(list.size).toBe(3)
	expect(list.toArray().map((e) => e.h)).toEqual([1, 1.5, 2])

	list.add(0, 0, 0.5)
	expect(list.size).toBe(4)
	expect(list.toArray().map((e) => e.h)).toEqual([0.5, 1, 1.5, 2])

	list.add(0, 0, 0.2)
	expect(list.size).toBe(5)
	expect(list.toArray().map((e) => e.h)).toEqual([0.2, 0.5, 1, 1.5, 2])

	list.add(0, 0, 1.7)
	expect(list.size).toBe(5)
	expect(list.toArray().map((e) => e.h)).toEqual([0.5, 1, 1.5, 1.7, 2])

	list.delete(list.toArray()[1])
	expect(list.size).toBe(4)
	expect(list.toArray().map((e) => e.h)).toEqual([0.5, 1.5, 1.7, 2])

	list.delete(list.toArray()[3])
	expect(list.size).toBe(3)
	expect(list.toArray().map((e) => e.h)).toEqual([0.5, 1.5, 1.7])

	list.delete(list.toArray()[0])
	expect(list.size).toBe(2)
	expect(list.toArray().map((e) => e.h)).toEqual([1.5, 1.7])
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
	let array = list.toArray()
	expect(array.map((e) => e.h)).toEqual([50, 50, 50, 900])
	expect(array.map((e) => e.x)).toEqual([100, 800, 102, 799])
	expect(array.map((e) => e.y)).toEqual([100, 100, 803, 803])

	excludeStarsFitWithinRegion(list, 1000)

	expect(list.size).toBe(1)
	array = list.toArray()
	expect(array.map((e) => e.h)).toEqual([900])
	expect(array.map((e) => e.x)).toEqual([799])
	expect(array.map((e) => e.y)).toEqual([803])
})

test('detect stars', async () => {
	const [image] = await readImage(Bitpix.FLOAT, 3)
	const stars = detectStars(image)

	expect(stars).toHaveLength(500)
	const flux = stars.map((e) => e.flux).reduceRight((a, b) => a + b)
	expect(flux).toBe(3074.7428488413807)
	const carina = stars.find((e) => e.x === 564 && e.y === 544)
	expect(carina).toBeDefined()
	expect(carina!.x).toBe(564)
	expect(carina!.y).toBe(544)
	expect(carina!.flux).toBeCloseTo(7.953, 2)
}, 10000)
