import { expect, test } from 'bun:test'
import { vector } from '../src/horizons'
import { deimos, phobos } from '../src/marssat'
import { Timescale, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

test('phobos', () => {
	const [p, v] = phobos(TIME)

	expect(p[0]).toBeCloseTo(-3.82910942172268e-5, 6)
	expect(p[1]).toBeCloseTo(3.065636702485076e-5, 6)
	expect(p[2]).toBeCloseTo(3.833086497253128e-5, 6)
	expect(v[0]).toBeCloseTo(-7.83678289321317e-4, 6)
	expect(v[1]).toBeCloseTo(-9.639456997298313e-4, 6)
	expect(v[2]).toBeCloseTo(-3.925176295238564e-5, 6)
})

test('deimos', () => {
	const [p, v] = deimos(TIME)

	expect(p[0]).toBeCloseTo(-5.327641535720459e-5, 6)
	expect(p[1]).toBeCloseTo(1.183014215884249e-4, 6)
	expect(p[2]).toBeCloseTo(8.798174327921323e-5, 6)
	expect(v[0]).toBeCloseTo(-6.626857223616553e-4, 6)
	expect(v[1]).toBeCloseTo(-3.926396895918225e-4, 6)
	expect(v[2]).toBeCloseTo(1.267119635052233e-4, 6)
})

test.skip('horizons', async () => {
	const v = await vector('402', '500@499', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 6)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 6)`)
	}
})
