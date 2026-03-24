import { type Angle, deg, mas, normalizeAngle } from './angle'
import { PI, PIOVERTWO, TAU } from './constants'
import { sphericalSeparation } from './geometry'
import { clamp } from './math'

const FULL_CIRCLE = TAU
const HALF_CIRCLE = PI
const MIN_DEC = -PIOVERTWO
const MAX_DEC = PIOVERTWO
const MAX_RESULT_LIMIT = 1_000_000
const GEOMETRY_EPSILON = 1e-12
const TANGENT_POLYGON_RECOMMENDED_SPAN = deg(20)

const CORE_RESULT_FIELDS = new Set<StarCatalogFieldName>(['id', 'ra', 'dec', 'epoch', 'sourceCatalog'])
const KNOWN_RESULT_FIELDS = new Set<StarCatalogFieldName>(['id', 'ra', 'dec', 'epoch', 'pmRaMasYr', 'pmDecMasYr', 'mag', 'magBand', 'magBands', 'positionErrorMas', 'properMotionError', 'flags', 'sourceCatalog', 'raw', 'extras'])

export type StarCatalogFieldName = 'id' | 'ra' | 'dec' | 'epoch' | 'pmRaMasYr' | 'pmDecMasYr' | 'mag' | 'magBand' | 'magBands' | 'positionErrorMas' | 'properMotionError' | 'flags' | 'sourceCatalog' | 'raw' | 'extras'

export type StarCatalogQueryKind = 'cone' | 'box' | 'polygon'

export type StarCatalogSortMode = 'none' | 'id' | 'ra' | 'dec' | 'mag' | 'distance'

export type StarCatalogGeometryMode = 'spherical' | 'planar-tangent'

export type StarCatalogMissingProperMotionMode = 'keep' | 'exclude' | 'error'

export interface StarCatalogMetadata {
	readonly catalogName: string
	readonly catalogVersion: string
	readonly referenceEpoch: number
	readonly referenceFrame: string
	readonly magnitudeSystems: readonly string[]
	readonly angularUnits: 'rad'
	readonly properMotionAvailability: 'none' | 'partial' | 'full'
	readonly photometricFields: readonly string[]
	readonly sourceIdentifierFormat: string
	readonly storageLayout: string
	readonly zoneIndex: string
	readonly supportedQueryTypes: readonly StarCatalogQueryKind[]
	readonly normalizedFieldAvailability: {
		readonly always: readonly StarCatalogFieldName[]
		readonly optional: readonly StarCatalogFieldName[]
	}
	readonly notes?: readonly string[]
}

export interface StarCatalogProperMotionError {
	readonly raMasYr?: number
	readonly decMasYr?: number
}

export interface StarCatalogEntry {
	readonly id: string
	readonly ra: Angle
	readonly dec: Angle
	readonly epoch: number
	readonly pmRaMasYr?: number
	readonly pmDecMasYr?: number
	readonly mag?: number
	readonly magBand?: string
	readonly magBands?: Readonly<Record<string, number | undefined>>
	readonly positionErrorMas?: number
	readonly properMotionError?: StarCatalogProperMotionError
	readonly flags?: Readonly<Record<string, string | number | boolean | undefined>> | number
	readonly sourceCatalog: string
	readonly raw?: unknown
	readonly extras?: Readonly<Record<string, unknown>>
}

export interface StarCatalogFlagFilter {
	readonly required?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
	readonly excluded?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
	readonly bitmaskAll?: number
	readonly bitmaskAny?: number
}

export interface StarCatalogEpochPropagation {
	readonly targetEpoch: number
	readonly onMissingProperMotion?: StarCatalogMissingProperMotionMode
}

export interface StarCatalogQueryBase {
	readonly magnitudeMin?: number
	readonly magnitudeMax?: number
	readonly limit?: number
	readonly sortMode?: StarCatalogSortMode
	readonly requestedFields?: readonly StarCatalogFieldName[]
	readonly epochPropagation?: StarCatalogEpochPropagation
	readonly qualityFilter?: StarCatalogFlagFilter
	readonly includeRaw?: boolean
	readonly requireCompleteFields?: readonly StarCatalogFieldName[]
}

export interface StarCatalogConeQuery extends StarCatalogQueryBase {
	readonly kind: 'cone'
	readonly centerRa: Angle
	readonly centerDec: Angle
	readonly radius: Angle
}

export interface StarCatalogBoxQuery extends StarCatalogQueryBase {
	readonly kind: 'box'
	readonly minRa: Angle
	readonly maxRa: Angle
	readonly minDec: Angle
	readonly maxDec: Angle
}

export interface StarCatalogPolygonQuery extends StarCatalogQueryBase {
	readonly kind: 'polygon'
	readonly verticesRaDec: readonly (readonly [Angle, Angle])[]
}

