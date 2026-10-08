import { PIOVERTWO, PI, TAU, ASEC2RAD } from '../../../core/constants'
import { type MutVec3, type Vec3, vecAngleUnit, vecLatitude, vecMidpoint, vecNormalizeMut, vecTripleProduct } from '../../../math/linear-algebra/vec3'
import type { Angle } from '../../../math/units/angle'
import type { StarCatalogRaDecBox } from '../catalog'

// Stellarium geodesic grid: the recursive subdivision of a regular icosahedron used by the Stellarium star
// catalogs to group stars into zones. Reproduces StelGeodesicGrid.cpp exactly: the 12 corners and the 20
// oriented faces in upstream table order (the physical zone index of level 0 is the table position), the
// normalized edge midpoints e0 = c1 + c2, e1 = c2 + c0, e2 = c0 + c1 and the children (c0, e2, e1),
// (e2, c1, e0), (e1, e0, c2) and (e0, e1, e2) numbered 4 × parent + k. A level L has 20 × 4^L local zones;
// the extra global zone index 20 × 4^L is not a triangle. Vectors are unit equatorial Cartesian directions
// (x toward RA 0, z toward the north pole), computed in double precision (upstream uses float32).
// The zone cover never materializes the grid: it walks the tree depth-first with a few small vectors per
// visited node, so a small region visits a number of nodes proportional to its border, not to 20 × 4^L.

// Golden ratio of the icosahedron construction.
const GOLDEN = (1 + Math.sqrt(5)) / 2
// Small coordinate of the icosahedron corners on the unit sphere: 1 / √(1 + φ²).
const CORNER_B = 1 / Math.sqrt(1 + GOLDEN * GOLDEN)
// Large coordinate of the icosahedron corners on the unit sphere: φ / √(1 + φ²).
const CORNER_A = CORNER_B * GOLDEN

// Number of faces of the icosahedron (zones of level 0).
export const STELLARIUM_GEODESIC_FACE_COUNT = 20

// Angular margin added to every zone bounding cap, radians (10″). It absorbs floating-point rounding of the
// geometry, the float32 zone assignment of upstream and the position quantization of the records (the real
// level 0..5 files place every star within 0.01″ of its zone triangle), so no star of a zone can lie outside
// the cap that represents it.
export const STELLARIUM_GEODESIC_COVER_MARGIN = 10 * ASEC2RAD

// The 12 icosahedron corners in upstream order, unit vectors.
export const STELLARIUM_ICOSAHEDRON_CORNERS: readonly Vec3[] = [
	[CORNER_A, -CORNER_B, 0],
	[CORNER_A, CORNER_B, 0],
	[-CORNER_A, CORNER_B, 0],
	[-CORNER_A, -CORNER_B, 0],
	[0, CORNER_A, -CORNER_B],
	[0, CORNER_A, CORNER_B],
	[0, -CORNER_A, CORNER_B],
	[0, -CORNER_A, -CORNER_B],
	[-CORNER_B, 0, CORNER_A],
	[CORNER_B, 0, CORNER_A],
	[CORNER_B, 0, -CORNER_A],
	[-CORNER_B, 0, -CORNER_A],
]

// The 20 oriented faces as corner indices (c0, c1, c2) in upstream order; counterclockwise seen from outside.
// oxfmt-ignore
export const STELLARIUM_ICOSAHEDRON_TRIANGLES: readonly (readonly [number, number, number])[] = [
	[1, 0, 10], [0, 1, 9], [0, 9, 6], [9, 8, 6], [0, 7, 10], [6, 7, 0], [7, 6, 3], [6, 8, 3], [11, 10, 7], [7, 3, 11],
	[3, 2, 11], [2, 3, 8], [10, 11, 4], [2, 4, 11], [5, 4, 2], [2, 8, 5], [4, 1, 10], [4, 5, 1], [5, 9, 1], [8, 9, 5],
]

// Relation of a zone bounding cap to a query region.
export type StellariumCapRelation = 'outside' | 'border' | 'inside'

// Classifies a bounding cap (unit center vector, angular radius in radians) against a region. It must be
// conservative: 'outside' only when no point of the cap can belong to the region, 'inside' only when every
// point of the cap passes the region's coarse test.
export type StellariumCapClassifier = (center: Vec3, radius: Angle) => StellariumCapRelation

// A run of consecutive local zones of one level, [start, end), with a common relation.
export interface StellariumZoneRange {
	// First zone of the run.
	readonly start: number
	// Zone after the last one of the run.
	readonly end: number
	// True when every zone of the run lies inside the classifier region.
	readonly inside: boolean
}

// Result of a zone cover: the candidate local zones of each requested level.
export interface StellariumZoneCover {
	// Ascending, non-overlapping zone runs keyed by level; the global zone is never included.
	readonly ranges: ReadonlyMap<number, readonly StellariumZoneRange[]>
	// Number of tree nodes classified, a measure of the traversal cost.
	readonly visited: number
}

