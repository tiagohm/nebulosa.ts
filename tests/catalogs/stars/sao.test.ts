import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readSaoCatalog, SaoCatalog, type SaoCatalogEntry } from '../../../src/catalogs/stars/sao'
import { fileHandleSource } from '../../../src/io/io'
import { deg, formatDEC, formatRA, parseAngle, toMas } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'

await downloadPerTag('sao')

test('read', async () => {
	const handle = await fs.open('data/SAO.pc.dat')
	await using source = fileHandleSource(handle)
	const entries = new Array<SaoCatalogEntry>(258997)
	let i = 0

	for await (const entry of readSaoCatalog(source, false)) {
		entries[i++] = entry
	}

	expect(i).toBe(258997)

	expect(entries[0].id).toBe(1)
	expect(formatRA(entries[0].rightAscension)).toBe('00 00 05.10')
	expect(formatDEC(entries[0].declination)).toBe('+82 41 41.82')
	expect(entries[0].magnitude).toBe(7.2)
	expect(entries[0].spType).toBe('A0')

	expect(entries[258995].id).toBe(258996)
	expect(formatRA(entries[258995].rightAscension)).toBe('23 54 51.66')
	expect(formatDEC(entries[258995].declination)).toBe('-82 26 52.62')
	expect(entries[258995].magnitude).toBe(5.7)
	expect(entries[258995].spType).toBe('K0')

	// SAO stores RA proper motion as dα/dt (no cosδ factor), the convention ERFA expects, so it must not
	// be divided by cosδ. Lock this in with Groombridge 1830 (SAO 62738): stored dα/dt ≈ 5080.5 mas/yr,
	// and dα/dt·cosδ ≈ 3999 mas/yr reproduces the catalogued μα·cosδ (SIMBAD ≈ 4003.7 mas/yr).
	const groombridge = entries[62737]
	expect(groombridge.id).toBe(62738)
	expect(toMas(groombridge.pmRA!)).toBeCloseTo(5080.5, 0)
	expect(toMas(groombridge.pmDEC!)).toBeCloseTo(-5806, 0)
	expect(toMas(groombridge.pmRA! * Math.cos(groombridge.declination))).toBeCloseTo(3999.25, 0)

	const catalog = new SaoCatalog()
	catalog.addMany(entries)

	expect(catalog.queryCone(parseAngle('05h 35 16.8')!, parseAngle('-05 23 24')!, deg(1))).toHaveLength(54)
}, 3000)
