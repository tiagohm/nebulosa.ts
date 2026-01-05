import { expect, test } from 'bun:test'
import { formatAZ, normalizeAngle, parseAngle } from '../src/angle'
import { eraC2s, eraS2c } from '../src/erfa'
import { ecliptic, eclipticJ2000, galactic, precessionMatrixCapitaine, supergalactic } from '../src/frame'
import { Timescale, timeYMDHMS } from '../src/time'

test('precession matrix capitaine', () => {
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

const RA = parseAngle('14h 39 20.75')!
const DEC = parseAngle('-60 49 57.9')!
const XYZ = eraS2c(RA, DEC)
const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC)

test('galactic', () => {
	const [lng, lat] = eraC2s(...galactic(XYZ))

	expect(formatAZ(normalizeAngle(lng))).toBe('315 42 19.55')
	expect(formatAZ(lat)).toBe('-000 39 56.15')
})

test('supergalactic', () => {
	const [lng, lat] = eraC2s(...supergalactic(XYZ))

	expect(formatAZ(normalizeAngle(lng))).toBe('180 28 42.82')
	expect(formatAZ(lat)).toBe('-001 43 39.50')
})

test('ecliptic J2000', () => {
	const [lng, lat] = eraC2s(...eclipticJ2000(XYZ))

	expect(formatAZ(normalizeAngle(lng))).toBe('239 26 20.75')
	expect(formatAZ(lat)).toBe('-042 36 23.32')
})

test('ecliptic', () => {
	const [lng, lat] = eraC2s(...ecliptic(XYZ, TIME))

	expect(formatAZ(normalizeAngle(lng))).toBe('239 47 53.71')
	expect(formatAZ(lat)).toBe('-042 36 34.23')
})
