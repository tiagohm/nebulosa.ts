import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { PI, PIOVERTWO } from '../src/constants'
import { sphericalDestination, sphericalSeparation } from '../src/geometry'
import { circleToPixels, coordToPixel, type HealpixId, HealpixIndex, nestedToRing, pixelToBoundary, pixelToCenter, ringToNested } from '../src/healpix'

// Extracts sorted ids from query results.
function idsOf(objects: readonly { id: HealpixId }[]) {
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
	const index = new HealpixIndex<{ readonly label: string }>({ nside: 8 })
	const catalog: { readonly id: HealpixId; readonly longitude: number; readonly latitude: number }[] = []

	for (let latitude = -60, c = 0; latitude <= 60; latitude += 20) {
		for (let longitude = 0; longitude < 360; longitude += 30, c++) {
			const object = { id: c.toFixed(0), longitude: deg(longitude), latitude: deg(latitude) }

			catalog.push(object)
			index.add(object.id, object.longitude, object.latitude, { label: object.id })
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

		expect(idsOf(index.queryCone(longitude, latitude, radius))).toEqual(bruteForce)
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
			nestedIndex.add(id, lon, lat)
			ringIndex.add(id, lon, lat)
		}
	}

	expect(idsOf(ringIndex.queryCone(deg(350), deg(10), deg(30)))).toEqual(idsOf(nestedIndex.queryCone(deg(350), deg(10), deg(30))))

	const ringPixels = circleToPixels(8, deg(350), deg(10), deg(30), { ordering: 'ring' })

	for (const pixel of ringPixels) {
		expect(ringToNested(8, pixel)).toBeGreaterThanOrEqual(0)
	}
})

test('circle query is boundary inclusive', () => {
	const index = new HealpixIndex<string>({ nside: 16 })
	const radius = deg(12)
	const [longitude, latitude] = sphericalDestination(0, 0, deg(90), radius)

	index.add('center', 0, 0)
	index.add('edge', longitude, latitude)
	index.add('outside', longitude, latitude + deg(0.5))

	expect(idsOf(index.queryCone(0, 0, radius))).toEqual(['center', 'edge'])
})

test('index queries ignore external target nside mismatches during bucket lookup', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.add('inside', deg(5), deg(2))
	index.add('outside', deg(90), deg(45))

	expect(idsOf(index.queryCone(0, 0, deg(10), { targetNside: 16 }))).toEqual(['inside'])
	expect(idsOf(index.queryCone(0, 0, deg(10), { targetNside: 4 }))).toEqual(['inside'])
})

test('triangle query handles longitude seam crossing', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.add('inside', 0, deg(5))
	index.add('outside', deg(40), 0)
	index.add('far-side', deg(180), deg(-5))

	expect(idsOf(index.queryTriangle([deg(350), 0], [deg(10), 0], [0, deg(20)]))).toEqual(['inside'])
})

test('polygon query handles a convex polar region with a repeated closing vertex', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.add('pole', deg(20), deg(85))
	index.add('mid', deg(20), deg(45))

	const polygon = [
		[deg(0), deg(80)],
		[deg(90), deg(80)],
		[deg(180), deg(80)],
		[deg(270), deg(80)],
		[deg(0), deg(80)],
	] as const

	expect(idsOf(index.queryPolygon(polygon))).toEqual(['pole'])
})

test('box query handles RA wrap-around and region dispatch', () => {
	const index = new HealpixIndex<string>({ nside: 8 })

	index.add('west', deg(359.9), 0)
	index.add('east', deg(0.1), deg(5))
	index.add('outside-ra', deg(20), 0)
	index.add('outside-dec', 0, deg(20))

	const query = { kind: 'box', minRA: deg(359.7), maxRA: deg(0.3), minDEC: deg(-0.1), maxDEC: deg(10) } as const

	expect(idsOf(index.queryBox(query.minRA, query.maxRA, query.minDEC, query.maxDEC))).toEqual(['east', 'west'])
	expect(idsOf(index.queryRegion(query))).toEqual(['east', 'west'])
})

test('add many, update, and remove keep the index consistent', () => {
	const index = new HealpixIndex<{ readonly magnitude: number }>({ nside: 8 })

	index.addMany([
		{ id: 'a', rightAscension: 0, declination: 0, metadata: { magnitude: 1 } },
		{ id: 'b', rightAscension: deg(30), declination: 0, metadata: { magnitude: 2 } },
	])

	index.update('a', deg(120), deg(20), { magnitude: 3 })
	expect(idsOf(index.queryCone(deg(120), deg(20), deg(1)))).toEqual(['a'])

	expect(index.remove('b')).toBeTrue()
	expect(index.remove('missing')).toBeFalse()
	expect(idsOf(index.queryCone(deg(30), 0, deg(10)))).toEqual([])
})

test('circle cover includes the center pixel for a zero-radius query', () => {
	const pixel = coordToPixel(8, deg(15), deg(-10))
	const [longitude, latitude] = pixelToCenter(8, pixel)

	expect(circleToPixels(8, longitude, latitude, 0)).toContain(pixel)
	expect(sphericalSeparation(longitude, latitude, ...pixelToCenter(8, pixel))).toBeCloseTo(0, 14)
})
