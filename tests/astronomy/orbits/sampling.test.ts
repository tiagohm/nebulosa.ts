import { expect, test } from 'bun:test'
import { type OrbitDefinition, orbitOf, orbitStateAt } from '../../../src/astronomy/orbits/mechanics'
import { sampleConic, sampleStates } from '../../../src/astronomy/orbits/sampling'
import { Timescale, time, timeShift, timeSubtract } from '../../../src/astronomy/time/time'
import { ECLIPTIC_J2000_MATRIX, GM_SUN_PITJEVA_2005 } from '../../../src/core/constants'
import { matMulVec } from '../../../src/math/linear-algebra/mat3'
import { vecLength } from '../../../src/math/linear-algebra/vec3'
import { hermiteVec3 } from '../../../src/math/numerical/spline'
import { deg } from '../../../src/math/units/angle'

const EPOCH = time(2460787, 0, Timescale.TDB)

function build(definition: OrbitDefinition) {
	const result = orbitOf(definition)
	if (!result.ok) throw new Error(result.reason)
	return result.orbit
}

const ECCENTRIC = build({ kind: 'elliptic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', semiMajorAxis: 17.8, eccentricity: 0.967, inclination: deg(162.2), node: deg(58.4), argumentOfPeriapsis: deg(111.3), meanAnomaly: deg(30), epoch: EPOCH })
const HYPERBOLA = build({ kind: 'hyperbolic', mu: GM_SUN_PITJEVA_2005, plane: 'ecliptic', periapsisDistance: 0.255, eccentricity: 1.2, inclination: deg(122.7), node: deg(24.6), argumentOfPeriapsis: deg(241.8), periapsisTime: EPOCH })

test('a closed conic is refined near periapsis within its tolerance and marks its apsides and nodes', () => {
	const tolerance = 1e-4
	const conic = sampleConic(ECCENTRIC, { tolerance, plane: 'ecliptic' })

	expect(conic.closed).toBeTrue()
	expect(conic.truncated).toBeFalse()
	expect(conic.points.at(-1)).toEqual(conic.points[0])
	expect(conic.points.length).toBeLessThanOrEqual(2048)

	const periapsis = conic.markers.find((e) => e.kind === 'periapsis')!
	const apoapsis = conic.markers.find((e) => e.kind === 'apoapsis')!
	expect(vecLength(periapsis.position)).toBeCloseTo(17.8 * 0.033, 10)
	expect(vecLength(apoapsis.position)).toBeCloseTo(17.8 * 1.967, 10)

	// Both nodes lie on the ecliptic.
	for (const kind of ['ascendingNode', 'descendingNode'] as const) {
		const node = conic.markers.find((e) => e.kind === kind)!
		expect(matMulVec(ECLIPTIC_J2000_MATRIX, node.position)[2]).toBeCloseTo(0, 12)
	}

	// Chords near periapsis are far shorter than near apoapsis.
	const lengths = conic.points.slice(1).map((p, k) => Math.hypot(p[0] - conic.points[k][0], p[1] - conic.points[k][1], p[2] - conic.points[k][2]))
	let nearest = 0
	for (let k = 1; k < conic.points.length; k++) if (vecLength(conic.points[k]) < vecLength(conic.points[nearest])) nearest = k
	expect(lengths[Math.min(nearest, lengths.length - 1)]).toBeLessThan(Math.max(...lengths) / 10)
})

test('an open conic is a finite arc inside its asymptotes and its radius bound', () => {
	const conic = sampleConic(HYPERBOLA, { maxRadius: 5 })

	expect(conic.closed).toBeFalse()
	expect(conic.markers.some((e) => e.kind === 'apoapsis')).toBeFalse()
	expect(conic.markers.some((e) => e.kind === 'periapsis')).toBeTrue()
	for (const p of conic.points) {
		expect(Number.isFinite(vecLength(p))).toBeTrue()
		expect(vecLength(p)).toBeLessThanOrEqual(5 * (1 + 1e-12))
	}
	expect(vecLength(conic.points[0])).toBeCloseTo(5, 9)
	expect(vecLength(conic.points.at(-1)!)).toBeCloseTo(5, 9)
})

test('a conic stops at its point budget and says so', () => {
	const conic = sampleConic(ECCENTRIC, { tolerance: 1e-12, maxPoints: 100 })
	expect(conic.truncated).toBeTrue()
	expect(conic.points.length).toBeLessThanOrEqual(100)
})

test('states are chronological, keep their ends and markers, and interpolate within tolerance', () => {
	const end = timeShift(EPOCH, 400)
	const marker = timeShift(EPOCH, 123.456)
	const result = sampleStates(HYPERBOLA, timeShift(EPOCH, -400), end, { tolerance: 1e-6, markers: [marker, timeShift(EPOCH, 9999)] })
	if (!result.ok) throw new Error(result.reason)
	const { samples } = result

	expect(result.truncated).toBeFalse()
	expect(timeSubtract(samples[0].time, timeShift(EPOCH, -400), Timescale.TDB)).toBeCloseTo(0, 12)
	expect(timeSubtract(samples.at(-1)!.time, end, Timescale.TDB)).toBeCloseTo(0, 12)
	expect(samples.some((e) => Math.abs(timeSubtract(e.time, marker, Timescale.TDB)) < 1e-9)).toBeTrue()

	for (let k = 1; k < samples.length; k++) {
		const a = samples[k - 1]
		const b = samples[k]
		const width = timeSubtract(b.time, a.time, Timescale.TDB)
		expect(width).toBeGreaterThan(0)
		const exact = orbitStateAt(HYPERBOLA, timeShift(a.time, width / 2))
		if (!exact.ok) throw new Error(exact.reason)
		const middle = hermiteVec3(a.position, a.velocity, b.position, b.velocity, width, 0.5)
		expect(Math.hypot(middle[0] - exact.position[0], middle[1] - exact.position[1], middle[2] - exact.position[2])).toBeLessThanOrEqual(1e-6 * vecLength(exact.position))
	}

	// The periapsis passage is crowded with samples.
	const near = samples.filter((e) => Math.abs(timeSubtract(e.time, EPOCH, Timescale.TDB)) < 20).length
	const far = samples.filter((e) => timeSubtract(e.time, EPOCH, Timescale.TDB) > 360).length
	expect(near).toBeGreaterThan(far)
})

test('states of many revolutions never alias a whole period', () => {
	const result = sampleStates(ECCENTRIC, EPOCH, timeShift(EPOCH, 3 * ECCENTRIC.periodInDays), { initialSamples: 3 })
	if (!result.ok) throw new Error(result.reason)
	expect(result.samples.length).toBeGreaterThan(48)
})

test('states stop at their budget and a non-positive interval gives one state', () => {
	const budget = sampleStates(ECCENTRIC, EPOCH, timeShift(EPOCH, ECCENTRIC.periodInDays), { tolerance: 1e-14, maxSamples: 64 })
	if (!budget.ok) throw new Error(budget.reason)
	expect(budget.truncated).toBeTrue()
	expect(budget.samples.length).toBeLessThanOrEqual(64)

	const single = sampleStates(ECCENTRIC, EPOCH, EPOCH)
	if (!single.ok) throw new Error(single.reason)
	expect(single.samples).toHaveLength(1)
})
