import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { DEG2RAD, PI, PIOVERTWO, TAU } from '../../core/constants'
import { GEOMETRY_EPSILON, validateLatitude } from '../../core/validation'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import type { Velocity } from '../../math/units/velocity'

// Generic star-catalog query model and base implementation: defines the public catalog interface and
// entry shape, the cone/triangle/box/polygon query union, and the normalization that turns each query
// into coarse RA/Dec preselection boxes plus an exact membership test. BaseStarCatalog drives the
// shared stream/filter flow; concrete providers supply only the candidate stream. Angles are radians,
// RA normalized to [0, TAU); polygon/triangle tests use a tangent-plane projection centered on the region.

// Minimum declination (south pole), radians.
const MIN_DEC = -PIOVERTWO
// Maximum declination (north pole), radians.
const MAX_DEC = PIOVERTWO
// Tangent-plane span (radians) above which polygon queries are less accurate; large fields are allowed but flagged.
const TANGENT_POLYGON_RECOMMENDED_SPAN = 20 * DEG2RAD

// A sky vertex as [right ascension, declination], radians.
export type Vertex = readonly [Angle, Angle]

// Supported query region shapes.
export type StarCatalogQueryKind = 'cone' | 'triangle' | 'box' | 'polygon'

// Exact-membership test strategy: full spherical geometry or a tangent-plane projection.
export type StarCatalogGeometryMode = 'spherical' | 'planarTangent'

// A catalog star: an equatorial position plus optional epoch, photometry, and motion.
export interface StarCatalogEntry extends Readonly<EquatorialCoordinate> {
	// Catalog epoch as a Julian year number or a Besselian "B1950"-style string.
	readonly epoch?: number | `B${number}`
	// Apparent magnitude.
	readonly magnitude?: number
	readonly pmRA?: Angle // per year
	readonly pmDEC?: Angle // per year
	// Radial velocity.
	readonly rv?: Velocity
}

// A circular (cone) region query around a center.
export interface StarCatalogConeQuery {
	readonly kind: 'cone'
	// Cone center right ascension, radians.
	readonly centerRA: Angle
	// Cone center declination, radians.
	readonly centerDEC: Angle
	// Angular radius, radians (0..PI).
	readonly radius: Angle
}

// A spherical-triangle region query.
export interface StarCatalogTriangleQuery {
	readonly kind: 'triangle'
	readonly a: Vertex
	readonly b: Vertex
	readonly c: Vertex
}

// An RA/Dec rectangular region query (may wrap across RA=0).
export interface StarCatalogBoxQuery {
	readonly kind: 'box'
	readonly minRA: Angle
	readonly maxRA: Angle
	readonly minDEC: Angle
	readonly maxDEC: Angle
}

// A convex-polygon region query.
export interface StarCatalogPolygonQuery {
	readonly kind: 'polygon'
	readonly vertices: readonly Vertex[]
}

// Union of all public query shapes.
export type StarCatalogQuery = StarCatalogConeQuery | StarCatalogTriangleQuery | StarCatalogBoxQuery | StarCatalogPolygonQuery

// Public catalog interface: region queries (sync or async) plus a streaming variant.
export interface StarCatalog<T extends StarCatalogEntry = StarCatalogEntry> {
	readonly queryRegion: (query: StarCatalogQuery) => Promise<readonly T[]> | readonly T[]
	readonly queryCone: (centerRA: Angle, centerDEC: Angle, radius: Angle) => Promise<readonly T[]> | readonly T[]
	readonly queryTriangle: (a: Vertex, b: Vertex, c: Vertex) => Promise<readonly T[]> | readonly T[]
	readonly queryBox: (minRA: Angle, maxRA: Angle, minDEC: Angle, maxDEC: Angle) => Promise<readonly T[]> | readonly T[]
	readonly queryPolygon: (vertices: readonly Vertex[]) => Promise<readonly T[]> | readonly T[]
	readonly streamRegion: (query: StarCatalogQuery) => AsyncIterable<T> | Iterable<T>
}

// A non-wrapping RA/Dec box used as a coarse provider preselection window.
export interface StarCatalogRaDecBox {
	readonly minRA: Angle
	readonly maxRA: Angle
	readonly minDEC: Angle
	readonly maxDEC: Angle
}