export type StarCatalogQuery = StarCatalogConeQuery | StarCatalogBoxQuery | StarCatalogPolygonQuery

export interface StarCatalogCapabilities {
	readonly featureNames: readonly string[]
	readonly queryTypes: readonly StarCatalogQueryKind[]
	readonly efficientQueryTypes: readonly StarCatalogQueryKind[]
	readonly supportsStreaming: boolean
	readonly supportsRawAccess: boolean
	readonly supportsMagnitudeFilter: boolean
	readonly supportsQualityFilter: boolean
	readonly supportsProjection: boolean
	readonly supportsEpochPropagation: boolean
}

export interface CatalogQueryStats {
	readonly candidateCount: number
	readonly matchedCount: number
	readonly durationMs: number
	readonly geometryMode: StarCatalogGeometryMode
	readonly wrapAround: boolean
	readonly zonesTouched?: number
	readonly recordsScanned?: number
	readonly bytesRead?: number
	readonly usedSpatialIndex?: boolean
	readonly coarsePreselection?: boolean
}

export interface CatalogQueryStatsAccumulator extends CatalogQueryStats {
	candidateCount: number
	matchedCount: number
	durationMs: number
	geometryMode: StarCatalogGeometryMode
	wrapAround: boolean
	zonesTouched?: number
	recordsScanned?: number
	bytesRead?: number
	usedSpatialIndex?: boolean
	coarsePreselection?: boolean
}

export interface CatalogQueryResult {
	readonly items: readonly StarCatalogEntry[]
	readonly totalEstimated?: number
	readonly truncated: boolean
	readonly queryStats: CatalogQueryStats
	readonly sourceMetadata: StarCatalogMetadata
}

export interface StarCatalogProvider<TCatalog extends StarCatalog = StarCatalog> {
	readonly name: string
	readonly open: (source: unknown) => Promise<TCatalog>
}

export interface StarCatalog {
	metadata(): StarCatalogMetadata
	open(source: unknown): Promise<this>
	close(): Promise<void>
	capabilities(): StarCatalogCapabilities
	queryRegion(query: StarCatalogQuery): Promise<CatalogQueryResult>
	queryCone(centerRa: Angle, centerDec: Angle, radius: Angle, options?: StarCatalogQueryBase): Promise<CatalogQueryResult>
	queryBox(minRa: Angle, maxRa: Angle, minDec: Angle, maxDec: Angle, options?: StarCatalogQueryBase): Promise<CatalogQueryResult>
	queryPolygon(verticesRaDec: readonly (readonly [Angle, Angle])[], options?: StarCatalogQueryBase): Promise<CatalogQueryResult>
	getById(catalogObjectId: string, options?: Omit<StarCatalogQueryBase, 'limit' | 'sortMode'>): Promise<StarCatalogEntry | undefined>
	streamRegion(query: StarCatalogQuery): AsyncIterable<StarCatalogEntry>
	estimateCount(query: StarCatalogQuery): Promise<number | undefined>
	supports(featureName: string): boolean
}

export interface StarCatalogRaDecBox {
	readonly minRa: Angle
	readonly maxRa: Angle
	readonly minDec: Angle
	readonly maxDec: Angle
}

interface NormalizedQueryBase {
	readonly magnitudeMin?: number
	readonly magnitudeMax?: number
	readonly limit?: number
	readonly sortMode: StarCatalogSortMode
	readonly requestedFields?: ReadonlySet<StarCatalogFieldName>
	readonly includeRaw: boolean
	readonly epochPropagation?: StarCatalogEpochPropagation
	readonly qualityFilter?: StarCatalogFlagFilter
	readonly requireCompleteFields?: readonly StarCatalogFieldName[]
	readonly geometryMode: StarCatalogGeometryMode
	readonly wrapAround: boolean
	readonly preselectionBoxes: readonly StarCatalogRaDecBox[]
	readonly sortAnchor?: readonly [number, number]
}

interface NormalizedConeQuery extends NormalizedQueryBase {
	readonly kind: 'cone'
	readonly centerRa: Angle
	readonly centerDec: Angle
	readonly radius: Angle
}

interface NormalizedBoxQuery extends NormalizedQueryBase {
	readonly kind: 'box'
	readonly boxes: readonly StarCatalogRaDecBox[]
}

interface NormalizedPolygonQuery extends NormalizedQueryBase {
	readonly kind: 'polygon'
	readonly projectedVertices: readonly (readonly [number, number])[]
	readonly tangentCenterRa: Angle
	readonly tangentCenterDec: Angle
}

export type NormalizedStarCatalogQuery = NormalizedConeQuery | NormalizedBoxQuery | NormalizedPolygonQuery

// Represents a user-caused catalog query failure.
export class StarCatalogQueryError extends Error {
	readonly code = 'STAR_CATALOG_QUERY_ERROR'
	readonly kind = 'user'

