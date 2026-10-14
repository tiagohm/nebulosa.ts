import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { type PositionAndVelocityMut, type PositionAndVelocityOverTime, separationFrom, topocentricDirection, zeroPositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readSpk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { occultationCandidates } from '../../../src/astronomy/events/occultation'
import { type OccultationPath, type OccultationPathLine, type OccultationPathMode, type OccultationPathSample, occultationPath, occultationPathPolylines } from '../../../src/astronomy/events/occultation.path'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { KeplerOrbit } from '../../../src/astronomy/orbits/asteroid'
import { gcrsToItrsRotationMatrix, NO_POLAR_MOTION, type Time, Timescale, time, timeMJD, timeShift, timeSubtract, timeYMDHMS, toJulianDay } from '../../../src/astronomy/time/time'
import { DAYSEC, ELLIPSOID_PARAMETERS, GM_SUN_PITJEVA_2005, PI, SPEED_OF_LIGHT_AU_DAY } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { type Mat3, matIdentity, matMul, matRotX, matTranspose, matTransposeMulVec } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecClone, vecLength, vecMulScalar, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { clamp } from '../../../src/math/numerical/math'
import { arcsec, deg, hour, mas, normalizePI, toDeg } from '../../../src/math/units/angle'
import { kilometer, toKilometer } from '../../../src/math/units/distance'
import { download } from '../../download'

await download('de440s.bsp')

// Synthetic encounters are built in ITRS at T0 and rotated into GCRS, so the expected ground geometry at T0 is
// a closed-form line/ellipsoid intersection: a star on ITRS +x (or -x) casts a shadow parallel to that axis.
const T0 = time(2461200.5, 0.1, Timescale.TDB)
const ROTATION = gcrsToItrsRotationMatrix(T0)
const { radius: A, oneMinusFlattening } = ELLIPSOID_PARAMETERS[Ellipsoid.IERS2010]
const B = A * oneMinusFlattening
const RADIUS = kilometer(100)
const RANGE = 1 // body distance, AU
const SPEED = kilometer(10) * DAYSEC // 10 km/s in AU/day

const geocenter: PositionAndVelocityOverTime = () => zeroPositionAndVelocity()

// Body whose geocentric-light-time-retarded position at reception T0 is the ITRS vector `position` (AU), moving
// uniformly with the ITRS velocity `velocity` (AU/day).
function syntheticBody(position: Vec3, velocity: Vec3): PositionAndVelocityOverTime {
	const p = matTransposeMulVec(ROTATION, position)
	const v = matTransposeMulVec(ROTATION, velocity)
	const tau = vecLength(position) / SPEED_OF_LIGHT_AU_DAY
	const pv: PositionAndVelocityMut = [vecClone(p), v]
	return (t) => {
		const dt = timeSubtract(t, T0) + tau
		vecPlus(vecMulScalar(v, dt, pv[0]), p, pv[0])
		return pv
	}
}

// ITRS direction rotated to GCRS at T0.
function syntheticStar(direction: Vec3) {
	return matTransposeMulVec(ROTATION, direction)
}

// Geodetic latitude of the ellipsoid point (x, 0, z) on the meridian plane.
function ellipsoidLatitude(z: number) {
	const x = A * Math.sqrt(1 - (z * z) / (B * B))
	return Math.atan2(z * A * A, x * B * B)
}

// ITRS covariance rotated to the GCRS axes the solver expects.
function gcrsCovariance(itrs: Mat3) {
	return matMul(matTranspose(ROTATION), matMul(itrs, ROTATION))
}

describe('synthetic straight chord on the oblate Earth', () => {
	const Z = kilometer(3000)
	const target = syntheticBody([RANGE, 0, Z], [0, SPEED, 0])
	const star = syntheticStar([1, 0, 0])

	for (const mode of ['approximate', 'rigorous'] as OccultationPathMode[]) {
		test(mode, () => {
			const path = occultationPath(target, star, geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS, mode })
			expect(path.mode).toBe(mode)
			expect(path.shadow).toHaveLength(1)
			expect(path.central).toHaveLength(1)
			expect(timeSubtract(path.shadow[0].start, T0)).toBe(0)

			const [sample] = path.samples
			expect(timeSubtract(sample.time, T0)).toBe(0)
			expect(sample.time.scale).toBe(Timescale.TDB)
			// Axis parallel to x at height Z; the limits sit RADIUS above and below it (left = north for motion
			// toward +y with the star overhead along +x).
			expect(sample.center!.latitude).toBeCloseTo(ellipsoidLatitude(Z), 9)
			expect(sample.left!.latitude).toBeCloseTo(ellipsoidLatitude(Z + RADIUS), 9)
			expect(sample.right!.latitude).toBeCloseTo(ellipsoidLatitude(Z - RADIUS), 9)
			expect(sample.radius).toBe(RADIUS)
			// The star altitude at a meridian point (x, 0, z) is the colatitude.
			expect(sample.center!.altitude).toBeCloseTo(PI / 2 - ellipsoidLatitude(Z), 9)
			// The oblique cut makes the ground width wider than the shadow diameter.
			expect(toKilometer(sample.width!)).toBeGreaterThan(200)
			expect(sample.groundVelocity!.azimuth).toBeCloseTo(PI / 2, 2)

			if (mode === 'approximate') {
				// Untilted axis and inertial shadow speed.
				expect(sample.center!.longitude).toBeCloseTo(0, 10)
				expect(toKilometer(sample.speed) / DAYSEC).toBeCloseTo(10, 6)
				expect(sample.duration!).toBeCloseTo(20, 4)
			} else {
				// The light-time tilt v/c moves the track east by depth * v / c (~0.2 km), and the ground rotating
				// east at ~0.41 km/s slows the shadow relative to it.
				const tilt = toKilometer(A * Math.sqrt(1 - (Z * Z) / (B * B))) * (SPEED / SPEED_OF_LIGHT_AU_DAY)
				expect(toKilometer(sample.center!.longitude * A * Math.cos(ellipsoidLatitude(Z)))).toBeCloseTo(tilt, 1)
				expect(toKilometer(sample.speed) / DAYSEC).toBeCloseTo(10 - 0.4651 * Math.cos(Math.atan(Z / A)) * 0.999, 1)
				expect(sample.duration!).toBeGreaterThan(20)
			}
		})
	}

	test('a uniform height inflates the intersection surface', () => {
		const height = kilometer(3)
		const path = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS, mode: 'approximate', height })
		const a = A + height
		const b = B + height
		const x = a * Math.sqrt(1 - (Z * Z) / (b * b))
		// The point on the inflated surface, converted to geodetic latitude on the base ellipsoid.
		const geocentric = Math.atan2(Z, x)
		expect(path.samples[0].center!.latitude).toBeGreaterThan(geocentric)
		expect(path.samples[0].center!.latitude).toBeLessThan(ellipsoidLatitude(Z))
	})
})

test('a polar graze touches the Earth with one limit only', () => {
	// Axis just above the North Pole: the centerline and the left limit miss, the right limit grazes the cap.
	const target = syntheticBody([RANGE, 0, B + RADIUS / 2], [0, SPEED, 0])
	const path = occultationPath(target, syntheticStar([1, 0, 0]), geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS })

	expect(path.central).toHaveLength(0)
	expect(path.shadow).toHaveLength(1)
	expect(path.samples.length).toBeGreaterThan(0)

	for (const sample of path.samples) {
		expect(sample.center).toBeUndefined()
		expect(sample.left).toBeUndefined()
		expect(toDeg(sample.right!.latitude)).toBeGreaterThan(80)
		expect(sample.right!.altitude).toBeGreaterThanOrEqual(0)
	}

	expect(occultationPathPolylines(path, 'center')).toHaveLength(0)
	expect(occultationPathPolylines(path, 'right')).toHaveLength(1)
})

