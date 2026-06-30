import { readUntil, type Seekable, type Source } from '../../../io/io'

// Reader for NAIF DAF (Double precision Array File) containers, the binary layout underlying SPK
// ephemeris kernels. Parses the file record (endianness, summary layout, FTP validation string),
// walks the summary record chain, and exposes a random-access float64 reader. Handles both
// big-endian and little-endian files and validates against truncation.

// One array summary: a named segment with its descriptor doubles and ints.
export interface Summary {
	// Trimmed ASCII name of the segment.
	readonly name: string
	// Double-precision descriptor components (e.g. segment start/stop epochs).
	readonly doubles: Float64Array
	// Integer descriptor components (e.g. target/center IDs, data type, address range).
	readonly ints: Int32Array
}

// A parsed DAF file: its segment summaries plus a random-access float64 reader.
export interface Daf {
	// All array summaries found in the summary record chain.
	readonly summaries: Summary[]
	// Reads the inclusive 1-based double-word range [start, end] from the file.
	readonly read: (start: number, end: number) => Promise<Float64Array> | Float64Array
}

// Metadata from the DAF file record describing byte order and summary layout.
export interface DafRecord {
	// True when the file stores numbers big-endian.
	readonly be: boolean
	// Number of double-precision components in each summary (ND).
	readonly nd: number
	// Number of integer components in each summary (NI).
	readonly ni: number
	// Record number of the first summary record (forward pointer).
	readonly fward: number
	// Record number of the last summary record (backward pointer).
	readonly bward: number
}

const FTPSTR = Buffer.from('FTPSTR:\r:\n:\r\n:\r\u0000:\u0081:\u0010\u00CE:ENDFTP', 'ascii') // FTP validation byte string embedded in valid DAF files; corruption is detected by comparison.
// Byte offset of the FTP validation string within the file record.
const FTPSTR_OFFSET = 699
// Length of the FTP validation string, in bytes.
const FTPSTR_LENGTH = 28
// Size of one DAF physical record, in bytes.
const RECORD_SIZE = 1024
// Size of a double-precision word, in bytes.
const FLOAT64_BYTES = 8
// Size of a 32-bit integer word, in bytes.
const INT32_BYTES = 4
// Whether the host CPU is little-endian; selects the zero-copy read fast path.
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/daf.html
export async function readDaf(source: Source & Seekable): Promise<Daf> {
	const buffer = Buffer.allocUnsafe(RECORD_SIZE)

	await readRecord(source, 1, buffer)

	const format = buffer.toString('ascii', 0, 8)

	if (format === 'NAIF/DAF') {
		const record = readNaifDafRecord(buffer)
		const summaries = await readSummaries(source, record)

		return {
			summaries,
			read: (start, end) => readFloat64Array(source, start, end, record.be),
		}
	} else if (format.startsWith('DAF/')) {
		if (hasFtpValidationString(buffer)) {
			const be = buffer.toString('ascii', 88, 96).toUpperCase() !== 'LTL-IEEE'
			const record = readNaifDafRecord(buffer, be)
			const summaries = await readSummaries(source, record)

			return {
				summaries,
				read: (start, end) => readFloat64Array(source, start, end, record.be),
			}
		} else {
			throw new Error('file has been damaged')
		}
	}

	throw new Error(`unsupported format: ${format}`)
}

