import { expect, test } from 'bun:test'
import { simbadQuery } from '../src/simbad'

test.skip('query', async () => {
	const query = `
    SELECT b.oid, b.otype, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.rvz_radvel, b.rvz_redshift, b.main_id
    FROM basic AS b INNER JOIN ident AS i ON b.oid = i.oidref
    WHERE i.id = 'ngc5128'
    `

	const table = await simbadQuery(query)

	expect(table).not.toBeUndefined()

	const [header, ...data] = table!

	expect(header).toHaveLength(10)
	expect(header).toEqual(['oid', 'otype', 'ra', 'dec', 'pmra', 'pmdec', 'plx_value', 'rvz_radvel', 'rvz_redshift', 'main_id'])
	expect(data).toHaveLength(1)
	expect(data[0]).toHaveLength(10)
	expect(data[0]).toEqual(['3392496', 'Sy2', '201.36506337683332', '-43.019112508083325', '', '', '', '562.1673793553026', '0.00187695', 'NAME Centaurus A'])
})
