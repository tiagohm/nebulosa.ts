import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { read } from './daf'
import { fileHandleSource } from './io'
import { Naif } from './naif'
import { spk } from './spk'
import { Timescale, timeYMDHMS } from './time'

const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)

test('DE405', async () => {
	await using source = fileHandleSource(await fs.open('data/de405.bsp'))
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).not.toBeUndefined()
	const [p, v] = await segment!.compute(time)

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
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).not.toBeUndefined()
	const [p, v] = await segment!.compute(time)

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
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SSB, Naif.EMB)
	expect(segment).not.toBeUndefined()
	const [p, v] = await segment!.compute(time)

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
	const daf = await read(source)
	const s = spk(daf)

	const segment = s.segment(Naif.SUN, Naif.DIDYMOS_BARYCENTER)
	expect(segment).not.toBeUndefined()
	const time = timeYMDHMS(2022, 12, 8, 20, 7, 15, Timescale.TDB)
	const [p, v] = await segment!.compute(time)

	// https://ssd.jpl.nasa.gov/horizons/app.html#/
	// x-y axes of reference frame (equatorial or equatorial-aligned, inertial)
	expect(p[0]).toBeCloseTo(1.321900520119582e-1, 8)
	expect(p[1]).toBeCloseTo(1.022633897814651, 8)
	expect(p[2]).toBeCloseTo(4.564442163931812e-1, 8)

	expect(v[0]).toBeCloseTo(-1.739801962135171e-2, 11)
	expect(v[1]).toBeCloseTo(5.419297752176816e-3, 10)
	expect(v[2]).toBeCloseTo(3.552869336296117e-3, 10)
}, 1000000)
