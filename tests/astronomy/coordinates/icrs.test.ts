import { expect, test } from 'bun:test'
import { fk5ToIcrs, precessFk5FromJ2000 } from '../../../src/astronomy/coordinates/fk5'
import { icrs, icrsToFk5 } from '../../../src/astronomy/coordinates/icrs'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ONE_KILOPARSEC } from '../../../src/core/constants'
import { vecLength } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'

test('icrs', () => {
	const p = icrs(deg(10.625), deg(41.2), 1)
	expect(p[0]).toBeCloseTo(0.7395147490115556, 15)
	expect(p[1]).toBeCloseTo(0.13873042608936675, 15)
	expect(p[2]).toBeCloseTo(0.6586894601186805, 15)
})

test('icrs to fk5', () => {
	const p = icrsToFk5(icrs(deg(10.625), deg(41.2), 1))
	expect(p[0]).toBeCloseTo(0.739514704549283364, 15)
	expect(p[1]).toBeCloseTo(0.138730571741011777, 15)
	expect(p[2]).toBeCloseTo(0.658689479360190067, 15)
})

test('icrs defaults to a one-kiloparsec distance', () => {
	const p = icrs(deg(10.625), deg(41.2))
	expect(vecLength(p)).toBeCloseTo(ONE_KILOPARSEC, 8)
})

test('icrs to fk5 and back round-trips', () => {
	const original = icrs(deg(10.625), deg(41.2), 1)
	const back = fk5ToIcrs(icrsToFk5(original))

	expect(back[0]).toBeCloseTo(original[0], 15)
	expect(back[1]).toBeCloseTo(original[1], 15)
	expect(back[2]).toBeCloseTo(original[2], 15)
})

test('icrs to fk5 J1975', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = precessFk5FromJ2000(icrsToFk5(icrs(deg(10.625), deg(41.2), 1)), e)
	expect(p[0]).toBeCloseTo(0.741876490027394198, 15)
	expect(p[1]).toBeCloseTo(0.134590404642352307, 15)
	expect(p[2]).toBeCloseTo(0.656890170822217012, 15)
})
