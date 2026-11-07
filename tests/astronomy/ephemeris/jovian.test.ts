import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { analyticalJovianEphemeris, GALILEAN_RADIUS_AU, hasJovianTargets, interpolatedJovianEphemeris, JOVIAN_BODIES, JovianEphemerisMiss, spkJovianEphemeris } from '../../../src/astronomy/ephemeris/jovian'
import { type Daf, readDaf, type Summary } from '../../../src/astronomy/ephemeris/kernels/daf'
import { SPK_FRAME_J2000 } from '../../../src/astronomy/ephemeris/kernels/spk'
import { inspectSpk } from '../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { prepareSpkKernelSet, type SpkKernelEntry } from '../../../src/astronomy/ephemeris/kernels/spk.kernelset'
import { callisto, io } from '../../../src/astronomy/ephemeris/models/analytical/l12'
import { earth, jupiter, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { findGalileanMutualEvents, galileanMutualEvents } from '../../../src/astronomy/events/mutual'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, J2000 } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { downloadPerTag } from '../../download'

await downloadPerTag('spk')

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

// A complete synthetic Jovian chain: the Sun and the Earth-Moon barycenter on the SSB, the Earth on the EMB,
// Jupiter's centre on its system barycenter, Io and Europa on Jupiter's centre, Ganymede and Callisto on
// the system barycenter, as in the NAIF JUP kernels.
const PLANETARY: readonly SyntheticSegment[] = [
	{ center: 0, target: 10, start: 0, end: 100, position: [-1000, 0, 0] },
	{ center: 0, target: 3, start: 0, end: 100, position: [150000000, 0, 0] },
	{ center: 3, target: 399, start: 0, end: 100, position: [0, 4000, 0] },
	{ center: 0, target: 5, start: 0, end: 100, position: [778000000, 0, 0] },
]

const SATELLITES: readonly SyntheticSegment[] = [
	{ center: 5, target: 599, start: 0, end: 100, position: [0, 0, 100] },
	{ center: 599, target: 501, start: 0, end: 100, position: [421700, 0, 0] },
	{ center: 599, target: 502, start: 0, end: 100, position: [0, 671000, 0] },
	{ center: 5, target: 503, start: 0, end: 100, position: [-1070400, 0, 0] },
	{ center: 5, target: 504, start: 0, end: 50, position: [0, -1882700, 0] },
]

test('the analytical source adds L1.2 to VSOP87E Jupiter', () => {
	const time = timeYMDHMS(2026, 12, 5, 19, 0, 0, Timescale.UTC)
	expect(analyticalJovianEphemeris.source).toEqual({ kind: 'analytical', planetary: 'VSOP87E', satellites: 'L1.2' })
	expect(analyticalJovianEphemeris.position('sun', time)).toEqual([...sun(time)[0]])
	expect(analyticalJovianEphemeris.position('earth', time)).toEqual([...earth(time)[0]])
	expect(analyticalJovianEphemeris.position('jupiter', time)).toEqual([...jupiter(time)[0]])

	const planet = jupiter(time)[0]
	const offset = io(time)[0]
	expect(analyticalJovianEphemeris.position('io', time)).toEqual([planet[0] + offset[0], planet[1] + offset[1], planet[2] + offset[2]])

	const outer = callisto(time)[0]
	expect(analyticalJovianEphemeris.position('callisto', time)).toEqual([planet[0] + outer[0], planet[1] + outer[1], planet[2] + outer[2]])
})

test('the analytical source returns fresh vectors', () => {
	const time = timeYMDHMS(2026, 12, 5, 19, 0, 0, Timescale.UTC)
	const a = analyticalJovianEphemeris.position('io', time)
	const b = analyticalJovianEphemeris.position('io', time)
	expect(a).not.toBe(b)
	expect(a).toEqual(b)
})