test('limb endpoints are refined where the centerline leaves the Earth', () => {
	// The axis climbs northward over the pole region, so the centerline leaves the cap during the window.
	const target = syntheticBody([RANGE, 0, B - kilometer(300)], [0, 0, SPEED])
	const path = occultationPath(target, syntheticStar([1, 0, 0]), geocenter, T0, timeShift(T0, 120 / DAYSEC), { radius: RADIUS, mode: 'approximate' })

	expect(path.central).toHaveLength(1)
	const centralEnd = path.central[0].end
	const last = path.samples.findLast((sample) => sample.center !== undefined)!
	// The last centerline sample is the refined limb point: at the central end, with the star on the horizon.
	// Altitude grows like the square root of the time from tangency, so the 1 ms default tolerance leaves ~0.1 deg.
	expect(Math.abs(timeSubtract(last.time, centralEnd)) * DAYSEC).toBeLessThan(0.01)
	expect(Math.abs(last.center!.altitude)).toBeLessThan(deg(0.2))
	expect(toDeg(last.center!.latitude)).toBeGreaterThan(89)
	// The polar crossing keeps every coordinate finite.
	for (const sample of path.samples) if (sample.center) expect(Number.isFinite(sample.center.longitude)).toBe(true)
})

test('a dateline crossing is split into antimeridian polylines', () => {
	// Star on ITRS -x: the shadow falls around longitude 180 and moves from east of it to west of it.
	const target = syntheticBody([-RANGE, kilometer(500), kilometer(1000)], [0, -SPEED, 0])
	const path = occultationPath(target, syntheticStar([-1, 0, 0]), geocenter, T0, timeShift(T0, 100 / DAYSEC), { radius: RADIUS })

	const split = occultationPathPolylines(path, 'center')
	expect(split).toHaveLength(2)
	expect(split[0].at(-1)!.longitude).toBe(PI)
	expect(split[1][0].longitude).toBe(-PI)
	expect(split[0].at(-1)!.latitude).toBe(split[1][0].latitude)
	expect(timeSubtract(split[0].at(-1)!.time, split[1][0].time)).toBe(0)
	expect(split[0].length + split[1].length).toBe(path.samples.length + 2)
	for (const vertex of split.flat()) expect(Math.abs(vertex.longitude)).toBeLessThanOrEqual(PI)

	const [unwrapped] = occultationPathPolylines(path, 'center', true)
	expect(unwrapped).toHaveLength(path.samples.length)
	expect(unwrapped[0].longitude).toBeLessThan(PI)
	expect(unwrapped.at(-1)!.longitude).toBeGreaterThan(PI)
	for (let i = 1; i < unwrapped.length; i++) expect(unwrapped[i].longitude).toBeGreaterThan(unwrapped[i - 1].longitude)
})

test('a shadow that misses the Earth yields no track', () => {
	const target = syntheticBody([RANGE, 0, 3 * A], [0, SPEED, 0])
	const path = occultationPath(target, syntheticStar([1, 0, 0]), geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS })
	expect(path.samples).toHaveLength(0)
	expect(path.shadow).toHaveLength(0)
	expect(path.central).toHaveLength(0)
	expect(occultationPathPolylines(path, 'center')).toHaveLength(0)
})

describe('uncertainty corridor', () => {
	const star = syntheticStar([1, 0, 0])
	const sigma = kilometer(10)

	test('maps an anisotropic body covariance onto the cross-track direction', () => {
		const Z = kilometer(3000)
		const target = syntheticBody([RANGE, 0, Z], [0, SPEED, 0])
		// Only the north (ITRS z) component is uncertain, which is cross-track for a shadow moving toward +y.
		const body = gcrsCovariance([0, 0, 0, 0, 0, 0, 0, 0, sigma * sigma])
		const path = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS, mode: 'approximate', uncertainty: { body, sigma: 2 } })
		const [sample] = path.samples
		const uncertainty = sample.uncertainty!

		expect(uncertainty.crossTrack / sigma).toBeCloseTo(1, 9)
		expect(uncertainty.alongTrack / sigma).toBeCloseTo(0, 6)
		expect(uncertainty.timing).toBeCloseTo(0, 4)
		expect(uncertainty.left!.latitude).toBeCloseTo(ellipsoidLatitude(Z + RADIUS + 2 * sigma), 9)
		expect(uncertainty.right!.latitude).toBeCloseTo(ellipsoidLatitude(Z - RADIUS - 2 * sigma), 9)
		// The nominal geometry is untouched by the uncertainty.
		expect(sample.center!.latitude).toBeCloseTo(ellipsoidLatitude(Z), 9)
	})

	test('symmetric fundamental-plane sigma becomes asymmetric on the ground near the limb', () => {
		const Z = 0.85 * B
		const target = syntheticBody([RANGE, 0, Z], [0, SPEED, 0])
		const body = gcrsCovariance([sigma * sigma, 0, 0, 0, sigma * sigma, 0, 0, 0, sigma * sigma])
		const path = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS, mode: 'approximate', uncertainty: { body, sigma: 3 } })
		const [sample] = path.samples
		const uncertainty = sample.uncertainty!

		expect(uncertainty.crossTrack / sigma).toBeCloseTo(1, 9)
		expect(uncertainty.alongTrack / sigma).toBeCloseTo(1, 9)
		expect(uncertainty.timing).toBeCloseTo(1, 6)
		// The north side is closer to the limb, so the same 3-sigma offset spreads farther over the ground.
		const north = uncertainty.left!.latitude - sample.left!.latitude
		const south = sample.right!.latitude - uncertainty.right!.latitude
		expect(north / south).toBeCloseTo((ellipsoidLatitude(Z + RADIUS + 3 * sigma) - ellipsoidLatitude(Z + RADIUS)) / (ellipsoidLatitude(Z - RADIUS) - ellipsoidLatitude(Z - RADIUS - 3 * sigma)), 6)
		expect(north / south).toBeGreaterThan(1.1)
	})

	test('maps the star position error with the body distance as lever arm', () => {
		const target = syntheticBody([RANGE, 0, kilometer(3000)], [0, SPEED, 0])
		const error = mas(1)
		const path = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS, mode: 'approximate', uncertainty: { source: [error * error, 0, 0, error * error] } })
		const uncertainty = path.samples[0].uncertainty!
		// 1 mas at 1 AU is ~0.725 km.
		expect(uncertainty.crossTrack / (RANGE * error)).toBeCloseTo(1, 6)
		expect(uncertainty.alongTrack / (RANGE * error)).toBeCloseTo(1, 6)
	})

	test('is omitted without covariance', () => {
		const target = syntheticBody([RANGE, 0, kilometer(3000)], [0, SPEED, 0])
		const path = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS, uncertainty: { sigma: 3 } })
		expect(path.samples[0].uncertainty).toBeUndefined()
		expect(occultationPathPolylines(path, 'corridorLeft')).toHaveLength(0)
	})
})