	constructor(message: string) {
		super(message)
		this.name = 'StarCatalogQueryError'
	}
}

// Represents malformed or inconsistent catalog data.
export class StarCatalogDataError extends Error {
	readonly code = 'STAR_CATALOG_DATA_ERROR'
	readonly kind = 'catalog'

	constructor(message: string) {
		super(message)
		this.name = 'StarCatalogDataError'
	}
}

// Represents filesystem or storage-level catalog failures.
export class StarCatalogStorageError extends Error {
	readonly code = 'STAR_CATALOG_STORAGE_ERROR'
	readonly kind = 'infrastructure'

	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message)
		this.name = 'StarCatalogStorageError'
	}
}

// Defines a provider without forcing downstream code to know the concrete catalog class.
export function defineStarCatalogProvider<TCatalog extends StarCatalog>(name: string, open: (source: unknown) => Promise<TCatalog>): StarCatalogProvider<TCatalog> {
	return { name, open }
}

// Implements the generic query, filtering, projection, and propagation flow for concrete catalogs.
export abstract class BaseStarCatalog implements StarCatalog {
	abstract metadata(): StarCatalogMetadata
	abstract open(source: unknown): Promise<this>
	abstract close(): Promise<void>
	abstract capabilities(): StarCatalogCapabilities

	// Returns whether a feature is advertised by the provider capabilities.
	supports(featureName: string) {
		return this.capabilities().featureNames.includes(featureName)
	}

	// Runs a normalized query and materializes a finite result set.
	async queryRegion(query: StarCatalogQuery): Promise<CatalogQueryResult> {
		const metadata = this.metadata()
		const normalized = normalizeStarCatalogQuery(query)
		const stats = createStatsAccumulator(normalized)
		const start = performance.now()
		const sortMode = normalized.sortMode
		const items: StarCatalogEntry[] = []
		let truncated = false

		const totalEstimated = await this.estimateCandidateCount(normalized)

		if (sortMode === 'none') {
			for await (const entry of this.streamNormalizedRegion(normalized, stats)) {
				items.push(entry)

				if (normalized.limit !== undefined && items.length >= normalized.limit) {
					truncated = true
					break
				}
			}
		} else {
			for await (const entry of this.streamNormalizedRegion(normalized, stats)) {
				items.push(entry)
			}

			items.sort((left, right) => compareEntries(left, right, sortMode, normalized.sortAnchor))

			if (normalized.limit !== undefined && items.length > normalized.limit) {
				items.length = normalized.limit
				truncated = true
			}
		}

		stats.durationMs = performance.now() - start

		return { items, totalEstimated, truncated, queryStats: { ...stats }, sourceMetadata: metadata }
	}

	// Runs a cone query by adapting it to the region interface.
	queryCone(centerRa: Angle, centerDec: Angle, radius: Angle, options: StarCatalogQueryBase = {}): Promise<CatalogQueryResult> {
		return this.queryRegion({ kind: 'cone', centerRa, centerDec, radius, ...options })
	}

	// Runs an RA/Dec box query by adapting it to the region interface.
	queryBox(minRa: Angle, maxRa: Angle, minDec: Angle, maxDec: Angle, options: StarCatalogQueryBase = {}): Promise<CatalogQueryResult> {
		return this.queryRegion({ kind: 'box', minRa, maxRa, minDec, maxDec, ...options })
	}

	// Runs a polygon query by adapting it to the region interface.
	queryPolygon(verticesRaDec: readonly (readonly [Angle, Angle])[], options: StarCatalogQueryBase = {}): Promise<CatalogQueryResult> {
		return this.queryRegion({ kind: 'polygon', verticesRaDec, ...options })
	}

	// Returns a normalized entry by source identifier when supported by the provider.
	async getById(catalogObjectId: string, options: Omit<StarCatalogQueryBase, 'limit' | 'sortMode'> = {}): Promise<StarCatalogEntry | undefined> {
		const normalizedFields = normalizeRequestedFields(options.requestedFields)
		const entry = await this.getEntryByIdInternal(catalogObjectId, options.includeRaw ?? false)
		if (!entry) return undefined

		const propagated = options.epochPropagation ? propagateEntry(entry, options.epochPropagation) : entry
		if (!propagated) return undefined
		if (!matchesQualityFilter(propagated, options.qualityFilter)) return undefined
		if (!matchesMagnitudeFilter(propagated, options.magnitudeMin, options.magnitudeMax)) return undefined
		if (!matchesRequiredFields(propagated, options.requireCompleteFields)) return undefined
		return projectEntry(propagated, normalizedFields, options.includeRaw ?? false)
	}

