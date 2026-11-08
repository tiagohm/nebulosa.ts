import { expect, test } from 'bun:test'
import { asteroid } from '../../../src/astronomy/orbits/asteroid'
import { type ClassicalElements, conicClass, type OrbitAngle, type OrbitDefinition, orbitalElements, orbitCenter, orbitDiagnostics, orbitOf, orbitStateAt, stateResidual } from '../../../src/astronomy/orbits/mechanics'
import { Timescale, time, timeShift, timeSubtract } from '../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, GM_EARTH_DE440_KM3_S2, GM_SUN_PITJEVA_2005, MU_KM3_S2_TO_AU3_D2, PI, TAU } from '../../../src/core/constants'
import { vecCross, vecDot, vecLength } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'

const EPOCH = time(2460787, 0, Timescale.TDB)
const MU_EARTH = 398600.4418 * MU_KM3_S2_TO_AU3_D2

function build(definition: OrbitDefinition) {
	const result = orbitOf(definition)
	if (!result.ok) throw new Error(result.reason)
	return result.orbit
}

function stateAt(definition: OrbitDefinition, at = EPOCH) {
	const state = orbitStateAt(build(definition), at)
	if (!state.ok) throw new Error(state.reason)
	return state
}

function elementsAt(definition: OrbitDefinition, plane: 'equator' | 'ecliptic' = 'equator', at = EPOCH): ClassicalElements {
	const { position, velocity } = stateAt(definition, at)
	return orbitalElements(at, position, velocity, definition.mu, plane)
}

function value(angle: OrbitAngle) {
	if (!angle.defined) throw new Error(angle.reason)
	return angle.value
}

const ELLIPSE: OrbitDefinition = { kind: 'elliptic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', semiMajorAxis: 2.7, eccentricity: 0.3, inclination: deg(12), node: deg(80), argumentOfPeriapsis: deg(70), meanAnomaly: deg(40), epoch: EPOCH }

test('elements of a Vallado state vector', () => {
	// Vallado, Fundamentals of Astrodynamics and Applications (4th ed.), Example 2-5 (RV2COE).
	const kmToAu = 1 / AU_KM
	const kmsToAud = DAYSEC / AU_KM
	const position = [6524.834 * kmToAu, 6862.875 * kmToAu, 6448.296 * kmToAu] as const
	const velocity = [4.901327 * kmsToAud, 5.533756 * kmsToAud, -1.976341 * kmsToAud] as const
	const elements = orbitalElements(EPOCH, position, velocity, MU_EARTH, 'equator')

	expect(elements.semiLatusRectum * AU_KM).toBeCloseTo(11067.79, 1)
	expect(elements.semiMajorAxis! * AU_KM).toBeCloseTo(36127.343, 0)
	expect(elements.eccentricity).toBeCloseTo(0.832853, 6)
	expect(toDeg(elements.inclination)).toBeCloseTo(87.87, 2)
	expect(toDeg(value(elements.node))).toBeCloseTo(227.898, 2)
	expect(toDeg(value(elements.argumentOfPeriapsis))).toBeCloseTo(53.38, 2)
	expect(toDeg(value(elements.trueAnomaly))).toBeCloseTo(92.335, 2)
	expect(value(elements.argumentOfLatitude)).toBeCloseTo((value(elements.argumentOfPeriapsis) + value(elements.trueAnomaly)) % TAU, 12)
	expect(elements.conic).toBe('elliptic')
})

test('ecliptic elements round trip through the equatorial model', () => {
	const elements = elementsAt(ELLIPSE, 'ecliptic')

	expect(elements.semiMajorAxis!).toBeCloseTo(2.7, 12)
	expect(elements.eccentricity).toBeCloseTo(0.3, 13)
	expect(elements.inclination).toBeCloseTo(deg(12), 13)
	expect(value(elements.node)).toBeCloseTo(deg(80), 12)
	expect(value(elements.argumentOfPeriapsis)).toBeCloseTo(deg(70), 12)
	expect(elements.meanAnomaly!).toBeCloseTo(deg(40), 12)
	expect(elements.period!).toBeCloseTo(TAU * Math.sqrt(2.7 ** 3 / GM_SUN_PITJEVA_2005), 8)
	expect(timeSubtract(EPOCH, elements.periapsisTime!, Timescale.TDB)).toBeCloseTo(deg(40) / elements.meanMotion!, 8)

	// The same orbit referred to the equator has another inclination but the same shape.
	const equatorial = elementsAt(ELLIPSE, 'equator')
	expect(equatorial.eccentricity).toBeCloseTo(0.3, 13)
	expect(equatorial.inclination).not.toBeCloseTo(deg(12), 3)
})

