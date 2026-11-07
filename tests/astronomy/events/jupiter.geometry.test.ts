import { expect, test } from 'bun:test'
import { JUPITER_ROTATION, orientation, positionAngleOfPole } from '../../../src/astronomy/bodies/orientation'
import { analyticalJovianEphemeris, type JovianBody, type JovianEphemeris } from '../../../src/astronomy/ephemeris/jovian'
import { JupiterMoons } from '../../../src/astronomy/ephemeris/meeus'
import { jovianMoonMargins, jovianShadowPoint, jovianSystemState, jovianView, projectJovianSurfacePoint } from '../../../src/astronomy/events/jupiter.geometry'
import { time, Timescale, timeYMDHMS } from '../../../src/astronomy/time/time'
import { JUPITER_EQUATORIAL_RADIUS_AU, JUPITER_POLAR_RADIUS_AU, SUN_RADIUS_AU } from '../../../src/core/constants'
import { type Vec3, vecCross, vecMinus, vecMulScalar, vecNormalize, vecPlus, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'

const T = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
const A = JUPITER_EQUATORIAL_RADIUS_AU
const RATIO = JUPITER_POLAR_RADIUS_AU / JUPITER_EQUATORIAL_RADIUS_AU

// Jupiter's north pole (unit, ICRF) at T.
const POLE: Vec3 = (() => {
	const { poleRa, poleDec } = orientation(JUPITER_ROTATION, T)
	return [Math.cos(poleDec) * Math.cos(poleRa), Math.cos(poleDec) * Math.sin(poleRa), Math.sin(poleDec)]
})()

// A line of sight perpendicular to the pole, so the Earth lies in Jupiter's equatorial plane.
const SIGHT = vecNormalize(vecCross(POLE, [1, 0, 0]))
// The equatorial direction perpendicular to the line of sight, and the pole direction on the sky.
const EQUATOR = vecNormalize(vecCross(POLE, SIGHT))

// A Jovian ephemeris of fixed positions; light time then only shifts the epochs, not the positions.
function fixed(positions: Partial<Record<JovianBody, Vec3>>): JovianEphemeris {
	const all: Record<JovianBody, Vec3> = {
		earth: [0, 0, 0],
		jupiter: vecMulScalar(SIGHT, 5),
		sun: vecMulScalar(SIGHT, -1),
		io: vecMulScalar(SIGHT, 50),
		europa: vecMulScalar(SIGHT, 60),
		ganymede: vecMulScalar(SIGHT, 70),
		callisto: vecMulScalar(SIGHT, 80),
		...positions,
	}
	return { source: { kind: 'analytical', planetary: 'VSOP87E', satellites: 'L1.2' }, position: (body) => [...all[body]] }
}

test('the outline is the polar section when the Earth is in the equatorial plane', () => {
	const view = jovianView(fixed({}), T)
	expect(view.polarRadius / view.equatorialRadius).toBeCloseTo(RATIO, 9)
	expect(toDeg(view.subEarthLatitude)).toBeCloseTo(0, 6)
	expect(view.distance).toBeCloseTo(5, 12)
})

test('a moon centred in front of the disk transits and one at the polar limb behind it is tangent', () => {
	const jupiter = vecMulScalar(SIGHT, 5)
	const front = vecMinus(jupiter, vecMulScalar(SIGHT, 10 * A))
	// Behind the planet, offset toward the projected pole so its centre sits on the apparent polar limb.
	const depth = 5 + 10 * A
	const behind = vecPlus(vecPlus(jupiter, vecMulScalar(SIGHT, 10 * A)), vecMulScalar(POLE, (RATIO * A * depth) / 5))
	const ephemeris = fixed({ io: front, europa: behind })
	const state = jovianSystemState(ephemeris, T)

	const io = jovianMoonMargins(ephemeris, state, 'io')
	expect(io.disk.front).toBeTrue()
	expect(io.disk.distance).toBeCloseTo(-RATIO, 6)
	expect(io.disk.ellipticRadius).toBeCloseTo(0, 9)

	const europa = jovianMoonMargins(ephemeris, state, 'europa')
	expect(europa.disk.front).toBeFalse()
	expect(europa.disk.distance).toBeCloseTo(0, 6)
	expect(europa.disk.ellipticRadius).toBeCloseTo(1, 6)

	const view = jovianView(ephemeris, T)
	expect(view.moons[0].disk).toBe('transit')
	expect(view.moons[1].disk).toBe('occulted')
	expect(view.moons[0].depth).toBeCloseTo(10, 6)
	expect(view.moons[1].depth).toBeCloseTo(-10, 6)
})

test('a moon behind Jupiter on the solar axis is inside the umbra cone', () => {
	const jupiter = vecMulScalar(SIGHT, 5)
	const s = 10 * A
	// At opposition the Sun is behind the Earth, so the solar axis is the line of sight.
	const ephemeris = fixed({ ganymede: vecPlus(jupiter, vecMulScalar(SIGHT, s)) })
	const state = jovianSystemState(ephemeris, T)
	const { eclipse } = jovianMoonMargins(ephemeris, state, 'ganymede')
	const D = 6
	const umbra = 1 - (s * (SUN_RADIUS_AU - A)) / (D * A)
	const penumbra = 1 + (s * (SUN_RADIUS_AU + A)) / (D * A)
	expect(eclipse.valid).toBeTrue()
	expect(eclipse.umbraDistance).toBeCloseTo(-umbra * RATIO, 6)
	expect(eclipse.penumbraDistance).toBeCloseTo(-penumbra * RATIO, 6)
	expect(jovianView(ephemeris, T).moons[2].eclipse).toBe('umbra')

	// The same moon on the sunward side cannot be eclipsed.
	const sunward = fixed({ ganymede: vecMinus(jupiter, vecMulScalar(SIGHT, s)) })
	expect(jovianMoonMargins(sunward, jovianSystemState(sunward, T), 'ganymede').eclipse.valid).toBeFalse()
})

test('the shadow falls on the moon at opposition and away from it elsewhere', () => {
	const jupiter = vecMulScalar(SIGHT, 5)
	const moon = vecMinus(jupiter, vecMulScalar(SIGHT, 10 * A))

	const opposition = fixed({ io: moon })
	const atOpposition = jovianView(opposition, T).moons[0]
	expect(atOpposition.shadow).toBeDefined()
	expect(atOpposition.shadow!.visible).toBeTrue()
	expect(atOpposition.shadow!.east - atOpposition.east).toBeCloseTo(0, 6)
	expect(atOpposition.shadow!.north - atOpposition.north).toBeCloseTo(0, 6)

	// Sun 10° away from the anti-Earth direction in the equatorial plane: phase angle ~10°.
	const sun = vecPlus(jupiter, vecMulScalar(vecRotateByRodrigues(vecMulScalar(SIGHT, -1), POLE, deg(10)), 5.2))
	// A moon three radii in front of the planet, so its displaced shadow still falls on the disk.
	const near = vecMinus(jupiter, vecMulScalar(SIGHT, 3 * A))
	const quadrature = fixed({ io: near, sun })
	const state = jovianSystemState(quadrature, T)
	const margins = jovianMoonMargins(quadrature, state, 'io')
	expect(margins.shadow.valid).toBeTrue()
	expect(jovianShadowPoint(state, margins.shadow)).toBeDefined()

	const away = jovianView(quadrature, T).moons[0]
	// The shadow lands ~2 radii behind the moon along the axis, displaced by ~2 × tan(10°) on the sky.
	const offset = Math.hypot(away.shadow!.east - away.east, away.shadow!.north - away.north)
	expect(offset).toBeGreaterThan(0.3)
	expect(offset).toBeLessThan(0.4)
	expect(toDeg(jovianView(quadrature, T).phaseAngle)).toBeCloseTo(10, 1)
	// The moon's penumbra at Jupiter is wider than the moon and the umbra narrower.
	expect(margins.shadow.umbra).toBeLessThan(margins.shadow.penumbra)
})

test('the shadow axis that misses Jupiter has no shadow point', () => {
	const jupiter = vecMulScalar(SIGHT, 5)
	const moon = vecPlus(vecMinus(jupiter, vecMulScalar(SIGHT, 10 * A)), vecMulScalar(EQUATOR, 3 * A))
	const ephemeris = fixed({ io: moon })
	const state = jovianSystemState(ephemeris, T)
	const margins = jovianMoonMargins(ephemeris, state, 'io')
	// The axis from the Sun through the moon diverges slightly, so it crosses Jupiter's plane a bit farther out.
	expect(margins.shadow.distance).toBeCloseTo(2, 2)
	expect(margins.shadow.distance).toBeGreaterThan(2)
	expect(jovianShadowPoint(state, margins.shadow)).toBeUndefined()
	expect(jovianView(ephemeris, T).moons[0].shadow).toBeUndefined()
})

test('satellite positions agree with Meeus E5', () => {
	// Meeus example 44.b, JDE 2448972.50068. Meeus scales to an older 71398 km equatorial radius, hence a
	// 0.13% scale difference on top of the L1.2 versus E5 theories.
	const jde = 2448972.50068
	const view = jovianView(analyticalJovianEphemeris, time(jde, 0, Timescale.TT))
	const meeus = JupiterMoons.e5(jde, JupiterMoons.positions(jde))
	const pa = view.poleAngle

	for (let i = 0; i < 4; i++) {
		const moon = view.moons[i]
		// Meeus X is positive toward the west along the equator, Y toward the projected north pole.
		const x = -moon.east * Math.cos(pa) + moon.north * Math.sin(pa)
		const y = moon.east * Math.sin(pa) + moon.north * Math.cos(pa)
		expect(Math.abs(x - meeus[i][0])).toBeLessThan(0.012)
		expect(Math.abs(y - meeus[i][1])).toBeLessThan(0.004)
		expect(Math.abs(-moon.depth - meeus[i][2])).toBeLessThan(0.03)
	}
})

test('the disk orientation and central meridians match the independent references', () => {
	const view = jovianView(analyticalJovianEphemeris, T)
	expect(view.poleAngle).toBeCloseTo(positionAngleOfPole(JUPITER_ROTATION, T, vecMinus(view.earth, view.jupiter)), 9)
	// PyEphem cmlII and cmlI at T, as in jupiter.test.ts.
	expect(toDeg(view.centralMeridian.II)).toBeCloseTo(328.2794, 2)
	expect(toDeg(view.centralMeridian.I)).toBeCloseTo(15.821, 2)
	// Jupiter's apparent equatorial semidiameter is 98.44″ at 1 AU (Meeus), here at ~6.19 AU.
	expect((toDeg(view.equatorialRadius) * 3600 * view.distance) / 98.44).toBeCloseTo(1, 2)
})

test('a surface point on the central meridian projects onto the disk centre line', () => {
	const view = jovianView(analyticalJovianEphemeris, T)
	const centre = projectJovianSurfacePoint(view, view.centralMeridian.II, view.subEarthLatitude)
	expect(centre.visible).toBeTrue()
	expect(Math.hypot(centre.east, centre.north)).toBeLessThan(0.01)

	const farSide = projectJovianSurfacePoint(view, view.centralMeridian.II + Math.PI, 0)
	expect(farSide.visible).toBeFalse()

	// 90° west of the central meridian the point sits on the western limb, one radius from the centre.
	const limb = projectJovianSurfacePoint(view, view.centralMeridian.II + Math.PI / 2, 0)
	expect(Math.hypot(limb.east, limb.north)).toBeCloseTo(1, 2)
})