	// Streams a region query after exact filtering, optional propagation, and projection.
	async *streamRegion(query: StarCatalogQuery): AsyncIterable<StarCatalogEntry> {
		const normalized = normalizeStarCatalogQuery(query)
		const stats = createStatsAccumulator(normalized)

		for await (const entry of this.streamNormalizedRegion(normalized, stats)) {
			yield entry
		}
	}

	// Estimates the number of candidate records for a region query.
	async estimateCount(query: StarCatalogQuery): Promise<number | undefined> {
		return await this.estimateCandidateCount(normalizeStarCatalogQuery(query))
	}

	// Streams provider candidates and applies generic exact filtering.
	protected async *streamNormalizedRegion(query: NormalizedStarCatalogQuery, stats: CatalogQueryStatsAccumulator): AsyncIterable<StarCatalogEntry> {
		for await (const entry of this.streamCandidateEntries(query, stats)) {
			stats.candidateCount++

			if (!matchesNormalizedGeometry(entry, query)) continue
			if (!matchesMagnitudeFilter(entry, query.magnitudeMin, query.magnitudeMax)) continue
			if (!matchesQualityFilter(entry, query.qualityFilter)) continue
			if (!matchesRequiredFields(entry, query.requireCompleteFields)) continue

			const propagated = query.epochPropagation ? propagateEntry(entry, query.epochPropagation) : entry
			if (!propagated) continue

			stats.matchedCount++
			yield projectEntry(propagated, query.requestedFields, query.includeRaw)
		}
	}

	// Returns provider-specific candidates for a normalized query.
	protected abstract streamCandidateEntries(query: NormalizedStarCatalogQuery, stats: CatalogQueryStatsAccumulator): AsyncIterable<StarCatalogEntry>

	// Returns a provider-specific identifier lookup result.
	protected abstract getEntryByIdInternal(catalogObjectId: string, includeRaw: boolean): Promise<StarCatalogEntry | undefined>

	// Estimates a provider-specific candidate count for a normalized query.
	protected abstract estimateCandidateCount(query: NormalizedStarCatalogQuery): Promise<number | undefined>
}

// Normalizes and validates a public query before it reaches a provider.
export function normalizeStarCatalogQuery(query: StarCatalogQuery): NormalizedStarCatalogQuery {
	validateQueryBase(query)

	switch (query.kind) {
		case 'cone':
			return normalizeConeQuery(query)
		case 'box':
			return normalizeBoxQuery(query)
		case 'polygon':
			return normalizePolygonQuery(query)
		default:
			throw new StarCatalogQueryError(`unsupported query kind: ${(query as { kind?: string }).kind}`)
	}
}

// Normalizes an RA value to the inclusive-exclusive [0, 360) range.
export function normalizeRa(ra: Angle) {
	if (!Number.isFinite(ra)) {
		throw new StarCatalogQueryError(`invalid right ascension: ${ra}`)
	}

	return normalizeAngle(ra)
}

// Validates a declination value in radians.
export function validateDec(dec: Angle) {
	if (!Number.isFinite(dec) || dec < MIN_DEC - GEOMETRY_EPSILON || dec > MAX_DEC + GEOMETRY_EPSILON) {
		throw new StarCatalogQueryError(`invalid declination: ${dec}`)
	}

	return clamp(dec, MIN_DEC, MAX_DEC)
}

// Normalizes an RA span into one or two non-wrapping boxes.
export function splitRaBox(minRa: Angle, maxRa: Angle, minDec: Angle, maxDec: Angle): readonly StarCatalogRaDecBox[] {
	const normalizedMinRa = normalizeRa(minRa)
	const normalizedMaxRa = normalizeRa(maxRa)
	const normalizedMinDec = validateDec(minDec)
	const normalizedMaxDec = validateDec(maxDec)

	if (normalizedMinDec > normalizedMaxDec + GEOMETRY_EPSILON) {
		throw new StarCatalogQueryError(`invalid declination range: [${minDec}, ${maxDec}]`)
	}

	if (Math.abs(maxRa - minRa) >= FULL_CIRCLE - GEOMETRY_EPSILON) {
		return [{ minRa: 0, maxRa: FULL_CIRCLE, minDec: normalizedMinDec, maxDec: normalizedMaxDec }]
	}

	if (normalizedMinRa <= normalizedMaxRa) {
		return [{ minRa: normalizedMinRa, maxRa: normalizedMaxRa, minDec: normalizedMinDec, maxDec: normalizedMaxDec }]
	}

	return [
		{ minRa: 0, maxRa: normalizedMaxRa, minDec: normalizedMinDec, maxDec: normalizedMaxDec },
		{ minRa: normalizedMinRa, maxRa: FULL_CIRCLE, minDec: normalizedMinDec, maxDec: normalizedMaxDec },
	]
}

