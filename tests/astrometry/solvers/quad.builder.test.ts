import { expect, test } from 'bun:test'
import { buildQuadBand, quadCellNside } from '../../../src/astrometry/solvers/quad.builder'
import { insideQuadCircle, type MutQuadCode, QUAD_CODE_MAX, QUAD_CODE_MIN, quadCode, skyQuadCode } from '../../../src/astrometry/solvers/quad.code'
import { EphemeralQuadIndex } from '../../../src/astrometry/solvers/quad.index.ephemeral'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { coordToPixel } from '../../../src/astronomy/sky/spatial/healpix'
import { ASEC2RAD, DEG2RAD, PI, PIOVERTWO, TAU } from '../../../src/core/constants'
import { vecAngleUnit } from '../../../src/math/linear-algebra/vec3'
import { mulberry32 } from '../../../src/math/numerical/random'

// Uniform random stars in a cap around (ra, dec), as unit vectors in random brightness order.
function randomStars(seed: number, count: number, ra: number, dec: number, radius: number) {
	const random = mulberry32(seed)
	const center = eraS2c(ra, dec)
	const stars = new Float64Array(count * 3)
	let n = 0

	while (n < count) {
		const z = 1 - random() * (1 - Math.cos(radius))
		const phi = random() * TAU
		const r = Math.sqrt(1 - z * z)
		// Rotate the cap around +Z onto the center.
		const local = [r * Math.cos(phi), r * Math.sin(phi), z]
		const [cra, cdec] = eraC2s(center[0], center[1], center[2])
		const v = rotateToCenter(local, cra, cdec)
		stars.set(v, n * 3)
		n++
	}

	return stars
}

function rotateToCenter(v: number[], ra: number, dec: number) {
	// Rotate about Y by (90° - dec), then about Z by ra.
	const theta = PIOVERTWO - dec
	const x1 = v[0] * Math.cos(theta) + v[2] * Math.sin(theta)
	const z1 = -v[0] * Math.sin(theta) + v[2] * Math.cos(theta)
	const y1 = v[1]
	return [x1 * Math.cos(ra) - y1 * Math.sin(ra), x1 * Math.sin(ra) + y1 * Math.cos(ra), z1]
}

test('cells are at least the band minimum wide', () => {
	for (const size of [0.001, 0.01, 0.05, 0.3]) {
		const nside = quadCellNside(size)
		expect(Math.sqrt(PI / 3) / nside).toBeGreaterThanOrEqual(size)
		expect(Math.sqrt(PI / 3) / nside).toBeLessThan(2 * size)
	}
})

test('builds valid, canonical, unique quads whose backbone spans the band', () => {
	const stars = randomStars(1, 4000, 1, 0.3, 3 * DEG2RAD)
	const scaleLower = 0.2 * DEG2RAD
	const scaleUpper = scaleLower * Math.SQRT2
	const band = buildQuadBand(stars, { scaleLower, scaleUpper, region: { center: eraS2c(1, 0.3), radius: 2 * DEG2RAD } })
	const quadCount = band.quads.length / 4

	expect(quadCount).toBeGreaterThan(100)

	const keys = new Set<string>()
	const code: MutQuadCode = quadCode()
	const star = (i: number): [number, number, number] => [band.stars[band.quads[i] * 3], band.stars[band.quads[i] * 3 + 1], band.stars[band.quads[i] * 3 + 2]]

	for (let q = 0; q < quadCount; q++) {
		const a = star(q * 4)
		const b = star(q * 4 + 1)
		const ab = vecAngleUnit(a, b)
		expect(ab).toBeGreaterThanOrEqual(scaleLower * (1 - 1e-9))
		expect(ab).toBeLessThanOrEqual(scaleUpper * (1 + 1e-9))

		// The stored code is the canonical code of the stars in stored order.
		expect(skyQuadCode(a, b, star(q * 4 + 2), star(q * 4 + 3), code)).toBeTrue()
		for (let i = 0; i < 4; i++) expect(code[i]).toBeCloseTo(band.codes[q * 4 + i], 12)
		expect((code[0] + code[2]) / 2).toBeLessThanOrEqual(0.5 + 1e-12)
		expect(code[0]).toBeLessThanOrEqual(code[2])
		expect(insideQuadCircle(code[0], code[1])).toBeTrue()
		expect(insideQuadCircle(code[2], code[3])).toBeTrue()
		for (const value of code) expect(value >= QUAD_CODE_MIN && value <= QUAD_CODE_MAX).toBeTrue()

		const key = [...band.quads.subarray(q * 4, q * 4 + 4)].sort((x, y) => x - y).join(',')
		expect(keys.has(key)).toBeFalse()
		keys.add(key)
	}

	// No cell keeps more stars than its share, and sweeps count up from 0 per cell.
	const perCell = new Map<number, number>()
	for (let s = 0; s < band.sweeps.length; s++) {
		const [ra, dec] = eraC2s(band.stars[s * 3], band.stars[s * 3 + 1], band.stars[s * 3 + 2])
		const cell = coordToPixel(band.nside, ra, dec)
		const count = perCell.get(cell) ?? 0
		expect(band.sweeps[s]).toBe(count)
		perCell.set(cell, count + 1)
	}
})

