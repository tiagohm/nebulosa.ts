import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PI, PIOVERTWO } from '../src/constants'
import { sphericalDestination, sphericalSeparation } from '../src/geometry'
import { circleToPixels, coordToPixel, HealpixIndex, nestedToRing, pixelToBoundary, pixelToCenter, ringToNested } from '../src/healpix'

// Extracts sorted ids from query results.
function idsOf(objects: readonly { id: string }[]) {
	return objects.map((object) => object.id).sort()
}

test('pixel centers round-trip at nside 1', () => {
	for (let pixel = 0; pixel < 12; pixel++) {
		const [longitude, latitude] = pixelToCenter(1, pixel)
		expect(coordToPixel(1, longitude, latitude)).toBe(pixel)
	}
})

test('nested and ring ordering convert exactly', () => {
	const nside = 8
	const pixelCount = 12 * nside * nside

	for (let nested = 0; nested < pixelCount; nested++) {
		const ring = nestedToRing(nside, nested)
		expect(ringToNested(nside, ring)).toBe(nested)
	}
})

test('pixel boundary vertices stay within valid spherical ranges', () => {
	const boundary = pixelToBoundary(4, coordToPixel(4, deg(12), deg(35)))

	expect(boundary).toHaveLength(4)

	for (const vertex of boundary) {
		expect(vertex[0]).toBeGreaterThanOrEqual(0)
		expect(vertex[0]).toBeLessThanOrEqual(2 * PI)
		expect(vertex[1]).toBeGreaterThanOrEqual(-PIOVERTWO)
		expect(vertex[1]).toBeLessThanOrEqual(PIOVERTWO)
	}
})

test('circle query matches brute-force filtering on a fixed catalog', () => {
	const index = new HealpixIndex<string, { readonly label: string }>({ nside: 8 })
	const catalog: { readonly id: string; readonly longitude: number; readonly latitude: number }[] = []

	let counter = 0

	for (let latitude = -60; latitude <= 60; latitude += 20) {
		for (let longitude = 0; longitude < 360; longitude += 30) {
			const object = { id: `star-${counter++}`, longitude: deg(longitude), latitude: deg(latitude) }

			catalog.push(object)
			index.insert(object.id, object.longitude, object.latitude, { label: object.id })
		}
	}

	const queries = [
		[deg(0), deg(0), deg(18)],
		[deg(350), deg(10), deg(22)],
		[deg(75), deg(-35), deg(28)],
	] as const

	for (const [longitude, latitude, radius] of queries) {
		const bruteForce = catalog
			.filter((object) => sphericalSeparation(longitude, latitude, object.longitude, object.latitude) <= radius + 1e-12)
			.map((object) => object.id)
			.sort()

		expect(idsOf(index.queryCircle(longitude, latitude, radius))).toEqual(bruteForce)
	}
})

test('ring ordering returns the same circle matches as nested ordering', () => {
	const nestedIndex = new HealpixIndex<string>({ nside: 8, ordering: 'nested' })
	const ringIndex = new HealpixIndex<string>({ nside: 8, ordering: 'ring' })

	for (let longitude = 0; longitude < 360; longitude += 45) {
		for (let latitude = -60; latitude <= 60; latitude += 30) {
			const id = `${longitude}-${latitude}`
			const lon = deg(longitude)
			const lat = deg(latitude)
			nestedIndex.insert(id, lon, lat)
			ringIndex.insert(id, lon, lat)
		}
	}

	expect(idsOf(ringIndex.queryCircle(deg(350), deg(10), deg(30)))).toEqual(idsOf(nestedIndex.queryCircle(deg(350), deg(10), deg(30))))

	const ringPixels = circleToPixels(8, deg(350), deg(10), deg(30), { ordering: 'ring' })

	for (const pixel of ringPixels) {
		expect(ringToNested(8, pixel)).toBeGreaterThanOrEqual(0)
	}
})

test('circle query is boundary inclusive', () => {
	const index = new HealpixIndex<string>({ nside: 16 })
	const radius = deg(12)
	const [longitude, latitude] = sphericalDestination(0, 0, deg(90), radius)

	index.insert('center', 0, 0)
	index.insert('edge', longitude, latitude)
	index.insert('outside', longitude, latitude + deg(0.5))

	expect(idsOf(index.queryCircle(0, 0, radius))).toEqual(['center', 'edge'])
})

test('index queries ignore external target nside mismatches during bucket lookup', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.insert('inside', deg(5), deg(2))
	index.insert('outside', deg(90), deg(45))

	expect(idsOf(index.queryCircle(0, 0, deg(10), { targetNside: 16 }))).toEqual(['inside'])
	expect(idsOf(index.queryCircle(0, 0, deg(10), { targetNside: 4 }))).toEqual(['inside'])
})

test('triangle query handles longitude seam crossing', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.insert('inside', 0, deg(5))
	index.insert('outside', deg(40), 0)
	index.insert('far-side', deg(180), deg(-5))

	expect(idsOf(index.queryTriangle([deg(350), 0], [deg(10), 0], [0, deg(20)]))).toEqual(['inside'])
})

test('polygon query handles a convex polar region with a repeated closing vertex', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.insert('pole', deg(20), deg(85))
	index.insert('mid', deg(20), deg(45))

	const polygon = [
		[deg(0), deg(80)],
		[deg(90), deg(80)],
		[deg(180), deg(80)],
		[deg(270), deg(80)],
		[deg(0), deg(80)],
	] as const

	expect(idsOf(index.queryPolygon(polygon))).toEqual(['pole'])
})

test('insertMany, update, and remove keep the index consistent', () => {
	const index = new HealpixIndex<string, { readonly magnitude: number }>({ nside: 8 })

	index.insertMany([
		{ id: 'a', longitude: 0, latitude: 0, metadata: { magnitude: 1 } },
		{ id: 'b', longitude: deg(30), latitude: 0, metadata: { magnitude: 2 } },
	])

	expect(() => index.insert('a', deg(10), 0)).toThrow()

	index.update('a', deg(120), deg(20), { magnitude: 3 })
	expect(idsOf(index.queryCircle(deg(120), deg(20), deg(1)))).toEqual(['a'])

	expect(index.remove('b')).toBeTrue()
	expect(index.remove('missing')).toBeFalse()
	expect(idsOf(index.queryCircle(deg(30), 0, deg(10)))).toEqual([])
})

test('circle cover includes the center pixel for a zero-radius query', () => {
	const pixel = coordToPixel(8, deg(15), deg(-10))
	const [longitude, latitude] = pixelToCenter(8, pixel)

	expect(circleToPixels(8, longitude, latitude, 0)).toContain(pixel)
	expect(sphericalSeparation(longitude, latitude, ...pixelToCenter(8, pixel))).toBeCloseTo(0, 14)
})
