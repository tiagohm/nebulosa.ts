import { expect, test } from 'bun:test'
import type { Daf, Summary } from '../../../src/astronomy/ephemeris/kernels/daf'
import { SPK_FRAME_J2000 } from '../../../src/astronomy/ephemeris/kernels/spk'
import { inspectSpk } from '../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { prepareSpkKernelSet, type SpkKernelEntry } from '../../../src/astronomy/ephemeris/kernels/spk.kernelset'
import { iapetus, mimas, titan } from '../../../src/astronomy/ephemeris/models/analytical/tass17'
import { earth, saturn, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { hasSaturnianTargets, interpolatedSaturnianEphemeris, SATURNIAN_BODIES, SATURNIAN_RADIUS_AU, SATURNIAN_RING_BODIES, saturnianEphemeris } from '../../../src/astronomy/ephemeris/saturnian'
import { analyticalEphemerisSource, EphemerisMiss, spkEphemerisSource } from '../../../src/astronomy/ephemeris/source'
import { findSaturnianMutualEvents, saturnianMutualEvents } from '../../../src/astronomy/events/mutual'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, J2000 } from '../../../src/core/constants'

interface SyntheticSegment {
	readonly center: number
	readonly target: number
	readonly start: number
	readonly end: number
	// Constant position, in km.
	readonly position: readonly [number, number, number]
	readonly frame?: number
	readonly type?: number
}

// Builds an in-memory SPK entry whose type 2 segments each hold one constant Chebyshev record.
function entry(id: string, segments: readonly SyntheticSegment[]): SpkKernelEntry {
	const values: number[] = []
	const summaries: Summary[] = []

	for (const { center, target, start, end, position, frame = SPK_FRAME_J2000, type = 2 } of segments) {
		const startIndex = values.length + 1
		values.push((start + end) / 2, (end - start) / 2, position[0], 0, position[1], 0, position[2], 0, start, end - start, 8, 1)
		summaries.push({ name: `${target}`, doubles: new Float64Array([start, end]), ints: new Int32Array([target, center, frame, type, startIndex, values.length]) })
	}

	const data = Float64Array.from(values)
	const readSync = (start: number, end: number) => data.subarray(start - 1, end)
	const daf: Daf = { summaries, read: readSync, readSync }
	const inspection = inspectSpk(daf, data.byteLength)
	if (!inspection.ok) throw new Error(inspection.error)
	return { id, daf, segments: inspection.segments }
}

function at(seconds: number): Time {
	return { day: J2000, fraction: seconds / DAYSEC, scale: Timescale.TDB }
}

function km(value: number) {
	return value / AU_KM
}

// The planetary part of a NAIF SAT kernel: the Sun and the Earth-Moon barycenter on the SSB, the Earth on
// the EMB, and the Saturnian system barycenter on the SSB.
const PLANETARY: readonly SyntheticSegment[] = [
	{ center: 0, target: 10, start: 0, end: 100, position: [-1000, 0, 0] },
	{ center: 0, target: 3, start: 0, end: 100, position: [150000000, 0, 0] },
	{ center: 3, target: 399, start: 0, end: 100, position: [0, 4000, 0] },
	{ center: 0, target: 6, start: 0, end: 100, position: [1430000000, 0, 0] },
]

// Saturn's centre and the seven major moons on the system barycenter, as in sat441.bsp. Iapetus stops at 50 s.
const SATELLITES: readonly SyntheticSegment[] = [
	{ center: 6, target: 699, start: 0, end: 100, position: [0, 0, 300] },
	{ center: 6, target: 601, start: 0, end: 100, position: [185540, 0, 0] },
	{ center: 6, target: 602, start: 0, end: 100, position: [0, 238040, 0] },
	{ center: 6, target: 603, start: 0, end: 100, position: [-294670, 0, 0] },
	{ center: 6, target: 604, start: 0, end: 100, position: [0, -377420, 0] },
	{ center: 6, target: 605, start: 0, end: 100, position: [527070, 0, 0] },
	{ center: 6, target: 606, start: 0, end: 100, position: [0, 1221870, 0] },
	{ center: 6, target: 608, start: 0, end: 50, position: [-3560840, 0, 0] },
]

