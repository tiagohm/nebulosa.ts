import { expect, test } from 'bun:test'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, normalizeStarCatalogQuery, type StarCatalogRaDecBox, type Vertex } from '../../../src/catalogs/stars/catalog'
import { deg } from '../../../src/math/units/angle'

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
] as const

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

test('query polygon rejects fewer than three vertices', () => {
	expect(catalog.queryPolygon([[0, 0]])).rejects.toThrow('at least three vertices')
})

test('query region dispatches by query kind', async () => {
	expect(idsOf(await catalog.queryRegion({ kind: 'cone', centerRA: deg(120), centerDEC: 0, radius: deg(10) }))).toEqual(['cone-center', 'cone-edge'])
	expect(idsOf(await catalog.queryRegion({ kind: 'box', minRA: deg(359.7), maxRA: deg(0.3), minDEC: deg(-0.1), maxDEC: deg(10) }))).toEqual(['box-east', 'box-west'])
})

test('stream region yields the same matches as the query helpers', async () => {
	const streamed: string[] = []
	for await (const entry of catalog.streamRegion({ kind: 'cone', centerRA: deg(120), centerDEC: 0, radius: deg(10) })) {
		streamed.push(entry.id)
	}
	expect(streamed.sort()).toEqual(['cone-center', 'cone-edge'])
})

test('polygon includes every vertex and edge midpoint in either winding', async () => {
	const vertices = [
		[deg(10), deg(-5)],
		[deg(20), deg(-5)],
		[deg(20), deg(5)],
		[deg(10), deg(5)],
	] as const
	const entries: MockCatalogEntry[] = []
	for (const ra of [10, 15, 20]) {
		for (const dec of [-5, 0, 5]) {
			entries.push({ id: `${ra},${dec}`, rightAscension: deg(ra), declination: deg(dec) })
		}
	}
	entries.push({ id: 'outside', rightAscension: deg(9.99), declination: 0 })
	const catalog = new MockCatalog(entries)
	const expected = idsOf(await catalog.queryBox(deg(10), deg(20), deg(-5), deg(5)))
	expect(expected).toHaveLength(9)
	expect(idsOf(await catalog.queryPolygon(vertices))).toEqual(expected)
	expect(idsOf(await catalog.queryPolygon(vertices.toReversed()))).toEqual(expected)
	expect(idsOf(await catalog.queryPolygon([...vertices, vertices[0]]))).toEqual(expected)
})

test('triangle includes its vertices and all edge midpoints', async () => {
	const vertices = [
		[deg(100), deg(10)],
		[deg(110), deg(10)],
		[deg(100), deg(20)],
	] as const
	const entries = [
		[100, 10],
		[110, 10],
		[100, 20],
		[105, 10],
		[100, 15],
		[105, 15],
		[102, 12],
	].map(([ra, dec]) => ({ id: `${ra},${dec}`, rightAscension: deg(ra), declination: deg(dec) }))
	const outside = { id: 'outside', rightAscension: deg(106), declination: deg(15) }
	const catalog = new MockCatalog([...entries, outside])
	expect(idsOf(await catalog.queryTriangle(...vertices))).toEqual(idsOf(entries))
	expect(idsOf(await catalog.queryTriangle(vertices[2], vertices[1], vertices[0]))).toEqual(idsOf(entries))
})

test.each([1, -1])('triangle encloses the celestial pole for hemisphere %i', async (hemisphere) => {
	const vertices: readonly [Vertex, Vertex, Vertex] = [
		[0, deg(88 * hemisphere)],
		[deg(120), deg(88 * hemisphere)],
		[deg(240), deg(88 * hemisphere)],
	]
	const entries = [
		{ id: 'pole', rightAscension: deg(310), declination: deg(90 * hemisphere) },
		{ id: 'inside', rightAscension: deg(10), declination: deg(89 * hemisphere) },
		{ id: 'outside-edge', rightAscension: deg(60), declination: deg(88.2 * hemisphere) },
		{ id: 'outside-cap', rightAscension: deg(20), declination: deg(45 * hemisphere) },
		{ id: 'opposite-pole', rightAscension: 0, declination: deg(-90 * hemisphere) },
	]
	const catalog = new MockCatalog(entries)
	expect(idsOf(await catalog.queryTriangle(...vertices))).toEqual(['inside', 'pole'])
	expect(idsOf(await catalog.queryTriangle(vertices[2], vertices[1], vertices[0]))).toEqual(['inside', 'pole'])
	const normalized = normalizeStarCatalogQuery({ kind: 'triangle', a: vertices[0], b: vertices[1], c: vertices[2] })
	expect(normalized.geometryMode).toBe('spherical')
	expect(matchesAnyBox(deg(310), deg(90 * hemisphere), normalized.preselectionBoxes)).toBe(true)
})

test.each([1, -1])('polygon preserves the polar cap with repeated closure for hemisphere %i', async (hemisphere) => {
	// Same four-meridian region as the HEALPix polar regression, reflected for the south pole.
	const vertices: Vertex[] = [0, 90, 180, 270, 0].map((ra) => [deg(ra), deg(80 * hemisphere)])
	const catalog = new MockCatalog([
		{ id: 'inside', rightAscension: deg(20), declination: deg(85 * hemisphere) },
		{ id: 'outside', rightAscension: deg(20), declination: deg(45 * hemisphere) },
	])
	expect(idsOf(await catalog.queryPolygon(vertices))).toEqual(['inside'])
	expect(idsOf(await catalog.queryPolygon(vertices.toReversed()))).toEqual(['inside'])
})

export interface MockCatalogEntry {
	readonly id: string
	readonly rightAscension: number
	readonly declination: number
}

// Keeps the generic catalog tests focused on normalized preselection boxes.
class MockCatalog extends BaseStarCatalog<MockCatalogEntry> {
	constructor(readonly entries: readonly MockCatalogEntry[]) {
		super()
	}

	// Streams only stars touched by the normalized preselection boxes.
	protected *streamCandidateEntries(query: NormalizedStarCatalogQuery): Iterable<MockCatalogEntry> {
		for (const entry of this.entries) {
			if (matchesAnyBox(entry.rightAscension, entry.declination, query.preselectionBoxes)) {
				yield entry
			}
		}
	}
}

const catalog = new MockCatalog(FIXTURE_STARS)

// Extracts sorted identifiers from query results.
function idsOf(items: readonly MockCatalogEntry[]) {
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