// Shared fields of a normalized query: filters, geometry mode, and coarse preselection metadata.
interface NormalizedQueryBase {
	// Lower magnitude bound, if filtering by brightness.
	readonly magnitudeMin?: number
	// Upper magnitude bound, if filtering by brightness.
	readonly magnitudeMax?: number
	// Maximum number of results to materialize.
	readonly limit?: number
	// Exact-test strategy.
	readonly geometryMode: StarCatalogGeometryMode
	// True when the region wraps across RA=0 (split into multiple boxes).
	readonly wrapAround: boolean
	// Coarse RA/Dec boxes a provider can use to preselect candidates.
	readonly preselectionBoxes: readonly StarCatalogRaDecBox[]
	// Optional anchor (region center) for result ordering.
	readonly sortAnchor?: Vertex
}

// Normalized cone query with cached center trig.
interface NormalizedConeQuery extends NormalizedQueryBase {
	readonly kind: 'cone'
	readonly centerRA: Angle
	readonly centerDEC: Angle
	readonly radius: Angle
	// Cached sin/cos of the cone center declination, reused by the per-candidate exact test.
	readonly sinCenterDEC: number
	readonly cosCenterDEC: number
}

// Normalized triangle query with its tangent-plane projection.
interface NormalizedTriangleQuery extends NormalizedQueryBase {
	readonly kind: 'triangle'
	// Triangle vertices projected onto the tangent plane.
	readonly projectedVertices: readonly Vertex[]
	// Tangent-plane center right ascension, radians.
	readonly tangentCenterRA: Angle
	// Tangent-plane center declination, radians.
	readonly tangentCenterDEC: Angle
	// Cached cos of the tangent center declination, reused when projecting each candidate.
	readonly cosTangentCenterDEC: number
}

// Normalized box query with its exact non-wrapping pieces.
interface NormalizedBoxQuery extends NormalizedQueryBase {
	readonly kind: 'box'
	// Exact RA/Dec boxes the entry must fall inside.
	readonly boxes: readonly StarCatalogRaDecBox[]
}

// Normalized polygon query with its tangent-plane projection.
interface NormalizedPolygonQuery extends NormalizedQueryBase {
	readonly kind: 'polygon'
	// Polygon vertices projected onto the tangent plane.
	readonly projectedVertices: readonly Vertex[]
	// Tangent-plane center right ascension, radians.
	readonly tangentCenterRA: Angle
	// Tangent-plane center declination, radians.
	readonly tangentCenterDEC: Angle
	// Cached cos of the tangent center declination, reused when projecting each candidate.
	readonly cosTangentCenterDEC: number
}

// Union of all normalized query shapes.
export type NormalizedStarCatalogQuery = NormalizedConeQuery | NormalizedTriangleQuery | NormalizedBoxQuery | NormalizedPolygonQuery

// Implements the generic query, filtering, projection, and propagation flow for concrete catalogs.
export abstract class BaseStarCatalog<T extends StarCatalogEntry> implements StarCatalog<T> {
	// Returns provider-specific candidates for a normalized query.
	protected abstract streamCandidateEntries(query: NormalizedStarCatalogQuery): AsyncIterable<T> | Iterable<T>

	// Runs a normalized query and materializes a finite result set.
	async queryRegion(query: StarCatalogQuery) {
		const normalized = normalizeStarCatalogQuery(query)
		const items: T[] = []

		for await (const entry of this.streamNormalizedRegion(normalized)) {
			items.push(entry)

			if (normalized.limit !== undefined && items.length >= normalized.limit) {
				break
			}
		}

		return items
	}

	// Runs a cone query by adapting it to the region interface.
	queryCone(centerRA: Angle, centerDEC: Angle, radius: Angle) {
		return this.queryRegion({ kind: 'cone', centerRA, centerDEC, radius })
	}

	queryTriangle(a: Vertex, b: Vertex, c: Vertex) {
		return this.queryRegion({ kind: 'triangle', a, b, c })
	}

	// Runs an RA/Dec box query by adapting it to the region interface.
	queryBox(minRA: Angle, maxRA: Angle, minDEC: Angle, maxDEC: Angle) {
		return this.queryRegion({ kind: 'box', minRA, maxRA, minDEC, maxDEC })
	}

	// Runs a polygon query by adapting it to the region interface.
	queryPolygon(vertices: readonly Vertex[]) {
		return this.queryRegion({ kind: 'polygon', vertices })
	}

	// Streams a region query after exact filtering, optional propagation, and projection.
	streamRegion(query: StarCatalogQuery) {
		return this.streamNormalizedRegion(normalizeStarCatalogQuery(query))
	}

	// Streams provider candidates and applies generic exact filtering.
	protected async *streamNormalizedRegion(query: NormalizedStarCatalogQuery) {
		for await (const entry of this.streamCandidateEntries(query)) {
			if (!matchesNormalizedGeometry(entry, query)) continue
			yield entry
		}
	}
}