test('ecliptic elements are rotated to the equator exactly once', () => {
	// asteroid() builds the same elements with KeplerOrbit's default ecliptic → equatorial output rotation.
	const reference = asteroid(2.7, 0.3, deg(12), deg(80), deg(70), deg(40), EPOCH)
	const at = timeShift(EPOCH, 123.4)
	const [p, v] = reference.at(at)
	const state = stateAt(ELLIPSE, at)

	for (let i = 0; i < 3; i++) {
		expect(state.position[i]).toBeCloseTo(p[i], 13)
		expect(state.velocity[i]).toBeCloseTo(v[i], 15)
	}
})

test('a Cartesian state is used without any rotation', () => {
	const position = [-1.70317472297052, -1.333843040283118, -3.086709149679688e-1] as const
	const velocity = [7.882762615954012e-3, -8.079478592200335e-3, -4.254433056153772e-3] as const
	const state = stateAt({ kind: 'cartesian', mu: GM_SUN_PITJEVA_2005, position, velocity, epoch: EPOCH })

	expect(state.position).toEqual([...position])
	expect(state.velocity).toEqual([...velocity])
})

test('a circular orbit keeps its radius and speed and moves a quarter turn in a quarter period', () => {
	const definition: OrbitDefinition = { kind: 'elliptic', mu: MU_EARTH, plane: 'equator', semiMajorAxis: 7000 / AU_KM, eccentricity: 0, inclination: deg(30), node: deg(10), argumentOfPeriapsis: 0, meanAnomaly: 0, epoch: EPOCH }
	const period = TAU * Math.sqrt(definition.semiMajorAxis ** 3 / MU_EARTH)
	const start = stateAt(definition)
	const quarter = stateAt(definition, timeShift(EPOCH, period / 4))
	const full = stateAt(definition, timeShift(EPOCH, period))

	expect(vecLength(quarter.position)).toBeCloseTo(vecLength(start.position), 15)
	expect(vecLength(quarter.velocity)).toBeCloseTo(vecLength(start.velocity), 13)
	expect(vecDot(start.position, quarter.position) / vecLength(start.position) ** 2).toBeCloseTo(0, 9)
	for (let i = 0; i < 3; i++) expect(full.position[i]).toBeCloseTo(start.position[i], 13)

	const elements = orbitalElements(EPOCH, start.position, start.velocity, MU_EARTH, 'equator')
	expect(elements.conic).toBe('circular')
	expect(elements.argumentOfPeriapsis).toEqual({ defined: false, reason: 'circular' })
	expect(elements.trueAnomaly).toEqual({ defined: false, reason: 'circular' })
	expect(elements.meanAnomaly).toBeUndefined()
	expect(value(elements.node)).toBeCloseTo(deg(10), 12)
	expect(value(elements.argumentOfLatitude)).toBeCloseTo(0, 12)
	expect(elements.period!).toBeCloseTo(period, 12)
})

test('equatorial prograde and retrograde orbits have no node but a longitude of periapsis', () => {
	for (const inclination of [0, PI]) {
		const definition: OrbitDefinition = { kind: 'elliptic', mu: GM_SUN_PITJEVA_2005, plane: 'equator', semiMajorAxis: 1.5, eccentricity: 0.2, inclination, node: 0, argumentOfPeriapsis: deg(30), meanAnomaly: deg(50), epoch: EPOCH }
		const elements = elementsAt(definition)
		const { position, velocity } = stateAt(definition)

		expect(elements.inclination).toBeCloseTo(inclination, 12)
		expect(elements.node).toEqual({ defined: false, reason: 'equatorial' })
		expect(elements.argumentOfPeriapsis).toEqual({ defined: false, reason: 'equatorial' })
		expect(elements.argumentOfLatitude).toEqual({ defined: false, reason: 'equatorial' })
		expect(value(elements.longitudeOfPeriapsis)).toBeCloseTo(deg(30), 12)
		// The true longitude of a retrograde orbit grows with its motion, clockwise seen from +Z.
		expect(vecCross(position, velocity)[2] > 0).toBe(inclination === 0)
		expect(elements.trueLongitude).toBeCloseTo((deg(30) + value(elements.trueAnomaly)) % TAU, 12)
	}
})

test('an inclined orbit has its ascending node where it crosses the plane northward', () => {
	const definition: OrbitDefinition = { ...ELLIPSE, plane: 'equator', argumentOfPeriapsis: 0, meanAnomaly: 0 }
	const { position, velocity } = stateAt(definition)

	// At the periapsis with ω = 0 the body is at the ascending node, so z = 0 and ż > 0.
	expect(position[2]).toBeCloseTo(0, 15)
	expect(velocity[2]).toBeGreaterThan(0)
	expect(Math.atan2(position[1], position[0])).toBeCloseTo(deg(80), 12)
})

