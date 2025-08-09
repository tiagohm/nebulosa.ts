import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { formatDEC, formatRA, toMas } from '../src/angle'
import { type HygDatabaseEntry, readHygCatalog } from '../src/hyg'
import { fileHandleSource } from '../src/io'
import { toKilometerPerSecond } from '../src/velocity'

test('read', async () => {
	const data: HygDatabaseEntry[] = []
	await using source = fileHandleSource(await fs.open('data/hygdata_v41.csv', 'r'))

	for await (const row of readHygCatalog(source)) {
		data.push(row)
	}

	expect(data).toHaveLength(119626)

	expect(data[0].id).toBe(0)
	expect(data[0].name).toBe('Sol')

	expect(data[32263].id).toBe(32263)
	expect(data[32263].name).toBe('Sirius')
	expect(data[32263].hip).toBe(32349)
	expect(data[32263].hd).toBe(48915)
	expect(data[32263].hr).toBe(2491)
	expect(data[32263].bayer).toBe('Alp')
	expect(data[32263].flamsteed).toBe(9)
	expect(data[32263].magnitude).toBe(-1.44)
	expect(data[32263].constellation).toBe('CMA')
	expect(data[32263].spType).toBe('A0m...')
	expect(data[32263].distance).toBeCloseTo(543940.9205, 3)
	expect(toMas(data[32263].pmRa)).toBeCloseTo(-546.0099, 3)
	expect(toMas(data[32263].pmDec)).toBeCloseTo(-1223.0799, 3)
	expect(toKilometerPerSecond(data[32263].rv)).toBeCloseTo(-9.4, 3)
	expect(formatRA(data[32263].rightAscension)).toBe('06 45 08.93')
	expect(formatDEC(data[32263].declination)).toBe('-16 42 58.02')

	expect(data[119625].id).toBe(119630)
}, 5000)
