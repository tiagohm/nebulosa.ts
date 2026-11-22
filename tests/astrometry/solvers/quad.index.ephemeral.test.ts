import { expect, test } from 'bun:test'
import { catalogQuadIndexStars, catalogStarVectors } from '../../../src/astrometry/solvers/quad.index.ephemeral'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { coordToPixel } from '../../../src/astronomy/sky/spatial/healpix'
import type { StarCatalog, StarCatalogConeQuery, StarCatalogEntry } from '../../../src/catalogs/stars/catalog'
import { HnskyCatalog } from '../../../src/catalogs/stars/hnsky'
import { deg } from '../../../src/math/units/angle'
import { downloadAll } from '../../download'

await downloadAll('HNSKY_g14.tar')

const catalog = new HnskyCatalog()
catalog.open(await new Bun.Archive(await Bun.file('data/HNSKY_g14.tar').arrayBuffer()).files(), 'g14')
const cone = { center: eraS2c(deg(161), deg(-59.6)), radius: deg(1) }

test('streams a cone brightest first with magnitudes and epoch', async () => {
	const stars = await catalogQuadIndexStars(catalog, cone)
	const queried = await catalog.queryCone(deg(161), deg(-59.6), deg(1))
	expect(stars.magnitudes.length).toBe(queried.length)
	expect(stars.vectors.length).toBe(3 * queried.length)
	for (let i = 1; i < stars.magnitudes.length; i++) expect(stars.magnitudes[i]).toBeGreaterThanOrEqual(stars.magnitudes[i - 1])
	expect(stars.epoch).toBe(queried[0].epoch)
	// The vectors alone are those of catalogStarVectors.
	expect(await catalogStarVectors(catalog, cone)).toEqual(stars.vectors)
})

test('keeps only the brightest stars of each cell when bounded', async () => {
	const nside = 64
	const perCell = 3
	const all = await catalogQuadIndexStars(catalog, cone)
	const bounded = await catalogQuadIndexStars(catalog, cone, { nside, perCell })
	const cellOf = (v: Float64Array, i: number) => coordToPixel(nside, ...eraC2s(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]))

	// The expected selection: the first perCell stars of each cell in the brightest-first list.
	const expected: number[] = []
	const counts = new Map<number, number>()
	for (let i = 0; i < all.magnitudes.length; i++) {
		const cell = cellOf(all.vectors, i)
		const count = counts.get(cell) ?? 0
		if (count < perCell) expected.push(all.magnitudes[i])
		counts.set(cell, count + 1)
	}

	expect(bounded.magnitudes.length).toBe(expected.length)
	expect([...bounded.magnitudes]).toEqual(expected)
	expect(bounded.magnitudes.length).toBeLessThan(all.magnitudes.length)
})

test('carries proper motions to one epoch and returns them', async () => {
	const pm = 1e-6 // radians per year
	const entries: StarCatalogEntry[] = [
		{ rightAscension: deg(161), declination: deg(-59.6), magnitude: 5, epoch: 2016, pmRA: pm, pmDEC: -pm },
		{ rightAscension: deg(161.1), declination: deg(-59.5), magnitude: 6, epoch: 2000, pmRA: 2 * pm, pmDEC: 0 },
		{ rightAscension: deg(161.2), declination: deg(-59.7), magnitude: 7 },
		{ rightAscension: deg(161.3), declination: deg(-59.8), magnitude: 20, epoch: 2000 },
	]
	const stub = { streamRegion: (query: StarCatalogConeQuery) => entries.filter((entry) => query.magnitudeMax === undefined || (entry.magnitude ?? Infinity) <= query.magnitudeMax) } as unknown as StarCatalog
	const position = (stars: Float64Array, i: number) => eraC2s(stars[i * 3], stars[i * 3 + 1], stars[i * 3 + 2])

	// Without a requested epoch, every star goes to the first entry's epoch (2016).
	const first = await catalogQuadIndexStars(stub, cone)
	expect(first.epoch).toBe(2016)
	expect(first.properMotions).toBeDefined()
	expect(position(first.vectors, 0)[0]).toBeCloseTo(deg(161), 12)
	expect(position(first.vectors, 1)[0]).toBeCloseTo(deg(161.1) + 2 * pm * 16, 12)
	expect(first.properMotions![2]).toBeCloseTo(2 * pm, 15)
	// A star without epoch or proper motion stays where the catalog puts it.
	expect(position(first.vectors, 2)[0]).toBeCloseTo(deg(161.2), 12)

	// A requested epoch moves every star with proper motion to it.
	const later = await catalogQuadIndexStars(stub, cone, { epoch: 2026 })
	expect(later.epoch).toBe(2026)
	expect(position(later.vectors, 0)[0]).toBeCloseTo(deg(161) + pm * 10, 12)
	expect(position(later.vectors, 0)[1]).toBeCloseTo(deg(-59.6) - pm * 10, 12)

	// The magnitude limit is passed to the catalog.
	expect((await catalogQuadIndexStars(stub, cone, { magnitudeMax: 10 })).magnitudes.length).toBe(3)
})

test('a star carried over a pole comes down on its other side', async () => {
	// 0.5" from the north pole, moving 100 mas/yr toward it, carried 14 years.
	const pm = deg(0.1 / 3600)
	const entry: StarCatalogEntry = { rightAscension: 1, declination: Math.PI / 2 - deg(0.5 / 3600), magnitude: 5, epoch: 2016, pmRA: 0, pmDEC: pm }
	const stub = { streamRegion: () => [entry] } as unknown as StarCatalog
	const stars = await catalogQuadIndexStars(stub, { center: [0, 0, 1], radius: deg(1) }, { epoch: 2030, nside: 64, perCell: 4 })
	const [ra, dec] = eraC2s(stars.vectors[0], stars.vectors[1], stars.vectors[2])
	expect(dec).toBeCloseTo(Math.PI / 2 - deg(0.9 / 3600), 12)
	// Half a turn away in right ascension.
	expect(Math.cos(ra - 1 - Math.PI)).toBeCloseTo(1, 9)
})
