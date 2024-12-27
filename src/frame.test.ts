import { expect, test } from 'bun:test'
import { FK5_FRAME, fk5Frame, precessionMatrixCapitaine } from './frame'
import { mulVec } from './matrix'
import { timeJulian, Timescale, timeYMDHMS } from './time'
import type { MutVec3 } from './vector'

const j2000 = timeJulian(2000)

test('precessionMatrixCapitaine', () => {
	const a = timeYMDHMS(2014, 10, 7, 12, 0, 0, Timescale.TT)
	const b = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	const m = precessionMatrixCapitaine(a, b)
	expect(m[0]).toBeCloseTo(0.999998929426458516, 15)
	expect(m[1]).toBeCloseTo(-0.001342072558891505, 15)
	expect(m[2]).toBeCloseTo(-0.000583084198765054, 15)
	expect(m[3]).toBeCloseTo(0.001342072563259706, 15)
	expect(m[4]).toBeCloseTo(0.999999099420138315, 15)
	expect(m[5]).toBeCloseTo(-0.000000383779316465, 15)
	expect(m[6]).toBeCloseTo(0.000583084188710855, 15)
	expect(m[7]).toBeCloseTo(-0.000000398762399648, 15)
	expect(m[8]).toBeCloseTo(0.999999830006320645, 15)
})

test('fk5', () => {
	const v: MutVec3 = [0.739514749011555561, 0.138730426089366754, 0.658689460118680459]
	mulVec(FK5_FRAME.rotationAt(j2000), v, v)
	expect(v[0]).toBeCloseTo(0.739514704549283364, 15)
	expect(v[1]).toBeCloseTo(0.138730571741011777, 15)
	expect(v[2]).toBeCloseTo(0.658689479360190067, 15)
})

test('fk5 J1975', () => {
	const v: MutVec3 = [0.739514749011555561, 0.138730426089366754, 0.658689460118680459]
	const t = timeJulian(1975, Timescale.TT)
	mulVec(fk5Frame(t).rotationAt(j2000), v, v)
	expect(v[0]).toBeCloseTo(0.741876554315267677, 15)
	expect(v[1]).toBeCloseTo(0.134590291115837146, 15)
	expect(v[2]).toBeCloseTo(0.656890121477450628, 15)
})
