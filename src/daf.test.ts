import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { read } from './daf'
import { fileHandleSource } from './io'

test('NAIF/DAF', async () => {
	await using source = fileHandleSource(await fs.open('data/de405.bsp'))
	const daf = await read(source)

	expect(daf).not.toBeUndefined()
	expect(daf.summaries).toHaveLength(15)

	for (const summary of daf.summaries) expect(summary.doubles).toEqual([-1.5778799588160586e9, 1.5778800641839132e9])

	expect(daf.summaries[0].ints).toEqual([1, 0, 1, 2, 1409, 202316])
	expect(daf.summaries[1].ints).toEqual([2, 0, 1, 2, 202317, 275376])
	expect(daf.summaries[2].ints).toEqual([3, 0, 1, 2, 275377, 368983])
	expect(daf.summaries[3].ints).toEqual([4, 0, 1, 2, 368984, 408957])
	expect(daf.summaries[4].ints).toEqual([5, 0, 1, 2, 408958, 438653])
	expect(daf.summaries[5].ints).toEqual([6, 0, 1, 2, 438654, 464923])
	expect(daf.summaries[6].ints).toEqual([7, 0, 1, 2, 464924, 487767])
	expect(daf.summaries[7].ints).toEqual([8, 0, 1, 2, 487768, 510611])
	expect(daf.summaries[8].ints).toEqual([9, 0, 1, 2, 510612, 533455])
	expect(daf.summaries[9].ints).toEqual([10, 0, 1, 2, 533456, 613364])
	expect(daf.summaries[10].ints).toEqual([301, 3, 1, 2, 613365, 987780])
	expect(daf.summaries[11].ints).toEqual([399, 3, 1, 2, 987781, 1362196])
	expect(daf.summaries[12].ints).toEqual([199, 1, 1, 2, 1362197, 1362208])
	expect(daf.summaries[13].ints).toEqual([299, 2, 1, 2, 1362209, 1362220])
	expect(daf.summaries[14].ints).toEqual([499, 4, 1, 2, 1362221, 1362232])
})

test('DAF/SPK', async () => {
	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const daf = await read(source)

	expect(daf).not.toBeUndefined()
	expect(daf.summaries).toHaveLength(15)

	for (const summary of daf.summaries) expect(summary.doubles).toEqual([-3.1691952e9, 1.6968528e9])

	expect(daf.summaries[0].ints).toEqual([1, 0, 1, 2, 641, 310404])
	expect(daf.summaries[1].ints).toEqual([2, 0, 1, 2, 310405, 423048])
	expect(daf.summaries[2].ints).toEqual([3, 0, 1, 2, 423049, 567372])
	expect(daf.summaries[3].ints).toEqual([4, 0, 1, 2, 567373, 628976])
	expect(daf.summaries[4].ints).toEqual([5, 0, 1, 2, 628977, 674740])
	expect(daf.summaries[5].ints).toEqual([6, 0, 1, 2, 674741, 715224])
	expect(daf.summaries[6].ints).toEqual([7, 0, 1, 2, 715225, 750428])
	expect(daf.summaries[7].ints).toEqual([8, 0, 1, 2, 750429, 785632])
	expect(daf.summaries[8].ints).toEqual([9, 0, 1, 2, 785633, 820836])
	expect(daf.summaries[9].ints).toEqual([10, 0, 1, 2, 820837, 944040])
	expect(daf.summaries[10].ints).toEqual([301, 3, 1, 2, 944041, 1521324])
	expect(daf.summaries[11].ints).toEqual([399, 3, 1, 2, 1521325, 2098608])
	expect(daf.summaries[12].ints).toEqual([199, 1, 1, 2, 2098609, 2098620])
	expect(daf.summaries[13].ints).toEqual([299, 2, 1, 2, 2098621, 2098632])
	expect(daf.summaries[14].ints).toEqual([499, 4, 1, 2, 2098633, 2098644])
})

test('DAF/PCK', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const daf = await read(source)

	expect(daf).not.toBeUndefined()
	expect(daf.summaries).toHaveLength(1)
	expect(daf.summaries[0].doubles).toEqual([-3.1557168e9, 1.609416e9])
	expect(daf.summaries[0].ints).toEqual([31006, 1, 2, 641, 221284])
})
