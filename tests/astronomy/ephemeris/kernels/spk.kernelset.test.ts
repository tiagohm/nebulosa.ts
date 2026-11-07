import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { type Daf, readDaf, type Summary } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { Naif } from '../../../../src/astronomy/ephemeris/kernels/naif'
import { readSpk, SPK_FRAME_J2000 } from '../../../../src/astronomy/ephemeris/kernels/spk'
import { inspectSpk } from '../../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { prepareSpkKernelSet, type SpkKernelEntry } from '../../../../src/astronomy/ephemeris/kernels/spk.kernelset'
import { type Time, Timescale, timeYMDHMS } from '../../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, J2000 } from '../../../../src/core/constants'
import { fileHandleSource } from '../../../../src/io/file'
import { downloadPerTag } from '../../../download'

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

test('chains segments from the body to the barycenter', async () => {
	const set = await prepareSpkKernelSet([
		entry('de', [
			{ center: 0, target: 3, start: 0, end: 100, position: [1000, 0, 0] },
			{ center: 3, target: 399, start: 0, end: 100, position: [0, 20, 0] },
		]),
	])

	const result = set.stateAt(399, at(50))
	expect(result.ok).toBeTrue()
	if (!result.ok) return
	expect(result.state[0][0]).toBeCloseTo(km(1000), 15)
	expect(result.state[0][1]).toBeCloseTo(km(20), 15)
	expect(result.state[0][2]).toBe(0)
	expect(result.state[1]).toEqual([0, 0, 0])
	expect(result.kernels).toEqual(['de'])
	expect(set.bodies).toEqual(new Set([3, 399]))
	expect(set.stateAt(0, at(50))).toEqual({
		ok: true,
		state: [
			[0, 0, 0],
			[0, 0, 0],
		],
		kernels: [],
	})
})

test('the file loaded last takes precedence whatever its center', async () => {
	const planetary = entry('planetary', [{ center: 0, target: 10, start: 0, end: 100, position: [5, 0, 0] }])
	const heliocentric = entry('heliocentric', [{ center: 10, target: 2000001, start: 0, end: 100, position: [100, 0, 0] }])
	const barycentric = entry('barycentric', [{ center: 0, target: 2000001, start: 40, end: 60, position: [300, 0, 0] }])
	const set = await prepareSpkKernelSet([planetary, heliocentric, barycentric])

	const inside = set.stateAt(2000001, at(50))
	const outside = set.stateAt(2000001, at(70))
	expect(inside.ok && inside.state[0][0]).toBeCloseTo(km(300), 15)
	expect(inside.ok && inside.kernels).toEqual(['barycentric'])
	expect(outside.ok && outside.state[0][0]).toBeCloseTo(km(105), 15)
	expect(outside.ok && outside.kernels).toEqual(['heliocentric', 'planetary'])

	const reordered = await prepareSpkKernelSet([planetary, barycentric, heliocentric])
	const swapped = reordered.stateAt(2000001, at(50))
	expect(swapped.ok && swapped.state[0][0]).toBeCloseTo(km(105), 15)
})

test('a later segment of a file takes precedence where it overlaps an earlier one', async () => {
	const set = await prepareSpkKernelSet([
		entry('file', [
			{ center: 0, target: 1, start: 0, end: 100, position: [1, 0, 0] },
			{ center: 0, target: 1, start: 50, end: 100, position: [2, 0, 0] },
		]),
	])

	const early = set.stateAt(1, at(25))
	const late = set.stateAt(1, at(75))
	expect(early.ok && early.state[0][0]).toBeCloseTo(km(1), 15)
	expect(late.ok && late.state[0][0]).toBeCloseTo(km(2), 15)
})

test('a center that changes over time is followed at each epoch', async () => {
	const set = await prepareSpkKernelSet([
		entry('file', [
			{ center: 0, target: 10, start: 0, end: 100, position: [7, 0, 0] },
			{ center: 0, target: 99, start: 0, end: 50, position: [1, 0, 0] },
			{ center: 10, target: 99, start: 50, end: 100, position: [2, 0, 0] },
		]),
	])

	const before = set.stateAt(99, at(25))
	const after = set.stateAt(99, at(75))
	expect(before.ok && before.state[0][0]).toBeCloseTo(km(1), 15)
	expect(after.ok && after.state[0][0]).toBeCloseTo(km(9), 15)
})

test('gaps between segments are not bridged and coverage ends are inclusive', async () => {
	const set = await prepareSpkKernelSet([
		entry('file', [
			{ center: 0, target: 1, start: 0, end: 10, position: [1, 0, 0] },
			{ center: 0, target: 1, start: 20, end: 30, position: [1, 0, 0] },
		]),
	])

	expect(set.stateAt(1, at(10)).ok).toBeTrue()
	expect(set.stateAt(1, at(20)).ok).toBeTrue()
	expect(set.stateAt(1, at(15))).toEqual({ ok: false, reason: 'coverage', body: 1 })
	expect(set.stateAt(1, at(30.001))).toEqual({ ok: false, reason: 'coverage', body: 1 })
	expect(set.stateAt(1, at(-0.001))).toEqual({ ok: false, reason: 'coverage', body: 1 })
})