test('the analytical source adds TASS 1.7 to VSOP87E Saturn', () => {
	const time = timeYMDHMS(2025, 3, 23, 0, 0, 0, Timescale.UTC)
	expect(saturnianEphemeris(analyticalEphemerisSource).source).toEqual({ kind: 'analytical', planetary: 'VSOP87E', satellites: 'TASS1.7' })
	expect(saturnianEphemeris(analyticalEphemerisSource).position('sun', time)).toEqual([...sun(time)[0]])
	expect(saturnianEphemeris(analyticalEphemerisSource).position('earth', time)).toEqual([...earth(time)[0]])
	expect(saturnianEphemeris(analyticalEphemerisSource).position('saturn', time)).toEqual([...saturn(time)[0]])

	const planet = saturn(time)[0]

	for (const [moon, theory] of [
		['mimas', mimas],
		['titan', titan],
		['iapetus', iapetus],
	] as const) {
		const offset = theory(time)[0]
		expect(saturnianEphemeris(analyticalEphemerisSource).position(moon, time)).toEqual([planet[0] + offset[0], planet[1] + offset[1], planet[2] + offset[2]])
		expect(saturnianEphemeris(analyticalEphemerisSource).planetocentric!(moon, time)).toEqual([...offset])
	}
})

test('the analytical source returns fresh vectors', () => {
	const time = timeYMDHMS(2025, 3, 23, 0, 0, 0, Timescale.UTC)
	const a = saturnianEphemeris(analyticalEphemerisSource).position('titan', time)
	const b = saturnianEphemeris(analyticalEphemerisSource).position('titan', time)
	expect(a).not.toBe(b)
	expect(a).toEqual(b)
})

test('the Saturnian radii are the IAU mean values', () => {
	expect(SATURNIAN_RADIUS_AU.mimas * AU_KM).toBeCloseTo(198.2, 9)
	expect(SATURNIAN_RADIUS_AU.titan * AU_KM).toBeCloseTo(2575, 9)
	expect(SATURNIAN_RADIUS_AU.iapetus * AU_KM).toBeCloseTo(734.5, 9)
})

test('the SPK source resolves Saturn and its moons through barycenter 6', async () => {
	const set = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('sat', SATELLITES)])
	expect(hasSaturnianTargets(spkEphemerisSource(set))).toBeTrue()

	const ephemeris = saturnianEphemeris(spkEphemerisSource(set))
	expect(ephemeris.source).toEqual({ kind: 'spk', kernels: ['planets', 'sat'] })

	const time = at(25)

	// Saturn is the planet centre (699), offset from its barycenter (6), never the barycenter itself.
	const saturnPosition = ephemeris.position('saturn', time)
	expect(saturnPosition[0]).toBeCloseTo(km(1430000000), 12)
	expect(saturnPosition[2]).toBeCloseTo(km(300), 15)

	const titanPosition = ephemeris.position('titan', time)
	expect(titanPosition[0]).toBeCloseTo(km(1430000000), 12)
	expect(titanPosition[1]).toBeCloseTo(km(1221870), 12)
	expect(titanPosition[2]).toBe(0)

	expect(ephemeris.kernelsByBody!.get('titan')).toEqual(new Set(['sat', 'planets']))
	expect(ephemeris.kernelsByBody!.has('mimas')).toBeFalse()
})

test('the SPK source throws a miss with the reason and the failing link', async () => {
	const set = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('sat', SATELLITES)])
	const ephemeris = saturnianEphemeris(spkEphemerisSource(set))

	try {
		ephemeris.position('iapetus', at(75))
		throw new Error('expected a miss')
	} catch (e) {
		expect(e).toBeInstanceOf(EphemerisMiss)
		const miss = e as EphemerisMiss
		expect(miss.target).toBe(608)
		expect(miss.body).toBe(608)
		expect(miss.reason).toBe('coverage')
	}

	// A missing moon.
	const withoutMimas = await prepareSpkKernelSet([
		entry('planets', PLANETARY),
		entry(
			'sat',
			SATELLITES.filter((s) => s.target !== 601),
		),
	])
	expect(hasSaturnianTargets(spkEphemerisSource(withoutMimas))).toBeFalse()

	try {
		saturnianEphemeris(spkEphemerisSource(withoutMimas)).position('mimas', at(25))
		throw new Error('expected a miss')
	} catch (e) {
		expect((e as EphemerisMiss).reason).toBe('missing')
		expect((e as EphemerisMiss).body).toBe(601)
	}

	// A missing system barycenter.
	const withoutBarycenter = await prepareSpkKernelSet([
		entry(
			'planets',
			PLANETARY.filter((s) => s.target !== 6),
		),
		entry('sat', SATELLITES),
	])

	try {
		saturnianEphemeris(spkEphemerisSource(withoutBarycenter)).position('saturn', at(25))
		throw new Error('expected a miss')
	} catch (e) {
		expect((e as EphemerisMiss).reason).toBe('missing')
		expect((e as EphemerisMiss).body).toBe(6)
	}

	// An unsupported data type selected for Saturn's centre.
	const unsupported = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('sat', SATELLITES), entry('odd', [{ center: 6, target: 699, start: 0, end: 100, position: [0, 0, 0], frame: 17 }])])

	try {
		saturnianEphemeris(spkEphemerisSource(unsupported)).position('saturn', at(25))
		throw new Error('expected a miss')
	} catch (e) {
		expect((e as EphemerisMiss).reason).toBe('frame')
		expect((e as EphemerisMiss).body).toBe(699)
	}
})

