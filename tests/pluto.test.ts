import { expect, test } from 'bun:test'
import { vector } from '../src/horizons'
import { pluto } from '../src/pluto'
import { Timescale, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TDB)

test('pluto', () => {
	const p = pluto(TIME)

	expect(p[0]).toBeCloseTo(1.897082455989403e1, 3)
	expect(p[1]).toBeCloseTo(-2.637625218763833e1, 3)
	expect(p[2]).toBeCloseTo(-1.394557188546127e1, 3)
})

test.skip('horizons', async () => {
	const v = await vector('901', '500@10', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 3)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 3)`)
	}
})
