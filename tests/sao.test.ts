import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { formatDEC, formatRA } from '../src/angle'
import { fileHandleSource } from '../src/io'
import { readSaoCatalog, type SaoCatalogEntry } from '../src/sao'

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
	expect(formatRA(entries[0].rightAscension)).toBe('00 02 42.05')
	expect(formatDEC(entries[0].declination)).toBe('+82 58 24.00')
	expect(entries[0].magnitude).toBe(7.2)
	expect(entries[0].spType).toBe('A0')

	expect(entries[258995].id).toBe(258996)
	expect(formatRA(entries[258995].rightAscension)).toBe('23 57 33.55')
	expect(formatDEC(entries[258995].declination)).toBe('-82 10 10.55')
	expect(entries[258995].magnitude).toBe(5.7)
	expect(entries[258995].spType).toBe('K0')
})