test('a ring-only kernel resolves the ring bodies without any moon', async () => {
	// Like sat480.bsp: the Sun, the Earth and Saturn's centre, but none of the major moons.
	const set = await prepareSpkKernelSet([
		entry('planets', PLANETARY),
		entry(
			'rings',
			SATELLITES.filter((s) => s.target === 699),
		),
	])
	expect(hasSaturnianTargets(spkEphemerisSource(set))).toBeFalse()
	expect(hasSaturnianTargets(spkEphemerisSource(set), SATURNIAN_RING_BODIES)).toBeTrue()

	const ephemeris = saturnianEphemeris(spkEphemerisSource(set))
	for (const body of SATURNIAN_RING_BODIES) expect(ephemeris.position(body, at(25)).every(Number.isFinite)).toBeTrue()
	expect(() => ephemeris.position('titan', at(25))).toThrow(EphemerisMiss)
})

test('the interpolated source stays within 0.1 km of the analytical one', () => {
	const ephemeris = interpolatedSaturnianEphemeris(analyticalEphemerisSource)
	expect(ephemeris.source).toBe(saturnianEphemeris(analyticalEphemerisSource).source)
	const start = timeYMDHMS(2025, 3, 1, 0, 0, 0, Timescale.UTC)

	for (let i = 0; i < 120; i++) {
		// Irregular epochs, so they fall at every phase between the nodes.
		const time = timeShift(start, i * 0.0371)

		for (const body of SATURNIAN_BODIES) {
			const exact = saturnianEphemeris(analyticalEphemerisSource).position(body, time)
			const interpolated = ephemeris.position(body, time)
			expect(Math.hypot(exact[0] - interpolated[0], exact[1] - interpolated[1], exact[2] - interpolated[2]) * AU_KM).toBeLessThan(0.1)
		}
	}
})

test('the interpolated source propagates a kernel miss from its nodes', async () => {
	const set = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('sat', SATELLITES)])
	const ephemeris = interpolatedSaturnianEphemeris(spkEphemerisSource(set))
	expect(ephemeris.source).toEqual({ kind: 'spk', kernels: ['planets', 'sat'] })
	// The synthetic segments cover 100 s around J2000, far less than one interpolation node step.
	expect(() => ephemeris.position('titan', at(50))).toThrow(EphemerisMiss)
})

test('the source-aware Saturnian mutual finder matches the analytical one and propagates a miss', async () => {
	// The 2025-03-12 Titan-Rhea occultation (impact parameter ~0.245).
	const start = timeYMDHMS(2025, 3, 12, 10, 0, 0, Timescale.UTC)
	const stop = timeYMDHMS(2025, 3, 12, 13, 0, 0, Timescale.UTC)
	const legacy = saturnianMutualEvents(saturnianEphemeris(analyticalEphemerisSource), start, stop)
	const injected = findSaturnianMutualEvents(saturnianEphemeris(analyticalEphemerisSource), start, stop)
	expect(injected.length).toBeGreaterThan(0)

	for (const event of injected) {
		const same = legacy.find((e) => e.kind === event.kind && e.front === event.front && e.back === event.back)
		expect(same).toBeDefined()
		expect(timeSubtract(same!.middle, event.middle) * DAYSEC).toBeCloseTo(0, 6)
		expect(same!.impactParameter).toBeCloseTo(event.impactParameter, 9)
	}

	// A kernel set without the moons abandons the search instead of completing it with another source.
	const set = await prepareSpkKernelSet([
		entry('planets', PLANETARY),
		entry(
			'rings',
			SATELLITES.filter((s) => s.target === 699),
		),
	])
	expect(() => findSaturnianMutualEvents(saturnianEphemeris(spkEphemerisSource(set)), at(0), at(60))).toThrow(EphemerisMiss)
})