// Normalizes and validates a public query before it reaches a provider.
export function normalizeStarCatalogQuery(query: StarCatalogQuery): NormalizedStarCatalogQuery {
	switch (query.kind) {
		case 'cone':
			return normalizeConeQuery(query)
		case 'triangle':
			return normalizeTriangleQuery(query)
		case 'box':
			return normalizeBoxQuery(query)
		case 'polygon':
			return normalizePolygonQuery(query)
		default:
			throw new Error(`unsupported query kind: ${(query as { kind?: string }).kind}`)
	}
}

// Normalizes an RA span into one or two non-wrapping boxes.
export function splitRaBox(minRA: Angle, maxRA: Angle, minDEC: Angle, maxDEC: Angle): readonly StarCatalogRaDecBox[] {
	const normalizedMinRA = normalizeAngle(minRA)
	const normalizedMaxRA = normalizeAngle(maxRA)
	const normalizedMinDEC = validateLatitude(minDEC)
	const normalizedMaxDEC = validateLatitude(maxDEC)

	if (normalizedMinDEC > normalizedMaxDEC + GEOMETRY_EPSILON) {
		throw new Error(`invalid declination range: [${minDEC}, ${maxDEC}]`)
	}

	if (Math.abs(maxRA - minRA) >= TAU - GEOMETRY_EPSILON) {
		return [{ minRA: 0, maxRA: TAU, minDEC: normalizedMinDEC, maxDEC: normalizedMaxDEC }]
	}

	if (normalizedMinRA <= normalizedMaxRA) {
		return [{ minRA: normalizedMinRA, maxRA: normalizedMaxRA, minDEC: normalizedMinDEC, maxDEC: normalizedMaxDEC }]
	}

	return [
		{ minRA: 0, maxRA: normalizedMaxRA, minDEC: normalizedMinDEC, maxDEC: normalizedMaxDEC },
		{ minRA: normalizedMinRA, maxRA: TAU, minDEC: normalizedMinDEC, maxDEC: normalizedMaxDEC },
	]
}

// Projects a polygon vertex onto a tangent plane centered on the query region.
export function projectPolygonVertex(ra: Angle, dec: Angle, centerRA: Angle, centerDEC: Angle): Vertex {
	const deltaRa = shortestSignedRaDelta(ra, centerRA)
	return [deltaRa * Math.cos(centerDEC), dec - centerDEC] as const
}

// Normalizes a cone query and computes its coarse preselection box.
function normalizeConeQuery(query: StarCatalogConeQuery): NormalizedConeQuery {
	const centerRA = normalizeAngle(query.centerRA)
	const centerDEC = validateLatitude(query.centerDEC)

	if (!Number.isFinite(query.radius) || query.radius < 0 || query.radius > PI) {
		throw new Error(`invalid cone radius: ${query.radius}. Expected a finite value in [0, pi]`)
	}

	const radius = query.radius
	const minDEC = clamp(centerDEC - radius, MIN_DEC, MAX_DEC)
	const maxDEC = clamp(centerDEC + radius, MIN_DEC, MAX_DEC)

	let preselectionBoxes: readonly StarCatalogRaDecBox[]
	let wrapAround = false

	if (radius >= PI || maxDEC >= MAX_DEC - GEOMETRY_EPSILON || minDEC <= MIN_DEC + GEOMETRY_EPSILON) {
		preselectionBoxes = [{ minRA: 0, maxRA: TAU, minDEC: minDEC, maxDEC: maxDEC }]
	} else {
		const sinSpan = Math.sin(radius) / Math.max(GEOMETRY_EPSILON, Math.cos(centerDEC))
		const halfSpan = Math.asin(clamp(sinSpan, -1, 1))
		const minRA = centerRA - halfSpan
		const maxRA = centerRA + halfSpan
		preselectionBoxes = splitRaBox(minRA, maxRA, minDEC, maxDEC)
		wrapAround = preselectionBoxes.length > 1
	}

	return {
		kind: 'cone',
		centerRA,
		centerDEC,
		radius,
		sinCenterDEC: Math.sin(centerDEC),
		cosCenterDEC: Math.cos(centerDEC),
		geometryMode: 'spherical',
		wrapAround,
		preselectionBoxes,
		sortAnchor: [centerRA, centerDEC],
	}
}

