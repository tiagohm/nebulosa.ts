import type { Daf } from './daf'
import { SPK_FRAME_J2000 } from './spk'

// Inspection of SPK files of unknown origin. Lists every segment descriptor of a parsed DAF without
// instantiating segment readers, so a file with unsupported data types or frames can still be
// catalogued, and checks the descriptor invariants a reader relies on: the SPK summary layout
// (ND = 2, NI = 6), finite and ordered coverage bounds, and data addresses inside the file. Epochs
// are TDB seconds past J2000. Nothing is read beyond the summaries already held by the DAF.

// Number of double-precision components of an SPK segment descriptor: start and end epochs.
const SPK_SUMMARY_DOUBLES = 2
// Number of integer components of an SPK segment descriptor: target, center, frame, type, start and end addresses.
const SPK_SUMMARY_INTS = 6
// Binary SPK data types the segment readers decode (2 and 3 Chebyshev, 9 Lagrange, 21 extended modified difference arrays).
const SUPPORTED_SPK_DATA_TYPES: ReadonlySet<number> = new Set([2, 3, 9, 21])
// Size of a double-precision word, in bytes.
const FLOAT64_BYTES = 8

// Why a well-formed segment cannot be evaluated: a data type no reader decodes, or a reference frame
// other than J2000, which would need a rotation the library does not apply.
export type SpkUnsupportedReason = 'dataType' | 'frame'

// One segment descriptor of an SPK file, in file order.
export interface SpkSegmentDescriptor {
	// Zero-based position of the segment in the file's summary order; later segments take precedence.
	readonly index: number
	// Segment name from the DAF name record, trimmed.
	readonly name: string
	// NAIF integer code of the target body.
	readonly target: number
	// NAIF integer code of the center body the target state is relative to.
	readonly center: number
	// NAIF integer code of the reference frame of the state vectors.
	readonly frame: number
	// SPK data type.
	readonly dataType: number
	// Coverage start, in TDB seconds past J2000 (inclusive).
	readonly start: number
	// Coverage end, in TDB seconds past J2000 (inclusive), never before `start`.
	readonly end: number
	// First 1-based double-word address of the segment data.
	readonly startIndex: number
	// Last 1-based double-word address of the segment data.
	readonly endIndex: number
	// Whether a segment reader can evaluate it in the library base frame.
	readonly supported: boolean
	// Why it is not supported; absent when supported.
	readonly reason?: SpkUnsupportedReason
}

// Outcome of an SPK inspection: the segment descriptors, or why the file is not a usable SPK.
export type SpkInspection = { readonly ok: true; readonly segments: readonly SpkSegmentDescriptor[] } | { readonly ok: false; readonly error: string }

// Lists the segment descriptors of `daf`, a DAF parsed from a file of `byteLength` bytes. Returns an
// error, instead of descriptors that would make a reader decode garbage or read out of the file, when
// the file is not an SPK (another DAF kind, or a summary layout other than ND = 2, NI = 6), when a
// coverage bound is not finite or the end precedes the start, or when a data address range is empty
// or outside the file. A data type or frame the readers do not handle is not an error: the segment is
// listed as unsupported with its reason.
export function inspectSpk(daf: Daf, byteLength: number): SpkInspection {
	if (daf.format !== undefined && daf.format !== 'DAF/SPK' && daf.format !== 'NAIF/DAF') return { ok: false, error: `not an SPK file: ${daf.format}` }

	const words = Math.floor(byteLength / FLOAT64_BYTES)
	const segments = new Array<SpkSegmentDescriptor>(daf.summaries.length)

	for (let i = 0; i < daf.summaries.length; i++) {
		const { name, doubles, ints } = daf.summaries[i]

		if (doubles.length !== SPK_SUMMARY_DOUBLES || ints.length !== SPK_SUMMARY_INTS) return { ok: false, error: 'not an SPK summary layout' }

		const [start, end] = doubles
		const [target, center, frame, dataType, startIndex, endIndex] = ints

		if (!(Number.isFinite(start) && Number.isFinite(end) && start <= end)) return { ok: false, error: `segment ${i} has invalid coverage` }
		if (!(startIndex >= 1 && startIndex <= endIndex && endIndex <= words)) return { ok: false, error: `segment ${i} has data outside the file` }

		const reason: SpkUnsupportedReason | undefined = !SUPPORTED_SPK_DATA_TYPES.has(dataType) ? 'dataType' : frame !== SPK_FRAME_J2000 ? 'frame' : undefined

		segments[i] = { index: i, name, target, center, frame, dataType, start, end, startIndex, endIndex, supported: reason === undefined, reason }
	}

	return { ok: true, segments }
}
