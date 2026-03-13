const GITHUB_URL = 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/'

export async function download(name: string, url?: string) {
	const file = Bun.file(`data/${name}`)
	if (await file.exists()) return file
	console.info('downloading:', name)
	const response = await fetch(url || `${GITHUB_URL}${name}`)
	await Bun.write(file, response)
	return file
}