// Projects a polygon vertex onto a tangent plane centered on the query region.
export function projectPolygonVertex(ra: Angle, dec: Angle, centerRa: Angle, centerDec: Angle): readonly [number, number] {
	const deltaRa = shortestSignedRaDelta(ra, centerRa)
	return [deltaRa * Math.cos(centerDec), dec - centerDec] as const
}

// Propagates a normalized catalog entry to a target epoch when proper motion is available.
export function propagateEntry(entry: StarCatalogEntry, propagation: StarCatalogEpochPropagation): StarCatalogEntry | undefined {
	const targetEpoch = propagation.targetEpoch
	const missingMode = propagation.onMissingProperMotion ?? 'keep'

	if (!Number.isFinite(targetEpoch) || targetEpoch < 0 || targetEpoch > 10000) {
		throw new StarCatalogQueryError(`invalid target epoch: ${targetEpoch}`)
	}

	if (targetEpoch === entry.epoch) return entry

	if (entry.pmRaMasYr === undefined || entry.pmDecMasYr === undefined) {
		if (missingMode === 'keep') return entry
		if (missingMode === 'exclude') return undefined
		throw new StarCatalogQueryError(`entry ${entry.id} does not contain proper motion data required for epoch propagation`)
	}

	const deltaYears = targetEpoch - entry.epoch
	const nextRa = normalizeRa(entry.ra + mas(entry.pmRaMasYr * deltaYears))
	const nextDec = clamp(entry.dec + mas(entry.pmDecMasYr * deltaYears), MIN_DEC, MAX_DEC)
	const extras = entry.extras ? { ...entry.extras, propagatedFromEpoch: entry.epoch } : { propagatedFromEpoch: entry.epoch }

	return { ...entry, ra: nextRa, dec: nextDec, epoch: targetEpoch, extras }
}

// Compares two entries according to the requested sort mode.
export function compareEntries(left: StarCatalogEntry, right: StarCatalogEntry, sortMode: StarCatalogSortMode, anchor?: readonly [number, number]) {
	switch (sortMode) {
		case 'id':
			return left.id.localeCompare(right.id)
		case 'ra':
			return left.ra - right.ra || left.dec - right.dec || left.id.localeCompare(right.id)
		case 'dec':
			return left.dec - right.dec || left.ra - right.ra || left.id.localeCompare(right.id)
		case 'mag':
			return numericSortValue(left.mag) - numericSortValue(right.mag) || left.id.localeCompare(right.id)
		case 'distance':
			return distanceSortValue(left, anchor) - distanceSortValue(right, anchor) || left.id.localeCompare(right.id)
		case 'none':
		default:
			return 0
	}
}

// Creates a zeroed query stats accumulator.
export function createStatsAccumulator(query: NormalizedStarCatalogQuery): CatalogQueryStatsAccumulator {
	return {
		candidateCount: 0,
		matchedCount: 0,
		durationMs: 0,
		geometryMode: query.geometryMode,
		wrapAround: query.wrapAround,
		zonesTouched: 0,
		recordsScanned: 0,
		bytesRead: 0,
		usedSpatialIndex: false,
		coarsePreselection: false,
	}
}

// Validates the common query options shared by all geometry kinds.
function validateQueryBase(query: StarCatalogQuery) {
	if (query.magnitudeMin !== undefined && (!Number.isFinite(query.magnitudeMin) || query.magnitudeMin < -50 || query.magnitudeMin > 50)) {
		throw new StarCatalogQueryError(`invalid minimum magnitude: ${query.magnitudeMin}`)
	}

	if (query.magnitudeMax !== undefined && (!Number.isFinite(query.magnitudeMax) || query.magnitudeMax < -50 || query.magnitudeMax > 50)) {
		throw new StarCatalogQueryError(`invalid maximum magnitude: ${query.magnitudeMax}`)
	}

	if (query.magnitudeMin !== undefined && query.magnitudeMax !== undefined && query.magnitudeMin > query.magnitudeMax) {
		throw new StarCatalogQueryError(`invalid magnitude range: [${query.magnitudeMin}, ${query.magnitudeMax}]`)
	}

	if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_RESULT_LIMIT)) {
		throw new StarCatalogQueryError(`invalid result limit: ${query.limit}. Expected an integer in [1, ${MAX_RESULT_LIMIT}]`)
	}

	if (query.requestedFields !== undefined) {
		for (const field of query.requestedFields) {
			if (!KNOWN_RESULT_FIELDS.has(field)) {
				throw new StarCatalogQueryError(`unsupported requested field: ${field}`)
			}
		}
	}

	if (query.requireCompleteFields !== undefined) {
		for (const field of query.requireCompleteFields) {
			if (!KNOWN_RESULT_FIELDS.has(field)) {
				throw new StarCatalogQueryError(`unsupported required field: ${field}`)
			}
		}
	}

	if (query.epochPropagation) {
		const targetEpoch = query.epochPropagation.targetEpoch

		if (!Number.isFinite(targetEpoch) || targetEpoch < 0 || targetEpoch > 10000) {
			throw new StarCatalogQueryError(`invalid target epoch: ${targetEpoch}`)
		}
	}
}

