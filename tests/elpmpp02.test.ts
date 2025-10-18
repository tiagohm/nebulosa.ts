import { expect, test } from 'bun:test'
import { moon } from '../src/elpmpp02'
import { vector } from '../src/horizons'
import { Timescale, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

test('moon', () => {
	const [p, v] = moon(TIME)

	expect(p[0]).toBeCloseTo(-5.283386082647222e-4, 8)
	expect(p[1]).toBeCloseTo(-2.315249555840687e-3, 8)
	expect(p[2]).toBeCloseTo(-1.272538157128253e-3, 8)
	expect(v[0]).toBeCloseTo(5.523452472098514e-4, 10)
	expect(v[1]).toBeCloseTo(-8.755019244854736e-5, 9)
	expect(v[2]).toBeCloseTo(-3.552982910277432e-5, 9)
})

test.skip('horizons', async () => {
	const v = await vector('301', '500@399', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 8)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 10)`)
	}
})
