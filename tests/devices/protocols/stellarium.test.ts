import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { PI } from '../../../src/core/constants'
import { readCatalogDat, readNamesDat, StellariumCatalog, type StellariumCatalogEntry, type StellariumNameEntry, StellariumObjectType, StellariumProtocolServer } from '../../../src/devices/protocols/stellarium'
import { BufferSource, fileHandleSource } from '../../../src/io/io'
import { sphericalSeparation } from '../../../src/math/numerical/geometry'
import { deg, parseAngle } from '../../../src/math/units/angle'
import { toLightYear } from '../../../src/math/units/distance'
import { downloadPerTag } from '../../download'

await downloadPerTag('stellarium')

function gotoMessage(ra: number, dec: number) {
	const message = Buffer.alloc(20)
	message.writeUInt16LE(20, 0)
	message.writeUInt16LE(0, 2)
	message.writeUInt32LE(ra, 12)
	message.writeInt32LE(dec, 16)
	return message
}

test('decodes a fragmented goto message', async () => {
	const gotos: [number, number][] = []
	const server = new StellariumProtocolServer({ handler: { goto: (_, ra, dec) => gotos.push([ra, dec]) } })
	server.start('127.0.0.1', 0)
	const client = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: () => {} } })

	try {
		const message = gotoMessage(0x40000000, 0x20000000)
		client.write(message, 0, 10)
		await Bun.sleep(10)
		expect(gotos).toHaveLength(0)
		client.write(message, 10, 10)
		await Bun.sleep(10)

		expect(gotos).toEqual([[PI / 2, PI / 4]])
	} finally {
		client.close()
		server.stop()
	}
})

test('decodes concatenated goto messages in order', async () => {
	const gotos: [number, number][] = []
	const server = new StellariumProtocolServer({ handler: { goto: (_, ra, dec) => gotos.push([ra, dec]) } })
	server.start('127.0.0.1', 0)
	const client = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: () => {} } })

	try {
		client.write(Buffer.concat([gotoMessage(0x40000000, 0x20000000), gotoMessage(0x60000000, -0x10000000)]))
		await Bun.sleep(10)

		expect(gotos).toEqual([
			[PI / 2, PI / 4],
			[(3 * PI) / 4, -PI / 8],
		])
	} finally {
		client.close()
		server.stop()
	}
})

test('catalog', async () => {
	const handle = await fs.open('data/catalog.dat')
	await using source = fileHandleSource(handle)
	const entries = new Array<StellariumCatalogEntry>(94659)
	let i = 0

	for await (const entry of readCatalogDat(source)) {
		entries[i++] = entry
	}

	expect(i).toBeGreaterThan(94000)

	const M40 = entries.find((e) => e.m === 40)!
	expect(M40.id).toBe(1)
	expect(M40.rightAscension).toBe(3.238497018814087)
	expect(M40.declination).toBe(1.0137385129928589)
	expect(M40.magnitude).toBe(9.649999618530273)
	expect(M40.type).toBe(StellariumObjectType.STAR)
	expect(M40.majorAxis).toBe(0)
	expect(M40.minorAxis).toBe(0)
	expect(M40.orientation).toBe(0)
	expect(M40.redshift).toBe(99)
	expect(M40.aco).toBeUndefined()

	const NGC281 = entries.find((e) => e.ngc === 281)!
	expect(NGC281.id).toBe(312)
	expect(NGC281.sh2).toBe(184)
	expect(NGC281.lbn).toBe(616)
	expect(NGC281.ced).toBe('3')
	expect(NGC281.rightAscension).toBe(0.22871841490268707)
	expect(NGC281.declination).toBe(0.9872454404830933)
	expect(NGC281.magnitude).toBeUndefined()
	expect(NGC281.type).toBe(StellariumObjectType.HII_REGION)
	expect(NGC281.majorAxis).toBe(0.01018108695653449)
	expect(NGC281.minorAxis).toBe(0.008726646259971648)
	expect(NGC281.orientation).toBe(0)
	expect(NGC281.redshift).toBe(99)
	expect(NGC281.px).toBe(2.908882202245805e-9)
	expect(toLightYear(NGC281.distance)).toBeCloseTo(5544.6, 0)

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

	expect(catalog.queryCone(parseAngle('18h 02 42.0')!, parseAngle('-22 58 18')!, deg(1)).length).toBeGreaterThanOrEqual(19)
}, 5000)

test('names', async () => {
	const handle = await fs.open('data/names.dat')
	await using source = fileHandleSource(handle)
	const entries = new Array<StellariumNameEntry>(2000)
	let i = 0

	for await (const entry of readNamesDat(source)) {
		entries[i++] = entry
	}

	expect(i).toBeGreaterThan(1300)

	const NGC40 = entries.find((e) => e.prefix === 'NGC' && e.id === '40')!
	expect(NGC40.name).toBe('Bow-Tie Nebula')

	const Norma = entries.find((e) => e.prefix === '' && e.id === '49')!
	expect(Norma.name).toBe('Norma Star Cloud')
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
