import { expect, test } from 'bun:test'
import { simbadSearch } from './simbad'

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
