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

async function install(name: string) {
	const file = Bun.file(`native/${name}.shared`)
	if (await file.exists()) return true
	console.info('downloading:', name)
	const response = await download(name)
	console.info('downloaded:', name, response?.status)
	if (!response || !response.ok) return Bun.write(file, '')
	return (await Bun.write(file, response)) > 0
}

await Promise.all(LIBS.map(install))
