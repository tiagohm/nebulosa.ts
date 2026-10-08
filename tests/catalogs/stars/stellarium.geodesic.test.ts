import { describe, expect, test } from 'bun:test'
import { normalizeStarCatalogQuery, type StarCatalogQuery } from '../../../src/catalogs/stars/catalog'
// oxfmt-ignore
import { STELLARIUM_ICOSAHEDRON_CORNERS, STELLARIUM_ICOSAHEDRON_TRIANGLES, type StellariumCapClassifier, stellariumBoxesClassifier, stellariumConeClassifier, stellariumLocalZoneCount, type StellariumZoneCover, stellariumZoneCover, stellariumZoneForPoint, stellariumZoneTriangle } from '../../../src/catalogs/stars/stellarium.geodesic'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { TAU, PI, PIOVERTWO } from '../../../src/core/constants'
import { type MutVec3, type Vec3, vecAngleUnit, vecCross, vecDot, vecLength, vecNormalize } from '../../../src/math/linear-algebra/vec3'
import { mulberry32 } from '../../../src/math/numerical/random'
import { arcsec, deg } from '../../../src/math/units/angle'

function randomDirection(random: () => number): MutVec3 {
	const z = 2 * random() - 1
	const phi = TAU * random()
	const r = Math.sqrt(1 - z * z)
	return [r * Math.cos(phi), r * Math.sin(phi), z]
}

// Signed angular distance of v outside a geodesic triangle (negative inside), radians.
function outsideDistance(triangle: readonly Vec3[], v: Vec3) {
	let worst = -Infinity

	for (let i = 0; i < 3; i++) {
		const n = vecNormalize(vecCross(triangle[i], triangle[(i + 1) % 3]))
		worst = Math.max(worst, -Math.asin(vecDot(n, v)))
	}

	return worst
}

function coverContains(cover: StellariumZoneCover, level: number, zone: number) {
	return (cover.ranges.get(level) ?? []).some((range) => zone >= range.start && zone < range.end)
}

// A point in a cone of the given radius around axis, uniformly in solid angle.
function pointInCone(axis: Vec3, radius: number, random: () => number): MutVec3 {
	const cosR = Math.cos(radius)
	const z = 1 - random() * (1 - cosR)
	const phi = TAU * random()
	const r = Math.sqrt(Math.max(0, 1 - z * z))
	const helper: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
	const u = vecNormalize(vecCross(axis, helper))
	const w = vecCross(axis, u)
	return [0, 1, 2].map((i) => axis[i] * z + r * (u[i] * Math.cos(phi) + w[i] * Math.sin(phi))) as MutVec3
}

