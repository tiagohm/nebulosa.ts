const GITHUB_URL = 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/'

const FILES = {
	'finals2000A.txt': [undefined, 'iers'],
	'eopc04.1962-now.txt': [undefined, 'iers', 'location', 'time'],
	'apod4.jpg': [undefined], // astap
	'IAU-CSN.tsv': [undefined, 'csv'],
	'de405.bsp': [undefined, 'daf', 'spk'],
	'de421.bsp': [undefined, 'daf', 'spk'],
	'moon_pa_de421_1900-2050.bpc': [undefined, 'daf'],
	'hyg_v42.csv': [undefined, 'hyg'],
	'indi.log': [undefined, 'indi'],
	'de440s.bsp': [undefined, 'daf', 'spk'],
	'65803_Didymos.bsp': [undefined, 'spk'],
	'catalog.dat': [undefined, 'stellarium'],
	'names.dat': [undefined, 'stellarium'],
	'GRBG-16.1.fit': [undefined, 'image'],
	'NGC3372-8.1.fit': [undefined, 'alpaca.client', 'alpaca.server', 'fits', 'image'],
	'NGC3372-16.1.fit': [undefined, 'alpaca.client', 'alpaca.server', 'fits', 'image'],
	'NGC3372-32.1.fit': [undefined, 'alpaca.client', 'fits', 'image'],
	'NGC3372--32.1.fit': [undefined, 'alpaca.client', 'fits', 'image'],
	'NGC3372--64.1.fit': [undefined, 'alpaca.client', 'fits', 'image'],
	'NGC3372-8.3.fit': [undefined, 'alpaca.client', 'alpaca.server', 'fits', 'image'],
	'NGC3372-16.3.fit': [undefined, 'alpaca.client', 'alpaca.server', 'fits', 'image'],
	'NGC3372-32.3.fit': [undefined, 'alpaca.client', 'fits', 'image'],
	'NGC3372--32.3.fit': [undefined, 'alpaca.client', 'fits', 'image'],
	'NGC3372--64.3.fit': [undefined, 'alpaca.client', 'fits', 'image'],
	'SAO.pc.dat': [undefined, 'sao'],
	'LIGHT.fit': [undefined, 'image'],
	'BIAS.fit': [undefined, 'image'],
	'DARK.15.fit': [undefined, 'image'],
	'DARK.30.fit': [undefined, 'image'],
	'DARK.60.fit': [undefined, 'image'],
	'DARKFLAT.fit': [undefined, 'image'],
	'FLAT.fit': [undefined, 'image'],
	'Sky Simulator.8.1.dat': [undefined, 'alpaca.client'],
	'Sky Simulator.8.3.dat': [undefined, 'alpaca.client'],
	'NGC3372-8.1.xisf': [undefined, 'xisf'],
	'NGC3372-8.3.xisf': [undefined, 'xisf'],
	'NGC3372-16.1.xisf': [undefined, 'xisf'],
	'NGC3372-16.3.xisf': [undefined, 'xisf'],
	'NGC3372-32.1.xisf': [undefined, 'xisf'],
	'NGC3372-32.3.xisf': [undefined, 'xisf'],
	'NGC3372--32.1.xisf': [undefined, 'xisf'],
	'NGC3372--32.3.xisf': [undefined, 'xisf'],
	'NGC3372--64.1.xisf': [undefined, 'xisf'],
	'NGC3372--64.3.xisf': [undefined, 'xisf'],
	'NGC3372-zstd-16.1.xisf': [undefined],
	'NGC3372-zstd+sh-16.1.xisf': [undefined],
	'NGC3372-lz4hc-16.1.xisf': [undefined],
	'NGC3372-lz4hc+sh-16.1.xisf': [undefined],
	'NGC3372-lz4-16.1.xisf': [undefined],
	'NGC3372-lz4+sh-16.1.xisf': [undefined],
	'NGC3372-zlib-16.1.xisf': [undefined],
	'NGC3372-zlib+sh-16.1.xisf': [undefined],
} as const

const downloading = new Map<string, Promise<Bun.BunFile>>()

type FileName = keyof typeof FILES
type FileTag = 'alpaca.client' | 'alpaca.server' | 'csv' | 'daf' | 'fits' | 'hyg' | 'iers' | 'image' | 'indi' | 'location' | 'sao' | 'spk' | 'stellarium' | 'time' | 'xisf'

export async function download(name: FileName) {
	const task = downloading.get(name)

	if (task !== undefined) {
		// console.info('downloading in progress', name)
		return task
	}

	const { promise, resolve } = Promise.withResolvers<Bun.BunFile>()
	downloading.set(name, promise)

	const file = Bun.file(`data/${name}`)
	const signal = AbortSignal.timeout(15000)

	try {
		if (!(await file.exists())) {
			console.info('downloading:', name)
			const startTime = Bun.nanoseconds()
			const response = await fetch(FILES[name][0] || `${GITHUB_URL}${name}`, { signal })
			const bytes = await response.blob()
			const size = await Bun.write(file, bytes)
			console.info('downloaded:', name, (Bun.nanoseconds() - startTime) / 1000000, 'ms', size, 'B')
		}
	} catch (e) {
		console.info('failed to download', name, e)
	} finally {
		resolve(file)
	}

	return file
}

export async function downloadPerTag(tag: FileTag) {
	const files = Object.keys(FILES).filter((name) => FILES[name as FileName].includes(tag as never))
	return await Promise.all(files.map((name) => download(name as never)))
}
