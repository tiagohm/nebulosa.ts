import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
// oxfmt-ignore
import { CIRS, ecliptic, ECLIPTIC_J2000, eclipticJ2000, frameAt, frameToBase, frameToFrame, GALACTIC, galactic, ICRS, ITRS, itrfToTeme, itrfToTemeByGmst, MEAN_EQUATOR_AND_EQUINOX_OF_DATE, precessionMatrixCapitaine, supergalactic, temeToItrf, temeToItrfByGmst, TIRS, TRUE_EQUATOR_AND_EQUINOX_OF_DATE } from '../../../src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ANGVEL_PER_DAY } from '../../../src/core/constants'
import { type Mat3, matMul, matMulTranspose, matRotX, matRotZ } from '../../../src/math/linear-algebra/mat3'
import type { MutVec3, Vec3 } from '../../../src/math/linear-algebra/vec3'
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

test('precession matrix is identity for the same epoch', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	expect(precessionMatrixCapitaine(t, t)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
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

test('galactic transforms a state by rotating both position and velocity', () => {
	// A constant-rotation frame has no rotating-frame term, so position and velocity
	// rotate by the same matrix; the state path must agree with the vector path.
	const velocity: MutVec3 = [0.0021, -0.0034, 0.0012]
	const state: PositionAndVelocity = [[...XYZ], velocity]
	const [position, transformedVelocity] = galactic(state)
	const positionOnly = galactic(XYZ)
	const velocityOnly = galactic(velocity)

	for (let i = 0; i < 3; i++) {
		expect(position[i]).toBeCloseTo(positionOnly[i], 15)
		expect(transformedVelocity[i]).toBeCloseTo(velocityOnly[i], 15)
	}
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

// Asserts that a rotation matrix is orthonormal (R · Rᵀ = I), i.e. a valid frame.
function expectOrthonormal(r: Mat3) {
	const i = matMulTranspose(r, r)
	const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
	for (let k = 0; k < 9; k++) expect(i[k]).toBeCloseTo(identity[k], 12)
}

test('frameToFrame from the base matches the dedicated wrappers', () => {
	// ICRS is the identity base, so frameToFrame(.., ICRS, F) must equal frameAt(.., F).
	const fromGraph = eraC2s(...frameToFrame(XYZ, ICRS, GALACTIC, TIME))
	const fromWrapper = eraC2s(...galactic(XYZ))
	expect(fromGraph[0]).toBeCloseTo(fromWrapper[0], 15)
	expect(fromGraph[1]).toBeCloseTo(fromWrapper[1], 15)

	const ecl = frameToFrame(XYZ, ICRS, ECLIPTIC_J2000, TIME)
	const eclWrapper = eclipticJ2000(XYZ)
	for (let i = 0; i < 3; i++) expect(ecl[i]).toBeCloseTo(eclWrapper[i], 15)
})

test('frameToBase is the exact inverse of frameAt for a constant frame', () => {
	const velocity: MutVec3 = [0.0021, -0.0034, 0.0012]
	const state: PositionAndVelocity = [[...XYZ], velocity]
	const back = frameToBase(galactic(state), GALACTIC, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(state[0][i], 15)
		expect(back[1][i]).toBeCloseTo(state[1][i], 15)
	}
})

test('frameToBase undoes the rotating-frame drag term for ITRS', () => {
	// ITRS carries dRdtTimesRtAt, so the velocity inverse must remove the
	// earth-rotation term, not just transpose the rotation.
	const state: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const back = frameToBase(frameAt(state, ITRS, TIME), ITRS, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(state[0][i], 12)
		expect(back[1][i]).toBeCloseTo(state[1][i], 12)
	}
})

test('frameToFrame round trips through a rotating frame with velocity', () => {
	const state: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const back = frameToFrame(frameToFrame(state, ICRS, ITRS, TIME), ITRS, ICRS, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(state[0][i], 12)
		expect(back[1][i]).toBeCloseTo(state[1][i], 12)
	}
})

test('new rotation frames are orthonormal and round trip', () => {
	for (const frame of [CIRS, MEAN_EQUATOR_AND_EQUINOX_OF_DATE, TIRS, TRUE_EQUATOR_AND_EQUINOX_OF_DATE]) {
		expectOrthonormal(frame.rotationAt(TIME))
		const back = frameToFrame(frameToFrame(XYZ, ICRS, frame, TIME), frame, ICRS, TIME)
		for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(XYZ[i], 12)
	}
})

test('mean and true equator of date differ only by nutation', () => {
	// The mean (precession-only) and true (precession+nutation) equators of date
	// must agree to well under the ~20 arcsec scale of nutation, but not be equal.
	const mean = eraC2s(...frameToFrame(XYZ, ICRS, MEAN_EQUATOR_AND_EQUINOX_OF_DATE, TIME))
	const trueOfDate = eraC2s(...frameToFrame(XYZ, ICRS, TRUE_EQUATOR_AND_EQUINOX_OF_DATE, TIME))
	const separation = Math.abs(mean[0] - trueOfDate[0]) + Math.abs(mean[1] - trueOfDate[1])
	expect(separation).toBeGreaterThan(0)
	expect(separation).toBeLessThan(2e-4) // ~40 arcsec
})
