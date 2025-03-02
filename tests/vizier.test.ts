import { expect, test } from 'bun:test'
import { vizierQuery } from '../src/vizier'

test.skip('vizier', async () => {
	const query = `
    SELECT TOP 100 sao.SAO, sao.HD, sao.Pmag, sao.Vmag, sao.SpType, sao.RA2000, sao.DE2000, sao.pmRA2000, sao.pmDE2000
    FROM "I/131A/sao" AS sao
    ORDER BY SAO ASC
    `

	const table = await vizierQuery(query)

	expect(table).not.toBeUndefined()

	const [header, ...data] = table!

	expect(header).toHaveLength(9)
	expect(header).toEqual(['SAO', 'HD', 'Pmag', 'Vmag', 'SpType', 'RA2000', 'DE2000', 'pmRA2000', 'pmDE2000'])
	expect(data).toHaveLength(100)
	expect(data[0]).toHaveLength(9)
	expect(data[0]).toEqual(['1', '225019', '', '7.2', 'A0', '0.6735416666666666', '82.97319999999999', '-0.0097', '-0.004'])
})