test('the Galilean radii are the IAU mean values', () => {
	expect(GALILEAN_RADIUS_AU.io * AU_KM).toBeCloseTo(1821.6, 9)
	expect(GALILEAN_RADIUS_AU.ganymede * AU_KM).toBeCloseTo(2631.2, 9)
})

test('the SPK source resolves every body through its center chain', async () => {
	const set = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('jup', SATELLITES)])
	expect(hasJovianTargets(set)).toBeTrue()

	const ephemeris = spkJovianEphemeris(set)
	expect(ephemeris.source).toEqual({ kind: 'spk', kernels: ['planets', 'jup'] })

	const time = at(25)
	const sunPosition = ephemeris.position('sun', time)
	expect(sunPosition[0]).toBeCloseTo(km(-1000), 15)

	const earthPosition = ephemeris.position('earth', time)
	expect(earthPosition[0]).toBeCloseTo(km(150000000), 12)
	expect(earthPosition[1]).toBeCloseTo(km(4000), 15)

	// Jupiter is the planet centre (599), offset from its barycenter (5), never the barycenter itself.
	const jupiterPosition = ephemeris.position('jupiter', time)
	expect(jupiterPosition[0]).toBeCloseTo(km(778000000), 12)
	expect(jupiterPosition[2]).toBeCloseTo(km(100), 15)

	const ioPosition = ephemeris.position('io', time)
	expect(ioPosition[0]).toBeCloseTo(km(778000000 + 421700), 12)
	expect(ioPosition[2]).toBeCloseTo(km(100), 15)

	const ganymedePosition = ephemeris.position('ganymede', time)
	expect(ganymedePosition[0]).toBeCloseTo(km(778000000 - 1070400), 12)
	expect(ganymedePosition[2]).toBe(0)

	expect(ephemeris.kernelsByBody.get('io')).toEqual(new Set(['jup', 'planets']))
	expect(ephemeris.kernelsByBody.get('earth')).toEqual(new Set(['planets']))
	expect(ephemeris.kernelsByBody.has('callisto')).toBeFalse()
})

test('the SPK source throws a miss with the reason and the failing link', async () => {
	const set = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('jup', SATELLITES)])
	const ephemeris = spkJovianEphemeris(set)

	// Callisto's segment ends at 50 s: a coverage gap.
	expect(() => ephemeris.position('callisto', at(75))).toThrow(JovianEphemerisMiss)

	try {
		ephemeris.position('callisto', at(75))
	} catch (e) {
		expect(e).toBeInstanceOf(JovianEphemerisMiss)
		const miss = e as JovianEphemerisMiss
		expect(miss.target).toBe('callisto')
		expect(miss.body).toBe(504)
		expect(miss.reason).toBe('coverage')
	}
})

test('the SPK source reports a missing center and an unsupported selected segment', async () => {
	// Jupiter's centre is present but its barycenter is not.
	const withoutBarycenter = await prepareSpkKernelSet([
		entry(
			'planets',
			PLANETARY.filter((s) => s.target !== 5),
		),
		entry('jup', SATELLITES),
	])
	expect(hasJovianTargets(withoutBarycenter)).toBeTrue()

	try {
		spkJovianEphemeris(withoutBarycenter).position('io', at(25))
		throw new Error('expected a miss')
	} catch (e) {
		const miss = e as JovianEphemerisMiss
		expect(miss.reason).toBe('missing')
		expect(miss.target).toBe('io')
		expect(miss.body).toBe(5)
	}

	// A later, higher-precedence segment in an ecliptic frame is selected and never bypassed.
	const ecliptic = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('jup', SATELLITES), entry('ecliptic', [{ center: 5, target: 599, start: 0, end: 100, position: [0, 0, 0], frame: 17 }])])

	try {
		spkJovianEphemeris(ecliptic).position('jupiter', at(25))
		throw new Error('expected a miss')
	} catch (e) {
		const miss = e as JovianEphemerisMiss
		expect(miss.reason).toBe('frame')
		expect(miss.body).toBe(599)
	}
})

