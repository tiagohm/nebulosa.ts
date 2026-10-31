import { describe, expect, test } from 'bun:test'
import { assertSupportedSignature, type CloseApproachCatalogQuery, closeApproaches, closeApproachesUrl, identify, parseCloseApproaches, search, SmallBodyResponseError } from '../../../src/adapters/orbits/sbd'
import { temporalFromDate } from '../../../src/astronomy/time/temporal'
import { deg, parseAngle } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'
import { isNetworkTestSkipped } from '../../util'

const SKIP = isNetworkTestSkipped()

// Trimmed from cad.api responses of 2026-10-31.
const SIGNATURE = { source: 'NASA/JPL SBDB Close Approach Data API', version: '1.5' }
const ALL_BODIES_FIELDS = ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'body', 'h', 'diameter', 'diameter_sigma', 'fullname'] as const
const APOPHIS = ['99942', '220', '2462240.407091969', '2029-Apr-13 21:46', '0.000254090910419299', '0.000254068999976389', '0.000254112821017663', '7.42253895678452', '5.84135589753103', '< 00:01', 'Earth', '19.09', '0.34', '0.04', ' 99942 Apophis (2004 MN4)']
const COMET_FIELDS = ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h'] as const
const COMET = ['323P', 'K253/2', '2451556.417454654', '2000-Jan-12 22:01', '0.060435122020183', '0.0587478883696102', '0.0623104136716796', '41.4723570563974', '41.4712939669654', '03:53', null] as unknown as string[]
const CATALOG_QUERY: CloseApproachCatalogQuery = { selector: 'catalog', dateMin: '2026-11-01', dateMax: '2026-11-30', body: 'Earth', distanceMax: 10, distanceUnit: 'LD', sort: 'date', limit: 50, offset: 0 }

describe('close approach url', () => {
	test('lifts the NEO filter, states every default, and takes the last day whole', () => {
		const url = new URL(closeApproachesUrl(CATALOG_QUERY))
		expect(url.pathname).toBe('/cad.api')
		expect(Object.fromEntries(url.searchParams)).toEqual({ diameter: 'true', fullname: 'true', 'date-min': '2026-11-01', 'date-max': '2026-11-30T23:59:59', body: 'Earth', 'dist-max': '10LD', sort: 'date', limit: '50', neo: 'false' })
	})

	test('sends the filters asked for and nothing else', () => {
		const { searchParams } = new URL(closeApproachesUrl({ ...CATALOG_QUERY, body: 'ALL', distanceMax: 0.05, distanceUnit: 'au', neoOnly: true, phaOnly: true, kind: 'a', hMin: 18, hMax: 0, sort: '-dist', offset: 50 }))
		expect(searchParams.get('neo')).toBe('true')
		expect(searchParams.get('pha')).toBe('true')
		expect(searchParams.get('kind')).toBe('a')
		expect(searchParams.get('h-min')).toBe('18')
		expect(searchParams.get('h-max')).toBe('0')
		expect(searchParams.get('dist-max')).toBe('0.05')
		expect(searchParams.get('sort')).toBe('-dist')
		expect(searchParams.get('limit-from')).toBe('50')
		expect(searchParams.get('body')).toBe('ALL')
	})

	test('never sends the NEO filter for one object, which CAD refuses', () => {
		const { searchParams } = new URL(closeApproachesUrl({ selector: 'spk', spkId: '20099942', dateMin: '2020-01-01', dateMax: '2039-12-31', body: 'ALL', distanceMax: 100, distanceUnit: 'au', sort: 'date', limit: 50, offset: 0 }))
		expect(searchParams.get('spk')).toBe('20099942')
		expect(searchParams.get('dist-max')).toBe('100')
		expect(searchParams.has('neo')).toBeFalse()
	})
})

