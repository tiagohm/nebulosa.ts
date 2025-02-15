export const BASE_URL = 'https://simbad.cds.unistra.fr/'
export const ALTERNATIVE_URL = 'https://simbad.u-strasbg.fr/'

const SEARCH_PATH = 'simbad/sim-tap/sync'

export interface SimbadTable {
	readonly headers: string[]
	readonly data: string[][]
}

export async function simbadSearch(query: string, baseUrl?: string) {
	const uri = `${baseUrl || BASE_URL}${SEARCH_PATH}`

	const body = new FormData()
	body.append('request', 'doQuery')
	body.append('lang', 'adql')
	body.append('format', 'tsv')
	body.append('query', query)

	const response = await fetch(uri, { method: 'POST', body })
	if (response.status >= 300) return undefined
	const text = await response.text()
	return parseTable(text)
}

function parseTable(text: string): SimbadTable | undefined {
	const lines = text.split('\n')
	const headers = lines[0]?.split('\t') ?? []
	const length = lines.length - (lines.length && !lines[lines.length - 1] ? 1 : 0)

	if (lines.length > 1 && headers.length && headers[0]) {
		const data = new Array<string[]>(Math.max(0, length - 1))

		for (let i = 1; i < length; i++) {
			const item = lines[i].split('\t')
			data[i - 1] = item
		}

		return { headers, data }
	}

	return undefined
}
