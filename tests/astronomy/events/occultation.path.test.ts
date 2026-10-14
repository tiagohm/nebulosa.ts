import { describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import { type PositionAndVelocityMut, type PositionAndVelocityOverTime, separationFrom, topocentricDirection, zeroPositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../src/astronomy/ephemeris/kernels/naif'
import { readSpk } from '../../../src/astronomy/ephemeris/kernels/spk'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { occultationCandidates } from '../../../src/astronomy/events/occultation'
import { type OccultationPathMode, occultationPath, occultationPathPolylines } from '../../../src/astronomy/events/occultation.path'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { KeplerOrbit } from '../../../src/astronomy/orbits/asteroid'
import { gcrsToItrsRotationMatrix, NO_POLAR_MOTION, type Time, Timescale, time, timeShift, timeSubtract } from '../../../src/astronomy/time/time'
import { DAYSEC, ELLIPSOID_PARAMETERS, GM_SUN_PITJEVA_2005, PI, SPEED_OF_LIGHT_AU_DAY } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { type Mat3, matIdentity, matMul, matTranspose, matTransposeMulVec } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecClone, vecLength, vecMulScalar, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { deg, mas, toDeg } from '../../../src/math/units/angle'
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