// Normalizes a triangle query and builds its tangent-plane projection.
function normalizeTriangleQuery(query: StarCatalogTriangleQuery): NormalizedTriangleQuery {
	const normalizedVertices = [
		[normalizeAngle(query.a[0]), validateLatitude(query.a[1])],
		[normalizeAngle(query.b[0]), validateLatitude(query.b[1])],
		[normalizeAngle(query.c[0]), validateLatitude(query.c[1])],
	] as const satisfies readonly Vertex[]
	const tangentCenterRA = meanRightAscension(normalizedVertices)
	const tangentCenterDEC = (normalizedVertices[0][1] + normalizedVertices[1][1] + normalizedVertices[2][1]) / 3
	const projectedVertices = normalizedVertices.map(([ra, dec]) => projectPolygonVertex(ra, dec, tangentCenterRA, tangentCenterDEC))
	const [minProjectedX, maxProjectedX, minDEC, maxDEC] = polygonBounds(projectedVertices, tangentCenterDEC)
	const preselectionBoxes = projectedPolygonToBoxes(minProjectedX, maxProjectedX, minDEC, maxDEC, tangentCenterRA, tangentCenterDEC)
	const wrapAround = preselectionBoxes.length > 1

	return {
		kind: 'triangle',
		projectedVertices,
		tangentCenterRA: tangentCenterRA,
		tangentCenterDEC: tangentCenterDEC,
		cosTangentCenterDEC: Math.cos(tangentCenterDEC),
		geometryMode: 'planarTangent',
		wrapAround,
		preselectionBoxes,
		sortAnchor: [tangentCenterRA, tangentCenterDEC],
	}
}

// Normalizes a box query and computes its exact non-wrapping pieces.
function normalizeBoxQuery(query: StarCatalogBoxQuery): NormalizedBoxQuery {
	const boxes = splitRaBox(query.minRA, query.maxRA, query.minDEC, query.maxDEC)
	const wrapAround = boxes.length > 1
	const centerRA = wrapAround ? normalizeAngle((boxes[0].maxRA + boxes[1].minRA) * 0.5) : normalizeAngle((boxes[0].minRA + boxes[0].maxRA) * 0.5)
	const centerDEC = (boxes[0].minDEC + boxes[0].maxDEC) * 0.5

	return {
		kind: 'box',
		boxes,
		geometryMode: 'spherical',
		wrapAround,
		preselectionBoxes: boxes,
		sortAnchor: [centerRA, centerDEC],
	}
}

// Normalizes a polygon query and builds its tangent-plane projection.
function normalizePolygonQuery(query: StarCatalogPolygonQuery): NormalizedPolygonQuery {
	if (query.vertices.length < 3) {
		throw new Error('polygon queries require at least three vertices')
	}

	const normalizedVertices: Vertex[] = []

	for (const vertex of query.vertices) {
		normalizedVertices.push([normalizeAngle(vertex[0]), validateLatitude(vertex[1])] as const)
	}

	const tangentCenterRA = meanRightAscension(normalizedVertices)
	const tangentCenterDEC = normalizedVertices.reduce((sum, [, dec]) => sum + dec, 0) / normalizedVertices.length
	const projectedVertices = normalizedVertices.map(([ra, dec]) => projectPolygonVertex(ra, dec, tangentCenterRA, tangentCenterDEC))
	const [minProjectedX, maxProjectedX, minDEC, maxDEC] = polygonBounds(projectedVertices, tangentCenterDEC)
	const preselectionBoxes = projectedPolygonToBoxes(minProjectedX, maxProjectedX, minDEC, maxDEC, tangentCenterRA, tangentCenterDEC)
	const wrapAround = preselectionBoxes.length > 1

	if (maxProjectedX - minProjectedX > TANGENT_POLYGON_RECOMMENDED_SPAN) {
		// Large polygons are still allowed, but the tangent-plane exact test is documented as best for smaller fields.
	}

	return {
		kind: 'polygon',
		projectedVertices,
		tangentCenterRA: tangentCenterRA,
		tangentCenterDEC: tangentCenterDEC,
		cosTangentCenterDEC: Math.cos(tangentCenterDEC),
		geometryMode: 'planarTangent',
		wrapAround,
		preselectionBoxes,
		sortAnchor: [tangentCenterRA, tangentCenterDEC],
	}
}

