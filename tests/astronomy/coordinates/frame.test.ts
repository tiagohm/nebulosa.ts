import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { eraC2s, eraNut06a, eraPmat06, eraPnm06a, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
// oxfmt-ignore
import { CIRS, cirs, ECLIPTIC, ecliptic, ECLIPTIC_B1950, eclipticB1950, ECLIPTIC_J2000, eclipticJ2000, FK4, fk4, FK5, fk5, fk5Frame, fk5ToIcrs, type Frame, frameAt, frameRotationAt, frameToBase, frameToFrame, GALACTIC, galactic, ICRS, icrs, icrsToFk5, ITRS, itrs, ITRS_INSTANTANEOUS, itrsInstantaneous, itrfToTeme, itrfToTemeByGmst, MEAN_ECLIPTIC_OF_DATE, meanEclipticOfDate, MEAN_EQUATOR_AND_EQUINOX_AT_B1950, meanEquatorAndEquinoxAtB1950, MEAN_EQUATOR_AND_EQUINOX_OF_DATE, meanEquatorAndEquinoxOfDate, precessionMatrixCapitaine, supergalactic, SUPERGALACTIC, TEME, teme, temeToItrf, temeToItrfByGmst, TIRS, tirs, TRUE_EQUATOR_AND_EQUINOX_OF_DATE, trueEquatorAndEquinoxOfDate } from '../../../src/astronomy/coordinates/frame'
import { type Time, type TimeProviders, Timescale, timeJulianYear, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { ANGVEL_PER_DAY, DAYSEC, EARTH_DRDT_TIMES_RT_MATRIX } from '../../../src/core/constants'
import { type Mat3, matMinus, matMul, matMulScalar, matMulTranspose, matMulVec, matRotX, matRotZ } from '../../../src/math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecDot, vecMinus, vecMulScalar } from '../../../src/math/linear-algebra/vec3'
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
const NO_TIME: Time = { day: 0, fraction: 0, scale: 0 }

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

test('frame convenience wrappers delegate to their matching frames', () => {
	const fixedCases = [
		{ wrapper: meanEquatorAndEquinoxAtB1950, frame: MEAN_EQUATOR_AND_EQUINOX_AT_B1950 },
		{ wrapper: eclipticB1950, frame: ECLIPTIC_B1950 },
		{ wrapper: eclipticJ2000, frame: ECLIPTIC_J2000 },
		{ wrapper: fk4, frame: FK4 },
		{ wrapper: fk5, frame: FK5 },
		{ wrapper: galactic, frame: GALACTIC },
		{ wrapper: supergalactic, frame: SUPERGALACTIC },
		{ wrapper: icrs, frame: ICRS },
	] as const

	for (const { wrapper, frame } of fixedCases) {
		const direct = wrapper(XYZ)
		const generic = frameAt(XYZ, frame, NO_TIME)
		for (let i = 0; i < 3; i++) expect(direct[i]).toBeCloseTo(generic[i], 15)
	}

	const timeDependentCases = [
		{ wrapper: trueEquatorAndEquinoxOfDate, frame: TRUE_EQUATOR_AND_EQUINOX_OF_DATE },
		{ wrapper: ecliptic, frame: ECLIPTIC },
		{ wrapper: meanEquatorAndEquinoxOfDate, frame: MEAN_EQUATOR_AND_EQUINOX_OF_DATE },
		{ wrapper: meanEclipticOfDate, frame: MEAN_ECLIPTIC_OF_DATE },
		{ wrapper: cirs, frame: CIRS },
		{ wrapper: tirs, frame: TIRS },
		{ wrapper: teme, frame: TEME },
		{ wrapper: itrs, frame: ITRS },
		{ wrapper: itrsInstantaneous, frame: ITRS_INSTANTANEOUS },
	] as const

	for (const { wrapper, frame } of timeDependentCases) {
		const direct = wrapper(XYZ, TIME)
		const generic = frameAt(XYZ, frame, TIME)
		for (let i = 0; i < 3; i++) expect(direct[i]).toBeCloseTo(generic[i], 15)

		const atJd0 = frameAt(XYZ, frame, NO_TIME)
		const separation = Math.abs(direct[0] - atJd0[0]) + Math.abs(direct[1] - atJd0[1]) + Math.abs(direct[2] - atJd0[2])
		expect(separation).toBeGreaterThan(1e-3)
	}
})

test('FK5 dynamic frame and ICRS/FK5 wrappers match generic transforms', () => {
	const dynamicFk5 = fk5Frame(TIME)
	const viaFrame = frameAt(XYZ, dynamicFk5, TIME)
	const viaGeneric = frameToFrame(XYZ, ICRS, dynamicFk5, TIME)
	for (let i = 0; i < 3; i++) expect(viaFrame[i]).toBeCloseTo(viaGeneric[i], 15)

	const fk5Position = icrsToFk5(XYZ)
	const roundTrip = fk5ToIcrs(fk5Position)
	for (let i = 0; i < 3; i++) expect(roundTrip[i]).toBeCloseTo(XYZ[i], 15)
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

test('frameAt and frameToBase write into an output parameter', () => {
	const state: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const outVec: MutVec3 = [0, 0, 0]
	const fresh = frameAt(XYZ, ITRS, TIME)
	const written = frameAt(XYZ, ITRS, TIME, outVec)
	expect(written).toBe(outVec)
	for (let i = 0; i < 3; i++) expect(outVec[i]).toBeCloseTo(fresh[i], 15)

	const outState: PositionAndVelocity = [
		[0, 0, 0],
		[0, 0, 0],
	]
	const freshState = frameAt(state, ITRS, TIME)
	const writtenState = frameAt(state, ITRS, TIME, outState)
	expect(writtenState).toBe(outState)
	for (let i = 0; i < 3; i++) {
		expect(outState[0][i]).toBeCloseTo(freshState[0][i], 15)
		expect(outState[1][i]).toBeCloseTo(freshState[1][i], 15)
	}

	const baseOut: PositionAndVelocity = [
		[0, 0, 0],
		[0, 0, 0],
	]
	const frameState = frameAt(state, ITRS, TIME)
	const baseFresh = frameToBase(frameState, ITRS, TIME)
	const baseWritten = frameToBase(frameState, ITRS, TIME, baseOut)
	expect(baseWritten).toBe(baseOut)
	for (let i = 0; i < 3; i++) {
		expect(baseOut[0][i]).toBeCloseTo(baseFresh[0][i], 15)
		expect(baseOut[1][i]).toBeCloseTo(baseFresh[1][i], 15)
	}
})

test('frameToFrame supports an in-place state transform through a rotating frame', () => {
	const original: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const inPlace: PositionAndVelocity = [[...original[0]], [...original[1]]]
	const expected = frameToFrame(original, ICRS, ITRS, TIME)
	const result = frameToFrame(inPlace, ICRS, ITRS, TIME, inPlace)
	expect(result).toBe(inPlace)
	for (let i = 0; i < 3; i++) {
		expect(inPlace[0][i]).toBeCloseTo(expected[0][i], 15)
		expect(inPlace[1][i]).toBeCloseTo(expected[1][i], 15)
	}
})

test('frameRotationAt matches frameToFrame for the position rotation', () => {
	// The composed matrix applied to a vector must equal the per-call transform,
	// for both an inertial pair (FK5 -> GALACTIC) and a time-dependent one
	// (ICRS -> CIRS).
	for (const [from, to] of [
		[FK5, GALACTIC],
		[ICRS, CIRS],
	] as const) {
		const r = frameRotationAt(from, to, TIME)
		const viaMatrix = matMulVec(r, XYZ)
		const viaFrame = frameToFrame(XYZ, from, to, TIME)
		for (let i = 0; i < 3; i++) expect(viaMatrix[i]).toBeCloseTo(viaFrame[i], 15)
	}
})

test('frameRotationAt transforms the velocity of an inertial frame pair', () => {
	// Both ICRS and GALACTIC are non-rotating, so the same matrix rotates the
	// velocity; the matrix path must agree with the full state transform.
	const state: PositionAndVelocity = [[...XYZ], [0.0021, -0.0034, 0.0012]]
	const r = frameRotationAt(ICRS, GALACTIC, TIME)
	const [position, velocity] = frameToFrame(state, ICRS, GALACTIC, TIME)
	const rp = matMulVec(r, state[0])
	const rv = matMulVec(r, state[1])
	for (let i = 0; i < 3; i++) {
		expect(rp[i]).toBeCloseTo(position[i], 15)
		expect(rv[i]).toBeCloseTo(velocity[i], 15)
	}
})

test('ITRS_INSTANTANEOUS matches ITRS closely but uses the exact drift term', () => {
	const state: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const approx = frameAt(state, ITRS, TIME)
	const exact = frameAt(state, ITRS_INSTANTANEOUS, TIME)

	// Positions are identical (same rotationAt); velocities differ only by the
	// small precession/nutation/polar-motion rate contributions to the drag term.
	for (let i = 0; i < 3; i++) {
		expect(exact[0][i]).toBeCloseTo(approx[0][i], 15)
		expect(exact[1][i]).toBeCloseTo(approx[1][i], 4)
	}
	const dv = Math.abs(exact[1][0] - approx[1][0]) + Math.abs(exact[1][1] - approx[1][1]) + Math.abs(exact[1][2] - approx[1][2])
	expect(dv).toBeGreaterThan(0)
	expect(dv).toBeLessThan(1e-4)

	// The exact frame still round trips.
	const back = frameToFrame(frameToFrame(state, ICRS, ITRS_INSTANTANEOUS, TIME), ITRS_INSTANTANEOUS, ICRS, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(state[0][i], 12)
		expect(back[1][i]).toBeCloseTo(state[1][i], 12)
	}
})

test('TIRS applies the earth-rotation velocity term', () => {
	// TIRS is Earth-fixed apart from polar motion, so a crust-fixed ITRS rest
	// state must have near-zero TIRS velocity (only polar-motion rate remains).
	const itrsRest: PositionAndVelocity = [
		[1, 0, 0],
		[0, 0, 0],
	]
	const gcrs = frameToFrame(itrsRest, ITRS, ICRS, TIME)
	const tirsFromItrs = frameToFrame(gcrs, ICRS, TIRS, TIME)
	// Without W the TIRS speed would be ~ω|r|; polar-motion residual is ~1e-6 relative.
	expect(Math.hypot(...tirsFromItrs[1])).toBeLessThan(1e-3 * ANGVEL_PER_DAY)

	// A GCRS rest state in TIRS is the rotating-frame drag W · p.
	const gcrsRest: PositionAndVelocity = [
		[1, 0, 0],
		[0, 0, 0],
	]
	const tirsFromGcrs = frameAt(gcrsRest, TIRS, TIME)
	expect(tirsFromGcrs[1][0]).toBeCloseTo(ANGVEL_PER_DAY * tirsFromGcrs[0][1], 12)
	expect(tirsFromGcrs[1][1]).toBeCloseTo(-ANGVEL_PER_DAY * tirsFromGcrs[0][0], 12)
	expect(tirsFromGcrs[1][2]).toBeCloseTo(0, 12)

	const pv: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const back = frameToFrame(frameToFrame(pv, ICRS, TIRS, TIME), TIRS, ICRS, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(pv[0][i], 12)
		expect(back[1][i]).toBeCloseTo(pv[1][i], 12)
	}
})

test('TEME frame reproduces temeToItrf and round trips', () => {
	const pv: PositionAndVelocity = [
		[4123, -5234, 3045],
		[2.1, 3.4, -1.2],
	]

	// The position must match the trusted temeToItrf chain (same Rz(GMST)·PM rotation).
	const viaFrame = frameToFrame(pv, TEME, ITRS, TIME)
	const viaFn = temeToItrf(pv, TIME)
	for (let i = 0; i < 3; i++) expect(viaFrame[0][i]).toBeCloseTo(viaFn[0][i], 6)

	// TEME is a valid orientation and the state round trips through it.
	expectOrthonormal(TEME.rotationAt(TIME))
	const back = frameToFrame(frameToFrame(pv, TEME, ITRS, TIME), ITRS, TEME, TIME)
	for (let i = 0; i < 3; i++) {
		expect(back[0][i]).toBeCloseTo(pv[0][i], 9)
		expect(back[1][i]).toBeCloseTo(pv[1][i], 9)
	}
})

test('mean and true ecliptic of date differ only by nutation', () => {
	expectOrthonormal(MEAN_ECLIPTIC_OF_DATE.rotationAt(TIME))

	// Round trip through the new frame.
	const back = frameToFrame(frameToFrame(XYZ, ICRS, MEAN_ECLIPTIC_OF_DATE, TIME), MEAN_ECLIPTIC_OF_DATE, ICRS, TIME)
	for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(XYZ[i], 12)

	// The mean (precession-only) and true (precession+nutation) ecliptics of date
	// must agree to well under the ~20 arcsec nutation scale, but not be equal.
	const mean = eraC2s(...frameToFrame(XYZ, ICRS, MEAN_ECLIPTIC_OF_DATE, TIME))
	const trueOfDate = eraC2s(...ecliptic(XYZ, TIME))
	const separation = Math.abs(mean[0] - trueOfDate[0]) + Math.abs(mean[1] - trueOfDate[1])
	expect(separation).toBeGreaterThan(0)
	expect(separation).toBeLessThan(2e-4) // ~40 arcsec
})

const CELESTIAL_RATE_FRAMES = [TRUE_EQUATOR_AND_EQUINOX_OF_DATE, MEAN_EQUATOR_AND_EQUINOX_OF_DATE, ECLIPTIC, MEAN_ECLIPTIC_OF_DATE, CIRS] as const

const STATIONARY: Vec3 = [0.8, -0.4, 0.3]
const STATIONARY_REST: PositionAndVelocity = [[...STATIONARY], [0, 0, 0]]
const CELESTIAL_DRIFT_STEP = 60 / DAYSEC

// tests/setup.ts caches PNM/nutation by rounded Julian day, which makes a 60 s
// celestial derivative identically zero. These tests attach the exact ERFA
// models to a fresh Time so the kinematic operator sees the real PN rate.
const EXACT_CELESTIAL_PROVIDERS: TimeProviders = {
	pnm: (t) => eraPnm06a(t.day, t.fraction),
	nut: (t) => eraNut06a(t.day, t.fraction),
	pmat: (t) => eraPmat06(t.day, t.fraction),
}

const CELESTIAL_NOW = { ...TIME, providers: EXACT_CELESTIAL_PROVIDERS }
const J2000_TT = timeJulianYear(2000, Timescale.TT)
const EPOCH_1990_TT = timeYMDHMS(1990, 1, 1, 12, 0, 0, Timescale.TT)
const LEAP_UTC = timeYMDHMS(2016, 12, 31, 23, 59, 0, Timescale.UTC)

J2000_TT.providers = EXACT_CELESTIAL_PROVIDERS
EPOCH_1990_TT.providers = EXACT_CELESTIAL_PROVIDERS
LEAP_UTC.providers = EXACT_CELESTIAL_PROVIDERS

// Independent so(3)-projected W = dR/dt·Rᵀ from rotationAt at an arbitrary step.
function projectedDrift(frame: Frame, time: Time, step: number): Mat3 {
	const r = frame.rotationAt(time)
	const d = matMulScalar(matMinus(frame.rotationAt(timeShift(time, step)), frame.rotationAt(timeShift(time, -step))), 0.5 / step)
	const a = matMulTranspose(d, r)
	const w01 = 0.5 * (a[1] - a[3])
	const w02 = 0.5 * (a[2] - a[6])
	const w12 = 0.5 * (a[5] - a[7])
	return [0, w01, w02, -w01, 0, w12, -w02, -w12, 0]
}

function hypot9(a: Mat3, b: Mat3) {
	let s = 0
	for (let i = 0; i < 9; i++) s += (a[i] - b[i]) ** 2
	return Math.sqrt(s)
}

test('celestial frames expose an antisymmetric basis-rate operator', () => {
	for (const frame of CELESTIAL_RATE_FRAMES) {
		expect(frame.dRdtTimesRtAt).toBeDefined()
		const r = frame.rotationAt(CELESTIAL_NOW)
		const before = [...r]
		const w = frame.dRdtTimesRtAt!(CELESTIAL_NOW, r)
		const withoutRotation = frame.dRdtTimesRtAt!(CELESTIAL_NOW)

		for (let i = 0; i < 9; i++) {
			expect(r[i]).toBe(before[i])
			expect(w[i]).toBeCloseTo(withoutRotation[i], 15)
		}

		expect(w[0]).toBeCloseTo(0, 15)
		expect(w[4]).toBeCloseTo(0, 15)
		expect(w[8]).toBeCloseTo(0, 15)
		expect(w[1]).toBeCloseTo(-w[3], 15)
		expect(w[2]).toBeCloseTo(-w[6], 15)
		expect(w[5]).toBeCloseTo(-w[7], 15)
		expect(vecDot(STATIONARY, matMulVec(w, STATIONARY))).toBeCloseTo(0, 15)
	}
})

test('celestial frameAt velocity matches an independent position derivative', () => {
	// Validation step is 1 hour, not the production 60 s derivative, so this
	// is not a tautology of the implementation.
	const delta = 3600 / DAYSEC

	for (const frame of CELESTIAL_RATE_FRAMES) {
		const [, velocity] = frameAt(STATIONARY_REST, frame, CELESTIAL_NOW)
		expect(Math.hypot(...velocity)).toBeGreaterThan(1e-8)

		const plus = matMulVec(frame.rotationAt(timeShift(CELESTIAL_NOW, delta)), STATIONARY)
		const minus = matMulVec(frame.rotationAt(timeShift(CELESTIAL_NOW, -delta)), STATIONARY)
		const expected = vecMulScalar(vecMinus(plus, minus), 0.5 / delta)

		for (let i = 0; i < 3; i++) expect(velocity[i]).toBeCloseTo(expected[i], 10)
	}
})

test('mean celestial rates are precession-only and true rates include nutation', () => {
	const meanW = MEAN_EQUATOR_AND_EQUINOX_OF_DATE.dRdtTimesRtAt!(CELESTIAL_NOW)
	const trueW = TRUE_EQUATOR_AND_EQUINOX_OF_DATE.dRdtTimesRtAt!(CELESTIAL_NOW)
	const meanEclW = MEAN_ECLIPTIC_OF_DATE.dRdtTimesRtAt!(CELESTIAL_NOW)
	const trueEclW = ECLIPTIC.dRdtTimesRtAt!(CELESTIAL_NOW)

	for (const [actual, frame] of [
		[meanW, MEAN_EQUATOR_AND_EQUINOX_OF_DATE],
		[trueW, TRUE_EQUATOR_AND_EQUINOX_OF_DATE],
		[meanEclW, MEAN_ECLIPTIC_OF_DATE],
		[trueEclW, ECLIPTIC],
	] as const) {
		const independent = projectedDrift(frame, CELESTIAL_NOW, CELESTIAL_DRIFT_STEP)
		for (let i = 0; i < 9; i++) expect(actual[i]).toBeCloseTo(independent[i], 15)
	}

	expect(hypot9(trueW, meanW)).toBeGreaterThan(1e-7)
	expect(hypot9(trueEclW, meanEclW)).toBeGreaterThan(1e-7)
})

test('celestial drift step is stable at 30 s, 60 s and 120 s', () => {
	// Observed 30 s vs 120 s disagreement is ~4e-13 away from leap seconds and
	// ~4e-12 near a UTC leap-second boundary. 1e-11 is well below AU/day
	// velocity and rad/day angular-rate accuracy.
	const times = [J2000_TT, CELESTIAL_NOW, EPOCH_1990_TT, LEAP_UTC]
	const h30 = 30 / DAYSEC
	const h120 = 120 / DAYSEC

	for (const time of times) {
		for (const frame of CELESTIAL_RATE_FRAMES) {
			const w = frame.dRdtTimesRtAt!(time)
			const w30 = projectedDrift(frame, time, h30)
			const w60 = projectedDrift(frame, time, CELESTIAL_DRIFT_STEP)
			const w120 = projectedDrift(frame, time, h120)

			expect(hypot9(w, w60)).toBeLessThan(1e-15)
			expect(hypot9(w30, w60)).toBeLessThan(1e-11)
			expect(hypot9(w60, w120)).toBeLessThan(1e-11)
			expect(hypot9(w30, w120)).toBeLessThan(1e-11)
		}
	}
})

test('mean equator of date precession rate is stable across decades', () => {
	const speeds = [J2000_TT, CELESTIAL_NOW, EPOCH_1990_TT].map((time) => Math.hypot(...frameAt(STATIONARY_REST, MEAN_EQUATOR_AND_EQUINOX_OF_DATE, time)[1]))

	for (const speed of speeds) {
		expect(Number.isFinite(speed)).toBe(true)
		expect(speed).toBeGreaterThan(1e-8)
	}

	expect(speeds[0]).toBeCloseTo(speeds[1], 9)
	expect(speeds[0]).toBeCloseTo(speeds[2], 9)
})

test('celestial drift stays finite across a UTC leap-second boundary', () => {
	const near = [LEAP_UTC, timeYMDHMS(2017, 1, 1, 0, 0, 1, Timescale.UTC)] as const
	near[1].providers = EXACT_CELESTIAL_PROVIDERS

	for (const frame of CELESTIAL_RATE_FRAMES) {
		const operators = near.map((time) => frame.dRdtTimesRtAt!(time))
		for (const w of operators) for (let i = 0; i < 9; i++) expect(Number.isFinite(w[i])).toBe(true)
		expect(hypot9(operators[0], operators[1])).toBeLessThan(1e-8)
	}
})

// PyERFA 2.0.1.5. UTC 2025-09-28 12:00:00 converted with utctai+taitt.
// W is the so(3) projection of [R(t+60s)-R(t-60s)]/(120s) · Rᵀ, using
// eraPnm06a / eraBp06 rbp / eraC2i06a. Inertial rest at [0.8, -0.4, 0.3] AU.
test('celestial drift matches independently sampled PyERFA rotation matrices', () => {
	const trueW = TRUE_EQUATOR_AND_EQUINOX_OF_DATE.dRdtTimesRtAt!(CELESTIAL_NOW)
	const meanW = MEAN_EQUATOR_AND_EQUINOX_OF_DATE.dRdtTimesRtAt!(CELESTIAL_NOW)
	const cirsW = CIRS.dRdtTimesRtAt!(CELESTIAL_NOW)
	const [, trueV] = frameAt(STATIONARY_REST, TRUE_EQUATOR_AND_EQUINOX_OF_DATE, CELESTIAL_NOW)
	const [, cirsV] = frameAt(STATIONARY_REST, CIRS, CELESTIAL_NOW)

	const expectedTrueW: Mat3 = [0, -8.521559769663562e-7, -3.7002066140474674e-7, 8.521559769663562e-7, 0, 1.0416238234173015e-7, 3.7002066140474674e-7, -1.0416238234173015e-7, 0]
	const expectedMeanW: Mat3 = [0, -6.122890614256493e-7, -2.659965641393925e-7, 6.122890614256493e-7, 0, 3.465037158430208e-12, 2.659965641393925e-7, -3.465037158430208e-12, 0]
	const expectedCirsW: Mat3 = [0, -6.593456868672199e-13, -3.6941343559094433e-7, 6.593456868672199e-13, 0, 1.0629585143724063e-7, 3.6941343559094433e-7, -1.0629585143724063e-7, 0]

	for (let i = 0; i < 9; i++) {
		expect(trueW[i]).toBeCloseTo(expectedTrueW[i], 13)
		expect(meanW[i]).toBeCloseTo(expectedMeanW[i], 13)
		expect(cirsW[i]).toBeCloseTo(expectedCirsW[i], 13)
	}

	expect(trueV[0]).toBeCloseTo(2.2519390588114227e-7, 13)
	expect(trueV[1]).toBeCloseTo(7.144932672625881e-7, 13)
	expect(trueV[2]).toBeCloseTo(3.377715029023664e-7, 13)
	expect(cirsV[0]).toBeCloseTo(-1.115587948243252e-7, 13)
	expect(cirsV[1]).toBeCloseTo(3.210078098643396e-8, 13)
	expect(cirsV[2]).toBeCloseTo(3.3777150800397635e-7, 13)
})

test('celestial frameAt and frameToBase remain inverse for a full state', () => {
	const pv: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]

	for (const frame of CELESTIAL_RATE_FRAMES) {
		const back = frameToBase(frameAt(pv, frame, CELESTIAL_NOW), frame, CELESTIAL_NOW)
		for (let i = 0; i < 3; i++) {
			expect(back[0][i]).toBeCloseTo(pv[0][i], 12)
			expect(back[1][i]).toBeCloseTo(pv[1][i], 12)
		}
	}
})

test('celestial frameToFrame includes both source and destination basis rates', () => {
	const pv: PositionAndVelocity = [
		[0.4, -0.6, 0.3],
		[1e-4, 2e-4, -3e-4],
	]
	const pairs = [
		[TRUE_EQUATOR_AND_EQUINOX_OF_DATE, CIRS],
		[MEAN_EQUATOR_AND_EQUINOX_OF_DATE, ECLIPTIC],
		[MEAN_ECLIPTIC_OF_DATE, TRUE_EQUATOR_AND_EQUINOX_OF_DATE],
	] as const

	for (const [from, to] of pairs) {
		const direct = frameToFrame(pv, from, to, CELESTIAL_NOW)
		const viaBase = frameAt(frameToBase(pv, from, CELESTIAL_NOW), to, CELESTIAL_NOW)
		for (let i = 0; i < 3; i++) {
			expect(direct[0][i]).toBeCloseTo(viaBase[0][i], 15)
			expect(direct[1][i]).toBeCloseTo(viaBase[1][i], 15)
		}

		const back = frameToFrame(direct, to, from, CELESTIAL_NOW)
		for (let i = 0; i < 3; i++) {
			expect(back[0][i]).toBeCloseTo(pv[0][i], 12)
			expect(back[1][i]).toBeCloseTo(pv[1][i], 12)
		}
	}
})

test('TEME omits celestial drift and keeps SGP4 ITRF velocity parity', () => {
	expect(TEME.dRdtTimesRtAt).toBeUndefined()

	const [, temeVelocity] = frameAt(STATIONARY_REST, TEME, TIME)
	expect(temeVelocity[0]).toBeCloseTo(0, 15)
	expect(temeVelocity[1]).toBeCloseTo(0, 15)
	expect(temeVelocity[2]).toBeCloseTo(0, 15)

	const pv: PositionAndVelocity = [
		[4123, -5234, 3045],
		[2.1, 3.4, -1.2],
	]
	const viaTirs = frameToFrame(pv, TEME, TIRS, TIME)
	const viaTemeToItrf = temeToItrf(pv, TIME, false)

	for (let i = 0; i < 3; i++) {
		expect(viaTirs[0][i]).toBeCloseTo(viaTemeToItrf[0][i], 9)
		expect(viaTirs[1][i]).toBeCloseTo(viaTemeToItrf[1][i], 9)
	}

	const viaItrs = frameToFrame(pv, TEME, ITRS, TIME)
	const withPm = temeToItrf(pv, TIME)
	for (let i = 0; i < 3; i++) expect(viaItrs[0][i]).toBeCloseTo(withPm[0][i], 6)
})

test('TIRS and ITRS keep the mean Earth-spin operator', () => {
	const tirsW = TIRS.dRdtTimesRtAt!(TIME)
	const itrsW = ITRS.dRdtTimesRtAt!(TIME)

	for (let i = 0; i < 9; i++) {
		expect(tirsW[i]).toBe(EARTH_DRDT_TIMES_RT_MATRIX[i])
		expect(itrsW[i]).toBe(EARTH_DRDT_TIMES_RT_MATRIX[i])
	}
})
