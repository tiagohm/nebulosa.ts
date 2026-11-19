import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readDaf } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { inspectSpk } from '../../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { prepareSpkKernelSet } from '../../../../src/astronomy/ephemeris/kernels/spk.kernelset'
import { type EphemerisSource, spkEphemerisSource } from '../../../../src/astronomy/ephemeris/source'
import { KeplerOrbit } from '../../../../src/astronomy/orbits/asteroid'
import { DE440_PERTURBERS, nonGravitationalDistanceLaw, SmallBodyPropagator, type SmallBodyForceModel } from '../../../../src/astronomy/orbits/propagation/nbody'
import { type Time, Timescale, time, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { AU_KM, GM_SUN_DE440_KM3_S2, MU_KM3_S2_TO_AU3_D2, SPEED_OF_LIGHT_AU_DAY } from '../../../../src/core/constants'
import { fileHandleSource } from '../../../../src/io/file'
import { matIdentity } from '../../../../src/math/linear-algebra/mat3'
import { downloadPerTag } from '../../../download'

await downloadPerTag('spk')

const GM_SUN = GM_SUN_DE440_KM3_S2 * MU_KM3_S2_TO_AU3_D2
const SUN_ONLY: SmallBodyForceModel = { perturbers: [{ naif: 10, gm: GM_SUN }], relativity: false }
const EPOCH = time(2460676, 0.5, Timescale.TDB)

// A Sun at rest at the origin, so barycentric and heliocentric states coincide.
const RESTING_SUN: EphemerisSource = {
	kind: 'analytical',
	has: (naif) => naif === 10,
	state: () => [
		[0, 0, 0],
		[0, 0, 0],
	],
}

function at(days: number): Time {
	return time(2460676, 0.5 + days, Timescale.TDB)
}

function distance(a: readonly number[], b: readonly number[]) {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function eccentricityVector([r, v]: readonly [readonly number[], readonly number[]], gm: number) {
	const rl = Math.hypot(r[0], r[1], r[2])
	const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
	const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
	return [0, 1, 2].map((i) => ((v2 - gm / rl) * r[i] - rv * v[i]) / gm)
}

function semiMajorAxis([r, v]: readonly [readonly number[], readonly number[]], gm: number) {
	const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
	return 1 / (2 / Math.hypot(r[0], r[1], r[2]) - v2 / gm)
}

test('the Sun alone reproduces the Kepler orbit forward and backward', () => {
	const position = [0.4, -1.1, 0.25] as const
	const velocity = [0.018, 0.009, -0.002] as const
	const kepler = new KeplerOrbit(position, velocity, EPOCH, GM_SUN, matIdentity())

	// KeplerOrbit measures the elapsed time in TT and the propagator in TDB; their periodic difference (up to 1.7 ms)
	// moves the particle by tens of meters, so the comparison allows 1e-9 AU (150 m).
	for (const days of [1000, -1000]) {
		const propagator = new SmallBodyPropagator(RESTING_SUN, SUN_ONLY, EPOCH, position, velocity)
		expect(propagator.advance(at(days))).toBeTrue()
		expect(propagator.offset).toBe(days)
		const [p, v] = propagator.state()
		const [kp, kv] = kepler.at(at(days))
		expect(distance(p, kp)).toBeLessThan(1e-9)
		expect(distance(v, kv)).toBeLessThan(1e-11)
	}
})

test('propagating forward and back returns to the initial state', () => {
	const position = [0.4, -1.1, 0.25] as const
	const velocity = [0.018, 0.009, -0.002] as const
	const propagator = new SmallBodyPropagator(RESTING_SUN, SUN_ONLY, EPOCH, position, velocity)
	propagator.advance(at(1000))
	propagator.advance(EPOCH)
	const [p, v] = propagator.state()
	expect(propagator.offset).toBe(0)
	expect(distance(p, position)).toBeLessThan(1e-12)
	expect(distance(v, velocity)).toBeLessThan(1e-14)
})

test('the solar relativistic term advances the perihelion as general relativity predicts', () => {
	// A Mercury-like orbit: a = 0.387 AU, e = 0.2056, started at perihelion.
	const a = 0.387
	const e = 0.2056
	const q = a * (1 - e)
	const position = [q, 0, 0] as const
	const velocity = [0, Math.sqrt((GM_SUN * (1 + e)) / q), 0] as const
	const period = 2 * Math.PI * Math.sqrt((a * a * a) / GM_SUN)
	const orbits = 20

	function perihelionLongitude(relativity: boolean) {
		const propagator = new SmallBodyPropagator(RESTING_SUN, { ...SUN_ONLY, relativity }, EPOCH, position, velocity)
		propagator.advance(at(orbits * period))
		const ev = eccentricityVector(propagator.state(), GM_SUN)
		return Math.atan2(ev[1], ev[0])
	}

	const advance = perihelionLongitude(true) - perihelionLongitude(false)
	const expected = (orbits * 6 * Math.PI * GM_SUN) / (SPEED_OF_LIGHT_AU_DAY ** 2 * a * (1 - e * e))
	expect(advance / expected).toBeCloseTo(1, 2)
})

test('a transverse Yarkovsky coefficient drifts the semi-major axis at 2·A2/n', () => {
	const position = [1, 0, 0] as const
	const velocity = [0, Math.sqrt(GM_SUN), 0] as const
	const a2 = 1e-10
	const days = 1000

	function finalSemiMajorAxis(coefficient: number) {
		const model: SmallBodyForceModel = { ...SUN_ONLY, nonGravitational: { model: 'asteroid', a1: 0, a2: coefficient, a3: 0 } }
		const propagator = new SmallBodyPropagator(RESTING_SUN, model, EPOCH, position, velocity)
		propagator.advance(at(days))
		return semiMajorAxis(propagator.state(), GM_SUN)
	}

	const drift = finalSemiMajorAxis(a2) - finalSemiMajorAxis(0)
	expect(drift / ((2 * a2 * days) / Math.sqrt(GM_SUN))).toBeCloseTo(1, 2)
	expect(finalSemiMajorAxis(-a2)).toBeLessThan(1)
})

test('the cometary distance law is normalized to 1 at 1 AU and falls steeply beyond 3 AU', () => {
	expect(nonGravitationalDistanceLaw('comet', 1)).toBeCloseTo(1, 3)
	expect(nonGravitationalDistanceLaw('asteroid', 2)).toBe(0.25)
	expect(nonGravitationalDistanceLaw('comet', 5)).toBeLessThan(0.01)
})

test('chunked advances and step bounds', () => {
	const position = [1, 0, 0] as const
	const velocity = [0, Math.sqrt(GM_SUN), 0] as const
	const instants: number[] = []
	const chunked = new SmallBodyPropagator(RESTING_SUN, SUN_ONLY, EPOCH, position, velocity, { maxRelativeStep: 0.05, onStep: (t) => instants.push(t.day - 2460676 + t.fraction - 0.5) })
	let calls = 1
	while (!chunked.advance(at(400), 10)) calls++

	const whole = new SmallBodyPropagator(RESTING_SUN, SUN_ONLY, EPOCH, position, velocity, { maxRelativeStep: 0.05 })
	expect(whole.advance(at(400))).toBeTrue()

	expect(calls).toBeGreaterThan(5)
	expect(chunked.state()).toEqual(whole.state())
	expect(instants.at(-1)).toBeCloseTo(400, 9)

	// On a circular orbit at 1 AU the speed over the distance is 0.0172 per day, so no step exceeds 0.05 / 0.0172 days.
	for (let i = 1; i < instants.length; i++) expect(instants[i] - instants[i - 1]).toBeLessThanOrEqual(0.05 / Math.sqrt(GM_SUN) + 1e-9)
})

test('relativity without the Sun among the perturbers throws', () => {
	expect(() => new SmallBodyPropagator(RESTING_SUN, { perturbers: [], relativity: true }, EPOCH, [1, 0, 0], [0, 0.017, 0])).toThrow()
})

test('the Mars barycenter as a test particle follows DE440s within a kilometer for a year', async () => {
	await using source = fileHandleSource(await fs.open('data/de440s.bsp'))
	const daf = await readDaf(source)
	const inspection = inspectSpk(daf, (await fs.stat('data/de440s.bsp')).size)
	if (!inspection.ok) throw new Error(inspection.error)
	const ephemeris = spkEphemerisSource(await prepareSpkKernelSet([{ id: 'de440s', daf, segments: inspection.segments }]))
	const model: SmallBodyForceModel = { perturbers: DE440_PERTURBERS.filter((e) => e.naif !== 4), relativity: true }
	const epoch = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TDB)
	const [position, velocity] = ephemeris.state(4, epoch)

	for (const days of [365, -365]) {
		const propagator = new SmallBodyPropagator(ephemeris, model, epoch, position, velocity)
		const end = time(epoch.day, epoch.fraction + days, Timescale.TDB)
		propagator.advance(end)
		expect(distance(propagator.state()[0], ephemeris.state(4, end)[0]) * AU_KM).toBeLessThan(MARS_TOLERANCE_KM)
	}
})

// DE440 integrates Mars with 343 asteroids and the full Einstein-Infeld-Hoffmann equations; the test particle has only
// the planets and the Sun's post-Newtonian term, so the residual over one year (0.08 km forward and 0.23 km backward
// from 2025) is dominated by the missing asteroids.
const MARS_TOLERANCE_KM = 1
