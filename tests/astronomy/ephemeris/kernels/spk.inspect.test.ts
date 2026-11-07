import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { type Daf, readDaf, type Summary } from '../../../../src/astronomy/ephemeris/kernels/daf'
import { SPK_FRAME_J2000 } from '../../../../src/astronomy/ephemeris/kernels/spk'
import { inspectSpk } from '../../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { fileHandleSource } from '../../../../src/io/file'
import { downloadPerTag } from '../../../download'

await downloadPerTag('spk')

function daf(summaries: Summary[], format?: string): Daf {
	const readSync = () => new Float64Array()
	return { format, summaries, read: readSync, readSync }
}

function summary(ints: readonly number[], doubles: readonly number[] = [0, 10]): Summary {
	return { name: 'segment', doubles: Float64Array.from(doubles), ints: Int32Array.from(ints) }
}

test('lists supported and unsupported segments without rejecting the file', () => {
	const inspection = inspectSpk(daf([summary([399, 3, SPK_FRAME_J2000, 2, 1, 12]), summary([401, 4, 17, 2, 13, 24]), summary([-82, 699, SPK_FRAME_J2000, 13, 25, 36])], 'DAF/SPK'), 36 * 8)

	expect(inspection.ok).toBeTrue()
	if (!inspection.ok) return
	expect(inspection.segments.map((e) => [e.index, e.target, e.center, e.frame, e.dataType, e.supported, e.reason])).toEqual([
		[0, 399, 3, 1, 2, true, undefined],
		[1, 401, 4, 17, 2, false, 'frame'],
		[2, -82, 699, 1, 13, false, 'dataType'],
	])
	expect(inspection.segments[0]).toMatchObject({ name: 'segment', start: 0, end: 10, startIndex: 1, endIndex: 12 })
})

test('rejects another DAF kind', () => {
	expect(inspectSpk(daf([], 'DAF/PCK'), 1024)).toEqual({ ok: false, error: 'not an SPK file: DAF/PCK' })
})

test('rejects a summary layout other than ND=2 and NI=6', () => {
	expect(inspectSpk(daf([summary([31006, 1, 2, 641, 221284])]), 1e7)).toEqual({ ok: false, error: 'not an SPK summary layout' })
})

test('rejects non-finite or reversed coverage', () => {
	expect(inspectSpk(daf([summary([1, 0, 1, 2, 1, 12], [0, Number.NaN])]), 96).ok).toBeFalse()
	expect(inspectSpk(daf([summary([1, 0, 1, 2, 1, 12], [10, 0])]), 96).ok).toBeFalse()
	expect(inspectSpk(daf([summary([1, 0, 1, 2, 1, 12], [Number.NEGATIVE_INFINITY, 0])]), 96).ok).toBeFalse()
})

test('rejects data addresses outside the file', () => {
	expect(inspectSpk(daf([summary([1, 0, 1, 2, 1, 13])]), 96)).toEqual({ ok: false, error: 'segment 0 has data outside the file' })
	expect(inspectSpk(daf([summary([1, 0, 1, 2, 0, 12])]), 96).ok).toBeFalse()
	expect(inspectSpk(daf([summary([1, 0, 1, 2, 12, 11])]), 96).ok).toBeFalse()
})

test('DE440s descriptors', async () => {
	await using source = fileHandleSource(await fs.open('data/de440s.bsp'))
	const inspection = inspectSpk(await readDaf(source), (await fs.stat('data/de440s.bsp')).size)

	expect(inspection.ok).toBeTrue()
	if (!inspection.ok) return
	expect(inspection.segments.every((e) => e.supported && e.frame === SPK_FRAME_J2000 && e.dataType === 2)).toBeTrue()
	expect(inspection.segments.map((e) => `${e.center}->${e.target}`)).toContain('3->399')
	expect(inspection.segments.map((e) => `${e.center}->${e.target}`)).toContain('0->10')
})
