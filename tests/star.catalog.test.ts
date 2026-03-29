import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry, type StarCatalogRaDecBox } from '../src/star.catalog'

const GEOMETRY_EPSILON = 1e-12

const FIXTURE_STARS = [
	{ id: 'box-east', rightAscension: deg(0.1), declination: deg(5) },
	{ id: 'box-outside-dec', rightAscension: 0, declination: deg(20) },
	{ id: 'box-outside-ra', rightAscension: deg(20), declination: 0 },
	{ id: 'box-west', rightAscension: deg(359.9), declination: 0 },
	{ id: 'cone-center', rightAscension: deg(120), declination: 0 },
	{ id: 'cone-edge', rightAscension: deg(130), declination: 0 },
	{ id: 'cone-outside', rightAscension: deg(130.2), declination: 0 },
	{ id: 'polygon-inside', rightAscension: deg(220), declination: deg(30) },
	{ id: 'polygon-outside', rightAscension: deg(228), declination: deg(34) },
	{ id: 'triangle-inside', rightAscension: deg(102), declination: deg(12) },
	{ id: 'triangle-outside', rightAscension: deg(108), declination: deg(18) },
] as const satisfies readonly StarCatalogEntry[]

test('query cone keeps spherical boundary matches', async () => {
	expect(idsOf(await catalog.queryCone(deg(120), 0, deg(10)))).toEqual(['cone-center', 'cone-edge'])
})

test('query triangle filters a tangent-plane triangle exactly', async () => {
	expect(idsOf(await catalog.queryTriangle([deg(100), deg(10)], [deg(110), deg(10)], [deg(100), deg(20)]))).toEqual(['triangle-inside'])
})

test('query box handles right ascension wrap-around', async () => {
	expect(idsOf(await catalog.queryBox(deg(359.7), deg(0.3), deg(-0.1), deg(10)))).toEqual(['box-east', 'box-west'])
})

test('query polygon filters a convex polygon exactly', async () => {
	const polygon = [
		[deg(220), deg(25)],
		[deg(230), deg(30)],
		[deg(220), deg(35)],
		[deg(210), deg(30)],
	] as const
	expect(idsOf(await catalog.queryPolygon(polygon))).toEqual(['polygon-inside'])
})

// Keeps the generic catalog tests focused on normalized preselection boxes.
class MockCatalog extends BaseStarCatalog<StarCatalogEntry> {
	constructor(private readonly entries: readonly StarCatalogEntry[]) {
		super()
	}

	// Streams only stars touched by the normalized preselection boxes.
	protected *streamCandidateEntries(query: NormalizedStarCatalogQuery): Iterable<StarCatalogEntry> {
		for (const entry of this.entries) {
			if (matchesAnyBox(entry.rightAscension, entry.declination, query.preselectionBoxes)) {
				yield entry
			}
		}
	}

	// Returns one fixture star by identifier.
	get(id: string) {
		return this.entries.find((entry) => entry.id === id)
	}
}

const catalog = new MockCatalog(FIXTURE_STARS)

// Extracts sorted identifiers from query results.
function idsOf(items: readonly StarCatalogEntry[]) {
	return items.map((item) => item.id).sort()
}

// Checks whether a point falls in any coarse preselection box.
function matchesAnyBox(ra: number, dec: number, boxes: readonly StarCatalogRaDecBox[]) {
	for (const box of boxes) {
		if (matchesBox(ra, dec, box)) return true
	}

	return false
}

// Checks whether a point falls inside one normalized RA/Dec box.
function matchesBox(ra: number, dec: number, box: StarCatalogRaDecBox) {
	return ra + GEOMETRY_EPSILON >= box.minRA && ra <= box.maxRA + GEOMETRY_EPSILON && dec + GEOMETRY_EPSILON >= box.minDEC && dec <= box.maxDEC + GEOMETRY_EPSILON
}
