import fs from 'fs/promises'
import { iersb } from '../src/iers'
import { fileHandleSource } from '../src/io'

const FILES: Readonly<Record<string, string>> = {
	'finals2000A.txt': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/finals2000A.txt',
	'eopc04.1962-now.txt': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/eopc04.1962-now.txt',
	'apod4.jpg': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/apod4.jpg',
	'IAU-CSN.tsv': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/IAU-CSN.tsv',
	'de405.bsp': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/de405.bsp',
	'de421.bsp': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/de421.bsp',
	'moon_pa_de421_1900-2050.bpc': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/moon_pa_de421_1900-2050.bpc',
	'hyg_v42.csv': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/hyg_v42.csv',
	'indi.log': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/indi.log',
	'de440s.bsp': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/de440s.bsp',
	'65803_Didymos.bsp': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/65803_Didymos.bsp',
	'catalog.dat': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/catalog.dat',
	'names.dat': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/names.dat',
	'GRBG-16.1.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/GRBG-16.1.fit',
	'NGC3372-8.1.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-8.1.fit',
	'NGC3372-16.1.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-16.1.fit',
	'NGC3372-32.1.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-32.1.fit',
	'NGC3372--32.1.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--32.1.fit',
	'NGC3372--64.1.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--64.1.fit',
	'NGC3372-8.3.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-8.3.fit',
	'NGC3372-16.3.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-16.3.fit',
	'NGC3372-32.3.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-32.3.fit',
	'NGC3372--32.3.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--32.3.fit',
	'NGC3372--64.3.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--64.3.fit',
	'SAO.pc.dat': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/SAO.pc.dat',
	'LIGHT.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/LIGHT.fit',
	'BIAS.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/BIAS.fit',
	'DARK.15.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/DARK.15.fit',
	'DARK.30.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/DARK.30.fit',
	'DARK.60.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/DARK.60.fit',
	'DARKFLAT.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/DARKFLAT.fit',
	'FLAT.fit': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/FLAT.fit',
	'Sky Simulator.8.1.dat': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/Sky Simulator.8.1.dat',
	'Sky Simulator.8.3.dat': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/Sky Simulator.8.3.dat',
	'NGC3372-8.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-8.1.xisf',
	'NGC3372-8.3.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-8.3.xisf',
	'NGC3372-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-16.1.xisf',
	'NGC3372-16.3.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-16.3.xisf',
	'NGC3372-32.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-32.1.xisf',
	'NGC3372-32.3.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-32.3.xisf',
	'NGC3372--32.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--32.1.xisf',
	'NGC3372--32.3.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--32.3.xisf',
	'NGC3372--64.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--64.1.xisf',
	'NGC3372--64.3.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372--64.3.xisf',
	'NGC3372-zstd-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-zstd-16.1.xisf',
	'NGC3372-zstd+sh-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-zstd+sh-16.1.xisf',
	'NGC3372-lz4hc-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-lz4hc-16.1.xisf',
	'NGC3372-lz4hc+sh-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-lz4hc+sh-16.1.xisf',
	'NGC3372-lz4-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-lz4-16.1.xisf',
	'NGC3372-lz4+sh-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-lz4+sh-16.1.xisf',
	'NGC3372-zlib-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-zlib-16.1.xisf',
	'NGC3372-zlib+sh-16.1.xisf': 'https://github.com/tiagohm/nebulosa.data/raw/refs/heads/main/NGC3372-zlib+sh-16.1.xisf',
}

async function download(type: keyof typeof FILES) {
	const file = Bun.file(`data/${type}`)
	if (await file.exists()) return file
	const url = FILES[type]
	console.info('downloading:', type)
	const response = await fetch(url)
	await Bun.write(file, await response.blob())
	return file
}

await Promise.all(Object.keys(FILES).map((key) => download(key as never)))

// IERS

const handle = await fs.open('data/eopc04.1962-now.txt')
await using source = fileHandleSource(handle)
source.seek(4640029)
await iersb.load(source)
