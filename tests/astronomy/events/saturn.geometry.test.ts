import { expect, test } from 'bun:test'
import { orientation, positionAngleOfPole, SATURN_ROTATION } from '../../../src/astronomy/bodies/orientation'
import { SaturnMoons } from '../../../src/astronomy/ephemeris/meeus'
import { analyticalSaturnianEphemeris, interpolatedSaturnianEphemeris, SATURNIAN_MOONS, type SaturnianBody, type SaturnianEphemeris, type SaturnianMoon } from '../../../src/astronomy/ephemeris/saturnian'
import { saturnianSeparationMaxima, saturnianView } from '../../../src/astronomy/events/saturn.geometry'
import { SATURN_RING_MODEL } from '../../../src/astronomy/events/saturn.rings'
import { time, type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, SATURN_EQUATORIAL_RADIUS_AU, SATURN_EQUATORIAL_RADIUS_KM, SATURN_POLAR_RADIUS_AU } from '../../../src/core/constants'
import { type Vec3, vecCross, vecMinus, vecMulScalar, vecNormalize, vecPlus } from '../../../src/math/linear-algebra/vec3'
import { toDeg } from '../../../src/math/units/angle'

// Arcseconds per radian.
const RAD_TO_ARCSEC = (180 / Math.PI) * 3600

function utc(year: number, month: number, day: number, hour = 0) {
	return timeYMDHMS(year, month, day, hour, 0, 0, Timescale.UTC)
}

// JPL Horizons API 1.2 quantity 6 (apparent plane-of-sky offsets of the satellite from Saturn's centre,
// ΔRA·cos δ and Δδ, arcseconds), observer 500@399, Saturnian satellite ephemeris sat441l, retrieved 2026-11-07.
const HORIZONS: readonly { time: Time; offsets: Readonly<Record<SaturnianMoon, readonly [number, number]>> }[] = [
	{
		time: utc(2025, 5, 5),
		offsets: { mimas: [-15.071, 2.04], enceladus: [-17.691, 2.318], tethys: [-32.546, 2.664], dione: [-19.323, 3.205], rhea: [66.24, -4.37], titan: [-144.03, 6.979], iapetus: [453.41, 99.281] },
	},
	{
		time: utc(2026, 11, 1),
		offsets: { mimas: [-20.251, -0.459], enceladus: [34.861, -0.193], tethys: [42.155, -0.717], dione: [-52.706, 6.571], rhea: [-40.054, -5.879], titan: [-19.539, -21.114], iapetus: [405.002, 15.037] },
	},
	{
		time: utc(2029, 12, 31, 18),
		offsets: { mimas: [28.991, -2.474], enceladus: [17.595, 12.773], tethys: [-8.182, -17.058], dione: [59.427, -4.985], rhea: [-58.861, -23.143], titan: [99.056, 65.813], iapetus: [-314.098, 44.936] },
	},
]

test('the apparent satellite offsets match JPL Horizons within the accuracy of TASS 1.7', () => {
	for (const reference of HORIZONS) {
		const view = saturnianView(analyticalSaturnianEphemeris, reference.time)
		const unit = view.equatorialRadius * RAD_TO_ARCSEC

		for (const moon of view.moons) {
			const [east, north] = reference.offsets[moon.moon]
			// TASS 1.7 positions differ from SAT441 by up to ~1,500 km for Iapetus (0.25″ at 9 AU) and a few
			// hundred km for the inner moons.
			const tolerance = moon.moon === 'iapetus' ? 0.25 : 0.1
			expect(Math.abs(moon.east * unit - east)).toBeLessThan(tolerance)
			expect(Math.abs(moon.north * unit - north)).toBeLessThan(tolerance)
			expect(toDeg(moon.separation) * 3600).toBeCloseTo(Math.hypot(east, north), 0)
			expect(Math.abs(toDeg(moon.positionAngle) - toDeg(Math.atan2(east, north)))).toBeLessThan(0.5)
		}
	}
})

test('the satellites agree with Meeus example 46.a within its unit scale', () => {
	// 1999 October 1, 0h TD (JDE 2451439.50074).
	const jde = 2451439.50074
	const view = saturnianView(analyticalSaturnianEphemeris, time(jde, 0, Timescale.TT))
	const meeus = SaturnMoons.positions(jde)
	// Meeus's chapter 46 ordering puts Hyperion before Iapetus.
	const index: Readonly<Record<SaturnianMoon, number>> = { mimas: 0, enceladus: 1, tethys: 2, dione: 3, rhea: 4, titan: 5, iapetus: 7 }
	const p = view.polePositionAngle

	for (const moon of view.moons) {
		// Meeus: X toward the west, Y toward the projected north pole, in Saturn equatorial radii.
		const x = -(moon.east * Math.cos(p) - moon.north * Math.sin(p))
		const y = moon.east * Math.sin(p) + moon.north * Math.cos(p)
		const [mx, my] = meeus[index[moon.moon]]
		// Dourneau's theory and Meeus's radius unit put the satellites about 0.25% closer than TASS 1.7 at IAU radii.
		const tolerance = 0.006 * Math.hypot(mx, my) + 0.02
		expect(Math.abs(x - mx)).toBeLessThan(tolerance)
		expect(Math.abs(y - my)).toBeLessThan(tolerance)
	}
})