describe('close approach parser', () => {
	test('reads a row by column name, keeping the published time and dropping the alignment of the name', () => {
		const { total, rows, signature } = parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 13, fields: ALL_BODIES_FIELDS, data: [APOPHIS] })
		expect(signature).toEqual(SIGNATURE)
		expect(total).toBe(13)
		expect(rows).toEqual([
			{
				designation: '99942',
				fullName: '99942 Apophis (2004 MN4)',
				orbitId: '220',
				body: 'Earth',
				jd: '2462240.407091969',
				calendarDate: '2029-Apr-13 21:46',
				distance: 0.000254090910419299,
				distanceMin: 0.000254068999976389,
				distanceMax: 0.000254112821017663,
				relativeVelocity: 7.42253895678452,
				infiniteVelocity: 5.84135589753103,
				timeUncertainty: '< 00:01',
				absoluteMagnitude: 19.09,
				diameter: 0.34,
				diameterSigma: 0.04,
			},
		])
	})

	test('the order of the columns does not matter', () => {
		const order = ALL_BODIES_FIELDS.map((_, index) => index).toReversed()
		const page = parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 1, fields: order.map((index) => ALL_BODIES_FIELDS[index]), data: [order.map((index) => APOPHIS[index])] })
		expect(page).toEqual(parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 1, fields: ALL_BODIES_FIELDS, data: [APOPHIS] }))
	})

	test('a value CAD does not publish is absent, never zero', () => {
		const [row] = parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 186, fields: COMET_FIELDS, data: [COMET] }).rows
		expect(row.designation).toBe('323P')
		expect(row.absoluteMagnitude).toBeUndefined()
		expect(row.diameter).toBeUndefined()
		expect(row.body).toBeUndefined()
		expect(row.fullName).toBeUndefined()
	})

	test('a page past the end has no table and keeps the total', () => {
		expect(parseCloseApproaches({ signature: SIGNATURE, count: 0, total: 53 })).toEqual({ signature: SIGNATURE, total: 53, rows: [] })
		expect(parseCloseApproaches({ signature: SIGNATURE, count: 0, total: 0 }).rows).toBeEmpty()
	})

	test('accepts a new minor version and refuses another major one', () => {
		expect(parseCloseApproaches({ signature: { ...SIGNATURE, version: '1.9' }, count: 0, total: 0 }).total).toBe(0)
		expect(() => parseCloseApproaches({ signature: { ...SIGNATURE, version: '2.0' }, count: 0, total: 0 })).toThrow(expect.objectContaining({ kind: 'unsupportedVersion', version: '2.0' }))
		expect(() => assertSupportedSignature(undefined)).toThrow(SmallBodyResponseError)
	})

	test('refuses a table it cannot trust', () => {
		const malformed = expect.objectContaining({ kind: 'malformed' })
		expect(() => parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 1, fields: ALL_BODIES_FIELDS.slice(1), data: [APOPHIS.slice(1)] })).toThrow(malformed)
		expect(() => parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 1, fields: ALL_BODIES_FIELDS, data: [APOPHIS.slice(1)] })).toThrow(malformed)
		expect(() => parseCloseApproaches({ signature: SIGNATURE, count: 1, total: 1, fields: ALL_BODIES_FIELDS, data: [APOPHIS.with(4, 'n/a')] })).toThrow(malformed)
	})
})

describe.skipIf(SKIP)('search', () => {
	test('single record', async () => {
		const data = await search('C/2017 K2')

		if ('object' in data) {
			expect(data.object.orbit_id).not.toBeEmpty()
			expect(data.object.orbit_class.code).toBe('HYP')
			expect(data.object.orbit_class.name).toBe('Hyperbolic Comet')
			expect(data.object.neo).toBeFalse()
			expect(data.object.pha).toBeFalse()
			expect(data.object.des_alt).toBeEmpty()
			expect(data.object.kind).toBe('cu')
			expect(data.object.fullname).toBe('C/2017 K2 (PANSTARRS)')
			expect(data.object.prefix).toBe('C')
			expect(data.object.des).toBe('2017 K2')
			expect(data.object.spkid).toBe('1003517')
			expect(data.orbit.first_obs).toBe('2013-05-12')
			expect(data.orbit.pe_used).toBe('DE441')
			expect(data.orbit.equinox).toBe('J2000')
			expect(data.orbit.cov_epoch).not.toBeEmpty()
			expect(data.orbit.last_obs).not.toBeEmpty()
			expect(data.orbit.soln_date).not.toBeEmpty()
			expect(data.orbit.n_del_obs_used).toBeNull()
			expect(data.orbit.t_jup).toBe('0.170')
			expect(data.orbit.epoch).not.toBeEmpty()
			expect(data.orbit.comment).toBeNull()
			expect(data.orbit.rms).not.toBeEmpty()
			expect(data.orbit.n_dop_obs_used).toBeNull()
			expect(data.orbit.orbit_id).not.toBeEmpty()
			expect(data.orbit.moid_jup).not.toBeEmpty()
			expect(data.orbit.n_obs_used).toBeGreaterThan(2596)
			expect(data.orbit.not_valid_after).toBeNull()
			expect(data.orbit.data_arc).not.toBeEmpty()
			expect(data.orbit.producer).toBe('Otto Matic')
			expect(data.orbit.moid).not.toBeEmpty()
			expect(data.orbit.sb_used).toBe('SB441-N16')
			expect(data.orbit.source).toBe('JPL')
			expect(data.orbit.epoch_cd).not.toBeEmpty()
			expect(data.orbit.elements).toHaveLength(12)
			expect(data.orbit.elements[0].value).not.toBeEmpty()
			expect(data.orbit.elements[0].title).toBe('eccentricity')
			expect(data.orbit.elements[0].label).toBe('e')
			expect(data.orbit.elements[0].sigma).not.toBeEmpty()
			expect(data.orbit.elements[0].units).toBeNull()
			expect(data.orbit.elements[0].name).toBe('e')
			const elementNames = data.orbit.elements.map((element) => element.name)
			expect(elementNames).toContain('tp_cd')
			expect(elementNames).toContain('ad')
			expect(elementNames).not.toContain('cd_tp')
			expect(elementNames).not.toContain('a_D')
			expect(data.phys_par).toHaveLength(2)
			expect(data.phys_par[0].desc).toBe('absolute magnitude of comet and coma (i.e. total)')
			expect(data.phys_par[0].value).toBe('8.5')
			expect(data.phys_par[0].notes).not.toBeEmpty()
			expect(data.phys_par[0].ref).not.toBeEmpty()
			expect(data.phys_par[0].title).toBe('comet total magnitude')
			expect(data.phys_par[0].sigma).toBe('0.7')
			expect(data.phys_par[0].units).toBeNull()
			expect(data.phys_par[0].name).toBe('M1')
		}
	})

	test('multiple records', async () => {
		const data = await search('PANSTARRS')

		if ('list' in data) {
			expect(data.list.length).toBeGreaterThanOrEqual(319)
			expect(data.list[0].pdes).toBe('253P')
			expect(data.list[0].name).toBe('253P/PANSTARRS')
			expect(data.message).toBe('specified query matched more than one object')
		}
	})

	test('alternate designations', async () => {
		const data = await search('Eros')
		expect('object' in data).toBeTrue()

		if ('object' in data) {
			expect(data.object.prefix).toBeNull()
			expect(data.object.des_alt[0].des).toBe('1956 PC')
			expect(data.object.des_alt[1].pri).toBe('A898 PA')
		}
	})

	test('failed', async () => {
		const data = await search('ggdgdfgdfgdg')

		if ('message' in data) {
			expect(data.message).toBe('specified object was not found')
		}
	})
})