test('is deterministic', () => {
	const stars = randomStars(2, 1500, 3, -0.8, 2 * DEG2RAD)
	const options = { scaleLower: 0.15 * DEG2RAD, scaleUpper: 0.21 * DEG2RAD, region: { center: eraS2c(3, -0.8), radius: DEG2RAD } }
	const a = buildQuadBand(stars, options)
	const b = buildQuadBand(stars, options)
	expect(a.quads).toEqual(b.quads)
	expect(a.codes).toEqual(b.codes)
})

test('dedup drops a star near a brighter kept one', () => {
	const center = eraS2c(0.5, 0.5)
	const near = eraS2c(0.5 + 1e-6, 0.5)
	const far = eraS2c(0.51, 0.5)
	const band = buildQuadBand(Float64Array.from([...center, ...near, ...far]), { scaleLower: 0.001, scaleUpper: 0.0015, dedup: 1e-5 })
	expect([...band.sourceIndices]).toEqual([0, 2])
})

test('dedup below the bucket precision limit drops every near companion', () => {
	// 2000 stars over the sky, each followed by a fainter companion 0.5" away: with a 1" dedup, no companion survives.
	const random = mulberry32(7)
	const vectors = new Float64Array(4000 * 3)

	for (let i = 0; i < 2000; i++) {
		const ra = random() * TAU
		const dec = Math.asin(2 * random() - 1)
		vectors.set(eraS2c(ra, dec), i * 6)
		vectors.set(eraS2c(ra + (0.5 * ASEC2RAD) / Math.cos(dec), dec), i * 6 + 3)
	}

	const band = buildQuadBand(vectors, { scaleLower: 5 * DEG2RAD, scaleUpper: 5 * DEG2RAD * Math.SQRT2, starsPerCell: 100, dedup: ASEC2RAD })
	expect(band.sourceIndices.length).toBe(2000)
	for (const index of band.sourceIndices) expect(index % 2).toBe(0)
})

test('the ephemeral index finds its own quads by code and its stars by cone', () => {
	const stars = randomStars(3, 3000, 4, 1.2, 3 * DEG2RAD)
	const region = { center: eraS2c(4, 1.2), radius: 2 * DEG2RAD }
	const index = EphemeralQuadIndex.fromVectors(stars, { scaleLower: 0.25 * DEG2RAD, scaleUpper: 0.35 * DEG2RAD, region })
	expect(index.quadCount).toBeGreaterThan(50)

	const out = new Float64Array(4)
	const code = quadCode()
	const vectors = [0, 1, 2, 3].map(() => [0, 0, 0] as [number, number, number])

	for (let q = 0; q < index.quadCount; q += 7) {
		index.quadStars(q, out)
		for (let i = 0; i < 4; i++) index.starVector(out[i], vectors[i])
		skyQuadCode(vectors[0], vectors[1], vectors[2], vectors[3], code)
		const hits: number[] = []
		index.searchCodes(code, 1e-9, (quad) => hits.push(quad))
		expect(hits).toContain(q)
	}

	let inside = 0
	index.starsInCone({ center: eraS2c(4, 1.2), radius: 0.5 * DEG2RAD }, (star) => {
		expect(vecAngleUnit(index.starVector(star, [0, 0, 0]), eraS2c(4, 1.2))).toBeLessThanOrEqual(0.5 * DEG2RAD + 1e-12)
		inside++
	})
	expect(inside).toBeGreaterThan(0)
})

test('grouped passes build the same kind of band as passes over all cells', () => {
	const stars = randomStars(5, 6000, 1, -0.4, 6 * DEG2RAD)
	const options = { scaleLower: 0.25 * DEG2RAD, scaleUpper: 0.35 * DEG2RAD }
	const all = buildQuadBand(stars, options)
	const grouped = buildQuadBand(stars, { ...options, maxPassMajorCells: 0 })
	expect(grouped.quads).toEqual(buildQuadBand(stars, { ...options, maxPassMajorCells: 0 }).quads)
	expect(grouped.quads.length).toBeGreaterThan(0.9 * all.quads.length)
	expect(grouped.quads.length).toBeLessThan(1.1 * all.quads.length)

	const code = quadCode()
	const star = (i: number) => [grouped.stars[grouped.quads[i] * 3], grouped.stars[grouped.quads[i] * 3 + 1], grouped.stars[grouped.quads[i] * 3 + 2]] as const
	for (let q = 0; q < grouped.quads.length / 4; q++) {
		expect(skyQuadCode(star(q * 4), star(q * 4 + 1), star(q * 4 + 2), star(q * 4 + 3), code)).toBeTrue()
		for (let i = 0; i < 4; i++) expect(code[i]).toBeCloseTo(grouped.codes[q * 4 + i], 12)
	}
})
