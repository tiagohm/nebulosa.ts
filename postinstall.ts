import { suffix } from 'bun:ffi'

const GITHUB_URL = `https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/native/${process.platform}-${process.arch}`
const LIBS = ['libwcs', 'libturbojpeg', 'libastrometry'] as const

function download(name: string) {
	try {
		return fetch(`${GITHUB_URL}/${name}.${suffix}`)
	} catch {
		console.error('failed to download:', name)
		return undefined
	}
}

function save(response: Response, file: Bun.BunFile) {
	return Bun.write(file, response)
}

async function install(name: string) {
	const file = Bun.file(`native/${name}.shared`)
	if (await file.exists()) return true
	console.info('downloading:', name)
	const response = await download(name)
	if (!response) return false
	console.info('downloaded:', name)
	return (await save(response, file)) > 0
}

await Promise.all(LIBS.map(install))