test('a retrograde inclined orbit keeps its elements', () => {
	const definition: OrbitDefinition = { ...ELLIPSE, inclination: deg(150) }
	const elements = elementsAt(definition, 'ecliptic')

	expect(elements.inclination).toBeCloseTo(deg(150), 12)
	expect(value(elements.node)).toBeCloseTo(deg(80), 12)
	expect(value(elements.argumentOfPeriapsis)).toBeCloseTo(deg(70), 12)
})

test('elliptic propagation returns to its state forward then backward and conserves its invariants', () => {
	const orbit = build(ELLIPSE)
	const later = timeShift(EPOCH, 10 * orbit.periodInDays + 17.25)
	const forward = orbitStateAt(orbit, later)
	if (!forward.ok) throw new Error(forward.reason)
	const back = orbitStateAt(build({ kind: 'cartesian', mu: GM_SUN_PITJEVA_2005, position: forward.position, velocity: forward.velocity, epoch: later }), EPOCH)
	if (!back.ok) throw new Error(back.reason)

	for (let i = 0; i < 3; i++) {
		expect(back.position[i]).toBeCloseTo(orbit.position[i], 11)
		expect(back.velocity[i]).toBeCloseTo(orbit.velocity[i], 13)
	}

	const start = orbitDiagnostics(orbit.position, orbit.velocity, GM_SUN_PITJEVA_2005)
	const end = orbitDiagnostics(forward.position, forward.velocity, GM_SUN_PITJEVA_2005)
	expect(end.specificEnergy / start.specificEnergy).toBeCloseTo(1, 11)
	expect(end.angularMomentumMagnitude / start.angularMomentumMagnitude).toBeCloseTo(1, 11)
	expect(start.specificEnergy).toBeCloseTo(-GM_SUN_PITJEVA_2005 / (2 * 2.7), 14)
	expect(start.escapeSpeed).toBeCloseTo(Math.sqrt((2 * GM_SUN_PITJEVA_2005) / start.radius), 15)
	expect(Math.hypot(start.radialSpeed, start.transverseSpeed)).toBeCloseTo(start.speed, 15)
})

test('a parabola has zero energy, no semi-major axis or period, and passes periapsis at its time', () => {
	const periapsisTime = timeShift(EPOCH, 20)
	const definition: OrbitDefinition = { kind: 'parabolic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', periapsisDistance: 0.5, inclination: deg(100), node: deg(30), argumentOfPeriapsis: deg(200), periapsisTime }
	const elements = elementsAt(definition, 'ecliptic')
	const { position, velocity } = stateAt(definition, periapsisTime)

	expect(conicClass(elements.eccentricity)).toBe('parabolic')
	expect(elements.semiMajorAxis).toBeUndefined()
	expect(elements.period).toBeUndefined()
	expect(elements.apoapsisDistance).toBeUndefined()
	expect(elements.meanAnomaly).toBeUndefined()
	expect(elements.periapsisDistance).toBeCloseTo(0.5, 13)
	expect(timeSubtract(elements.periapsisTime!, periapsisTime, Timescale.TDB)).toBeCloseTo(0, 7)
	expect(vecLength(position)).toBeCloseTo(0.5, 14)
	expect(orbitDiagnostics(position, velocity, GM_SUN_PITJEVA_2005).specificEnergy).toBeCloseTo(0, 14)

	for (const days of [-3000, -1, 1, 3000]) {
		const state = stateAt(definition, timeShift(periapsisTime, days))
		expect(Number.isFinite(vecLength(state.position))).toBeTrue()
		expect(vecDot(state.position, state.velocity) > 0).toBe(days > 0)
	}
})

test('a hyperbola has a negative semi-major axis, positive energy, and no period', () => {
	const periapsisTime = timeShift(EPOCH, -5)
	const definition: OrbitDefinition = { kind: 'hyperbolic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', periapsisDistance: 0.255, eccentricity: 1.2, inclination: deg(122.7), node: deg(24.6), argumentOfPeriapsis: deg(241.8), periapsisTime }
	const elements = elementsAt(definition, 'ecliptic')
	const { position, velocity } = stateAt(definition)

	expect(elements.conic).toBe('hyperbolic')
	expect(elements.semiMajorAxis!).toBeCloseTo(-0.255 / 0.2, 12)
	expect(elements.period).toBeUndefined()
	expect(elements.apoapsisDistance).toBeUndefined()
	expect(Math.abs(value(elements.trueAnomaly))).toBeLessThan(Math.acos(-1 / 1.2))
	expect(timeSubtract(elements.periapsisTime!, periapsisTime, Timescale.TDB)).toBeCloseTo(0, 8)
	expect(orbitDiagnostics(position, velocity, GM_SUN_PITJEVA_2005).specificEnergy).toBeCloseTo(GM_SUN_PITJEVA_2005 / (2 * (0.255 / 0.2)), 14)
})

