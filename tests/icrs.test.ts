import { expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { precessFk5FromJ2000 } from '../src/fk5'
import { icrs, icrsToFk5 } from '../src/icrs'
import { Timescale, timeYMDHMS } from '../src/time'

test('icrs', () => {
	const p = icrs(deg(10.625), deg(41.2), 1)
	expect(p[0]).toBeCloseTo(0.7395147490115556, 15)
	expect(p[1]).toBeCloseTo(0.13873042608936675, 15)
	expect(p[2]).toBeCloseTo(0.6586894601186805, 15)
})

test('icrsToFk5', () => {
	const p = icrsToFk5(icrs(deg(10.625), deg(41.2), 1))
	expect(p[0]).toBeCloseTo(0.739514704549283364, 15)
	expect(p[1]).toBeCloseTo(0.138730571741011777, 15)
	expect(p[2]).toBeCloseTo(0.658689479360190067, 15)
})

test('icrsToFk5J1975', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = precessFk5FromJ2000(icrsToFk5(icrs(deg(10.625), deg(41.2), 1)), e)
	expect(p[0]).toBeCloseTo(0.741876490027394198, 15)
	expect(p[1]).toBeCloseTo(0.134590404642352307, 15)
	expect(p[2]).toBeCloseTo(0.656890170822217012, 15)
})