describe('grid', () => {
	test('zone counts', () => {
		for (let level = 0; level <= 8; level++) expect(stellariumLocalZoneCount(level)).toBe(20 * 4 ** level)
	})

	test('corners and oriented faces of the upstream tables', () => {
		expect(STELLARIUM_ICOSAHEDRON_CORNERS).toHaveLength(12)
		expect(STELLARIUM_ICOSAHEDRON_TRIANGLES).toHaveLength(20)
		for (const corner of STELLARIUM_ICOSAHEDRON_CORNERS) expect(vecLength(corner)).toBeCloseTo(1, 15)
		// Upstream corner 0 is (a, -b, 0) and face 0 is (1, 0, 10).
		expect(STELLARIUM_ICOSAHEDRON_CORNERS[0][0]).toBeCloseTo(0.85065080835204, 14)
		expect(STELLARIUM_ICOSAHEDRON_CORNERS[0][1]).toBeCloseTo(-0.5257311121191336, 14)
		expect(STELLARIUM_ICOSAHEDRON_TRIANGLES[0]).toEqual([1, 0, 10])
		expect(STELLARIUM_ICOSAHEDRON_TRIANGLES[19]).toEqual([8, 9, 5])

		for (const [a, b, c] of STELLARIUM_ICOSAHEDRON_TRIANGLES) {
			const [ca, cb, cc] = [STELLARIUM_ICOSAHEDRON_CORNERS[a], STELLARIUM_ICOSAHEDRON_CORNERS[b], STELLARIUM_ICOSAHEDRON_CORNERS[c]]
			// Counterclockwise seen from outside, adjacent corners 63.43° apart.
			expect(vecDot(vecCross(ca, cb), cc)).toBeGreaterThan(0)
			expect(vecAngleUnit(ca, cb)).toBeCloseTo(Math.atan(2), 12)
		}
	})

	test('face centers map to their table position', () => {
		for (let face = 0; face < 20; face++) {
			const t = stellariumZoneTriangle(0, face)
			const center = vecNormalize([t[0][0] + t[1][0] + t[2][0], t[0][1] + t[1][1] + t[2][1], t[0][2] + t[1][2] + t[2][2]])
			expect(stellariumZoneForPoint(center, 0)).toBe(face)
			expect(stellariumZoneForPoint(center, 3) >> 6).toBe(face)
		}
	})

	test('children follow the upstream subdivision', () => {
		for (const [level, zone] of [
			[0, 0],
			[0, 13],
			[2, 37],
			[5, 12345],
		]) {
			const [c0, c1, c2] = stellariumZoneTriangle(level, zone)
			const e0 = vecNormalize([c1[0] + c2[0], c1[1] + c2[1], c1[2] + c2[2]])
			const e1 = vecNormalize([c2[0] + c0[0], c2[1] + c0[1], c2[2] + c0[2]])
			const e2 = vecNormalize([c0[0] + c1[0], c0[1] + c1[1], c0[2] + c1[2]])
			const expected = [
				[c0, e2, e1],
				[e2, c1, e0],
				[e1, e0, c2],
				[e0, e1, e2],
			]

			for (let k = 0; k < 4; k++) {
				const child = stellariumZoneTriangle(level + 1, 4 * zone + k)
				for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(child[i][j]).toBeCloseTo(expected[k][i][j], 14)
			}
		}
	})

	test('zone of a point against a brute-force search of the triangles', () => {
		const random = mulberry32(17)

		for (let n = 0; n < 100; n++) {
			const v = randomDirection(random)

			for (let level = 0; level <= 3; level++) {
				const zone = stellariumZoneForPoint(v, level)
				expect(outsideDistance(stellariumZoneTriangle(level, zone), v)).toBeLessThanOrEqual(1e-15)

				let best = -1
				let bestDistance = Infinity

				for (let z = 0; z < stellariumLocalZoneCount(level); z++) {
					const distance = outsideDistance(stellariumZoneTriangle(level, z), v)
					if (distance < bestDistance) [best, bestDistance] = [z, distance]
				}

				expect(zone).toBe(best)
			}

			// The deep zone descends from the shallow one.
			expect(stellariumZoneForPoint(v, 8) >> 10).toBe(stellariumZoneForPoint(v, 3))
		}
	})

	test('points on shared edges and corners resolve deterministically', () => {
		for (const corner of STELLARIUM_ICOSAHEDRON_CORNERS) {
			const zone = stellariumZoneForPoint(corner, 6)
			expect(zone).toBeGreaterThanOrEqual(0)
			expect(zone).toBeLessThan(stellariumLocalZoneCount(6))
			expect(outsideDistance(stellariumZoneTriangle(6, zone), corner)).toBeLessThan(1e-12)
		}

		const [c0, c1] = stellariumZoneTriangle(4, 999)
		const edge = vecNormalize([c0[0] + c1[0], c0[1] + c1[1], c0[2] + c1[2]])
		const zone = stellariumZoneForPoint(edge, 7)
		expect(outsideDistance(stellariumZoneTriangle(7, zone), edge)).toBeLessThan(1e-12)
		expect(stellariumZoneForPoint([0, 0, 1], 8)).toBe(stellariumZoneForPoint([0, 0, 2], 8))
	})
})