test('near-parabolic orbits keep their eccentricity and class on each side of 1', () => {
	for (const e of [1 - 1e-6, 1 + 1e-6]) {
		const definition: OrbitDefinition =
			e < 1
				? { kind: 'elliptic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', semiMajorAxis: 0.5 / (1 - e), eccentricity: e, inclination: deg(40), node: deg(10), argumentOfPeriapsis: deg(20), meanAnomaly: 0, epoch: EPOCH }
				: { kind: 'hyperbolic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', periapsisDistance: 0.5, eccentricity: e, inclination: deg(40), node: deg(10), argumentOfPeriapsis: deg(20), periapsisTime: EPOCH }
		const elements = elementsAt(definition, 'ecliptic', timeShift(EPOCH, 40))

		expect(elements.eccentricity).toBeCloseTo(e, 9)
		expect(elements.conic).toBe(e < 1 ? 'elliptic' : 'hyperbolic')
		expect(elements.periapsisDistance).toBeCloseTo(0.5, 10)
		expect(timeSubtract(timeShift(EPOCH, 40), elements.periapsisTime!, Timescale.TDB)).toBeCloseTo(40, 4)
	}
})

test('a rectilinear state is degenerate and a long offset on a hyperbola stays finite', () => {
	expect(orbitOf({ kind: 'cartesian', mu: GM_SUN_PITJEVA_2005, position: [1, 0, 0], velocity: [0.01, 0, 0], epoch: EPOCH })).toEqual({ ok: false, reason: 'degenerate' })
	expect(orbitOf({ kind: 'cartesian', mu: GM_SUN_PITJEVA_2005, position: [1, 0, 0], velocity: [0, 0, 0], epoch: EPOCH })).toEqual({ ok: false, reason: 'degenerate' })

	const hyperbola = build({ kind: 'hyperbolic', mu: GM_SUN_PITJEVA_2005, plane: 'equator', periapsisDistance: 1, eccentricity: 3, inclination: 0.1, node: 0, argumentOfPeriapsis: 0, periapsisTime: EPOCH })
	const far = orbitStateAt(hyperbola, time(EPOCH.day + 1e6, 0, Timescale.TDB))
	if (!far.ok) throw new Error(far.reason)
	expect(vecLength(far.position)).toBeCloseTo(vecLength(far.velocity) * 1e6, -4)
})

test('the residual is model minus reference, and its RTN components rebuild its norm', () => {
	const reference = stateAt(ELLIPSE)
	const ahead = stateAt(ELLIPSE, timeShift(EPOCH, 0.01))
	const residual = stateResidual(ahead.position, ahead.velocity, reference.position, reference.velocity)

	expect(residual.distance).toBeCloseTo(vecLength(residual.position), 16)
	expect(vecLength(residual.rtnPosition!)).toBeCloseTo(residual.distance, 16)
	expect(vecLength(residual.rtnVelocity!)).toBeCloseTo(residual.speed, 17)
	// A model ahead along its orbit differs mostly in T, positively, and barely in N.
	expect(residual.rtnPosition![1]).toBeGreaterThan(0)
	expect(Math.abs(residual.rtnPosition![1])).toBeGreaterThan(Math.abs(residual.rtnPosition![0]))
	expect(residual.rtnPosition![2]).toBeCloseTo(0, 12)

	const same = stateResidual(reference.position, reference.velocity, reference.position, reference.velocity)
	expect(same.distance).toBe(0)
	expect(stateResidual([1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]).rtnPosition).toBeUndefined()
})

test('centers carry DE440 gravitational parameters', () => {
	expect(orbitCenter(399)!.mu).toBe(GM_EARTH_DE440_KM3_S2 * MU_KM3_S2_TO_AU3_D2)
	expect(orbitCenter(10)!.mu / GM_SUN_PITJEVA_2005).toBeCloseTo(1, 10)
	expect(orbitCenter(5)!.system).toBeTrue()
	expect(orbitCenter(301)!.radius * AU_KM).toBe(1737.4)
	expect(orbitCenter(3)).toBeUndefined()
})
