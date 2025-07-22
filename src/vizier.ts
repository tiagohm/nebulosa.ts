import { readCsv, TSV_DELIMITER } from './csv'

export const VIZIER_URL = 'http://tapvizier.cds.unistra.fr/'

const VIZIER_QUERY_PATH = 'TAPVizieR/tap/sync'

export interface VizierQueryOptions extends Omit<RequestInit, 'method' | 'body'> {
	baseUrl?: string
	timeout?: number
}

const DEFAULT_VIZIER_QUERY_OPTIONS: VizierQueryOptions = {
	baseUrl: VIZIER_URL,
	timeout: 60000,
}

export async function vizierQuery(query: string, { baseUrl, timeout = 60000, signal, ...options }: VizierQueryOptions = DEFAULT_VIZIER_QUERY_OPTIONS) {
	const uri = `${baseUrl || VIZIER_URL}${VIZIER_QUERY_PATH}`
	signal ??= timeout ? AbortSignal.timeout(timeout) : undefined

	const body = new FormData()
	body.append('request', 'doQuery')
	body.append('lang', 'adql')
	body.append('format', 'tsv')
	body.append('query', query)

	const response = await fetch(uri, { method: 'POST', body, signal, ...options })
	if (response.status >= 300) return undefined
	const text = await response.text()
	return readCsv(text, TSV_DELIMITER)
}