// Reads a contiguous DAF float64 range.
async function readFloat64Array(source: Source & Seekable, start: number, end: number, be: boolean): Promise<Float64Array> {
	source.seek(FLOAT64_BYTES * (start - 1))

	const length = 1 + end - start
	const data = new Float64Array(length)
	const expected = data.byteLength

	// Fast path: read directly into the Float64Array when file and host endianness match.
	if (be !== HOST_LITTLE_ENDIAN) {
		const n = await readUntil(source, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
		// Guard against truncated files: a short read would otherwise leave the tail zeroed.
		if (n !== expected) throw new Error(`unexpected end of DAF file: read ${n} of ${expected} bytes`)
		return data
	}

	const buffer = Buffer.allocUnsafe(data.byteLength)
	const n = await readUntil(source, buffer)
	// Guard against truncated files: a short read would otherwise decode uninitialized memory.
	if (n !== expected) throw new Error(`unexpected end of DAF file: read ${n} of ${expected} bytes`)

	for (let i = 0, offset = 0; i < length; i++, offset += FLOAT64_BYTES) {
		data[i] = be ? buffer.readDoubleBE(offset) : buffer.readDoubleLE(offset)
	}

	return data
}

// Checks the FTP validation string without creating temporary slices.
function hasFtpValidationString(buffer: Buffer) {
	for (let i = 0; i < FTPSTR_LENGTH; i++) {
		if (buffer.readUInt8(FTPSTR_OFFSET + i) !== FTPSTR.readUInt8(i)) return false
	}

	return true
}

// Reads a fixed-size DAF record into buffer.
// Throws when the record cannot be filled completely, so a truncated file is
// rejected instead of being parsed from stale or uninitialized buffer contents.
async function readRecord(source: Source & Seekable, index: number, buffer: Buffer): Promise<void> {
	source.seek((index - 1) * RECORD_SIZE)
	const n = await readUntil(source, buffer)
	if (n !== RECORD_SIZE) throw new Error(`unexpected end of DAF file: incomplete record ${index} (${n} of ${RECORD_SIZE} bytes)`)
}

// Parses the DAF file record metadata and byte order.
function readNaifDafRecord(buffer: Buffer, be?: boolean): DafRecord {
	let nd: number

	if (be === undefined) {
		// Big-endian format?
		be = true
		// The number of double precision components in each array summary.
		nd = buffer.readUInt32BE(8)

		// Little-endian format?
		if (nd !== 2) {
			be = false
			nd = buffer.readUInt32LE(8)

			if (nd !== 2) throw new Error('neither a big nor a little-endian scan of this file produces the expected ND=2')
		}
	} else {
		// The number of double precision components in each array summary.
		nd = be ? buffer.readUInt32BE(8) : buffer.readUInt32LE(8)
	}

	// The number of integer components in each array summary.
	const ni = be ? buffer.readUInt32BE(12) : buffer.readUInt32LE(12)
	// The record number of the initial summary record in the file.
	const fward = be ? buffer.readUInt32BE(76) : buffer.readUInt32LE(76)
	// The record number of the final summary record in the file.
	const bward = be ? buffer.readUInt32BE(80) : buffer.readUInt32LE(80)

	return { be, nd, ni, fward, bward }
}

// Reads all summary records and their names.
async function readSummaries(source: Source & Seekable, record: DafRecord): Promise<Summary[]> {
	const buffer = Buffer.allocUnsafe(RECORD_SIZE)
	const names = Buffer.allocUnsafe(RECORD_SIZE)
	const summaries: Summary[] = []

	let recordNumber = record.fward
	const stepSize = FLOAT64_BYTES * (record.nd + ((record.ni + 1) >> 1))

	while (recordNumber !== 0) {
		await readRecord(source, recordNumber, buffer)
		const count = readSummaryControlInt(buffer, 16, record.be)
		await readRecordSummaries(record, recordNumber, count, source, buffer, names, stepSize, summaries)
		recordNumber = readSummaryControlInt(buffer, 0, record.be)
	}

	return summaries
}

// Reads summaries from a summary record and its companion name record.
async function readRecordSummaries(record: DafRecord, index: number, count: number, source: Source & Seekable, data: Buffer, names: Buffer, stepSize: number, summaries: Summary[]): Promise<void> {
	await readRecord(source, index + 1, names)

	for (let i = 0, offset = 0; i < count; i++, offset += stepSize) {
		summaries.push(readSummary(data, names, 24 + offset, offset, stepSize, record))
	}
}

// Reads one integer-like summary control field stored as a DAF double.
function readSummaryControlInt(buffer: Buffer, offset: number, be: boolean) {
	return Math.trunc(be ? buffer.readDoubleBE(offset) : buffer.readDoubleLE(offset))
}

// Decodes one summary entry and its name.
function readSummary(data: Buffer, names: Buffer, dataOffset: number, nameOffset: number, stepSize: number, { be, nd, ni }: DafRecord): Summary {
	const doubles = new Float64Array(nd)
	const ints = new Int32Array(ni)
	const name = readSummaryName(names, nameOffset, nameOffset + stepSize)

	let offset = dataOffset
	for (let i = 0; i < nd; i++, offset += FLOAT64_BYTES) doubles[i] = be ? data.readDoubleBE(offset) : data.readDoubleLE(offset)
	for (let i = 0; i < ni; i++, offset += INT32_BYTES) ints[i] = be ? data.readInt32BE(offset) : data.readInt32LE(offset)

	return { name, doubles, ints }
}

// Reads an ASCII summary name and trims padding before string allocation.
function readSummaryName(buffer: Buffer, start: number, end: number) {
	while (start < end && buffer.readUInt8(start) <= 32) start++
	while (end > start && buffer.readUInt8(end - 1) <= 32) end--
	return buffer.toString('ascii', start, end)
}
