import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { fk5, fk5ToIcrs, precessFk5FromJ2000, precessFk5ToJ2000 } from '../src/fk5'
import { Timescale, timeYMDHMS } from '../src/time'

test('fk5', () => {
	const p = fk5(deg(10.625), deg(41.2), 1)
	expect(p[0]).toBeCloseTo(0.7395147490115556, 15)
	expect(p[1]).toBeCloseTo(0.13873042608936675, 15)
	expect(p[2]).toBeCloseTo(0.6586894601186805, 15)
})

test('fk5FromJ2000ToJ1975', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = precessFk5FromJ2000(fk5(deg(10.625), deg(41.2), 1), e)
	expect(p[0]).toBeCloseTo(0.741876533627981227, 15)
	expect(p[1]).toBeCloseTo(0.134590258744592489, 15)
	expect(p[2]).toBeCloseTo(0.65689015147374108, 15)
})

test('fk5FromJ1975ToJ2000', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = precessFk5ToJ2000(fk5(deg(10.625), deg(41.2), 1), e)
	expect(p[0]).toBeCloseTo(0.737125495970369249, 15)
	expect(p[1]).toBeCloseTo(0.14285731543506594, 15)
	expect(p[2]).toBeCloseTo(0.660482997977331121, 15)
})

test('fk5ToIcrs', () => {
	const p = fk5ToIcrs(fk5(deg(10.625), deg(41.2), 1))
	expect(p[0]).toBeCloseTo(0.739514793473810439, 15)
	expect(p[1]).toBeCloseTo(0.138730280437718595, 15)
	expect(p[2]).toBeCloseTo(0.658689440877155308, 15)
})

test('fk5J1975ToIcrs', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = fk5ToIcrs(precessFk5ToJ2000(fk5(deg(10.625), deg(41.2), 1), e))
	expect(p[0]).toBeCloseTo(0.73712554096992855, 15)
	expect(p[1]).toBeCloseTo(0.142857169875641316, 15)
	expect(p[2]).toBeCloseTo(0.660482979239368717, 15)
})