// Returns the number of local (triangle) zones of a level, 20 × 4^level, which is also the global zone index.
export function stellariumLocalZoneCount(level: number) {
	return STELLARIUM_GEODESIC_FACE_COUNT * 4 ** level
}

// Returns the three corners (c0, c1, c2) of a local zone of a level as fresh unit vectors.
export function stellariumZoneTriangle(level: number, zone: number): [MutVec3, MutVec3, MutVec3] {
	let face = zone

	for (let l = 0; l < level; l++) face = Math.floor(face / 4)

	const t = STELLARIUM_ICOSAHEDRON_TRIANGLES[face]
	const c = STELLARIUM_ICOSAHEDRON_CORNERS
	let c0: MutVec3 = [...c[t[0]]]
	let c1: MutVec3 = [...c[t[1]]]
	let c2: MutVec3 = [...c[t[2]]]

	for (let l = level - 1; l >= 0; l--) {
		const k = Math.floor(zone / 4 ** l) % 4
		const e0 = vecMidpoint(c1, c2)
		const e1 = vecMidpoint(c2, c0)
		const e2 = vecMidpoint(c0, c1)

		if (k === 0) {
			c1 = e2
			c2 = e1
		} else if (k === 1) {
			c0 = e2
			c2 = e0
		} else if (k === 2) {
			c0 = e1
			c1 = e0
		} else {
			c0 = e0
			c1 = e1
			c2 = e2
		}
	}

	return [c0, c1, c2]
}

// Returns the local zone of a level that contains the direction `v` (any non-zero vector), with the same
// half-space tests and tie order as StelGeodesicGrid::getZoneNumberForPoint: a point on a shared edge belongs
// to the first face that accepts it, and to the lowest child. If rounding makes every face reject the point,
// the face whose worst edge test is the least negative is used instead of failing.
export function stellariumZoneForPoint(v: Vec3, level: number) {
	const corners = STELLARIUM_ICOSAHEDRON_CORNERS
	let face = -1
	let bestFace = 0
	let bestScore = -Infinity

	for (let i = 0; i < STELLARIUM_GEODESIC_FACE_COUNT; i++) {
		const t = STELLARIUM_ICOSAHEDRON_TRIANGLES[i]
		const c0 = corners[t[0]]
		const c1 = corners[t[1]]
		const c2 = corners[t[2]]
		const score = Math.min(vecTripleProduct(v, c0, c1), vecTripleProduct(v, c1, c2), vecTripleProduct(v, c2, c0))

		if (score >= 0) {
			face = i
			break
		} else if (score > bestScore) {
			bestScore = score
			bestFace = i
		}
	}

	if (face < 0) face = bestFace

	const t = STELLARIUM_ICOSAHEDRON_TRIANGLES[face]
	let c0: Vec3 = corners[t[0]]
	let c1: Vec3 = corners[t[1]]
	let c2: Vec3 = corners[t[2]]
	let zone = face

	for (let l = 0; l < level; l++) {
		const e0 = vecMidpoint(c1, c2)
		const e1 = vecMidpoint(c2, c0)
		const e2 = vecMidpoint(c0, c1)
		zone *= 4

		if (vecTripleProduct(v, e1, e2) <= 0) {
			c1 = e2
			c2 = e1
		} else if (vecTripleProduct(v, e2, e0) <= 0) {
			zone += 1
			c0 = e2
			c2 = e0
		} else if (vecTripleProduct(v, e0, e1) <= 0) {
			zone += 2
			c0 = e1
			c1 = e0
		} else {
			zone += 3
			c0 = e0
			c1 = e1
			c2 = e2
		}
	}

	return zone
}

