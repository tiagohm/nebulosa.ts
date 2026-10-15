import { CSV_DELIMITER, type CsvRow, type ReadCsvOptions, readCsv } from '../../io/csv'
import type { ExoplanetArchiveRow } from './exoplanet.archive'

// NASA Exoplanet Archive TAP client: runs synchronous ADQL queries against the archive's `/TAP/sync`
// endpoint in CSV format and maps the Planetary Systems (`ps`) and Composite Parameters (`pscomppars`)
// transit-ephemeris columns into ExoplanetArchiveRow records. Every value is kept as the decimal or text
// string the archive sent (empty fields become null), so `pl_tranmid` reaches
// exoplanetArchiveTransitEphemeris with all of its digits; no unit conversion, time-scale default, or
// solution merging happens here. Each call performs one network request and holds the whole bounded
// response in memory.

// https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html
// https://exoplanetarchive.ipac.caltech.edu/docs/API_PS_columns.html

// NASA Exoplanet Archive host.
export const EXOPLANET_ARCHIVE_URL = 'https://exoplanetarchive.ipac.caltech.edu/'

// Path of the synchronous TAP query endpoint, relative to the host.
const EXOPLANET_ARCHIVE_TAP_SYNC_PATH = 'TAP/sync'

// Default request timeout, in milliseconds.
const DEFAULT_TIMEOUT = 60000

// Default cap on the downloaded response body, in bytes (16 MiB, tens of thousands of rows).
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

// CSV dialect of the archive: comma-separated, double-quoted strings, header row first, no comment
// lines (a field starting with '#' is data), quoted text kept untrimmed, and malformed quoting rejected
// (strict) so a truncated or corrupt body is never taken as data.
const EXOPLANET_ARCHIVE_CSV_OPTIONS: ReadCsvOptions = { delimiter: CSV_DELIMITER, quote: '"', comment: [], skipFirstLine: false, forceTrim: false, strict: true }

// Transit-ephemeris columns selected from both tables, in projection order.
const COMMON_COLUMNS = ['pl_name', 'ra', 'dec', 'pl_tranmid', 'pl_tranmiderr1', 'pl_tranmiderr2', 'pl_orbper', 'pl_orbpererr1', 'pl_orbpererr2', 'pl_trandur', 'pl_trandurerr1', 'pl_trandurerr2'] as const

// Columns selected from `ps`: the common ones plus its table-specific time reference.
const PS_COLUMNS = [...COMMON_COLUMNS, 'pl_tsystemref'] as const

// Columns selected from `pscomppars`: the common ones plus its table-specific time reference.
const PSCOMPPARS_COLUMNS = [...COMMON_COLUMNS, 'pl_tranmid_systemref'] as const

// Archive tables holding transit ephemerides: `ps` has one self-contained row per published solution,
// `pscomppars` one composite row per planet whose values may come from different publications.
export type ExoplanetArchiveTable = 'ps' | 'pscomppars'

// Options of an archive TAP request.
export interface ExoplanetArchiveTapOptions {
	// Host base URL ending with '/', for example a mirror or a local mock server. Defaults to EXOPLANET_ARCHIVE_URL.
	readonly baseUrl?: string
	// Request timeout covering the response headers and body, in milliseconds. Defaults to 60000; 0 disables it.
	readonly timeout?: number
	// Caller cancellation; it stays active together with the timeout.
	readonly signal?: AbortSignal
	// Maximum response body size, in bytes. Defaults to 16 MiB; a larger body fails with kind 'size'.
	readonly maxResponseBytes?: number
	// Extra request headers.
	readonly headers?: HeadersInit
}

// One CSV record keyed by its header name. An empty field, quoted or not, is null; other values are the
// raw text, never parsed as numbers.
export type ExoplanetArchiveTapRecord = Readonly<Record<string, string | null>>

// Parsed CSV answer of a TAP query.
export interface ExoplanetArchiveTapResult {
	// Column names from the header row, in response order.
	readonly columns: readonly string[]
	// Records in response order; empty when the query matched nothing.
	readonly records: readonly ExoplanetArchiveTapRecord[]
}

