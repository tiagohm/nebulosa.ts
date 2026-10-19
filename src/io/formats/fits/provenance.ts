import type { FitsHeader, FitsHeaderKey, FitsHeaderValue } from './fits'
import { type FitsMetadataDiagnostic, finiteMetadataKeyword, textMetadataKeyword } from './util'

// Instrument, detector and calibration provenance of a FITS HDU: a pure parse/serialize layer between
// the descriptive keywords of the FITS Standard (TELESCOP, INSTRUME, OBSERVER, OBJECT, ORIGIN), the
// common dictionary (DETECTOR, FILTER) and the de facto capture-software set (IMAGETYP/FRAME, XBINNING,
// CCD-TEMP, SET-TEMP, GAIN, OFFSET, EGAIN, READOUTM, CALSTAT, PEDESTAL, PROGRAM) and a typed record.
// Values are kept in the header's units: temperatures in degrees Celsius, EGAIN in e-/ADU, PEDESTAL in
// ADU. Headers are untrusted input: unreadable values are dropped and reported, never thrown. The
// reader never mutates the header; the writer updates it in place.

// Calibration frame role of an image (IMAGETYP or FRAME).
export type FitsFrameType = 'light' | 'dark' | 'flat' | 'bias' | 'darkFlat'

// Calibration step already applied to an image (CALSTAT letters B, D and F).
export type FitsCalibrationStep = 'bias' | 'dark' | 'flat'

// Typed provenance values; every field is optional and absent when the header does not provide it.
export interface FitsProvenanceFields {
	// TELESCOP: telescope or observatory name.
	readonly telescope?: string
	// INSTRUME: instrument or camera name.
	readonly instrument?: string
	// DETECTOR: detector (sensor) name.
	readonly detector?: string
	// OBSERVER: who acquired the data.
	readonly observer?: string
	// OBJECT: name of the observed object.
	readonly object?: string
	// ORIGIN: organization responsible for the file.
	readonly origin?: string
	// PROGRAM, else SWCREATE, else CREATOR: software that wrote the HDU.
	readonly software?: string
	// FILTER: filter name.
	readonly filter?: string
	// IMAGETYP, else FRAME, as a normalized frame role.
	readonly frameType?: FitsFrameType
	// XBINNING and YBINNING, positive binning factors along x and y.
	readonly binning?: readonly [number, number]
	// CCD-TEMP: measured sensor temperature in degrees Celsius.
	readonly sensorTemperature?: number
	// SET-TEMP: sensor cooler set point in degrees Celsius.
	readonly setTemperature?: number
	// GAIN as written: capture software records the camera gain setting here, while NOAO-style
	// headers record e-/ADU; prefer `electronGain` for a physical conversion factor.
	readonly gain?: number
	// OFFSET: camera offset (bias level) setting, in the driver's units.
	readonly offset?: number
	// EGAIN: electronic gain in e-/ADU.
	readonly electronGain?: number
	// READOUTM: camera readout mode name.
	readonly readoutMode?: string
	// CALSTAT: calibration steps already applied.
	readonly calibration?: readonly FitsCalibrationStep[]
	// PEDESTAL: ADU to add to each pixel to recover zero-based values.
	readonly pedestal?: number
}

// Provenance read from a header, with the reader's findings.
export interface FitsProvenance extends FitsProvenanceFields {
	// Invalid, unsupported, assumed and conflicting values, in reading order.
	readonly diagnostics: readonly FitsMetadataDiagnostic[]
}

// Keywords owned by readFitsProvenance and rewritten (or removed) by writeFitsProvenance.
export const FITS_PROVENANCE_KEYWORDS: readonly FitsHeaderKey[] = ['TELESCOP', 'INSTRUME', 'DETECTOR', 'OBSERVER', 'OBJECT', 'ORIGIN', 'PROGRAM', 'SWCREATE', 'CREATOR', 'FILTER', 'IMAGETYP', 'FRAME', 'XBINNING', 'YBINNING', 'CCD-TEMP', 'SET-TEMP', 'GAIN', 'OFFSET', 'EGAIN', 'READOUTM', 'CALSTAT', 'PEDESTAL']