// Normalizes a cone query and computes its coarse preselection box.
function normalizeConeQuery(query: StarCatalogConeQuery): NormalizedConeQuery {
	const centerRa = normalizeRa(query.centerRa)
	const centerDec = validateDec(query.centerDec)

	if (!Number.isFinite(query.radius) || query.radius < 0 || query.radius > HALF_CIRCLE) {
		throw new StarCatalogQueryError(`invalid cone radius: ${query.radius}. Expected a finite value in [0, pi]`)
	}

	const radius = query.radius
	const minDec = clamp(centerDec - radius, MIN_DEC, MAX_DEC)
	const maxDec = clamp(centerDec + radius, MIN_DEC, MAX_DEC)

	let preselectionBoxes: readonly StarCatalogRaDecBox[]
	let wrapAround = false

	if (radius >= HALF_CIRCLE || maxDec >= MAX_DEC - GEOMETRY_EPSILON || minDec <= MIN_DEC + GEOMETRY_EPSILON) {
		preselectionBoxes = [{ minRa: 0, maxRa: FULL_CIRCLE, minDec, maxDec }]
	} else {
		const sinSpan = Math.sin(radius) / Math.max(GEOMETRY_EPSILON, Math.cos(centerDec))
		const halfSpan = Math.asin(clamp(sinSpan, -1, 1))
		const minRa = centerRa - halfSpan
		const maxRa = centerRa + halfSpan
		preselectionBoxes = splitRaBox(minRa, maxRa, minDec, maxDec)
		wrapAround = preselectionBoxes.length > 1
	}

	return {
		kind: 'cone',
		centerRa,
		centerDec,
		radius,
		magnitudeMin: query.magnitudeMin,
		magnitudeMax: query.magnitudeMax,
		limit: query.limit,
		sortMode: query.sortMode ?? 'none',
		requestedFields: normalizeRequestedFields(query.requestedFields),
		includeRaw: query.includeRaw ?? false,
		epochPropagation: query.epochPropagation,
		qualityFilter: query.qualityFilter,
		requireCompleteFields: query.requireCompleteFields,
		geometryMode: 'spherical',
		wrapAround,
		preselectionBoxes,
		sortAnchor: [centerRa, centerDec],
	}
}

// Normalizes a box query and computes its exact non-wrapping pieces.
function normalizeBoxQuery(query: StarCatalogBoxQuery): NormalizedBoxQuery {
	const boxes = splitRaBox(query.minRa, query.maxRa, query.minDec, query.maxDec)
	const wrapAround = boxes.length > 1
	const centerRa = wrapAround ? normalizeRa((boxes[0].maxRa + boxes[1].minRa) * 0.5) : normalizeRa((boxes[0].minRa + boxes[0].maxRa) * 0.5)
	const centerDec = (boxes[0].minDec + boxes[0].maxDec) * 0.5

	return {
		kind: 'box',
		boxes,
		magnitudeMin: query.magnitudeMin,
		magnitudeMax: query.magnitudeMax,
		limit: query.limit,
		sortMode: query.sortMode ?? 'none',
		requestedFields: normalizeRequestedFields(query.requestedFields),
		includeRaw: query.includeRaw ?? false,
		epochPropagation: query.epochPropagation,
		qualityFilter: query.qualityFilter,
		requireCompleteFields: query.requireCompleteFields,
		geometryMode: 'spherical',
		wrapAround,
		preselectionBoxes: boxes,
		sortAnchor: [centerRa, centerDec],
	}
}

