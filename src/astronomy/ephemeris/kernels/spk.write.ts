// Writer of NAIF SPK files holding type 9 segments (Lagrange interpolation of unequally spaced states), the format a
// numerically integrated trajectory is stored in: each accepted integration step becomes one state, so the table is
// densest where the motion bends. The output is a little-endian DAF/SPK with ND = 2 and NI = 6, no comment area, its
// summary and name records first (25 segments per pair), then the segment arrays, laid out as the SPICE toolkit's
// SPKW09 writes them: the states, the epochs, the directory of every 100th epoch, the degree, and the state count. It
// builds the whole file in memory, 8 bytes per value plus a 1024-byte record per 25 segments.

// Description of one type 9 segment.
export interface SpkType9Segment {
	// NAIF code of the body whose state the segment gives.
	readonly target: number
	// NAIF code of the body the states are relative to.
	readonly center: number
	// NAIF code of the reference frame of the states, such as SPK_FRAME_J2000.
	readonly frame: number
	// Segment identifier, printable ASCII; truncated to 40 characters.
	readonly name: string
	// Degree of the interpolating polynomials, from 1 to 27; a window of degree + 1 states around each request epoch is
	// interpolated.
	readonly degree: number
	// Epochs of the states, TDB seconds past J2000, strictly increasing, at least degree + 1 of them. The first and last
	// bound the coverage of the segment.
	readonly epochs: Float64Array
	// States at the epochs, six values each: position (km) then velocity (km/s), length 6 × epochs.length.
	readonly states: Float64Array
}

// Identification word of an SPK DAF.
const LOCIDW = 'DAF/SPK '
// Binary format word of little-endian IEEE doubles.
const LOCFMT = 'LTL-IEEE'
// FTP validation string the DAF file record carries at FTPSTR_OFFSET, as Latin-1 bytes.
const FTPSTR = 'FTPSTR:\r:\n:\r\n:\r\u0000:\u0081:\u0010\u00CE:ENDFTP'
// Byte offset of the FTP validation string in the file record.
const FTPSTR_OFFSET = 699
// Size of one DAF record, in bytes, and in double-precision words.
const RECORD_BYTES = 1024
const RECORD_WORDS = 128
// Double-precision (ND) and integer (NI) components of an SPK summary.
const ND = 2
const NI = 6
// Size of one summary, in double-precision words: ND + (NI + 1) / 2.
const SUMMARY_WORDS = ND + ((NI + 1) >> 1)
// Summaries per summary record, after its NEXT, PREV, and NSUM control words.
const SUMMARIES_PER_RECORD = Math.trunc((RECORD_WORDS - 3) / SUMMARY_WORDS)
// Characters of one segment name in a name record (8 per summary word).
const NAME_LENGTH = 8 * SUMMARY_WORDS
// Characters of the internal file name.
const IFNAME_LENGTH = 60
// SPK data type of the segments.
const TYPE_9 = 9
// Highest interpolation degree the SPICE toolkit accepts for type 9 (MAXDEG of SPKW09).
const MAXIMUM_DEGREE = 27
// Spacing of the epoch directory: every 100th epoch is listed.
const DIRECTORY_STEP = 100

