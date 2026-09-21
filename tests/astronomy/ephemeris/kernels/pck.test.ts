import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { readDaf, type Summary, type SyncDaf } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { MultiplePckSegment, readPck, Type2PckSegment } from '../../../../src/astronomy/ephemeris/kernels/pck'
import { Timescale, time, timeShift, type Time } from '../../../../src/astronomy/time/time'
import { DAYSEC, J2000, PI } from '../../../../src/core/constants'
import { fileHandleSource } from '../../../../src/io/io'
import { type Mat3, type MutMat3, matDeterminant, matIdentity, matMinus, matMulScalar, matMulTranspose, matRotX, matRotZ } from '../../../../src/math/linear-algebra/mat3'
import { downloadPerTag } from '../../../download'
import { expectNumberArrayToBeCloseTo } from '../../../util'

await downloadPerTag('pck')

// Skyfield 1.55 / jplephem 2.24 rotation of MOON_PA_DE421 at TDB = T0 − 11150.
// From skyfield/tests/test_planetarylib.py (CSPICE pxform / sxform).
const T0_MINUS_11150_PA: Mat3 = [0.9994150897380264, 0.032310270603926675, 0.011203785852719871, -0.034157426811763446, 0.9272642685944782, 0.37284614304233643, 0.0016578894811167893, -0.3730107540024127, 0.9278255379116378]

// Builds a tiny in-memory DAF for deterministic PCK segment tests.
function dafFrom(values: readonly number[], summaries: Summary[] = []): SyncDaf {
	const data = Float64Array.from(values)

	return {
		summaries,
		read: (start, end) => data.subarray(start - 1, end),
		readSync: (start, end) => data.subarray(start - 1, end),
	}
}

// Builds a minimal PCK summary with one Type 2 segment descriptor.
function summary(frameClassId: number, start: number, end: number, type: number, startIndex: number, endIndex: number, inertialFrameId = 1): Summary {
	return {
		name: '',
		doubles: new Float64Array([start, end]),
		ints: new Int32Array([frameClassId, inertialFrameId, type, startIndex, endIndex]),
	}
}

// Time at `seconds` ephemeris seconds past J2000 TDB.
function tdbSeconds(seconds: number) {
	return time(J2000, seconds / DAYSEC, Timescale.TDB)
}

// Centered finite-difference W = dR/dt · Rᵀ (per day) of an orthonormal rotationAt.
function numericalW(rotationAt: (t: Time) => Mat3, t: Time, rotation: Mat3, step = 60 / DAYSEC): Mat3 {
	const rp = rotationAt(timeShift(t, step))
	const rm = rotationAt(timeShift(t, -step))
	const d = matMinus(rp, rm)
	matMulScalar(d, 0.5 / step, d)
	return matMulTranspose(d, rotation, d)
}

test('type 2 constant Euler angles reproduce Rz(w)·Rx(δ)·Rz(φ)', async () => {
	const phi = 0.1
	const delta = 0.2
	const w = 0.3
	const segment = new Type2PckSegment(dafFrom([4, 4, phi, delta, w, 0, 8, 5, 1]), 0, 8, 31006, 1, 1, 9)
	await segment.initialize()

	const expected = matIdentity()
	matRotZ(phi, expected)
	matRotX(delta, expected)
	matRotZ(w, expected)

	expectNumberArrayToBeCloseTo(segment.rotationAt(tdbSeconds(4)), expected, 15)
	expectNumberArrayToBeCloseTo(segment.dRdtTimesRtAt(tdbSeconds(4)), [0, 0, 0, 0, 0, 0, 0, 0, 0], 15)
})

test('type 2 segment includes both coverage endpoints', async () => {
	const segment = new Type2PckSegment(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1]), 0, 8, 31006, 1, 1, 9)
	await segment.initialize()

	expectNumberArrayToBeCloseTo(segment.rotationAt(tdbSeconds(0)), matIdentity(), 15)
	expectNumberArrayToBeCloseTo(segment.rotationAt(tdbSeconds(8)), matIdentity(), 15)
})

test('type 2 segment rejects epochs outside coverage', async () => {
	const segment = new Type2PckSegment(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1]), 0, 8, 31006, 1, 1, 9)
	await segment.initialize()

	expect(() => segment.rotationAt(tdbSeconds(-1))).toThrow('cannot find a PCK segment that covers the date')
	expect(() => segment.rotationAt(tdbSeconds(8.1))).toThrow('cannot find a PCK segment that covers the date')
})

test('rotationAt before initialize is rejected', () => {
	const segment = new Type2PckSegment(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1]), 0, 8, 31006, 1, 1, 9)

	expect(() => segment.rotationAt(tdbSeconds(4))).toThrow('PCK segment is not initialized')
})

test('type 2 initialize reads only directory words and caches each record', async () => {
	const reads: [number, number][] = []
	const data = Float64Array.from([4, 4, 0, 0, 0, 0, 8, 5, 1])
	const readSync = (start: number, end: number) => {
		reads.push([start, end])
		return data.subarray(start - 1, end)
	}
	const daf: SyncDaf = {
		summaries: [],
		read: (start, end) => readSync(start, end),
		readSync,
	}
	const segment = new Type2PckSegment(daf, 0, 8, 31006, 1, 1, 9)

	await segment.initialize()
	expect(reads).toEqual([[6, 9]])

	segment.rotationAt(tdbSeconds(4))
	expect(reads).toEqual([
		[6, 9],
		[1, 5],
	])

	segment.dRdtTimesRtAt(tdbSeconds(4))
	expect(reads).toEqual([
		[6, 9],
		[1, 5],
	])
})