// Normalizes a polygon query and builds its tangent-plane projection.
function normalizePolygonQuery(query: StarCatalogPolygonQuery): NormalizedPolygonQuery {
	if (query.verticesRaDec.length < 3) {
		throw new StarCatalogQueryError('polygon queries require at least three vertices')
	}

	const normalizedVertices: (readonly [number, number])[] = []

	for (const vertex of query.verticesRaDec) {
		if (!Array.isArray(vertex) || vertex.length !== 2) {
			throw new StarCatalogQueryError('polygon vertices must be [ra, dec] pairs')
		}

		normalizedVertices.push([normalizeRa(vertex[0]), validateDec(vertex[1])] as const)
	}

	const tangentCenterRa = meanRa(normalizedVertices)
	const tangentCenterDec = normalizedVertices.reduce((sum, [, dec]) => sum + dec, 0) / normalizedVertices.length
	const projectedVertices = normalizedVertices.map(([ra, dec]) => projectPolygonVertex(ra, dec, tangentCenterRa, tangentCenterDec))
	const [minProjectedX, maxProjectedX, minDec, maxDec] = polygonBounds(projectedVertices, tangentCenterDec)
	const preselectionBoxes = projectedPolygonToBoxes(minProjectedX, maxProjectedX, minDec, maxDec, tangentCenterRa, tangentCenterDec)
	const wrapAround = preselectionBoxes.length > 1

	if (maxProjectedX - minProjectedX > TANGENT_POLYGON_RECOMMENDED_SPAN) {
		// Large polygons are still allowed, but the tangent-plane exact test is documented as best for smaller fields.
	}

	return {
		kind: 'polygon',
		projectedVertices,
		tangentCenterRa,
		tangentCenterDec,
		magnitudeMin: query.magnitudeMin,
		magnitudeMax: query.magnitudeMax,
		limit: query.limit,
		sortMode: query.sortMode ?? 'none',
		requestedFields: normalizeRequestedFields(query.requestedFields),
		includeRaw: query.includeRaw ?? false,
		epochPropagation: query.epochPropagation,
		qualityFilter: query.qualityFilter,
		requireCompleteFields: query.requireCompleteFields,
		geometryMode: 'planar-tangent',
		wrapAround,
		preselectionBoxes,
		sortAnchor: [tangentCenterRa, tangentCenterDec],
	}
}

// Checks the exact query geometry after provider-side coarse preselection.
function matchesNormalizedGeometry(entry: StarCatalogEntry, query: NormalizedStarCatalogQuery) {
	switch (query.kind) {
		case 'cone':
			return sphericalSeparation(query.centerRa, query.centerDec, entry.ra, entry.dec) <= query.radius + GEOMETRY_EPSILON
		case 'box':
			return query.boxes.some((box) => matchesBox(entry.ra, entry.dec, box))
		case 'polygon':
			return pointInProjectedPolygon(projectPolygonVertex(entry.ra, entry.dec, query.tangentCenterRa, query.tangentCenterDec), query.projectedVertices)
		default:
			return false
	}
}

// Checks whether a normalized entry falls inside a non-wrapping box.
function matchesBox(ra: Angle, dec: Angle, box: StarCatalogRaDecBox) {
	return ra + GEOMETRY_EPSILON >= box.minRa && ra <= box.maxRa + GEOMETRY_EPSILON && dec + GEOMETRY_EPSILON >= box.minDec && dec <= box.maxDec + GEOMETRY_EPSILON
}

// Checks whether a normalized entry satisfies magnitude constraints.
function matchesMagnitudeFilter(entry: StarCatalogEntry, magnitudeMin?: number, magnitudeMax?: number) {
	if (magnitudeMin === undefined && magnitudeMax === undefined) return true
	if (entry.mag === undefined) return false
	if (magnitudeMin !== undefined && entry.mag < magnitudeMin - GEOMETRY_EPSILON) return false
	if (magnitudeMax !== undefined && entry.mag > magnitudeMax + GEOMETRY_EPSILON) return false
	return true
}

// Checks whether a normalized entry satisfies requested completeness constraints.
function matchesRequiredFields(entry: StarCatalogEntry, requiredFields?: readonly StarCatalogFieldName[]) {
	if (!requiredFields?.length) return true

	for (const field of requiredFields) {
		if ((entry as unknown as Record<string, unknown>)[field] === undefined) return false
	}

	return true
}

// Checks whether a normalized entry satisfies quality-flag filters.
function matchesQualityFilter(entry: StarCatalogEntry, qualityFilter?: StarCatalogFlagFilter) {
	if (!qualityFilter) return true

	if (typeof entry.flags === 'number') {
		if (qualityFilter.bitmaskAll !== undefined && (entry.flags & qualityFilter.bitmaskAll) !== qualityFilter.bitmaskAll) return false
		if (qualityFilter.bitmaskAny !== undefined && (entry.flags & qualityFilter.bitmaskAny) === 0) return false
	}

	if (entry.flags && typeof entry.flags === 'object') {
		if (qualityFilter.required) {
			for (const key of Object.keys(qualityFilter.required)) {
				if (!matchesFlagValue(entry.flags[key], qualityFilter.required[key]!)) return false
			}
		}

		if (qualityFilter.excluded) {
			for (const key of Object.keys(qualityFilter.excluded)) {
				if (matchesFlagValue(entry.flags[key], qualityFilter.excluded[key]!)) return false
			}
		}
	}

	return true
}

// Checks whether a flag value matches a scalar or any-of condition.
function matchesFlagValue(value: unknown, condition: string | number | boolean | readonly (string | number | boolean)[]) {
	if (Array.isArray(condition)) return condition.includes(value as never)
	return value === condition
}

