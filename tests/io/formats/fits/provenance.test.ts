import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { fileHandleSource } from '../../../../src/io/file'
import { FitsKeywordReader, FitsKeywordWriter, type FitsHeader, readFits } from '../../../../src/io/formats/fits/fits'
import { FITS_PROVENANCE_KEYWORDS, type FitsProvenance, readFitsProvenance, writeFitsProvenance } from '../../../../src/io/formats/fits/provenance'
import { download } from '../../../download'

await Promise.all([download('NGC3372-16.1.fit'), download('LIGHT.fit'), download('DARK.30.fit')])

// Diagnostic kinds and keywords as compact strings.
function findings(provenance: FitsProvenance) {
	return provenance.diagnostics.map((e) => `${e.kind}:${e.keyword}`)
}

// Reads the primary header of a repository fixture.
async function primaryHeader(path: string) {
	await using source = fileHandleSource(await fs.open(path))
	return (await readFits(source))!.hdus[0].header
}

test('reads the PixInsight provenance of NGC3372-16.1.fit', async () => {
	const provenance = readFitsProvenance(await primaryHeader('data/NGC3372-16.1.fit'))

	expect(provenance).toEqual({
		telescope: undefined,
		instrument: 'ASI Camera (1)',
		detector: undefined,
		observer: undefined,
		object: 'NGC3372',
		origin: undefined,
		software: 'PixInsight 1.9.3',
		filter: 'Luminance+Red+Green+Blue',
		frameType: 'light',
		binning: [4, 4],
		sensorTemperature: -10,
		setTemperature: -10,
		gain: 120,
		offset: 30,
		electronGain: 1.00224268436432,
		readoutMode: 'Mode0',
		calibration: ['dark'],
		pedestal: -100,
		diagnostics: [],
	})
})

test('reads the INDI frame types of the calibration fixtures', async () => {
	const light = readFitsProvenance(await primaryHeader('data/LIGHT.fit'))
	expect(light.frameType).toBe('light')
	expect(light.telescope).toBe('iOptronV3')
	expect(light.instrument).toBe('ZWO CCD ASI294MM Pro')
	expect(light.sensorTemperature).toBe(19)
	expect(light.diagnostics).toBeEmpty()

	const dark = readFitsProvenance(await primaryHeader('data/DARK.30.fit'))
	expect(dark.frameType).toBe('dark')
	expect(dark.binning).toEqual([4, 4])
	expect(dark.diagnostics).toBeEmpty()
})

test('normalizes frame-type spellings and reports conflicts', () => {
	const types = ['Light Frame', 'OBJECT', 'dark', 'Flat Field', 'SKYFLAT', 'Bias Frame', 'zero', 'Dark Flat', 'FLATDARK'].map((IMAGETYP) => readFitsProvenance({ IMAGETYP }).frameType)
	expect(types).toEqual(['light', 'light', 'dark', 'flat', 'flat', 'bias', 'bias', 'darkFlat', 'darkFlat'])

	const conflict = readFitsProvenance({ IMAGETYP: 'Light Frame', FRAME: 'Dark' })
	expect(conflict.frameType).toBe('light')
	expect(findings(conflict)).toEqual(['conflict:IMAGETYP'])

	const fallback = readFitsProvenance({ IMAGETYP: 'Focus', FRAME: 'Flat' })
	expect(fallback.frameType).toBe('flat')
	expect(findings(fallback)).toEqual(['unsupported:IMAGETYP'])
})

test('reports invalid numbers, lone and non-positive binning, and unknown CALSTAT letters', () => {
	const provenance = readFitsProvenance({ 'CCD-TEMP': 'cold', GAIN: true, XBINNING: 2, YBINNING: 0, CALSTAT: 'fdbx', SWCREATE: 'N.I.N.A.', TELESCOP: '   ' })
	expect(provenance.sensorTemperature).toBeUndefined()
	expect(provenance.gain).toBeUndefined()
	expect(provenance.binning).toEqual([2, 2])
	expect(provenance.calibration).toEqual(['flat', 'dark', 'bias'])
	expect(provenance.software).toBe('N.I.N.A.')
	expect(provenance.telescope).toBeUndefined()
	expect(findings(provenance)).toEqual(['invalid:YBINNING', 'assumed:YBINNING', 'invalid:CCD-TEMP', 'invalid:GAIN', 'unsupported:CALSTAT'])
})

test('round-trips through header cards and replaces stale aliases', () => {
	const header: FitsHeader = { SIMPLE: true, FRAME: 'Dark', SWCREATE: 'old', CREATOR: 'older', IMAGETYP: 'Dark Frame', NAXIS: 0 }
	const fields = {
		telescope: 'C14',
		instrument: 'QHY600',
		detector: 'IMX455',
		observer: 'A. Observer',
		object: 'M42',
		origin: 'Observatory',
		software: 'nebulosa',
		filter: 'Ha',
		frameType: 'darkFlat',
		binning: [2, 1],
		sensorTemperature: -9.8,
		setTemperature: -10,
		gain: 26,
		offset: 30,
		electronGain: 0.8,
		readoutMode: 'High Gain',
		calibration: ['bias', 'flat'],
		pedestal: 100,
	} as const

	writeFitsProvenance(header, fields)

	expect(Object.keys(header).slice(0, 3)).toEqual(['SIMPLE', 'IMAGETYP', 'NAXIS'])
	expect(header.IMAGETYP).toBe('Dark Flat')
	expect(header.CALSTAT).toBe('BF')
	expect(header.FRAME).toBeUndefined()
	expect(header.SWCREATE).toBeUndefined()
	expect(header.CREATOR).toBeUndefined()

	const buffer = Buffer.alloc(80 * 32)
	new FitsKeywordWriter().writeAll(header, buffer)
	expect(readFitsProvenance(new FitsKeywordReader().readAll(buffer))).toEqual({ ...fields, diagnostics: [] })

	writeFitsProvenance(header, {})
	for (const key of FITS_PROVENANCE_KEYWORDS) expect(header[key]).toBeUndefined()
	expect(header).toEqual({ SIMPLE: true, NAXIS: 0 })
})