describe.skip('identify', () => {
	test('ceres', async () => {
		const date = temporalFromDate(2023, 8, 21, 0, 0, 0)
		const response = await identify(date, deg(-45.5), deg(-22.5), kilometer(1.81754), parseAngle('13h 21 16.50')!, parseAngle('-01 57 06.5')!)

		expect('fields_second' in response).toBeTrue()

		if ('fields_second' in response) {
			expect(response.fields_second).toEqual(['Object name', 'Astrometric RA (hh:mm:ss)', 'Astrometric Dec (dd mm\'ss")', 'Dist. from center RA (")', 'Dist. from center Dec (")', 'Dist. from center Norm (")', 'Visual magnitude (V)', 'RA rate ("/h)', 'Dec rate ("/h)'])
			expect(response.data_second_pass[0][0]).toBe('1 Ceres (A801 AA)')
		}
	}, 60000)

	test('no records', async () => {
		const date = temporalFromDate(2023, 1, 15, 1, 38, 15)
		const response = await identify(date, deg(-45.5), deg(-22.5), kilometer(1.81754), parseAngle('10h 44 02')!, parseAngle('-59 36 04')!)
		expect('n_first_pass' in response).toBeFalse()
		expect('n_second_pass' in response).toBeFalse()
	}, 60000)
})

describe.skipIf(SKIP)('close approaches', () => {
	test('from now to 7 days', async () => {
		const response = await closeApproaches('now', '7d', 10)
		expect(response.count).toBeGreaterThan(0)
		expect(response.fields).toHaveLength(14)
		expect(response.data.length).toBeGreaterThan(0)
	})

	test('from date to date', async () => {
		const from = temporalFromDate(2024, 3, 13)
		const to = temporalFromDate(2024, 3, 20)
		const response = await closeApproaches(from, to, 10)
		// const asteroids = ['2021 GQ5', '2024 GT2', '2023 FN13', '2024 HX', '2024 HB', '2024 HE', '2024 GO1', '2024 JJ', '2024 HZ', '2024 GF5', '2024 GJ6', '2021 JW2', '2024 HQ', '2024 HL']
		expect(response.count).toBeGreaterThanOrEqual(0)
		expect(response.fields).toHaveLength(14)
		expect(response.data.length).toBeGreaterThanOrEqual(0)
		// expect(response.data.map((e) => e[0])).toContainValues(asteroids)
	})

	test('every approach of one object, paged, with the last day whole', async () => {
		const response = await fetch(closeApproachesUrl({ selector: 'spk', spkId: '20099942', dateMin: '2029-04-13', dateMax: '2029-04-13', body: 'ALL', distanceMax: 100, distanceUnit: 'au', sort: 'date', limit: 1, offset: 0 }))
		const page = parseCloseApproaches(await response.json())
		expect(page.total).toBe(1)
		expect(page.rows[0].fullName).toBe('99942 Apophis (2004 MN4)')
		expect(page.rows[0].body).toBe('Earth')
	})
})
