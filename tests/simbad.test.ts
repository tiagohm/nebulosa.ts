import { describe, expect, test } from 'bun:test'
import { arcmin, deg, formatDEC, formatRA, toDeg, toMas } from '../src/angle'
import { SimbadCatalog, simbadQuery } from '../src/simbad'
import { toKilometerPerSecond } from '../src/velocity'

const SKIP = Bun.env.RUN_SKIPPED_TESTS !== 'true'
const SIMBAD_HEADER = 'oid\totype\tra\tdec\tV\tpmra\tpmdec\tplx_value\trvz_radvel'

async function withMockSimbadCatalog<T>(rows: readonly string[], callback: (catalog: SimbadCatalog, queries: string[]) => Promise<T> | T) {
	const queries: string[] = []
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const form = await request.formData()
			const query = form.get('query')
			queries.push(typeof query === 'string' ? query : '')
			return new Response(`${SIMBAD_HEADER}\n${rows.join('\n')}`)
		},
	})

	try {
		const catalog = new SimbadCatalog({ baseUrl: `http://127.0.0.1:${server.port}/`, timeout: 1000 })
		return await callback(catalog, queries)
	} finally {
		await server.stop(true)
	}
}

async function expectInvalidSimbadObjectId(value: Promise<unknown>) {
	let error: unknown

	try {
		await value
	} catch (cause) {
		error = cause
	}

	expect(error).toBeInstanceOf(Error)
	expect((error as Error).message).toContain('invalid Simbad object id')
}

test('SimbadCatalog rejects invalid object ids before querying', async () => {
	await withMockSimbadCatalog(['1\t*\t0\t0\t0\t0\t0\t0\t0'], async (catalog, queries) => {
		await expectInvalidSimbadObjectId(catalog.get('1 OR 1 = 1'))
		await expectInvalidSimbadObjectId(catalog.get(Number.MAX_SAFE_INTEGER + 1))
		await expectInvalidSimbadObjectId(catalog.get(-1n))
		expect(queries).toEqual([])
	})
})

test('SimbadCatalog preserves zero-valued numeric columns', async () => {
	await withMockSimbadCatalog(['0\t\t0\t0\t0\t0\t0\t0\t0'], async (catalog, queries) => {
		const star = await catalog.get(' 0 ')

		expect(queries[0]).toContain('WHERE b.oid = 0 ORDER BY')
		expect(star).toBeDefined()
		expect(star!.id).toBe(0)
		expect(star!.type).toBeUndefined()
		expect(star!.magnitude).toBe(0)
		expect(toDeg(star!.rightAscension)).toBe(0)
		expect(toDeg(star!.declination)).toBe(0)
		expect(toMas(star!.pmRA!)).toBe(0)
		expect(toMas(star!.pmDEC!)).toBe(0)
		expect(star!.plx).toBe(0)
		expect(toKilometerPerSecond(star!.rv!)).toBe(0)
	})
})

test('SimbadCatalog skips rows with missing required numeric columns', async () => {
	const rows = ['x\t*\t0\t0\t1\t0\t0\t0\t0', '1\t*\t\t0\t1\t0\t0\t0\t0', '1\t*\t0\t\t1\t0\t0\t0\t0', '1\t*\t0\t0\t   \t0\t0\t0\t0']

	for (const row of rows) {
		await withMockSimbadCatalog([row], async (catalog) => {
			expect(await catalog.get('1')).toBeUndefined()
		})
	}
})

test.skipIf(SKIP)('query', async () => {
	const query = `
    SELECT b.oid, b.otype, b.ra, b.dec, b.pmra, b.pmdec, b.plx_value, b.rvz_radvel, b.rvz_redshift, b.main_id
    FROM basic AS b INNER JOIN ident AS i ON b.oid = i.oidref
    WHERE i.id = 'ngc5128'
    `

	const table = await simbadQuery(query, { skipFirstLine: false })

	expect(table).toBeDefined()

	const [header, ...data] = table!

	expect(header).toHaveLength(10)
	expect(header).toEqual(['oid', 'otype', 'ra', 'dec', 'pmra', 'pmdec', 'plx_value', 'rvz_radvel', 'rvz_redshift', 'main_id'])
	expect(data).toHaveLength(1)
	expect(data[0]).toHaveLength(10)
	expect(data[0]).toEqual(['3392496', 'BLL', '201.36506337683332', '-43.019112508083325', '', '', '', '562.1673793553026', '0.00187695', 'NAME Centaurus A'])
})

describe.serial.skipIf(SKIP)('simbad catalog', () => {
	const catalog = new SimbadCatalog()
	const sourceId = 8399845 // Sirius
	const centerRA = deg(101.28715533333335)
	const centerDEC = deg(-16.71611586111111)
	const radius = arcmin(0.5)

	test('get by source id', async () => {
		const star = await catalog.get(sourceId)

		expect(star).toBeDefined()
		expect(star!.id).toBe(sourceId)
		expect(star!.epoch).toBe(2000)
		expect(star!.magnitude).toBeCloseTo(-1.46, 1)
		expect(formatRA(star!.rightAscension, true)).toBe('06 45 09')
		expect(formatDEC(star!.declination, true)).toBe('-16 42 58')
		expect(toMas(star!.pmRA!)).toBeCloseTo(-546.01 / Math.cos(centerDEC), 0)
		expect(toMas(star!.pmDEC!)).toBeCloseTo(-1223.07, 0)
		expect(toKilometerPerSecond(star!.rv!)).toBeCloseTo(-5.5, 0)
		expect(star!.plx!).toBeCloseTo(379.21, 0)
	})

	test('query around cone region', async () => {
		const stars = await catalog.queryCone(centerRA, centerDEC, radius)
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
		expect(stars[0].magnitude).toBeLessThanOrEqual(stars.at(-1)!.magnitude)
	})

	test('query around triangle region', async () => {
		const stars = await catalog.queryTriangle([centerRA - radius, centerDEC - radius], [centerRA + radius, centerDEC - radius], [centerRA, centerDEC + radius])
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
		expect(stars[0].magnitude).toBeLessThanOrEqual(stars.at(-1)!.magnitude)
	})

	test('query around box region', async () => {
		const stars = await catalog.queryBox(centerRA - radius, centerRA + radius, centerDEC - radius, centerDEC + radius)
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
		expect(stars[0].magnitude).toBeLessThanOrEqual(stars.at(-1)!.magnitude)
	})

	test('query around polygon region', async () => {
		const stars = await catalog.queryPolygon([
			[centerRA, centerDEC + radius],
			[centerRA + radius, centerDEC],
			[centerRA, centerDEC - radius],
			[centerRA - radius, centerDEC],
		])
		expect(stars.find((e) => e.id === sourceId)).toBeDefined()
		expect(stars[0].magnitude).toBeLessThanOrEqual(stars.at(-1)!.magnitude)
	})
})