// What failed in an archive request: 'network' (the request could not be sent or the body could not be
// read), 'http' (a non-2xx status), 'service' (a VOTable or plain-text TAP error, such as an ADQL
// error, with a successful status), 'format' (an empty, non-CSV, or malformed body, including malformed
// quoting, or a header that does not match the requested columns), or
// 'size' (the body exceeded maxResponseBytes).
export type ExoplanetArchiveTapErrorKind = 'network' | 'http' | 'service' | 'format' | 'size'

// Failure of an archive TAP request. Cancellation and timeout are not wrapped: they reject with the
// signal's reason (the caller's reason, or a DOMException named 'TimeoutError').
export class ExoplanetArchiveTapError extends Error {
	// Failure category.
	readonly kind: ExoplanetArchiveTapErrorKind
	// HTTP status of the response, when one was received.
	readonly status?: number

	constructor(kind: ExoplanetArchiveTapErrorKind, message: string, status?: number, cause?: unknown) {
		super(`NASA Exoplanet Archive TAP query failed: ${message}`, cause === undefined ? undefined : { cause })
		this.name = 'ExoplanetArchiveTapError'
		this.kind = kind
		this.status = status
	}
}

// Runs one synchronous ADQL query against the archive TAP endpoint with `format=csv` and returns the
// header-keyed records. Parameters: adql is trusted caller input sent verbatim (only URL-encoded), so it
// must quote its own literals; options select the host, timeout, cancellation, size cap, and headers.
// Returns the columns and records of a completed query, with no records for an empty result. Throws an
// ExoplanetArchiveTapError for a network, HTTP, TAP-service, CSV-format, or size failure, and rejects
// with the signal's reason on cancellation or timeout; a failure is never reported as an empty result.
export async function exoplanetArchiveTapQuery(adql: string, options: ExoplanetArchiveTapOptions = {}): Promise<ExoplanetArchiveTapResult> {
	const text = await fetchCsv(adql, options)
	return parseCsv(text)
}

// Fields shared by both table queries.
interface ExoplanetArchiveRowsQueryBase {
	// Exact planet name (`pl_name`), for example 'WASP-12 b'.
	readonly planetName?: string
	// Exact host star name (`hostname`), for example 'TRAPPIST-1'.
	readonly hostName?: string
	// Maximum number of rows returned, a positive integer. The query asks for one more row to detect truncation.
	readonly limit: number
}

// Query of the `ps` table.
export interface ExoplanetArchivePsQuery extends ExoplanetArchiveRowsQueryBase {
	readonly table: 'ps'
	// 'default' keeps only the archive's default solution of each planet (`default_flag = 1`); 'all'
	// returns every published solution as a separate row.
	readonly solution: 'default' | 'all'
}

// Query of the `pscomppars` table, which has one composite row per planet and no solution choice.
export interface ExoplanetArchiveCompositeQuery extends ExoplanetArchiveRowsQueryBase {
	readonly table: 'pscomppars'
}

// Query of exoplanetArchiveRows.
export type ExoplanetArchiveRowsQuery = ExoplanetArchivePsQuery | ExoplanetArchiveCompositeQuery

// Result of exoplanetArchiveRows.
export interface ExoplanetArchiveRowsResult {
	// Rows in query order (planet name, then publication for `ps`), at most `limit` of them.
	readonly rows: readonly ExoplanetArchiveRow[]
	// More rows than `limit` matched, so `rows` is not the complete selection.
	readonly truncated: boolean
}