test('solar light deflection moves the shadow by the differential deflection', () => {
	const Z = kilometer(3000)
	const target = syntheticBody([RANGE, 0, Z], [0, SPEED, 0])
	const star = syntheticStar([1, 0, 0])
	// Sun 1 AU away along ITRS -z, i.e. 90 degrees from the star; deflection pushes the star away from the Sun.
	const sunPosition = matTransposeMulVec(ROTATION, [0, 0, -1])
	const sunSampler: PositionAndVelocityOverTime = () => [sunPosition, [0, 0, 0]]
	const plain = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS })
	const deflected = occultationPath(target, star, geocenter, T0, timeShift(T0, 10 / DAYSEC), { radius: RADIUS, sun: sunSampler })
	const shift = (deflected.samples[0].center!.latitude - plain.samples[0].center!.latitude) * A
	// The star (4.07 mas at 90 degrees) is deflected more than the body at 1 AU; its apparent direction moves north
	// (away from the Sun), so the shadow moves south by roughly a km.
	expect(toKilometer(shift)).toBeLessThan(-0.2)
	expect(toKilometer(shift)).toBeGreaterThan(-3)
})

describe('causal ray order', () => {
	const MODES = ['rigorous', 'approximate'] as OccultationPathMode[]

	// Static barycentric body at `position` (AU); records the latest epoch it was sampled at.
	function staticBody(position: Vec3) {
		const state = { latest: Number.NEGATIVE_INFINITY }
		const sampler: PositionAndVelocityOverTime = (t) => {
			state.latest = Math.max(state.latest, timeSubtract(t, T0))
			return [position, [0, 0, 0]]
		}
		return { sampler, state }
	}

	for (const mode of MODES) {
		test(`a body behind the Earth casts no shadow on it (${mode})`, () => {
			// Light from the star on +x reaches the Earth before the body at -1 AU, so nothing is occulted.
			const { sampler, state } = staticBody([-1, 0, 0])
			const stop = timeShift(T0, 60 / DAYSEC)
			const path = occultationPath(sampler, [1, 0, 0], geocenter, T0, stop, { radius: RADIUS, mode })
			expect(path.shadow).toHaveLength(0)
			expect(path.central).toHaveLength(0)
			expect(path.samples).toHaveLength(0)
			// The body is never sampled after the window: a negative light time is not used.
			expect(state.latest).toBeLessThanOrEqual(timeSubtract(stop, T0))
		})

		test(`the same body in front of the Earth casts a central shadow (${mode})`, () => {
			const path = occultationPath(staticBody([1, 0, 0]).sampler, [1, 0, 0], geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS, mode })
			expect(path.shadow).toHaveLength(1)
			expect(path.central).toHaveLength(1)
			// The sub-body point sees the star at the zenith.
			expect(toDeg(path.samples[0].center!.altitude)).toBeGreaterThan(89)
		})

		test(`a body just behind the limb casts no shadow (${mode})`, () => {
			// The axis grazes the Earth inside the limb, but the body sits half an Earth radius downstream of the
			// geocenter, so the ray would hit the ground before reaching it.
			const body = syntheticBody([-0.5 * A, 0.95 * A, 0], [0, 0, 0])
			const path = occultationPath(body, syntheticStar([1, 0, 0]), geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS, mode, lightTimeIterations: 0 })
			expect(path.shadow).toHaveLength(0)
			expect(path.samples).toHaveLength(0)
		})

		test(`a finite source must lie beyond the body (${mode})`, () => {
			// Source at +1 AU and body at +2 AU: the light travels away from the Earth after passing the body.
			const source: PositionAndVelocityOverTime = () => [
				[1, 0, 0],
				[0, 0, 0],
			]
			const behind = occultationPath(staticBody([2, 0, 0]).sampler, source, geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS, mode })
			expect(behind.shadow).toHaveLength(0)
			expect(behind.samples).toHaveLength(0)

			const beyond: PositionAndVelocityOverTime = () => [
				[2, 0, 0],
				[0, 0, 0],
			]
			const front = occultationPath(staticBody([1, 0, 0]).sampler, beyond, geocenter, T0, timeShift(T0, 60 / DAYSEC), { radius: RADIUS, mode })
			expect(front.central).toHaveLength(1)
			// The cone from a source 1 AU behind the body doubles its radius at the Earth.
			expect(front.samples[0].radius / RADIUS).toBeCloseTo(2, 6)
		})
	}
})

describe('separate passes', () => {
	// A body whose shadow swings north-south across the Earth twice: z = 1.5 A cos(2 PI t / 120 s) at 1 AU, sampled
	// without light time so the passes fall around t = 30 s and t = 90 s.
	const PERIOD = 120 / DAYSEC
	const target: PositionAndVelocityOverTime = (t) => {
		const phase = (2 * PI * timeSubtract(t, T0)) / PERIOD
		const position = matTransposeMulVec(ROTATION, [RANGE, 0, 1.5 * A * Math.cos(phase)])
		const velocity = matTransposeMulVec(ROTATION, [0, 0, ((-1.5 * A * 2 * PI) / PERIOD) * Math.sin(phase)])
		return [position, velocity]
	}

	test('two shadow intervals give two polylines per line', () => {
		const sigma = kilometer(30)
		const body = gcrsCovariance([sigma * sigma, 0, 0, 0, sigma * sigma, 0, 0, 0, sigma * sigma])
		const path = occultationPath(target, syntheticStar([1, 0, 0]), geocenter, T0, timeShift(T0, PERIOD), { radius: RADIUS, mode: 'approximate', step: 1 / DAYSEC, lightTimeIterations: 0, uncertainty: { body } })
		expect(path.shadow).toHaveLength(2)
		expect(timeSubtract(path.shadow[0].start, T0)).toBeGreaterThan(0)
		expect(timeSubtract(path.shadow[1].end, T0)).toBeLessThan(PERIOD)
		expect(path.central).toHaveLength(2)

		for (const line of ['center', 'left', 'right', 'corridorLeft', 'corridorRight'] as const) {
			expect(occultationPathPolylines(path, line)).toHaveLength(2)
			expect(occultationPathPolylines(path, line, true)).toHaveLength(2)
		}
	})

	test('a pass boundary breaks a line even when both sides have points', () => {
		const point = (longitude: number) => ({ longitude: deg(longitude), latitude: 0, altitude: deg(45) })
		const sample = (minutes: number, longitude: number): OccultationPathSample => ({ time: timeShift(T0, minutes / 1440), center: point(longitude), radius: RADIUS, speed: 1 })
		const interval = (from: number, to: number) => ({ start: timeShift(T0, from / 1440), end: timeShift(T0, to / 1440) })
		// The first pass crosses the antimeridian; the second is far away and later.
		const path: OccultationPath = {
			mode: 'rigorous',
			samples: [sample(0, 178), sample(1, -178), sample(10, 10), sample(11, 20)],
			shadow: [interval(0, 1), interval(10, 11)],
			central: [interval(0, 1), interval(10, 11)],
		}

		const split = occultationPathPolylines(path, 'center')
		expect(split.map((polyline) => polyline.length)).toEqual([2, 2, 2])
		expect(split[2][0].longitude).toBe(deg(10))

		const unwrapped = occultationPathPolylines(path, 'center', true)
		expect(unwrapped.map((polyline) => polyline.length)).toEqual([2, 2])
		expect(toDeg(unwrapped[0][1].longitude)).toBeCloseTo(182, 12)
		expect(unwrapped[1][0].longitude).toBe(deg(10))
	})
})

test('rejects an invalid light-time iteration count', () => {
	const target = syntheticBody([RANGE, 0, 0], [0, SPEED, 0])
	expect(() => occultationPath(target, [1, 0, 0], geocenter, T0, timeShift(T0, 0.001), { radius: RADIUS, lightTimeIterations: 17 })).toThrow()
})

