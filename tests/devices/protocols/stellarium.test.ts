import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readCatalogDat, readNamesDat, StellariumCatalog, type StellariumCatalogEntry, type StellariumNameEntry, StellariumObjectType } from '../../../src/devices/protocols/stellarium'
import { BufferSource, fileHandleSource } from '../../../src/io/io'
import { sphericalSeparation } from '../../../src/math/numerical/geometry'
import { deg, parseAngle } from '../../../src/math/units/angle'
import { toLightYear } from '../../../src/math/units/distance'
import { downloadPerTag } from '../../download'

await downloadPerTag('stellarium')

test('catalog', async () => {
	const handle = await fs.open('data/catalog.dat')
	await using source = fileHandleSource(handle)
	const entries = new Array<StellariumCatalogEntry>(94659)
	let i = 0

	for await (const entry of readCatalogDat(source)) {
		entries[i++] = entry
	}

	expect(i).toBe(94659)

	expect(entries[0].id).toBe(1)
	expect(entries[0].m).toBe(40)
	expect(entries[0].rightAscension).toBe(3.238497018814087)
	expect(entries[0].declination).toBe(1.0137385129928589)
	expect(entries[0].magnitude).toBe(9.649999618530273)
	expect(entries[0].type).toBe(StellariumObjectType.STAR)
	expect(entries[0].majorAxis).toBe(0)
	expect(entries[0].minorAxis).toBe(0)
	expect(entries[0].orientation).toBe(0)
	expect(entries[0].redshift).toBe(99)
	expect(entries[0].aco).toBeUndefined()

	expect(entries[311].id).toBe(312)
	expect(entries[311].ngc).toBe(281)
	expect(entries[311].sh2).toBe(184)
	expect(entries[311].lbn).toBe(616)
	expect(entries[311].ced).toBe('3')
	expect(entries[311].rightAscension).toBe(0.22871841490268707)
	expect(entries[311].declination).toBe(0.9872454404830933)
	expect(entries[311].magnitude).toBeUndefined()
	expect(entries[311].type).toBe(StellariumObjectType.HII_REGION)
	expect(entries[311].majorAxis).toBe(0.01018108695653449)
	expect(entries[311].minorAxis).toBe(0.008726646259971648)
	expect(entries[311].orientation).toBe(0)
	expect(entries[311].redshift).toBe(99)
	expect(entries[311].px).toBe(2.908882202245805e-9)
	expect(toLightYear(entries[311].distance)).toBeCloseTo(5544.6, 0)

	expect(entries[94658].id).toBe(94659)
	expect(entries[94658].vdbha).toBe(197)
	expect(entries[94658].rightAscension).toBe(4.391684532165527)
	expect(entries[94658].declination).toBe(-0.8004080057144165)
	expect(entries[94658].magnitude).toBeUndefined()
	expect(entries[94658].type).toBe(StellariumObjectType.OPEN_STAR_CLUSTER)
	expect(entries[94658].majorAxis).toBe(0.0011635528953468956)
	expect(entries[94658].minorAxis).toBe(0.0011635528953468956)
	expect(entries[94658].orientation).toBe(1.5707963267948966)
	expect(entries[94658].redshift).toBe(99)
	expect(entries[94658].aco).toBeUndefined()

	expect(entries[254].mType).toBe('SA(s)b')

	const catalog = new StellariumCatalog()
	catalog.addMany(entries)

	const centerRA = parseAngle('05h 35 16.8')!
	const centerDEC = parseAngle('-05 23 24')!
	const radius = deg(1)
	const results = catalog.queryCone(centerRA, centerDEC, radius)
	expect(results).toHaveLength(11)
	// Every returned entry must actually lie within the queried cone.
	for (const entry of results) {
		expect(sphericalSeparation(centerRA, centerDEC, entry.rightAscension, entry.declination)).toBeLessThanOrEqual(radius + 1e-9)
	}

	expect(catalog.queryCone(parseAngle('18h 02 42.0')!, parseAngle('-22 58 18')!, deg(1))).toHaveLength(19)
}, 5000)

test('names', async () => {
	const handle = await fs.open('data/names.dat')
	await using source = fileHandleSource(handle)
	const entries = new Array<StellariumNameEntry>(2000)
	let i = 0

	for await (const entry of readNamesDat(source)) {
		entries[i++] = entry
	}

	expect(i).toBe(1383)

	expect(entries[0].prefix).toBe('NGC')
	expect(entries[0].id).toBe('40')
	expect(entries[0].name).toBe('Bow-Tie Nebula')

	expect(entries[1382].prefix).toBe('')
	expect(entries[1382].id).toBe('49')
	expect(entries[1382].name).toBe('Norma Star Cloud')
})

test('names skips comments and entries without translated names', async () => {
	const line = (prefix: string, id: string, name: string) => `${prefix.padEnd(5)}${id.padEnd(15)}${name}`
	const source = new BufferSource(Buffer.from(['# comment', line('NGC', '40', '_("Bow-Tie Nebula")'), line('IC', '1', 'Plain text name'), line('', '49', '_("Norma Star Cloud")')].join('\n') + '\n'))
	const entries: StellariumNameEntry[] = []

	for await (const entry of readNamesDat(source)) {
		entries.push(entry)
	}

	expect(entries).toEqual([
		{ prefix: 'NGC', id: '40', name: 'Bow-Tie Nebula' },
		{ prefix: '', id: '49', name: 'Norma Star Cloud' },
	])
})
