import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { read } from './daf'
import { fileHandleSource } from './io'
import { Naif } from './naif'
import { spk } from './spk'
import { timeYMDHMS } from './time'

const time = timeYMDHMS(2022, 12, 8, 20, 7, 15.0)

test('DE405', async () => {
	await using source = fileHandleSource(await fs.open('data/de405.bsp'))
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).not.toBeUndefined()
	segment!.compute(time)
})

test('DE421', async () => {
	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).not.toBeUndefined()
	segment!.compute(time)
})

test('65803 Didymos', async () => {
	await using source = fileHandleSource(await fs.open('data/65803_Didymos.bsp'))
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SUN, Naif.DIDYMOS_BARYCENTER)
	expect(segment).not.toBeUndefined()
	segment!.compute(time)
})