describe('a real asteroid track agrees with the per-site predictor', () => {
	// Heliocentric Ceres state (ICRF equatorial, AU/day) at JD 2461200.5 TDB from JPL Horizons.
	const epoch = time(2461200.5, 0, Timescale.TDB)
	const orbit = new KeplerOrbit([1.414905393343522, 2.2479053286939, 7.722476360317566e-1], [-9.08092698547858e-3, 3.499459682146027e-3, 3.499457832664595e-3], epoch, GM_SUN_PITJEVA_2005, matIdentity())
	const target: PositionAndVelocityOverTime = (t) => {
		const [sp, sv] = sun(t)
		const [hp, hv] = orbit.at(t)
		return [vecPlus(sp, hp), vecPlus(sv, hv)]
	}
	const radius = kilometer(200)
	// A star exactly on the light-time-corrected geocentric direction of Ceres at `anchor` (UTC).
	const anchor = time(2461200.5, 0.3, Timescale.UTC)
	const star = topocentricDirection(target, earth, anchor, 3)

	// Topocentric light-time-corrected separation and range from a ground point, via the independent observer path.
	function view(point: { longitude: number; latitude: number }, at: Time) {
		const site = geodeticLocation(point.longitude, point.latitude, 0, Ellipsoid.IERS2010)
		const observer: PositionAndVelocityOverTime = (t) => observerState(t, earth(t), site)
		const direction = topocentricDirection(target, observer, at, 3)
		return { observer, separation: separationFrom(direction, star), range: vecLength(direction) }
	}

	const start = timeShift(anchor, -240 / DAYSEC)
	const stop = timeShift(anchor, 240 / DAYSEC)
	const rigorous = occultationPath(target, star, earth, start, stop, { radius, step: 20 / DAYSEC })
	const approximate = occultationPath(target, star, earth, start, stop, { radius, step: 20 / DAYSEC, mode: 'approximate' })

	test('samples are chronological in the input timescale', () => {
		expect(rigorous.samples.length).toBeGreaterThan(5)
		for (let i = 1; i < rigorous.samples.length; i++) expect(timeSubtract(rigorous.samples[i].time, rigorous.samples[i - 1].time)).toBeGreaterThan(0)
		for (const sample of rigorous.samples) expect(sample.time.scale).toBe(Timescale.UTC)
	})

	test('every rigorous centerline point sees a central occultation at that instant', () => {
		for (const sample of rigorous.samples) {
			if (sample.center === undefined) continue
			const { separation, range } = view(sample.center, sample.time)
			// Lateral miss distance below a metre.
			expect(toKilometer(separation * range)).toBeLessThan(0.001)
		}
	})

	test('every rigorous limit point grazes the disk at the closest approach', () => {
		for (const sample of rigorous.samples) {
			for (const point of [sample.left, sample.right]) {
				if (point === undefined) continue
				const now = view(point, sample.time)
				expect(toKilometer(Math.abs(now.separation - Math.asin(radius / now.range)) * now.range)).toBeLessThan(0.001)
				// Envelope: the separation is a minimum in time at the limit.
				expect(view(point, timeShift(sample.time, -5 / DAYSEC)).separation).toBeGreaterThan(now.separation)
				expect(view(point, timeShift(sample.time, 5 / DAYSEC)).separation).toBeGreaterThan(now.separation)
			}
		}
	})

	test('a centerline site gets the predicted appulse time and duration', () => {
		const sample = rigorous.samples.find((s) => s.center !== undefined && s.center.altitude > deg(30))!
		const { observer } = view(sample.center!, sample.time)
		const [candidate] = occultationCandidates(target, star, observer, timeShift(sample.time, -30 / DAYSEC), timeShift(sample.time, 30 / DAYSEC), { radius, lightTimeIterations: 3, step: 5 / DAYSEC, tolerance: 1e-9 })
		expect(candidate.occultation).toBe(true)
		expect(Math.abs(timeSubtract(candidate.time, sample.time)) * DAYSEC).toBeLessThan(0.01)
		expect(candidate.duration! / sample.duration!).toBeCloseTo(1, 3)
	})

	test('the approximate mode misses by the light-time tilt, below a kilometre', () => {
		let worst = 0
		for (const sample of approximate.samples) {
			if (sample.center === undefined) continue
			const { separation, range } = view(sample.center, sample.time)
			worst = Math.max(worst, toKilometer(separation * range))
		}
		expect(worst).toBeGreaterThan(0.01)
		expect(worst).toBeLessThan(1)
	})

	test('contacts bracket the samples', () => {
		expect(rigorous.shadow).toHaveLength(1)
		expect(rigorous.central).toHaveLength(1)
		const [shadow] = rigorous.shadow
		const [central] = rigorous.central
		expect(timeSubtract(central.start, shadow.start)).toBeGreaterThan(0)
		expect(timeSubtract(shadow.end, central.end)).toBeGreaterThan(0)
		expect(timeSubtract(rigorous.samples[0].time, shadow.start)).toBeCloseTo(0, 12)
	})
})

test('central line of the 2024-04-08 total solar eclipse matches the NASA path table', async () => {
	// A solar eclipse is the occultation of the Sun's centre (a finite-distance point source) by the Moon, so its
	// central line is this solver's axis with a cone-shaped shadow. Sun, Earth and Moon from DE440s.
	await using source = fileHandleSource(await fs.open('data/de440s.bsp'))
	const spk = readSpk(await readDaf(source))
	const ssbSun = (await spk.segment(Naif.SSB, Naif.SUN))!
	const ssbEmb = (await spk.segment(Naif.SSB, Naif.EMB))!
	const embEarth = (await spk.segment(Naif.EMB, Naif.EARTH))!
	const embMoon = (await spk.segment(Naif.EMB, Naif.MOON))!

	const solar: PositionAndVelocityOverTime = (t) => ssbSun.at(t)
	const terrestrial: PositionAndVelocityOverTime = (t) => {
		const [bp, bv] = ssbEmb.at(t)
		const [ep, ev] = embEarth.at(t)
		return [vecPlus(bp, ep), vecPlus(bv, ev)]
	}
	const lunar: PositionAndVelocityOverTime = (t) => {
		const [bp, bv] = ssbEmb.at(t)
		const [mp, mv] = embMoon.at(t)
		return [vecPlus(bp, mp), vecPlus(bv, mv)]
	}

	// NASA/GSFC umbral path table, https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2024Apr08Tpath.html, computed
	// with delta T = 70.6 s and tabulated in UT (UT1): UT1 - UTC = (TT - UTC) - delta T = 69.184 - 70.6 s.
	// NASA applies its own lunar ephemeris and centre-of-figure offset (~0.5" ~ 1 km), the residual floor here.
	const start = time(2460408.5, 16.5 / 24, Timescale.UT1)
	start.providers = { dut1: () => 69.184 - 70.6, pm: NO_POLAR_MOTION }
	const path = occultationPath(lunar, solar, terrestrial, start, timeShift(start, 3 / 24), { radius: kilometer(1737.4), step: 60 / DAYSEC })

	expect(path.central).toHaveLength(1)
	expect(path.samples.every((sample) => sample.time.scale === Timescale.UT1)).toBe(true)

	// NASA "Limits (Start)": central line at 07 49.5S 158 31.9W, where the axis first meets the Earth at sunrise.
	const first = path.samples.find((sample) => sample.center !== undefined)!
	expect(Math.abs(timeSubtract(first.time, path.central[0].start)) * DAYSEC).toBeLessThan(0.01)
	expect(Math.abs(toDeg(first.center!.latitude) + 7.825) * 60).toBeLessThan(0.5)
	expect(Math.abs(toDeg(first.center!.longitude) + 158.531667) * 60).toBeLessThan(0.5)

	const rows = [
		[17, 1.711667, -129.686667],
		[18, 20.32, -108.763333],
		[19, 37.328333, -89.776667],
	] as const

	for (const [hour, latitude, longitude] of rows) {
		const sample = path.samples.find((s) => Math.abs(timeSubtract(s.time, start) * 24 + 16.5 - hour) < 1e-9)!
		expect(Math.abs(toDeg(sample.center!.latitude) - latitude) * 60).toBeLessThan(0.6)
		expect(Math.abs(toDeg(sample.center!.longitude) - longitude) * 60 * Math.cos(deg(latitude))).toBeLessThan(0.6)
		// The point-source cone is slightly wider than the Moon: radius * (1 + Moon distance / Sun distance).
		expect(toKilometer(sample.radius)).toBeCloseTo(1741.6, 0)
	}
})

