import { expect, test } from 'bun:test'
import { precessionMatrixCapitaine } from '../src/frame'
import { Timescale, timeYMDHMS } from '../src/time'

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
