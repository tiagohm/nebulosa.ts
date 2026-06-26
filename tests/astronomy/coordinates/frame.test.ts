import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { ecliptic, eclipticJ2000, galactic, itrfToTeme, itrfToTemeByGmst, precessionMatrixCapitaine, supergalactic, temeToItrf, temeToItrfByGmst } from '../../../src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ANGVEL_PER_DAY } from '../../../src/core/constants'
import { matMul, matRotX, matRotZ } from '../../../src/math/linear-algebra/mat3'
import type { Vec3 } from '../../../src/math/linear-algebra/vec3'
import { formatAZ, normalizeAngle, parseAngle } from '../../../src/math/units/angle'

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

test('teme<->itrf position round trip without polar motion', () => {
	const p: Vec3 = [4123, -5234, 3045]
	const back = itrfToTemeByGmst(temeToItrfByGmst(p, 1.7), 1.7)

	expect(back[0]).toBeCloseTo(p[0], 9)
	expect(back[1]).toBeCloseTo(p[1], 9)
	expect(back[2]).toBeCloseTo(p[2], 9)
})

test('teme<->itrf state round trip with polar motion', () => {
	// Any proper rotation works as a stand-in polar-motion matrix because the inverse uses its transpose.
	const polarMotion = matMul(matRotX(1.5e-6), matRotZ(2e-6))
	const pv: PositionAndVelocity = [
		[4123, -5234, 3045],
		[2.1, 3.4, -1.2],
	]
	const back = itrfToTemeByGmst(temeToItrfByGmst(pv, 2.3, polarMotion), 2.3, polarMotion)

	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(pv[0][i], 9)
		expect(back[1][i]).toBeCloseTo(pv[1][i], 9)
	}
})

test('teme to itrf adds the earth-rotation velocity term', () => {
	// With zero TEME velocity the ITRF velocity is purely the rotating-frame term (dR/dt R^T) r = -(omega x r).
	const state: PositionAndVelocity = [
		[7000, 1000, -2000],
		[0, 0, 0],
	]
	const [pPef, vPef] = temeToItrfByGmst(state, 1.234)

	expect(vPef[0]).toBeCloseTo(ANGVEL_PER_DAY * pPef[1], 9)
	expect(vPef[1]).toBeCloseTo(-ANGVEL_PER_DAY * pPef[0], 9)
	expect(vPef[2]).toBeCloseTo(0, 12)
})

test('teme<->itrf state round trip through time with earth rotation', () => {
	const pv: PositionAndVelocity = [
		[4123, -5234, 3045],
		[2.1, 3.4, -1.2],
	]
	const back = itrfToTeme(temeToItrf(pv, TIME, false), TIME, false)

	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(pv[0][i], 9)
		expect(back[1][i]).toBeCloseTo(pv[1][i], 9)
	}
})