// Writes `segments` into a new SPK file and returns its bytes. `internalName` is the internal file name of the file
// record, printable ASCII truncated to 60 characters. Throws when a segment's tables are inconsistent (length, count
// against the degree, or epochs not strictly increasing), which would otherwise write a file SPICE reads wrongly.
export function writeSpk(segments: readonly SpkType9Segment[], internalName: string = 'NEBULOSA SPK'): Uint8Array {
	for (const segment of segments) validateSegment(segment)

	const summaryRecords = Math.max(1, Math.ceil(segments.length / SUMMARIES_PER_RECORD))
	const firstDataRecord = 2 + 2 * summaryRecords
	const addresses: [number, number][] = []
	let next = (firstDataRecord - 1) * RECORD_WORDS + 1

	for (const segment of segments) {
		const words = arrayWords(segment)
		addresses.push([next, next + words - 1])
		next += words
	}

	const free = next
	const totalRecords = Math.max(firstDataRecord - 1, Math.ceil((free - 1) / RECORD_WORDS))
	const bytes = new Uint8Array(totalRecords * RECORD_BYTES)
	const view = new DataView(bytes.buffer)

	writeFileRecord(bytes, view, internalName, 2, 2 + 2 * (summaryRecords - 1), free)

	for (let r = 0; r < summaryRecords; r++) {
		const record = 2 + 2 * r
		const offset = (record - 1) * RECORD_BYTES
		const first = r * SUMMARIES_PER_RECORD
		const count = Math.min(SUMMARIES_PER_RECORD, segments.length - first)
		view.setFloat64(offset, r + 1 < summaryRecords ? record + 2 : 0, true)
		view.setFloat64(offset + 8, r > 0 ? record - 2 : 0, true)
		view.setFloat64(offset + 16, Math.max(0, count), true)

		for (let i = 0; i < count; i++) {
			const segment = segments[first + i]
			const [begin, end] = addresses[first + i]
			const at = offset + 24 + i * SUMMARY_WORDS * 8
			view.setFloat64(at, segment.epochs[0], true)
			view.setFloat64(at + 8, segment.epochs.at(-1)!, true)
			view.setInt32(at + 16, segment.target, true)
			view.setInt32(at + 20, segment.center, true)
			view.setInt32(at + 24, segment.frame, true)
			view.setInt32(at + 28, TYPE_9, true)
			view.setInt32(at + 32, begin, true)
			view.setInt32(at + 36, end, true)
			writeText(bytes, offset + RECORD_BYTES + i * NAME_LENGTH, segment.name, NAME_LENGTH)
		}

		// Unused name slots are blank, as SPICE writes them.
		for (let i = Math.max(0, count) * NAME_LENGTH; i < RECORD_BYTES; i++) bytes[offset + RECORD_BYTES + i] = 32
	}

	for (let s = 0; s < segments.length; s++) writeArray(view, (addresses[s][0] - 1) * 8, segments[s])

	return bytes
}

// Rejects a segment whose tables would be written inconsistently.
function validateSegment({ degree, epochs, states }: SpkType9Segment) {
	if (!(degree >= 1 && degree <= MAXIMUM_DEGREE && Number.isInteger(degree))) throw new Error(`type 9 degree must be an integer from 1 to ${MAXIMUM_DEGREE}: ${degree}`)
	if (states.length !== 6 * epochs.length) throw new Error('type 9 states must hold six values per epoch')
	if (!(epochs.length >= degree + 1)) throw new Error(`type 9 needs at least ${degree + 1} states for degree ${degree}`)

	for (let i = 1; i < epochs.length; i++) {
		if (!(epochs[i] > epochs[i - 1])) throw new Error(`type 9 epochs must be strictly increasing at index ${i}`)
	}
}

// Words of the array of a segment: states, epochs, directory, degree, and count.
function arrayWords({ epochs }: SpkType9Segment) {
	const n = epochs.length
	return 7 * n + Math.trunc((n - 1) / DIRECTORY_STEP) + 2
}

// Writes the array of a segment at byte `offset`.
function writeArray(view: DataView, offset: number, { degree, epochs, states }: SpkType9Segment) {
	const n = epochs.length
	let at = offset

	for (let i = 0; i < states.length; i++, at += 8) view.setFloat64(at, states[i], true)
	for (let i = 0; i < n; i++, at += 8) view.setFloat64(at, epochs[i], true)
	for (let k = DIRECTORY_STEP; k < n; k += DIRECTORY_STEP, at += 8) view.setFloat64(at, epochs[k - 1], true)

	view.setFloat64(at, degree, true)
	view.setFloat64(at + 8, n, true)
}

// Writes the DAF file record: identification, summary layout, internal name, record pointers, first free address,
// binary format, and the FTP validation string; the rest stays zero.
function writeFileRecord(bytes: Uint8Array, view: DataView, internalName: string, forward: number, backward: number, free: number) {
	writeText(bytes, 0, LOCIDW, 8)
	view.setInt32(8, ND, true)
	view.setInt32(12, NI, true)
	writeText(bytes, 16, internalName, IFNAME_LENGTH)
	view.setInt32(76, forward, true)
	view.setInt32(80, backward, true)
	view.setInt32(84, free, true)
	writeText(bytes, 88, LOCFMT, 8)
	for (let i = 0; i < FTPSTR.length; i++) bytes[FTPSTR_OFFSET + i] = FTPSTR.charCodeAt(i)
}

// Writes `text` at `offset` as single bytes, truncated or blank-padded to `length`; a character outside printable
// ASCII is written as a blank.
function writeText(bytes: Uint8Array, offset: number, text: string, length: number) {
	for (let i = 0; i < length; i++) {
		const code = i < text.length ? text.charCodeAt(i) : 32
		bytes[offset + i] = code >= 32 && code <= 126 ? code : 32
	}
}
