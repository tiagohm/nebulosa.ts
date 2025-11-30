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