// Fetches transit-ephemeris rows from `ps` or `pscomppars`. Parameters: query names the table, the
// optional exact planet and host names (ANDed; string literals are escaped), the `ps` solution
// selection, and the row limit; options are those of exoplanetArchiveTapQuery. The request selects
// only the transit-ephemeris columns: `pl_tsystemref` for `ps` and `pl_tranmid_systemref` for
// `pscomppars`. Returns every fetched row, including rows whose ephemeris fields are empty, with values
// as raw strings or null, so exoplanetArchiveTransitEphemeris decides which rows are usable and why the
// others are rejected. Solutions are never merged or chosen; `truncated` reports a selection larger
// than `limit`. Throws as exoplanetArchiveTapQuery, and with kind 'format' when the response header is
// not exactly the requested columns.
export async function exoplanetArchiveRows(query: ExoplanetArchiveRowsQuery, options: ExoplanetArchiveTapOptions = {}): Promise<ExoplanetArchiveRowsResult> {
	const columns = query.table === 'ps' ? PS_COLUMNS : PSCOMPPARS_COLUMNS
	const { columns: header, records } = await exoplanetArchiveTapQuery(rowsAdql(query, columns), options)

	if (header.length !== columns.length || !columns.every((column) => header.includes(column))) {
		throw new ExoplanetArchiveTapError('format', `expected columns ${columns.join(',')} from ${query.table}, received ${header.join(',')}`)
	}

	const truncated = records.length > query.limit
	const count = truncated ? query.limit : records.length
	const rows = new Array<ExoplanetArchiveRow>(count)

	for (let i = 0; i < count; i++) {
		const record = records[i]
		const row: ExoplanetArchiveRow = {
			pl_name: record.pl_name,
			ra: record.ra,
			dec: record.dec,
			pl_tranmid: record.pl_tranmid,
			pl_tranmiderr1: record.pl_tranmiderr1,
			pl_tranmiderr2: record.pl_tranmiderr2,
			pl_orbper: record.pl_orbper,
			pl_orbpererr1: record.pl_orbpererr1,
			pl_orbpererr2: record.pl_orbpererr2,
			pl_trandur: record.pl_trandur,
			pl_trandurerr1: record.pl_trandurerr1,
			pl_trandurerr2: record.pl_trandurerr2,
		}

		rows[i] = query.table === 'ps' ? { ...row, pl_tsystemref: record.pl_tsystemref } : { ...row, pl_tranmid_systemref: record.pl_tranmid_systemref }
	}

	return { rows, truncated }
}

// Builds the fixed-projection ADQL of a table query, asking for limit + 1 rows in a deterministic order.
function rowsAdql(query: ExoplanetArchiveRowsQuery, columns: readonly string[]) {
	const predicates: string[] = []
	if (query.planetName !== undefined) predicates.push(`pl_name = ${adqlString(query.planetName)}`)
	if (query.hostName !== undefined) predicates.push(`hostname = ${adqlString(query.hostName)}`)
	if (query.table === 'ps' && query.solution === 'default') predicates.push('default_flag = 1')
	const where = predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : ''
	// pl_refname orders the solutions of one planet in `ps`; `pscomppars` has one row per planet.
	const order = query.table === 'ps' ? 'pl_name, pl_refname' : 'pl_name'
	return `SELECT TOP ${query.limit + 1} ${columns.join(',')} FROM ${query.table}${where} ORDER BY ${order}`
}

// Quotes text as an ADQL string literal, doubling embedded apostrophes.
function adqlString(value: string) {
	return `'${value.replaceAll("'", "''")}'`
}

// Sends the query and returns the response body text, enforcing the timeout and size cap.
async function fetchCsv(adql: string, { baseUrl, timeout = DEFAULT_TIMEOUT, signal, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, headers }: ExoplanetArchiveTapOptions) {
	signal?.throwIfAborted()

	const url = `${baseUrl || EXOPLANET_ARCHIVE_URL}${EXOPLANET_ARCHIVE_TAP_SYNC_PATH}?${new URLSearchParams({ query: adql, format: 'csv' })}`
	const timeoutController = new AbortController()
	const timer = timeout > 0 ? setTimeout(() => timeoutController.abort(new DOMException(`NASA Exoplanet Archive TAP query timed out after ${timeout} ms`, 'TimeoutError')), timeout) : undefined
	const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal

	try {
		let response: Response

		try {
			response = await fetch(url, { method: 'GET', headers, signal: requestSignal })
		} catch (cause) {
			if (requestSignal.aborted) throw requestSignal.reason
			throw new ExoplanetArchiveTapError('network', `request to ${url} failed`, undefined, cause)
		}

		let text: string

		try {
			text = await readBody(response, maxResponseBytes)
		} catch (cause) {
			if (requestSignal.aborted) throw requestSignal.reason
			if (cause instanceof ExoplanetArchiveTapError) throw cause
			throw new ExoplanetArchiveTapError('network', `reading the response failed with HTTP ${response.status}`, response.status, cause)
		}

		if (!response.ok) {
			const message = tapErrorMessage(text)
			throw new ExoplanetArchiveTapError('http', `HTTP ${response.status}${message ? `: ${message}` : ''}`, response.status)
		}

		// The service answers CSV queries with text; a markup body is a TAP error document or an HTML page.
		if (text.trimStart().startsWith('<')) {
			const message = tapErrorMessage(text)
			if (message) throw new ExoplanetArchiveTapError('service', message, response.status)
			throw new ExoplanetArchiveTapError('format', 'received markup instead of CSV', response.status)
		}

		// A plain-text error would otherwise parse as a one-column header with no records.
		if (PLAIN_TEXT_ERROR_PATTERN.test(text)) throw new ExoplanetArchiveTapError('service', tapErrorMessage(text) ?? 'unknown TAP error', response.status)

		return text
	} finally {
		clearTimeout(timer)
	}
}

