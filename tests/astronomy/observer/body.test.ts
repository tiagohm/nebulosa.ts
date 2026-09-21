import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { bodyFixedFrame, bodyFixedMatrix, JUPITER_ROTATION, MOON_ROTATION } from '../../../src/astronomy/bodies/orientation'
import { equatorial, relativePositionAndVelocity, type PositionAndVelocity, type PositionAndVelocityOverTime } from '../../../src/astronomy/coordinates/astrometry'
import { frameAt, frameToBase, ICRS, type Frame } from '../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { bodyRadii, SpiceFrames } from '../../../src/astronomy/ephemeris/kernels/frame.kernel'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readPck } from '../../../src/astronomy/ephemeris/kernels/pck'
import { readSpk, type Spk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { readTextKernel, SpiceKernelPool } from '../../../src/astronomy/ephemeris/kernels/text.kernel'
import { bodyShape, bodySurfaceLocation, bodySurfacePositionAndVelocity, bodySurfaceState, type BodyShape } from '../../../src/astronomy/observer/body'
import { Timescale, time, timeShift, timeYMDHMS, toJulianDay, type Time } from '../../../src/astronomy/time/time'
import { DAYSEC, J2000, PI, PIOVERTWO, TAU } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/io'
import { type Mat3, matIdentity, matMinus, matMulScalar, matMulTranspose, matRotX, matRotZ } from '../../../src/math/linear-algebra/mat3'
import { type MutVec3, vecCross, vecLength, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { deg, normalizeAngle, toDeg } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'
import { expectNumberArrayToBeCloseTo } from '../../util'

await downloadPerTag('frame.kernel')

const T0 = time(J2000, 0, Timescale.TDB)
const UNIT_SPHERE: BodyShape = { radii: [1, 1, 1] }
const TRIAXIAL: BodyShape = { radii: [3, 2, 1] }

// Constant spin about body-fixed +Z at `rate` rad/day, identity at J2000 TDB.
function zSpin(rate: number): Frame {
	return {
		rotationAt: (t) => matRotZ(rate * (toJulianDay(t) - J2000)),
		dRdtTimesRtAt: () => [0, rate, 0, -rate, 0, 0, 0, 0, 0],
	}
}

// Constant spin about a body-fixed +Z axis tilted by `obliquity` around +X.
function tiltedSpin(obliquity: number, rate: number): Frame {
	return {
		rotationAt: (t) => matRotZ(rate * (toJulianDay(t) - J2000), matRotX(obliquity)),
		dRdtTimesRtAt: () => [0, rate, 0, -rate, 0, 0, 0, 0, 0],
	}
}

// Implicit ellipsoid value x²/a² + y²/b² + z²/c².
function ellipsoidValue(p: readonly [number, number, number], radii: readonly [number, number, number]) {
	return (p[0] * p[0]) / (radii[0] * radii[0]) + (p[1] * p[1]) / (radii[1] * radii[1]) + (p[2] * p[2]) / (radii[2] * radii[2])
}

// Centered finite-difference W = dR/dt · Rᵀ (per day), projected onto so(3) so a
// tiny symmetric leftover cannot masquerade as a rate error. Five seconds keeps
// sinc truncation of Jupiter's ~15 rad/day spin near 2e-6 rad/day.
function numericalW(rotationAt: (t: Time) => Mat3, t: Time, rotation: Mat3, step = 5 / DAYSEC): Mat3 {
	const rp = rotationAt(timeShift(t, step))
	const rm = rotationAt(timeShift(t, -step))
	const d = matMinus(rp, rm)
	matMulScalar(d, 0.5 / step, d)
	const a = matMulTranspose(d, rotation, d)
	const w01 = 0.5 * (a[1] - a[3])
	const w02 = 0.5 * (a[2] - a[6])
	const w12 = 0.5 * (a[5] - a[7])
	return [0, w01, w02, -w01, 0, w12, -w02, -w12, 0]
}

// Frobenius distance between two 3×3 matrices.
function hypot9(a: Mat3, b: Mat3) {
	let s = 0
	for (let i = 0; i < 9; i++) s += (a[i] - b[i]) ** 2
	return Math.sqrt(s)
}

// Loads the lunar FK, text PCK, binary PCK, and DE421 SPK.
async function lunarKernels() {
	const pool = new SpiceKernelPool()

	await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'))
	pool.load(await readTextKernel(fk))

	await using tpc = fileHandleSource(await fs.open('data/pck00008.tpc'))
	pool.load(await readTextKernel(tpc))

	const bpc = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(bpc))
	for (const segment of pck.segments) await segment.initialize()

	const bsp = fileHandleSource(await fs.open('data/de421.bsp'))
	const spk = readSpk(await readDaf(bsp))

	return {
		pool,
		spk,
		frames: new SpiceFrames(pool, pck),
		async [Symbol.asyncDispose]() {
			await bpc[Symbol.asyncDispose]()
			await bsp[Symbol.asyncDispose]()
		},
	}
}

// Barycentric ICRS state of Earth or the Moon from DE421 (SSB → EMB → target).
async function barycentricAt(spk: Spk, target: number, t: Time): Promise<PositionAndVelocity> {
	const emb = await spk.segment(Naif.SSB, Naif.EMB)!.at(t)
	const rel = await spk.segment(Naif.EMB, target)!.at(t)
	return [vecPlus(emb[0], rel[0]), vecPlus(emb[1], rel[1])]
}

test('bodyShape copies a tuple and a {x,y,z} radii record', () => {
	const tuple = bodyShape([1, 2, 3])
	expect(tuple.radii).toEqual([1, 2, 3])

	const record = bodyShape({ x: 4, y: 5, z: 6 })
	expect(record.radii).toEqual([4, 5, 6])
})

test('identity frame and a sphere map planetocentric coordinates to Cartesian', () => {
	const equator = bodySurfaceLocation(0, 0, 0, UNIT_SPHERE, ICRS)
	expectNumberArrayToBeCloseTo(equator.bodyFixed, [1, 0, 0], 15)

	const east = bodySurfaceLocation(PIOVERTWO, 0, 0, UNIT_SPHERE, ICRS)
	expectNumberArrayToBeCloseTo(east.bodyFixed, [0, 1, 0], 15)

	const north = bodySurfaceLocation(0, PIOVERTWO, 0, UNIT_SPHERE, ICRS)
	expectNumberArrayToBeCloseTo(north.bodyFixed, [0, 0, 1], 15)

	const south = bodySurfaceLocation(0, -PIOVERTWO, 0, UNIT_SPHERE, ICRS)
	expectNumberArrayToBeCloseTo(south.bodyFixed, [0, 0, -1], 15)
})

test('sphere Cartesian radius is radius plus elevation', () => {
	const loc = bodySurfaceLocation(deg(40), deg(-15), 0.5, { radii: [2, 2, 2] }, ICRS)
	expect(vecLength(loc.bodyFixed!)).toBeCloseTo(2.5, 15)
})

test('tri-axial ellipsoid satisfies the implicit surface equation', () => {
	const equatorX = bodySurfaceLocation(0, 0, 0, TRIAXIAL, ICRS)
	expectNumberArrayToBeCloseTo(equatorX.bodyFixed, [3, 0, 0], 15)
	expect(ellipsoidValue(equatorX.bodyFixed!, TRIAXIAL.radii)).toBeCloseTo(1, 15)

	const equatorY = bodySurfaceLocation(PIOVERTWO, 0, 0, TRIAXIAL, ICRS)
	expectNumberArrayToBeCloseTo(equatorY.bodyFixed, [0, 2, 0], 15)

	const pole = bodySurfaceLocation(0, PIOVERTWO, 0, TRIAXIAL, ICRS)
	expectNumberArrayToBeCloseTo(pole.bodyFixed, [0, 0, 1], 15)

	const loc = bodySurfaceLocation(deg(30), deg(40), 0, TRIAXIAL, ICRS)
	expect(ellipsoidValue(loc.bodyFixed!, TRIAXIAL.radii)).toBeCloseTo(1, 14)
})

test('non-zero elevation is a radial offset along the planetocentric direction', () => {
	const surface = bodySurfaceLocation(deg(-20), deg(10), 0, TRIAXIAL, ICRS).bodyFixed!
	const raised = bodySurfaceLocation(deg(-20), deg(10), 0.25, TRIAXIAL, ICRS).bodyFixed!
	const s = vecLength(surface)
	expect(vecLength(raised)).toBeCloseTo(s + 0.25, 15)
	expect(raised[0] / surface[0]).toBeCloseTo((s + 0.25) / s, 14)
	expect(raised[1] / surface[1]).toBeCloseTo((s + 0.25) / s, 14)
	expect(raised[2] / surface[2]).toBeCloseTo((s + 0.25) / s, 14)
})

test('longitude wrap leaves the Cartesian point unchanged', () => {
	const a = bodySurfaceLocation(PI, deg(20), 0, UNIT_SPHERE, ICRS).bodyFixed!
	const b = bodySurfaceLocation(-PI, deg(20), 0, UNIT_SPHERE, ICRS).bodyFixed!
	const c = bodySurfaceLocation(PI + TAU, deg(20), 0, UNIT_SPHERE, ICRS).bodyFixed!
	expectNumberArrayToBeCloseTo(a, b, 15)
	expectNumberArrayToBeCloseTo(a, c, 15)
})

test('poles remain finite for any longitude', () => {
	for (const lon of [0, PI, -PI, TAU, 1e6]) {
		const north = bodySurfaceLocation(lon, PIOVERTWO, 0.1, TRIAXIAL, ICRS).bodyFixed!
		const south = bodySurfaceLocation(lon, -PIOVERTWO, 0.1, TRIAXIAL, ICRS).bodyFixed!

		expect(north.every(Number.isFinite)).toBe(true)
		expect(south.every(Number.isFinite)).toBe(true)
		expectNumberArrayToBeCloseTo(north, [0, 0, 1.1], 12)
		expectNumberArrayToBeCloseTo(south, [0, 0, -1.1], 12)
	}
})

test('a zero-rate frame has zero body-relative velocity', () => {
	const loc = bodySurfaceLocation(deg(12), deg(-8), 0, UNIT_SPHERE, ICRS)
	const [p, v] = bodySurfaceState(loc, T0)
	expectNumberArrayToBeCloseTo(p, loc.bodyFixed!, 15)
	expectNumberArrayToBeCloseTo(v, [0, 0, 0], 15)
})

test('constant +Z spin velocity matches omega cross r', () => {
	const rate = 2.5
	const loc = bodySurfaceLocation(deg(35), deg(20), 0.05, { radii: [1.2, 1.2, 1.2] }, zSpin(rate))
	const [p, v] = bodySurfaceState(loc, T0)
	const expected = vecCross([0, 0, rate], loc.bodyFixed!)

	expectNumberArrayToBeCloseTo(p, loc.bodyFixed!, 15)
	expectNumberArrayToBeCloseTo(v, expected, 15)
})

test('tilted-axis spin velocity matches omega cross r', () => {
	const rate = 1.7
	const obliquity = deg(25)
	const frame = tiltedSpin(obliquity, rate)
	const loc = bodySurfaceLocation(deg(-10), deg(15), 0, UNIT_SPHERE, frame)
	const [p, v] = bodySurfaceState(loc, T0)
	const rotation = frame.rotationAt(T0)
	const omegaBody: MutVec3 = [0, 0, rate]
	const rInertial = frameToBase(loc.bodyFixed!, frame, T0)
	const omegaInertial = frameToBase(omegaBody, frame, T0)
	const expected = vecCross(omegaInertial, rInertial)

	expectNumberArrayToBeCloseTo(p, rInertial, 15)
	expectNumberArrayToBeCloseTo(v, expected, 15)
	expect(rotation).not.toEqual(matIdentity())
})

test('body-fixed state round-trips through frameToBase and frameAt', () => {
	const loc = bodySurfaceLocation(deg(80), deg(-40), 0.02, TRIAXIAL, zSpin(3))
	const inertial = bodySurfaceState(loc, T0)
	const back = frameAt(inertial, loc.frame, T0)

	expectNumberArrayToBeCloseTo(back[0], loc.bodyFixed!, 14)
	expectNumberArrayToBeCloseTo(back[1], [0, 0, 0], 14)
})

test('reusable output aliases the supplied state pair', () => {
	const loc = bodySurfaceLocation(deg(5), deg(8), 0, UNIT_SPHERE, zSpin(0.4))
	const out: PositionAndVelocity = [
		[1, 2, 3],
		[4, 5, 6],
	]
	const first = bodySurfaceState(loc, T0, out)
	expect(first).toBe(out)
	expect(first[0]).toBe(out[0])
	expect(first[1]).toBe(out[1])

	const snapshot = [out[0].slice(), out[1].slice()] as const
	const second = bodySurfaceState(loc, T0, first)
	expect(second).toBe(out)
	expectNumberArrayToBeCloseTo(second[0], snapshot[0], 15)
	expectNumberArrayToBeCloseTo(second[1], snapshot[1], 15)
})

test('bodySurfaceLocation caches the body-fixed point', () => {
	const loc = bodySurfaceLocation(0, 0, 0, UNIT_SPHERE, ICRS)
	const cached = loc.bodyFixed
	expect(cached).toEqual([1, 0, 0])

	loc.bodyFixed = [9, 8, 7]
	const [p] = bodySurfaceState(loc, T0)
	expectNumberArrayToBeCloseTo(p, [9, 8, 7], 15)
	expect(loc.bodyFixed).toEqual([9, 8, 7])
})

test('bodySurfacePositionAndVelocity adds the surface state to a body ephemeris', () => {
	const loc = bodySurfaceLocation(0, 0, 0, UNIT_SPHERE, ICRS)
	const body: PositionAndVelocityOverTime = () => [
		[1, 2, 3],
		[0.1, 0.2, 0.3],
	]
	const at = bodySurfacePositionAndVelocity(body, loc)
	const [p, v] = at(T0)
	expectNumberArrayToBeCloseTo(p, [2, 2, 3], 15)
	expectNumberArrayToBeCloseTo(v, [0.1, 0.2, 0.3], 15)

	const again = at(T0)
	expect(again).not.toBe(p)
	expect(again[0]).not.toBe(p)
})

test('bodyFixedFrame rotationAt matches bodyFixedMatrix for the Moon and Jupiter', () => {
	const times = [T0, timeYMDHMS(2019, 12, 20, 11, 5, 0, Timescale.UTC), timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)]

	for (const elements of [MOON_ROTATION, JUPITER_ROTATION]) {
		const frame = bodyFixedFrame(elements)
		for (const t of times) {
			expectNumberArrayToBeCloseTo(frame.rotationAt(t), bodyFixedMatrix(elements, t), 15)
		}
	}
})