// Projects a normalized entry onto the requested public fields.
function projectEntry(entry: StarCatalogEntry, requestedFields?: ReadonlySet<StarCatalogFieldName>, includeRaw: boolean = false): StarCatalogEntry {
	if (!requestedFields && includeRaw) return entry
	if (!requestedFields && !includeRaw && entry.raw === undefined) return entry

	const output: Record<string, unknown> = {
		id: entry.id,
		ra: entry.ra,
		dec: entry.dec,
		epoch: entry.epoch,
		sourceCatalog: entry.sourceCatalog,
	}

	const includeField = (field: StarCatalogFieldName) => requestedFields?.has(field) ?? true

	if (includeField('pmRaMasYr') && entry.pmRaMasYr !== undefined) output.pmRaMasYr = entry.pmRaMasYr
	if (includeField('pmDecMasYr') && entry.pmDecMasYr !== undefined) output.pmDecMasYr = entry.pmDecMasYr
	if (includeField('mag') && entry.mag !== undefined) output.mag = entry.mag
	if (includeField('magBand') && entry.magBand !== undefined) output.magBand = entry.magBand
	if (includeField('magBands') && entry.magBands !== undefined) output.magBands = entry.magBands
	if (includeField('positionErrorMas') && entry.positionErrorMas !== undefined) output.positionErrorMas = entry.positionErrorMas
	if (includeField('properMotionError') && entry.properMotionError !== undefined) output.properMotionError = entry.properMotionError
	if (includeField('flags') && entry.flags !== undefined) output.flags = entry.flags
	if (includeField('extras') && entry.extras !== undefined) output.extras = entry.extras
	if (includeRaw && includeField('raw') && entry.raw !== undefined) output.raw = entry.raw

	return output as unknown as StarCatalogEntry
}

// Normalizes requested field names into a fast membership set.
function normalizeRequestedFields(fields?: readonly StarCatalogFieldName[]) {
	if (!fields?.length) return undefined

	const normalized = new Set<StarCatalogFieldName>()

	for (const field of fields) {
		normalized.add(field)
	}

	for (const field of CORE_RESULT_FIELDS) {
		normalized.add(field)
	}

	return normalized
}

// Computes a representative RA from a set of wrapped longitudes.
function meanRa(vertices: readonly (readonly [Angle, Angle])[]) {
	let sinSum = 0
	let cosSum = 0

	for (const [ra] of vertices) {
		sinSum += Math.sin(ra)
		cosSum += Math.cos(ra)
	}

	return normalizeRa(Math.atan2(sinSum, cosSum))
}

// Computes the tangent-plane bounds of a projected polygon.
function polygonBounds(projectedVertices: readonly (readonly [number, number])[], tangentCenterDec: Angle): readonly [number, number, Angle, Angle] {
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
function projectedPolygonToBoxes(minProjectedX: number, maxProjectedX: number, minDec: Angle, maxDec: Angle, tangentCenterRa: Angle, tangentCenterDec: Angle): readonly StarCatalogRaDecBox[] {
	const cosCenter = Math.max(Math.cos(tangentCenterDec), GEOMETRY_EPSILON)
	const minRa = tangentCenterRa + minProjectedX / cosCenter
	const maxRa = tangentCenterRa + maxProjectedX / cosCenter
	return splitRaBox(minRa, maxRa, minDec, maxDec)
}

// Checks whether a tangent-plane point falls inside a polygon using ray casting.
function pointInProjectedPolygon(point: readonly [number, number], polygon: readonly (readonly [number, number])[]) {
	let inside = false
	let j = polygon.length - 1

	for (let i = 0; i < polygon.length; i++) {
		const xi = polygon[i][0]
		const yi = polygon[i][1]
		const xj = polygon[j][0]
		const yj = polygon[j][1]
		const crosses = yi > point[1] !== yj > point[1]
		const xIntersection = ((xj - xi) * (point[1] - yi)) / (yj - yi || Number.MIN_VALUE) + xi

		if (crosses && point[0] <= xIntersection + GEOMETRY_EPSILON) {
			inside = !inside
		}

		j = i
	}

	return inside
}

// Computes a wrapped signed RA delta relative to a reference longitude.
function shortestSignedRaDelta(ra: Angle, referenceRa: Angle) {
	let delta = normalizeRa(ra) - normalizeRa(referenceRa)
	if (delta > HALF_CIRCLE) delta -= FULL_CIRCLE
	else if (delta <= -HALF_CIRCLE) delta += FULL_CIRCLE
	return delta
}

// Converts undefined magnitudes to a stable sort tail value.
function numericSortValue(value?: number) {
	return value === undefined ? Number.POSITIVE_INFINITY : value
}

// Computes the sort distance relative to the query anchor.
function distanceSortValue(entry: StarCatalogEntry, anchor?: readonly [number, number]) {
	if (!anchor) return Number.POSITIVE_INFINITY
	return sphericalSeparation(anchor[0], anchor[1], entry.ra, entry.dec)
}
