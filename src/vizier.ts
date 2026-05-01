import { type Angle, deg, mas, toDeg } from './angle'
import { type CsvRow, type ReadCsvOptions, readCsv, TSV_DELIMITER } from './csv'
import { BaseStarCatalog, type NormalizedStarCatalogQuery, type StarCatalogEntry, type StarCatalogRaDecBox } from './star.catalog'
import { kilometerPerSecond } from './velocity'

export const VIZIER_URL = 'http://tapvizier.cds.unistra.fr/'

const VIZIER_QUERY_PATH = 'TAPVizieR/tap/sync'
const VIZIER_GAIA_DR3_TABLE = '"I/355/gaiadr3"'
const VIZIER_GAIA_DR3_COLUMNS = 'Source, RAJ2000, DEJ2000, Gmag, pmRA, pmDE, RV'
const VIZIER_GAIA_DR3_EPOCH = 2000
const VIZIER_GAIA_DR3_PM_COS_DEC_EPSILON = 1e-12
const VIZIER_GAIA_SOURCE_ID_REGEX = /^\d+$/

export interface VizierQueryOptions extends ReadCsvOptions, Omit<RequestInit, 'method' | 'body'> {
	baseUrl?: string
	timeout?: number
}

const DEFAULT_VIZIER_QUERY_OPTIONS: VizierQueryOptions = {
	baseUrl: VIZIER_URL,
	timeout: 60000,
}

// Executes a VizieR query.
export async function vizierQuery(query: string, { baseUrl, timeout = 60000, signal, ...options }: Readonly<VizierQueryOptions> = DEFAULT_VIZIER_QUERY_OPTIONS) {
	const uri = `${baseUrl || VIZIER_URL}${VIZIER_QUERY_PATH}`
	signal ??= timeout ? AbortSignal.timeout(timeout) : undefined

	const body = new FormData()
	body.append('request', 'doQuery')
	body.append('lang', 'adql')
	body.append('format', 'tsv')
	body.append('query', query)

	const response = await fetch(uri, { ...options, method: 'POST', body, signal })
	if (response.status >= 300) return undefined
	const text = await response.text()
	return readCsv(text, { ...options, delimiter: TSV_DELIMITER })
}

export interface VizierGaiaCatalogEntry extends Omit<StarCatalogEntry, 'epoch' | 'magnitude'> {
	readonly id: string
	readonly epoch: 2000
	readonly magnitude: number
}

export class VizierGaiaCatalog extends BaseStarCatalog<VizierGaiaCatalogEntry> {
	readonly options: VizierQueryOptions

	constructor(options?: VizierQueryOptions) {
		super()

		this.options = { ...options, skipFirstLine: true, forceTrim: true }
	}

	// Retrieves a Gaia DR3 source by source identifier.
	async get(id: number | string | bigint): Promise<VizierGaiaCatalogEntry | undefined> {
		const rows = await this.#query(`Source = ${formatVizierGaiaSourceId(id)}`, 1)
		return rows?.length ? parseVizierGaiaCatalogRow(rows[0]) : undefined
	}

	// Streams Gaia DR3 candidates intersecting the normalized coarse boxes.
	protected async *streamCandidateEntries(query: NormalizedStarCatalogQuery): AsyncIterable<VizierGaiaCatalogEntry> {
		const rows = await this.#query(buildVizierGaiaWhere(query))
		if (!rows?.length) return

		for (const row of rows) {
			const entry = parseVizierGaiaCatalogRow(row)
			if (entry) yield entry
		}
	}

	// Executes one Gaia DR3 TSV query with only the columns needed by the catalog API.
	async #query(where: string, limit?: number) {
		const top = limit && limit > 0 ? `TOP ${Math.trunc(limit)} ` : ''
		const query = `SELECT ${top}${VIZIER_GAIA_DR3_COLUMNS} FROM ${VIZIER_GAIA_DR3_TABLE} WHERE ${where} ORDER BY GMag ASC`
		return await vizierQuery(query, this.options)
	}
}

