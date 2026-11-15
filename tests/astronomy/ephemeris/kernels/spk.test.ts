import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { type Daf, readDaf, type Summary } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../../src/astronomy/ephemeris/kernels/naif'
import { MultipleSpkSegment, readSpk, SPK_FRAME_J2000, Type17Segment, Type21Segment, Type2And3Segment, Type9Segment } from '../../../../src/astronomy/ephemeris/kernels/spk'
import { Timescale, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, J2000 } from '../../../../src/core/constants'
import { fileHandleSource } from '../../../../src/io/file'
import { rangeHttpSource } from '../../../../src/io/io'
import { downloadPerTag } from '../../../download'

await downloadPerTag('spk')

const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)

// Builds a tiny in-memory DAF for deterministic SPK segment tests.
function dafFrom(values: readonly number[], summaries: Summary[] = []): Daf {
	const data = Float64Array.from(values)
	const readSync = (start: number, end: number) => data.subarray(start - 1, end)
	return { summaries, read: readSync, readSync }
}

// Builds a minimal SPK summary with one segment descriptor.
function summary(center: number, target: number, start: number, end: number, type: number, startIndex: number, endIndex: number, frame = SPK_FRAME_J2000): Summary {
	return {
		name: '',
		doubles: new Float64Array([start, end]),
		ints: new Int32Array([target, center, frame, type, startIndex, endIndex]),
	}
}

