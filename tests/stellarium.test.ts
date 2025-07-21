import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { deg, parseAngle } from '../src/angle'
import { fileHandleSource } from '../src/io'
import { type CatalogEntry, type NameEntry, readCatalogDat, readNamesDat, StellariumObjectType, searchAround } from '../src/stellarium'

test('catalog', async () => {
	const handle = await fs.open('data/catalog.dat')
	const source = fileHandleSource(handle)
	const entries = new Array<CatalogEntry>(94660)
	let i = 0

	for await (const entry of readCatalogDat(source)) {
		entries[i++] = entry
	}

	expect(i).toBe(94660)

	expect(entries[0].id).toBe(1)
	expect(entries[0].m).toBe(40)
	expect(entries[0].ra).toBe(3.238497018814087)
	expect(entries[0].dec).toBe(1.0137385129928589)
	expect(entries[0].mB).toBe(99)
	expect(entries[0].mV).toBe(9.649999618530273)
	expect(entries[0].type).toBe(StellariumObjectType.STAR)
	expect(entries[0].majorAxis).toBe(0)
	expect(entries[0].minorAxis).toBe(0)
	expect(entries[0].orientation).toBe(0)
	expect(entries[0].redshift).toBe(99)
	expect(entries[0].aco).toBe('')

	expect(entries[311].id).toBe(312)
	expect(entries[311].ngc).toBe(281)
	expect(entries[311].sh2).toBe(184)
	expect(entries[311].lbn).toBe(616)
	expect(entries[311].ced).toBe('3')
	expect(entries[311].ra).toBe(0.22871841490268707)
	expect(entries[311].dec).toBe(0.9872454404830933)
	expect(entries[311].mB).toBe(99)
	expect(entries[311].mV).toBe(99)
	expect(entries[311].type).toBe(StellariumObjectType.HII_REGION)
	expect(entries[311].majorAxis).toBe(0.01018108695653449)
	expect(entries[311].minorAxis).toBe(0.008726646259971648)
	expect(entries[311].orientation).toBe(0)
	expect(entries[311].redshift).toBe(99)
	expect(entries[311].parallax).toBe(2.908882202245805e-9)

	expect(entries[94659].id).toBe(94660)
	expect(entries[94659].vdbha).toBe(197)
	expect(entries[94659].ra).toBe(4.391684532165527)
	expect(entries[94659].dec).toBe(-0.8004080057144165)
	expect(entries[94659].mB).toBe(99)
	expect(entries[94659].mV).toBe(99)
	expect(entries[94659].type).toBe(StellariumObjectType.OPEN_STAR_CLUSTER)
	expect(entries[94659].majorAxis).toBe(0.0011635528953468956)
	expect(entries[94659].minorAxis).toBe(0.0011635528953468956)
	expect(entries[94659].orientation).toBe(1.5707963267948966)
	expect(entries[94659].redshift).toBe(99)
	expect(entries[94659].aco).toBe('')

	expect(searchAround(entries, parseAngle('05h 35 16.8')!, parseAngle('-05 23 24')!, deg(1))).toHaveLength(11)
	expect(searchAround(entries, parseAngle('18h 02 42.0')!, parseAngle('-22 58 18')!, deg(1))).toHaveLength(19)
}, 10000)

test('names', async () => {
	const handle = await fs.open('data/names.dat')
	const source = fileHandleSource(handle)
	const entries = new Array<NameEntry>(2000)
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