// Frame-role spellings after lower-casing, dropping non-letters and a trailing 'frame' or 'field'.
const FRAME_TYPES: Readonly<Record<string, FitsFrameType>> = {
	light: 'light',
	object: 'light',
	science: 'light',
	dark: 'dark',
	flat: 'flat',
	skyflat: 'flat',
	domeflat: 'flat',
	twilightflat: 'flat',
	bias: 'bias',
	zero: 'bias',
	offset: 'bias',
	darkflat: 'darkFlat',
	flatdark: 'darkFlat',
}

// IMAGETYP values written for each frame role (MaxIm DL spelling).
const FRAME_TYPE_CODES: Readonly<Record<FitsFrameType, string>> = {
	light: 'Light Frame',
	dark: 'Dark Frame',
	flat: 'Flat Frame',
	bias: 'Bias Frame',
	darkFlat: 'Dark Flat',
}

// CALSTAT letters and the calibration step each one records.
const CALIBRATION_STEPS: Readonly<Record<string, FitsCalibrationStep>> = { B: 'bias', D: 'dark', F: 'flat' }

// Reads the instrument, detector and calibration provenance of one HDU header. Blank strings count as
// absent. IMAGETYP wins over FRAME and a disagreement between them is a conflict; a single XBINNING or
// YBINNING is taken as square binning; non-positive binning and unknown CALSTAT letters are reported.
export function readFitsProvenance(header: FitsHeader): FitsProvenance {
	const diagnostics: FitsMetadataDiagnostic[] = []

	return {
		telescope: textMetadataKeyword(header, 'TELESCOP'),
		instrument: textMetadataKeyword(header, 'INSTRUME'),
		detector: textMetadataKeyword(header, 'DETECTOR'),
		observer: textMetadataKeyword(header, 'OBSERVER'),
		object: textMetadataKeyword(header, 'OBJECT'),
		origin: textMetadataKeyword(header, 'ORIGIN'),
		software: textMetadataKeyword(header, 'PROGRAM') ?? textMetadataKeyword(header, 'SWCREATE') ?? textMetadataKeyword(header, 'CREATOR'),
		filter: textMetadataKeyword(header, 'FILTER'),
		frameType: readFrameType(header, diagnostics),
		binning: readBinning(header, diagnostics),
		sensorTemperature: finiteMetadataKeyword(header, 'CCD-TEMP', diagnostics),
		setTemperature: finiteMetadataKeyword(header, 'SET-TEMP', diagnostics),
		gain: finiteMetadataKeyword(header, 'GAIN', diagnostics),
		offset: finiteMetadataKeyword(header, 'OFFSET', diagnostics),
		electronGain: finiteMetadataKeyword(header, 'EGAIN', diagnostics),
		readoutMode: textMetadataKeyword(header, 'READOUTM'),
		calibration: readCalibration(header, diagnostics),
		pedestal: finiteMetadataKeyword(header, 'PEDESTAL', diagnostics),
		diagnostics,
	}
}

