import { readCsv, TSV_DELIMITER } from './csv'

export const VIZIER_URL = 'http://tapvizier.cds.unistra.fr/'

const VIZIER_QUERY_PATH = 'TAPVizieR/tap/sync'

export async function vizierQuery(query: string, baseUrl?: string) {
	const uri = `${baseUrl || VIZIER_URL}${VIZIER_QUERY_PATH}`

	const body = new FormData()
	body.append('request', 'doQuery')
	body.append('lang', 'adql')
	body.append('format', 'tsv')
	body.append('query', query)

	const response = await fetch(uri, { method: 'POST', body })
	if (response.status >= 300) return undefined
	const text = await response.text()
	return readCsv(text, TSV_DELIMITER)
}