test('the pole position angle matches the toolkit orientation', () => {
	const t = utc(2026, 11, 1)
	const view = saturnianView(analyticalSaturnianEphemeris, t)
	const toEarth = vecMinus(view.earth, view.saturn)
	expect(toDeg(view.polePositionAngle)).toBeCloseTo(toDeg(positionAngleOfPole(SATURN_ROTATION, t, toEarth)), 2)
})

// Saturn's IAU pole at a time (unit, ICRF).
function pole(at: Time): Vec3 {
	const { poleRa, poleDec } = orientation(SATURN_ROTATION, at)
	return [Math.cos(poleDec) * Math.cos(poleRa), Math.cos(poleDec) * Math.sin(poleRa), Math.sin(poleDec)]
}

const T = utc(2026, 6, 1)
const POLE = pole(T)
// A line of sight inclined by 20° to the ring plane, from the north side.
const EQUATOR = vecNormalize(vecCross(POLE, [1, 0, 0]))
const SIGHT = vecNormalize(vecPlus(vecMulScalar(EQUATOR, Math.cos((20 * Math.PI) / 180)), vecMulScalar(POLE, -Math.sin((20 * Math.PI) / 180))))
const SATURN = vecMulScalar(SIGHT, 9)
const A = SATURN_EQUATORIAL_RADIUS_AU

// A Saturnian ephemeris of fixed positions; the Sun lies behind the Earth so no shadow reaches the moons.
function fixed(moons: Partial<Record<SaturnianMoon, Vec3>>): SaturnianEphemeris {
	const far = vecPlus(SATURN, vecMulScalar(vecNormalize(vecCross(POLE, SIGHT)), 200 * A))
	const all: Record<SaturnianBody, Vec3> = { earth: [0, 0, 0], sun: vecMulScalar(SIGHT, -1), saturn: SATURN, mimas: far, enceladus: far, tethys: far, dione: far, rhea: far, titan: far, iapetus: far, ...moons }
	return { source: { kind: 'analytical', planetary: 'VSOP87E', satellites: 'TASS1.7' }, position: (body) => [...all[body]] }
}

test('a moon in front of the disk transits and one behind the polar limb is occulted', () => {
	const front = vecMinus(SATURN, vecMulScalar(SIGHT, 30 * A))
	const behind = vecPlus(SATURN, vecMulScalar(SIGHT, 30 * A))
	const view = saturnianView(fixed({ titan: front, rhea: behind }), T)
	const titan = view.moons.find((m) => m.moon === 'titan')!
	const rhea = view.moons.find((m) => m.moon === 'rhea')!
	expect(titan.disk).toBe('transit')
	expect(titan.depth).toBeCloseTo(30, 6)
	expect(titan.diskClearance).toBeLessThan(0)
	expect(rhea.disk).toBe('occulted')
	expect(rhea.depth).toBeCloseTo(-30, 6)
	// The polar outline is foreshortened between b/a and 1.
	expect(view.polarRadius / view.equatorialRadius).toBeGreaterThan(SATURN_POLAR_RADIUS_AU / A)
	expect(view.polarRadius / view.equatorialRadius).toBeLessThan(1)
})

test('a moon over the rings is in front on the near side and behind on the far side', () => {
	// The rings' outline has its semi-minor axis along the projected pole, foreshortened by sin 20°: the
	// annulus spans 0.42 (C inner, 1.236 radii) to 0.78 (A outer, 2.269 radii) along it, so a point 0.6
	// radii toward the projected pole lies over the far half of the rings, 1.65 radii behind the sky plane.
	const projected = vecNormalize(vecMinus(POLE, vecMulScalar(SIGHT, POLE[0] * SIGHT[0] + POLE[1] * SIGHT[1] + POLE[2] * SIGHT[2])))
	const sky = vecMulScalar(projected, 0.6 * A)
	// In front of the ring plane, toward the Earth, and behind it, away from the Earth.
	const near = vecPlus(vecPlus(SATURN, sky), vecMulScalar(SIGHT, -5 * A))
	const far = vecPlus(vecPlus(SATURN, sky), vecMulScalar(SIGHT, 5 * A))
	const view = saturnianView(fixed({ mimas: near, enceladus: far }), T)
	const mimas = view.moons.find((m) => m.moon === 'mimas')!
	const enceladus = view.moons.find((m) => m.moon === 'enceladus')!
	expect(mimas.ringOverlap).toBe('front')
	expect(enceladus.ringOverlap).toBe('behind')
	expect(mimas.ringClearance).toBeLessThan(0)

	// Far from the rings there is no overlap and a positive clearance of the right size.
	const clear = view.moons.find((m) => m.moon === 'titan')!
	expect(clear.ringOverlap).toBe('none')
	expect(clear.ringClearance).toBeGreaterThan(0)
	expect(clear.ringClearance / view.equatorialRadius).toBeCloseTo(200 - SATURN_RING_MODEL.outerRadius / SATURN_EQUATORIAL_RADIUS_KM - clear.radius, 0)
})