test('an unsupported selected segment does not fall back to a lower-precedence one', async () => {
	const supported = entry('supported', [{ center: 0, target: 1, start: 0, end: 100, position: [1, 0, 0] }])
	const ecliptic = entry('ecliptic', [{ center: 0, target: 1, start: 40, end: 60, position: [1, 0, 0], frame: 17 }])
	const type5 = entry('type5', [{ center: 0, target: 1, start: 70, end: 80, position: [1, 0, 0], type: 5 }])
	const set = await prepareSpkKernelSet([supported, ecliptic, type5])

	expect(set.stateAt(1, at(50))).toEqual({ ok: false, reason: 'frame', body: 1 })
	expect(set.stateAt(1, at(75))).toEqual({ ok: false, reason: 'dataType', body: 1 })
	expect(set.stateAt(1, at(20)).ok).toBeTrue()
})

test('a missing dependency names the body where the chain stops', async () => {
	const set = await prepareSpkKernelSet([entry('asteroid', [{ center: 10, target: 2000001, start: 0, end: 100, position: [1, 0, 0] }])])

	expect(set.stateAt(2000001, at(50))).toEqual({ ok: false, reason: 'missing', body: 10 })
	expect(set.stateAt(399, at(50))).toEqual({ ok: false, reason: 'missing', body: 399 })
})

test('a cyclic center chain is rejected', async () => {
	const set = await prepareSpkKernelSet([
		entry('cycle', [
			{ center: 2, target: 1, start: 0, end: 100, position: [1, 0, 0] },
			{ center: 1, target: 2, start: 0, end: 100, position: [1, 0, 0] },
		]),
	])

	expect(set.stateAt(1, at(50)).ok).toBeFalse()
	expect(set.stateAt(1, at(50))).toMatchObject({ reason: 'cycle' })
})

test('every state is owned by the caller', async () => {
	const set = await prepareSpkKernelSet([entry('file', [{ center: 0, target: 1, start: 0, end: 100, position: [1, 0, 0] }])])
	const a = set.stateAt(1, at(50))
	const b = set.stateAt(1, at(50))
	if (!a.ok || !b.ok) throw new Error('unresolved')
	expect(b.state[0][0]).toBeCloseTo(km(1), 15)
	expect(a.state[0]).not.toBe(b.state[0])
})

test('DE440s and the Didymos kernel resolve the Earth and Didymos from separate files', async () => {
	await using planetarySource = fileHandleSource(await fs.open('data/de440s.bsp'))
	await using didymosSource = fileHandleSource(await fs.open('data/65803_Didymos.bsp'))
	const planetaryDaf = await readDaf(planetarySource)
	const didymosDaf = await readDaf(didymosSource)
	const planetaryInspection = inspectSpk(planetaryDaf, (await fs.stat('data/de440s.bsp')).size)
	const didymosInspection = inspectSpk(didymosDaf, (await fs.stat('data/65803_Didymos.bsp')).size)
	if (!planetaryInspection.ok || !didymosInspection.ok) throw new Error('invalid fixture')

	const set = await prepareSpkKernelSet([
		{ id: 'de440s', daf: planetaryDaf, segments: planetaryInspection.segments },
		{ id: 'didymos', daf: didymosDaf, segments: didymosInspection.segments },
	])

	// Earth-Moon barycenter of DE440s against JPL Horizons (DE441), as in spk.test.ts.
	const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)
	const emb = set.stateAt(Naif.EMB, time)
	if (!emb.ok) throw new Error(emb.reason)
	expect(emb.state[0][0]).toBeCloseTo(-4.233964762021999e-1, 12)
	expect(emb.state[0][1]).toBeCloseTo(8.124609657969613e-1, 12)
	expect(emb.state[0][2]).toBeCloseTo(3.523864507181277e-1, 12)
	expect(emb.state[1][0]).toBeCloseTo(-1.584863352414356e-2, 14)

	// Chain composition: the Earth is EMB + (EMB -> Earth), Didymos is Sun + (Sun -> Didymos).
	const spk = readSpk(planetaryDaf)
	const embToEarth = (await spk.segment(Naif.EMB, Naif.EARTH))!.at(time)
	const earth = set.stateAt(Naif.EARTH, time)
	if (!earth.ok) throw new Error(earth.reason)
	for (let i = 0; i < 3; i++) expect(earth.state[0][i]).toBeCloseTo(emb.state[0][i] + embToEarth[0][i], 15)
	expect(earth.kernels).toEqual(['de440s'])

	const didymosTime = timeYMDHMS(2022, 12, 8, 20, 7, 15, Timescale.TDB)
	const sun = (await spk.segment(Naif.SSB, Naif.SUN))!.at(didymosTime)
	const didymos = set.stateAt(Naif.DIDYMOS_BARYCENTER, didymosTime)
	if (!didymos.ok) throw new Error(didymos.reason)
	// Heliocentric Didymos against JPL Horizons (JPL#219), as in spk.test.ts.
	expect(didymos.state[0][0] - sun[0][0]).toBeCloseTo(1.321900534972707e-1, 14)
	expect(didymos.state[0][1] - sun[0][1]).toBeCloseTo(1.022633896837742, 14)
	expect(didymos.state[0][2] - sun[0][2]).toBeCloseTo(4.564442166808176e-1, 14)
	expect(didymos.kernels).toEqual(['didymos', 'de440s'])

	// Planet centers absent from DE440s are not replaced by their system barycenters.
	expect(set.stateAt(Naif.JUPITER, time)).toEqual({ ok: false, reason: 'missing', body: Naif.JUPITER })
})