test('IAU analytic dRdtTimesRtAt agrees with a centered finite difference', () => {
	const times = [T0, timeYMDHMS(2019, 12, 20, 11, 5, 0, Timescale.UTC), timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)]

	for (const elements of [MOON_ROTATION, JUPITER_ROTATION]) {
		const frame = bodyFixedFrame(elements)
		for (const t of times) {
			const r = frame.rotationAt(t)
			const w = frame.dRdtTimesRtAt!(t, r)
			const wFd = numericalW((time) => frame.rotationAt(time), t, r)

			expect(hypot9(w, wFd)).toBeLessThan(1e-5)
			expect(w[0]).toBeCloseTo(0, 15)
			expect(w[4]).toBeCloseTo(0, 15)
			expect(w[8]).toBeCloseTo(0, 15)
			expect(w[1]).toBeCloseTo(-w[3], 15)
			expect(w[2]).toBeCloseTo(-w[6], 15)
			expect(w[5]).toBeCloseTo(-w[7], 15)
			expect(w.every(Number.isFinite)).toBe(true)
		}
	}
})

test('Aristarchus on the Moon matches Skyfield at 2019-12-20 11:05 UTC', async () => {
	await using lunar = await lunarKernels()
	const { pool, spk, frames } = lunar
	const t = timeYMDHMS(2019, 12, 20, 11, 5, 0, Timescale.UTC)
	const frame = await frames.frame('MOON_ME_DE421')
	const aristarchus = bodySurfaceLocation(deg(-46.8), deg(26.3), 0, bodyShape(bodyRadii(pool, Naif.MOON)!), frame)

	const moonState = await barycentricAt(spk, Naif.MOON, t)
	const earthState = await barycentricAt(spk, Naif.EARTH, t)
	const moonAt: PositionAndVelocityOverTime = () => moonState
	const earthAt: PositionAndVelocityOverTime = () => earthState
	const aristarchusAt = bodySurfacePositionAndVelocity(moonAt, aristarchus)

	const surface = bodySurfaceState(aristarchus, t)
	const bary = aristarchusAt(t)
	const fromEarth = relativePositionAndVelocity(aristarchusAt, earthAt, t)
	const [ra, dec, distance] = equatorial(fromEarth[0])

	// Skyfield 1.55 / jplephem 2.24, DE421 + moon_080317.tf + pck00008.tpc + moon_pa_de421.
	expectNumberArrayToBeCloseTo(surface[0], [8.51427072165803e-6, -7.459961004374627e-6, 2.5954893631552345e-6], 15)
	expectNumberArrayToBeCloseTo(surface[1], [1.331243482886879e-6, 1.8086436095443966e-6, 8.3138209654175e-7], 12)
	expectNumberArrayToBeCloseTo(bary[0], [0.028569198970199113, 0.9082673240622109, 0.39400481707743673], 11)
	expectNumberArrayToBeCloseTo(fromEarth[0], [-0.0023814770535562253, -0.0006646492758509703, -3.5358335139401564e-5], 12)
	expectNumberArrayToBeCloseTo(fromEarth[1], [0.00014880022263391232, -0.0005390682700368948, -0.0002398547452045155], 12)
	expect(distance).toBeCloseTo(0.0024727397413330603, 12)
	expect(normalizeAngle(ra)).toBeCloseTo(3.4137584230187903, 10)
	expect(toDeg(dec)).toBeCloseTo(-0.819314861515383, 9)
})