test('MultiplePckSegment rejects mixed inertial frame ids', () => {
	const overlapping = [summary(31006, 0, 20, 2, 1, 9, 1), summary(31006, 10, 20, 2, 10, 18, 2)]
	expect(() => readPck(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1, 15, 5, 0, 0, 0, 10, 10, 5, 1], overlapping))).toThrow('one of the segments does not match the inertial frame id')

	const disjoint = [summary(31006, 0, 10, 2, 1, 9, 1), summary(31006, 10, 20, 2, 10, 18, 2)]
	expect(() => readPck(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1, 15, 5, 0, 0, 0, 10, 10, 5, 1], disjoint))).toThrow('one of the segments does not match the inertial frame id')
})

test('overlapping segments use the latest matching segment in file order', async () => {
	const pck = readPck(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1, 15, 5, 0, 0, PI / 2, 10, 10, 5, 1], [summary(31006, 0, 20, 2, 1, 9), summary(31006, 10, 20, 2, 10, 18)]))
	const segment = pck.segment(31006)!
	await segment.initialize()

	expectNumberArrayToBeCloseTo(segment.rotationAt(tdbSeconds(5)), matIdentity(), 15)
	expectNumberArrayToBeCloseTo(segment.rotationAt(tdbSeconds(10)), matRotZ(PI / 2), 15)
})

test('unsupported PCK types are rejected', () => {
	expect(() => readPck(dafFrom([], [summary(31006, 0, 8, 3, 1, 9)]))).toThrow('unsupported PCK data type 3')
	expect(() => readPck(dafFrom([], [summary(31006, 0, 8, 20, 1, 9)]))).toThrow('unsupported PCK data type 20')
})

test('segment lookup returns undefined for an unknown frame class id', () => {
	const pck = readPck(dafFrom([4, 4, 0, 0, 0, 0, 8, 5, 1], [summary(31006, 0, 8, 2, 1, 9)]))

	expect(pck.segment(31006)).toBeDefined()
	expect(pck.segment(399)).toBeUndefined()
})

test('MultiplePckSegment rejects an empty list', () => {
	expect(() => new MultiplePckSegment([])).toThrow('at least one segment needs to be provided')
})

test('DAF/PCK moon_pa_de421 descriptor is Type 2', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const daf = await readDaf(source)
	const pck = readPck(daf)
	const segment = pck.segment(31006)!

	expect(pck.segments).toHaveLength(1)
	expect(segment.start).toBe(-3.1557168e9)
	expect(segment.end).toBe(1.609416e9)
	expect(segment.frameClassId).toBe(31006)
	expect(segment.inertialFrameId).toBe(1)
	expect(segment.type).toBe(2)
	expect(segment.startIndex).toBe(641)
	expect(segment.endIndex).toBe(221284)
})

test('moon_pa_de421 rotation matches Skyfield/CSPICE at T0 − 11150', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(source))
	const segment = pck.segment(31006)!
	await segment.initialize()

	const t = time(J2000 - 11150, 0, Timescale.TDB)
	const r = segment.rotationAt(t)
	expectNumberArrayToBeCloseTo(r, T0_MINUS_11150_PA, 15)

	const rtr = matMulTranspose(r, r)
	expectNumberArrayToBeCloseTo(rtr, matIdentity(), 14)
	expect(matDeterminant(r)).toBeCloseTo(1, 14)
})

test('moon_pa_de421 analytic W agrees with a 60 s finite difference', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(source))
	const segment = pck.segment(31006)!
	await segment.initialize()

	const t = time(J2000 - 11150, 0, Timescale.TDB)
	const r = segment.rotationAt(t)
	const w = segment.dRdtTimesRtAt(t, r)
	const wFd = numericalW((time) => segment.rotationAt(time), t, r)

	for (let i = 0; i < 9; i++) expect(w[i]).toBeCloseTo(wFd[i], 8)

	// Skyfield 1.55 W = (dR/dt)·Rᵀ at T0 − 11150, radians/day.
	expect(w[1]).toBeCloseTo(0.2299696080125305, 12)
	expect(w[3]).toBeCloseTo(-0.22996960801253047, 12)
	expect(w[2]).toBeCloseTo(-3.5050952857567146e-5, 12)
	expect(w[6]).toBeCloseTo(3.5050952857556487e-5, 12)
})

test('returned rotation matrices are copies of the cached record', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(source))
	const segment = pck.segment(31006)!
	await segment.initialize()

	const t = time(J2000, 0, Timescale.TDB)
	const first = segment.rotationAt(t) as MutMat3
	first[0] = 99
	const second = segment.rotationAt(t)

	expect(second[0]).toBeCloseTo(0.7840447406961362, 12)
	expect(first[0]).toBe(99)
})

test('moon_pa_de421 rejects an epoch outside the segment window', async () => {
	await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
	const pck = readPck(await readDaf(source))
	const segment = pck.segment(31006)!
	await segment.initialize()

	expect(() => segment.rotationAt(tdbSeconds(-4e9))).toThrow('cannot find a PCK segment that covers the date')
})
