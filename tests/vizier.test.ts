import { describe, expect, test } from 'bun:test'
import { arcmin, formatDEC, formatRA, toMas } from '../src/angle'
import { toKilometerPerSecond } from '../src/velocity'
import { VizierGaiaCatalog, vizierQuery } from '../src/vizier'

const SKIP = Bun.env.RUN_SKIPPED_TESTS !== 'true'

test.skipIf(SKIP)('vizier', async () => {
	const query = `
    SELECT TOP 2 sao.SAO, sao.HD, sao.Pmag, sao.Vmag, sao.SpType, sao.RA2000, sao.DE2000, sao.pmRA2000, sao.pmDE2000
    FROM "I/131A/sao" AS sao
    ORDER BY SAO ASC
    `

	const table = await vizierQuery(query, { skipFirstLine: false, forceTrim: true })

	expect(table).toBeDefined()

	const [header, ...data] = table!

	expect(header).toHaveLength(9)
	expect(header).toEqual(['SAO', 'HD', 'Pmag', 'Vmag', 'SpType', 'RA2000', 'DE2000', 'pmRA2000', 'pmDE2000'])
	expect(data).toHaveLength(2)
	expect(data[0]).toHaveLength(9)
	expect(data[0]).toEqual(['1', '225019', '', '7.2', 'A0', '0.6735416666666666', '82.97319999999999', '-0.0097', '-0.004'])
})

describe.serial.skipIf(SKIP)('vizier gaia catalog', () => {
	const catalog = new VizierGaiaCatalog()
	const sourceId = '5271055243163629056'
	const centerRA = 2.1734891657691073
	const centerDEC = -1.1922867981518974
	const radius = arcmin(0.5)

	test('get by source id', async () => {
		const star = await catalog.get(sourceId)

		expect(star).toBeDefined()
		expect(star!.id).toBe(sourceId)
		expect(star!.epoch).toBe(2000)
		expect(star!.magnitude).toBeCloseTo(10.6, 1)
		expect(formatRA(star!.rightAscension, true)).toBe('08 18 08')
		expect(formatDEC(star!.declination, true)).toBe('-68 18 47')
		expect(toMas(star!.pmRA!)).toBeCloseTo(94.794 / Math.cos(-centerDEC), 0)
		expect(toMas(star!.pmDEC!)).toBeCloseTo(-340, 0)
		expect(toKilometerPerSecond(star!.rv!)).toBeCloseTo(-6.1, 0)
	})

	test('query around cone region', async () => {
		const stars = await catalog.queryCone(centerRA, centerDEC, radius)
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
	})

	test('query around triangle region', async () => {
		const stars = await catalog.queryTriangle([centerRA - radius, centerDEC - radius], [centerRA + radius, centerDEC - radius], [centerRA, centerDEC + radius])
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
	})

	test('query around box region', async () => {
		const stars = await catalog.queryBox(centerRA - radius, centerRA + radius, centerDEC - radius, centerDEC + radius)
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
	})

	test('query around polygon region', async () => {
		const stars = await catalog.queryPolygon([
			[centerRA, centerDEC + radius],
			[centerRA + radius, centerDEC],
			[centerRA, centerDEC - radius],
			[centerRA - radius, centerDEC],
		])
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
	})
})
