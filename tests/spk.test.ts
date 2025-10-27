import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readDaf } from '../src/daf'
import { fileHandleSource, rangeHttpSource } from '../src/io'
import { Naif } from '../src/naif'
import { readSpk } from '../src/spk'
import { Timescale, timeYMDHMS } from '../src/time'

const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)

test('DE405', async () => {
	await using source = fileHandleSource(await fs.open('data/de405.bsp'))
	const daf = await readDaf(source)
	const s = readSpk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).not.toBeUndefined()
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
	expect(segment).not.toBeUndefined()
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
	expect(segment).not.toBeUndefined()
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
	expect(segment).not.toBeUndefined()
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
