import { expect, test } from 'bun:test'
import { readDaf } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { readSpk, SPK_FRAME_J2000 } from '../../../../src/astronomy/ephemeris/kernels/spk'
import { inspectSpk } from '../../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { type SpkType9Segment, writeSpk } from '../../../../src/astronomy/ephemeris/kernels/spk.write'
import { KeplerOrbit } from '../../../../src/astronomy/orbits/asteroid'
import { Timescale, time } from '../../../../src/astronomy/time/time'
import { AU_KM, DAYSEC, GM_SUN_PITJEVA_2005, J2000 } from '../../../../src/core/constants'
import { bufferSource } from '../../../../src/io/io'
import { matIdentity } from '../../../../src/math/linear-algebra/mat3'

const ORBIT = new KeplerOrbit([1.2, -0.6, 0.15], [0.006, 0.0135, 0.001], time(J2000, 0, Timescale.TDB), GM_SUN_PITJEVA_2005, matIdentity())

function tdbAt(seconds: number) {
	return time(J2000, seconds / DAYSEC, Timescale.TDB)
}

// Kepler states every `stepDays` from 0, in km and km/s.
function keplerSegment(count: number, stepDays: number, target: number = 2099999): SpkType9Segment {
	const epochs = new Float64Array(count)
	const states = new Float64Array(count * 6)

	for (let i = 0; i < count; i++) {
		epochs[i] = i * stepDays * DAYSEC
		const [p, v] = ORBIT.at(tdbAt(epochs[i]))
		states.set([p[0] * AU_KM, p[1] * AU_KM, p[2] * AU_KM, (v[0] * AU_KM) / DAYSEC, (v[1] * AU_KM) / DAYSEC, (v[2] * AU_KM) / DAYSEC], i * 6)
	}

	return { target, center: 10, frame: SPK_FRAME_J2000, name: `KEPLER ${target}`, degree: 11, epochs, states }
}

function open(bytes: Uint8Array) {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	return readDaf(bufferSource(buffer))
}

test('a written type 9 segment reads back exactly at its states and interpolates between them', async () => {
	const segment = keplerSegment(251, 2)
	const bytes = writeSpk([segment], 'TEST FILE')
	expect(bytes.byteLength % 1024).toBe(0)

	const daf = await open(bytes)
	expect(daf.format).toBe('DAF/SPK')
	expect(daf.summaries).toHaveLength(1)
	expect(daf.summaries[0].name).toBe('KEPLER 2099999')

	const inspection = inspectSpk(daf, bytes.byteLength)
	expect(inspection.ok).toBeTrue()
	if (inspection.ok) expect(inspection.segments[0]).toMatchObject({ target: 2099999, center: 10, frame: SPK_FRAME_J2000, dataType: 9, start: 0, end: 500 * DAYSEC, supported: true })

	const reader = (await readSpk(daf).segment(10, 2099999))!

	for (const i of [0, 100, 137, 250]) {
		const [p, v] = reader.at(tdbAt(segment.epochs[i]))
		expect(p[0] * AU_KM).toBeCloseTo(segment.states[i * 6], 6)
		expect(v[2] * AU_KM).toBeCloseTo(segment.states[i * 6 + 5] * DAYSEC, 6)
	}

	for (const days of [0.7, 173.3, 499.1]) {
		const [p] = reader.at(tdbAt(days * DAYSEC))
		const [k] = ORBIT.at(tdbAt(days * DAYSEC))
		// Degree 11 over 2-day steps of a 1.3 AU orbit: millimeters.
		expect(Math.hypot(p[0] - k[0], p[1] - k[1], p[2] - k[2]) * AU_KM).toBeLessThan(1e-5)
	}
})

test('the array holds the epoch directory, the degree, and the count, as SPKW09 writes them', async () => {
	const segment = keplerSegment(251, 2)
	const daf = await open(writeSpk([segment]))
	const [begin, end] = [daf.summaries[0].ints[4], daf.summaries[0].ints[5]]
	expect(end - begin + 1).toBe(7 * 251 + 2 + 2)

	const directory = daf.readSync(begin + 7 * 251, end)
	expect([...directory]).toEqual([segment.epochs[99], segment.epochs[199], 11, 251])
})

test('more segments than one summary record holds are chained', async () => {
	const segments = Array.from({ length: 30 }, (_, i) => keplerSegment(12, 1, 2000001 + i))
	const bytes = writeSpk(segments)
	const daf = await open(bytes)
	expect(daf.summaries.map((e) => e.ints[0])).toEqual(segments.map((e) => e.target))

	const spk = readSpk(daf)
	const last = (await spk.segment(10, 2000030))!
	expect(last.at(tdbAt(5 * DAYSEC))[0][1] * AU_KM).toBeCloseTo(segments[29].states[5 * 6 + 1], 6)
})

test('inconsistent tables are rejected', () => {
	const segment = keplerSegment(20, 1)
	expect(() => writeSpk([{ ...segment, degree: 28 }])).toThrow()
	expect(() => writeSpk([{ ...segment, degree: 19, epochs: segment.epochs.subarray(0, 19), states: segment.states.subarray(0, 19 * 6) }])).toThrow()
	expect(() => writeSpk([{ ...segment, states: segment.states.subarray(6) }])).toThrow()
	const epochs = Float64Array.from(segment.epochs)
	epochs[5] = epochs[4]
	expect(() => writeSpk([{ ...segment, epochs }])).toThrow()
})