test('a planetary kernel alone is not a Jovian source', async () => {
	await using source = fileHandleSource(await fs.open('data/de440s.bsp'))
	const daf = await readDaf(source)
	const inspection = inspectSpk(daf, (await fs.stat('data/de440s.bsp')).size)
	if (!inspection.ok) throw new Error(inspection.error)

	const set = await prepareSpkKernelSet([{ id: 'de440s', daf, segments: inspection.segments }])
	// DE440s carries the Jovian system barycenter (5) but not Jupiter's centre (599) nor its satellites.
	expect(set.bodies.has(5)).toBeTrue()
	expect(hasJovianTargets(set)).toBeFalse()

	try {
		spkJovianEphemeris(set).position('jupiter', timeYMDHMS(2026, 12, 5, 0, 0, 0, Timescale.UTC))
		throw new Error('expected a miss')
	} catch (e) {
		expect((e as JovianEphemerisMiss).reason).toBe('missing')
		expect((e as JovianEphemerisMiss).body).toBe(599)
	}
})

test('the source-aware mutual finder keeps contacts and partitions windows by maximum', () => {
	// The 2026-12-05 Europa-Ganymede occultation peaks at ~19:17:52 UTC and lasts ~17.7 min.
	const start = timeYMDHMS(2026, 12, 5, 19, 20, 0, Timescale.UTC)
	const stop = timeYMDHMS(2026, 12, 5, 19, 30, 0, Timescale.UTC)

	// Its maximum lies before this window, so the half-open finder does not report it here...
	expect(findGalileanMutualEvents(analyticalJovianEphemeris, start, stop).length).toBe(0)

	// ...but reports it, with both contacts, in the window holding its maximum.
	const before = timeYMDHMS(2026, 12, 5, 19, 0, 0, Timescale.UTC)
	const events = findGalileanMutualEvents(analyticalJovianEphemeris, before, start)
	expect(events.length).toBe(1)
	expect(events[0].start).toBeDefined()
	expect(events[0].end).toBeDefined()
	expect(timeSubtract(events[0].end!, start)).toBeGreaterThan(0)

	// The legacy wrapper gives the same maximum from the same analytical positions.
	const legacy = galileanMutualEvents(start, stop)
	expect(legacy.length).toBe(1)
	expect(timeSubtract(legacy[0].middle, events[0].middle) * DAYSEC).toBeCloseTo(0, 6)
	expect(timeSubtract(legacy[0].end!, events[0].end!) * DAYSEC).toBeCloseTo(0, 6)
})

test('the interpolated source stays within 0.1 km of the analytical one', () => {
	const ephemeris = interpolatedJovianEphemeris(analyticalJovianEphemeris)
	expect(ephemeris.source).toBe(analyticalJovianEphemeris.source)
	const start = timeYMDHMS(2026, 12, 1, 0, 0, 0, Timescale.UTC)

	for (let i = 0; i < 120; i++) {
		// Irregular epochs, so they fall at every phase between the nodes.
		const time = timeShift(start, i * 0.0371)

		for (const body of JOVIAN_BODIES) {
			const exact = analyticalJovianEphemeris.position(body, time)
			const interpolated = ephemeris.position(body, time)
			expect(Math.hypot(exact[0] - interpolated[0], exact[1] - interpolated[1], exact[2] - interpolated[2]) * AU_KM).toBeLessThan(0.1)
		}
	}
})

test('the interpolated source propagates a kernel miss from its nodes', async () => {
	const set = await prepareSpkKernelSet([entry('planets', PLANETARY), entry('jup', SATELLITES)])
	const ephemeris = interpolatedJovianEphemeris(spkJovianEphemeris(set))
	expect(ephemeris.source).toEqual({ kind: 'spk', kernels: ['planets', 'jup'] })
	// The synthetic segments cover 100 s around J2000, far less than one interpolation node step.
	expect(() => ephemeris.position('io', at(50))).toThrow(JovianEphemerisMiss)
})
