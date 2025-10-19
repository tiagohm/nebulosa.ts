import { expect, test } from 'bun:test'
import { vector } from '../src/horizons'
import { callisto, europa, ganymede, io } from '../src/l12'
import { Timescale, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

test('io', () => {
	const [p, v] = io(TIME)

	expect(p[0]).toBeCloseTo(-2.823390566477013e-3, 6)
	expect(p[1]).toBeCloseTo(-2.496225953358087e-5, 5)
	expect(p[2]).toBeCloseTo(-5.603701885571625e-5, 5)
	expect(v[0]).toBeCloseTo(2.033152282516508e-4, 5)
	expect(v[1]).toBeCloseTo(-9.022834280383245e-3, 6)
	expect(v[2]).toBeCloseTo(-4.297690211393224e-3, 6)
})

test('europa', () => {
	const [p, v] = europa(TIME)

	expect(p[0]).toBeCloseTo(2.425780242857923e-3, 6)
	expect(p[1]).toBeCloseTo(3.365624416725937e-3, 6)
	expect(p[2]).toBeCloseTo(1.64362509140026e-3, 6)
	expect(v[0]).toBeCloseTo(-6.727103438835267e-3, 6)
	expect(v[1]).toBeCloseTo(3.938049907520507e-3, 6)
	expect(v[2]).toBeCloseTo(1.698058117157359e-3, 5)
})

test('ganymede', () => {
	const [p, v] = ganymede(TIME)

	expect(p[0]).toBeCloseTo(-5.097304459962585e-4, 6)
	expect(p[1]).toBeCloseTo(-6.424969243118112e-3, 6)
	expect(p[2]).toBeCloseTo(-3.090078740204307e-3, 6)
	expect(v[0]).toBeCloseTo(6.274660802379808e-3, 6)
	expect(v[1]).toBeCloseTo(-4.324958058374301e-4, 5)
	expect(v[2]).toBeCloseTo(-1.071055194749395e-4, 5)
})

test('callisto', () => {
	const [p, v] = callisto(TIME)

	expect(p[0]).toBeCloseTo(-1.09593616464953e-2, 5)
	expect(p[1]).toBeCloseTo(-5.688649555227991e-3, 5)
	expect(p[2]).toBeCloseTo(-2.843855912995549e-3, 6)
	expect(v[0]).toBeCloseTo(2.372092834287197e-3, 5)
	expect(v[1]).toBeCloseTo(-3.690899745321731e-3, 5)
	expect(v[2]).toBeCloseTo(-1.70396540376535e-3, 6)
})

test.skip('horizons', async () => {
	const v = await vector('504', '500@599', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 6)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 6)`)
	}
})
