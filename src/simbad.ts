import { readCsv, TSV_DELIMITER } from './csv'

// https://simbad.cds.unistra.fr/simbad/sim-tap/

export const SIMBAD_URL = 'https://simbad.cds.unistra.fr/'
export const SIMBAD_ALTERNATIVE_URL = 'https://simbad.u-strasbg.fr/'

const SIMBAD_QUERY_PATH = 'simbad/sim-tap/sync'

export async function simbadQuery(query: string, baseUrl?: string) {
	const uri = `${baseUrl || SIMBAD_URL}${SIMBAD_QUERY_PATH}`

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