// Published stellar occultation path tables from the RASNZ Occultation Section (Occult format). Each row is kept
// verbatim: centre longitude/latitude, UT, star altitude/azimuth, Sun altitude, path limits 1-2 (nominal shadow
// edges), error limits 3-4 (edges moved out by the published 1-sigma) and the Crn column. On a fixed-longitude row
// the limits are latitudes; on a fixed-latitude row they are longitudes. Limit 1 and 3 lie right of the shadow
// motion. The asteroid comes from the published OrbFit osculating elements at the event epoch (heliocentric,
// ecliptic J2000 with the IAU 1976 obliquity 84381.448" that OrbFit uses; the library's default 84381.411"
// ecliptic rotation would move these shadows by ~67 km), the star from the published Gaia position at the event
// date, Sun and Earth from DE440s.
describe('published RASNZ stellar occultation path tables', () => {
	const ORBFIT_ECLIPTIC = matTranspose(matRotX(arcsec(84381.448)))
	// OrbFit's Gaussian solar GM, AU³/day².
	const ORBFIT_GM_SUN = 0.01720209895 ** 2

	interface PublishedRow {
		// Fixed coordinate of the row (longitude or latitude), radians.
		readonly fixed: number
		// Centre coordinate along the other axis, radians.
		readonly center: number
		// UT of the central occultation, seconds of the day.
		readonly seconds: number
		// Limits 1-4 along the other axis, radians.
		readonly limits: readonly [number, number, number, number]
	}

	// Parses sexagesimal triples, keeping the sign of the degree token (so "-0" stays negative). The first two
	// columns are always longitude then latitude, so the fixed coordinate is the first on fixed-longitude rows and
	// the second on fixed-latitude rows.
	function parseRows(table: string, fixed: 'longitude' | 'latitude'): PublishedRow[] {
		return table.split('\n').map((line) => {
			const tokens = line.trim().split(/\s+/)
			const angle = (index: number) => deg((tokens[index].startsWith('-') ? -1 : 1) * (Math.abs(+tokens[index]) + +tokens[index + 1] / 60 + +tokens[index + 2] / 3600))
			return {
				fixed: fixed === 'longitude' ? angle(0) : angle(3),
				center: fixed === 'longitude' ? angle(3) : angle(0),
				seconds: +tokens[6] * 3600 + +tokens[7] * 60 + +tokens[8],
				limits: [angle(12), angle(15), angle(18), angle(21)],
			}
		})
	}

	// Barycentric asteroid from osculating elements (degrees, AU) at an MJD TT epoch.
	function orbitFromElements(a: number, e: number, inclination: number, node: number, perihelion: number, meanAnomaly: number, mjd: number): PositionAndVelocityOverTime {
		const orbit = KeplerOrbit.meanAnomaly(a * (1 - e * e), e, deg(inclination), deg(node), deg(perihelion), deg(meanAnomaly), timeMJD(mjd, Timescale.TT), ORBFIT_GM_SUN, ORBFIT_ECLIPTIC)
		return (t) => {
			const [sp, sv] = ephemeris.sun(t)
			const [hp, hv] = orbit.at(t)
			return [vecPlus(sp, hp), vecPlus(sv, hv)]
		}
	}

	// Signed cross-track distance (km) of a published point from a computed line, positive left of the shadow
	// motion, in a local equirectangular plane around the point (adequate for few-km offsets and short segments).
	// The distance is to the nearest point of the polyline; its side comes from the nearest segment's direction.
	function crossTrackOffset(path: OccultationPath, line: OccultationPathLine, longitude: number, latitude: number) {
		const scale = toKilometer(A)
		const local = (vertex: { longitude: number; latitude: number }) => [normalizePI(vertex.longitude - longitude) * Math.cos(latitude) * scale, (vertex.latitude - latitude) * scale] as const
		let best: number | undefined

		for (const polyline of occultationPathPolylines(path, line, true)) {
			for (let i = 1; i < polyline.length; i++) {
				const [ax, ay] = local(polyline[i - 1])
				const [bx, by] = local(polyline[i])
				const dx = bx - ax
				const dy = by - ay
				const length = dx * dx + dy * dy
				if (!(length > 0)) continue
				const along = clamp(-(ax * dx + ay * dy) / length, 0, 1)
				const distance = Math.hypot(ax + along * dx, ay + along * dy)
				const offset = Math.sign(dy * ax - dx * ay) * distance
				if (best === undefined || distance < Math.abs(best)) best = offset
			}
		}

		return best!
	}

	// UT (seconds of the day) where the computed centerline crosses a meridian or a parallel.
	function centerCrossing(path: OccultationPath, along: 'longitude' | 'latitude', value: number, midnight: number) {
		for (const polyline of occultationPathPolylines(path, 'center', true)) {
			for (let i = 1; i < polyline.length; i++) {
				const a = polyline[i - 1]
				const b = polyline[i]
				const target = along === 'longitude' ? a.longitude + normalizePI(value - a.longitude) : value
				if ((a[along] - target) * (b[along] - target) > 0 || a[along] === b[along]) continue
				const fraction = (target - a[along]) / (b[along] - a[along])
				return (toJulianDay(timeShift(a.time, fraction * timeSubtract(b.time, a.time))) - midnight) * DAYSEC
			}
		}

		return undefined
	}

	const LINES = ['center', 'right', 'left', 'corridorRight', 'corridorLeft'] as const

	// Signed offsets of every published point of a row from its computed line, centre first.
	function rowOffsets(path: OccultationPath, row: PublishedRow, fixed: 'longitude' | 'latitude') {
		return [row.center, ...row.limits].map((value, k) => (fixed === 'longitude' ? crossTrackOffset(path, LINES[k], row.fixed, value) : crossTrackOffset(path, LINES[k], value, row.fixed)))
	}

	// Ephemerides shared by both events, closed once all tests ran.
	const ephemeris = {} as { sun: PositionAndVelocityOverTime; earth: PositionAndVelocityOverTime; close: () => Promise<void> }

	beforeAll(async () => {
		const source = fileHandleSource(await fs.open('data/de440s.bsp'))
		const spk = readSpk(await readDaf(source))
		const ssbSun = (await spk.segment(Naif.SSB, Naif.SUN))!
		const ssbEmb = (await spk.segment(Naif.SSB, Naif.EMB))!
		const embEarth = (await spk.segment(Naif.EMB, Naif.EARTH))!
		ephemeris.sun = (t) => ssbSun.at(t)
		ephemeris.earth = (t) => {
			const [bp, bv] = ssbEmb.at(t)
			const [ep, ev] = embEarth.at(t)
			return [vecPlus(bp, ep), vecPlus(bv, ev)]
		}
		ephemeris.close = () => source[Symbol.asyncDispose]()
	})

	afterAll(() => ephemeris.close())

	// https://www.occultations.org.nz/planet/2022/updates/220923_307_77320_u.htm, update of 2022 Aug 20 02:30 UT
	// ("Prediction of 2022 Aug 20.1"): (307) Nike, diameter 58.2 km, occults TYC 6880-02029-1 (Gaia EDR3, J2000 with
	// proper motion to date RA 19 25 51.0196, Dec -25 16 11.319). 1-sigma uncertainty 0.11 path widths, shadow speed
	// 5.4818 km/s, maximum duration 10.620 s. Fixed-longitude rows.
	const NIKE = `
    134  0  0   -39  5 46    7 56  3.5    56    77    12  -39 22 24  -38 49 10  -39 26  4  -38 45 31   0.27
    135  0  0   -39 14 40    7 56 18.2    57    76    11  -39 31 15  -38 58  5  -39 34 55  -38 54 26   0.27
    136  0  0   -39 23  9    7 56 33.0    58    75    10  -39 39 43  -39  6 36  -39 43 22  -39  2 57   0.27
    137  0  0   -39 31 12    7 56 47.9    59    73     9  -39 47 45  -39 14 41  -39 51 24  -39 11  3   0.27
    138  0  0   -39 38 51    7 57  2.8    59    72     8  -39 55 22  -39 22 22  -39 59  1  -39 18 44   0.27
    139  0  0   -39 46  6    7 57 17.9    60    71     8  -40  2 35  -39 29 37  -40  6 14  -39 26  0   0.27
    140  0  0   -39 52 55    7 57 32.9    61    69     7  -40  9 23  -39 36 28  -40 13  1  -39 32 51   0.27
    141  0  0   -39 59 20    7 57 48.1    61    68     6  -40 15 47  -39 42 54  -40 19 24  -39 39 17   0.27
    142  0  0   -40  5 20    7 58  3.3    62    67     5  -40 21 46  -39 48 55  -40 25 23  -39 45 19   0.27
    143  0  0   -40 10 55    7 58 18.6    63    65     4  -40 27 20  -39 54 32  -40 30 57  -39 50 55   0.27
    144  0  0   -40 16  6    7 58 34.0    64    64     3  -40 32 30  -39 59 44  -40 36  6  -39 56  7   0.27
    145  0  0   -40 20 52    7 58 49.4    64    62     3  -40 37 15  -40  4 31  -40 40 51  -40  0 55   0.27
    146  0  0   -40 25 14    7 59  4.9    65    60     2  -40 41 35  -40  8 53  -40 45 12  -40  5 17   0.27
    147  0  0   -40 29 11    7 59 20.5    66    59     1  -40 45 31  -40 12 51  -40 49  8  -40  9 15   0.27
    148  0  0   -40 32 43    7 59 36.1    66    57     0  -40 49  3  -40 16 24  -40 52 39  -40 12 49   0.27
    149  0  0   -40 35 51    7 59 51.8    67    55    -1  -40 52 10  -40 19 33  -40 55 46  -40 15 57   0.27
    150  0  0   -40 38 34    8  0  7.5    67    53    -1  -40 54 53  -40 22 17  -40 58 29  -40 18 41   0.27
    151  0  0   -40 40 53    8  0 23.3    68    51    -2  -40 57 12  -40 24 36  -41  0 47  -40 21  1   0.27
    152  0  0   -40 42 48    8  0 39.1    69    49    -3  -40 59  6  -40 26 31  -41  2 41  -40 22 56   0.27
    153  0  0   -40 44 17    8  0 55.0    69    47    -4  -41  0 35  -40 28  1  -41  4 11  -40 24 26   0.27
    154  0  0   -40 45 23    8  1 11.0    70    45    -5  -41  1 40  -40 29  7  -41  5 16  -40 25 32   0.27
    155  0  0   -40 46  4    8  1 27.0    70    42    -5  -41  2 21  -40 29 48  -41  5 56  -40 26 13   0.27
    156  0  0   -40 46 20    8  1 43.1    71    40    -6  -41  2 37  -40 30  4  -41  6 13  -40 26 29   0.27
    157  0  0   -40 46 12    8  1 59.2    71    37    -7  -41  2 29  -40 29 56  -41  6  5  -40 26 21   0.27
    158  0  0   -40 45 39    8  2 15.3    72    34    -8  -41  1 57  -40 29 23  -41  5 32  -40 25 48   0.27
    159  0  0   -40 44 42    8  2 31.5    72    32    -9  -41  0 59  -40 28 26  -41  4 35  -40 24 51   0.27
    160  0  0   -40 43 20    8  2 47.8    73    29    -9  -40 59 38  -40 27  4  -41  3 14  -40 23 29   0.27
    161  0  0   -40 41 34    8  3  4.1    73    26   -10  -40 57 52  -40 25 17  -41  1 28  -40 21 42   0.27
    162  0  0   -40 39 23    8  3 20.5    73    23   -11  -40 55 41  -40 23  6  -40 59 17  -40 19 31   0.27
    163  0  0   -40 36 47    8  3 36.9    74    19   -12  -40 53  6  -40 20 30  -40 56 42  -40 16 54   0.27
    164  0  0   -40 33 47    8  3 53.3    74    16   -13  -40 50  6  -40 17 29  -40 53 42  -40 13 53   0.27
    165  0  0   -40 30 22    8  4  9.9    74    12   -13  -40 46 42  -40 14  3  -40 50 18  -40 10 27   0.27
    166  0  0   -40 26 32    8  4 26.4    75     9   -14  -40 42 52  -40 10 12  -40 46 29  -40  6 36   0.27
    167  0  0   -40 22 17    8  4 43.0    75     5   -15  -40 38 38  -40  5 56  -40 42 15  -40  2 20   0.27
    168  0  0   -40 17 37    8  4 59.6    75     1   -16  -40 33 59  -40  1 16  -40 37 36  -39 57 39   0.27
    169  0  0   -40 12 32    8  5 16.3    75   358   -17  -40 28 56  -39 56 10  -40 32 33  -39 52 33   0.27
    170  0  0   -40  7  2    8  5 33.1    75   354   -18  -40 23 27  -39 50 39  -40 27  4  -39 47  2   0.27
    171  0  0   -40  1  7    8  5 49.8    75   350   -18  -40 17 33  -39 44 43  -40 21 11  -39 41  6   0.27
    172  0  0   -39 54 47    8  6  6.6    75   346   -19  -40 11 14  -39 38 22  -40 14 52  -39 34 45   0.27
    173  0  0   -39 48  2    8  6 23.5    75   342   -20  -40  4 31  -39 31 35  -40  8  9  -39 27 58   0.27
    174  0  0   -39 40 52    8  6 40.4    75   339   -21  -39 57 21  -39 24 23  -40  1  0  -39 20 45   0.27
    175  0  0   -39 33 16    8  6 57.3    74   335   -22  -39 49 47  -39 16 46  -39 53 26  -39 13  8   0.27
    176  0  0   -39 25 14    8  7 14.3    74   331   -22  -39 41 47  -39  8 43  -39 45 26  -39  5  5   0.27
    177  0  0   -39 16 48    8  7 31.3    74   328   -23  -39 33 22  -39  0 15  -39 37  1  -38 56 36   0.27
    178  0  0   -39  7 55    8  7 48.3    74   325   -24  -39 24 31  -38 51 20  -39 28 11  -38 47 41   0.27
    179  0  0   -38 58 37    8  8  5.4    73   321   -25  -39 15 15  -38 42  1  -39 18 55  -38 38 21   0.27
    180  0  0   -38 48 53    8  8 22.5    73   318   -26  -39  5 33  -38 32 15  -39  9 14  -38 28 35   0.27`

	test('(307) Nike 2022-09-23 reproduces the published centre, limits and error limits', () => {
		const target = orbitFromElements(2.9058591039, 0.1438486187, 6.1258475625, 100.9500991912, 324.0844431936, 257.9221618725, 59845.33756944)
		const star = eraS2c(hour(19 + 25 / 60 + 51.0196 / 3600), -deg(25 + 16 / 60 + 11.319 / 3600))
		const start = timeYMDHMS(2022, 9, 23, 7, 55, 0, Timescale.UTC)
		// The published error limits are the edges moved by 0.11 diameters: an isotropic 1-sigma body position error.
		const sigma = kilometer(0.11 * 58.2)
		const body: Mat3 = [sigma * sigma, 0, 0, 0, sigma * sigma, 0, 0, 0, sigma * sigma]
		const path = occultationPath(target, star, ephemeris.earth, start, timeShift(start, 15 / 1440), { radius: kilometer(29.1), step: 2 / DAYSEC, uncertainty: { body } })
		const midnight = toJulianDay(timeYMDHMS(2022, 9, 23, 0, 0, 0, Timescale.UTC))

		for (const row of parseRows(NIKE.trim(), 'longitude')) {
			// Table resolution is 1" (~0.03 km) and 0.1 s. The residual, a uniform ~0.1 km and +0.15 s, is the level of
			// the star's 0.9 mas Gaia parallax, which the table does not appear to apply: applying it removes the
			// cross-track residual but turns the time residual into -0.17 s.
			for (const offset of rowOffsets(path, row, 'longitude')) expect(Math.abs(offset)).toBeLessThan(0.25)
			expect(Math.abs(centerCrossing(path, 'longitude', row.fixed, midnight)! - row.seconds)).toBeLessThan(0.3)
		}

		// The published speed and duration are geocentric, which is what the approximate mode reports.
		const approximate = occultationPath(target, star, ephemeris.earth, timeYMDHMS(2022, 9, 23, 8, 2, 0, Timescale.UTC), timeYMDHMS(2022, 9, 23, 8, 2, 1, Timescale.UTC), { radius: kilometer(29.1), mode: 'approximate' })
		expect(toKilometer(approximate.samples[0].speed) / DAYSEC).toBeCloseTo(5.4818, 2)
		expect(approximate.samples[0].duration!).toBeCloseTo(10.62, 1)
	})

	// https://www.occultations.org.nz/planet/2019/updates/191128_347_62182_u.htm, update of 2019 Jul 21 08:18 UT:
	// (347) Pariana, diameter 50.5 km, occults TYC 1879-00902-1 (Gaia DR2, J2000 with proper motion to date RA
	// 06 28 39.9868, Dec +23 06 41.243). 1-sigma uncertainty 0.37 path widths, time uncertainty 3 s. The path starts
	// just east of the antimeridian. The table is stamped "Prediction of 2019 Jul 21.0", hours before the update
	// whose elements the page lists, and the whole corridor sits ~8.6 km north of the one those elements give, a
	// rigid offset well inside the published 1-sigma; the corridor shape is compared, not its absolute position.
	const PARIANA_FIXED_LATITUDE = `
    179 21 46   -39  0  0   14  8 47    28   359   -22  179 57 15  178 46  4 -179 36 32  178 19 23   1.16
    178 16  3   -38  0  0   14  9  0    29   360   -23  178 51 29  177 40 22  179 17 39  177 13 43   1.16
    177  9  8   -37  0  0   14  9 13    30     1   -24  177 44 34  176 33 28  178 10 43  176  6 48   1.16
    176  0 58   -36  0  0   14  9 27    31     2   -26  176 36 25  175 25 14  177  2 36  174 58 32   1.16
    174 51 25   -35  0  0   14  9 41    32     3   -27  175 26 57  174 15 36  175 53 11  173 48 49   1.16
    173 40 23   -34  0  0   14  9 56    33     5   -28  174 16  4  173  4 26  174 42 22  172 37 32   1.16
    172 27 46   -33  0  0   14 10 11    34     6   -30  173  3 37  171 51 37  173 30  3  171 24 34   1.16
    171 13 25   -32  0  0   14 10 28    35     7   -31  171 49 29  170 37  1  172 16  5  170  9 47   1.16
    169 57 11   -31  0  0   14 10 44    36     9   -32  170 33 32  169 20 29  171  0 20  168 53  0   1.16
    168 38 54   -30  0  0   14 11  2    36    10   -34  169 15 37  168  1 50  169 42 40  167 34  4   1.15
    167 18 24   -29  0  0   14 11 20    37    12   -35  167 55 32  166 40 54  168 22 53  166 12 47   1.15
    165 55 29   -28  0  0   14 11 39    38    13   -36  166 33  6  165 17 26  167  0 48  164 48 55   1.15
    164 29 52   -27  0  0   14 11 59    39    15   -38  165  8  5  163 51 13  165 36 12  163 22 13   1.15
    163  1 19   -26  0  0   14 12 19    39    17   -39  163 40 13  162 21 56  164  8 49  161 52 22   1.15
    161 29 29   -25  0  0   14 12 40    40    19   -41  162  9 11  160 49 15  162 38 21  160 19  1   1.15
    159 53 59   -24  0  0   14 13  2    40    21   -42  160 34 38  159 12 45  161  4 28  158 41 45   1.15
    158 14 22   -23  0  0   14 13 26    41    23   -44  158 56  7  157 31 58  159 26 45  157  0  2   1.15
    156 30  4   -22  0  0   14 13 50    41    25   -45  157 13  8  155 46 16  157 44 41  155 13 14   1.15
    154 40 22   -21  0  0   14 14 15    41    27   -46  155 25  1  153 54 54  155 57 39  153 20 33   1.15
    152 44 25   -20  0  0   14 14 42    41    30   -48  153 30 56  151 56 55  154  4 54  151 20 58   1.15
    150 41  2   -19  0  0   14 15 10    41    32   -49  151 29 52  149 51  2  152  5 26  149 13  5   1.15`
	const PARIANA_FIXED_LONGITUDE = `
    149  0  0   -18 13 48   14 15 32    41    34   -50  -17 50 57  -18 36 51  -17 34  5  -18 54  6   1.15
    148  0  0   -17 47 36   14 15 46    41    35   -51  -17 24 54  -18 10 30  -17  8 10  -18 27 37   1.14
    147  0  0   -17 22 20   14 15 59    41    36   -51  -16 59 46  -17 45  4  -16 43  8  -18  2  5   1.14
    146  0  0   -16 57 58   14 16 12    40    37   -52  -16 35 33  -17 20 34  -16 19  1  -17 37 28   1.14
    145  0  0   -16 34 31   14 16 25    40    38   -52  -16 12 14  -16 56 58  -15 55 48  -17 13 46   1.14
    144  0  0   -16 11 59   14 16 38    40    40   -53  -15 49 50  -16 34 18  -15 33 29  -16 51  0   1.14
    143  0  0   -15 50 21   14 16 51    39    41   -53  -15 28 19  -16 12 33  -15 12  4  -16 29  9   1.14
    142  0  0   -15 29 37   14 17  3    39    42   -53  -15  7 42  -15 51 42  -14 51 32  -16  8 13   1.14
    141  0  0   -15  9 47   14 17 16    39    43   -54  -14 47 59  -15 31 45  -14 31 54  -15 48 11   1.14
    140  0  0   -14 50 51   14 17 28    38    43   -54  -14 29  9  -15 12 43  -14 13  8  -15 29  4   1.14
    139  0  0   -14 32 49   14 17 40    38    44   -54  -14 11 13  -14 54 34  -13 55 16  -15 10 51   1.14
    138  0  0   -14 15 40   14 17 52    37    45   -54  -13 54  9  -14 37 20  -13 38 17  -14 53 32   1.14
    137  0  0   -13 59 24   14 18  4    37    46   -54  -13 37 59  -14 20 59  -13 22 10  -14 37  7   1.14
    136  0  0   -13 44  2   14 18 16    37    47   -54  -13 22 41  -14  5 32  -13  6 56  -14 21 36   1.14
    135  0  0   -13 29 32   14 18 27    36    48   -55  -13  8 16  -13 50 58  -12 52 34  -14  6 58   1.14
    134  0  0   -13 15 56   14 18 39    35    49   -55  -12 54 44  -13 37 17  -12 39  5  -13 53 15   1.15
    133  0  0   -13  3 12   14 18 50    35    49   -55  -12 42  4  -13 24 29  -12 26 28  -13 40 24   1.15
    132  0  0   -12 51 21   14 19  1    34    50   -54  -12 30 17  -13 12 35  -12 14 43  -13 28 27   1.15
    131  0  0   -12 40 23   14 19 12    34    51   -54  -12 19 22  -13  1 34  -12  3 51  -13 17 23   1.15
    130  0  0   -12 30 18   14 19 23    33    51   -54  -12  9 19  -12 51 25  -11 53 50  -13  7 12   1.15
    129  0  0   -12 21  5   14 19 33    32    52   -54  -12  0  9  -12 42 10  -11 44 42  -12 57 55   1.15
    128  0  0   -12 12 45   14 19 43    32    53   -54  -11 51 51  -12 33 47  -11 36 26  -12 49 30   1.15
    127  0  0   -12  5 17   14 19 53    31    53   -54  -11 44 26  -12 26 17  -11 29  2  -12 41 59   1.15
    126  0  0   -11 58 42   14 20  3    30    54   -53  -11 37 52  -12 19 41  -11 22 29  -12 35 21   1.15
    125  0  0   -11 53  0   14 20 13    30    54   -53  -11 32 11  -12 13 57  -11 16 49  -12 29 36   1.15
    124  0  0   -11 48 10   14 20 22    29    55   -53  -11 27 22  -12  9  6  -11 12  1  -12 24 45   1.15
    123  0  0   -11 44 13   14 20 32    28    56   -52  -11 23 26  -12  5  8  -11  8  6  -12 20 46   1.16
    122  0  0   -11 41  8   14 20 41    28    56   -52  -11 20 22  -12  2  3  -11  5  2  -12 17 41   1.16
    121  0  0   -11 38 57   14 20 49    27    57   -51  -11 18 11  -11 59 52  -11  2 51  -12 15 29   1.16
    120  0  0   -11 37 39   14 20 58    26    57   -51  -11 16 53  -11 58 33  -11  1 33  -12 14 11   1.16
    119  0  0   -11 37 13   14 21  6    25    57   -50  -11 16 27  -11 58  9  -11  1  7  -12 13 47   1.16
    118  0  0   -11 37 42   14 21 14    24    58   -50  -11 16 54  -11 58 38  -11  1 33  -12 14 16   1.16
    117  0  0   -11 39  3   14 21 22    24    58   -49  -11 18 15  -12  0  0  -11  2 53  -12 15 40   1.16
    116  0  0   -11 41 18   14 21 30    23    59   -49  -11 20 29  -12  2 17  -11  5  6  -12 17 57   1.17
    115  0  0   -11 44 27   14 21 37    22    59   -48  -11 23 36  -12  5 28  -11  8 12  -12 21  9   1.17
    114  0  0   -11 48 31   14 21 44    21    59   -47  -11 27 37  -12  9 33  -11 12 12  -12 25 16   1.17
    113  0  0   -11 53 28   14 21 51    20    60   -47  -11 32 32  -12 14 33  -11 17  5  -12 30 18   1.17
    112  0  0   -11 59 20   14 21 58    19    60   -46  -11 38 22  -12 20 28  -11 22 53  -12 36 15   1.17
    111  0  0   -12  6  7   14 22  4    18    60   -45  -11 45  6  -12 27 18  -11 29 35  -12 43  7   1.18
    110  0  0   -12 13 50   14 22 10    18    61   -44  -11 52 45  -12 35  3  -11 37 12  -12 50 56   1.18`

	test('(347) Pariana 2019-11-28 reproduces the published corridor shape across the antimeridian', () => {
		const target = orbitFromElements(2.61177941, 0.1663091, 11.68110804, 85.51402654, 86.13880448, 292.13571013, 58815.593)
		const star = eraS2c(hour(6 + 28 / 60 + 39.9868 / 3600), deg(23 + 6 / 60 + 41.243 / 3600))
		const start = timeYMDHMS(2019, 11, 28, 14, 7, 0, Timescale.UTC)
		const sigma = kilometer(0.37 * 50.5)
		const body: Mat3 = [sigma * sigma, 0, 0, 0, sigma * sigma, 0, 0, 0, sigma * sigma]
		const path = occultationPath(target, star, ephemeris.earth, start, timeShift(start, 17 / 1440), { radius: kilometer(25.25), step: 2 / DAYSEC, uncertainty: { body } })
		const midnight = toJulianDay(timeYMDHMS(2019, 11, 28, 0, 0, 0, Timescale.UTC))

		// The track crosses the antimeridian: two split polylines meeting on the seam, one continuous unwrapped one.
		const split = occultationPathPolylines(path, 'center')
		expect(split).toHaveLength(2)
		expect(Math.abs(split[0].at(-1)!.longitude)).toBe(PI)
		expect(split[1][0].longitude).toBe(-split[0].at(-1)!.longitude)
		expect(occultationPathPolylines(path, 'center', true)).toHaveLength(1)

		const offsets: number[] = []

		for (const row of parseRows(PARIANA_FIXED_LATITUDE.trim(), 'latitude')) {
			offsets.push(...rowOffsets(path, row, 'latitude'))
			expect(Math.abs(centerCrossing(path, 'latitude', row.fixed, midnight)! - row.seconds)).toBeLessThan(3)
		}

		for (const row of parseRows(PARIANA_FIXED_LONGITUDE.trim(), 'longitude')) {
			offsets.push(...rowOffsets(path, row, 'longitude'))
			expect(Math.abs(centerCrossing(path, 'longitude', row.fixed, midnight)! - row.seconds)).toBeLessThan(3)
		}

		expect(offsets).toHaveLength(61 * 5)
		const mean = offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length
		// Rigid offset, inside the published 1-sigma of 0.37 x 50.5 km.
		expect(Math.abs(mean)).toBeLessThan(0.37 * 50.5)
		// Every centre, limit and error-limit point keeps its place relative to the others within half a kilometre.
		for (const offset of offsets) expect(Math.abs(offset - mean)).toBeLessThan(0.5)
	})
})