test('type 2 segment includes the final endpoint', async () => {
	const segment = new Type2And3Segment(dafFrom([4, 4, 1, 2, 3, 4, 5, 6, 0, 8, 8, 1]), 0, 8, 0, 1, SPK_FRAME_J2000, 2, 1, 12)
	await segment.initialize()
	const [p, v] = segment.at({ day: J2000, fraction: 8 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(3 / AU_KM, 15)
	expect(p[1]).toBeCloseTo(7 / AU_KM, 15)
	expect(p[2]).toBeCloseTo(11 / AU_KM, 15)
	expect(v[0]).toBeCloseTo((0.5 * DAYSEC) / AU_KM, 15)
	expect(v[1]).toBeCloseTo(DAYSEC / AU_KM, 15)
	expect(v[2]).toBeCloseTo((1.5 * DAYSEC) / AU_KM, 15)
})

test('type 3 segment evaluates velocity from the stored velocity coefficients', async () => {
	const segment = new Type2And3Segment(dafFrom([4, 4, 10, 2, 20, 3, 30, 4, 100, 0, 200, 0, 300, 0, 0, 8, 14, 1]), 0, 8, 0, 1, SPK_FRAME_J2000, 3, 1, 18)
	await segment.initialize()
	const [p, v] = segment.at({ day: J2000, fraction: 4 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(10 / AU_KM, 15)
	expect(p[1]).toBeCloseTo(20 / AU_KM, 15)
	expect(p[2]).toBeCloseTo(30 / AU_KM, 15)
	expect(v[0]).toBeCloseTo((100 * DAYSEC) / AU_KM, 15)
	expect(v[1]).toBeCloseTo((200 * DAYSEC) / AU_KM, 15)
	expect(v[2]).toBeCloseTo((300 * DAYSEC) / AU_KM, 15)
})

test('type 9 odd interpolation window is centered on the closest epoch', async () => {
	const segment = new Type9Segment(dafFrom([0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 216, 0, 0, 0, 0, 0, 0, 2, 4, 6, 2, 4]), 0, 6, 0, 1, SPK_FRAME_J2000, 1, 30)
	await segment.initialize()
	const [p, v] = segment.at({ day: J2000, fraction: 2.1 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(9.66 / AU_KM, 14)
	expect(p[1]).toBeCloseTo(0, 15)
	expect(p[2]).toBeCloseTo(0, 15)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('type 17 circular orbit without precession moves on the equator of a pole at the J2000 pole', async () => {
	// Epoch 0, a = 1000 km, e = 0, mean longitude 0, i = 0, mean motion 0.001 rad/s, pole RA -90° and Dec 90°, so the
	// equator of the central body is the J2000 equator with the same x axis.
	const segment = new Type17Segment(dafFrom([0, 1000, 0, 0, 0, 0, 0, 0, 0.001, 0, -Math.PI / 2, Math.PI / 2]), -1000, 1000, 699, 635, SPK_FRAME_J2000, 1, 12)
	await segment.initialize()
	const [p, v] = segment.at({ day: J2000, fraction: 500 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo((1000 * Math.cos(0.5)) / AU_KM, 15)
	expect(p[1]).toBeCloseTo((1000 * Math.sin(0.5)) / AU_KM, 15)
	expect(p[2]).toBeCloseTo(0, 15)
	expect(v[0]).toBeCloseTo((-Math.sin(0.5) * DAYSEC) / AU_KM, 15)
	expect(v[1]).toBeCloseTo((Math.cos(0.5) * DAYSEC) / AU_KM, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('type 17 rejects an eccentricity above 0.9', async () => {
	const segment = new Type17Segment(dafFrom([0, 1000, 0.6, 0.7, 0, 0, 0, 0, 0.001, 0, 0, Math.PI / 2]), -1000, 1000, 699, 635, SPK_FRAME_J2000, 1, 12)
	await expect(segment.initialize()).rejects.toThrow('SPK type 17 eccentricity')
})

test('overlapping segments use the latest matching segment in file order', async () => {
	const spk = readSpk(dafFrom([10, 10, 1, 0, 0, 0, 20, 5, 1, 10, 10, 2, 0, 0, 0, 20, 5, 1], [summary(0, 1, 0, 20, 2, 1, 9), summary(0, 1, 10, 20, 2, 10, 18)]))
	const merged = (await spk.segment(0, 1))!
	expect(merged.frame).toBe(SPK_FRAME_J2000)
	const [earlyPosition, earlyVelocity] = merged.at({ day: J2000, fraction: 5 / DAYSEC, scale: Timescale.TDB })
	const [p, v] = (await spk.segment(0, 1))!.at({ day: J2000, fraction: 10 / DAYSEC, scale: Timescale.TDB })

	expect(earlyPosition[0]).toBeCloseTo(1 / AU_KM, 15)
	expect(earlyPosition[1]).toBeCloseTo(0, 15)
	expect(earlyPosition[2]).toBeCloseTo(0, 15)
	expect(earlyVelocity[0]).toBeCloseTo(0, 15)
	expect(earlyVelocity[1]).toBeCloseTo(0, 15)
	expect(earlyVelocity[2]).toBeCloseTo(0, 15)
	expect(p[0]).toBeCloseTo(2 / AU_KM, 15)
	expect(p[1]).toBeCloseTo(0, 15)
	expect(p[2]).toBeCloseTo(0, 15)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('segments retain the descriptor reference frame', () => {
	// NAIF frame 17 is ECLIPJ2000, distinct from J2000 (frame 1).
	const ecliptic = 17
	const type2 = new Type2And3Segment(dafFrom([]), 0, 1, Naif.SSB, Naif.EARTH, ecliptic, 2, 1, 1)
	const type9 = new Type9Segment(dafFrom([]), 0, 1, Naif.SSB, Naif.EARTH, ecliptic, 1, 1)
	const type21 = new Type21Segment(dafFrom([]), 0, 1, Naif.SSB, Naif.EARTH, ecliptic, 1, 1)
	expect(type2.frame).toBe(ecliptic)
	expect(type9.frame).toBe(ecliptic)
	expect(type21.frame).toBe(ecliptic)
	const merged = new MultipleSpkSegment([type2, new Type2And3Segment(dafFrom([]), 2, 3, Naif.SSB, Naif.EARTH, ecliptic, 2, 1, 1)])
	expect(merged.frame).toBe(ecliptic)
	expect(() => new MultipleSpkSegment([type2, new Type2And3Segment(dafFrom([]), 2, 3, Naif.SSB, Naif.EARTH, SPK_FRAME_J2000, 2, 1, 1)])).toThrow('one of the segments does not match the reference frame')

	const spk = readSpk(dafFrom([], [summary(Naif.SSB, Naif.EARTH, 0, 20, 2, 1, 9, ecliptic)]))
	expect(spk.segments[0][2].frame).toBe(ecliptic)
	expect(() => readSpk(dafFrom([], [summary(Naif.SSB, Naif.EARTH, 0, 10, 2, 1, 2, ecliptic), summary(Naif.SSB, Naif.EARTH, 10, 20, 2, 3, 4, SPK_FRAME_J2000)]))).toThrow('one of the segments does not match the reference frame')
})

test('segment lookup returns undefined for an unknown center/target pair', async () => {
	const spk = readSpk(dafFrom([10, 10, 1, 0, 0, 0, 20, 5, 1], [summary(0, 1, 0, 20, 2, 1, 9)]))

	expect(await spk.segment(0, 1)).toBeDefined()
	expect(await spk.segment(0, 2)).toBeUndefined()
	expect(await spk.segment(7, 9)).toBeUndefined()
})

test('DE405', async () => {
	await using source = fileHandleSource(await fs.open('data/de405.bsp'))
	const daf = await readDaf(source)
	const s = readSpk(daf)

	const segment = await s.segment(Naif.SSB, Naif.EMB)
	expect(segment).toBeDefined()
	const [p, v] = segment!.at(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-4.233964762021999e-1, 5)
	expect(p[1]).toBeCloseTo(8.124609657969613e-1, 5)
	expect(p[2]).toBeCloseTo(3.523864507181277e-1, 5)

	expect(v[0]).toBeCloseTo(-1.584863352414356e-2, 9)
	expect(v[1]).toBeCloseTo(-6.766164807834689e-3, 9)
	expect(v[2]).toBeCloseTo(-2.933074405477159e-3, 9)
})

test('DE421', async () => {
	await using source = fileHandleSource(await fs.open('data/de421.bsp'))
	const daf = await readDaf(source)
	const spk = readSpk(daf)

	const segment = await spk.segment(Naif.SSB, Naif.EMB)
	expect(segment).toBeDefined()
	const [p, v] = segment!.at(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-4.233964762021999e-1, 5)
	expect(p[1]).toBeCloseTo(8.124609657969613e-1, 5)
	expect(p[2]).toBeCloseTo(3.523864507181277e-1, 5)

	expect(v[0]).toBeCloseTo(-1.584863352414356e-2, 9)
	expect(v[1]).toBeCloseTo(-6.766164807834689e-3, 9)
	expect(v[2]).toBeCloseTo(-2.933074405477159e-3, 9)
})

test('DE440', async () => {
	await using source = fileHandleSource(await fs.open('data/de440s.bsp'))
	const daf = await readDaf(source)
	const s = readSpk(daf)

	const segment = await s.segment(Naif.SSB, Naif.EMB)
	expect(segment).toBeDefined()
	const [p, v] = segment!.at(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/ {source: DE441}
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(-4.233964762021999e-1, 15)
	expect(p[1]).toBeCloseTo(8.124609657969613e-1, 15)
	expect(p[2]).toBeCloseTo(3.523864507181277e-1, 15)

	expect(v[0]).toBeCloseTo(-1.584863352414356e-2, 15)
	expect(v[1]).toBeCloseTo(-6.766164807834689e-3, 15)
	expect(v[2]).toBeCloseTo(-2.933074405477159e-3, 15)
})

test('65803 Didymos', async () => {
	await using source = fileHandleSource(await fs.open('data/65803_Didymos.bsp'))
	const daf = await readDaf(source)
	const s = readSpk(daf)

	const segment = await s.segment(Naif.SUN, Naif.DIDYMOS_BARYCENTER)
	expect(segment).toBeDefined()
	const time = timeYMDHMS(2022, 12, 8, 20, 7, 15, Timescale.TDB)
	const [p, v] = segment!.at(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	// Target body name: 65803 Didymos (1996 GT)         {source: JPL#219}
	// Center body name: Sun (10)                        {source: DE441}
	expect(p[0]).toBeCloseTo(1.321900534972707e-1, 15)
	expect(p[1]).toBeCloseTo(1.022633896837742, 15)
	expect(p[2]).toBeCloseTo(4.564442166808176e-1, 15)

	expect(v[0]).toBeCloseTo(-1.739801961691489e-2, 16)
	expect(v[1]).toBeCloseTo(5.41929776178759e-3, 16)
	expect(v[2]).toBeCloseTo(3.552869344161516e-3, 16)
})

// Now, it does not work anymore! RangeHttpSource does not support synchronous read.
test.skip('MAR099', async () => {
	using source = rangeHttpSource('https://ssd.jpl.nasa.gov/ftp/eph/satellites/bsp/mar099.bsp')
	const daf = await readDaf(source)
	const spk = readSpk(daf)
	const [p, v] = (await spk.segment(4, 401))!.at({ day: 2460947, fraction: 0, scale: 5 })

	expect(p[0]).toBeCloseTo(-3.82910942172268e-5, 11)
	expect(p[1]).toBeCloseTo(3.065636702485076e-5, 11)
	expect(p[2]).toBeCloseTo(3.833086497253128e-5, 11)
	expect(v[0]).toBeCloseTo(-7.83678289321317e-4, 10)
	expect(v[1]).toBeCloseTo(-9.639456997298313e-4, 10)
	expect(v[2]).toBeCloseTo(-3.925176295238564e-5, 10)
})

test('Daphnis type 17', async () => {
	await using source = fileHandleSource(await fs.open('data/sat393_daphnis.bsp'))
	const segment = await readSpk(await readDaf(source)).segment(Naif.SATURN, Naif.DAPHNIS)
	expect(segment).toBeDefined()

	// CSPICE N0067 through SpiceyPy 6.0.0: spkgeo(635, et, 'J2000', 699), km and km/s, at TDB seconds past J2000 in each of
	// the three segments (joins at 315576000 and 504878400).
	const references = [
		[-1577880000, 133937.4740676739, -24482.63715777935, -9716.301188622076, 2.8909258928778714, 16.39351764973821, -1.4572213078112135],
		[-400000000, 78556.15333951659, -111629.84052140606, 1472.178920164435, 13.590662608743356, 9.539243537805188, -1.8719629693541895],
		[0, 33679.49596876311, -132108.03599952377, 6841.060755281576, 16.130276372416812, 4.024713814000071, -1.6838926151071492],
		[500000000, 132348.54724590736, -32186.175949667748, -9023.671473305056, 3.8342477916784903, 16.192624019314017, -1.5229209012682743],
		[1577880000, -115502.26236849165, -71148.73790981439, 15176.154200074267, 8.790518965768287, -14.208038020343155, 0.2903726193470037],
	] as const

	for (const [seconds, x, y, z, vx, vy, vz] of references) {
		const [p, v] = segment!.at({ day: J2000, fraction: seconds / DAYSEC, scale: Timescale.TDB })

		// Within 5 cm and 5 µm/s; the residual against CSPICE is 3 mm, from rounding the mean longitude after 10⁴ revolutions.
		expect(p[0] * AU_KM).toBeCloseTo(x, 4)
		expect(p[1] * AU_KM).toBeCloseTo(y, 4)
		expect(p[2] * AU_KM).toBeCloseTo(z, 4)
		expect((v[0] * AU_KM) / DAYSEC).toBeCloseTo(vx, 8)
		expect((v[1] * AU_KM) / DAYSEC).toBeCloseTo(vy, 8)
		expect((v[2] * AU_KM) / DAYSEC).toBeCloseTo(vz, 8)
	}
})
