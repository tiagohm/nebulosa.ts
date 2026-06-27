import { expect, test } from 'bun:test'
import { fk5, fk5ToIcrs, precessFk5, precessFk5FromJ2000, precessFk5ToJ2000 } from '../../../src/astronomy/coordinates/fk5'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ONE_KILOPARSEC } from '../../../src/core/constants'
import { type MutVec3, vecLength } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'

test('fk5', () => {
	const p = fk5(deg(10.625), deg(41.2), 1)
	expect(p[0]).toBeCloseTo(0.7395147490115556, 15)
	expect(p[1]).toBeCloseTo(0.13873042608936675, 15)
	expect(p[2]).toBeCloseTo(0.6586894601186805, 15)
})

test('fk5 from J2000 to J1975', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = precessFk5FromJ2000(fk5(deg(10.625), deg(41.2), 1), e)
	expect(p[0]).toBeCloseTo(0.741876533627981227, 15)
	expect(p[1]).toBeCloseTo(0.134590258744592489, 15)
	expect(p[2]).toBeCloseTo(0.65689015147374108, 15)
})

test('fk5 from J1975 to J2000', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = precessFk5ToJ2000(fk5(deg(10.625), deg(41.2), 1), e)
	expect(p[0]).toBeCloseTo(0.737125495970369249, 15)
	expect(p[1]).toBeCloseTo(0.14285731543506594, 15)
	expect(p[2]).toBeCloseTo(0.660482997977331121, 15)
})

test('fk5 to icrs', () => {
	const p = fk5ToIcrs(fk5(deg(10.625), deg(41.2), 1))
	expect(p[0]).toBeCloseTo(0.739514793473810439, 15)
	expect(p[1]).toBeCloseTo(0.138730280437718595, 15)
	expect(p[2]).toBeCloseTo(0.658689440877155308, 15)
})

test('fk5 J1975 to icrs', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = fk5ToIcrs(precessFk5ToJ2000(fk5(deg(10.625), deg(41.2), 1), e))
	expect(p[0]).toBeCloseTo(0.73712554096992855, 15)
	expect(p[1]).toBeCloseTo(0.142857169875641316, 15)
	expect(p[2]).toBeCloseTo(0.660482979239368717, 15)
})

test('fk5 defaults to a one-kiloparsec distance', () => {
	const p = fk5(deg(10.625), deg(41.2))
	expect(vecLength(p)).toBeCloseTo(ONE_KILOPARSEC, 8)
})

test('precessing to and from J2000 round-trips', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const original = fk5(deg(10.625), deg(41.2), 1)
	const there = precessFk5FromJ2000(original, e)
	const back = precessFk5ToJ2000(there, e)

	expect(back[0]).toBeCloseTo(original[0], 14)
	expect(back[1]).toBeCloseTo(original[1], 14)
	expect(back[2]).toBeCloseTo(original[2], 14)
})

test('precessFk5 matches the J2000 convenience wrappers', () => {
	const from = timeYMDHMS(2000, 1, 1, 12, 0, 0, Timescale.TT)
	const to = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = fk5(deg(10.625), deg(41.2), 1)
	const general = precessFk5(p, from, to)
	const wrapper = precessFk5FromJ2000(p, to)

	expect(general[0]).toBeCloseTo(wrapper[0], 15)
	expect(general[1]).toBeCloseTo(wrapper[1], 15)
	expect(general[2]).toBeCloseTo(wrapper[2], 15)
})

test('precessFk5 writes into and returns the provided output vector', () => {
	const e = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)
	const p = fk5(deg(10.625), deg(41.2), 1)
	const out: MutVec3 = [0, 0, 0]
	const result = precessFk5FromJ2000(p, e, out)

	expect(result).toBe(out)
	expect(out[0]).toBeCloseTo(0.741876533627981227, 15)
	expect(out[1]).toBeCloseTo(0.134590258744592489, 15)
	expect(out[2]).toBeCloseTo(0.65689015147374108, 15)
})
