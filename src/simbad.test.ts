import { expect, test } from 'bun:test'
import { simbadSearch, vizierSearch } from './simbad'

test.skip('search', async () => {
	const query = `
    SELECT b.oid, b.otype, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.rvz_radvel, b.rvz_redshift, b.main_id
    FROM basic AS b INNER JOIN ident AS i ON b.oid = i.oidref
    WHERE i.id = 'ngc5128'
    `

	const table = await simbadSearch(query)

	expect(table).not.toBeUndefined()
	expect(table!.headers).toHaveLength(10)
	expect(table!.headers).toEqual(['oid', 'otype', 'ra', 'dec', 'pmra', 'pmdec', 'plx_value', 'rvz_radvel', 'rvz_redshift', 'main_id'])
	expect(table!.data).toHaveLength(1)
	expect(table!.data[0]).toHaveLength(10)
	expect(table!.data[0]).toEqual(['3392496', '"Sy2"', '201.36506337683332', '-43.019112508083325', '', '', '', '562.1673793553026', '0.00187695', '"NAME Centaurus A"'])
})

test.skip('vizier', async () => {
	const query = `
    SELECT TOP 100 sao.SAO, sao.HD, sao.Pmag, sao.Vmag, sao.SpType, sao.RA2000, sao.DE2000, sao.pmRA2000, sao.pmDE2000
    FROM "I/131A/sao" AS sao
    ORDER BY SAO ASC
    `

	const table = await vizierSearch(query)

	expect(table).not.toBeUndefined()
	expect(table!.headers).toHaveLength(9)
	expect(table!.headers).toEqual(['SAO', 'HD', 'Pmag', 'Vmag', 'SpType', 'RA2000', 'DE2000', 'pmRA2000', 'pmDE2000'])
	expect(table!.data).toHaveLength(100)
	expect(table!.data[0]).toHaveLength(9)
	expect(table!.data[0]).toEqual(['1', '"225019"', '', '7.2', '"A0 "', '0.6735416666666666', '82.97319999999999', '-0.0097', '-0.004'])
})