test('an edge-on ring plane gives finite clearances', () => {
	const edge = vecNormalize(vecCross(POLE, [0, 1, 0]))
	const saturn = vecMulScalar(edge, 9)
	const inPlane = vecPlus(saturn, vecMulScalar(vecNormalize(vecCross(POLE, edge)), 1.8 * A))
	const ephemeris: SaturnianEphemeris = { source: { kind: 'analytical', planetary: 'VSOP87E', satellites: 'TASS1.7' }, position: (body) => (body === 'earth' ? [0, 0, 0] : body === 'sun' ? vecMulScalar(edge, -1) : body === 'saturn' ? [...saturn] : [...inPlane]) }
	const view = saturnianView(ephemeris, T)
	expect(view.ringSemiMinor).toBeCloseTo(0, 12)

	for (const moon of view.moons) {
		expect([moon.east, moon.north, moon.ringClearance, moon.diskClearance, moon.separation, moon.positionAngle].every(Number.isFinite)).toBeTrue()
		expect(moon.ringOverlap).toBe('behind')
	}
})

// Angular separation of a moon from Saturn by brute force, through the view.
function separation(ephemeris: SaturnianEphemeris, moon: SaturnianMoon, at: Time) {
	return saturnianView(ephemeris, at, [moon]).moons[0].separation
}

test('the separation maxima are the true maxima of the separation, found completely', () => {
	const ephemeris = interpolatedSaturnianEphemeris(analyticalSaturnianEphemeris)
	const start = utc(2026, 11, 1)
	const stop = utc(2026, 12, 1)
	const maxima = saturnianSeparationMaxima(ephemeris, start, stop)

	for (const moon of SATURNIAN_MOONS) {
		const found = maxima.filter((m) => m.moon === moon)
		// Fine-scan oracle: every local maximum of a 20-minute sampling.
		const oracle: Time[] = []
		const step = 20 / 1440
		let previous = separation(ephemeris, moon, timeShift(start, -step))
		let current = separation(ephemeris, moon, start)

		for (let x = step; x <= 30; x += step) {
			const next = separation(ephemeris, moon, timeShift(start, x))
			if (current > previous && current > next) oracle.push(timeShift(start, x - step))
			previous = current
			current = next
		}

		expect(found.length).toBe(oracle.length)
		for (const [i, maximum] of found.entries()) {
			expect(Math.abs(timeSubtract(maximum.time, oracle[i]) * 1440)).toBeLessThan(20)
			expect(maximum.separation).toBeGreaterThanOrEqual(separation(ephemeris, moon, oracle[i]) - 1e-12)
		}
	}
})

test('the Iapetus separation maximum differs from the maximum of its east offset', () => {
	const ephemeris = interpolatedSaturnianEphemeris(analyticalSaturnianEphemeris)
	const [maximum] = saturnianSeparationMaxima(ephemeris, utc(2026, 11, 1), utc(2026, 12, 1), ['iapetus'])
	expect(maximum).toBeDefined()
	// Iapetus is about 0.6° north of the projected ring plane at this maximum, so the north offset is not
	// negligible and the east offset peaks at another instant.
	const east = (at: Time) => saturnianView(ephemeris, at, ['iapetus']).moons[0].east
	let best = maximum.time
	let bestEast = Math.abs(east(best))

	for (let x = -3; x <= 3; x += 1 / 24) {
		const at = timeShift(maximum.time, x)
		const value = Math.abs(east(at))
		if (value > bestEast) {
			best = at
			bestEast = value
		}
	}

	expect(Math.abs(timeSubtract(best, maximum.time)) * 24).toBeGreaterThan(1)
})

test('a short window holds no maximum of a slow moon and never reports an edge', () => {
	const ephemeris = interpolatedSaturnianEphemeris(analyticalSaturnianEphemeris)
	// Iapetus's maximum falls on 2026-11-10; a day-long window before it has none.
	expect(saturnianSeparationMaxima(ephemeris, utc(2026, 11, 2), utc(2026, 11, 3), ['iapetus'])).toEqual([])
	// A window ending just after the maximum reports it once; the next window does not repeat it.
	const [maximum] = saturnianSeparationMaxima(ephemeris, utc(2026, 11, 1), utc(2026, 12, 1), ['iapetus'])
	const before = saturnianSeparationMaxima(ephemeris, utc(2026, 11, 5), timeShift(maximum.time, 1 / DAYSEC), ['iapetus'])
	const after = saturnianSeparationMaxima(ephemeris, timeShift(maximum.time, 1 / DAYSEC), utc(2026, 11, 15), ['iapetus'])
	expect(before.length).toBe(1)
	expect(after.length).toBe(0)
})
