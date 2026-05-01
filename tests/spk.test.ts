import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { AU_KM, DAYSEC, J2000 } from '../src/constants'
import { type Daf, readDaf, type Summary } from '../src/daf'
import { fileHandleSource, rangeHttpSource } from '../src/io'
import { Naif } from '../src/naif'
import { readSpk, Type2And3Segment, Type9Segment } from '../src/spk'
import { Timescale, timeYMDHMS } from '../src/time'
import { downloadPerTag } from './download'

await downloadPerTag('spk')

const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)

// Builds a tiny in-memory DAF for deterministic SPK segment tests.
function dafFrom(values: readonly number[], summaries: Summary[] = []): Daf {
	const data = Float64Array.from(values)

	return {
		summaries,
		read: (start: number, end: number) => data.subarray(start - 1, end),
	}
}

// Builds a minimal SPK summary with one segment descriptor.
function summary(center: number, target: number, start: number, end: number, type: number, startIndex: number, endIndex: number): Summary {
	return {
		name: '',
		doubles: new Float64Array([start, end]),
		ints: new Int32Array([target, center, 1, type, startIndex, endIndex]),
	}
}

test('type 2 segment includes the final endpoint', async () => {
	const segment = new Type2And3Segment(dafFrom([4, 4, 1, 2, 3, 4, 5, 6, 0, 8, 8, 1]), 0, 8, 0, 1, 2, 1, 12)
	const [p, v] = await segment.at({ day: J2000, fraction: 8 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(3 / AU_KM, 15)
	expect(p[1]).toBeCloseTo(7 / AU_KM, 15)
	expect(p[2]).toBeCloseTo(11 / AU_KM, 15)
	expect(v[0]).toBeCloseTo((0.5 * DAYSEC) / AU_KM, 15)
	expect(v[1]).toBeCloseTo(DAYSEC / AU_KM, 15)
	expect(v[2]).toBeCloseTo((1.5 * DAYSEC) / AU_KM, 15)
})

test('type 3 segment evaluates velocity from the stored velocity coefficients', async () => {
	const segment = new Type2And3Segment(dafFrom([4, 4, 10, 2, 20, 3, 30, 4, 100, 0, 200, 0, 300, 0, 0, 8, 14, 1]), 0, 8, 0, 1, 3, 1, 18)
	const [p, v] = await segment.at({ day: J2000, fraction: 4 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(10 / AU_KM, 15)
	expect(p[1]).toBeCloseTo(20 / AU_KM, 15)
	expect(p[2]).toBeCloseTo(30 / AU_KM, 15)
	expect(v[0]).toBeCloseTo((100 * DAYSEC) / AU_KM, 15)
	expect(v[1]).toBeCloseTo((200 * DAYSEC) / AU_KM, 15)
	expect(v[2]).toBeCloseTo((300 * DAYSEC) / AU_KM, 15)
})

test('type 9 odd interpolation window is centered on the closest epoch', async () => {
	const segment = new Type9Segment(dafFrom([0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 216, 0, 0, 0, 0, 0, 0, 2, 4, 6, 2, 4]), 0, 6, 0, 1, 1, 30)
	const [p, v] = await segment.at({ day: J2000, fraction: 2.1 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(9.66 / AU_KM, 14)
	expect(p[1]).toBeCloseTo(0, 15)
	expect(p[2]).toBeCloseTo(0, 15)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('overlapping segments use the latest matching segment in file order', async () => {
	const spk = readSpk(dafFrom([10, 10, 1, 0, 0, 0, 20, 5, 1, 10, 10, 2, 0, 0, 0, 20, 5, 1], [summary(0, 1, 0, 20, 2, 1, 9), summary(0, 1, 0, 20, 2, 10, 18)]))
	const [p, v] = await spk.segment(0, 1)!.at({ day: J2000, fraction: 10 / DAYSEC, scale: Timescale.TDB })

	expect(p[0]).toBeCloseTo(2 / AU_KM, 15)
	expect(p[1]).toBeCloseTo(0, 15)
	expect(p[2]).toBeCloseTo(0, 15)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(0, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('DE405', async () => {
	await using source = fileHandleSource(await fs.open('data/de405.bsp'))
	const daf = await readDaf(source)
	const s = readSpk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).toBeDefined()
	const [p, v] = await segment!.at(time)

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

	const segment = spk.segment(Naif.SSB, Naif.EMB)
	expect(segment).toBeDefined()
	const [p, v] = await segment!.at(time)

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

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).toBeDefined()
	const [p, v] = await segment!.at(time)

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

	const segment = s.segment(Naif.SUN, Naif.DIDYMOS_BARYCENTER)
	expect(segment).toBeDefined()
	const time = timeYMDHMS(2022, 12, 8, 20, 7, 15, Timescale.TDB)
	const [p, v] = await segment!.at(time)

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

test.skip('MAR099', async () => {
	const source = rangeHttpSource('https://ssd.jpl.nasa.gov/ftp/eph/satellites/bsp/mar099.bsp')
	const daf = await readDaf(source)
	const spk = readSpk(daf)
	const [p, v] = await spk.segment(4, 401)!.at({ day: 2460947, fraction: 0, scale: 5 })

	expect(p[0]).toBeCloseTo(-3.82910942172268e-5, 11)
	expect(p[1]).toBeCloseTo(3.065636702485076e-5, 11)
	expect(p[2]).toBeCloseTo(3.833086497253128e-5, 11)
	expect(v[0]).toBeCloseTo(-7.83678289321317e-4, 10)
	expect(v[1]).toBeCloseTo(-9.639456997298313e-4, 10)
	expect(v[2]).toBeCloseTo(-3.925176295238564e-5, 10)
})