// Writes provenance into `header` in place and returns it. Every keyword of FITS_PROVENANCE_KEYWORDS is
// rewritten when the input defines it and deleted otherwise (the software goes to PROGRAM and the frame
// role to IMAGETYP only), so stale aliases cannot contradict the new values; existing keywords keep
// their position and unrelated keywords pass through.
export function writeFitsProvenance(header: FitsHeader, provenance: FitsProvenanceFields) {
	const values: Record<FitsHeaderKey, FitsHeaderValue> = {
		TELESCOP: provenance.telescope,
		INSTRUME: provenance.instrument,
		DETECTOR: provenance.detector,
		OBSERVER: provenance.observer,
		OBJECT: provenance.object,
		ORIGIN: provenance.origin,
		PROGRAM: provenance.software,
		FILTER: provenance.filter,
		IMAGETYP: provenance.frameType && FRAME_TYPE_CODES[provenance.frameType],
		XBINNING: provenance.binning?.[0],
		YBINNING: provenance.binning?.[1],
		'CCD-TEMP': provenance.sensorTemperature,
		'SET-TEMP': provenance.setTemperature,
		GAIN: provenance.gain,
		OFFSET: provenance.offset,
		EGAIN: provenance.electronGain,
		READOUTM: provenance.readoutMode,
		CALSTAT: provenance.calibration?.length ? provenance.calibration.map((step) => step[0].toUpperCase()).join('') : undefined,
		PEDESTAL: provenance.pedestal,
	}

	for (const key of FITS_PROVENANCE_KEYWORDS) {
		const value = values[key]
		if (value === undefined) delete header[key]
		else header[key] = value
	}

	return header
}

// Normalizes one frame-role spelling, or undefined when it is not recognized.
function parseFrameType(value: string) {
	return FRAME_TYPES[
		value
			.toLowerCase()
			.replaceAll(/[^a-z]/g, '')
			.replace(/(?:frame|field)$/, '')
	]
}

// Reads IMAGETYP, else FRAME, as a frame role.
function readFrameType(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[]) {
	let frameType: FitsFrameType | undefined
	let source: FitsHeaderKey | undefined

	for (const key of ['IMAGETYP', 'FRAME'] as const) {
		const text = textMetadataKeyword(header, key)
		if (text === undefined) continue
		const parsed = parseFrameType(text)

		if (parsed === undefined) {
			diagnostics.push({ kind: 'unsupported', keyword: key, message: `${key} ${JSON.stringify(text)} is not a recognized frame type` })
		} else if (frameType === undefined) {
			frameType = parsed
			source = key
		} else if (parsed !== frameType) {
			diagnostics.push({ kind: 'conflict', keyword: source!, message: `${source} is ${frameType} but ${key} is ${parsed}; ${source} is used` })
		}
	}

	return frameType
}

// Reads XBINNING and YBINNING as positive factors; a lone factor is applied to both axes.
function readBinning(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[]): readonly [number, number] | undefined {
	let x = finiteMetadataKeyword(header, 'XBINNING', diagnostics)
	let y = finiteMetadataKeyword(header, 'YBINNING', diagnostics)

	if (x !== undefined && !(x > 0)) {
		diagnostics.push({ kind: 'invalid', keyword: 'XBINNING', message: 'XBINNING is not positive' })
		x = undefined
	}

	if (y !== undefined && !(y > 0)) {
		diagnostics.push({ kind: 'invalid', keyword: 'YBINNING', message: 'YBINNING is not positive' })
		y = undefined
	}

	if (x === undefined && y === undefined) return undefined

	if (x === undefined || y === undefined) {
		const [missing, present] = x === undefined ? ['XBINNING', 'YBINNING'] : ['YBINNING', 'XBINNING']
		diagnostics.push({ kind: 'assumed', keyword: missing, message: `${missing} is unavailable; the ${present} factor is used for both axes` })
		return [x ?? y!, y ?? x!]
	}

	return [x, y]
}

// Reads CALSTAT letters as applied calibration steps; other letters are reported.
function readCalibration(header: FitsHeader, diagnostics: FitsMetadataDiagnostic[]): readonly FitsCalibrationStep[] | undefined {
	const text = textMetadataKeyword(header, 'CALSTAT')
	if (text === undefined) return undefined

	const steps = new Set<FitsCalibrationStep>()

	for (const letter of text.toUpperCase()) {
		const step = CALIBRATION_STEPS[letter]
		if (step !== undefined) steps.add(step)
		else diagnostics.push({ kind: 'unsupported', keyword: 'CALSTAT', message: `CALSTAT letter ${JSON.stringify(letter)} is not a recognized calibration step` })
	}

	return [...steps]
}