describe('cover', () => {
	function expectConeComplete(ra: number, dec: number, radius: number, levels: readonly number[], samples: number, seed: number) {
		const axis = eraS2c(ra, dec)
		const cover = stellariumZoneCover(stellariumConeClassifier(axis, radius), levels)
		const random = mulberry32(seed)

		for (let n = 0; n < samples; n++) {
			const v = n === 0 ? axis : pointInCone(axis, radius, random)
			for (const level of levels) expect(coverContains(cover, level, stellariumZoneForPoint(v, level))).toBeTrue()
		}

		return cover
	}

	test('cones of every size contain the zones of their points', () => {
		expectConeComplete(deg(83.8), deg(-5.4), 0, [0, 3, 8], 1, 1)
		expectConeComplete(deg(10), deg(20), arcsec(0.3), [0, 4, 8], 50, 2)
		expectConeComplete(deg(200), deg(-40), deg(1), [0, 1, 2, 3, 4, 5], 500, 3)
		expectConeComplete(deg(300), deg(70), deg(60), [0, 2, 4], 500, 4)
		expectConeComplete(deg(0), deg(0), PI, [0, 3], 500, 5)
	})

	test('cone crossing an edge without containing any vertex', () => {
		const [c0, c1, c2] = stellariumZoneTriangle(3, 500)
		const edge = vecNormalize([c0[0] + c1[0], c0[1] + c1[1], c0[2] + c1[2]])
		const radius = arcsec(20)
		// The cone is far smaller than the triangle, so it holds none of its vertices.
		for (const corner of [c0, c1, c2]) expect(vecAngleUnit(corner, edge)).toBeGreaterThan(radius)
		const cover = stellariumZoneCover(stellariumConeClassifier(edge, radius), [3])
		expect(coverContains(cover, 3, 500)).toBeTrue()
		// The neighbor across the edge is selected too.
		const outward = vecNormalize(vecCross(c1, c0))
		const across = vecNormalize([edge[0] + outward[0] * 1e-6, edge[1] + outward[1] * 1e-6, edge[2] + outward[2] * 1e-6])
		const neighbor = stellariumZoneForPoint(across, 3)
		expect(neighbor).not.toBe(500)
		expect(coverContains(cover, 3, neighbor)).toBeTrue()
	})

	test('cones around the poles and across RA 0', () => {
		expectConeComplete(0, PIOVERTWO, deg(2), [0, 4, 6], 500, 6)
		expectConeComplete(deg(123), -PIOVERTWO, deg(0.5), [0, 5], 300, 7)
		expectConeComplete(deg(359.9), deg(1), deg(0.5), [2, 6], 300, 8)
	})

	test('a full-sky cone is a single inside run per level', () => {
		const cover = stellariumZoneCover(stellariumConeClassifier([1, 0, 0], PI), [0, 2, 5])
		expect(cover.ranges.get(5)).toEqual([{ start: 0, end: stellariumLocalZoneCount(5), inside: true }])
		expect(cover.ranges.get(0)).toEqual([{ start: 0, end: 20, inside: true }])
		expect(cover.visited).toBe(20)
	})

	test('a small cone visits few nodes at level 8', () => {
		const cover = stellariumZoneCover(stellariumConeClassifier(eraS2c(deg(45), deg(45)), deg(0.1)), [8])
		const zones = cover.ranges.get(8)!.reduce((sum, range) => sum + range.end - range.start, 0)
		expect(cover.visited).toBeLessThan(1000)
		expect(zones).toBeGreaterThan(0)
		expect(zones).toBeLessThan(100)
	})

	test('runs are ascending, disjoint and never include the global zone', () => {
		for (const level of [0, 1, 4, 7]) {
			const cover = stellariumZoneCover(stellariumConeClassifier(eraS2c(1, 0.3), deg(30)), [level])
			const ranges = cover.ranges.get(level)!
			for (let i = 0; i < ranges.length; i++) {
				expect(ranges[i].start).toBeLessThan(ranges[i].end)
				if (i > 0) expect(ranges[i].start).toBeGreaterThanOrEqual(ranges[i - 1].end)
			}
			expect(ranges.at(-1)!.end).toBeLessThanOrEqual(stellariumLocalZoneCount(level))
			// Inside runs contain only zones whose triangle is fully inside the cone.
			for (const range of ranges.filter((range) => range.inside)) {
				for (let zone = range.start; zone < range.end; zone += Math.max(1, Math.floor((range.end - range.start) / 7))) {
					for (const corner of stellariumZoneTriangle(level, zone)) expect(vecAngleUnit(corner, eraS2c(1, 0.3))).toBeLessThanOrEqual(deg(30))
				}
			}
		}
	})

	test('an empty level list selects nothing', () => {
		expect(stellariumZoneCover(stellariumConeClassifier([1, 0, 0], 1), []).ranges.size).toBe(0)
	})

	function expectRegionComplete(query: StarCatalogQuery, levels: readonly number[], seed: number) {
		const normalized = normalizeStarCatalogQuery(query)
		const classify: StellariumCapClassifier = stellariumBoxesClassifier(normalized.preselectionBoxes)
		const cover = stellariumZoneCover(classify, levels)
		const random = mulberry32(seed)
		let hits = 0

		for (const box of normalized.preselectionBoxes) {
			for (let n = 0; n < 400; n++) {
				const ra = box.minRA + random() * (box.maxRA - box.minRA)
				const dec = box.minDEC + random() * (box.maxDEC - box.minDEC)
				hits++
				const v = eraS2c(ra, dec)
				for (const level of levels) expect(coverContains(cover, level, stellariumZoneForPoint(v, level))).toBeTrue()
			}
		}

		expect(hits).toBeGreaterThan(0)
		return cover
	}

	test('box crossing RA 0', () => {
		const cover = expectRegionComplete({ kind: 'box', minRA: deg(359.5), maxRA: deg(0.5), minDEC: deg(-0.5), maxDEC: deg(0.5) }, [0, 3, 6], 9)
		const zones = cover.ranges.get(6)!.reduce((sum, range) => sum + range.end - range.start, 0)
		expect(zones).toBeLessThan(200)
	})

	test('full-RA declination band and polar cap box', () => {
		expectRegionComplete({ kind: 'box', minRA: 0, maxRA: TAU, minDEC: deg(10), maxDEC: deg(12) }, [0, 2, 4], 10)
		expectRegionComplete({ kind: 'box', minRA: 0, maxRA: TAU, minDEC: deg(85), maxDEC: deg(90) }, [0, 3, 5], 11)
		expectRegionComplete({ kind: 'box', minRA: deg(10), maxRA: deg(10), minDEC: deg(5), maxDEC: deg(5) }, [0, 5], 12)
	})

	test('triangle and polygon, including one around a pole', () => {
		expectRegionComplete({ kind: 'triangle', a: [deg(10), deg(10)], b: [deg(12), deg(10)], c: [deg(11), deg(12)] }, [0, 2, 5], 13)
		expectRegionComplete(
			{
				kind: 'polygon',
				vertices: [
					[deg(0), deg(80)],
					[deg(120), deg(80)],
					[deg(240), deg(80)],
				],
			},
			[0, 3, 5],
			14,
		)
		expectRegionComplete(
			{
				kind: 'polygon',
				vertices: [
					[deg(358), deg(-30)],
					[deg(2), deg(-30)],
					[deg(2), deg(-26)],
					[deg(358), deg(-26)],
				],
			},
			[1, 4, 6],
			15,
		)
	})

	test('a box far from a zone is outside and a zone inside a box is inside', () => {
		const classify = stellariumBoxesClassifier([{ minRA: deg(10), maxRA: deg(20), minDEC: deg(10), maxDEC: deg(20) }])
		expect(classify(eraS2c(deg(15), deg(15)), deg(1))).toBe('inside')
		expect(classify(eraS2c(deg(15), deg(15)), deg(10))).toBe('border')
		expect(classify(eraS2c(deg(200), deg(15)), deg(1))).toBe('outside')
		expect(classify(eraS2c(deg(15), deg(60)), deg(1))).toBe('outside')
		expect(classify([0, 0, 1], deg(1))).toBe('outside')
		// A cap touching the pole spans every RA.
		expect(stellariumBoxesClassifier([{ minRA: deg(10), maxRA: deg(20), minDEC: deg(80), maxDEC: deg(90) }])([0, 0, 1], deg(1))).toBe('border')
		expect(stellariumBoxesClassifier([{ minRA: 0, maxRA: TAU, minDEC: deg(80), maxDEC: deg(90) }])([0, 0, 1], deg(1))).toBe('inside')
	})
})
