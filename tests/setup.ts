import fs from 'fs/promises'
import { iersb } from '../src/iers'
import { fileHandleSource } from '../src/io'
import { download } from './download'

const FILES: Readonly<Record<string, string | undefined>> = {
	'finals2000A.txt': undefined,
	'eopc04.1962-now.txt': undefined,
	'apod4.jpg': undefined,
	'IAU-CSN.tsv': undefined,
	'de405.bsp': undefined,
	'de421.bsp': undefined,
	'moon_pa_de421_1900-2050.bpc': undefined,
	'hyg_v42.csv': undefined,
	'indi.log': undefined,
	'de440s.bsp': undefined,
	'65803_Didymos.bsp': undefined,
	'catalog.dat': undefined,
	'names.dat': undefined,
	'GRBG-16.1.fit': undefined,
	'NGC3372-8.1.fit': undefined,
	'NGC3372-16.1.fit': undefined,
	'NGC3372-32.1.fit': undefined,
	'NGC3372--32.1.fit': undefined,
	'NGC3372--64.1.fit': undefined,
	'NGC3372-8.3.fit': undefined,
	'NGC3372-16.3.fit': undefined,
	'NGC3372-32.3.fit': undefined,
	'NGC3372--32.3.fit': undefined,
	'NGC3372--64.3.fit': undefined,
	'SAO.pc.dat': undefined,
	'LIGHT.fit': undefined,
	'BIAS.fit': undefined,
	'DARK.15.fit': undefined,
	'DARK.30.fit': undefined,
	'DARK.60.fit': undefined,
	'DARKFLAT.fit': undefined,
	'FLAT.fit': undefined,
	'Sky Simulator.8.1.dat': undefined,
	'Sky Simulator.8.3.dat': undefined,
	'NGC3372-8.1.xisf': undefined,
	'NGC3372-8.3.xisf': undefined,
	'NGC3372-16.1.xisf': undefined,
	'NGC3372-16.3.xisf': undefined,
	'NGC3372-32.1.xisf': undefined,
	'NGC3372-32.3.xisf': undefined,
	'NGC3372--32.1.xisf': undefined,
	'NGC3372--32.3.xisf': undefined,
	'NGC3372--64.1.xisf': undefined,
	'NGC3372--64.3.xisf': undefined,
	'NGC3372-zstd-16.1.xisf': undefined,
	'NGC3372-zstd+sh-16.1.xisf': undefined,
	'NGC3372-lz4hc-16.1.xisf': undefined,
	'NGC3372-lz4hc+sh-16.1.xisf': undefined,
	'NGC3372-lz4-16.1.xisf': undefined,
	'NGC3372-lz4+sh-16.1.xisf': undefined,
	'NGC3372-zlib-16.1.xisf': undefined,
	'NGC3372-zlib+sh-16.1.xisf': undefined,
}

await Promise.all(Object.entries(FILES).map((entry) => download(...entry)))

// IERS

const handle = await fs.open('data/eopc04.1962-now.txt')
await using source = fileHandleSource(handle)
source.seek(4640029)
await iersb.load(source)
