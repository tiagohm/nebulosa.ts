import { describe, expect, test } from 'bun:test'
import { deg, parseAngle } from './angle'
import { dateFrom, dateYMDHMS } from './datetime'
import { kilometer } from './distance'
import { closeApproaches, identify, search } from './sbd'

describe.skip('search', () => {
	test('singleRecord', async () => {
		const data = await search('C/2017 K2')

		if ('object' in data) {
			expect(data.object.orbit_id).toBe('151')
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
			expect(data.orbit.cov_epoch).toBe('2459388.5')
			expect(data.orbit.last_obs).toBe('2025-01-13')
			expect(data.orbit.soln_date).toBe('2025-01-14 17:42:12')
			expect(data.orbit.n_del_obs_used).toBeNull()
			expect(data.orbit.t_jup).toBe('0.170')
			expect(data.orbit.epoch).toBe('2459388.5')
			expect(data.orbit.comment).toBeNull()
			expect(data.orbit.rms).toBe('.53485')
			expect(data.orbit.n_dop_obs_used).toBeNull()
			expect(data.orbit.orbit_id).toBe('151')
			expect(data.orbit.moid_jup).toBe('1.25441')
			expect(data.orbit.n_obs_used).toBe(2596)
			expect(data.orbit.not_valid_after).toBeNull()
			expect(data.orbit.data_arc).toBe('4264')
			expect(data.orbit.producer).toBe('Otto Matic')
			expect(data.orbit.moid).toBe('1.09118')
			expect(data.orbit.sb_used).toBe('SB441-N16')
			expect(data.orbit.source).toBe('JPL')
			expect(data.orbit.epoch_cd).toBe('2021-Jun-23.0')
			expect(data.orbit.elements).toHaveLength(12)
			expect(data.orbit.elements[0].value).toBe('1.000571955192475')
			expect(data.orbit.elements[0].title).toBe('eccentricity')
			expect(data.orbit.elements[0].label).toBe('e')
			expect(data.orbit.elements[0].sigma).toBe('9.506E-7')
			expect(data.orbit.elements[0].units).toBeNull()
			expect(data.orbit.elements[0].name).toBe('e')
			expect(data.phys_par).toHaveLength(2)
			expect(data.phys_par[0].desc).toBe('absolute magnitude of comet and coma (i.e. total)')
			expect(data.phys_par[0].value).toBe('8.5')
			expect(data.phys_par[0].notes).toBe('2 parameter fit from 2212 observations, autocmod 3.0f')
			expect(data.phys_par[0].ref).toBe('151')
			expect(data.phys_par[0].title).toBe('comet total magnitude')
			expect(data.phys_par[0].sigma).toBe('0.8')
			expect(data.phys_par[0].units).toBeNull()
			expect(data.phys_par[0].name).toBe('M1')
		}
	})

	test('multipleRecords', async () => {
		const data = await search('PANSTARRS')

		if ('list' in data) {
			expect(data.list.length).toBeGreaterThanOrEqual(319)
			expect(data.list[0].pdes).toBe('253P')
			expect(data.list[0].name).toBe('253P/PANSTARRS')
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
		const dateTime = dateFrom('2023-08-21T00:00:00Z')
		const response = await identify(dateTime, deg(-45.5), deg(-22.5), kilometer(1.81754), parseAngle('13h 21 16.50')!, parseAngle('-01 57 06.5')!)

		expect('fields_second' in response).toBeTrue()

		if ('fields_second' in response) {
			expect(response.fields_second).toEqual(['Object name', 'Astrometric RA (hh:mm:ss)', 'Astrometric Dec (dd mm\'ss")', 'Dist. from center RA (")', 'Dist. from center Dec (")', 'Dist. from center Norm (")', 'Visual magnitude (V)', 'RA rate ("/h)', 'Dec rate ("/h)'])
			expect(response.data_second_pass[0][0]).toBe('1 Ceres (A801 AA)')
		}
	}, 60000)

	test('noRecords', async () => {
		const dateTime = dateFrom('2023-01-15T01:38:15Z')
		const response = await identify(dateTime, deg(-45.5), deg(-22.5), kilometer(1.81754), parseAngle('10h 44 02')!, parseAngle('-59 36 04')!)
		expect('n_first_pass' in response).toBeFalse()
		expect('n_second_pass' in response).toBeFalse()
	}, 60000)
})

describe.skip('closeApproaches', () => {
	test('fromNowTo7Days', async () => {
		const response = await closeApproaches('now', 7, 10)
		expect(response.count).toBeGreaterThan(0)
		expect(response.fields).toHaveLength(14)
		expect(response.data.length).toBeGreaterThan(0)
	})

	test('fromDateToDate', async () => {
		const from = dateYMDHMS(2024, 3, 13)
		const to = dateYMDHMS(2024, 3, 20)
		const response = await closeApproaches(from, to, 10)
		const asteroids = ['2021 GQ5', '2024 GT2', '2023 FN13', '2024 HX', '2024 HB', '2024 HE', '2024 GO1', '2024 JJ', '2024 HZ', '2024 GF5', '2024 GJ6', '2021 JW2', '2024 HQ', '2024 HL']
		expect(response.count).toBeGreaterThanOrEqual(0)
		expect(response.fields).toHaveLength(14)
		expect(response.data.length).toBeGreaterThanOrEqual(0)
		// expect(response.data.map((e) => e[0])).toContainValues(asteroids)
	})
})