// Parses a raw Gaia DR3 TSV row into the generic catalog shape.
function parseVizierGaiaCatalogRow(row: Readonly<CsvRow>): VizierGaiaCatalogEntry | undefined {
	const [id, raJ2000, decJ2000, gMagnitude, pmRaCosDecMasYr, pmDecMasYr, radialVelocityKmS] = row
	if (!id) return undefined

	const rawRightAscension = parseVizierGaiaNumber(raJ2000)
	const rawDeclination = parseVizierGaiaNumber(decJ2000)
	const magnitude = parseVizierGaiaNumber(gMagnitude)

	if (rawRightAscension === undefined || rawDeclination === undefined || magnitude === undefined) {
		return undefined
	}

	const rightAscension = deg(rawRightAscension)
	const declination = deg(rawDeclination)

	if (!Number.isFinite(rightAscension) || !Number.isFinite(declination)) {
		return undefined
	}

	const rawPmRA = parseVizierGaiaNumber(pmRaCosDecMasYr)
	let pmRA: Angle | undefined

	if (rawPmRA !== undefined) {
		const cosDec = Math.cos(declination)
		if (Math.abs(cosDec) > VIZIER_GAIA_DR3_PM_COS_DEC_EPSILON) pmRA = mas(rawPmRA / cosDec)
	}

	const rawPmDEC = parseVizierGaiaNumber(pmDecMasYr)
	const rawRV = parseVizierGaiaNumber(radialVelocityKmS)

	return {
		id,
		epoch: VIZIER_GAIA_DR3_EPOCH,
		rightAscension,
		declination,
		magnitude,
		pmRA,
		pmDEC: rawPmDEC !== undefined ? mas(rawPmDEC) : undefined,
		rv: rawRV !== undefined ? kilometerPerSecond(rawRV) : undefined,
	}
}

// Builds the ADQL predicate for a normalized query.
function buildVizierGaiaWhere(query: NormalizedStarCatalogQuery) {
	const constraints = [buildVizierGaiaGeometryConstraint(query.preselectionBoxes)]
	const magnitudeConstraint = buildVizierGaiaMagnitudeConstraint(query)

	if (magnitudeConstraint) {
		constraints.push(magnitudeConstraint)
	}

	return constraints.join(' AND ')
}

// Builds the ADQL predicate for one or more coarse RA/Dec boxes.
function buildVizierGaiaGeometryConstraint(boxes: readonly StarCatalogRaDecBox[]) {
	const predicates = new Array<string>(boxes.length)

	for (let i = 0; i < boxes.length; i++) {
		predicates[i] = buildVizierGaiaBoxConstraint(boxes[i])
	}

	return predicates.length === 1 ? predicates[0] : `(${predicates.join(' OR ')})`
}

// Converts one coarse preselection box into an ADQL predicate.
function buildVizierGaiaBoxConstraint(box: StarCatalogRaDecBox) {
	return `(RAJ2000 >= ${toDeg(box.minRA)} AND RAJ2000 <= ${toDeg(box.maxRA)} AND DEJ2000 >= ${toDeg(box.minDEC)} AND DEJ2000 <= ${toDeg(box.maxDEC)})`
}

// Pushes optional magnitude limits down to the remote query.
function buildVizierGaiaMagnitudeConstraint(query: NormalizedStarCatalogQuery) {
	const constraints = ['Gmag IS NOT NULL']

	if (query.magnitudeMin !== undefined) {
		constraints.push(`Gmag >= ${query.magnitudeMin}`)
	}

	if (query.magnitudeMax !== undefined) {
		constraints.push(`Gmag <= ${query.magnitudeMax}`)
	}

	return constraints.join(' AND ')
}

// Parses an optional Gaia numeric column.
function parseVizierGaiaNumber(value?: string) {
	const text = value?.trim()
	if (!text) return undefined
	const num = +text
	return Number.isFinite(num) ? num : undefined
}

// Formats a Gaia source id as an ADQL integer literal.
function formatVizierGaiaSourceId(id: number | string | bigint) {
	if (typeof id === 'bigint') {
		if (id >= 0n) return id.toString()
	} else if (typeof id === 'number') {
		if (Number.isSafeInteger(id) && id >= 0) return `${id}`
	} else {
		const text = id.trim()
		if (VIZIER_GAIA_SOURCE_ID_REGEX.test(text)) return text
	}

	throw new Error(`invalid VizieR Gaia source id: ${id}`)
}