// Reads the body as UTF-8 without buffering more than maxBytes bytes.
async function readBody(response: Response, maxBytes: number) {
	const length = Number(response.headers.get('content-length'))
	if (length > maxBytes) {
		await response.body?.cancel()
		throw new ExoplanetArchiveTapError('size', `response of ${length} bytes exceeds ${maxBytes} bytes`, response.status)
	}

	if (!response.body) return ''

	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let text = ''
	let bytes = 0

	while (true) {
		const { done, value } = await reader.read()
		if (done) break

		bytes += value.byteLength

		if (bytes > maxBytes) {
			await reader.cancel()
			throw new ExoplanetArchiveTapError('size', `response exceeds ${maxBytes} bytes`, response.status)
		}

		text += decoder.decode(value, { stream: true })
	}

	return text + decoder.decode()
}

// TAP error status of a VOTable error document: an INFO element with name QUERY_STATUS and value ERROR,
// in either attribute order and with single or double quotes.
const QUERY_STATUS_ERROR_PATTERN = /<INFO\b(?=[^>]*\bname\s*=\s*(["'])QUERY_STATUS\1)(?=[^>]*\bvalue\s*=\s*(["'])ERROR\2)[^>]*>([\s\S]*?)<\/INFO>/i

// First line of a plain-text TAP or database error ('ERROR: …', 'ORA-00904: …', 'QUERY_STATUS=ERROR').
// A CSV header cannot start this way: archive column names are ADQL regular identifiers, without ':' or '-'.
const PLAIN_TEXT_ERROR_PATTERN = /^\s*(?:ERROR\s*:|ORA-\d{5}\s*:|QUERY_STATUS\s*[=:]\s*ERROR\b)/i

// Extracts the message of a TAP error document, or a short plain-text body; undefined for markup without one.
function tapErrorMessage(text: string) {
	const match = QUERY_STATUS_ERROR_PATTERN.exec(text)
	if (match) return match[3].trim() || 'unknown TAP error'
	const trimmed = text.trim()
	if (trimmed === '' || trimmed.startsWith('<')) return undefined
	return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

// Parses the CSV body into header-keyed records, rejecting malformed quoting (an unterminated quoted
// field or text after a closing quote), a missing header, duplicate or empty column names, and records
// whose width differs from the header.
function parseCsv(text: string): ExoplanetArchiveTapResult {
	let rows: CsvRow[]

	try {
		rows = readCsv(text, EXOPLANET_ARCHIVE_CSV_OPTIONS)
	} catch (cause) {
		throw new ExoplanetArchiveTapError('format', `malformed CSV: ${cause instanceof Error ? cause.message : String(cause)}`, undefined, cause)
	}

	if (rows.length === 0) throw new ExoplanetArchiveTapError('format', 'empty response without a CSV header')

	const header = rows[0]

	const columns = new Set<string>()

	for (const column of header) {
		if (column === '' || columns.has(column)) throw new ExoplanetArchiveTapError('format', `invalid or duplicated column name '${column}' in the CSV header`)
		columns.add(column)
	}

	const records = new Array<ExoplanetArchiveTapRecord>(rows.length - 1)

	for (let i = 1; i < rows.length; i++) {
		records[i - 1] = csvRecord(header, rows[i], i)
	}

	return { columns: header, records }
}

// Keys one CSV row by the header, mapping empty fields to null. index is the 1-based data record number.
function csvRecord(header: readonly string[], row: Readonly<CsvRow>, index: number): ExoplanetArchiveTapRecord {
	if (row.length !== header.length) throw new ExoplanetArchiveTapError('format', `CSV record ${index} has ${row.length} fields, expected ${header.length}`)
	// Object.fromEntries defines own properties, so a column named like an Object.prototype member stays data.
	return Object.fromEntries(header.map((column, i) => [column, row[i] === '' ? null : row[i]]))
}