// Computes the candidate local zones of each requested level for a region. Walks the subdivision tree from
// the 20 faces down to the deepest requested level, bounding every node by the cap centered on the normalized
// sum of its corners whose radius is the largest corner distance plus STELLARIUM_GEODESIC_COVER_MARGIN (every
// point of a geodesic triangle is a normalized non-negative combination of its corners, so it is not farther
// from the center than the farthest corner). Outside nodes are pruned with their descendants, inside nodes emit
// all their descendants at every deeper requested level without further classification, and border nodes emit
// themselves at requested levels and recurse. The cover may contain zones that hold no match, never omit a zone
// that can. `levels` may be unsorted and contain duplicates; levels above 30 would exceed exact integer zone
// numbering and are outside the domain.
export function stellariumZoneCover(classify: StellariumCapClassifier, levels: readonly number[]): StellariumZoneCover {
	const ranges = new Map<number, StellariumZoneRange[]>()
	let maxLevel = -1

	for (const level of levels) {
		if (!ranges.has(level)) ranges.set(level, [])
		if (level > maxLevel) maxLevel = level
	}

	let visited = 0

	if (maxLevel < 0) return { ranges, visited }

	const requested = new Array<StellariumZoneRange[] | undefined>(maxLevel + 1)
	for (const [level, list] of ranges) requested[level] = list

	const emit = (level: number, start: number, end: number, inside: boolean) => {
		const list = requested[level]!
		const last = list.at(-1)
		if (last !== undefined && last.end === start && last.inside === inside) list[list.length - 1] = { start: last.start, end, inside }
		else list.push({ start, end, inside })
	}

	const center: MutVec3 = [0, 0, 0]

	const walk = (c0: Vec3, c1: Vec3, c2: Vec3, depth: number, zone: number) => {
		visited++

		center[0] = c0[0] + c1[0] + c2[0]
		center[1] = c0[1] + c1[1] + c2[1]
		center[2] = c0[2] + c1[2] + c2[2]
		vecNormalizeMut(center)

		const radius = Math.max(vecAngleUnit(center, c0), vecAngleUnit(center, c1), vecAngleUnit(center, c2)) + STELLARIUM_GEODESIC_COVER_MARGIN
		const relation = classify(center, radius)

		if (relation === 'outside') return

		if (relation === 'inside') {
			for (let level = depth, size = 1; level <= maxLevel; level++, size *= 4) {
				if (requested[level] !== undefined) emit(level, zone * size, (zone + 1) * size, true)
			}

			return
		}

		if (requested[depth] !== undefined) emit(depth, zone, zone + 1, false)

		if (depth < maxLevel) {
			const e0 = vecMidpoint(c1, c2)
			const e1 = vecMidpoint(c2, c0)
			const e2 = vecMidpoint(c0, c1)
			const child = zone * 4
			walk(c0, e2, e1, depth + 1, child)
			walk(e2, c1, e0, depth + 1, child + 1)
			walk(e1, e0, c2, depth + 1, child + 2)
			walk(e0, e1, e2, depth + 1, child + 3)
		}
	}

	const corners = STELLARIUM_ICOSAHEDRON_CORNERS

	for (let face = 0; face < STELLARIUM_GEODESIC_FACE_COUNT; face++) {
		const t = STELLARIUM_ICOSAHEDRON_TRIANGLES[face]
		walk(corners[t[0]], corners[t[1]], corners[t[2]], 0, face)
	}

	return { ranges, visited }
}

// Builds a cap classifier for a cone of angular `radius` (radians) around the unit vector `axis`.
// A cap is outside when its center is farther than radius + capRadius (never when that sum reaches π) and
// inside when center distance + capRadius does not exceed the cone radius or the cone is the whole sphere.
export function stellariumConeClassifier(axis: Vec3, radius: Angle): StellariumCapClassifier {
	return (center, capRadius) => {
		const distance = vecAngleUnit(center, axis)
		if (radius >= PI || distance + capRadius <= radius) return 'inside'
		if (radius + capRadius < PI && distance > radius + capRadius) return 'outside'
		return 'border'
	}
}

// Builds a cap classifier for a union of non-wrapping RA/Dec boxes (radians, RA within [0, 2π]). The cap is
// replaced by its RA/Dec bounding box: declinations center ± radius clamped to ±π/2, and RA center ± asin(sin radius / cos δ)
// or the full circle when the cap reaches a pole. A cap is outside when its bounding box overlaps no box
// (RA compared modulo 2π) and inside when it is contained in a single box.
export function stellariumBoxesClassifier(boxes: readonly StarCatalogRaDecBox[]): StellariumCapClassifier {
	return (center, capRadius) => {
		const dec = vecLatitude(center)
		const fullRA = dec + capRadius >= PIOVERTWO || dec - capRadius <= -PIOVERTWO
		const minDEC = Math.max(-PIOVERTWO, dec - capRadius)
		const maxDEC = Math.min(PIOVERTWO, dec + capRadius)
		let minRA = 0
		let maxRA = TAU

		if (!fullRA) {
			const ra = Math.atan2(center[1], center[0])
			const halfWidth = Math.asin(Math.min(1, Math.sin(capRadius) / Math.cos(dec)))
			minRA = ra - halfWidth
			maxRA = ra + halfWidth
		}

		let relation: StellariumCapRelation = 'outside'

		for (const box of boxes) {
			if (maxDEC < box.minDEC || minDEC > box.maxDEC) continue

			const boxFullRA = box.maxRA - box.minRA >= TAU

			if (fullRA || boxFullRA) {
				if (boxFullRA && minDEC >= box.minDEC && maxDEC <= box.maxDEC) return 'inside'
				relation = 'border'
				continue
			}

			for (let shift = -TAU; shift <= TAU; shift += TAU) {
				const lo = box.minRA + shift
				const hi = box.maxRA + shift
				if (maxRA < lo || minRA > hi) continue
				if (minRA >= lo && maxRA <= hi && minDEC >= box.minDEC && maxDEC <= box.maxDEC) return 'inside'
				relation = 'border'
			}
		}

		return relation
	}
}
