import { expect, test } from 'bun:test'
import { normalizeIauMeteorShowerCatalog, parseIauMeteorShowerCatalog } from '../../../src/adapters/catalogs/iau.meteor.showers'
import { toDeg } from '../../../src/math/units/angle'
import { toKilometerPerSecond } from '../../../src/math/units/velocity'

test('normalizes the versioned IAU shower object without inventing activity data', () => {
	const catalog = parseIauMeteorShowerCatalog({
		source: 'IAU Meteor Data Center',
		version: 'test',
		count: 1,
		fields: {},
		data: [
			{
				LP: '02584',
				IAUNo: '1',
				Code: 'TST',
				s: '-5',
				Name: 'Test shower',
				ProvName: 'M2026-X1',
				solution: [
					{
						AdNo: '000',
						'sub.date': '2026.01.01',
						s: '-2',
						activity: '1989/12',
						LoSb: 350,
						LoSe: 20,
						LoS: 5,
						Ra: 359,
						De: -20,
						dRa: 0.5,
						dDe: -0.25,
						Vg: 20,
						inc: 5,
						'Parent body': 'Test parent',
						References: [null, '<A>reference</A>'],
					},
				],
			},
		],
	})
	const solution = normalizeIauMeteorShowerCatalog(catalog).showers[0].solutions[0]

	expect(solution.status).toBe('removed')
	expect(solution.sourceStatus).toBe(-2)
	expect(solution.activity).toEqual({ kind: 'yearSpecific', source: '1989/12', year: 1989 })
	expect(toDeg(solution.rightAscension!)).toBeCloseTo(359, 12)
	expect(toDeg(solution.activityInterval!.start)).toBeCloseTo(350, 12)
	expect(toDeg(solution.activityInterval!.end)).toBeCloseTo(20, 12)
	expect(toKilometerPerSecond(solution.geocentricSpeed!)).toBeCloseTo(20, 12)
	expect(solution.orbit).toEqual({ semiMajorAxis: undefined, perihelionDistance: undefined, eccentricity: undefined, argumentOfPerihelion: undefined, longitudeOfAscendingNode: undefined, inclination: expect.any(Number) })
	expect(solution.reference).toBe('<A>reference</A>')
})

test('rejects an unversioned array root', () => {
	expect(() => parseIauMeteorShowerCatalog([])).toThrow('versioned object')
})
