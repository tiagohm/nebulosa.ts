import { expect, test } from 'bun:test'
import { normalizeIauMeteorShowerCatalog, parseIauMeteorShowerCatalog } from '../../../src/adapters/catalogs/iau.meteor.showers'
import { meteorRadiantPathBetween } from '../../../src/astronomy/meteors/radiant'
import { meteorSolarLongitude, timeAtMeteorSolarLongitude } from '../../../src/astronomy/meteors/solar'
import { meteorShowerState } from '../../../src/astronomy/meteors/state'
import { timeShift } from '../../../src/astronomy/time/time'
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
					{
						AdNo: '001',
						activity: 'annual',
						LoS: null,
						Ra: 12,
						De: null,
						q: 0.91,
						e: 0.72,
						Ote: 'RAD',
					},
					{ AdNo: '002', activity: '2022', LoSb: 100, LoSe: 150, LoS: 120, Ra: 40, De: 50 },
					{ AdNo: '003', activity: '1989out', LoSb: 100, LoSe: 150, LoS: 120, Ra: 40, De: 50 },
				],
			},
		],
	})
	const shower = normalizeIauMeteorShowerCatalog(catalog).showers[0]
	const solution = shower.solutions[0]

	expect(solution.status).toBe('removed')
	expect(solution.sourceStatus).toBe(-2)
	expect(solution.activity).toEqual({ kind: 'yearSpecific', source: '1989/12', year: 1989 })
	expect(toDeg(solution.rightAscension!)).toBeCloseTo(359, 12)
	expect(toDeg(solution.activityInterval!.start)).toBeCloseTo(350, 12)
	expect(toDeg(solution.activityInterval!.end)).toBeCloseTo(20, 12)
	expect(toKilometerPerSecond(solution.geocentricSpeed!)).toBeCloseTo(20, 12)
	expect(solution.orbit).toEqual({ semiMajorAxis: undefined, perihelionDistance: undefined, eccentricity: undefined, argumentOfPerihelion: undefined, longitudeOfAscendingNode: undefined, inclination: expect.any(Number) })
	expect(solution.reference).toBe('<A>reference</A>')
	expect(shower.code).toBe('TST')
	expect(shower.provisionalName).toBe('M2026-X1')
	expect(shower.solutions).toHaveLength(4)
	expect(shower.solutions[1].activity).toEqual({ kind: 'annual', source: 'annual', year: undefined })
	expect(shower.solutions[1].declination).toBeUndefined()
	expect(shower.solutions[1].referenceSolarLongitude).toBeUndefined()
	expect(shower.solutions[1].radiantDrift).toBeUndefined()
	expect(shower.solutions[1].orbit).toEqual({ semiMajorAxis: undefined, perihelionDistance: 0.91, eccentricity: 0.72, argumentOfPerihelion: undefined, longitudeOfAscendingNode: undefined, inclination: undefined })
	expect(shower.solutions[1].observationTechnique).toBe('radar')
	expect(shower.solutions[1].parentBody).toBeUndefined()
	expect(shower.solutions[2].activity).toEqual({ kind: 'yearSpecific', source: '2022', year: 2022 })
	expect(shower.solutions[3].activity).toEqual({ kind: 'outburst', source: '1989out', year: 1989 })
})

test('rejects an unversioned array root', () => {
	expect(() => parseIauMeteorShowerCatalog([])).toThrow('versioned object')
})

test('normalized IAU bounds and daily drift feed time paths and tri-state shower state', () => {
	const catalog = parseIauMeteorShowerCatalog({
		source: 'IAU Meteor Data Center',
		version: 'integration-fixture',
		count: 1,
		fields: {},
		data: [
			{
				IAUNo: '7',
				Code: 'PER',
				Name: 'Perseids-like fixture',
				solution: [{ AdNo: '000', activity: '2022', LoSb: 110, LoSe: 160, LoS: 140, Ra: 48, De: 58, dRa: 1.4, dDe: 0.25, Vg: 59 }],
			},
		],
	})
	const solution = normalizeIauMeteorShowerCatalog(catalog).showers[0].solutions[0]
	expect(solution.radiantDrift?.basis).toBe('day')
	const start = timeAtMeteorSolarLongitude(2022, solution.referenceSolarLongitude!, { step: 7 })
	const end = timeShift(start, 2)
	const path = meteorRadiantPathBetween(solution, start, end, { step: 1, solarLongitudeSearch: { step: 7 } })

	expect(path).toHaveLength(3)
	expect(path[1].rightAscension).toBeGreaterThan(path[0].rightAscension)
	expect(path[1].declination).toBeGreaterThan(path[0].declination)
	const context = { time: start, solarLongitude: meteorSolarLongitude(start) }
	const options = { includeHorizontal: false, includeMoon: false, includeRadiantOfDate: false, includeSun: false } as const
	expect(meteorShowerState(solution, context, options).active).toBe(true)
	expect(meteorShowerState({ ...solution, activityInterval: undefined }, context, options).active).toBeUndefined()
	const future = timeAtMeteorSolarLongitude(2026, solution.referenceSolarLongitude!, { step: 7 })
	expect(meteorShowerState(solution, { time: future, solarLongitude: meteorSolarLongitude(future) }, options).active).toBe(false)
})