// Checks the exact query geometry after provider-side coarse preselection.
function matchesNormalizedGeometry(entry: StarCatalogEntry, query: NormalizedStarCatalogQuery) {
	switch (query.kind) {
		case 'cone':
			return coneContainsEntry(entry.rightAscension, entry.declination, query)
		case 'box':
			return query.boxes.some((box) => matchesBox(entry.rightAscension, entry.declination, box))
		case 'triangle':
		case 'polygon': {
			// Inline the tangent-plane projection using the cached cos(centerDEC) and avoid a per-candidate tuple allocation.
			const deltaRa = shortestSignedRaDelta(entry.rightAscension, query.tangentCenterRA)
			return pointInProjectedPolygon(deltaRa * query.cosTangentCenterDEC, entry.declination - query.tangentCenterDEC, query.projectedVertices)
		}
		default:
			return false
	}
}

// Tests cone membership reusing the cached center sin/cos, mirroring sphericalSeparation's atan2 formulation
// so small-cone numerical robustness is preserved. RA/Dec in radians; tolerant by GEOMETRY_EPSILON.
function coneContainsEntry(ra: Angle, dec: Angle, query: NormalizedConeQuery) {
	const dLongitude = ra - query.centerRA
	const sinDec = Math.sin(dec)
	const cosDec = Math.cos(dec)
	const sinDLongitude = Math.sin(dLongitude)
	const cosDLongitude = Math.cos(dLongitude)
	const x = cosDec * sinDLongitude
	const y = query.cosCenterDEC * sinDec - query.sinCenterDEC * cosDec * cosDLongitude
	const z = query.sinCenterDEC * sinDec + query.cosCenterDEC * cosDec * cosDLongitude
	return Math.atan2(Math.hypot(x, y), z) <= query.radius + GEOMETRY_EPSILON
}

// Checks whether a normalized entry falls inside a non-wrapping box.
function matchesBox(ra: Angle, dec: Angle, box: StarCatalogRaDecBox) {
	return ra + GEOMETRY_EPSILON >= box.minRA && ra <= box.maxRA + GEOMETRY_EPSILON && dec + GEOMETRY_EPSILON >= box.minDEC && dec <= box.maxDEC + GEOMETRY_EPSILON
}

// Computes a representative RA from a set of wrapped longitudes.
function meanRightAscension(vertices: readonly Vertex[]) {
	let sinSum = 0
	let cosSum = 0

	for (const [ra] of vertices) {
		sinSum += Math.sin(ra)
		cosSum += Math.cos(ra)
	}

	return normalizeAngle(Math.atan2(sinSum, cosSum))
}

// Computes the tangent-plane bounds of a projected polygon.
function polygonBounds(projectedVertices: readonly Vertex[], tangentCenterDec: Angle): readonly [number, number, Angle, Angle] {
	let minX = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY

	for (const [x, y] of projectedVertices) {
		if (x < minX) minX = x
		if (x > maxX) maxX = x
		if (y < minY) minY = y
		if (y > maxY) maxY = y
	}

	return [minX, maxX, tangentCenterDec + minY, tangentCenterDec + maxY] as const
}

// Converts tangent-plane polygon bounds back into one or two RA boxes.
function projectedPolygonToBoxes(minProjectedX: number, maxProjectedX: number, minDEC: Angle, maxDEC: Angle, tangentCenterRa: Angle, tangentCenterDec: Angle): readonly StarCatalogRaDecBox[] {
	const cosCenter = Math.max(Math.cos(tangentCenterDec), GEOMETRY_EPSILON)
	const minRA = tangentCenterRa + minProjectedX / cosCenter
	const maxRA = tangentCenterRa + maxProjectedX / cosCenter
	return splitRaBox(minRA, maxRA, minDEC, maxDEC)
}

// Checks whether a tangent-plane point (px, py) falls inside a polygon using ray casting.
function pointInProjectedPolygon(px: number, py: number, polygon: readonly Vertex[]) {
	let inside = false
	let j = polygon.length - 1

	for (let i = 0; i < polygon.length; i++) {
		const xi = polygon[i][0]
		const yi = polygon[i][1]
		const xj = polygon[j][0]
		const yj = polygon[j][1]
		const crosses = yi > py !== yj > py
		const xIntersection = ((xj - xi) * (py - yi)) / (yj - yi || Number.MIN_VALUE) + xi

		if (crosses && px <= xIntersection + GEOMETRY_EPSILON) {
			inside = !inside
		}

		j = i
	}

	return inside
}

// Computes a wrapped signed RA delta relative to a reference longitude.
function shortestSignedRaDelta(ra: Angle, referenceRa: Angle) {
	let delta = normalizeAngle(ra) - normalizeAngle(referenceRa)
	if (delta > PI) delta -= TAU
	else if (delta <= -PI) delta += TAU
	return delta
}
