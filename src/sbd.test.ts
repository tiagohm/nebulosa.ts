import { describe, expect, test } from 'bun:test'
import { search } from './sbd'

describe('search', () => {
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
